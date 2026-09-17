"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  Download,
  Edit,
  FileText,
  Files,
  FolderTree,
  History,
  KeyRound,
  ListChecks,
  LogOut,
  Monitor,
  Moon,
  Play,
  Plus,
  RefreshCw,
  Rss,
  Search,
  Share2,
  Sun,
} from "lucide-react";
import type { TaskRow } from "@/lib/api";
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
import { startTaskWithToast } from "@/lib/task-start";
import { checkForUpdate } from "@/lib/update";
import { usePaletteData } from "@/hooks/use-palette-data";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 顶栏那个「粘贴分享链接」的入口，面板只负责把它叫出来 */
  onOpenShare: () => void;
  onLogout: () => void;
};

/**
 * 面板的第二段。现在只有任务有动作页，以后要加别的实体就在这里加一支。
 * rootQuery 是进来之前输入框里那个词，「在 strm 里搜」要用它。
 */
type Stage = { kind: "task"; task: TaskRow; rootQuery: string } | null;

/** 任务在面板里显示成什么样 */
const taskLabel = (t: TaskRow) => `${t.originPath} → ${t.targetPath}`;

/**
 * ⌘K 命令面板：去哪儿、做什么、找什么，都在这一个输入框里。
 *
 * 两段式：第一段搜页面 / 操作 / 实体，选中一个任务进第二段，列出对它能做什么。
 * 空输入框上按 Backspace 或 Esc 退回第一段。设计见 .claude/plans/command-palette.md。
 */
export function CommandPalette({ open, onOpenChange, onOpenShare, onLogout }: Props) {
  const router = useRouter();
  const { setTheme } = useTheme();
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState<Stage>(null);
  const { tasks, accounts, follows } = usePaletteData(open);

  // 每次打开都从头开始：留着上次的词和上次进的那一段，第二次打开还得先退出来
  useEffect(() => {
    if (open) {
      setQuery("");
      setStage(null);
    }
  }, [open]);

  /** 选中即执行：先关面板再做事，免得导航完面板还浮在上面 */
  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  /** 进第二段：面板不关，输入框清空重新用来筛动作，但把原来那个词记下来 */
  const enter = (task: TaskRow) => {
    setStage({ kind: "task", task, rootQuery: query.trim() });
    setQuery("");
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="命令面板"
      description="搜索页面、任务和操作，回车执行"
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={stage ? `对「${taskLabel(stage.task)}」做什么…` : "搜索页面、任务、操作…"}
        onKeyDown={(e) => {
          if (!stage) return;
          // 在第二段里，这两个键是"退回上一段"而不是"关掉面板"。
          // Esc 要 preventDefault：Radix 的关闭逻辑看的就是 defaultPrevented
          if (e.key === "Escape" || (e.key === "Backspace" && query === "")) {
            e.preventDefault();
            setStage(null);
          }
        }}
      />
      <CommandList>
        <CommandEmpty>{stage ? "没有匹配的操作" : "什么都没找到。要搜 strm 文件，先选中一个任务"}</CommandEmpty>

        {stage ? (
          <CommandGroup heading={taskLabel(stage.task)}>
            <CommandItem
              value="开始同步 运行 start"
              onSelect={() => run(() => void startTaskWithToast(stage.task.id))}
            >
              <Play />
              开始同步
            </CommandItem>
            <CommandItem
              value="实时日志 log"
              onSelect={() => run(() => router.push(`/log?taskId=${encodeURIComponent(stage.task.id)}`))}
            >
              <FileText />
              实时日志
            </CommandItem>
            <CommandItem
              value="执行历史 history"
              onSelect={() => run(() => router.push(`/history?taskId=${encodeURIComponent(stage.task.id)}`))}
            >
              <History />
              执行历史
            </CommandItem>
            <CommandItem
              value="strm 目录 文件"
              onSelect={() => run(() => router.push(`/strm?taskId=${encodeURIComponent(stage.task.id)}`))}
            >
              <Files />
              strm 目录
            </CommandItem>
            <CommandItem
              value="整理 organize 规范化命名"
              onSelect={() => run(() => router.push(`/organize?task=${encodeURIComponent(stage.task.id)}`))}
            >
              <FolderTree />
              整理这个任务
            </CommandItem>
            {stage.rootQuery && (
              <CommandItem
                value={`在 strm 里搜 ${stage.rootQuery}`}
                onSelect={() =>
                  run(() =>
                    router.push(
                      `/strm?taskId=${encodeURIComponent(stage.task.id)}&q=${encodeURIComponent(stage.rootQuery)}`,
                    ),
                  )
                }
              >
                <Search />
                在 strm 里搜「{stage.rootQuery}」
              </CommandItem>
            )}
            <CommandItem
              value="编辑 修改 edit"
              onSelect={() => run(() => router.push(`/home?edit=${encodeURIComponent(stage.task.id)}`))}
            >
              <Edit />
              编辑任务
            </CommandItem>
          </CommandGroup>
        ) : (
          <>
            {tasks.length > 0 && (
              <CommandGroup heading="任务">
                {tasks.map((task) => (
                  <CommandItem
                    key={task.id}
                    value={`${task.originPath} ${task.targetPath} ${task.account}`}
                    onSelect={() => enter(task)}
                  >
                    <ListChecks />
                    <span className="truncate">{taskLabel(task)}</span>
                    <CommandShortcut className="tracking-normal">{task.account}</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {accounts.length > 0 && (
              <CommandGroup heading="账户">
                {accounts.map((acc) => (
                  <CommandItem
                    key={acc.name}
                    value={`${acc.name} ${acc.accountType}`}
                    onSelect={() => run(() => router.push("/account"))}
                  >
                    <KeyRound />
                    {acc.name}
                    <CommandShortcut className="tracking-normal">{acc.accountType}</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {follows.length > 0 && (
              <CommandGroup heading="追更">
                {follows.map((f) => (
                  <CommandItem
                    key={f.id}
                    value={`${f.name} ${f.watchPath}`}
                    onSelect={() => run(() => router.push("/follow"))}
                  >
                    <Rss />
                    <span className="truncate">{f.name || f.watchPath || f.shareCode}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

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
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
