import { NextResponse } from 'next/server';
import { authBearerUser } from '@/lib/auth/bearer';
import { CLIENT_CONFIG_CONTRACT_VERSION } from '@/lib/client-config/contract';

/**
 * 桌面客户端配置下发：登录用户自动获得线路 + key（内测用户零配置）。
 *
 * **契约 v2（2026-09-03）**：线路按**档位**下发，客户端不再持任何写死的 base URL。
 * 这一份对所有登录用户相同（没有按账号的配置），来源全是 Vercel 环境变量：
 *
 *   标准档（DeepSeek 官方直连）
 *     CLIENT_TIER_STANDARD_BASE_URL   缺省 https://api.deepseek.com/anthropic
 *     CLIENT_TIER_STANDARD_MODEL      缺省 deepseek-v4-pro
 *     CLIENT_TIER_STANDARD_FAST_MODEL 缺省 deepseek-v4-flash
 *     CLIENT_TIER_STANDARD_API_KEY    缺省回落 CLIENT_LLM_API_KEY（同一把 DeepSeek key，也供投递箱打标）
 *   增强档（inferera 中转站）
 *     CLIENT_TIER_ENHANCED_BASE_URL   缺省 https://api.inferera.com
 *     CLIENT_TIER_ENHANCED_MODEL      缺省 claude-opus-5
 *     CLIENT_TIER_ENHANCED_FAST_MODEL 缺省 claude-opus-5
 *     CLIENT_TIER_ENHANCED_API_KEY    缺省回落 CLIENT_RELAY_API_KEY（第一版复用中转站那把；限额子 key 随网关单一并做）
 *
 * 缺省值写在这里而不是客户端：客户端只认下发的值，服务端换线路 = 改环境变量 + 客户端重新登录，不用发版。
 * key 未配置的项返回 null，客户端会明示「线路未配置，请联系管理员」，**不做任何静默回落**。
 *
 * **v1 字段保留**（relayBaseUrl / relayApiKey / llmBaseUrl / llmModel / llmApiKey）：
 * 0.1.2 及更早的客户端只认这几个；`llm*` 三项此外仍是投递箱打标的配置（与档位无关）。
 * 废弃时机：所有已知装机（用户本人 / 大头 / Jerry）升到含契约 v2 的版本之后，见 HANDOFF。
 * P1 网关上线后本接口改为下发网关地址，key 不再出服务端。
 *
 * **route.ts 里不许再 export 任何非 HTTP 方法的东西**（契约版本常量在 lib/client-config/contract.ts）。
 */

function tier(prefix: string, defaults: { baseUrl: string; model: string; fastModel: string; keyFallback?: string }) {
  const env = process.env;
  return {
    baseUrl: env[`${prefix}_BASE_URL`] || defaults.baseUrl,
    model: env[`${prefix}_MODEL`] || defaults.model,
    fastModel: env[`${prefix}_FAST_MODEL`] || defaults.fastModel,
    apiKey: env[`${prefix}_API_KEY`] || defaults.keyFallback || null,
  };
}

export async function GET(req: Request) {
  const user = await authBearerUser(req);
  if (!user) return NextResponse.json({ error: '未授权' }, { status: 401 });

  return NextResponse.json({
    contractVersion: CLIENT_CONFIG_CONTRACT_VERSION,
    // ---- v1 字段（老客户端 + 投递箱打标配置）----
    relayBaseUrl: process.env.CLIENT_RELAY_BASE_URL || 'https://api.inferera.com',
    relayApiKey: process.env.CLIENT_RELAY_API_KEY || null,
    llmBaseUrl: process.env.CLIENT_LLM_BASE_URL || 'https://api.deepseek.com',
    llmModel: process.env.CLIENT_LLM_MODEL || 'deepseek-v4-flash',
    llmApiKey: process.env.CLIENT_LLM_API_KEY || null,
    // ---- v2：按档位下发 ----
    tiers: {
      standard: tier('CLIENT_TIER_STANDARD', {
        baseUrl: 'https://api.deepseek.com/anthropic',
        model: 'deepseek-v4-pro',
        fastModel: 'deepseek-v4-flash',
        keyFallback: process.env.CLIENT_LLM_API_KEY,
      }),
      enhanced: tier('CLIENT_TIER_ENHANCED', {
        baseUrl: 'https://api.inferera.com',
        model: 'claude-opus-5',
        fastModel: 'claude-opus-5',
        keyFallback: process.env.CLIENT_RELAY_API_KEY,
      }),
    },
  });
}
