import {
  Bot,
  CloudDownload,
  History,
  KeyRound,
  Library,
  ListChecks,
  Radar,
  Rss,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { FEATURES } from "@/lib/features";

export type NavItem = {
  title: string;
  url: string;
  icon: LucideIcon;
  /** 除了 url 本身，这些路径前缀也算"当前页"（比如任务的实时日志页仍高亮「任务」） */
  match?: string[];
};
export type NavGroup = { label: string; items: NavItem[] };

/** 侧栏导航；顶栏的当前页名也从这里取，两边不会对不上 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "运行",
    items: [
      { title: "任务", url: "/home", icon: ListChecks, match: ["/log"] },
      // 影库入口暂时隐藏（lib/features.ts）；直接访问 /library 仍可用
      ...(FEATURES.libraryEntry ? [{ title: "影库", url: "/library", icon: Library }] : []),
      { title: "追更", url: "/follow", icon: Rss },
      { title: "云下载", url: "/offline", icon: CloudDownload },
      { title: "网盘监控", url: "/life", icon: Radar },
      { title: "历史", url: "/history", icon: History },
    ],
  },
  {
    label: "配置",
    items: [
      { title: "账户", url: "/account", icon: KeyRound },
      { title: "Telegram", url: "/telegram", icon: Bot },
      { title: "设置", url: "/settings", icon: Settings },
    ],
  },
];

export function isNavActive(item: NavItem, pathname: string): boolean {
  return [item.url, ...(item.match ?? [])].some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export type PageCrumb = {
  title: string;
  /** 子页面才有：顶栏会常驻一个返回键和面包屑，手机上滚到哪都能回上一级 */
  parent?: { title: string; url: string };
};

/** 顶栏显示的当前页。search 可选：日志页带 executionId 是在看历史记录，上一级算「历史」 */
export function currentPage(pathname: string, search?: { get(name: string): string | null } | null): PageCrumb | null {
  if (pathname.startsWith("/log")) {
    const parent = search?.get("executionId") ? { title: "历史", url: "/history" } : { title: "任务", url: "/home" };
    return { title: "任务日志", parent };
  }
  if (pathname.startsWith("/library")) return { title: "影库" };
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (isNavActive(item, pathname)) return { title: item.title };
    }
  }
  return null;
}
