"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Github } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { NAV_GROUPS, isNavActive } from "@/lib/nav";

// 构建时由 next.config.ts 注入（APP_VERSION 或 package.json 的版本）
const appVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "";
const REPO_URL = "https://github.com/indown/OpenStrm";

export function AppSidebar() {
  const pathname = usePathname();
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            {/* size=lg 在图标模式下自动缩成 32px 方块，文字随 overflow 隐藏，不用再手写折叠态 */}
            <SidebarMenuButton size="lg" asChild tooltip="OpenStrm">
              <Link href="/home">
                <Image src="/logo-128.png" alt="OpenStrm" width={32} height={32} className="size-8 shrink-0" />
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate text-sm font-semibold">OpenStrm</span>
                  <span className="truncate text-xs text-muted-foreground">Strm 管理平台</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.url}>
                    <SidebarMenuButton
                      asChild
                      tooltip={item.title}
                      isActive={isNavActive(item, pathname)}
                      className="data-[active=true]:bg-brand/10 data-[active=true]:text-brand data-[active=true]:hover:bg-brand/15 data-[active=true]:hover:text-brand"
                    >
                      <Link href={item.url}>
                        <item.icon />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <div className="flex items-center justify-between gap-2 px-2 py-1 text-xs text-muted-foreground group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 hover:text-foreground"
            title="GitHub"
          >
            <Github className="size-4" />
            <span className="group-data-[collapsible=icon]:hidden">GitHub</span>
          </a>
          {appVersion && (
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs tabular-nums group-data-[collapsible=icon]:hidden">
              v{appVersion}
            </span>
          )}
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
