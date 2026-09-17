"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Download, KeyRound, LogOut, Monitor, Moon, Plus, RefreshCw, Share2, Sun } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { NAV_GROUPS } from "@/lib/nav";
import { downloadBackupWithToast } from "@/lib/backup";
import { checkForUpdate } from "@/lib/update";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 顶栏那个「粘贴分享链接」的入口，面板只负责把它叫出来 */
  onOpenShare: () => void;
  onLogout: () => void;
};

/**
 * ⌘K 命令面板：去哪儿、做什么，都在这一个输入框里。
 *
 * 这一版只有静态命令（导航 + 全局动作），一个请求都不发。
 * 实体（任务 / 账号 / 追更）和两段式动作在后面几步加，设计见 .claude/plans/command-palette.md。
 */
export function CommandPalette({ open, onOpenChange, onOpenShare, onLogout }: Props) {
  const router = useRouter();
  const { setTheme } = useTheme();
  const [query, setQuery] = useState("");

  // 每次打开都从空的开始：留着上次搜的词，第二次打开还得先删一遍
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  /** 选中即执行：先关面板再做事，免得导航完面板还浮在上面 */
  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="命令面板"
      description="搜索页面和操作，回车执行"
    >
      <CommandInput value={query} onValueChange={setQuery} placeholder="搜索页面、操作…" />
      <CommandList>
        <CommandEmpty>没有匹配的命令</CommandEmpty>

        {NAV_GROUPS.map((group) => (
          <CommandGroup key={group.label} heading={`前往 · ${group.label}`}>
            {group.items.map((item) => (
              <CommandItem
                key={item.url}
                // 中文标题之外把路径也算进匹配：打 "strm" 或 "/organize" 都要找得到
                value={`${item.title} ${item.url}`}
                onSelect={() => run(() => router.push(item.url))}
              >
                <item.icon />
                {item.title}
                <CommandShortcut className="font-mono tracking-normal">{item.url}</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}

        <CommandGroup heading="操作">
          <CommandItem value="新建任务 添加任务 new task" onSelect={() => run(() => router.push("/home?new=1"))}>
            <Plus />
            新建任务
          </CommandItem>
          <CommandItem value="粘贴分享链接 转存 115 夸克 share" onSelect={() => run(onOpenShare)}>
            <Share2 />
            粘贴分享链接
          </CommandItem>
          <CommandItem value="立即检查更新 update" onSelect={() => run(() => void checkForUpdate())}>
            <RefreshCw />
            立即检查更新
          </CommandItem>
          <CommandItem value="下载备份 backup 数据库" onSelect={() => run(() => void downloadBackupWithToast())}>
            <Download />
            下载备份
          </CommandItem>
        </CommandGroup>

        <CommandGroup heading="主题">
          <CommandItem value="浅色 亮色 light 主题" onSelect={() => run(() => setTheme("light"))}>
            <Sun />
            浅色
          </CommandItem>
          <CommandItem value="深色 暗色 dark 主题" onSelect={() => run(() => setTheme("dark"))}>
            <Moon />
            深色
          </CommandItem>
          <CommandItem value="跟随系统 system 主题" onSelect={() => run(() => setTheme("system"))}>
            <Monitor />
            跟随系统
          </CommandItem>
        </CommandGroup>

        <CommandGroup heading="账号">
          <CommandItem value="修改密码 password" onSelect={() => run(() => router.push("/change-password"))}>
            <KeyRound />
            修改密码
          </CommandItem>
          <CommandItem value="退出登录 logout" onSelect={() => run(onLogout)}>
            <LogOut />
            退出登录
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
