"use client";

import { useState } from "react";
import Image from "next/image";
import { Film, Tv } from "lucide-react";
import { cn } from "@/lib/utils";

/** 影库作品的海报（2:3）：没有或加载失败画个图标；没认出的可以在图标下面写名字 */
export function WorkPoster({
  url,
  mediaType,
  label,
  className,
  sizes = "160px",
}: {
  url: string;
  mediaType?: "movie" | "tv" | null;
  /** 没海报时写在图标下面 */
  label?: string;
  className?: string;
  sizes?: string;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const Icon = mediaType === "tv" ? Tv : Film;
  return (
    <div className={cn("relative aspect-[2/3] w-full overflow-hidden rounded-md bg-muted", className)}>
      {url && broken !== url ? (
        <Image src={url} alt="" fill className="object-cover" sizes={sizes} unoptimized onError={() => setBroken(url)} />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 p-2 text-muted-foreground">
          <Icon className="size-6 shrink-0" />
          {label && <span className="line-clamp-3 text-center text-[11px] leading-tight [overflow-wrap:anywhere]">{label}</span>}
        </div>
      )}
    </div>
  );
}
