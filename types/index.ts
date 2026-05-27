export type { Database, Tables, TablesInsert, TablesUpdate } from './database';

export type UserRole =
  | 'member'
  | 'org_editor'
  | 'org_admin'
  | 'super_admin';

export type Conversation = {
  id: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type Message = {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
};
