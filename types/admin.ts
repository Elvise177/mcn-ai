export type SystemSettingsValue = {
  ai: {
    defaultProvider: string;
    defaultModel: string;
    temperature: number;
    maxTokens: number;
  };
  limits: {
    maxMessagesPerConversation: number;
    maxDailyMessagesPerUser: number;
    maxTokensPerMessage: number;
    maxHistoryMessages: number;
  };
  features: Record<string, boolean>;
};
