"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { SwitchRow } from "@/components/switch-row";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Settings as SettingsIcon } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { FormSkeleton } from "@/components/loading";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import type { AppSettings } from "@openstrm/shared";
import { OrganizeSection } from "./components/OrganizeSection";
import { UpdateSection } from "./components/UpdateSection";

type Settings = AppSettings;

/** 逗号分隔的扩展名 → 规范化数组：去空白、补点号、转小写 */
function parseExtensions(input: string): string[] {
  return input
    .split(",")
    .map((ext) => ext.trim())
    .filter((ext) => ext.length > 0)
    .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`))
    .map((ext) => ext.toLowerCase());
}

/**
 * 要提交的那份设置。只含本页拥有的键——后端按顶层键合并，
 * Telegram / 生活事件监控那些由别的页面写的设置不会被这里加载时的快照覆盖掉。
 * 脏状态和保存共用它，比的和存的才是同一个东西。
 */
function buildPayload(data: Settings, strmExt: string, downloadExt: string, mountPath: string): Settings {
  return {
    "user-agent": data["user-agent"],
    strmExtensions: parseExtensions(strmExt),
    downloadExtensions: parseExtensions(downloadExt),
    mediaMountPath: mountPath
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0),
    emby: data.emby,
    download: data.download,
    tmdb: data.tmdb,
    hdhive: data.hdhive,
    openlistCopy: data.openlistCopy,
    organize: data.organize,
    update: data.update,
  };
}

/** 递归比叶子，数出几处和基准不一样。数组当一个叶子——扩展名列表改三个也是"一处改动" */
function countChanges(base: unknown, next: unknown): number {
  if (base === next) return 0;
  const isPlain = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (isPlain(base) && isPlain(next)) {
    let n = 0;
    for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) n += countChanges(base[key], next[key]);
    return n;
  }
  return JSON.stringify(base) === JSON.stringify(next) ? 0 : 1;
}

export default function SettingsPage() {
  const [data, setData] = useState<Settings>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [strmExtensionsInput, setStrmExtensionsInput] = useState("");
  const [downloadExtensionsInput, setDownloadExtensionsInput] = useState("");
  const [mediaMountPathInput, setMediaMountPathInput] = useState("");
  const [backingUp, setBackingUp] = useState(false);
  const [openlistAccounts, setOpenlistAccounts] = useState<string[]>([]);
  /** 上次从服务器读到（或刚存成功）的那份，用来算改了几处 */
  const [baseline, setBaseline] = useState<Settings | null>(null);
  /** 保存条上那个快捷键提示。取 navigator 要等挂载后，否则静态导出时服务端没有它 */
  const [modKey, setModKey] = useState("Ctrl");

  useEffect(() => {
    if (/Mac|iPhone|iPad|iPod/.test(navigator.userAgent)) setModKey("⌘");
  }, []);

  useEffect(() => {
    api.settings.get()
      .then((settings) => {
        setData(settings);
        const strmExt = (settings.strmExtensions || []).join(", ");
        const downloadExt = (settings.downloadExtensions || []).join(", ");
        const mountPath = (settings.mediaMountPath || []).join(", ");
        setStrmExtensionsInput(strmExt);
        setDownloadExtensionsInput(downloadExt);
        setMediaMountPathInput(mountPath);
        setBaseline(buildPayload(settings, strmExt, downloadExt, mountPath));
      })
      .catch((err) => toast.error(apiErrorMessage(err, "加载设置失败")))
      .finally(() => setLoading(false));
    // 「复制到 OpenList」里的账号下拉；拉不到就只剩空提示，不拦别的设置
    api.accounts
      .list()
      .then((rows) => setOpenlistAccounts(rows.filter((a) => a.accountType === "openlist").map((a) => a.name)))
      .catch(() => {});
  }, []);

  const payload = useMemo(
    () => buildPayload(data, strmExtensionsInput, downloadExtensionsInput, mediaMountPathInput),
    [data, strmExtensionsInput, downloadExtensionsInput, mediaMountPathInput],
  );
  const changes = baseline ? countChanges(baseline, payload) : 0;

  const onSave = useCallback(async () => {
    setSaving(true);
    try {
      await api.settings.patch(payload);
      setData((prev) => ({ ...prev, ...payload }));
      setBaseline(payload);
      toast.success("保存成功");
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'response' in error) {
        const apiError = error as { response?: { status?: number; data?: { message?: string } } };
        if (apiError.response?.status === 409) {
          // 有任务正在执行
          toast.error(apiError.response.data?.message || "有任务正在执行中，无法保存设置。请等待任务完成后再试。");
        } else if (apiError.response?.status === 400) {
          toast.error("保存失败：参数错误");
        } else {
          toast.error("保存失败");
        }
      } else {
        toast.error("保存失败");
      }
    } finally {
      setSaving(false);
    }
  }, [payload]);

  /** 放弃：把三个文本框和 data 都退回基准那一份 */
  const onRevert = () => {
    if (!baseline) return;
    setData((prev) => ({ ...prev, ...baseline }));
    setStrmExtensionsInput((baseline.strmExtensions || []).join(", "));
    setDownloadExtensionsInput((baseline.downloadExtensions || []).join(", "));
    setMediaMountPathInput((baseline.mediaMountPath || []).join(", "));
  };

  // ⌘S / Ctrl+S 保存。浏览器那个"保存网页"对这里没意义，脏着就接管
  useEffect(() => {
    if (changes === 0 || saving) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "s" || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      void onSave();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [changes, saving, onSave]);

  // 改了没存就关标签页 / 刷新时拦一下。站内跳转拦不住（App Router 没给钩子），保存条已经一直摆在那儿
  useEffect(() => {
    if (changes === 0) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [changes]);

  // 备份接口要带登录 token，普通 <a download> 带不上，只能拉成 blob 再触发下载
  const downloadBackup = async () => {
    setBackingUp(true);
    try {
      const { blob, filename } = await api.system.backup();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      // 别同步撤销：Firefox / Safari 会在下载真正开始前就把 URL 收回，下载直接中断
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      toast.error("下载备份失败");
    } finally {
      setBackingUp(false);
    }
  };

  const description = "配置全局选项与 Emby 通知";

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader icon={SettingsIcon} title="设置" description={description} />
        <div className="max-w-3xl">
          <FormSkeleton />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader icon={SettingsIcon} title="设置" description={description} />
      <div className="max-w-3xl space-y-6">
        <UpdateSection value={data.update ?? {}} onChange={(update) => setData({ ...data, update })} />

        <section className="space-y-4 rounded-xl border bg-card p-6">
          <h2 className="text-base font-medium">基础设置</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>User-Agent</Label>
              <Input
                value={data["user-agent"] || ""}
                onChange={(e) =>
                  setData({ ...data, ["user-agent"]: e.target.value })
                }
                placeholder="Mozilla/5.0 ..."
              />
            </div>
            <div className="space-y-2">
              <Label>Strm文件扩展名</Label>
              <Input
                value={strmExtensionsInput}
                onChange={(e) => setStrmExtensionsInput(e.target.value)}
                placeholder="请输入 例如：.mkv, .mp4, .mp3"
              />
              <p className="text-xs text-muted-foreground">
                用逗号分隔，自动添加点号前缀
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>下载文件扩展名</Label>
              <Input
                value={downloadExtensionsInput}
                onChange={(e) => setDownloadExtensionsInput(e.target.value)}
                placeholder="请输入 例如：.srt, .ass, .sub, .nfo"
              />
              <p className="text-xs text-muted-foreground">
                用逗号分隔，自动添加点号前缀
              </p>
            </div>
            <div className="space-y-2">
              <Label>额外的媒体挂载路径 (mediaMountPath)</Label>
              <Input
                value={mediaMountPathInput}
                onChange={(e) => setMediaMountPathInput(e.target.value)}
                placeholder="/root/webdav/115, /mnt/media"
              />
              <p className="text-xs text-muted-foreground">
                开了 302 的任务会自动把它的 strmPrefix 当作挂载路径，不用填在这里；
                只填任务之外、也希望代理接管的前缀，多个用逗号分隔
              </p>
            </div>
          </div>
        </section>

        <section className="space-y-4 rounded-xl border bg-card p-6">
          <h2 className="text-base font-medium">下载限流配置</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>链接获取每秒请求数 (linkMaxPerSecond)</Label>
              <Input
                type="number"
                min="1"
                max="100"
                value={data.download?.linkMaxPerSecond || 2}
                onChange={(e) =>
                  setData({
                    ...data,
                    download: { 
                      ...(data.download || {}), 
                      linkMaxPerSecond: parseInt(e.target.value) || 2 
                    },
                  })
                }
                placeholder="2"
              />
              <p className="text-xs text-muted-foreground">
                控制获取下载链接的每秒请求数
              </p>
            </div>
            <div className="space-y-2">
              <Label>链接获取并发数 (linkMaxConcurrent)</Label>
              <Input
                type="number"
                min="1"
                max="50"
                value={data.download?.linkMaxConcurrent || 10}
                onChange={(e) =>
                  setData({
                    ...data,
                    download: { 
                      ...(data.download || {}), 
                      linkMaxConcurrent: parseInt(e.target.value) || 10 
                    },
                  })
                }
                placeholder="10"
              />
              <p className="text-xs text-muted-foreground">
                控制同时获取下载链接的数量
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>文件下载并发数 (downloadMaxConcurrent)</Label>
              <Input
                type="number"
                min="1"
                max="50"
                value={data.download?.downloadMaxConcurrent || 2}
                onChange={(e) =>
                  setData({
                    ...data,
                    download: { 
                      ...(data.download || {}), 
                      downloadMaxConcurrent: parseInt(e.target.value) || 2 
                    },
                  })
                }
                placeholder="2"
              />
              <p className="text-xs text-muted-foreground">
                控制同时下载文件的数量
              </p>
            </div>
          </div>
        </section>

        <section className="space-y-4 rounded-xl border bg-card p-6">
          <h2 className="text-base font-medium">Emby</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Emby URL</Label>
              <Input
                value={data.emby?.url || ""}
                onChange={(e) =>
                  setData({
                    ...data,
                    emby: { ...(data.emby || {}), url: e.target.value },
                  })
                }
                placeholder="http://host.docker.internal:8096"
              />
            </div>
            <div className="space-y-2">
              <Label>Emby API Key</Label>
              <Input
                value={data.emby?.apiKey || ""}
                onChange={(e) =>
                  setData({
                    ...data,
                    emby: { ...(data.emby || {}), apiKey: e.target.value },
                  })
                }
                placeholder="xxxxxxxxxxxxxxxx"
              />
              <p className="text-xs text-muted-foreground">已保存的密钥只显示末 4 位；改动即替换，清空即删除</p>
            </div>
          </div>
          <SwitchRow
            label="允许未认证的请求换取直链"
            description="默认关闭。开启后，不带任何 Emby 令牌的请求也会用上面这个 API Key 去解析直链——意味着任何能访问代理端口的人，报一个条目 id 就能拿到你的媒体直链，无需登录 Emby。绝大多数播放器都会带令牌，只有确认播放器一个令牌都不发、且播放确实不走直连时才需要开启。"
            checked={data.emby?.allowAnonymousRedirect === true}
            onCheckedChange={(v) =>
              setData({
                ...data,
                emby: { ...(data.emby || {}), allowAnonymousRedirect: v },
              })
            }
          />
        </section>

        <section className="space-y-4 rounded-xl border bg-card p-6">
          <h2 className="text-base font-medium">TMDB</h2>
          <p className="text-sm text-muted-foreground">
            配置后，在影库「加入影库」对话框中可通过 TMDB 搜索自动填充标题与封面。
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>TMDB API Key (v4 Bearer Token)</Label>
              <Input
                value={data.tmdb?.apiKey || ""}
                onChange={(e) =>
                  setData({
                    ...data,
                    tmdb: { ...(data.tmdb || {}), apiKey: e.target.value },
                  })
                }
                placeholder="eyJhbGciOiJIUzI1NiJ9..."
              />
              <p className="text-xs text-muted-foreground">已保存的密钥只显示末 4 位；改动即替换，清空即删除</p>
            </div>
            <div className="space-y-2">
              <Label>默认语言</Label>
              <Input
                value={data.tmdb?.language || ""}
                onChange={(e) =>
                  setData({
                    ...data,
                    tmdb: { ...(data.tmdb || {}), language: e.target.value },
                  })
                }
                placeholder="zh-CN"
              />
            </div>
          </div>
        </section>

        <section className="space-y-4 rounded-xl border bg-card p-6">
          <h2 className="text-base font-medium">HDHive OpenAPI</h2>
          <p className="text-sm text-muted-foreground">
            配置后，可在顶部搜索框搜索影视并查询 HDHive 的可用资源（基于 TMDB ID）。
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>HDHive API Key (X-API-Key)</Label>
              <Input
                value={data.hdhive?.apiKey || ""}
                onChange={(e) =>
                  setData({
                    ...data,
                    hdhive: { ...(data.hdhive || {}), apiKey: e.target.value },
                  })
                }
                placeholder="个人 API Key 或应用 Secret"
              />
              <p className="text-xs text-muted-foreground">已保存的密钥只显示末 4 位；改动即替换，清空即删除</p>
            </div>
            <div className="space-y-2">
              <Label>Base URL (可选)</Label>
              <Input
                value={data.hdhive?.baseUrl || ""}
                onChange={(e) =>
                  setData({
                    ...data,
                    hdhive: { ...(data.hdhive || {}), baseUrl: e.target.value },
                  })
                }
                placeholder="https://hdhive.com"
              />
            </div>
          </div>
        </section>

        <section className="space-y-4 rounded-xl border bg-card p-6">
          <h2 className="text-base font-medium">复制到 OpenList</h2>
          <p className="text-sm text-muted-foreground">
            三项都配好后，「云下载」页添加任务（下载到 115 默认目录）时可以勾选
            「下载完成后让 OpenList 复制走」：115 下完，就通知 OpenList
            把产物从挂载的 115 存储复制到目标目录（比如挂载的本地磁盘）。
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>OpenList 账号</Label>
              {openlistAccounts.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  还没有 openlist 账号，先到「账户」页添加一个。
                </p>
              ) : (
                <Select
                  value={data.openlistCopy?.account || ""}
                  onValueChange={(v) =>
                    setData({
                      ...data,
                      openlistCopy: { ...(data.openlistCopy || {}), account: v },
                    })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择账号" />
                  </SelectTrigger>
                  <SelectContent>
                    {openlistAccounts.map((name) => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <p className="text-xs text-muted-foreground">用这个账号调 OpenList 的接口</p>
            </div>
            <div className="space-y-2">
              <Label>源目录</Label>
              <Input
                value={data.openlistCopy?.srcDir || ""}
                onChange={(e) =>
                  setData({
                    ...data,
                    openlistCopy: { ...(data.openlistCopy || {}), srcDir: e.target.value },
                  })
                }
                placeholder="/115/云下载"
              />
              <p className="text-xs text-muted-foreground">
                115 默认下载目录在 OpenList 里的完整路径（挂载路径 + 目录）
              </p>
            </div>
            <div className="space-y-2">
              <Label>目标目录</Label>
              <Input
                value={data.openlistCopy?.dstDir || ""}
                onChange={(e) =>
                  setData({
                    ...data,
                    openlistCopy: { ...(data.openlistCopy || {}), dstDir: e.target.value },
                  })
                }
                placeholder="/local/downloads"
              />
              <p className="text-xs text-muted-foreground">复制到 OpenList 的哪个目录（另一个存储里的路径）</p>
            </div>
          </div>
        </section>

        <OrganizeSection value={data.organize ?? {}} onChange={(organize) => setData({ ...data, organize })} />

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" disabled={backingUp} onClick={downloadBackup}>
            {backingUp ? "打包中..." : "下载备份"}
          </Button>
          <span className="text-xs text-muted-foreground">
            一致性快照（openstrm.db）；库是 WAL 模式，直接拷文件可能拷到一半
          </span>
        </div>

        {/* 改了才出现，跟着这一列贴在视口底部：这页有 3000px 高，保存不能只待在最下面 */}
        {changes > 0 && (
          <div className="sticky bottom-4 z-10 flex items-center gap-3 rounded-xl border bg-card/90 p-3 shadow-lg backdrop-blur-md">
            <span className="text-sm font-medium tabular-nums">{changes} 处未保存</span>
            <kbd className="hidden rounded border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline">
              {modKey === "⌘" ? "⌘S" : "Ctrl+S"}
            </kbd>
            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" size="sm" disabled={saving} onClick={onRevert}>
                放弃更改
              </Button>
              <Button size="sm" disabled={saving} onClick={() => void onSave()}>
                {saving ? "保存中..." : "保存"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
