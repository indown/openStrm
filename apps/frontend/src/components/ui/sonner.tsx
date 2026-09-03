"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { useIsMobile } from "@/hooks/use-mobile"

// toast 跟着应用主题走（next-themes 解析后的 light / dark），颜色用 popover 的 token。
// 手机上从底部弹会挡住列表最后一行和卡片底部的操作按钮，改到顶部居中
const Toaster = ({ ...props }: ToasterProps) => {
  const { resolvedTheme } = useTheme()
  const isMobile = useIsMobile()
  return (
    <Sonner
      theme={(resolvedTheme as ToasterProps["theme"]) ?? "system"}
      position={isMobile ? "top-center" : "bottom-right"}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
