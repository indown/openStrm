"use client";
import { Fragment, useCallback, useEffect, useState } from "react";
import { Activity, Loader2, Play, Radar, RotateCw, Square, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { FormSkeleton } from "@/components/loading";
import type { LifeMonitorSettings } from "@openstrm/shared";
import { api, type LifeEventMode as EventMode, type LifeEventRow, type LifeMonitorStatus as Status } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";

/**
 * 只放配置项，故意不含 enabled。
 * enabled 是「是否随服务自启」的运行态，由启动/停止按钮独占，
 * 表单若也带着它，保存时会用挂载那一刻的旧值把启停结果覆盖掉。
 */
type LifeMonitorConfig = Omit<LifeMonitorSettings, "enabled">;

type Account = { name: string; accountType: string };

const ALL_MODES: { value: EventMode; label: string; hint: string }[] = [
  { value: "create", label: "新增", hint: "上传 / 接收 / 复制 → 生成 strm" },
  { value: "move", label: "移动", hint: "移动网盘文件 → 同步移动本地" },
  { value: "rename", label: "改名", hint: "重命名 → 同步重命名本地" },
  { value: "remove", label: "删除", hint: "删除网盘文件 → 删除本地 strm" },
];

const PULL_MODES = [
  { value: "latest", label: "latest — 只处理启动之后的新事件" },
  { value: "all", label: "all — 拉取全部历史事件补齐" },
  { value: "last", label: "last — 从上次停止的位置继续" },
];

function fmtTime(sec?: number | null) {
  if (!sec) return "—";
  const ms = sec > 1e11 ? sec : sec * 1000;
  return new Date(ms).toLocaleString();
}

function relative(ms: number | null) {
  if (!ms) return "—";
  const d = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (d < 60) return `${d} 秒前`;
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  return `${Math.floor(d / 3600)} 小时前`;
}

export default function LifeMonitorPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [events, setEvents] = useState<LifeEventRow[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [cfg, setCfg] = useState<LifeMonitorConfig>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.life.status());
    } catch {
      /* 轮询失败静默，避免刷屏 */
    }
  }, []);

  const loadEvents = useCallback(async () => {
    try {
      setEvents((await api.life.events(30)).events || []);
    } catch {
      /* 同上 */
    }
  }, []);

  useEffect(() => {
    Promise.all([
      api.settings.get().then((s) => {
        // 运行态归启停按钮管，别让表单把它带回来
        const saved = { ...(s.lifeMonitor ?? {}) };
        delete saved.enabled;
        setCfg(saved);
      }),
      api.accounts.list().then((list) => setAccounts((list || []).filter((a) => a.accountType === "115"))),
      loadStatus(),
      loadEvents(),
    ])
      .catch((err) => toast.error(apiErrorMessage(err, "加载监控配置失败")))
      .finally(() => setLoading(false));
  }, [loadStatus, loadEvents]);

  // 运行时每 5s 刷新一次状态，停止时不必轮询
  useEffect(() => {
    if (!status?.running) return;
    const t = setInterval(() => {
      loadStatus();
      loadEvents();
    }, 5000);
    return () => clearInterval(t);
  }, [status?.running, loadStatus, loadEvents]);

  const saveConfig = async () => {
    setSaving(true);
    try {
      // 只动 lifeMonitor 这一个键；enabled 由启停按钮维护，合并时保留库里的值
      const current = (await api.settings.get()).lifeMonitor ?? {};
      await api.settings.patch({ lifeMonitor: { ...current, ...cfg } });
      toast.success("配置已保存");
      if (status?.running) toast.info("部分参数需要重启监控后生效");
    } catch {
      toast.error("保存失败");
    } finally {
      setSaving(false);
    }
  };

  const start = async () => {
    setBusy(true);
    try {
      const r = await api.life.start(cfg);
      // 起来了但有账号没起来：按警告提示，别让一条失败原因藏在绿色对勾后面
      if (r.partial) toast.warning(r.message);
      else toast.success(r.message || "已启动");
      await loadStatus();
    } catch (err: unknown) {
      toast.error(apiErrorMessage(err, "启动失败"));
      await loadStatus();
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      const r = await api.life.stop();
      toast.success(r.message || "已停止");
      await loadStatus();
    } catch {
      toast.error("停止失败");
    } finally {
      setBusy(false);
    }
  };

  const probe = async () => {
    setProbing(true);
    try {
      const r = await api.life.probe(5);
      toast.success(`连通正常：${r.message || ""}`);
    } catch (err: unknown) {
      toast.error(apiErrorMessage(err, "连接失败"));
    } finally {
      setProbing(false);
    }
  };

  const toggleMode = (m: EventMode, on: boolean) => {
    const cur = new Set<EventMode>(cfg.eventModes ?? ALL_MODES.map((x) => x.value));
    if (on) cur.add(m);
    else cur.delete(m);
    setCfg({ ...cfg, eventModes: ALL_MODES.map((x) => x.value).filter((v) => cur.has(v)) });
  };

  const toggleAccount = (name: string, on: boolean) => {
    const cur = new Set(cfg.accounts ?? []);
    if (on) cur.add(name);
    else cur.delete(name);
    // 按账号表的顺序存，勾选的先后不影响结果；已不存在的账号名排最后
    const known = accounts.map((a) => a.name).filter((n) => cur.has(n));
    const unknown = [...cur].filter((n) => !accounts.some((a) => a.name === n));
    setCfg({ ...cfg, accounts: [...known, ...unknown] });
  };

  const description = "轮询 115 生活事件，网盘一有变动就增量更新本地 strm 库，无需跑全量任务；多个账号各自轮询";

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader icon={Radar} title="网盘监控" description={description} />
        <div className="max-w-3xl">
          <FormSkeleton />
        </div>
      </div>
    );
  }

  const modes = new Set<EventMode>(cfg.eventModes ?? ALL_MODES.map((x) => x.value));
  const selected = new Set(cfg.accounts ?? []);
  const unknownAccounts = [...selected].filter((n) => !accounts.some((a) => a.name === n));
  const runningCount = status?.accounts.filter((a) => a.running).length ?? 0;
  // 只有一个账号时事件表不用多一列账号
  const showEventAccount =
    (status?.accounts.length ?? 0) > 1 || new Set(events.map((e) => e.accountName)).size > 1;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Radar}
        title="网盘监控"
        description={description}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={probe} disabled={probing}>
              {probing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              测试连接
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              title="刷新"
              onClick={() => { loadStatus(); loadEvents(); }}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            {status?.running ? (
              <>
                {/* 重启 = 用当前表单配置先停再起：改了账号列表、或某个账号修好 cookie 后重新带上它 */}
                <Button variant="outline" size="sm" onClick={start} disabled={busy}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
                  重启
                </Button>
                <Button variant="destructive" size="sm" onClick={stop} disabled={busy}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
                  停止
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={start} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                启动
              </Button>
            )}
          </>
        }
      />
      <div className="max-w-3xl space-y-6">
        {/* ---------------- 运行状态 ---------------- */}
        <section className="space-y-4 rounded-xl border bg-card p-6">
          <h2 className="flex items-center gap-2 text-base font-medium">
            <Activity className="h-4 w-4 text-muted-foreground" />
            运行状态
          </h2>

          <div className="flex flex-wrap items-center gap-2">
            {status &&
              (status.running ? (
                <StatusBadge tone="info" pulse>
                  运行中
                </StatusBadge>
              ) : (
                <StatusBadge tone="neutral">已停止</StatusBadge>
              ))}
            {status && status.accounts.length > 0 && (
              <Badge variant="outline" className="tabular-nums">
                {runningCount} / {status.accounts.length} 个账号在跑
              </Badge>
            )}
            {status?.embyRefresh?.configured && status.embyRefresh.pendingCount > 0 && (
              <Badge variant="outline" className="tabular-nums">
                待通知 Emby：{status.embyRefresh.pendingCount} 处变更
              </Badge>
            )}
          </div>

          {status === null ? (
            <p className="text-sm text-muted-foreground">运行状态没能加载，点右上角的刷新按钮重试</p>
          ) : status.accounts.length > 0 ? (
            <div className="overflow-hidden rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>账号</TableHead>
                    <TableHead className="w-20">状态</TableHead>
                    <TableHead className="w-20">接口</TableHead>
                    <TableHead className="w-16 text-right">轮询</TableHead>
                    <TableHead className="w-16 text-right">事件</TableHead>
                    <TableHead className="w-16 text-right">已处理</TableHead>
                    <TableHead className="w-16 text-right">失败</TableHead>
                    <TableHead className="w-24">最近轮询</TableHead>
                    <TableHead className="w-40">游标时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {status.accounts.map((a) => (
                    <Fragment key={a.name}>
                      <TableRow>
                        <TableCell className="font-medium">{a.name}</TableCell>
                        <TableCell>
                          {a.running ? (
                            <StatusBadge tone="info" pulse>
                              运行中
                            </StatusBadge>
                          ) : (
                            <StatusBadge tone="neutral">已停止</StatusBadge>
                          )}
                        </TableCell>
                        <TableCell className="text-xs">{a.api === "web" ? "webapi" : "proapi"}</TableCell>
                        <TableCell className="text-right tabular-nums">{a.stats.rounds}</TableCell>
                        <TableCell className="text-right tabular-nums">{a.stats.events}</TableCell>
                        <TableCell className="text-right tabular-nums">{a.stats.handled}</TableCell>
                        <TableCell className="text-right tabular-nums">{a.stats.failed}</TableCell>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {relative(a.lastPollAt)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {fmtTime(a.cursor.fromTime)}
                        </TableCell>
                      </TableRow>
                      {a.lastError ? (
                        <TableRow>
                          <TableCell colSpan={9} className="text-xs text-destructive break-all whitespace-normal">
                            最近错误：{a.lastError}
                          </TableCell>
                        </TableRow>
                      ) : status.running && !a.running ? (
                        // 状态列表按当前配置生成：监控跑着时才勾上的账号会在这里，但还没被带上
                        <TableRow>
                          <TableCell colSpan={9} className="text-xs text-muted-foreground">
                            启动后才加进配置，重启监控后生效
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              没有可监控的 115 账号，请先到「账户」页添加带 cookie 的 115 账号
            </p>
          )}

          <div className="grid grid-cols-3 gap-3 rounded-lg bg-muted/40 p-3 text-sm md:grid-cols-6">
            <Stat label="轮询次数" value={status?.stats.rounds ?? 0} />
            <Stat label="已处理" value={status?.stats.handled ?? 0} />
            <Stat label="失败" value={status?.stats.failed ?? 0} />
            <Stat label="最近轮询" value={relative(status?.lastPollAt ?? null)} />
            <Stat label="事件表" value={status?.db.lifeEvents ?? 0} />
            <Stat label="路径缓存" value={status?.db.pathCache ?? 0} />
          </div>

          {status?.logs && status.logs.length > 0 && (
            <details className="rounded-lg border bg-muted/30 p-3">
              <summary className="cursor-pointer text-sm select-none">
                运行日志（最近 {Math.min(status.logs.length, 50)} 条）
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto font-mono text-xs whitespace-pre-wrap break-all text-muted-foreground">
                {status.logs.slice(-50).join("\n")}
              </pre>
            </details>
          )}
        </section>

        {/* ---------------- 配置 ---------------- */}
        <section className="space-y-4 rounded-xl border bg-card p-6">
          <h2 className="text-base font-medium">配置</h2>

          <div className="space-y-2">
            <Label>监控账号</Label>
            {accounts.length === 0 && unknownAccounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无 115 账号，请先到「账户」页添加</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {accounts.map((a) => (
                  <label key={a.name} className="flex items-center gap-2 rounded-md border p-3 cursor-pointer">
                    <Checkbox
                      checked={selected.has(a.name)}
                      onCheckedChange={(v) => toggleAccount(a.name, v === true)}
                    />
                    <span className="text-sm font-medium">{a.name}</span>
                  </label>
                ))}
                {unknownAccounts.map((name) => (
                  <label key={name} className="flex items-center gap-2 rounded-md border border-dashed p-3 cursor-pointer">
                    <Checkbox checked onCheckedChange={(v) => toggleAccount(name, v === true)} />
                    <span className="text-sm">
                      <span className="font-medium">{name}</span>
                      <span className="block text-xs text-muted-foreground">账号已不存在，取消勾选后保存</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              勾选的账号各跑一条轮询，互不影响；一个都不勾时监控全部 115 账号。事件路径按该账号同步任务的原始路径前缀匹配
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>冷启动模式</Label>
              <Select
                value={cfg.pullMode || "latest"}
                onValueChange={(v) => setCfg({ ...cfg, pullMode: v as LifeMonitorConfig["pullMode"] })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PULL_MODES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                首次启用建议 latest；all 会把历史事件全部补一遍，耗时较长
              </p>
            </div>

            <div className="space-y-2">
              <Label>轮询间隔（秒）</Label>
              <Input
                type="number"
                min={5}
                max={3600}
                value={cfg.intervalSeconds ?? 15}
                onChange={(e) =>
                  setCfg({ ...cfg, intervalSeconds: parseInt(e.target.value) || 15 })
                }
              />
              <p className="text-xs text-muted-foreground">默认 15 秒，太短容易触发 115 风控；每个账号各算各的</p>
            </div>
          </div>

          <div className="space-y-2">
            <Label>处理的事件类型</Label>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {ALL_MODES.map((m) => (
                <label key={m.value} className="flex items-start gap-2 rounded-md border p-3 cursor-pointer">
                  <Checkbox
                    checked={modes.has(m.value)}
                    onCheckedChange={(v) => toggleMode(m.value, v === true)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="text-sm font-medium">{m.label}</span>
                    <span className="block text-xs text-muted-foreground">{m.hint}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              关掉「删除」可以避免网盘误删连带清掉本地 strm
            </p>
          </div>

          <div className="space-y-4 border-t pt-4">
            <div className="space-y-1">
              <h3 className="text-sm font-medium">Emby 刷新</h3>
              <p className="text-xs text-muted-foreground">
                /Library/Refresh 是全库扫描，生活事件逐条触发会打瘫 Emby，所以合并成一次再发。
                未配置 Emby 地址时不会发出任何请求。
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>安静期（秒）</Label>
                <Input
                  type="number"
                  min={1}
                  value={cfg.mediaServerRefreshDelay ?? 30}
                  onChange={(e) =>
                    setCfg({ ...cfg, mediaServerRefreshDelay: parseInt(e.target.value) || 30 })
                  }
                />
                <p className="text-xs text-muted-foreground">最后一次变更后再等这么久才通知</p>
              </div>
              <div className="space-y-2">
                <Label>最长等待（秒）</Label>
                <Input
                  type="number"
                  min={1}
                  value={cfg.mediaServerRefreshMaxWait ?? 300}
                  onChange={(e) =>
                    setCfg({ ...cfg, mediaServerRefreshMaxWait: parseInt(e.target.value) || 300 })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  变更持续不断时的封顶时间，防止刷新被无限推后
                </p>
              </div>
            </div>
          </div>

          <div className="pt-2">
            <Button disabled={saving} onClick={saveConfig}>
              {saving ? "保存中..." : "保存"}
            </Button>
          </div>
        </section>

        {/* ---------------- 最近事件 ---------------- */}
        <section className="space-y-4 rounded-xl border bg-card p-6">
          <h2 className="text-base font-medium">最近事件</h2>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有拉到任何事件</p>
          ) : (
            <div className="overflow-hidden rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-40">时间</TableHead>
                    {showEventAccount && <TableHead className="w-28">账号</TableHead>}
                    <TableHead className="w-28">类型</TableHead>
                    <TableHead>文件</TableHead>
                    <TableHead className="w-20">结果</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {fmtTime(e.updateTime)}
                      </TableCell>
                      {showEventAccount && <TableCell className="text-xs">{e.accountName}</TableCell>}
                      <TableCell className="text-xs">{e.typeName}</TableCell>
                      <TableCell className="text-xs whitespace-normal">
                        <div className="break-all">{e.fileName}</div>
                        {e.detail && (
                          <div className="text-muted-foreground break-all">{e.detail}</div>
                        )}
                      </TableCell>
                      <TableCell>
                        <StatusBadge
                          tone={e.status === "done" ? "success" : e.status === "failed" ? "danger" : "neutral"}
                        >
                          {e.status}
                        </StatusBadge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium tabular-nums">{value}</div>
    </div>
  );
}
