"use client";

import { useCallback, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Bot, Loader2, Play, RefreshCw, RotateCcw, Send, Square, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { FormSkeleton } from "@/components/loading";
import type { TelegramNotifySettings } from "@openstrm/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SwitchRow } from "@/components/switch-row";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { SecretInput } from "@/components/ui/secret-input";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api, type TelegramBotStatus, type TelegramPermissions } from "@/lib/api";
import { apiErrorBody, apiErrorMessage } from "@/lib/axios";

const PERMISSIONS: Array<{ key: keyof TelegramPermissions; label: string; hint: string }> = [
  { key: "allowTaskStart", label: "允许从 Telegram 启动 / 取消任务", hint: "/tasks 里的「运行」按钮会真的跑同步任务。" },
  { key: "allowOfflineAdd", label: "允许添加云下载", hint: "发磁力 / ed2k / http 链接给机器人，交给 115 云下载；选任务目录的话下完自动生成 strm。" },
  { key: "allowShareReceive", label: "允许转存分享", hint: "发 115 / 夸克分享链接给机器人，整个分享转存到同类账号的某个任务目录并触发同步。" },
  {
    key: "allowOAuthApproval",
    label: "允许批准网页客户端的连接",
    hint: "claude.ai、ChatGPT 这类网页客户端来连接时，把授权页上的配对码发给机器人，就能在 Telegram 里批准（只读或日常）。白名单里的人都能批，批出去的档位比上面几个开关管的多，所以打开要输当前密码；换了机器人、chat id 或往白名单里加人会自动关掉。",
  },
];

const NOTIFY: Array<{ key: keyof TelegramNotifySettings; label: string; hint: string }> = [
  { key: "taskDone", label: "任务完成", hint: "同步跑完：文件数、用时。" },
  { key: "taskFailed", label: "任务失败", hint: "有文件失败、启动失败（定时触发的也算），带原因。" },
  { key: "accountAlert", label: "网盘账号异常", hint: "115 / 夸克 cookie 失效或被封控时提醒，同一原因一小时只发一次。" },
  { key: "offline", label: "云下载", hint: "从任务目录下载完成并生成 strm，或回执失败。" },
  { key: "follow", label: "分享追更", hint: "追更到新文件、分享失效、长期没更新时提醒。" },
  { key: "embyNew", label: "Emby 入库", hint: "Emby 把新条目收进媒体库时提醒（按剧聚合），需要配好 Emby 地址和 API Key。" },
  { key: "organize", label: "整理", hint: "整理执行完成、自动整理生成了待确认的清单时提醒。" },
  { key: "taskStart", label: "任务开始", hint: "每次同步开始都发一条，比较吵，默认关。" },
  { key: "update", label: "新版本", hint: "检查更新发现有新版本时提醒一次（同一个版本只发一次），要先在「设置」里开自动检查。默认关。" },
];

/** 连接那一段的字段。chat id 可以留空（只用命令、不要通知），填了就得是一串数字，群是负号开头 */
const connectSchema = z.object({
  botToken: z.string().trim().min(1, "请填 bot token"),
  chatId: z
    .string()
    .trim()
    .refine((v) => v === "" || /^-?\d+$/.test(v), "chat id 是一串数字，给机器人发 /id 就能看到"),
});

type ConnectValues = z.infer<typeof connectSchema>;

export default function TelegramPage() {
  const [status, setStatus] = useState<TelegramBotStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [newUserId, setNewUserId] = useState("");
  const [removeOpen, setRemoveOpen] = useState(false);
  // 打开「允许批准网页客户端的连接」要当前密码（和在设置页批准、建令牌一样）：先弹框问
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [approvalPassword, setApprovalPassword] = useState("");
  const [approvalError, setApprovalError] = useState<string | null>(null);

  const form = useForm<ConnectValues>({
    resolver: zodResolver(connectSchema),
    defaultValues: { botToken: "", chatId: "" },
  });
  const saving = form.formState.isSubmitting;

  const load = useCallback(async (silent = false) => {
    try {
      const s = await api.telegram.status();
      setStatus(s);
      // reset 而不是 setValue：这也是新的"未改动"基准，重新加载后表单不该还是脏的
      form.reset({ botToken: s.botToken, chatId: s.chatId });
    } catch (err) {
      if (!silent) toast.error(apiErrorMessage(err, "加载 Telegram 配置失败"));
    } finally {
      setLoaded(true);
    }
  }, [form]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (values: ConnectValues) => {
    try {
      const res = await api.telegram.configure({ botToken: values.botToken, chatId: values.chatId });
      toast.success("已保存");
      if (res.oauthApprovalOff) toast.warning(res.oauthApprovalOff);
      await load(true);
    } catch (err) {
      const body = apiErrorBody(err);
      toast.error(body.details ? `${body.message}：${body.details}` : apiErrorMessage(err, "保存失败"));
    }
  };

  const run = async (key: string, fn: () => Promise<unknown>, okText: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(okText);
      await load(true);
    } catch (err) {
      toast.error(apiErrorMessage(err, "操作失败"));
    } finally {
      setBusy(null);
    }
  };

  /** 权限和通知开关：勾选即保存。PUT 是按组替换，patchGroup 会先把组里其它字段带上 */
  const patch = async (partial: Record<string, unknown>, okText: string) => {
    try {
      const res = await api.settings.patchGroup("telegram", partial);
      toast.success(okText);
      if (res.telegramOAuthApprovalOff) toast.warning(res.telegramOAuthApprovalOff);
      await load(true);
    } catch (err) {
      toast.error(apiErrorMessage(err, "保存失败"));
      await load(true);
    }
  };

  const enableApproval = async () => {
    setBusy("approval");
    setApprovalError(null);
    try {
      await api.settings.patchGroup("telegram", { allowOAuthApproval: true }, { currentPassword: approvalPassword });
      toast.success("已开启：允许批准网页客户端的连接");
      setApprovalOpen(false);
      setApprovalPassword("");
      await load(true);
    } catch (err) {
      if (apiErrorBody(err).code === "WRONG_PASSWORD") setApprovalError("当前密码不正确");
      else toast.error(apiErrorMessage(err, "保存失败"));
    } finally {
      setBusy(null);
    }
  };

  const addUser = async () => {
    const id = newUserId.trim();
    if (!/^-?\d+$/.test(id)) {
      toast.error("用户 id 是一串数字，给机器人发 /start 就能看到");
      return;
    }
    await run(
      "add-user",
      async () => {
        const res = await api.telegram.users.add(id);
        if (res.oauthApprovalOff) toast.warning(res.oauthApprovalOff);
      },
      `已加入白名单：${id}`,
    );
    setNewUserId("");
  };

  const description = "出事第一时间收到通知；手机上把链接发给机器人就能云下载或转存。只回应白名单里的人。";

  if (!loaded) {
    return (
      <div className="space-y-6">
        <PageHeader icon={Bot} title="Telegram 机器人" description={description} />
        <div className="max-w-3xl">
          <FormSkeleton />
        </div>
      </div>
    );
  }
  const configured = Boolean(status?.configured);

  return (
    <div className="space-y-6">
      <PageHeader icon={Bot} title="Telegram 机器人" description={description} />
      <div className="max-w-3xl space-y-6">
        {/* ---------------- 连接 ---------------- */}
        <section className="space-y-4 rounded-xl border bg-card p-6">
          <h2 className="text-base font-medium">连接</h2>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(save)} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="botToken"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Bot token</FormLabel>
                      <FormControl>
                        <SecretInput
                          placeholder="123456789:ABC…（找 @BotFather 创建机器人获得）"
                          value={field.value}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          name={field.name}
                          masked={status?.botToken}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="chatId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Chat id（通知发到这里）</FormLabel>
                      <FormControl>
                        <Input placeholder="例如 123456789 或群的 -100…" {...field} />
                      </FormControl>
                      <FormDescription className="text-xs">
                        给机器人发 <code>/id</code> 就能看到。填群 id 的话机器人只在这个群里响应命令。
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <Button type="submit" disabled={saving}>
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  保存
                </Button>
                {configured && (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => run("test", () => api.telegram.test(), "测试消息已发出，看看 Telegram")}
                      disabled={busy === "test"}
                    >
                      {busy === "test" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                      发测试消息
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setRemoveOpen(true)}
                    >
                      <Trash2 className="h-4 w-4" />
                      清除配置
                    </Button>
                  </>
                )}
              </div>
            </form>
          </Form>

          {configured && (
            <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
              <div className="flex items-center gap-2 flex-wrap">
                {status?.bot ? (
                  <StatusBadge tone="success">@{status.bot.username ?? status.bot.first_name}</StatusBadge>
                ) : (
                  <StatusBadge tone="danger">连不上 Telegram{status?.botError ? `：${status.botError}` : ""}</StatusBadge>
                )}
                {status?.polling ? (
                  <StatusBadge tone="info" pulse>
                    轮询运行中
                  </StatusBadge>
                ) : (
                  <StatusBadge tone="neutral">轮询未运行</StatusBadge>
                )}
                <div className="ml-auto flex items-center gap-2">
                  {status?.polling ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => run("restart", () => api.telegram.polling.restart(), "轮询已重启")}
                        disabled={busy === "restart"}
                      >
                        {busy === "restart" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                        重启
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => run("stop", () => api.telegram.polling.stop(), "轮询已停止")}
                        disabled={busy === "stop"}
                      >
                        {busy === "stop" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
                        停止
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" onClick={() => run("start", () => api.telegram.polling.start(), "轮询已启动")} disabled={busy === "start"}>
                      {busy === "start" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                      启动轮询
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" className="size-8" onClick={() => load()} title="刷新">
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                轮询是机器人收消息的方式（不需要公网地址）。不开轮询也能收到通知，只是命令和链接没人处理。开着的话重启服务后会自动恢复。
              </p>
            </div>
          )}
        </section>

        {/* ---------------- 白名单 ---------------- */}
        <section className="space-y-4 rounded-xl border bg-card p-6">
          <div className="space-y-1">
            <h2 className="text-base font-medium">白名单</h2>
            <p className="text-sm text-muted-foreground">
              只有这些用户 id 能使用机器人。陌生人私聊机器人会收到自己的 id，把它加进来即可；群里的陌生人一律不理。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(status?.allowedUsers ?? []).length === 0 && <span className="text-sm text-muted-foreground">还没有人</span>}
            {(status?.allowedUsers ?? []).map((id) => (
              <Badge key={id} variant="outline" className="gap-1 pr-1 font-mono">
                {id}
                <button
                  type="button"
                  className="rounded p-0.5 hover:bg-destructive/10 hover:text-destructive"
                  title="移出白名单"
                  onClick={() => run(`rm-${id}`, () => api.telegram.users.remove(id), `已移除 ${id}`)}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
          <InputGroup className="max-w-sm">
            <InputGroupInput
              value={newUserId}
              onChange={(e) => setNewUserId(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && addUser()}
              placeholder="用户 id"
            />
            <InputGroupButton onClick={addUser} disabled={busy === "add-user"}>
              <UserPlus />
              添加
            </InputGroupButton>
          </InputGroup>
        </section>

        {/* ---------------- 权限 ---------------- */}
        <section className="space-y-4 rounded-xl border bg-card p-6">
          <div className="space-y-1">
            <h2 className="text-base font-medium">权限</h2>
            <p className="text-sm text-muted-foreground">这些动作会真的改动网盘或跑任务，默认全关，需要的再打开。</p>
          </div>
          <div className="space-y-2">
            {PERMISSIONS.map((p) => (
              <SwitchRow
                key={p.key}
                label={p.label}
                description={p.hint}
                checked={status?.permissions[p.key] === true}
                onCheckedChange={(v) => {
                  if (p.key === "allowOAuthApproval" && v) {
                    setApprovalError(null);
                    setApprovalOpen(true);
                    return;
                  }
                  void patch({ [p.key]: v }, v ? `已开启：${p.label}` : `已关闭：${p.label}`);
                }}
              />
            ))}
          </div>
        </section>

        {/* ---------------- 通知 ---------------- */}
        <section className="space-y-4 rounded-xl border bg-card p-6">
          <div className="space-y-1">
            <h2 className="text-base font-medium">通知</h2>
            <p className="text-sm text-muted-foreground">发到上面填的 chat id。</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {NOTIFY.map((n) => (
              <SwitchRow
                key={n.key}
                label={n.label}
                description={n.hint}
                checked={status?.notify[n.key] === true}
                onCheckedChange={(v) =>
                  patch({ notify: { ...(status?.notify ?? {}), [n.key]: v } }, v ? `已开启：${n.label}` : `已关闭：${n.label}`)
                }
              />
            ))}
          </div>
        </section>

        {/* ---------------- 用法 ---------------- */}
        <section className="space-y-4 rounded-xl border bg-card p-6">
          <h2 className="text-base font-medium">怎么用</h2>
          <div className="space-y-3 text-sm">
            <div>
              <div className="font-medium">直接发链接</div>
              <ul className="mt-1 space-y-1 text-muted-foreground">
                <li>• 磁力 / ed2k / http(s) / ftp 链接（可多行）→ 选下到哪个任务目录，或 115 默认目录</li>
                <li>• 115 / 夸克分享链接 → 看一眼内容，选转存到哪个任务目录</li>
              </ul>
            </div>
            <div>
              <div className="font-medium">命令</div>
              <ul className="mt-1 space-y-1 text-muted-foreground">
                {(status?.commands ?? []).map((c) => (
                  <li key={c.command}>
                    <code className="text-foreground">/{c.command}</code> {c.description}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <AlertDialog
          open={approvalOpen}
          onOpenChange={(o) => {
            if (busy === "approval") return;
            setApprovalOpen(o);
            if (!o) setApprovalPassword("");
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>允许在 Telegram 里批准网页客户端</AlertDialogTitle>
              <AlertDialogDescription>
                批准等于发一把能一直续期的钥匙，和在设置页批准一样要再输一次密码。之后换了机器人、chat id 或往白名单里加人，这个开关会自动关掉，要用再打开。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-2">
              <Input
                type="password"
                autoComplete="current-password"
                placeholder="管理界面的登录密码"
                value={approvalPassword}
                onChange={(e) => setApprovalPassword(e.target.value)}
                aria-label="当前密码"
                aria-invalid={approvalError ? true : undefined}
              />
              {approvalError && <p className="text-xs text-destructive">{approvalError}</p>}
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy === "approval"}>取消</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  void enableApproval();
                }}
                disabled={busy === "approval" || !approvalPassword}
              >
                {busy === "approval" ? <Loader2 className="size-4 animate-spin" /> : "开启"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>清除 Telegram 配置</AlertDialogTitle>
              <AlertDialogDescription>会停掉轮询并删除 token、chat id、白名单和所有开关，无法恢复。</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  setRemoveOpen(false);
                  void run("remove", () => api.telegram.remove(), "已清除");
                }}
              >
                清除
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
