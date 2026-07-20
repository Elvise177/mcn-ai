/**
 * 钉钉 AI 表格联调冒烟：验证 应用凭证 → token → 列工作表 → 读源表样例。
 * 用法（拿到客户 AppKey 后）：
 *   DINGTALK_APP_KEY=xx DINGTALK_APP_SECRET=xx DINGTALK_OPERATOR_ID=xx \
 *   node scripts/dingtalk-smoke.mjs <baseId> [源表名]
 */
const [baseId, sourceSheet = '抖音数据'] = process.argv.slice(2);
if (!baseId) {
  console.error('用法: node scripts/dingtalk-smoke.mjs <baseId> [源表名]');
  process.exit(1);
}

const API = 'https://api.dingtalk.com';
const { DINGTALK_APP_KEY, DINGTALK_APP_SECRET, DINGTALK_OPERATOR_ID } = process.env;
if (!DINGTALK_APP_KEY || !DINGTALK_APP_SECRET || !DINGTALK_OPERATOR_ID) {
  console.error('缺少环境变量 DINGTALK_APP_KEY / DINGTALK_APP_SECRET / DINGTALK_OPERATOR_ID');
  process.exit(1);
}

// 1. token
const tokenRes = await fetch(`${API}/v1.0/oauth2/accessToken`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ appKey: DINGTALK_APP_KEY, appSecret: DINGTALK_APP_SECRET }),
});
const { accessToken, message } = await tokenRes.json();
if (!accessToken) {
  console.error('❌ 鉴权失败:', message ?? tokenRes.status);
  process.exit(1);
}
console.log('✅ accessToken 获取成功');

const call = async (method, path, body) => {
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${API}${path}${sep}operatorId=${encodeURIComponent(DINGTALK_OPERATOR_ID)}`, {
    method,
    headers: {
      'x-acs-dingtalk-access-token': accessToken,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
};

// 2. 列工作表（GET /v1.0/notable/bases/{baseId}/sheets）
try {
  const sheets = await call('GET', `/v1.0/notable/bases/${baseId}/sheets`);
  const list = sheets.value ?? sheets.items ?? [];
  console.log(`✅ 工作表 ${list.length} 张:`, list.map((s) => s.name).join(' / '));
} catch (e) {
  console.error('❌ 列工作表失败（检查 baseId 与应用授权）:', String(e).slice(0, 300));
  process.exit(1);
}

// 3. 读源表样例（POST …/records/list）
try {
  const j = await call(
    'POST',
    `/v1.0/notable/bases/${baseId}/sheets/${encodeURIComponent(sourceSheet)}/records/list`,
    { maxResults: 3 },
  );
  const rows = j.records ?? j.value ?? [];
  console.log(`✅ 源表「${sourceSheet}」读到 ${rows.length} 行样例:`);
  for (const row of rows) console.log('  ', JSON.stringify(row.fields).slice(0, 200));
  console.log('\n=== 冒烟通过：把样例字段名发给开发，校准 douyinToDetail 映射 ===');
} catch (e) {
  console.error(`❌ 读源表「${sourceSheet}」失败（把真实表名当第二个参数传入重试）:`, String(e).slice(0, 300));
  process.exit(1);
}
