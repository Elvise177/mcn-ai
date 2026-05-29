export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // 不设 overflow-hidden，导入/设置等页可整页滚动；聊天页自行 h-screen 锁高
  return <div className="min-h-screen">{children}</div>;
}
