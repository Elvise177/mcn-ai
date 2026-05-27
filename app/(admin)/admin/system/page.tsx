'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import useSWR from 'swr';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { adminFetcher } from '@/lib/admin/client';
import type { SystemSettingsValue } from '@/types/admin';

type SystemResponse = {
  settings: SystemSettingsValue;
  defaults: SystemSettingsValue;
};

export default function AdminSystemPage() {
  const { data, isLoading, mutate } = useSWR<SystemResponse>(
    '/api/v1/admin/system',
    adminFetcher,
  );
  const [settings, setSettings] = useState<SystemSettingsValue | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data?.settings) setSettings(data.settings);
  }, [data]);

  if (isLoading || !settings) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch('/api/v1/admin/system', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      toast.success('系统配置已保存并生效');
      mutate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">系统配置</h1>
        <Button
          style={{ backgroundColor: '#FF3366' }}
          className="text-white"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? '保存中…' : '保存配置'}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">AI Provider</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>默认 Provider</Label>
            <Input
              value={settings.ai.defaultProvider}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  ai: { ...settings.ai, defaultProvider: e.target.value },
                })
              }
            />
          </div>
          <div className="space-y-2">
            <Label>默认模型</Label>
            <Input
              value={settings.ai.defaultModel}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  ai: { ...settings.ai, defaultModel: e.target.value },
                })
              }
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>默认温度</Label>
              <Input
                type="number"
                step="0.1"
                min="0"
                max="1"
                value={settings.ai.temperature}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    ai: {
                      ...settings.ai,
                      temperature: Number(e.target.value),
                    },
                  })
                }
              />
            </div>
            <div className="space-y-2">
              <Label>默认 Max Tokens</Label>
              <Input
                type="number"
                value={settings.ai.maxTokens}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    ai: {
                      ...settings.ai,
                      maxTokens: Number(e.target.value),
                    },
                  })
                }
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">限流配置</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {(
            Object.keys(settings.limits) as (keyof SystemSettingsValue['limits'])[]
          ).map((key) => (
            <div key={key} className="space-y-2">
              <Label>{key}</Label>
              <Input
                type="number"
                value={settings.limits[key]}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    limits: {
                      ...settings.limits,
                      [key]: Number(e.target.value),
                    },
                  })
                }
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">功能开关</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {Object.entries(settings.features).map(([key, enabled]) => (
            <div
              key={key}
              className="flex items-center justify-between rounded-lg border px-3 py-2"
            >
              <Label>{key}</Label>
              <Switch
                checked={enabled}
                onCheckedChange={(checked) =>
                  setSettings({
                    ...settings,
                    features: { ...settings.features, [key]: checked },
                  })
                }
              />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
