"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { CircleUserRound, CloudDownload, KeyRound, Link2Off, LogOut, Search, Share2, Telescope } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
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
import { inputKindOf, unsupportedInputMessage } from "@/lib/share";
import { offlineHandoffHref } from "@/lib/offline";
import { requestResourceSearch, searchHref } from "@/lib/resource";
import { FEATURES } from "@/lib/features";
import { PageCrumbs } from "@/components/page-crumbs";
import { useModKey } from "@/hooks/use-mod-key";

// 两个弹框只在用到时才加载：它们（连同转存 / 目录选择弹框）不该进所有页面共享的首屏包，登录页也得为它们买单
const ShareDetailDialog = dynamic(() => import("@/components/ShareDetailDialog").then((m) => m.ShareDetailDialog), {
  ssr: false,
});
const HdhiveSearchDialog = dynamic(() => import("@/components/HdhiveSearchDialog").then((m) => m.HdhiveSearchDialog), {
  ssr: false,
});
const CommandPalette = dynamic(() => import("@/components/command-palette").then((m) => m.CommandPalette), {
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const modKey = useModKey();

  // ⌘K / Ctrl+K 开命令面板。这个 effect 必须待在下面那个提前 return 前面，不然 hooks 顺序会变
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "k" || !(e.metaKey || e.ctrlKey)) return;
      // 面板自己开着时再按一次是关掉
      if (paletteOpen) {
        e.preventDefault();
        setPaletteOpen(false);
        return;
      }
      // 别的弹框开着就不抢：两层 Radix Dialog 的焦点陷阱会打架
      if (document.querySelector('[data-slot="dialog-content"],[data-slot="alert-dialog-content"]')) return;
      e.preventDefault();
      setPaletteOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen]);

  // 智能体给的「在 OpenStrm 里打开」链接：任意页面带 ?share=<分享链接> 就弹出转存框。
  // 加载完才把参数从地址栏摘掉（摘了刷新就不会再弹）：加载时撞上登录失效会跳登录页，记下的回跳地址里
  // 得还带着它，重新登录回来照样弹。和 ⌘K 那个一样必须待在下面那个提前 return 前面
  useEffect(() => {
    if (pathname === "/login" || pathname === "/change-password") return;
    const link = new URLSearchParams(window.location.search).get("share")?.trim();
    if (!link) return;
    void share.load(link, { openImmediately: true }).finally(() => {
      const params = new URLSearchParams(window.location.search);
      if (!params.has("share")) return;
      params.delete("share");
      const rest = params.toString();
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
    });
    // share.load 每次渲染都是新函数；这里只该在进页面时读一次地址
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

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

  // 资源搜索页自己有一个大搜索框，顶栏再摆一个就重复了
  const onSearchPage = pathname === "/search" || pathname.startsWith("/search/");

  /**
   * 顶栏输入框和 ⌘K 里打的字，按是什么分开走：认得的分享链接打开转存框（和以前一样）；磁力、电驴、下载链接去云下载页、
   * 添加框预填好；认不出的链接当场说一声（不拿网址去搜）；别的文字当片名，去资源搜索页搜。
   * 没配 PanSou 的话搜索页自己会说「还没配置」并给去设置的按钮
   */
  const routeInput = (text: string) => {
    const kind = inputKindOf(text);
    if (kind === "unsupported") {
      toast.error(unsupportedInputMessage(text));
      return;
    }
    if (kind === "share") {
      void share.load(text);
      return;
    }
    share.setLink("");
    if (kind === "offline") {
      router.push(offlineHandoffHref(text));
      return;
    }
    // 本来就在资源搜索页（⌘K）：交给页面，和在它自己的框里按回车一样——同一个词要重搜，
    // 换地址做不到（地址没变），还会把选着的 TMDB 候选、外文原名丢掉。页面还没加载出来才换地址
    if (onSearchPage && requestResourceSearch(text)) return;
    router.push(searchHref(text));
  };
  const inputKind = inputKindOf(share.link);
  const submitLabel = share.loading ? "加载中..." : inputKind === "offline" ? "云下载" : inputKind === "search" ? "搜索" : "查看";
  const submitTopbar = () => {
    const text = share.link.trim();
    if (text) routeInput(text);
  };

  /** 手机弹框里点「查看 / 搜索」：先关掉输入弹框，转存弹框加载完自己会开；认不出的链接留在弹框里好改 */
  const submitShareFromDialog = () => {
    const text = share.link.trim();
    if (!text) return;
    if (inputKindOf(text) !== "unsupported") setShareBoxOpen(false);
    routeInput(text);
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
          <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-border/60 bg-background/80 px-3 backdrop-blur-md sm:px-4">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <SidebarTrigger className="-ml-1" />
              <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-5" />
              {/* 当前页名和子页面的返回键。它要读 query（日志页从历史进来时上一级是历史），静态导出下必须包在 Suspense 里 */}
              <Suspense fallback={null}>
                <PageCrumbs />
              </Suspense>
            </div>
            {/* 全站都能用：打片名回车去资源搜索，粘 115 / 夸克分享链接回车打开转存弹框；手机上收成一个图标，点开再输入 */}
            {!onSearchPage && (
              <>
                <div className="hidden items-center gap-1.5 sm:flex">
                  <div className="relative w-72">
                    {inputKind === "share" ? (
                      <Share2 className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                    ) : inputKind === "offline" ? (
                      <CloudDownload className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                    ) : inputKind === "unsupported" ? (
                      <Link2Off className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                    ) : (
                      <Telescope className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                    )}
                    <Input
                      placeholder="搜资源，或粘贴分享 / 磁力链接"
                      value={share.link}
                      onChange={(e) => share.setLink(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && submitTopbar()}
                      className="h-8 bg-muted/60 pl-8 text-sm shadow-none"
                    />
                  </div>
                  <Button size="sm" variant="secondary" className="h-8" onClick={submitTopbar} disabled={share.loading}>
                    {submitLabel}
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 sm:hidden"
                  aria-label="搜资源或查看分享"
                  onClick={() => setShareBoxOpen(true)}
                >
                  <Telescope className="size-5" />
                </Button>
              </>
            )}
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
            <div className="flex items-center gap-1">
              {/* 命令面板的入口。手机没有 ⌘K，这个按钮是唯一的路 */}
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 px-2 text-muted-foreground"
                onClick={() => setPaletteOpen(true)}
                aria-label="命令面板"
                title="命令面板"
              >
                <Search className="size-4" />
                <kbd className="hidden font-mono text-[10px] sm:inline">{modKey}K</kbd>
              </Button>
              <ThemeToggle />
              <UserMenu onLogout={logout} />
            </div>
          </header>
          {/* 所有页面共用这一个容器；表单类页面在自己内部再收窄到 max-w-3xl。
              宽度给到 88rem 是为了表格：strm 管理、整理、云下载这些页的主要内容是长路径，
              72rem 的时候 1920 屏上两侧各空 300px，而路径列在拼命折行 */}
          <div className="mx-auto w-full max-w-[88rem] flex-1 px-4 py-6 sm:px-6">{children}</div>
        </SidebarInset>
      </SidebarProvider>
      {/* 手机上的分享链接输入：靠上摆，免得软键盘弹起来把居中的弹框顶没了 */}
      <Dialog open={shareBoxOpen} onOpenChange={setShareBoxOpen}>
        <DialogContent size="sm" className="top-20 translate-y-0">
          <DialogHeader>
            <DialogTitle>搜资源或查看分享</DialogTitle>
            <DialogDescription>打片名去资源搜索页搜；粘贴分享链接看内容并转存到网盘；磁力、电驴交给 115 云下载</DialogDescription>
          </DialogHeader>
          <InputGroup>
            <InputGroupInput
              autoFocus
              placeholder="片名，或 https://pan.quark.cn/s/..."
              value={share.link}
              onChange={(e) => share.setLink(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && submitShareFromDialog()}
            />
            <InputGroupButton onClick={submitShareFromDialog} disabled={share.loading || !share.link.trim()}>
              {submitLabel}
            </InputGroupButton>
          </InputGroup>
        </DialogContent>
      </Dialog>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onOpenShare={() => setShareBoxOpen(true)}
        onInput={routeInput}
        onLogout={logout}
      />
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
