"use client";

/**
 * 海报背景：一面 3D 倾斜的海报墙，压暗压糊，铺在内容后面。
 *
 *   stream  多个作品：若干列各自缓慢上下漂移，列在 Z 轴上深浅不一——越远越小、越糊、越暗
 *   single  已经进到某一部作品里：就这一张，倾斜、放大、糊掉，完全静止
 *
 * 规矩（改这里之前先想清楚）：
 *   - 纯装饰，`pointer-events-none` + `aria-hidden`，不进焦点链，不承载任何信息；
 *   - 有任务在跑时 `muted`，淡出并停住 rAF —— 这个后台里「动」的意思是「有任务在跑」，不能被背景稀释；
 *   - 窄屏、reduced-motion、页面切到后台都各有兜底。
 *
 * 层级：页面根节点套 `relative z-0`（在内容列的 bg-muted/50 之上自成一个层叠上下文），
 * 这一层放在它里面、自己是 `-z-10`：于是它在那层底色之上、在面板和文字之下。
 * 根节点是 z-0 而不是 z-10，让顶栏（sticky z-20）盖在它上面；左右两边按 sidebar-inset 的
 * 实测位置收住，不然这层 fixed 会一路铺到侧栏的导航上去。
 * 想让墙从表格后面透出来，那一页的面板要改成 bg-card/60 + backdrop-blur-sm。
 *
 * 几何上的坑（踩过一次）：透视里元素的 Z 一旦逼近相机距离（CSS 的 perspective 值），投影就会炸开，
 * 一张海报能被放大到几万像素宽。所以墙的尺寸按视口算、不用 scale() 放大（scale 连 Z 一起放大），
 * 倾角压在 10° / 14°：最坏情况的 Z 位移只有 perspective 的四分之一，放大倍率稳定在 0.7~1.4。
 */
import { useEffect, useMemo, useRef, useState } from "react";

export interface BackdropPoster {
  /** 稳定的键，一般是目录相对路径 */
  key: string;
  url: string;
}

type PosterBackdropProps = {
  mode: "stream" | "single";
  posters: BackdropPoster[];
  /** 有任务在跑 / 在搜索：淡出并停住 */
  muted?: boolean;
};

const TILE_W = 190;
const TILE_H = 285;
const GAP = 20;
/**
 * 墙比视口大出这么多倍。倾角越大远端收缩越厉害，这两个数要跟着给够，
 * 否则屏幕左上角（最远的那个角）会露出墙外的底色。和倾角一起调，别单独动。
 */
const OVERSCAN_X = 1.7;
const OVERSCAN_Y = 1.5;
/** 基准速度（px/s）。参考实现是 42，那是给落地页的；这是工作页的背景，慢到余光不被拽走为止 */
const SPEED = 12;
/** 列的深度范围（px）。和 globals.css 里的 perspective 一起决定放大倍率 */
const Z_NEAR = 40;
const Z_FAR = -300;
/**
 * 整面墙先往后推这么多，再摆列。推得越远，近端那几列离相机越安全、瓦片也越小越密——
 * 倾角和墙的尺寸每次调大，这个值都要跟着往后加，不能只动一个。
 */
const PLANE_Z = -120;
/** 墙的尺寸上限：超宽屏上不设限的话，斜着的墙左右两端会伸到相机跟前 */
const PLANE_MAX_W = 3600;
const PLANE_MAX_H = 1800;

/** 每列的深度、速度都按黄金分割取个稳定的伪随机——不能用 Math.random，重渲染要拿到同一面墙 */
const pseudo = (i: number, seed: number): number => ((i * 0.6180339887 + seed) % 1) * 2 - 1;

interface Column {
  z: number;
  /** 远处糊、淡，近处清楚、实——空气透视 */
  blur: number;
  opacity: number;
  velocity: number;
  items: BackdropPoster[];
  copies: number;
}

function buildColumns(posters: BackdropPoster[], count: number, planeH: number): Column[] {
  const buckets: BackdropPoster[][] = Array.from({ length: count }, () => []);
  posters.forEach((p, i) => buckets[i % count].push(p));
  const unit = TILE_H + GAP;
  return buckets.map((bucket, c) => {
    // 列里没分到海报（作品数比列数少）就整列复用全部海报，别留空列
    const items = bucket.length > 0 ? bucket : posters;
    const z = Z_FAR + ((pseudo(c, 0.35) + 1) / 2) * (Z_NEAR - Z_FAR);
    const near = (z - Z_FAR) / (Z_NEAR - Z_FAR);
    return {
      z,
      blur: 6 - near * 4.5,
      opacity: 0.5 + near * 0.5,
      velocity: SPEED * (0.7 + Math.abs(pseudo(c, 0.72)) * 0.8) * (c % 2 === 0 ? 1 : -1),
      items,
      // 无缝循环只要「一份的高度 ≥ 墙高 + 一块」，多铺就是白渲染
      copies: Math.max(2, Math.ceil((planeH + unit) / (items.length * unit)) + 1),
    };
  });
}

export function PosterBackdrop({ mode, posters, muted = false }: PosterBackdropProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRefs = useRef<(HTMLDivElement | null)[]>([]);
  const offsets = useRef<number[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [viewport, setViewport] = useState({ w: 1440, h: 900 });
  /** 只铺内容列，不铺侧栏：量出内容列的左边和宽度，跟着侧栏展开 / 收起变 */
  const [box, setBox] = useState<{ left: number; width: number } | null>(null);

  useEffect(() => {
    const host = rootRef.current?.parentElement?.closest("[data-slot=\"sidebar-inset\"]");
    if (!host) return;
    const measure = () => {
      const r = host.getBoundingClientRect();
      setBox({ left: r.left, width: r.width });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  // 窄屏不渲染：手机上这两页是卡片列表，背景只会拖慢它
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 640px)");
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      setEnabled(wide.matches);
      setReduced(motion.matches);
      setViewport({ w: window.innerWidth || 1440, h: window.innerHeight || 900 });
    };
    sync();
    wide.addEventListener("change", sync);
    motion.addEventListener("change", sync);
    window.addEventListener("resize", sync);
    return () => {
      wide.removeEventListener("change", sync);
      motion.removeEventListener("change", sync);
      window.removeEventListener("resize", sync);
    };
  }, []);

  const planeH = Math.min(Math.max(viewport.h * OVERSCAN_Y, 900), PLANE_MAX_H);
  const columnCount = Math.max(3, Math.ceil(Math.min(viewport.w * OVERSCAN_X, PLANE_MAX_W) / (TILE_W + GAP)));
  const columns = useMemo(
    () => (mode === "stream" && posters.length > 0 ? buildColumns(posters, columnCount, planeH) : []),
    [mode, posters, columnCount, planeH],
  );

  const running = enabled && !muted && !reduced && columns.length > 0;

  useEffect(() => {
    if (!running) return;
    const unit = TILE_H + GAP;
    if (offsets.current.length !== columns.length) {
      offsets.current = columns.map((_, c) => unit * ((c * 0.37) % 1));
    }
    let raf = 0;
    let last: number | null = null;
    const step = (ts: number) => {
      if (last === null) last = ts;
      const dt = Math.min(0.05, Math.max(0, ts - last) / 1000);
      last = ts;
      for (let c = 0; c < columns.length; c++) {
        const span = columns[c].items.length * unit;
        const next = ((((offsets.current[c] ?? 0) + columns[c].velocity * dt) % span) + span) % span;
        offsets.current[c] = next;
        const el = trackRefs.current[c];
        if (el) el.style.transform = `translate3d(0, ${-next}px, 0)`;
      }
      raf = requestAnimationFrame(step);
    };
    const start = () => {
      if (!raf && !document.hidden) raf = requestAnimationFrame(step);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      last = null;
    };
    // 页面切到后台就别烧电了
    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVisibility);
    start();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [running, columns]);

  if (!enabled || posters.length === 0) return null;

  return (
    <div
      ref={rootRef}
      aria-hidden="true"
      className="poster-backdrop pointer-events-none fixed inset-y-0 -z-10 overflow-hidden transition-opacity duration-700"
      style={{ opacity: muted ? 0 : 1, left: box?.left ?? 0, width: box?.width ?? "100%" }}
    >
      {mode === "single" ? (
        <div className="absolute inset-0" style={{ opacity: "var(--pb-single-opacity)" }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- 装饰图，不走 next/image 的优化和占位 */}
          <img
            src={posters[0].url}
            alt=""
            className="absolute top-1/2 left-1/2 h-[135%] w-[135%] object-cover"
            style={{
              transform: "translate(-50%, -50%) rotateX(16deg) rotateY(-14deg)",
              filter: "blur(var(--pb-single-blur)) saturate(0.8)",
            }}
          />
        </div>
      ) : (
        <div
          className="absolute top-1/2 left-1/2 flex"
          style={{
            width: columnCount * (TILE_W + GAP),
            height: planeH,
            opacity: "var(--pb-opacity)",
            // 先转再沿着墙自己的法线往后推（和参考实现同一套写法）
            transform: `translate(-50%, -50%) rotateX(16deg) rotateY(-14deg) translateZ(${PLANE_Z}px)`,
            transformStyle: "preserve-3d",
          }}
        >
          {columns.map((col, c) => (
            <div
              key={`col-${c}`}
              className="h-full overflow-hidden"
              style={{
                width: TILE_W + GAP,
                transform: `translateZ(${col.z.toFixed(0)}px)`,
                filter: `blur(${col.blur.toFixed(1)}px) saturate(0.75)`,
                opacity: col.opacity,
              }}
            >
              <div
                className="will-change-transform"
                ref={(el) => {
                  trackRefs.current[c] = el;
                }}
                style={{ transform: `translate3d(0, ${-(offsets.current[c] ?? 0)}px, 0)` }}
              >
                {Array.from({ length: col.copies }).map((_, copy) =>
                  col.items.map((item, i) => (
                    <div key={`${copy}-${i}-${item.key}`} style={{ height: TILE_H + GAP, padding: GAP / 2 }}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- 同上。不加 loading=lazy：3D 变换里浏览器判不准可见性，会一张都不加载 */}
                      <img
                        src={item.url}
                        alt=""
                        decoding="async"
                        draggable={false}
                        className="h-full w-full rounded-xl object-cover"
                      />
                    </div>
                  )),
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
