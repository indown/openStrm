import type { Metadata } from "next";
import  LayoutWrapper  from "@/components/LayoutWrapper";
import ClientAuthProvider from "@/components/ClientAuthProvider";
import { Toaster } from "@/components/ui/sonner"
import "./globals.css";

// 字体用系统字体栈（见 globals.css）：next/font/google 会在构建时去 Google 拉字体，离线或国内网络下 next build 直接失败

export const metadata: Metadata = {
  title: "OpenStrm",
  description: "OpenStrm：把 115 / OpenList 网盘里的媒体生成 strm 文件并同步到本地，供 Emby 等媒体库直接播放",
  icons: {
    icon: "/logo.png",
    shortcut: "/logo.png",
    apple: "/logo.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">
        <ClientAuthProvider>
          <LayoutWrapper>{children}</LayoutWrapper>
        </ClientAuthProvider>
        <Toaster />
      </body>
    </html>
  );
}
