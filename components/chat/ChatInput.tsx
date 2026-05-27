'use client';

import { Loader2, SendHorizontal } from 'lucide-react';
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
  loading?: boolean;
  disabled?: boolean;
};

export function ChatInput({
  role,
  value,
  onChange,
  onSend,
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
    <div className="border-t bg-background px-4 py-4">
      <p className="mb-2 text-xs text-muted-foreground">
        当前角色：{role.icon} {role.name}
      </p>
      <div className="flex items-end gap-2">
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="输入消息，Enter 发送，Shift+Enter 换行"
          disabled={disabled || loading}
          rows={1}
          className="min-h-[44px] max-h-[136px] resize-none focus-visible:ring-[#FF3366] focus-visible:border-[#FF3366]"
        />
        <Button
          type="button"
          size="icon"
          className="h-11 w-11 shrink-0 text-white hover:opacity-90"
          style={{ backgroundColor: '#FF3366' }}
          disabled={disabled || loading || !value.trim()}
          onClick={onSend}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <SendHorizontal className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
}
