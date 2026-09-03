"use client";

import { Suspense, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { CircleUserRound, KeyRound, LogOut, Search, Share2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AppSidebar } from "@/components/app-sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { apiErrorBody, clearToken } from "@/lib/axios";
import { api, type HdhiveResourceItem, type HdhiveTmdbItem } from "@/lib/api";
import { useShareDetail } from "@/hooks/use-share-detail";
import { FEATURES } from "@/lib/features";
import { PageCrumbs } from "@/components/page-crumbs";

// 两个弹框只在用到时才加载：它们（连同转存 / 目录选择弹框）不该进所有页面共享的首屏包，登录页也得为它们买单
const ShareDetailDialog = dynamic(() => import("@/components/ShareDetailDialog").then((m) => m.ShareDetailDialog), {
  ssr: false,
});
const HdhiveSearchDialog = dynamic(() => import("@/components/HdhiveSearchDialog").then((m) => m.HdhiveSearchDialog), {
  ssr: false,
});

function UserMenu({ onLogout }: { onLogout: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label="账号菜单">
          <CircleUserRound className="size-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuItem asChild>
          <Link href="/change-password">
            <KeyRound />
            修改密码
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onLogout}>
          <LogOut />
          退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function LayoutWrapper({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const share = useShareDetail();

  const [searchQuery, setSearchQuery] = useState("");
  // 手机上顶栏放不下输入框，分享链接改成图标 + 弹框
  const [shareBoxOpen, setShareBoxOpen] = useState(false);
  const [hdhiveOpen, setHdhiveOpen] = useState(false);
  const [hdhiveLoading, setHdhiveLoading] = useState(false);
  const [hdhiveTmdb, setHdhiveTmdb] = useState<HdhiveTmdbItem | null>(null);
  const [hdhiveAlternatives, setHdhiveAlternatives] = useState<HdhiveTmdbItem[]>([]);
  const [hdhiveResources, setHdhiveResources] = useState<HdhiveResourceItem[]>([]);
  const [hdhiveTotal, setHdhiveTotal] = useState(0);
  const [hdhiveError, setHdhiveError] = useState<string | null>(null);
  // 连续搜索时只认最后一次的结果，慢的旧响应不能盖掉新的
  const hdhiveSeqRef = useRef(0);

  // 登录页和强制改密码页都不显示导航等
  if (pathname === "/login" || pathname === "/change-password") {
    return <>{children}</>;
  }

  const logout = async () => {
    try {
      await api.auth.logout();
    } catch {
      // 即使API调用失败也要清除token
    }
    clearToken(); // 清除本地token
    router.push("/login"); // 退出后跳转到登录页
  };

  const runHdhiveSearch = async (
    options: { query?: string; tmdbId?: number; mediaType?: "movie" | "tv" } = {},
  ) => {
    const queryFromOptions = options.query?.trim();
    const queryFromState = searchQuery.trim();
    const queryToUse = queryFromOptions ?? queryFromState;
    const hasExplicit = Boolean(options.tmdbId && options.mediaType);
    if (!queryToUse && !hasExplicit) {
      toast.error("请输入要搜索的影视名称");
      return;
    }

    const seq = ++hdhiveSeqRef.current;
    setHdhiveOpen(true);
    setHdhiveLoading(true);
    setHdhiveError(null);
    setHdhiveTmdb(null);
    setHdhiveAlternatives([]);
    setHdhiveResources([]);
    setHdhiveTotal(0);

    try {
      const data = await api.hdhive.search(
        hasExplicit ? { tmdbId: options.tmdbId, mediaType: options.mediaType } : { query: queryToUse },
      );
      if (seq !== hdhiveSeqRef.current) return;
      setHdhiveTmdb(data?.tmdb ?? null);
      setHdhiveAlternatives(data?.alternatives ?? []);
      setHdhiveResources(data?.resources ?? []);
      setHdhiveTotal(data?.total ?? 0);
    } catch (err) {
      if (seq !== hdhiveSeqRef.current) return;
      setHdhiveError(apiErrorBody(err).message || (err as Error).message || "搜索失败");
      // HDHive 挂了时后端仍把 TMDB 结果放在错误体的 data 里，先把它们摆出来
      const fallback = (apiErrorBody(err) as { data?: { tmdb: HdhiveTmdbItem | null; alternatives: HdhiveTmdbItem[] } }).data;
      if (fallback) {
        setHdhiveTmdb(fallback.tmdb ?? null);
        setHdhiveAlternatives(fallback.alternatives ?? []);
      }
    } finally {
      if (seq === hdhiveSeqRef.current) setHdhiveLoading(false);
    }
  };

  const fetchShareDetail = (overrideUrl?: string) => share.load(overrideUrl ?? share.link);

  /** 手机弹框里点「查看」：先关掉输入弹框，转存弹框加载完自己会开 */
  const submitShareFromDialog = () => {
    if (!share.link.trim()) return;
    setShareBoxOpen(false);
    void fetchShareDetail();
  };

  const handle115UnlockedFromHdhive = (fullUrl: string) => {
    const url = (fullUrl || "").trim();
    if (!url) return;
    share.setLink(url);
    setHdhiveOpen(false);
    void share.load(url);
  };

  return (
    <>
      <SidebarProvider>
        <AppSidebar />
        {/* 内容列是浅灰画布，表格和面板用 bg-card 浮在上面；暗色下画布就是 background，面板靠 card 更亮来区分。
            min-w-0 不能少：它是侧栏旁边的 flex 项，默认 min-width:auto 会按宽表格的最小宽度算，连同侧栏把整页撑出横向滚动条 */}
        <SidebarInset className="min-w-0 bg-muted/50 dark:bg-background">
          <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background px-3 sm:px-4">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <SidebarTrigger className="-ml-1" />
              <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-5" />
              {/* 当前页名和子页面的返回键。它要读 query（日志页从历史进来时上一级是历史），静态导出下必须包在 Suspense 里 */}
              <Suspense fallback={null}>
                <PageCrumbs />
              </Suspense>
            </div>
            {/* 115 分享链接全站都能粘，回车或点「查看」打开转存弹框；手机上收成一个图标，点开再输入 */}
            <div className="hidden items-center gap-1.5 sm:flex">
              <div className="relative w-72">
                <Share2 className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="粘贴 115 分享链接，回车查看"
                  value={share.link}
                  onChange={(e) => share.setLink(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && fetchShareDetail()}
                  className="h-8 bg-muted/60 pl-8 text-sm shadow-none"
                />
              </div>
              <Button size="sm" variant="secondary" className="h-8" onClick={() => fetchShareDetail()} disabled={share.loading}>
                {share.loading ? "加载中..." : "查看"}
              </Button>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 sm:hidden"
              aria-label="查看 115 分享"
              onClick={() => setShareBoxOpen(true)}
            >
              <Share2 className="size-5" />
            </Button>
            {/* 影巢搜索入口暂时隐藏（lib/features.ts） */}
            {FEATURES.hdhiveSearch && (
              <div className="hidden items-center gap-1.5 sm:flex">
                <div className="relative w-64">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="搜索影视资源（TMDB → HDHive）"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && runHdhiveSearch()}
                    className="h-8 bg-muted/60 pl-8 text-sm shadow-none"
                  />
                </div>
                <Button size="sm" variant="secondary" className="h-8" onClick={() => runHdhiveSearch()} disabled={hdhiveLoading}>
                  {hdhiveLoading ? "搜索中..." : "搜索"}
                </Button>
              </div>
            )}
            <div className="flex items-center gap-0.5">
              <ThemeToggle />
              <UserMenu onLogout={logout} />
            </div>
          </header>
          {/* 所有页面共用这一个容器；表单类页面在自己内部再收窄到 max-w-3xl */}
          <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">{children}</div>
        </SidebarInset>
      </SidebarProvider>
      {/* 手机上的分享链接输入：靠上摆，免得软键盘弹起来把居中的弹框顶没了 */}
      <Dialog open={shareBoxOpen} onOpenChange={setShareBoxOpen}>
        <DialogContent className="top-20 translate-y-0 sm:max-w-md">
          <DialogHeader>
            <DialogTitle>查看 115 分享</DialogTitle>
            <DialogDescription>粘贴分享链接，看内容并转存到网盘</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              placeholder="https://115.com/s/..."
              value={share.link}
              onChange={(e) => share.setLink(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && submitShareFromDialog()}
            />
            <Button onClick={submitShareFromDialog} disabled={share.loading || !share.link.trim()}>
              {share.loading ? "加载中..." : "查看"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <ShareDetailDialog {...share.dialogProps} />
      {FEATURES.hdhiveSearch && (
        <HdhiveSearchDialog
          open={hdhiveOpen}
          onOpenChange={setHdhiveOpen}
          loading={hdhiveLoading}
          query={searchQuery}
          tmdb={hdhiveTmdb}
          alternatives={hdhiveAlternatives}
          resources={hdhiveResources}
          total={hdhiveTotal}
          errorMessage={hdhiveError}
          onPickAlternative={(item) =>
            runHdhiveSearch({ tmdbId: item.id, mediaType: item.mediaType })
          }
          onPan115Unlocked={handle115UnlockedFromHdhive}
        />
      )}
    </>
  );
}
