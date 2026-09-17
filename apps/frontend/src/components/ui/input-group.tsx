"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * 一个边框里装下"前缀 + 输入 + 按钮"。
 *
 * 这个产品输入的大多是路径，而路径很少是一截光秃秃的文本：前面挂着挂载点、后面跟着浏览按钮。
 * 以前是 `<Input class="flex-1">` 旁边并排一个 `<Button>`，两个独立控件各有各的边框和焦点环，
 * 读起来是两样东西；甚至有地方拿一个 disabled 的 Input 冒充后缀。
 *
 * 焦点环挂在外壳上（focus-within），里面的 input 自己不画边框，所以整组看起来是一个控件。
 */
function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group"
      className={cn(
        "border-input dark:bg-input/30 flex h-9 w-full min-w-0 items-center overflow-hidden rounded-md border bg-transparent shadow-xs transition-[color,box-shadow]",
        "focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]",
        // 校验失败的红环也挂外壳：里面的 input 没有边框，挂它身上看不见
        "has-[input[aria-invalid=true]]:border-destructive has-[input[aria-invalid=true]]:ring-destructive/20 dark:has-[input[aria-invalid=true]]:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

/** 组里的输入框：边框、阴影、焦点环都交给外壳 */
function InputGroupInput({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      data-slot="input-group-input"
      className={cn(
        "placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground h-full w-full min-w-0 flex-1 bg-transparent px-3 py-1 text-base outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      {...props}
    />
  )
}

/** 不可编辑的前缀 / 后缀，比如 302 自动拼上的 `/账号名` */
function InputGroupAddon({
  className,
  side = "end",
  ...props
}: React.ComponentProps<"span"> & { side?: "start" | "end" }) {
  return (
    <span
      data-slot="input-group-addon"
      className={cn(
        "text-muted-foreground bg-muted/60 flex h-full shrink-0 items-center px-2.5 text-sm font-medium",
        side === "start" ? "border-r" : "border-l",
        className
      )}
      {...props}
    />
  )
}

/** 贴在组内的按钮，比如"浏览目录"。焦点环画在内侧，免得被外壳裁掉 */
function InputGroupButton({ className, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      data-slot="input-group-button"
      className={cn(
        "text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring/50 flex h-full shrink-0 items-center gap-1.5 border-l px-2.5 text-sm transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
        className
      )}
      {...props}
    />
  )
}

export { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput }
