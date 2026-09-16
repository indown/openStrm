"use client";

import { useEffect, useRef } from "react";

/** 扫一圈的周期。慢一点——它是背景，不是主角 */
const SWEEP_PERIOD_MS = 7200;
const RING_COUNT = 5;
const SPOKE_COUNT = 12;
const BLIP_COUNT = 7;
/** 扫描尾迹张开的角度，和尾迹里亮度衰减的快慢 */
const TRAIL = Math.PI * 0.42;
const TRAIL_SLICES = 22;
const BLIP_DECAY = 0.85;
const TAU = Math.PI * 2;

/** 静止时停在这个角度，有几个光点正好亮着，看得出是什么东西 */
const STILL_ANGLE = Math.PI * 0.75;

type Blip = { angle: number; radius: number };

/**
 * 登录页背景：一圈慢慢转的雷达扫描。
 *
 * 这个产品干的事就是盯着网盘找新东西，扫到才亮的光点说的是同一件事。
 * 用 canvas 2D 而不是 WebGL：几何图形而已，省掉一个依赖，颜色还能直接跟 --brand 走。
 * 系统设了"减少动态效果"就只画一帧静态的；标签页切走时停掉，不在后台空转。
 */
export function RadarBackdrop() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame: number | null = null;
    let width = 0;
    let height = 0;
    let brand = "oklch(0.6 0.13 220)";
    // 同一个透明度在两个主题下轻重不一样：浅色底上这个青蓝要更实一点才看得见，
    // 暗色底上扫描扇会显得重，收一点
    let gridAlpha = 0.1;
    let sweepAlpha = 0.24;

    // 光点的位置定下来就不变了，重绘时不要重新随机，否则一改窗口大小整片就跳
    const blips: Blip[] = Array.from({ length: BLIP_COUNT }, () => ({
      angle: Math.random() * TAU,
      radius: 0.38 + Math.random() * 0.55,
    }));

    const readTheme = () => {
      const value = getComputedStyle(document.documentElement).getPropertyValue("--brand").trim();
      if (value) brand = value;
      const dark = document.documentElement.classList.contains("dark");
      gridAlpha = dark ? 0.1 : 0.15;
      sweepAlpha = dark ? 0.24 : 0.3;
    };

    const resize = () => {
      // 2 倍封顶：再高的 dpr 对这种淡线没有肉眼可见的收益，只是白烧 GPU
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = (sweep: number) => {
      // 圆心放在登录卡片后面偏上的位置：卡片是不透明的，正好盖住最密的中心，只留外圈的弧
      const cx = width / 2;
      const cy = height * 0.42;
      const maxR = Math.hypot(Math.max(cx, width - cx), Math.max(cy, height - cy));

      ctx.clearRect(0, 0, width, height);
      ctx.strokeStyle = brand;
      ctx.fillStyle = brand;
      ctx.lineWidth = 1;

      ctx.globalAlpha = gridAlpha;
      for (let i = 1; i <= RING_COUNT; i++) {
        ctx.beginPath();
        ctx.arc(cx, cy, (maxR * i) / RING_COUNT, 0, TAU);
        ctx.stroke();
      }
      // 整组辐条转半格：正水平的那一根会横穿整屏，圆心又被卡片挡着，看着不像辐条像一条分割线
      for (let i = 0; i < SPOKE_COUNT; i++) {
        const a = ((i + 0.5) / SPOKE_COUNT) * TAU;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * maxR, cy + Math.sin(a) * maxR);
        ctx.stroke();
      }

      // 扫描扇形：切成若干薄片，越靠近前缘越亮。比 createConicGradient 省心，浏览器支持也不用挑
      for (let i = 0; i < TRAIL_SLICES; i++) {
        const t = i / TRAIL_SLICES;
        ctx.globalAlpha = sweepAlpha * t * t;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, maxR, sweep - TRAIL * (1 - t), sweep - TRAIL * (1 - t - 1 / TRAIL_SLICES));
        ctx.closePath();
        ctx.fill();
      }

      // 光点：亮度只看扫描线转过它多久，不用存状态，改窗口大小也不会闪
      for (const blip of blips) {
        const passed = (((sweep - blip.angle) % TAU) + TAU) % TAU;
        const lit = Math.exp(-passed / BLIP_DECAY);
        if (lit < 0.02) continue;
        ctx.globalAlpha = lit * 0.85;
        ctx.shadowBlur = 12;
        ctx.shadowColor = brand;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(blip.angle) * maxR * blip.radius, cy + Math.sin(blip.angle) * maxR * blip.radius, 2.5, 0, TAU);
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      ctx.globalAlpha = 1;
    };

    const stop = () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
    };

    const loop = (now: number) => {
      draw(((now % SWEEP_PERIOD_MS) / SWEEP_PERIOD_MS) * TAU - Math.PI / 2);
      frame = requestAnimationFrame(loop);
    };

    const start = () => {
      stop();
      readTheme();
      resize();
      if (motion.matches || document.hidden) {
        draw(STILL_ANGLE);
        return;
      }
      frame = requestAnimationFrame(loop);
    };

    start();

    // 主题切换只改 <html> 上的 class，颜色得重新读一遍
    const themeWatcher = new MutationObserver(start);
    themeWatcher.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    const onVisibility = () => start();
    window.addEventListener("resize", start);
    document.addEventListener("visibilitychange", onVisibility);
    motion.addEventListener("change", start);

    return () => {
      stop();
      themeWatcher.disconnect();
      window.removeEventListener("resize", start);
      document.removeEventListener("visibilitychange", onVisibility);
      motion.removeEventListener("change", start);
    };
  }, []);

  return <canvas ref={ref} aria-hidden className="pointer-events-none absolute inset-0 size-full" />;
}
