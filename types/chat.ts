export type ChatRole = {
  id: string;
  name: string;
  icon: string;
  description?: string | null;
  category?: string;
};

export type Conversation = {
  id: string;
  title: string;
  roleId: string;
  updatedAt: Date;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  thinking?: boolean;
};
