"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { Settings, Github, Share2, Search } from "lucide-react";
import axiosInstance, { clearToken } from "@/lib/axios";
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
import { ShareDetailDialog, type ShareFileItem } from "@/components/ShareDetailDialog";
import {
  HdhiveSearchDialog,
  type HdhiveTmdbItem,
  type HdhiveResourceItem,
} from "@/components/HdhiveSearchDialog";
import { toast } from "sonner";

export default function LayoutWrapper({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [shareLink, setShareLink] = useState("");
  const [shareDetailOpen, setShareDetailOpen] = useState(false);
  const [shareInfo, setShareInfo] = useState<Record<string, unknown> | null>(null);
  const [shareFileList, setShareFileList] = useState<ShareFileItem[]>([]);
  const [shareFileCount, setShareFileCount] = useState(0);
  const [shareLoading, setShareLoading] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [hdhiveOpen, setHdhiveOpen] = useState(false);
  const [hdhiveLoading, setHdhiveLoading] = useState(false);
  const [hdhiveTmdb, setHdhiveTmdb] = useState<HdhiveTmdbItem | null>(null);
  const [hdhiveAlternatives, setHdhiveAlternatives] = useState<HdhiveTmdbItem[]>([]);
  const [hdhiveResources, setHdhiveResources] = useState<HdhiveResourceItem[]>([]);
  const [hdhiveTotal, setHdhiveTotal] = useState(0);
  const [hdhiveError, setHdhiveError] = useState<string | null>(null);

  // 登录页和强制改密码页都不显示导航等
  if (pathname === "/login" || pathname === "/change-password") {
    return <>{children}</>;
  }

  const logout = async () => {
    try {
      await axiosInstance.post("/api/auth/logout");
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

    setHdhiveOpen(true);
    setHdhiveLoading(true);
    setHdhiveError(null);
    setHdhiveTmdb(null);
    setHdhiveAlternatives([]);
    setHdhiveResources([]);
    setHdhiveTotal(0);

    try {
      const body: Record<string, unknown> = {};
      if (hasExplicit) {
        body.tmdbId = options.tmdbId;
        body.mediaType = options.mediaType;
      } else {
        body.query = queryToUse;
      }
      const res = await axiosInstance.post<{
        tmdb: HdhiveTmdbItem | null;
        alternatives: HdhiveTmdbItem[];
        resources: HdhiveResourceItem[];
        total: number;
      }>("/api/library/hdhive/search", body);
      const data = res.data;
      setHdhiveTmdb(data?.tmdb ?? null);
      setHdhiveAlternatives(data?.alternatives ?? []);
      setHdhiveResources(data?.resources ?? []);
      setHdhiveTotal(data?.total ?? 0);
    } catch (err) {
      const apiErr = err as {
        response?: { data?: { message?: string; data?: unknown } };
        message?: string;
      };
      const message = apiErr.response?.data?.message || apiErr.message || "搜索失败";
      setHdhiveError(message);
      const fallback = apiErr.response?.data?.data as
        | {
            tmdb: HdhiveTmdbItem | null;
            alternatives: HdhiveTmdbItem[];
          }
        | undefined;
      if (fallback) {
        setHdhiveTmdb(fallback.tmdb ?? null);
        setHdhiveAlternatives(fallback.alternatives ?? []);
      }
    } finally {
      setHdhiveLoading(false);
    }
  };

  const fetchShareDetail = async (overrideUrl?: string) => {
    const url = (overrideUrl ?? shareLink).trim();
    if (!url) {
      toast.error("请输入 115 分享链接");
      return;
    }
    setShareLoading(true);
    try {
      const [infoRes, listRes] = await Promise.all([
        axiosInstance.post<Record<string, unknown>>("/api/115/share", {
          action: "info",
          url,
        }),
        axiosInstance.post<{ list: ShareFileItem[]; count: number }>("/api/115/share", {
          action: "list",
          url,
          cid: 0,
        }),
      ]);
      setShareInfo(infoRes.data ?? null);
      setShareFileList(listRes.data.list ?? []);
      setShareFileCount(listRes.data.count ?? 0);
      setShareDetailOpen(true);
    } catch (err: unknown) {
      const msg =
        err && typeof err === "object" && "response" in err && err.response && typeof err.response === "object" && "data" in err.response && err.response.data && typeof err.response.data === "object" && "message" in err.response.data
          ? String((err.response.data as { message?: string }).message)
          : "获取分享详情失败";
      toast.error(msg);
    } finally {
      setShareLoading(false);
    }
  };

  const handle115UnlockedFromHdhive = (fullUrl: string) => {
    const url = (fullUrl || "").trim();
    if (!url) return;
    setShareLink(url);
    setHdhiveOpen(false);
    void fetchShareDetail(url);
  };

  return (
    <>
      <SidebarProvider>
          <AppSidebar />
          <SidebarTrigger />
          <div className="flex flex-col w-full min-h-screen pl-0">
            <header className="w-full border-b flex items-center gap-3 p-2 flex-wrap">
              <div className="flex items-center gap-2 flex-1 min-w-[200px] max-w-md">
                <Share2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                <Input
                  placeholder="粘贴 115 分享链接"
                  value={shareLink}
                  onChange={(e) => setShareLink(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && fetchShareDetail()}
                  className="h-8 text-sm"
                />
                <Button size="sm" onClick={() => fetchShareDetail()} disabled={shareLoading}>
                  {shareLoading ? "加载中..." : "查看"}
                </Button>
              </div>
              <div className="flex items-center gap-2 flex-1 min-w-[200px] max-w-md">
                <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                <Input
                  placeholder="搜索影视资源（TMDB → HDHive）"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && runHdhiveSearch()}
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
      <ShareDetailDialog
        open={shareDetailOpen}
        onOpenChange={setShareDetailOpen}
        shareInfo={shareInfo}
        fileList={shareFileList}
        fileCount={shareFileCount}
        shareLink={shareLink}
        loading={shareLoading}
      />
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
    </>
  );
}
