"use client"
import { Home, Inbox, Settings, Github, History, Library, Radar, Bot, Users, CloudDownload } from "lucide-react";
import Image from "next/image";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import Link from "next/link";
import { usePathname } from "next/navigation"; // 新增
// 构建时由 next.config.ts 注入（APP_VERSION 或 package.json 的版本）
const appVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "";

// Menu items.
const items = [
  {
    title: "首页",
    url: "/home",
    icon: Home,
  },
  {
    title: "影库",
    url: "/library",
    icon: Library,
  },
  {
    title: "账户",
    url: "/account",
    icon: Inbox,
  },
  {
    title: "网盘监控",
    url: "/life",
    icon: Radar,
  },
  {
    title: "云下载",
    url: "/offline",
    icon: CloudDownload,
  },
  {
    title: "设置",
    url: "/settings",
    icon: Settings,
  },
  {
    title: "历史",
    url: "/history",
    icon: History,
  },
];

const telegramItems = [
  {
    title: "Telegram",
    url: "/telegram",
    icon: Bot,
  },
  {
    title: "授权用户",
    url: "/telegram/users",
    icon: Users,
  },
];

export function AppSidebar() {
  const pathname = usePathname();
  return (
    <Sidebar collapsible="icon">
      <SidebarContent>
        <div className="p-4 border-b border-border/50">
          <div className="flex items-center gap-3">
            <Image
              src="/logo-128.png"
              alt="OpenStrm Logo"
              width={36}
              height={36}
              className="flex-shrink-0"
            />
            <div className="flex flex-col">
              <span className="text-xl font-bold text-foreground">Open Strm</span>
              <span className="text-xs text-muted-foreground">流媒体管理</span>
            </div>
          </div>
        </div>
        <SidebarGroup>
          <SidebarGroupLabel>主菜单</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => {
                const isActive = pathname === item.url;
                return (
                  <SidebarMenuItem key={item.title} className={isActive ? "bg-muted" : ""}>
                    <SidebarMenuButton asChild tooltip={item.title}>
                      <Link href={item.url}>
                        <item.icon />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        
        <SidebarGroup>
          <SidebarGroupLabel>Telegram</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {telegramItems.map((item) => {
                const isActive = pathname === item.url;
                return (
                  <SidebarMenuItem key={item.title} className={isActive ? "bg-muted" : ""}>
                    <SidebarMenuButton asChild tooltip={item.title}>
                      <Link href={item.url}>
                        <item.icon />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarSeparator className="ml-0 mr-2 w-auto group-data-[collapsible=icon]:mx-0" />
      <SidebarFooter>
        <div className="flex items-center justify-between mx-2 mb-1 rounded-md px-2 py-1 text-xs group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <a
            href="https://github.com/indown/OpenStrm"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground group-data-[collapsible=icon]:justify-center"
          >
            <Github className="h-4 w-4" />
            <span className="group-data-[collapsible=icon]:hidden">GitHub</span>
          </a>
          <span className="px-2 py-0.5 rounded bg-muted text-foreground/80 group-data-[collapsible=icon]:hidden">v{appVersion}</span>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
