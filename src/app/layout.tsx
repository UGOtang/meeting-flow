import './globals.css';

export const metadata = {
  title: 'Loro Cursor Demo',
  description: 'Next.js + Loro CRDT cursor sync',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
