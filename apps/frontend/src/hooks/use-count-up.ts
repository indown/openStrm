"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 让数字滚到位，而不是一下跳过去。
 *
 * 目标值中途又变了（实时日志里每来一个文件就变一次）就从当前显示的值接着滚，不会回跳到起点。
 * 系统设了"减少动态效果"时直接返回目标值。
 */
export function useCountUp(target: number, duration = 400): number {
  const [display, setDisplay] = useState(target);
  // 当前显示值也存一份 ref：effect 要读它当起点，但它不能进依赖数组，否则每一帧都会重跑
  const displayRef = useRef(target);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const from = displayRef.current;
    if (from === target) return;

    const settle = () => {
      displayRef.current = target;
      setDisplay(target);
    };
    if (!Number.isFinite(target) || !Number.isFinite(from)) {
      settle();
      return;
    }
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      settle();
      return;
    }

    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      if (t >= 1) {
        settle();
        return;
      }
      // easeOutCubic：起步快、收尾稳，几个数的小变化也不显得拖
      displayRef.current = from + (target - from) * (1 - Math.pow(1 - t, 3));
      setDisplay(displayRef.current);
      frameRef.current = requestAnimationFrame(step);
    };
    frameRef.current = requestAnimationFrame(step);

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [target, duration]);

  return Math.round(display);
}
