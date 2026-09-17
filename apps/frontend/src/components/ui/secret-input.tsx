"use client"

import * as React from "react"
import { EyeIcon, EyeOffIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"

type SecretInputProps = Omit<React.ComponentProps<"input">, "type" | "value" | "onChange"> & {
  value: string
  onChange: (value: string) => void
  /**
   * 服务端回来的掩码（形如 `****1a2b`）。值还等于它，就说明库里存着一个、这次没动过。
   * 不传表示这个字段没有"已保存"的概念（比如新建账号）。
   */
  masked?: string
}

/**
 * 密钥 / Cookie 这类字段。
 *
 * 以前它们是普通文本框，"库里已经有一个、只回末 4 位、清空即删除"这些全写在下面一行灰字里，
 * 控件本身什么都不说；而且新打进去的密钥是明文显示的。现在状态落到控件上：
 *
 *   - 还是服务端那个掩码 → 右边挂「已保存」，明文显示（`****1a2b` 本来就是脱敏过的）
 *   - 自己打了新的        → 默认遮起来，右边给一个眼睛按钮
 *   - 空的                → 什么都不挂，说明这个密钥会被删掉
 */
function SecretInput({ value, onChange, masked, className, ...props }: SecretInputProps) {
  const [revealed, setRevealed] = React.useState(false)
  const untouched = Boolean(masked) && value === masked

  // 退回掩码状态时把眼睛收回去，免得下次输入直接是明文
  React.useEffect(() => {
    if (untouched) setRevealed(false)
  }, [untouched])

  return (
    <InputGroup className={className}>
      <InputGroupInput
        {...props}
        type={untouched || revealed ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        className={cn(untouched && "font-mono")}
      />
      {untouched ? (
        <InputGroupAddon>已保存</InputGroupAddon>
      ) : (
        value !== "" && (
          <InputGroupButton
            onClick={() => setRevealed((v) => !v)}
            aria-label={revealed ? "隐藏" : "显示"}
            title={revealed ? "隐藏" : "显示"}
          >
            {revealed ? <EyeOffIcon /> : <EyeIcon />}
          </InputGroupButton>
        )
      )}
    </InputGroup>
  )
}

export { SecretInput }
