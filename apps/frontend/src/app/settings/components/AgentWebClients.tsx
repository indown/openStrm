"use client";

/**
 * 智能体接入里的「网页客户端」：claude.ai、ChatGPT 这类从公网走 OAuth 连进来的。
 *   - 公网 MCP 地址和两家的接入步骤（填了公网地址才有）；
 *   - 待批准：开着页面时每 3 秒刷一次（先来的在前，新来的不会把正要点的那行挤走）。批准要输入授权页上的配对码和当前密码：
 *     配对码证明批的是自己眼前授权页上的那一条（列表里故意不给配对码），密码和建令牌一样——批准等于发一把长期有效的钥匙；
 *   - 已连接的客户端（断开、全部断开；公网地址改过的标失效）、预注册客户端（新建时 secret 只显示一次）、连接自检。
 * 列表总是显示（公网地址清掉了，已连接的和预注册的也还在库里，得能看到、能断开）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Globe, Loader2, MoreHorizontal, Plus, ShieldCheck, XCircle } from "lucide-react";
import { toast } from "sonner";
import type { AgentOAuthState, AgentScope, AgentSelfCheckItem, OAuthClientCreated, OAuthClientInfo, OAuthGrantInfo, OAuthPendingRequest } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { StatusBadge, TONE_CLASS } from "@/components/status-badge";
import { FieldHint } from "@/components/field-hint";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { fmtWhen } from "@/lib/format";
import { CopyButton, PRESETS, SCOPE_LABEL, grantedPreview, presetLabel, toolsetText } from "./agent-common";

const POLL_MS = 3000;

/** 客户端只要了查看，默认就批只读；别的默认日常（完全得自己选） */
function defaultPreset(requested: AgentScope[]): string {
  return requested.length > 0 && requested.every((s) => s === "read") ? "read" : "daily";
}

const KIND_LABEL: Record<OAuthPendingRequest["clientKind"], string> = { dcr: "动态注册", cimd: "CIMD", manual: "预注册" };
const VIA_LABEL: Record<string, string> = { ui: "在管理界面批准", telegram: "在 Telegram 里批准", password: "在授权页上用密码批准" };

/** 配对码输入：只留字母表里的字符，大写，四位后自动补横线 */
function formatPairing(input: string): string {
  const s = input.toUpperCase().replace(/[^23456789ABCDEFGHJKLMNPQRSTUVWXYZ]/g, "").slice(0, 8);
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

/** 后端错误里的 code（WRONG_PAIRING_CODE、WRONG_PASSWORD…）和 HTTP 状态 */
function errorInfo(err: unknown): { status?: number; code?: string } {
  const r = (err as { response?: { status?: number; data?: { code?: string } } })?.response;
  return { status: r?.status, code: r?.data?.code };
}

function ageText(createdAt: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() / 1000 - createdAt) / 60));
  return minutes === 0 ? "刚刚发起" : `${minutes} 分钟前发起`;
}

function PendingRow({ req, onApprove, onDeny, busy }: { req: OAuthPendingRequest; onApprove: () => void; onDeny: () => void; busy: boolean }) {
  const left = Math.max(0, req.expiresAt - Math.floor(Date.now() / 1000));
  return (
    <li className="space-y-1.5 p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 break-all font-medium">{req.clientName}</span>
        <StatusBadge tone="neutral">{KIND_LABEL[req.clientKind]}</StatusBadge>
        {req.redirectInsecure && <StatusBadge tone="warning">回调是明文 http</StatusBadge>}
        {req.redirectLoopback && <StatusBadge tone="info">跳回本机</StatusBadge>}
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {ageText(req.createdAt)} · {Math.ceil(left / 60)} 分钟内有效
        </span>
      </div>
      <p className="break-all text-xs text-muted-foreground">
        {req.clientHost ? `身份：${req.clientHost}（元数据地址的域名）· ` : "名字是它自己报的 · "}
        授权后跳回 {req.redirectHost}
        {req.requestedScopes.length > 0 ? ` · 它要：${req.requestedScopes.map((s) => SCOPE_LABEL[s]).join("、")}` : ""}
        {req.ip ? ` · 来自 ${req.ip}` : ""}
      </p>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button type="button" size="sm" disabled={busy} onClick={onApprove} aria-label={`批准「${req.clientName}」`}>
          <ShieldCheck className="size-4" />
          批准…
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onDeny} aria-label={`拒绝「${req.clientName}」`}>
          拒绝
        </Button>
      </div>
    </li>
  );
}

/**
 * 批准框：输入授权页上的配对码、选档位（下面实时显示实际会给什么）、当前密码。
 * 配对码对不上说明这一条不是眼前那个授权页发起的——可能是别人冒充的，别批
 */
function ApproveDialog({ req, onClose, onDone }: { req: OAuthPendingRequest | null; onClose: () => void; onDone: () => void }) {
  const [code, setCode] = useState("");
  const [preset, setPreset] = useState("daily");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  useEffect(() => {
    if (req) {
      setCode("");
      setPreset(defaultPreset(req.requestedScopes));
      setPassword("");
      setCodeError(null);
      setPasswordError(null);
    }
  }, [req]);
  if (!req) return <Dialog open={false} />;
  const chosen = PRESETS.find((p) => p.id === preset)!.scopes;
  const preview = grantedPreview(req.requestedScopes, chosen);
  const complete = code.replace("-", "").length === 8 && password.length > 0;
  const submit = async () => {
    setSaving(true);
    setCodeError(null);
    setPasswordError(null);
    try {
      await api.agent.approveOAuth(req.id, { pairingCode: code, scopes: chosen, toolsets: null, currentPassword: password });
      toast.success(`已批准「${req.clientName}」，授权页会自动跳回客户端`);
      onDone();
    } catch (err) {
      const { status, code: errCode } = errorInfo(err);
      if (errCode === "WRONG_PAIRING_CODE") setCodeError("配对码对不上：输入的得是这一条授权页上显示的那个。对不上说明它不是你眼前的授权页发起的，别批");
      else if (errCode === "WRONG_PASSWORD") setPasswordError("当前密码不正确");
      else if (status === 404) {
        toast.error("这个授权请求已经处理过或过期了");
        onDone();
      } else toast.error(apiErrorMessage(err, "批准失败"));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="break-all">批准「{req.clientName}」</DialogTitle>
          <DialogDescription>
            在授权页上找到配对码，填到下面：对得上才会批准。这是为了确认批的就是你眼前那个授权页——谁都能打开授权页、冒充 claude.ai 发起请求。
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            // 弹框渲染在 portal 里，但 React 的事件照组件树往上冒：不拦住会连带提交外面设置页的表单
            e.preventDefault();
            e.stopPropagation();
            if (complete && !saving) void submit();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="oauth-pairing">配对码</Label>
            <Input
              id="oauth-pairing"
              value={code}
              onChange={(e) => setCode(formatPairing(e.target.value))}
              placeholder="XXXX-XXXX"
              autoComplete="off"
              autoFocus
              className="font-mono text-lg tracking-widest"
              aria-invalid={codeError ? true : undefined}
              aria-describedby={codeError ? "oauth-pairing-error" : undefined}
            />
            {codeError && (
              <p id="oauth-pairing-error" className={`text-xs ${TONE_CLASS.danger.text}`}>
                {codeError}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="oauth-preset">档位</Label>
            <Select value={preset} onValueChange={setPreset}>
              <SelectTrigger id="oauth-preset" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRESETS.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}：{p.scopes.map((s) => SCOPE_LABEL[s]).join("、")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              实际给：{preview.map((s) => SCOPE_LABEL[s]).join("、")}
              {req.requestedScopes.length > 0 ? "（不会超过客户端自己要的）" : "（客户端没说要什么，按你选的给）"}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="oauth-password">当前密码</Label>
            <Input
              id="oauth-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              aria-invalid={passwordError ? true : undefined}
              aria-describedby="oauth-password-hint"
            />
            <p id="oauth-password-hint" className={`text-xs ${passwordError ? TONE_CLASS.danger.text : "text-muted-foreground"}`}>
              {passwordError ?? "批准等于发一把能一直续期的钥匙，和建令牌一样要再输一次密码。"}
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              取消
            </Button>
            <Button type="submit" disabled={saving || !complete}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              批准
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 新建预注册客户端：名称 + 回调地址（一行一个）；建好后 client id 和 secret 只显示这一次 */
function ManualClientDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (c: OAuthClientCreated) => void }) {
  const [name, setName] = useState("");
  const [uris, setUris] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) {
      setName("");
      setUris("");
    }
  }, [open]);
  const redirectUris = uris
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const submit = async () => {
    setSaving(true);
    try {
      onCreated(await api.agent.createOAuthClient({ name: name.trim(), redirectUris }));
    } catch (err) {
      toast.error(apiErrorMessage(err, "新建失败"));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建预注册客户端</DialogTitle>
          <DialogDescription>给只能手填 client id / secret、不会自动注册的客户端用（比如 Home Assistant）。claude.ai、ChatGPT 不用建这个。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="oauth-client-name">名称</Label>
            <Input id="oauth-client-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="比如：Home Assistant" maxLength={60} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="oauth-client-uris">回调地址</Label>
            <Textarea id="oauth-client-uris" value={uris} onChange={(e) => setUris(e.target.value)} rows={3} placeholder={"一行一个，照客户端给的原样填\nhttps://my.home-assistant.io/redirect/oauth"} />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={saving || !name.trim() || redirectUris.length === 0}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            新建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ClientCreatedDialog({ created, onClose }: { created: OAuthClientCreated | null; onClose: () => void }) {
  return (
    <Dialog open={created != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton={false} onInteractOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="break-all">预注册客户端「{created?.info.name}」已建好</DialogTitle>
          <DialogDescription>client secret 只显示这一次，关掉就再也看不到了。把两样都填进客户端的 OAuth 设置里。</DialogDescription>
        </DialogHeader>
        {created && (
          <div className="space-y-3">
            {[
              ["Client ID", created.clientId],
              ["Client Secret", created.clientSecret],
            ].map(([label, value]) => (
              <div key={label} className="space-y-1">
                <span className="text-sm font-medium">{label}</span>
                <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-2">
                  <code className="min-w-0 flex-1 break-all font-mono text-xs select-all">{value}</code>
                  <CopyButton text={value} label={`复制 ${label}`} />
                </div>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">客户端认证方式选 client_secret_post 或 client_secret_basic 都行。</p>
          </div>
        )}
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            我已经记好了
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 一个确认框：断开一个 / 全部、删预注册客户端都用它 */
function ConfirmDialog({
  open,
  title,
  description,
  action,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  action: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-all">{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            disabled={busy}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

type Confirming = { kind: "grant"; grant: OAuthGrantInfo } | { kind: "allGrants" } | { kind: "client"; client: OAuthClientInfo };

export function AgentWebClients({ publicBaseUrl, enabled }: { publicBaseUrl: string; enabled: boolean }) {
  const [state, setState] = useState<AgentOAuthState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [approving, setApproving] = useState<OAuthPendingRequest | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<OAuthClientCreated | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState<AgentSelfCheckItem[] | null>(null);
  const [checking, setChecking] = useState(false);
  const pendingRef = useRef<HTMLDivElement>(null);
  /** 上一轮看到的待批准；null 是还没取过（第一次取到的不提醒） */
  const seenPending = useRef<Set<string> | null>(null);
  /** 只认最新一轮的结果：批准 / 断开之后再取的那一次，不能被更早发出、更晚回来的一轮盖掉 */
  const loadSeq = useRef(0);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    inFlight.current = true;
    try {
      const next = await api.agent.oauth();
      if (seq !== loadSeq.current) return;
      // 页面开着时来了新的待批准：提醒一声，免得没往下翻看不到
      const seen = seenPending.current;
      if (seen && next.pending.some((p) => !seen.has(p.id))) {
        toast.info("有客户端在等批准", { action: { label: "去看看", onClick: () => pendingRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }) } });
      }
      seenPending.current = new Set(next.pending.map((p) => p.id));
      setState(next);
      setLoadFailed(false);
    } catch {
      // 轮询失败不打扰：下一轮再试；页面上标出来，不让空列表看着像「一切正常」
      if (seq === loadSeq.current) setLoadFailed(true);
    } finally {
      if (seq === loadSeq.current) inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      // 上一轮还没回来就跳过这一轮，不叠着发
      if (document.visibilityState === "visible" && !inFlight.current) void load();
    }, POLL_MS);
    // 后台标签页不轮询；切回来时立刻取一次——人多半是从授权页切过来批准的，别让他干等一轮
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  // 公网地址换了：上一次的自检结果说的是旧地址
  useEffect(() => {
    setChecks(null);
  }, [publicBaseUrl]);

  const deny = async (req: OAuthPendingRequest) => {
    setBusy(true);
    try {
      await api.agent.denyOAuth(req.id);
      toast.success(`已拒绝「${req.clientName}」`);
    } catch (err) {
      if (errorInfo(err).status !== 404) toast.error(apiErrorMessage(err, "拒绝失败"));
    } finally {
      setBusy(false);
      void load();
    }
  };

  const denyAll = async () => {
    setBusy(true);
    try {
      const r = await api.agent.denyAllOAuth();
      toast.success(`已拒绝 ${r.denied} 个授权请求`);
    } catch (err) {
      toast.error(apiErrorMessage(err, "拒绝失败"));
    } finally {
      setBusy(false);
      void load();
    }
  };

  const confirm = async () => {
    if (!confirming) return;
    setBusy(true);
    try {
      if (confirming.kind === "allGrants") {
        const r = await api.agent.revokeAllGrants();
        toast.success(`已断开 ${r.deleted} 个客户端`);
      } else if (confirming.kind === "grant") {
        await api.agent.revokeGrant(confirming.grant.id);
        toast.success(`已断开「${confirming.grant.clientName}」`);
      } else {
        await api.agent.deleteOAuthClient(confirming.client.id);
        toast.success(`已删除「${confirming.client.name}」，用它连上的客户端也断开了`);
      }
      setConfirming(null);
    } catch (err) {
      // 404：已经被别处（另一个标签页、Telegram、过期清理）处理掉了，就当办完了
      if (errorInfo(err).status === 404) setConfirming(null);
      else toast.error(apiErrorMessage(err, confirming.kind === "client" ? "删除失败" : "断开失败"));
    } finally {
      setBusy(false);
      void load();
    }
  };

  const selfCheck = async () => {
    setChecking(true);
    try {
      setChecks((await api.agent.selfCheck()).items);
    } catch (err) {
      toast.error(apiErrorMessage(err, "自检失败"));
    } finally {
      setChecking(false);
    }
  };

  const mcpUrl = publicBaseUrl ? `${publicBaseUrl}/mcp` : "";
  const loading = state === null && !loadFailed;
  const listNote = (empty: string) =>
    loading ? "读取中…" : loadFailed && !state ? "没读到（过几秒自动重试）。" : empty;

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Globe className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">网页客户端（claude.ai、ChatGPT）</h3>
        {publicBaseUrl && <StatusBadge tone={enabled ? "success" : "neutral"}>{enabled ? "可以连" : "未开启"}</StatusBadge>}
        <FieldHint label="网页客户端说明">
          它们从自己的服务器连过来，要一个公网 https 地址，并走 OAuth：在客户端里填上地址，会打开一个授权页，页上显示配对码；回到这里点「批准」、输入配对码和当前密码（开了的话也可以把配对码发给 Telegram 机器人）。默认公网页面上不收管理员密码。
        </FieldHint>
        {loadFailed && state && <span className={`ml-auto text-xs ${TONE_CLASS.warning.text}`}>刷新失败，显示的是上一次读到的</span>}
      </div>

      {!publicBaseUrl ? (
        <p className="text-xs text-muted-foreground">先在上面填「公网地址」并保存。反代和 Cloudflare Tunnel 的配法见 README 的「公网部署」。</p>
      ) : (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-2 py-1">
            <code className="min-w-0 flex-1 truncate font-mono text-xs">{mcpUrl}</code>
            <CopyButton text={mcpUrl} label="复制公网 MCP 地址" />
          </div>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
            <li>claude.ai：设置 → 连接器（Connectors）→ 添加自定义连接器，填上面的地址，点「连接」会打开授权页。</li>
            <li>ChatGPT：设置里打开开发者模式（Developer mode），到 chatgpt.com/plugins 点「+」，填上面的地址，鉴权选 OAuth。</li>
          </ul>
        </div>
      )}

      <div ref={pendingRef} className="space-y-2">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-medium">待批准</h4>
          {state && state.pending.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon" className="ml-auto size-8" aria-label="待批准的更多操作">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="destructive" disabled={busy} onSelect={() => void denyAll()}>
                  全部拒绝
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {!state || state.pending.length === 0 ? (
          <p className="text-xs text-muted-foreground">{listNote("没有在等批准的客户端。在客户端里点连接后，这里会出现一条（开着页面时自动刷新）。")}</p>
        ) : (
          <ul className="divide-y rounded-lg border border-warning/60">
            {state.pending.map((req) => (
              <PendingRow key={req.id} req={req} busy={busy} onApprove={() => setApproving(req)} onDeny={() => void deny(req)} />
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-medium">已连接的客户端</h4>
          {state && state.grants.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon" className="ml-auto size-8" aria-label="已连接客户端的更多操作">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="destructive" onSelect={() => setTimeout(() => setConfirming({ kind: "allGrants" }), 0)}>
                  全部断开
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {!state || state.grants.length === 0 ? (
          <p className="text-xs text-muted-foreground">{listNote("还没有。")}</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {state.grants.map((g) => (
              <li key={g.id} className="flex items-start gap-2 p-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 break-all font-medium">{g.clientName}</span>
                    <StatusBadge tone={g.scopes.includes("write") ? "warning" : "info"}>{presetLabel(g.scopes)}</StatusBadge>
                    {g.status === "stale" && <StatusBadge tone="danger">已失效</StatusBadge>}
                  </div>
                  <p className="break-all text-xs text-muted-foreground">
                    {g.status === "stale" ? "公网地址改过了，它的令牌绑的是旧地址、用不了了：断开后在客户端里重新连接。" : ""}
                    {toolsetText(g.toolsets)}
                    {" · "}
                    {g.lastUsedAt ? `最近使用 ${fmtWhen(g.lastUsedAt * 1000)}${g.lastUsedIp ? `（${g.lastUsedIp}）` : ""}` : "还没用过"}
                    {` · 不用的话 ${fmtWhen(g.refreshExpiresAt * 1000)} 后要重新授权`}
                    {g.approvedVia ? ` · ${VIA_LABEL[g.approvedVia] ?? g.approvedVia}${g.requestIp ? `，授权页来自 ${g.requestIp}` : ""}` : ""}
                  </p>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" aria-label={`${g.clientName} 的更多操作`}>
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem variant="destructive" onSelect={() => setTimeout(() => setConfirming({ kind: "grant", grant: g }), 0)}>
                      断开
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-medium">预注册客户端</h4>
          <FieldHint label="预注册客户端说明">只有不会自动注册、又只能手填 client id / secret 的客户端才要（比如 Home Assistant）。claude.ai、ChatGPT、Codex 都不用。</FieldHint>
          <Button type="button" variant="ghost" size="sm" className="ml-auto h-7" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" />
            新建
          </Button>
        </div>
        {!state || state.clients.length === 0 ? (
          <p className="text-xs text-muted-foreground">{listNote("还没有。")}</p>
        ) : (
          <ul className="divide-y rounded-lg border text-sm">
            {state.clients.map((c) => (
              <li key={c.id} className="flex items-center gap-2 px-3 py-2">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="min-w-0 break-all font-medium">{c.name}</span>
                  <code className="min-w-0 break-all font-mono text-xs text-muted-foreground">{c.id}</code>
                  <span className="text-xs text-muted-foreground">{c.redirectUris.length} 个回调地址</span>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" aria-label={`${c.name} 的更多操作`}>
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem variant="destructive" onSelect={() => setTimeout(() => setConfirming({ kind: "client", client: c }), 0)}>
                      删除
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        )}
      </div>

      {publicBaseUrl && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-medium">连接自检</h4>
            <Button type="button" variant="outline" size="sm" className="ml-auto h-7" disabled={checking} onClick={() => void selfCheck()}>
              {checking && <Loader2 className="size-3.5 animate-spin" />}
              检查一遍
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">从服务器这边请求公网地址，看元数据、MCP 地址通不通，管理界面有没有漏到公网上。</p>
          {checks && (
            <ul className="space-y-1 text-xs">
              {checks.map((c) => (
                <li key={c.name} className="flex items-start gap-2">
                  {c.ok ? (
                    <CheckCircle2 className={`mt-0.5 size-3.5 shrink-0 ${TONE_CLASS.success.text}`} />
                  ) : (
                    <XCircle className={`mt-0.5 size-3.5 shrink-0 ${TONE_CLASS.danger.text}`} />
                  )}
                  <span className="min-w-0 break-all">
                    <span className="font-medium">{c.name}</span>
                    <span className="text-muted-foreground">：{c.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <ApproveDialog
        req={approving}
        onClose={() => setApproving(null)}
        onDone={() => {
          setApproving(null);
          void load();
        }}
      />
      <ManualClientDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(c) => {
          setCreating(false);
          setCreated(c);
          void load();
        }}
      />
      <ClientCreatedDialog created={created} onClose={() => setCreated(null)} />
      <ConfirmDialog
        open={confirming !== null}
        busy={busy}
        onCancel={() => setConfirming(null)}
        onConfirm={() => void confirm()}
        title={
          confirming?.kind === "allGrants"
            ? "断开全部网页客户端"
            : confirming?.kind === "grant"
              ? `断开「${confirming.grant.clientName}」`
              : confirming?.kind === "client"
                ? `删除预注册客户端「${confirming.client.name}」`
                : ""
        }
        description={
          confirming?.kind === "client"
            ? "它的 client id 和 secret 马上作废，用它连上的客户端也一起断开，已经批了还没连上的也作废。要再用得重新建一个，把新的 id / secret 填回客户端。调用记录会保留。"
            : `${confirming?.kind === "allGrants" ? "它们的" : "它的"}访问令牌和刷新令牌马上作废，要再用得在客户端里重新连接、重新批准。调用记录会保留。`
        }
        action={confirming?.kind === "client" ? "删除" : "断开"}
      />
    </div>
  );
}
