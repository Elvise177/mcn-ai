import { config } from '@/config';

import { AIHubMixProvider } from './providers/aihubmix';
import { AIProvider } from './providers/base';

const providers = new Map<string, AIProvider>();

export function getProvider(name: string): AIProvider {
  if (!providers.has(name)) {
    switch (name) {
      case 'aihubmix':
        providers.set(name, new AIHubMixProvider());
        break;
      // V2+ 预留: case 'anthropic': providers.set(name, new AnthropicProvider()); break;
      // V2+ 预留: case 'openai': providers.set(name, new OpenAIProvider()); break;
      default:
        throw new Error(`Unknown AI provider: ${name}`);
    }
  }
  return providers.get(name)!;
}

/** 通过角色别名获取模型 ID */
export function resolveModel(alias: string): string {
  const aliases = config.ai.modelAliases as Record<string, string>;
  return aliases[alias] || alias;
}

export function getDefaultProvider(): AIProvider {
  return getProvider(config.ai.defaultProvider);
}

export * from './types';
export { AIProvider } from './providers/base';
export { AIHubMixProvider } from './providers/aihubmix';
export { PromptManager } from './prompts/manager';
export { SYSTEM_PROMPTS } from './prompts';
