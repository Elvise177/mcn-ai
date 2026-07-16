import { NextResponse } from 'next/server';
import { authBearerUser } from '@/lib/auth/bearer';

/**
 * 桌面客户端配置下发：登录用户自动获得 AI key（内测用户零配置）。
 * key 来自服务端环境变量（Vercel 配置）：
 *   CLIENT_RELAY_API_KEY —— 中转站低配额专用子 key（勿用主 key）
 *   CLIENT_LLM_API_KEY   —— DeepSeek 打标 key
 * 未配置的项返回 null，客户端回退到用户自填。
 * P1 网关上线后本接口改为下发网关地址，key 不再出服务端。
 */
export async function GET(req: Request) {
  const user = await authBearerUser(req);
  if (!user) return NextResponse.json({ error: '未授权' }, { status: 401 });

  return NextResponse.json({
    relayBaseUrl: process.env.CLIENT_RELAY_BASE_URL || 'https://api.inferera.com',
    relayApiKey: process.env.CLIENT_RELAY_API_KEY || null,
    llmBaseUrl: process.env.CLIENT_LLM_BASE_URL || 'https://api.deepseek.com',
    llmModel: process.env.CLIENT_LLM_MODEL || 'deepseek-v4-flash',
    llmApiKey: process.env.CLIENT_LLM_API_KEY || null,
  });
}
