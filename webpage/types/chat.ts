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
  /** RAG 命中的知识库参考条数（用于展示"参考了 N 条爆款"） */
  knowledgeCount?: number;
};
