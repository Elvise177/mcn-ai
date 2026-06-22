'use client';

import { Copy, Sparkles } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { toast } from 'sonner';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import type { ChatMessage, ChatRole } from '@/types/chat';

type MessageBubbleProps = {
  message: ChatMessage;
  role?: ChatRole;
};

export function MessageBubble({ message, role }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="bg-brand-gradient max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-relaxed text-primary-foreground shadow-soft">
          {message.content}
        </div>
      </div>
    );
  }

  const isThinking =
    message.thinking || (message.streaming && !message.content);

  return (
    <div className="flex gap-3">
      <Avatar className="h-8 w-8 shrink-0">
        <AvatarFallback className="border bg-card text-sm">
          {role?.icon ?? '🤖'}
        </AvatarFallback>
      </Avatar>

      <div className="min-w-0 flex-1 space-y-2">
        {!isThinking && message.knowledgeCount ? (
          <div className="inline-flex items-center gap-1 rounded-full bg-accent px-2.5 py-1 text-xs font-medium text-accent-foreground">
            <Sparkles className="h-3 w-3" />
            参考了 {message.knowledgeCount} 条爆款资料
          </div>
        ) : null}
        <div className="rounded-2xl border bg-card px-4 py-3 text-sm leading-relaxed shadow-soft">
          {isThinking ? (
            <p className="flex items-center gap-2 text-muted-foreground">
              <span className="inline-flex gap-1">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.3s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.15s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary" />
              </span>
              思考中
            </p>
          ) : (
            <>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  p: ({ children }) => (
                    <p className="my-2 first:mt-0 last:mb-0">{children}</p>
                  ),
                  h2: ({ children }) => (
                    <h2 className="mb-2 mt-4 text-base font-semibold first:mt-0">
                      {children}
                    </h2>
                  ),
                  h3: ({ children }) => (
                    <h3 className="mb-1 mt-3 text-sm font-semibold first:mt-0">
                      {children}
                    </h3>
                  ),
                  ul: ({ children }) => (
                    <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>
                  ),
                  ol: ({ children }) => (
                    <ol className="my-2 list-decimal space-y-1 pl-5">
                      {children}
                    </ol>
                  ),
                  li: ({ children }) => <li>{children}</li>,
                  strong: ({ children }) => (
                    <strong className="font-semibold">{children}</strong>
                  ),
                  code: ({ children }) => (
                    <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                      {children}
                    </code>
                  ),
                }}
              >
                {message.content}
              </ReactMarkdown>
              {message.streaming && (
                <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-foreground" />
              )}
            </>
          )}
        </div>

        {!message.streaming && !isThinking && message.content && (
          <CopyButton content={message.content} />
        )}
      </div>
    </div>
  );
}

function CopyButton({ content }: { content: string }) {
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(content);
      toast.success('已复制');
    } catch {
      toast.error('复制失败');
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
      onClick={handleCopy}
    >
      <Copy className="h-3.5 w-3.5" />
      复制
    </Button>
  );
}
