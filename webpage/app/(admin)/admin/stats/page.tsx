'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import useSWR from 'swr';
import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { adminFetcher } from '@/lib/admin/client';

type StatsData = {
  summary: { totalTokens: number; totalCost: number };
  userRanking: {
    userId: string;
    email: string;
    messages: number;
    tokens: number;
    cost: number;
  }[];
  roleRanking: {
    roleId: string;
    name: string;
    icon: string | null;
    count: number;
  }[];
  tokenTrend: { date: string; tokens: number }[];
};

export default function AdminStatsPage() {
  const [range, setRange] = useState('7d');
  const { data, isLoading } = useSWR<StatsData>(
    `/api/v1/admin/stats?range=${range}`,
    adminFetcher,
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">使用统计</h1>
        <Select value={range} onValueChange={setRange}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7d">近 7 天</SelectItem>
            <SelectItem value="30d">近 30 天</SelectItem>
            <SelectItem value="all">全部</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading || !data ? (
        <Loader2 className="h-6 w-6 animate-spin" />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground">
                  Token 总消耗
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">
                  {data.summary.totalTokens.toLocaleString()}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground">
                  总成本
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">
                  ¥{data.summary.totalCost.toFixed(2)}
                </p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Token 消耗趋势</CardTitle>
            </CardHeader>
            <CardContent className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data.tokenTrend}>
                  <XAxis dataKey="date" tickFormatter={(v) => v.slice(5)} />
                  <YAxis />
                  <Tooltip />
                  <Line
                    type="monotone"
                    dataKey="tokens"
                    stroke="#6366F1"
                    strokeWidth={2}
                  />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">用户对话排行</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>用户</TableHead>
                      <TableHead>对话数</TableHead>
                      <TableHead>Tokens</TableHead>
                      <TableHead>成本</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.userRanking.slice(0, 10).map((u) => (
                      <TableRow key={u.userId}>
                        <TableCell>{u.email}</TableCell>
                        <TableCell>{u.messages}</TableCell>
                        <TableCell>{u.tokens.toLocaleString()}</TableCell>
                        <TableCell>¥{u.cost.toFixed(2)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">角色使用排行</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>角色</TableHead>
                      <TableHead>使用次数</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.roleRanking.map((r) => (
                      <TableRow key={r.roleId}>
                        <TableCell>
                          {r.icon} {r.name}
                        </TableCell>
                        <TableCell>{r.count}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
