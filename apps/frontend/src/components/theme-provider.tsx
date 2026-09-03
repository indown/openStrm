"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

// 主题挂在 <html class="dark">，globals.css 的 @custom-variant dark 认的就是这个 class；
// next-themes 会在 hydration 前注入一段脚本设好 class，避免首屏闪白
export function ThemeProvider({ children, ...props }: React.ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange {...props}>
      {children}
    </NextThemesProvider>
  );
}
