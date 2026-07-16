'use client';

import { format } from 'date-fns';
import { Loader2 } from 'lucide-react';
import useSWR from 'swr';
import {
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { adminFetcher } from '@/lib/admin/client';

type DashboardData = {
  kpis: {
    todayConversations: number;
    activeUsers: number;
    monthlyTokens: number;
    monthlyCost: number;
  };
  roleUsage: { id: string; name: string; icon: string | null; count: number }[];
  conversationTrend: { date: string; count: number }[];
  recentConversations: {
    id: string;
    title: string;
    userEmail: string;
    roleName: string;
    messageCount: number;
    updatedAt: string;
  }[];
};

const COLORS = ['#FF3366', '#FF6B9D', '#FFB3C6', '#6366F1', '#22C55E'];

export default function AdminDashboardPage() {
  const { data, isLoading, error } = useSWR<DashboardData>(
    '/api/v1/admin/dashboard',
    adminFetcher,
  );

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !data) {
    return <p className="text-destructive">加载失败</p>;
  }

  const pieData = data.roleUsage.filter((r) => r.count > 0);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">总览 Dashboard</h1>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard title="今日对话数" value={String(data.kpis.todayConversations)} />
        <KpiCard title="活跃用户数" value={String(data.kpis.activeUsers)} />
        <KpiCard
          title="本月 Token 消耗"
          value={data.kpis.monthlyTokens.toLocaleString()}
        />
        <KpiCard
          title="本月成本"
          value={`¥${data.kpis.monthlyCost.toFixed(2)}`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">角色使用分布</CardTitle>
          </CardHeader>
          <CardContent className="h-72">
            {pieData.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无使用数据</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="count"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={90}
                    label={({ name, value }) => `${name}: ${value}`}
                  >
                    {pieData.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">最近 7 天对话趋势</CardTitle>
          </CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.conversationTrend}>
                <XAxis
                  dataKey="date"
                  tickFormatter={(v) => v.slice(5)}
                  fontSize={12}
                />
                <YAxis allowDecimals={false} fontSize={12} />
                <Tooltip />
                <Line
                  type="monotone"
                  dataKey="count"
                  stroke="#FF3366"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">最近 10 条对话</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>用户</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>标题</TableHead>
                <TableHead>消息数</TableHead>
                <TableHead>时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.recentConversations.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>{c.userEmail || '-'}</TableCell>
                  <TableCell>{c.roleName || '-'}</TableCell>
                  <TableCell className="max-w-[200px] truncate">
                    {c.title}
                  </TableCell>
                  <TableCell>{c.messageCount}</TableCell>
                  <TableCell>
                    {format(new Date(c.updatedAt), 'MM-dd HH:mm')}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function KpiCard({ title, value }: { title: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-bold">{value}</p>
      </CardContent>
    </Card>
  );
}
