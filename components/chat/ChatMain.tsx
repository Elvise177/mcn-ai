'use client';

import { Loader2, Menu } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { ChatMessage, ChatRole } from '@/types/chat';

import { ChatInput } from './ChatInput';
import { MessageBubble } from './MessageBubble';
import { RoleSelector } from './RoleSelector';

type ChatMainProps = {
  roles: ChatRole[];
  selectedRole: ChatRole;
  messages: ChatMessage[];
  inputValue: string;
  sending?: boolean;
  loadingMessages?: boolean;
  pageLoading?: boolean;
  onRoleChange: (role: ChatRole) => void;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onStop?: () => void;
  onOpenSidebar?: () => void;
};

export function ChatMain({
  roles,
  selectedRole,
  messages,
  inputValue,
  sending = false,
  loadingMessages = false,
  pageLoading = false,
  onRoleChange,
  onInputChange,
  onSend,
  onStop,
  onOpenSidebar,
}: ChatMainProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex h-14 shrink-0 items-center gap-1 border-b px-3 sm:px-4">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0 md:hidden"
          onClick={onOpenSidebar}
          title="对话列表"
        >
          <Menu className="h-5 w-5" />
        </Button>
        <RoleSelector
          roles={roles}
          selectedRole={selectedRole}
          onRoleChange={onRoleChange}
        />
      </header>

      <div className="min-h-0 flex-1">
        <ScrollArea className="h-full">
        <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
          {pageLoading || loadingMessages ? (
            <div className="flex h-[40vh] items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : messages.length === 0 ? (
            <div className="flex h-[40vh] flex-col items-center justify-center text-center text-muted-foreground">
              <span className="mb-3 text-4xl">{selectedRole.icon}</span>
              <p className="text-sm">
                与 {selectedRole.name} 开始对话
              </p>
              <p className="mt-1 text-xs">
                输入问题，Enter 发送
              </p>
            </div>
          ) : (
            messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                role={selectedRole}
              />
            ))
          )}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
      </div>

      <ChatInput
        role={selectedRole}
        value={inputValue}
        onChange={onInputChange}
        onSend={onSend}
        onStop={onStop}
        loading={sending}
        disabled={pageLoading}
      />
    </div>
  );
}
