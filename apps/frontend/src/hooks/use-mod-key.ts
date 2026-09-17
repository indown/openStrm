"use client";

import { useEffect, useState } from "react";

/**
 * 快捷键提示里那个修饰键：Mac 上是 ⌘，别处是 Ctrl。
 *
 * 要等挂载后才能取 navigator —— 静态导出时服务端没有它，
 * 而且先渲染 "Ctrl" 再换成 "⌘" 也避免了 hydration 前后对不上。
 */
export function useModKey(): string {
  const [key, setKey] = useState("Ctrl");
  useEffect(() => {
    if (/Mac|iPhone|iPad|iPod/.test(navigator.userAgent)) setKey("⌘");
  }, []);
  return key;
}
