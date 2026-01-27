"use client"
import { Home, Inbox, Settings, Github, Bot, Users, History } from "lucide-react";
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
import frontendPkg from "../../package.json" assert { type: "json" };
type PackageJson = { version?: string } & Record<string, unknown>;
const appVersion = (frontendPkg as PackageJson).version ?? "";

// Menu items.
const items = [
  {
    title: "Home",
    url: "/home",
    icon: Home,
  },
  {
    title: "Account",
    url: "/account",
    icon: Inbox,
  },
  {
    title: "Settings",
    url: "/settings",
    icon: Settings,
  },
  {
    title: "History",
    url: "/history",
    icon: History,
  },
];

// Telegram menu items.
const telegramItems = [
  {
    title: "Bot Config",
    url: "/telegram",
    icon: Bot,
  },
  {
    title: "Users",
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
              src="/logo.svg"
              alt="OpenStrm Logo"
              width={36}
              height={36}
              className="flex-shrink-0"
            />
            <div className="flex flex-col">
              <span className="text-xl font-bold text-foreground">Open Strm</span>
              <span className="text-xs text-muted-foreground">Strm Management</span>
            </div>
          </div>
        </div>
        <SidebarGroup>
          <SidebarGroupLabel>Main</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => {
                const isActive = pathname === item.url;
                console.log("Current pathname:", isActive, pathname);
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
        
        {/* <SidebarGroup>
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
        </SidebarGroup> */}
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
