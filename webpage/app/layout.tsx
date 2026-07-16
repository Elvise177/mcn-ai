import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Toaster } from 'sonner';

import { registerEventHandlers } from '@/lib/events/register';

import './globals.css';

registerEventHandlers();

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'MCN AI',
  description: '带货 AI 操作台 — 长期迭代的 SaaS 平台',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className={inter.className}>
        {children}
        <Toaster position="top-center" richColors closeButton />
      </body>
    </html>
  );
}
