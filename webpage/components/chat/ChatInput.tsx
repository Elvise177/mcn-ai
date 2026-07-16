'use client';

import { SendHorizontal, Square } from 'lucide-react';
import { useCallback, useRef } from 'react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { ChatRole } from '@/types/chat';

const MAX_LINES = 5;
const LINE_HEIGHT_PX = 24;

type ChatInputProps = {
  role: ChatRole;
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop?: () => void;
  loading?: boolean;
  disabled?: boolean;
};

export function ChatInput({
  role,
  value,
  onChange,
  onSend,
  onStop,
  loading = false,
  disabled = false,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = LINE_HEIGHT_PX * MAX_LINES + 16;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, []);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!loading && value.trim()) {
        onSend();
      }
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    onChange(e.target.value);
    adjustHeight();
  }

  return (
    <div className="border-t bg-background px-3 py-3 sm:px-4 sm:py-4">
      <p className="mb-2 px-1 text-xs text-muted-foreground">
        当前角色：{role.icon} {role.name}
      </p>
      <div className="flex items-end gap-2 rounded-2xl border bg-card p-2 shadow-soft focus-within:border-primary/60 focus-within:ring-1 focus-within:ring-primary/30">
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="输入消息，Enter 发送，Shift+Enter 换行"
          disabled={disabled}
          rows={1}
          className="min-h-[40px] max-h-[136px] resize-none border-0 bg-transparent px-2 shadow-none focus-visible:ring-0"
        />
        {loading ? (
          <Button
            type="button"
            size="icon"
            variant="secondary"
            className="h-10 w-10 shrink-0"
            onClick={onStop}
            title="停止生成"
          >
            <Square className="h-3.5 w-3.5 fill-current" />
          </Button>
        ) : (
          <Button
            type="button"
            size="icon"
            className="bg-brand-gradient h-10 w-10 shrink-0"
            disabled={disabled || !value.trim()}
            onClick={onSend}
            title="发送"
          >
            <SendHorizontal className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
