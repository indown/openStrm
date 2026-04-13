"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { Settings, Github, Share2 } from "lucide-react";
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
import { toast } from "sonner";

export default function LayoutWrapper({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [shareLink, setShareLink] = useState("");
  const [shareDetailOpen, setShareDetailOpen] = useState(false);
  const [shareInfo, setShareInfo] = useState<Record<string, unknown> | null>(null);
  const [shareFileList, setShareFileList] = useState<ShareFileItem[]>([]);
  const [shareLoading, setShareLoading] = useState(false);

  if (pathname === "/login") {
    return <>{children}</>; // 登录页不显示导航等
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

  const fetchShareDetail = async () => {
    const url = shareLink.trim();
    if (!url) {
      toast.error("请输入 115 分享链接");
      return;
    }
    setShareLoading(true);
    try {
      const [infoRes, listRes] = await Promise.all([
        axiosInstance.post<{ code: number; data?: Record<string, unknown> }>("/api/115/share", {
          action: "info",
          url,
        }),
        axiosInstance.post<{ code: number; data?: ShareFileItem[] }>("/api/115/share", {
          action: "list",
          url,
          cid: 0,
        }),
      ]);
      if (infoRes.data.code !== 200 || listRes.data.code !== 200) {
        toast.error(infoRes.data.code !== 200 ? "获取分享信息失败" : "获取文件列表失败");
        return;
      }
      setShareInfo(infoRes.data.data ?? null);
      setShareFileList(listRes.data.data ?? []);
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
                <Button size="sm" onClick={fetchShareDetail} disabled={shareLoading}>
                  {shareLoading ? "加载中..." : "查看"}
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
        shareLink={shareLink}
        loading={shareLoading}
      />
    </>
  );
}
