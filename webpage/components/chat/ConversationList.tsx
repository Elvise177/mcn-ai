'use client';

import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import {
  Check,
  LayoutDashboard,
  LogOut,
  Pencil,
  Plus,
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent } from '@/components/ui/sheet';
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
  onRename: (id: string, title: string) => void;
  /** 移动端抽屉控制 */
  mobileOpen?: boolean;
  onMobileOpenChange?: (open: boolean) => void;
};

export function ConversationList(props: ConversationListProps) {
  const { mobileOpen = false, onMobileOpenChange } = props;

  return (
    <>
      {/* 桌面侧边栏 */}
      <aside className="hidden h-full w-[264px] shrink-0 flex-col border-r bg-muted/30 md:flex">
        <SidebarContent {...props} />
      </aside>

      {/* 移动端抽屉 */}
      <Sheet open={mobileOpen} onOpenChange={onMobileOpenChange}>
        <SheetContent side="left" className="w-[280px] p-0">
          <SidebarContent
            {...props}
            onSelect={(id) => {
              props.onSelect(id);
              onMobileOpenChange?.(false);
            }}
            onNew={() => {
              props.onNew();
              onMobileOpenChange?.(false);
            }}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}

function SidebarContent({
  conversations,
  activeId,
  userEmail,
  isAdmin = false,
  onSelect,
  onNew,
  onDelete,
  onRename,
}: ConversationListProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [signingOut, setSigningOut] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null);

  async function handleSignOut() {
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <div className="flex h-full flex-col">
      <div className="p-3">
        <Link href="/chat" className="mb-3 flex items-center gap-2 px-1">
          <span className="text-lg font-bold text-brand-gradient">OMG AI</span>
        </Link>
        <Button
          type="button"
          className="bg-brand-gradient w-full gap-2 font-medium"
          onClick={onNew}
        >
          <Plus className="h-4 w-4" />
          新对话
        </Button>
        <Link
          href="/import"
          className={cn(
            'mt-2 flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
            pathname === '/import'
              ? 'bg-accent font-medium text-accent-foreground'
              : 'text-muted-foreground hover:bg-muted',
          )}
        >
          <span>📥</span>
          <span>视频快速导入</span>
        </Link>
        <Link
          href="/edit-jobs"
          className={cn(
            'mt-1 flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
            pathname === '/edit-jobs'
              ? 'bg-accent font-medium text-accent-foreground'
              : 'text-muted-foreground hover:bg-muted',
          )}
        >
          <span>🎬</span>
          <span>自动剪辑</span>
        </Link>
      </div>

      <div className="flex-1 overflow-y-auto px-2">
        <div className="space-y-0.5 pb-2">
          {conversations.length === 0 ? (
            <p className="px-3 py-8 text-center text-xs text-muted-foreground">
              还没有对话，点击「新对话」开始
            </p>
          ) : (
            conversations.map((conversation) => (
              <ConversationItem
                key={conversation.id}
                conversation={conversation}
                active={conversation.id === activeId}
                onSelect={() => onSelect(conversation.id)}
                onDelete={() => setPendingDelete(conversation)}
                onRename={(title) => onRename(conversation.id, title)}
              />
            ))
          )}
        </div>
      </div>

      <div className="border-t p-3">
        <p
          className="mb-2 truncate text-xs text-muted-foreground"
          title={userEmail}
        >
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

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>删除对话</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            确定删除「{pendingDelete?.title}」？此操作不可恢复。
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingDelete) onDelete(pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

type ConversationItemProps = {
  conversation: Conversation;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
};

function ConversationItem({
  conversation,
  active,
  onSelect,
  onDelete,
  onRename,
}: ConversationItemProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(conversation.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function commit() {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== conversation.title) onRename(trimmed);
    setEditing(false);
  }

  const relativeTime = formatDistanceToNow(conversation.updatedAt, {
    addSuffix: true,
    locale: zhCN,
  });

  if (editing) {
    return (
      <div className="flex items-center gap-1 rounded-lg bg-muted px-2 py-1.5">
        <Input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setDraft(conversation.title);
              setEditing(false);
            }
          }}
          className="h-7 text-sm"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          onClick={commit}
        >
          <Check className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          onClick={() => {
            setDraft(conversation.title);
            setEditing(false);
          }}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'group relative flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted',
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
        <span className="absolute bottom-2 left-0 top-2 w-0.5 rounded-full bg-primary" />
      )}
      <div className="min-w-0 flex-1 pl-1">
        <p className="truncate text-sm font-medium">{conversation.title}</p>
        <p className="text-xs text-muted-foreground">{relativeTime}</p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity group-focus-within:opacity-100 md:opacity-0 md:group-hover:opacity-100">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          title="重命名"
          onClick={(e) => {
            e.stopPropagation();
            setDraft(conversation.title);
            setEditing(true);
          }}
        >
          <Pencil className="h-4 w-4 text-muted-foreground" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          title="删除会话"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
