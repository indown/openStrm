"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export type Section = { id: string; title: string };

/**
 * 哪一节正对着视口上沿。
 *
 * 用 IntersectionObserver 而不是 scroll 事件：不用自己节流，也不会每帧去读布局。
 * 上沿减掉顶栏的高度，下沿收到 70%，于是"当前"只可能是靠近页面顶部的那一节 ——
 * 否则一屏里同时露着三节，最下面那节也会抢到高亮。
 */
function useActiveSection(sections: Section[]): string {
  const [active, setActive] = useState(sections[0]?.id ?? "");

  useEffect(() => {
    const visible = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.set(e.target.id, e.isIntersecting);
        // 按页面顺序取第一个还在带子里的；一个都不在就保持原样（滚到最底部时会这样）
        const first = sections.find((s) => visible.get(s.id));
        if (first) setActive(first.id);
      },
      { rootMargin: "-72px 0px -70% 0px" },
    );
    for (const s of sections) {
      const el = document.getElementById(s.id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [sections]);

  return active;
}

/**
 * 设置页右侧那条分区导航。
 *
 * 这页有八节、近千行，加了保存条之后"存不了"的问题没了，"找不到"还在。
 * 只在 xl 以上出现。断点不是 lg：媒体查询看的是视口，视口 1024 时内容区只剩 768，
 * 再让出 176 的导航，两列表单就被压到 560 了 —— 要等视口 1280 才真的有富余。
 */
export function SectionNav({ sections }: { sections: Section[] }) {
  const active = useActiveSection(sections);

  return (
    <nav aria-label="设置分区" className="sticky top-20 hidden w-44 shrink-0 self-start xl:block">
      <ul className="border-l">
        {sections.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              aria-current={active === s.id ? "true" : undefined}
              className={cn(
                "-ml-px block border-l-2 px-3 py-1.5 text-sm transition-colors",
                active === s.id
                  ? "border-brand text-foreground font-medium"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {s.title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
