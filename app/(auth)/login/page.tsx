'use client';

import { AlertCircle } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createClient } from '@/lib/supabase/client';

const BRAND = '#FF3366';

const inputClassName =
  'focus-visible:ring-[#FF3366] focus-visible:border-[#FF3366]';

function LoginPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const callbackError =
    searchParams.get('error') === 'auth_callback_failed'
      ? '登录验证失败，请重试或联系管理员。'
      : searchParams.get('error') === 'profile_setup_failed'
        ? '用户档案初始化失败，请联系管理员检查 Supabase 配置。'
        : searchParams.get('error') === 'account_disabled'
          ? '账号已被禁用，请联系管理员。'
          : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const supabase = createClient();

    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (signInError) {
        setError(translateAuthError(signInError.message));
        return;
      }

      await bootstrapProfile();
      router.push('/chat');
      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : '网络异常，请稍后重试。',
      );
    } finally {
      setLoading(false);
    }
  }

  const displayError = error ?? callbackError;

  return (
    <Card className="w-[400px] border-0 shadow-lg">
      <CardHeader className="space-y-4 pb-2 text-center">
        <div className="space-y-1">
          <p
            className="text-2xl font-bold tracking-tight"
            style={{ color: BRAND }}
          >
            MCN AI
          </p>
          <CardTitle className="text-lg font-semibold text-foreground">
            美妆带货AI操作台
          </CardTitle>
        </div>
        <CardDescription>使用管理员分配的账号登录</CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {displayError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{displayError}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label htmlFor="email">邮箱</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@company.com"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
              className={inputClassName}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              type="password"
              placeholder="请输入密码"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              className={inputClassName}
            />
          </div>

          <Button
            type="submit"
            className="w-full text-white hover:opacity-90"
            style={{ backgroundColor: BRAND }}
            disabled={loading}
          >
            {loading ? '登录中…' : '登录'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <Card className="w-[400px] border-0 shadow-lg">
          <CardHeader className="text-center">
            <CardTitle style={{ color: BRAND }}>美妆带货AI操作台</CardTitle>
            <CardDescription>加载中…</CardDescription>
          </CardHeader>
        </Card>
      }
    >
      <LoginPageContent />
    </Suspense>
  );
}

async function bootstrapProfile() {
  const res = await fetch('/api/v1/auth/bootstrap', { method: 'POST' });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? '创建用户档案失败');
  }
}

function translateAuthError(message: string): string {
  const map: Record<string, string> = {
    'Invalid login credentials': '邮箱或密码错误',
    'Email not confirmed': '邮箱尚未验证，请联系管理员',
    'Password should be at least 6 characters': '密码至少需要 6 位',
    'Unable to validate email address: invalid format': '邮箱格式不正确',
  };

  return map[message] ?? message;
}
