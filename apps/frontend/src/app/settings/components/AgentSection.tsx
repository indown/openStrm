"use client";

import { useCallback, useEffect, useState } from "react";
import { Bot, KeyRound, Loader2, MoreHorizontal, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { AgentCall, AgentInfo, AgentToken, AgentToolset } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { StatusBadge, TONE_CLASS, type StatusTone } from "@/components/status-badge";
import { FieldHint } from "@/components/field-hint";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { fmtWhen } from "@/lib/format";
import { AgentWebClients } from "./AgentWebClients";
import { CUSTOM, CopyButton, PRESETS, SCOPE_LABEL, TOOLSETS, hasAllToolsets, presetIdOf, presetLabel, toolsetText } from "./agent-common";

const EXPIRY: Array<{ value: string; label: string; days: number | null }> = [
  { value: "never", label: "永不过期", days: null },
  { value: "30", label: "30 天", days: 30 },
  { value: "90", label: "90 天", days: 90 },
  { value: "365", label: "一年", days: 365 },
];

/** 各家客户端的配置片段；令牌只在新建后这一次拿得到明文 */
function snippets(mcpUrl: string, token: string) {
  return [
    {
      title: "Claude Code",
      code: `claude mcp add --transport http openstrm ${mcpUrl} --header "Authorization: Bearer ${token}"`,
    },
    {
      title: "Codex（命令行 / IDE / 桌面端）",
      code: `export OPENSTRM_TOKEN=${token}\ncodex mcp add openstrm --url ${mcpUrl} --bearer-token-env-var OPENSTRM_TOKEN`,
    },
    {
      title: "Open WebUI",
      code: `管理员设置 → Integrations → External Tool Servers → Add Connection\nType：MCP Streamable HTTP\nID：openstrm\nURL：${mcpUrl}\nAuth：Bearer，填上面的令牌`,
      note: "连接是从 Open WebUI 的容器里发起的：和 OpenStrm 在同一个 compose 网络里就写 http://openstrm:3000/mcp。Open WebUI 调用前不会问人，令牌只给「只读」或「日常」。",
    },
    {
      title: "通用 JSON（Cherry Studio、Cursor 等）",
      code: JSON.stringify({ mcpServers: { openstrm: { url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
      note: "有的客户端还要写传输类型：选 Streamable HTTP（配置里常写作 http 或 streamableHttp），不要选 SSE。",
    },
  ];
}

/** MCP 地址：接口在哪儿它就在哪儿（前后端分开部署时是 NEXT_PUBLIC_API_URL 那边，不是页面自己的地址） */
/**
 * 一次调用的结果怎么显示：弹了确认框在等人点（CONFIRM_REQUESTED）、人在确认框里拒绝了（DECLINED）都不算失败——
 * 前一种客户端会带着结果再调一次，那一次另记一笔
 */
function callOutcome(c: AgentCall): { tone: StatusTone; label: string } {
  if (c.ok) return { tone: "success", label: "成功" };
  if (c.error.startsWith("CONFIRM_REQUESTED")) return { tone: "neutral", label: "等确认" };
  if (c.error.startsWith("DECLINED")) return { tone: "neutral", label: "已拒绝" };
  return { tone: "danger", label: "失败" };
}

function mcpUrlOf(mcpPath: string): string {
  const base = (process.env.NEXT_PUBLIC_API_URL || window.location.origin).replace(/\/+$/, "");
  return `${base}${mcpPath}`;
}

type Editing = { mode: "create" } | { mode: "edit"; token: AgentToken };

/** 新建 / 修改令牌的弹框。修改不动明文，只改名字、档位、工具集 */
function TokenDialog({
  editing,
  onClose,
  onSaved,
}: {
  editing: Editing | null;
  onClose: () => void;
  onSaved: (result: { token?: string; info: AgentToken }) => void;
}) {
  const [name, setName] = useState("");
  const [preset, setPreset] = useState("daily");
  const [allToolsets, setAllToolsets] = useState(true);
  const [toolsets, setToolsets] = useState<AgentToolset[]>(TOOLSETS.map((t) => t.id));
  const [expiry, setExpiry] = useState("never");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) return;
    setPassword("");
    if (editing.mode === "edit") {
      const t = editing.token;
      setName(t.name);
      setPreset(presetIdOf(t.scopes));
      setAllToolsets(hasAllToolsets(t.toolsets));
      setToolsets(t.toolsets);
    } else {
      setName("");
      setPreset("daily");
      setAllToolsets(true);
      setToolsets(TOOLSETS.map((t) => t.id));
      setExpiry("never");
    }
  }, [editing]);

  const custom = editing?.mode === "edit" && preset === CUSTOM ? editing.token.scopes : null;
  const chosenPreset = PRESETS.find((p) => p.id === preset);
  // 「全部」交给后端展开成眼下的全部组
  const chosenToolsets = allToolsets ? null : toolsets;
  const invalid =
    !name.trim() || (chosenToolsets !== null && chosenToolsets.length === 0) || (editing?.mode === "create" && !password);

  const submit = async () => {
    if (!editing || invalid) return;
    setSaving(true);
    try {
      if (editing.mode === "create") {
        const created = await api.agent.createToken({
          name: name.trim(),
          scopes: chosenPreset!.scopes,
          toolsets: chosenToolsets,
          expiresInDays: EXPIRY.find((e) => e.value === expiry)?.days ?? null,
          currentPassword: password,
        });
        onSaved({ token: created.token, info: created.info });
      } else {
        // 自定义档位没动就不发 scopes：原样保留，不会被改成哪个预设
        const info = await api.agent.updateToken(editing.token.id, {
          name: name.trim(),
          ...(chosenPreset ? { scopes: chosenPreset.scopes } : {}),
          toolsets: chosenToolsets,
        });
        onSaved({ info });
      }
    } catch (err) {
      toast.error(apiErrorMessage(err, "保存令牌失败"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={editing != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing?.mode === "edit" ? "修改令牌" : "新建令牌"}</DialogTitle>
          <DialogDescription>每个客户端单独建一个，用不到了就撤销。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="agent-token-name">名称</Label>
            <Input id="agent-token-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="比如：Claude Code、家里的 Open WebUI" maxLength={60} />
          </div>
          <div className="space-y-2">
            <Label>权限</Label>
            <Select value={preset} onValueChange={setPreset}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRESETS.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
                {editing?.mode === "edit" && presetIdOf(editing.token.scopes) === CUSTOM && (
                  <SelectItem value={CUSTOM}>自定义（保持不变）</SelectItem>
                )}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {custom ? `现在的档位：${custom.map((s) => SCOPE_LABEL[s]).join("、")}` : chosenPreset?.hint}
            </p>
          </div>
          <div className="space-y-2">
            <Label className="flex items-center gap-1">
              工具
              <FieldHint label="工具集说明">
                只开需要的几组，工具少了，本地小模型选得更准，也省上下文。总览、任务列表、后台作业进度这几个基础工具总在。选「全部」记下的是现在的这几组：以后的版本加了新的一组，要回来勾上才能用。
              </FieldHint>
            </Label>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
              <label className="flex items-center gap-2">
                <Checkbox checked={allToolsets} onCheckedChange={(v) => setAllToolsets(v === true)} />
                全部
              </label>
              {TOOLSETS.map((t) => (
                <label key={t.id} className="flex items-center gap-2">
                  <Checkbox
                    disabled={allToolsets}
                    checked={allToolsets || toolsets.includes(t.id)}
                    onCheckedChange={(v) => setToolsets((cur) => (v === true ? [...new Set([...cur, t.id])] : cur.filter((x) => x !== t.id)))}
                  />
                  {t.label}
                </label>
              ))}
            </div>
          </div>
          {editing?.mode === "create" && (
            <>
              <div className="space-y-2">
                <Label>有效期</Label>
                <Select value={expiry} onValueChange={setExpiry}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPIRY.map((e) => (
                      <SelectItem key={e.value} value={e.value}>
                        {e.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="agent-token-password" className="flex items-center gap-1">
                  当前密码
                  <FieldHint label="为什么要输密码">
                    令牌不会随改密码失效，所以签令牌要再确认一次是你本人：登录状态被人偷去了也签不出令牌。
                  </FieldHint>
                </Label>
                <Input
                  id="agent-token-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="管理界面的登录密码"
                />
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={saving || invalid}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {editing?.mode === "edit" ? "保存" : "新建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 新建成功后：明文只显示这一次，外加各家客户端的配置片段。
 * 点外面、按 Esc、右上角的叉都关不掉：一关令牌就没了，只能点底下的按钮
 */
function CreatedDialog({ created, mcpUrl, onClose }: { created: { token: string; name: string } | null; mcpUrl: string; onClose: () => void }) {
  return (
    <Dialog open={created != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        size="lg"
        className="max-h-[85vh] overflow-y-auto"
        showCloseButton={false}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>令牌「{created?.name}」已建好</DialogTitle>
          <DialogDescription>令牌只显示这一次，关掉就再也看不到了。先复制下来，或者直接复制下面对应客户端的配置。</DialogDescription>
        </DialogHeader>
        {created && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-2">
              <code className="min-w-0 flex-1 break-all font-mono text-xs select-all">{created.token}</code>
              <CopyButton text={created.token} label="复制令牌" />
            </div>
            {snippets(mcpUrl, created.token).map((s) => (
              <div key={s.title} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{s.title}</span>
                  <CopyButton text={s.code} />
                </div>
                <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap break-all">{s.code}</pre>
                {s.note && <p className="text-xs text-muted-foreground">{s.note}</p>}
              </div>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            我已经复制好了
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 设置页的「智能体接入」一节。
 * 开关和管理界面地址是设置项，由页面的表单管（fields 传进来，跟着底部保存条一起存；enabled 是保存过的值）；
 * 令牌的增删改立即生效，不走保存条。
 */
export function AgentSection({
  enabled,
  publicBaseUrl,
  sharedDomain,
  passwordApproval,
  fields,
}: {
  enabled: boolean;
  publicBaseUrl: string;
  /** 保存过的「这个域名也用来打开管理界面」：授权页的样子（密码在前还是配对码在前）跟着它 */
  sharedDomain: boolean;
  /** 保存过的「授权页上允许用管理员密码批准」：网页客户端那块的步骤按它写 */
  passwordApproval: boolean;
  fields: React.ReactNode;
}) {
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [tokens, setTokens] = useState<AgentToken[] | null>(null);
  const [tokensFailed, setTokensFailed] = useState(false);
  const [calls, setCalls] = useState<AgentCall[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null);
  const [revoking, setRevoking] = useState<AgentToken | "all" | null>(null);
  const [busy, setBusy] = useState(false);

  // 三样各取各的：一样没取到（容器正在重启之类）不能把另外两样也清掉，尤其不能让令牌列表看着像是空了
  const load = useCallback(async () => {
    const [i, t, c] = await Promise.allSettled([api.agent.info(), api.agent.tokens(), api.agent.calls(undefined, 20)]);
    if (i.status === "fulfilled") setInfo(i.value);
    if (t.status === "fulfilled") {
      setTokens(t.value);
      setTokensFailed(false);
    } else {
      setTokensFailed(true);
    }
    if (c.status === "fulfilled") setCalls(c.value.calls);
    const failed = [i, t, c].find((r) => r.status === "rejected");
    if (failed) toast.error(apiErrorMessage(failed.reason, "读取智能体令牌失败"));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mcpUrl = info ? mcpUrlOf(info.mcpPath) : "";

  const confirmRevoke = async () => {
    if (!revoking) return;
    setBusy(true);
    try {
      if (revoking === "all") {
        const r = await api.agent.revokeAll();
        toast.success(`已撤销 ${r.deleted} 个令牌`);
      } else {
        await api.agent.revokeToken(revoking.id);
        toast.success(`已撤销「${revoking.name}」`);
      }
      setRevoking(null);
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, "撤销失败"));
    } finally {
      setBusy(false);
    }
  };

  const now = Math.floor(Date.now() / 1000);
  return (
    <section id="agent" className="scroll-mt-20 space-y-4 rounded-xl border bg-card p-6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-medium">智能体接入</h2>
        <StatusBadge tone={enabled ? "success" : "neutral"}>{enabled ? "已开启" : "未开启"}</StatusBadge>
      </div>
      <p className="text-sm text-muted-foreground">
        让 Claude Code、Codex、Open WebUI 这类 AI 客户端通过 MCP 调用 OpenStrm：看任务和同步进度、开始同步、看分享、转存、添加云下载。
        <FieldHint label="智能体接入说明">
          客户端用令牌连 MCP 地址。每个令牌有自己的权限档：只读令牌看不到会改网盘的工具。账号 cookie、设置、备份这些永远不对令牌开放。每次调用都记在下面的「最近调用」里。
        </FieldHint>
      </p>

      {fields}

      <div className="space-y-1.5">
        <Label>MCP 地址</Label>
        <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-2 py-1">
          <code className="min-w-0 flex-1 truncate font-mono text-xs">{mcpUrl || "…"}</code>
          {mcpUrl && <CopyButton text={mcpUrl} label="复制地址" />}
        </div>
        <p className="text-xs text-muted-foreground">
          客户端要能访问到这个地址。在别的机器或容器里连，把主机名换成它能访问到的地址。
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">令牌</h3>
          <div className="ml-auto flex items-center gap-2">
            <Button type="button" size="sm" onClick={() => setEditing({ mode: "create" })}>
              <Plus className="size-4" />
              新建令牌
            </Button>
            {tokens && tokens.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="ghost" size="icon" className="size-8" aria-label="更多操作">
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem variant="destructive" onSelect={() => setTimeout(() => setRevoking("all"), 0)}>
                    全部撤销
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>

        {tokens === null ? (
          tokensFailed ? (
            <p className="text-sm text-muted-foreground">令牌列表没读到，点下面「最近调用」旁边的刷新再试。</p>
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              读取中
            </p>
          )
        ) : tokens.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            <KeyRound className="size-5" />
            还没有令牌。新建一个，按提示填进客户端就能用。
          </div>
        ) : (
          <ul className="divide-y rounded-lg border">
            {tokens.map((t) => {
              const expired = t.expiresAt !== null && t.expiresAt <= now;
              return (
                <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{t.name}</span>
                      <code className="font-mono text-xs text-muted-foreground">{t.prefix}…</code>
                      <StatusBadge tone={t.scopes.includes("write") ? "warning" : "info"}>{presetLabel(t.scopes)}</StatusBadge>
                      {expired && <StatusBadge tone="danger">已过期</StatusBadge>}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {toolsetText(t.toolsets)}
                      {" · "}
                      {t.lastUsedAt ? `最近使用 ${fmtWhen(t.lastUsedAt * 1000)}${t.lastUsedIp ? `（${t.lastUsedIp}）` : ""}` : "还没用过"}
                      {t.expiresAt && !expired ? ` · ${fmtWhen(t.expiresAt * 1000)} 过期` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button type="button" variant="ghost" size="sm" onClick={() => setEditing({ mode: "edit", token: t })}>
                      修改
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={`${t.name} 的更多操作`}>
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem variant="destructive" onSelect={() => setTimeout(() => setRevoking(t), 0)}>
                          撤销
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <AgentWebClients publicBaseUrl={publicBaseUrl} enabled={enabled} sharedDomain={sharedDomain} passwordApproval={passwordApproval} />

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">最近调用</h3>
          <Button type="button" variant="ghost" size="sm" className="ml-auto h-7" onClick={() => void load()}>
            <RefreshCw className="size-3.5" />
            刷新
          </Button>
        </div>
        {calls.length === 0 ? (
          <p className="text-xs text-muted-foreground">还没有调用记录。</p>
        ) : (
          <ul className="divide-y rounded-lg border text-xs">
            {calls.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <Bot className="size-3.5 text-muted-foreground" />
                <span className="font-mono">{c.tool}</span>
                <StatusBadge tone={callOutcome(c).tone}>{callOutcome(c).label}</StatusBadge>
                <span className="text-muted-foreground">
                  {c.tokenName}
                  {c.ip ? `（${c.ip}）` : ""}
                </span>
                {callOutcome(c).tone === "danger" && c.error && (
                  <span className={`min-w-0 flex-1 truncate ${TONE_CLASS.danger.text}`} title={c.error}>
                    {c.error}
                  </span>
                )}
                <span className="ml-auto tabular-nums text-muted-foreground" title={new Date(c.at * 1000).toLocaleString("zh-CN", { hour12: false })}>
                  {fmtWhen(c.at * 1000)} · {c.durationMs} ms
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {!enabled && (tokens?.length ?? 0) > 0 && (
        <p className="text-xs text-warning">智能体接入还没开启：打开上面的开关并保存后，令牌才能用。</p>
      )}

      <TokenDialog
        editing={editing}
        onClose={() => setEditing(null)}
        onSaved={({ token, info: saved }) => {
          setEditing(null);
          if (token) setCreated({ token, name: saved.name });
          else toast.success("已保存");
          void load();
        }}
      />
      <CreatedDialog created={created} mcpUrl={mcpUrl} onClose={() => setCreated(null)} />

      <AlertDialog open={revoking != null} onOpenChange={(o) => !o && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{revoking === "all" ? "撤销全部令牌" : `撤销「${revoking?.name ?? ""}」`}</AlertDialogTitle>
            <AlertDialogDescription>
              {revoking === "all"
                ? "所有客户端马上都连不上了，要重新建令牌再配一遍。怀疑令牌泄露时用。"
                : "用这个令牌的客户端马上就连不上了。调用记录会保留。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmRevoke();
              }}
              disabled={busy}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : "撤销"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
