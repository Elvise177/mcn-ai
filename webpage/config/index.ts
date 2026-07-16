import 'server-only';

import { env } from '@/lib/utils/env';

export const config = {
  app: {
    name: '美妆带货AI操作台',
    version: '1.0.0',
  },

  supabase: {
    url: env.NEXT_PUBLIC_SUPABASE_URL,
    anonKey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  },

  tikhub: {
    baseURL: 'https://api.tikhub.io',
    apiKey: env.TIKHUB_API_KEY,
  },

  ai: {
    defaultProvider: 'aihubmix' as const,
    providers: {
      aihubmix: {
        // 备用域名 api.inferera.com 国内免翻墙（AIHubMix 官方备份，同 key）；
        // 海外部署可用 env 切回主域名
        baseURL: process.env.AIHUBMIX_BASE_URL || 'https://api.inferera.com/v1',
        apiKey: env.AIHUBMIX_API_KEY,
        defaultModel: 'claude-sonnet-4-6',
      },
      // V2+ 预留：直接对接官方 API
      anthropic: {
        baseURL: 'https://api.anthropic.com/v1',
        apiKey: env.ANTHROPIC_API_KEY ?? '',
        defaultModel: 'claude-sonnet-4-6',
      },
      openai: {
        baseURL: 'https://api.openai.com/v1',
        apiKey: env.OPENAI_API_KEY ?? '',
        defaultModel: 'gpt-4o',
      },
    },

    /** 业务别名 → 实际模型 ID（经 AIHubMix 路由） */
    modelAliases: {
      'script-writer': 'claude-sonnet-4-6',
      'video-analyzer': 'gpt-4o',
      'product-analyzer': 'claude-sonnet-4-6',
      'comment-expert': 'claude-haiku-4-5',
      'hook-generator': 'gpt-4o-mini',
    },
  },

  limits: {
    maxMessagesPerConversation: 100,
    maxConversationsPerUser: 1000,
    maxDailyMessagesPerUser: 200,
    maxTokensPerMessage: 8000,
    maxHistoryMessages: 20,
  },

  features: {
    enableConversations: true,
    enableAdminPanel: true,
    enableAuditLog: true,
    enableKnowledgeBase: false,
    enableCustomRoles: false,
    enablePayment: false,
    enableMultiTenant: false,
    enableScheduledTasks: false,
    enableDataCrawling: false,
    enablePushNotification: false,
    enableAutoEditing: false,
  },
} as const;

export type Config = typeof config;

/** 将角色别名解析为实际模型 ID（兼容旧调用） */
export function resolveModelId(aliasOrModel: string): string {
  const aliases = config.ai.modelAliases as Record<string, string>;
  return aliases[aliasOrModel] ?? aliasOrModel;
}
