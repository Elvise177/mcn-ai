'use client';

import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { LayoutDashboard, LogOut, Plus, Settings, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { createClient } from '@/lib/supabase/client';
import type { Conversation } from '@/types/chat';

type ConversationListProps = {
  conversations: Conversation[];
  activeId: string | null;
  userEmail: string;
  isAdmin?: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
};

export function ConversationList({
  conversations,
  activeId,
  userEmail,
  isAdmin = false,
  onSelect,
  onNew,
  onDelete,
}: ConversationListProps) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <aside className="flex h-full w-[260px] shrink-0 flex-col border-r bg-muted/40">
      <div className="p-3">
        <Button
          type="button"
          className="w-full gap-2 text-white hover:opacity-90"
          style={{ backgroundColor: '#FF3366' }}
          onClick={onNew}
        >
          <Plus className="h-4 w-4" />
          新对话
        </Button>
      </div>

      <ScrollArea className="flex-1 px-2">
        <div className="space-y-0.5 pb-2">
          {conversations.map((conversation) => (
            <ConversationItem
              key={conversation.id}
              conversation={conversation}
              active={conversation.id === activeId}
              onSelect={() => onSelect(conversation.id)}
              onDelete={() => onDelete(conversation.id)}
            />
          ))}
        </div>
      </ScrollArea>

      <div className="border-t p-3">
        <p className="mb-2 truncate text-xs text-muted-foreground" title={userEmail}>
          {userEmail}
        </p>
        <div className="flex items-center gap-1">
          {isAdmin && (
            <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
              <Link href="/admin" title="管理后台">
                <LayoutDashboard className="h-4 w-4" />
              </Link>
            </Button>
          )}
          <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
            <Link href="/settings" title="设置">
              <Settings className="h-4 w-4" />
            </Link>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title="退出登录"
            disabled={signingOut}
            onClick={handleSignOut}
          >
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </aside>
  );
}

type ConversationItemProps = {
  conversation: Conversation;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
};

function ConversationItem({
  conversation,
  active,
  onSelect,
  onDelete,
}: ConversationItemProps) {
  const relativeTime = formatDistanceToNow(conversation.updatedAt, {
    addSuffix: true,
    locale: zhCN,
  });

  return (
    <div
      className={cn(
        'group relative flex cursor-pointer items-start gap-2 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted',
        active && 'bg-muted',
      )}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      role="button"
      tabIndex={0}
    >
      {active && (
        <span
          className="absolute bottom-2 left-0 top-2 w-0.5 rounded-full"
          style={{ backgroundColor: '#FF3366' }}
        />
      )}
      <div className="min-w-0 flex-1 pl-1">
        <p className="truncate text-sm font-medium">{conversation.title}</p>
        <p className="text-xs text-muted-foreground">{relativeTime}</p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        title="删除会话"
      >
        <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
      </Button>
    </div>
  );
}
