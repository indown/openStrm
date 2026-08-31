"use client";

import { useRef, useState } from "react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { Settings, Github, Share2, Search } from "lucide-react";
import { apiErrorBody, clearToken } from "@/lib/axios";
import { api, type HdhiveResourceItem, type HdhiveTmdbItem } from "@/lib/api";
import { useShareDetail } from "@/hooks/use-share-detail";
import { FEATURES } from "@/lib/features";
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarTrigger,
} from "@/components/ui/menubar";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

// 两个弹框只在用到时才加载：它们（连同转存 / 目录选择弹框）不该进所有页面共享的首屏包，登录页也得为它们买单
const ShareDetailDialog = dynamic(() => import("@/components/ShareDetailDialog").then((m) => m.ShareDetailDialog), {
  ssr: false,
});
const HdhiveSearchDialog = dynamic(() => import("@/components/HdhiveSearchDialog").then((m) => m.HdhiveSearchDialog), {
  ssr: false,
});

export default function LayoutWrapper({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const share = useShareDetail();

  const [searchQuery, setSearchQuery] = useState("");
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
          <SidebarTrigger />
          {/* min-w-0 + flex-1：内容列是侧栏旁边的 flex 项，w-full 会让它按视口 100% 算宽度、连同侧栏一起把页面撑出横向滚动条；
              收窄到 800px 以下时顶部搜索栏不换行、表格也滚不了自己的滚动条，全是这一处的锅 */}
          <div className="flex min-w-0 flex-1 flex-col min-h-screen">
            <header className="w-full border-b flex items-center gap-3 p-2 flex-wrap">
              <div className="flex items-center gap-2 flex-1 min-w-[200px] max-w-md">
                <Share2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                <Input
                  placeholder="粘贴 115 分享链接"
                  value={share.link}
                  onChange={(e) => share.setLink(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && fetchShareDetail()}
                  className="h-8 text-sm"
                />
                <Button size="sm" onClick={() => fetchShareDetail()} disabled={share.loading}>
                  {share.loading ? "加载中..." : "查看"}
                </Button>
              </div>
              {/* 影巢搜索入口暂时隐藏（lib/features.ts） */}
              {FEATURES.hdhiveSearch && (
                <div className="flex items-center gap-2 flex-1 min-w-[200px] max-w-md">
                  <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <Input
                    placeholder="搜索影视资源（TMDB → HDHive）"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && runHdhiveSearch()}
                    className="h-8 text-sm"
                  />
                  <Button
                    size="sm"
                    onClick={() => runHdhiveSearch()}
                    disabled={hdhiveLoading}
                  >
                    {hdhiveLoading ? "搜索中..." : "搜索"}
                  </Button>
                </div>
              )}
              <div className="ml-auto flex items-center gap-1">
                <a
                  href="https://github.com/indown/OpenStrm"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center justify-center rounded p-1 hover:bg-accent"
                  aria-label="GitHub"
                >
                  <Github className="h-5 w-5" />
                </a>
                <Menubar className="border-0 shadow-none">
                  <MenubarMenu>
                    <MenubarTrigger>
                      <Settings className="m-2" />
                    </MenubarTrigger>
                    <MenubarContent>
                      <MenubarItem onClick={() => logout()}>Sign Out</MenubarItem>
                    </MenubarContent>
                  </MenubarMenu>
                </Menubar>
              </div>
            </header>
            <div className="p-[20px]">{children}</div>
          </div>
      </SidebarProvider>
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
