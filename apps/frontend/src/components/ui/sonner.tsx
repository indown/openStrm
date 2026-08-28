"use client"

import { Toaster as Sonner, ToasterProps } from "sonner"

// 应用本身没有主题切换（始终浅色），toast 也固定浅色，别跟着系统的深色模式变
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
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
