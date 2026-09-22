"use client"

import * as React from "react"
import { XIcon } from "lucide-react"

import { cn } from "@/lib/utils"

type TagInputProps = {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  /**
   * 每条提交前过一道：返回 null 就丢掉。
   * 扩展名那几个字段用它补点号、转小写，挂载路径只去空白。
   */
  normalize?: (raw: string) => string | null
  disabled?: boolean
  className?: string
  id?: string
  /** FormControl 给的：说明文字 / 报错挂到里面那个 input 上，读屏才念得到 */
  "aria-describedby"?: string
  "aria-invalid"?: React.AriaAttributes["aria-invalid"]
}

const DEFAULT_NORMALIZE = (raw: string): string | null => {
  const v = raw.trim()
  return v ? v : null
}

/**
 * 一串短值的输入：回车或逗号落一个标签，退格删最后一个。
 *
 * 这个产品里扩展名、挂载路径都是"一串短值"，以前存成 `".mkv, .mp4, .ts"` 一个字符串，
 * 前后端各 split / trim / 补点号一遍，界面上还看不出哪几段是分开的。
 * 标签化之后值本身就是数组，规范化只在落标签这一刻发生一次。
 */
function TagInput({
  value,
  onChange,
  placeholder,
  normalize = DEFAULT_NORMALIZE,
  disabled,
  className,
  id,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
}: TagInputProps) {
  const [draft, setDraft] = React.useState("")
  const inputRef = React.useRef<HTMLInputElement>(null)
  const rootRef = React.useRef<HTMLDivElement>(null)
  /** 点 ✕ 删掉的是第几个：那个按钮带着焦点一起卸载了，值变了之后把焦点交给同一位置的下一个 ✕，删光了回输入框 */
  const refocusAt = React.useRef<number | null>(null)

  React.useLayoutEffect(() => {
    const i = refocusAt.current
    if (i === null) return
    refocusAt.current = null
    const buttons = rootRef.current?.querySelectorAll<HTMLButtonElement>("[data-slot=tag-input-remove]")
    ;(buttons?.[Math.min(i, buttons.length - 1)] ?? inputRef.current)?.focus()
  }, [value])

  const commit = (raw: string) => {
    const next = normalize(raw)
    setDraft("")
    if (!next || value.includes(next)) return
    onChange([...value, next])
  }

  const removeAt = (i: number) => onChange(value.filter((_, idx) => idx !== i))

  return (
    <div
      ref={rootRef}
      data-slot="tag-input"
      className={cn(
        "border-input dark:bg-input/30 flex min-h-9 w-full flex-wrap items-center gap-1 rounded-md border bg-transparent p-1 shadow-xs transition-[color,box-shadow]",
        "focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]",
        // 和 InputGroup 一样，校验失败的红框挂外壳
        "has-[input[aria-invalid=true]]:border-destructive has-[input[aria-invalid=true]]:ring-destructive/20 dark:has-[input[aria-invalid=true]]:ring-destructive/40",
        disabled && "cursor-not-allowed opacity-50",
        className
      )}
      // 点空白处也进输入框：标签之间的缝隙是这个控件最容易点到的地方
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault()
          inputRef.current?.focus()
        }
      }}
    >
      {value.map((tag, i) => (
        <span
          key={tag}
          data-slot="tag-input-tag"
          className="bg-muted flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-xs"
        >
          {tag}
          {!disabled && (
            <button
              type="button"
              data-slot="tag-input-remove"
              className="text-muted-foreground hover:text-foreground -mr-0.5 rounded-sm outline-none focus-visible:ring-ring/50 focus-visible:ring-[2px]"
              aria-label={`删除 ${tag}`}
              onClick={() => {
                refocusAt.current = i
                removeAt(i)
              }}
            >
              <XIcon className="size-3" />
            </button>
          )}
        </span>
      ))}
      <input
        ref={inputRef}
        id={id}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        disabled={disabled}
        value={draft}
        placeholder={value.length === 0 ? placeholder : ""}
        className="placeholder:text-muted-foreground h-6 min-w-24 flex-1 bg-transparent px-1.5 text-base outline-none disabled:cursor-not-allowed md:text-sm"
        onChange={(e) => {
          // 粘进来一整串 ".mkv, .mp4" 时就地拆开，不用一个个回车
          const raw = e.target.value
          if (/[,，]/.test(raw)) {
            const parts = raw.split(/[,，]/)
            const tail = parts.pop() ?? ""
            let next = value
            for (const p of parts) {
              const v = normalize(p)
              if (v && !next.includes(v)) next = [...next, v]
            }
            if (next !== value) onChange(next)
            setDraft(tail)
            return
          }
          setDraft(raw)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            // 别让回车顺手提交外面的表单
            e.preventDefault()
            commit(draft)
          } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
            e.preventDefault()
            removeAt(value.length - 1)
          }
        }}
        // 失焦也落一个：填完直接去点保存的人不该丢掉最后一条
        onBlur={() => commit(draft)}
      />
    </div>
  )
}

export { TagInput }
