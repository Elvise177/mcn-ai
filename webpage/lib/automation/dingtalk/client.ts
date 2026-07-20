/**
 * 自动化中心 · 钉钉 AI 表格（智能表格/Notable）API 客户端
 *
 * 职责：企业内部应用鉴权 + AI 表格数据层读写（工作表/记录 CRUD）+ 群机器人推送。
 * 环境变量（Vercel 配置）：
 *   DINGTALK_APP_KEY / DINGTALK_APP_SECRET  企业内部应用凭证
 *   DINGTALK_OPERATOR_ID                    操作者 unionId（表格 API 必填，用管理员账号）
 *   DINGTALK_GROUP_WEBHOOK / DINGTALK_GROUP_SECRET  群机器人（可选，管道通知用）
 *
 * 注意：Notable 接口路径以联调为准（集中在 EP 常量，改动只动一处）。
 */

const API = 'https://api.dingtalk.com';

/**
 * 接口路径集中定义。已按开放平台 API Explorer（多维表 notable_1.0）核对：
 *   获取所有数据表  GET  /v1.0/notable/bases/{baseId}/sheets
 *   列出多行记录    POST /v1.0/notable/bases/{baseId}/sheets/{sheet}/records/list
 *   新增记录        POST /v1.0/notable/bases/{baseId}/sheets/{sheet}/records
 *   更新多行记录    PUT  /v1.0/notable/bases/{baseId}/sheets/{sheet}/records
 *   删除多行记录    DELETE /v1.0/notable/bases/{baseId}/sheets/{sheet}/records?recordIds=a,b
 */
const EP = {
  token: `${API}/v1.0/oauth2/accessToken`,
  sheets: (baseId: string) => `${API}/v1.0/notable/bases/${baseId}/sheets`,
  records: (baseId: string, sheet: string) =>
    `${API}/v1.0/notable/bases/${baseId}/sheets/${encodeURIComponent(sheet)}/records`,
  recordsList: (baseId: string, sheet: string) =>
    `${API}/v1.0/notable/bases/${baseId}/sheets/${encodeURIComponent(sheet)}/records/list`,
};

export interface NotableRecord {
  id?: string;
  fields: Record<string, unknown>;
}

export interface NotableSheet {
  id: string;
  name: string;
}

// ---- 鉴权：accessToken 进程内缓存（有效期 2 小时，提前 5 分钟刷新） ----
let cachedToken: { token: string; expireAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expireAt) return cachedToken.token;
  const appKey = process.env.DINGTALK_APP_KEY;
  const appSecret = process.env.DINGTALK_APP_SECRET;
  if (!appKey || !appSecret) throw new Error('缺少 DINGTALK_APP_KEY / DINGTALK_APP_SECRET');
  const r = await fetch(EP.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey, appSecret }),
  });
  const j = (await r.json()) as { accessToken?: string; expireIn?: number; message?: string };
  if (!j.accessToken) throw new Error(`钉钉鉴权失败: ${j.message ?? r.status}`);
  cachedToken = { token: j.accessToken, expireAt: Date.now() + ((j.expireIn ?? 7200) - 300) * 1000 };
  return j.accessToken;
}

function operatorId(): string {
  const id = process.env.DINGTALK_OPERATOR_ID;
  if (!id) throw new Error('缺少 DINGTALK_OPERATOR_ID（表格操作者 unionId）');
  return id;
}

async function call<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<T> {
  const token = await getAccessToken();
  const sep = url.includes('?') ? '&' : '?';
  const r = await fetch(`${url}${sep}operatorId=${encodeURIComponent(operatorId())}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-acs-dingtalk-access-token': token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let j: unknown = {};
  try {
    j = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }
  if (!r.ok) {
    const msg = (j as { message?: string }).message ?? text.slice(0, 200);
    throw new Error(`钉钉 API ${r.status}: ${msg} (${method} ${url})`);
  }
  return j as T;
}

// ---- 工作表 ----

/** 列出 AI 表格文件内的所有工作表 */
export async function listSheets(baseId: string): Promise<NotableSheet[]> {
  const j = await call<{ value?: NotableSheet[]; items?: NotableSheet[] }>(
    'GET',
    EP.sheets(baseId),
  );
  return j.value ?? j.items ?? [];
}

// ---- 记录：读（自动翻页） ----

/** 拉取工作表全部记录（sheet 可传名称或 id；自动翻页取全量） */
export async function listRecords(
  baseId: string,
  sheet: string,
  opts?: { pageSize?: number; maxTotal?: number },
): Promise<NotableRecord[]> {
  const pageSize = opts?.pageSize ?? 100;
  const maxTotal = opts?.maxTotal ?? 5000;
  const out: NotableRecord[] = [];
  let nextToken: string | undefined;
  do {
    const j = await call<{
      records?: NotableRecord[];
      value?: NotableRecord[];
      nextToken?: string;
      hasMore?: boolean;
    }>('POST', EP.recordsList(baseId, sheet), {
      maxResults: pageSize,
      ...(nextToken ? { nextToken } : {}),
    });
    out.push(...(j.records ?? j.value ?? []));
    nextToken = j.hasMore === false ? undefined : j.nextToken;
  } while (nextToken && out.length < maxTotal);
  return out;
}

// ---- 记录：写（批量分片，钉钉单次批量有条数限制） ----

const BATCH = 100;

/** 批量插入记录 */
export async function insertRecords(
  baseId: string,
  sheet: string,
  records: Array<Record<string, unknown>>,
): Promise<number> {
  let n = 0;
  for (let i = 0; i < records.length; i += BATCH) {
    const chunk = records.slice(i, i + BATCH).map((fields) => ({ fields }));
    await call('POST', EP.records(baseId, sheet), { records: chunk });
    n += chunk.length;
  }
  return n;
}

/** 批量更新记录（按记录 id） */
export async function updateRecords(
  baseId: string,
  sheet: string,
  records: Array<{ id: string; fields: Record<string, unknown> }>,
): Promise<number> {
  let n = 0;
  for (let i = 0; i < records.length; i += BATCH) {
    const chunk = records.slice(i, i + BATCH);
    await call('PUT', EP.records(baseId, sheet), { records: chunk });
    n += chunk.length;
  }
  return n;
}

/** 批量删除记录 */
export async function deleteRecords(
  baseId: string,
  sheet: string,
  recordIds: string[],
): Promise<number> {
  let n = 0;
  for (let i = 0; i < recordIds.length; i += BATCH) {
    const chunk = recordIds.slice(i, i + BATCH);
    await call(
      'DELETE',
      `${EP.records(baseId, sheet)}?recordIds=${encodeURIComponent(chunk.join(','))}`,
    );
    n += chunk.length;
  }
  return n;
}

// ---- 群机器人推送（与桌面端同款加签逻辑，管道结果通知用） ----

export async function sendGroupMessage(title: string, markdown: string): Promise<void> {
  const webhook = process.env.DINGTALK_GROUP_WEBHOOK;
  if (!webhook) return; // 未配置则静默跳过
  let url = webhook;
  const secret = process.env.DINGTALK_GROUP_SECRET;
  if (secret) {
    const { createHmac } = await import('crypto');
    const ts = Date.now();
    const sign = encodeURIComponent(
      createHmac('sha256', secret).update(`${ts}\n${secret}`).digest('base64'),
    );
    url += `${url.includes('?') ? '&' : '?'}timestamp=${ts}&sign=${sign}`;
  }
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { title, text: markdown } }),
  }).catch(() => void 0);
}
