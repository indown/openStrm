import type { Metadata, Viewport } from "next";
import LayoutWrapper from "@/components/LayoutWrapper";
import ClientAuthProvider from "@/components/ClientAuthProvider";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
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

// 浏览器地址栏 / 手机状态栏的配色跟主题走。只认系统偏好：next-themes 手动切换只改 class，不会更新这个 meta
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning：next-themes 在客户端给 <html> 加 class，服务端渲染的没有，这是预期内的差异
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="antialiased">
        <ThemeProvider>
          <ClientAuthProvider>
            <LayoutWrapper>{children}</LayoutWrapper>
          </ClientAuthProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
