"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { currentPage } from "@/lib/nav";

// 这个标签页里有没有发生过站内跳转。有过，返回键就真的后退，回到用户来的那一页（任务列表或历史）；
// 没有（直接打开的链接、刷新出来的），后退会跑出站外，改成跳到上一级
let navigatedInApp = false;

/** 顶栏里的当前页名；子页面前面多一个返回键，桌面上再带一段可点的面包屑 */
export function PageCrumbs() {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const page = currentPage(pathname, search);

  // 只认 pathname 的变化：日志页自己会 replace 一下 query 补 executionId，那不算跳转；
  // 比较上一次的值而不是"是否首次"，StrictMode 下 effect 跑两遍也不会误判
  const lastPathname = useRef(pathname);
  useEffect(() => {
    if (lastPathname.current !== pathname) {
      navigatedInApp = true;
      lastPathname.current = pathname;
    }
  }, [pathname]);

  if (!page) return null;
  const parent = page.parent;

  const goBack = () => {
    if (!parent) return;
    if (navigatedInApp) router.back();
    else router.push(parent.url);
  };

  return (
    <>
      {parent && (
        <Button variant="ghost" size="icon" className="-ml-1 size-8" aria-label={`返回${parent.title}`} onClick={goBack}>
          <ArrowLeft />
        </Button>
      )}
      <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
        {parent && (
          <>
            <Link href={parent.url} className="hidden text-muted-foreground hover:text-foreground sm:inline">
              {parent.title}
            </Link>
            <span className="hidden text-muted-foreground sm:inline">/</span>
          </>
        )}
        <span className="truncate">{page.title}</span>
      </div>
    </>
  );
}
