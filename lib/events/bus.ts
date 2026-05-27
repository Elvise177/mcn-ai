type EventHandler<T = unknown> = (payload: T) => Promise<void> | void;

class EventBus {
  private handlers: Map<string, EventHandler[]> = new Map();

  on<T>(event: string, handler: EventHandler<T>) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    this.handlers.get(event)!.push(handler as EventHandler);
  }

  off(event: string, handler: EventHandler) {
    const handlers = this.handlers.get(event);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    }
  }

  emit<T>(event: string, payload: T) {
    const handlers = this.handlers.get(event) || [];
    // 异步执行，不阻塞调用方
    Promise.allSettled(
      handlers.map(async (h) => {
        try {
          await h(payload);
        } catch (e) {
          console.error(`[EventBus] Handler error for ${event}:`, e);
        }
      }),
    );
  }
}

export const eventBus = new EventBus();

export const Events = {
  // V1.0 事件
  USER_MESSAGE_SENT: 'user.message.sent',
  AI_RESPONSE_GENERATED: 'ai.response.generated',
  CONVERSATION_CREATED: 'conversation.created',
  CONVERSATION_DELETED: 'conversation.deleted',
  USER_LOGGED_IN: 'user.logged_in',
  USER_LOGGED_OUT: 'user.logged_out',
  ADMIN_PROMPT_UPDATED: 'admin.prompt.updated',
  ADMIN_ROLE_CREATED: 'admin.role.created',
  ADMIN_USER_CREATED: 'admin.user.created',
  ERROR_OCCURRED: 'error.occurred',
} as const;

export type EventName = (typeof Events)[keyof typeof Events];
