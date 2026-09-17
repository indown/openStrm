"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * 开关：某个行为开着还是关着。多选（挑文件、挑账号）仍然用 Checkbox。
 *
 * 手写而不是引 @radix-ui/react-switch —— 一个 role="switch" 的 <button> 就够：
 * 空格 / 回车是 button 自带的，<label htmlFor> 对 button 也生效（button 是可关联标签的元素），
 * 省一个依赖。表单不靠原生提交取值，所以也不需要 Radix 那个隐藏 input。
 */
function Switch({
  className,
  checked = false,
  onCheckedChange,
  onClick,
  disabled,
  ...props
}: Omit<React.ComponentProps<"button">, "onChange" | "value" | "type"> & {
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
}) {
  const state = checked ? "checked" : "unchecked"
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-slot="switch"
      data-state={state}
      disabled={disabled}
      // 外面传的 onClick 先跑；它 preventDefault 了就不翻转
      onClick={(e) => {
        onClick?.(e)
        if (!e.defaultPrevented) onCheckedChange?.(!checked)
      }}
      className={cn(
        "peer data-[state=checked]:bg-primary data-[state=unchecked]:bg-input dark:data-[state=unchecked]:bg-input/80",
        "focus-visible:border-ring focus-visible:ring-ring/50 inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:ring-[3px]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      <span
        data-slot="switch-thumb"
        data-state={state}
        className={cn(
          "bg-background dark:data-[state=unchecked]:bg-foreground dark:data-[state=checked]:bg-primary-foreground",
          "pointer-events-none block size-4 rounded-full ring-0 transition-transform",
          "data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0"
        )}
      />
    </button>
  )
}

export { Switch }
