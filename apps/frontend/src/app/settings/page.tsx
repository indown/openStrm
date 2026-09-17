"use client";
import { useCallback, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Input } from "@/components/ui/input";
import { TagInput } from "@/components/ui/tag-input";
import { SecretInput } from "@/components/ui/secret-input";
import { Button } from "@/components/ui/button";
import { SwitchRow } from "@/components/switch-row";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
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
import { downloadBackupWithToast } from "@/lib/backup";
import { useModKey } from "@/hooks/use-mod-key";
import { apiErrorMessage } from "@/lib/axios";
import type { AppSettings, OrganizeSettings, UpdateSettings } from "@openstrm/shared";
import { OrganizeSection } from "./components/OrganizeSection";
import { UpdateSection } from "./components/UpdateSection";
import { SectionNav, type Section } from "./components/SectionNav";

/** 右侧导航的顺序就是页面顺序；id 对应各 section 上的锚点 */
const SECTIONS: Section[] = [
  { id: "update", title: "更新" },
  { id: "basic", title: "基础设置" },
  { id: "throttle", title: "下载限流" },
  { id: "emby", title: "Emby" },
  { id: "tmdb", title: "TMDB" },
  { id: "hdhive", title: "HDHive" },
  { id: "openlist-copy", title: "复制到 OpenList" },
  { id: "organize", title: "整理与命名" },
];

/** 扩展名落一个标签时规范化：去空白、补点号、转小写。空的丢掉 */
function normalizeExtension(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  return v.startsWith(".") ? v : `.${v}`;
}

const httpUrl = (hint: string) =>
  z
    .string()
    .trim()
    .refine((v) => v === "" || /^https?:\/\/\S+$/i.test(v), hint);

/** 并发 / 频率这类计数在表单里是字符串：以前 `parseInt(v) || 2` 会把打错的字悄悄改回默认值 */
const count = (min: number, max: number) =>
  z
    .string()
    .trim()
    .refine((v) => /^\d+$/.test(v) && Number(v) >= min && Number(v) <= max, `填 ${min}–${max} 之间的整数`);

/**
 * 表单的形状。只含本页拥有的键——后端按顶层键合并，Telegram / 网盘监控那些
 * 由别的页面写的设置不会被这里加载时的快照覆盖掉。
 *
 * organize 和 update 是两个子组件各自管的一整块，这里只当作一个值透传，不拆开校验。
 */
const schema = z.object({
  "user-agent": z.string(),
  strmExtensions: z.array(z.string()),
  downloadExtensions: z.array(z.string()),
  mediaMountPath: z.array(z.string()),
  emby: z.object({
    url: httpUrl("填 http:// 或 https:// 开头的地址"),
    apiKey: z.string(),
    allowAnonymousRedirect: z.boolean(),
  }),
  download: z.object({
    linkMaxPerSecond: count(1, 100),
    linkMaxConcurrent: count(1, 50),
    downloadMaxConcurrent: count(1, 50),
  }),
  tmdb: z.object({ apiKey: z.string(), language: z.string() }),
  hdhive: z.object({ apiKey: z.string(), baseUrl: httpUrl("填 http:// 或 https:// 开头的地址") }),
  openlistCopy: z.object({ account: z.string(), srcDir: z.string(), dstDir: z.string() }),
  organize: z.custom<OrganizeSettings>(),
  update: z.custom<UpdateSettings>(),
});

type SettingsValues = z.infer<typeof schema>;

/** 服务端那份 → 表单那份 */
function fromSettings(s: AppSettings): SettingsValues {
  return {
    "user-agent": s["user-agent"] ?? "",
    strmExtensions: s.strmExtensions ?? [],
    downloadExtensions: s.downloadExtensions ?? [],
    mediaMountPath: s.mediaMountPath ?? [],
    emby: {
      url: s.emby?.url ?? "",
      apiKey: s.emby?.apiKey ?? "",
      allowAnonymousRedirect: s.emby?.allowAnonymousRedirect === true,
    },
    download: {
      linkMaxPerSecond: String(s.download?.linkMaxPerSecond ?? 2),
      linkMaxConcurrent: String(s.download?.linkMaxConcurrent ?? 10),
      downloadMaxConcurrent: String(s.download?.downloadMaxConcurrent ?? 2),
    },
    tmdb: { apiKey: s.tmdb?.apiKey ?? "", language: s.tmdb?.language ?? "" },
    hdhive: { apiKey: s.hdhive?.apiKey ?? "", baseUrl: s.hdhive?.baseUrl ?? "" },
    openlistCopy: {
      account: s.openlistCopy?.account ?? "",
      srcDir: s.openlistCopy?.srcDir ?? "",
      dstDir: s.openlistCopy?.dstDir ?? "",
    },
    organize: s.organize ?? {},
    update: s.update ?? {},
  };
}

/** 表单那份 → 提交那份 */
function toSettings(v: SettingsValues): AppSettings {
  return {
    "user-agent": v["user-agent"],
    strmExtensions: v.strmExtensions,
    downloadExtensions: v.downloadExtensions,
    mediaMountPath: v.mediaMountPath,
    emby: v.emby,
    download: {
      linkMaxPerSecond: Number(v.download.linkMaxPerSecond),
      linkMaxConcurrent: Number(v.download.linkMaxConcurrent),
      downloadMaxConcurrent: Number(v.download.downloadMaxConcurrent),
    },
    tmdb: v.tmdb,
    hdhive: v.hdhive,
    openlistCopy: v.openlistCopy,
    organize: v.organize,
    update: v.update,
  };
}

/**
 * 递归比叶子，数出几处和基准不一样。数组当一个叶子——扩展名列表改三个也是"一处改动"。
 * 不用 RHF 的 dirtyFields：那个把数组摊成一串布尔，数出来的是"改了几个元素"。
 */
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
  const [loading, setLoading] = useState(true);
  const [backingUp, setBackingUp] = useState(false);
  const [openlistAccounts, setOpenlistAccounts] = useState<string[]>([]);
  const modKey = useModKey();

  const form = useForm<SettingsValues>({
    resolver: zodResolver(schema),
    defaultValues: fromSettings({}),
  });
  const saving = form.formState.isSubmitting;
  const values = form.watch();
  // defaultValues 就是"上次从服务器读到的那份"，每次 reset 之后它跟着走
  const changes = countChanges(form.formState.defaultValues, values);

  useEffect(() => {
    api.settings
      .get()
      .then((s) => form.reset(fromSettings(s)))
      .catch((err) => toast.error(apiErrorMessage(err, "加载设置失败")))
      .finally(() => setLoading(false));
    // 「复制到 OpenList」里的账号下拉；拉不到就只剩空提示，不拦别的设置
    api.accounts
      .list()
      .then((rows) => setOpenlistAccounts(rows.filter((a) => a.accountType === "openlist").map((a) => a.name)))
      .catch(() => {});
  }, [form]);

  const onSave = useCallback(
    async (v: SettingsValues) => {
      try {
        await api.settings.patch(toSettings(v));
        // 重读一次而不是拿刚发出去的当基准：密钥存进去之后服务端只回掩码，
        // 拿本地那份明文当基准的话，输入框会把刚打的密钥当成"已保存的掩码"明文摆出来
        try {
          form.reset(fromSettings(await api.settings.get()));
        } catch {
          form.reset(v);
        }
        toast.success("保存成功");
      } catch (error: unknown) {
        if (error && typeof error === "object" && "response" in error) {
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
      }
    },
    [form],
  );

  // ⌘S / Ctrl+S 保存。浏览器那个"保存网页"对这里没意义，脏着就接管
  useEffect(() => {
    if (changes === 0 || saving) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "s" || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      void form.handleSubmit(onSave)();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [changes, saving, form, onSave]);

  // 改了没存就关标签页 / 刷新时拦一下。站内跳转拦不住（App Router 没给钩子），保存条已经一直摆在那儿
  useEffect(() => {
    if (changes === 0) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [changes]);

  // 带 #hash 进来时（侧栏的更新角标、分区导航的链接）得等这页真渲染出来才跳得动：
  // 加载期间这里是骨架屏，浏览器自己那次跳转找不到目标，于是停在顶部
  useEffect(() => {
    if (loading) return;
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id) document.getElementById(id)?.scrollIntoView();
  }, [loading]);

  const onBackup = async () => {
    setBackingUp(true);
    await downloadBackupWithToast();
    setBackingUp(false);
  };

  const description = "配置全局选项与 Emby 通知";
  /** 密钥字段拿它判断"还是库里那份掩码、没动过" */
  const saved = form.formState.defaultValues;

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
      <div className="flex gap-8">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSave)} className="min-w-0 max-w-3xl flex-1 space-y-6">
            <FormField
              control={form.control}
              name="update"
              render={({ field }) => <UpdateSection value={field.value ?? {}} onChange={field.onChange} />}
            />

            <section id="basic" className="scroll-mt-20 space-y-4 rounded-xl border bg-card p-6">
              <h2 className="text-base font-medium">基础设置</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="user-agent"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>User-Agent</FormLabel>
                      <FormControl>
                        <Input placeholder="Mozilla/5.0 ..." {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="strmExtensions"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Strm 文件扩展名</FormLabel>
                      <FormControl>
                        <TagInput
                          value={field.value}
                          onChange={field.onChange}
                          normalize={normalizeExtension}
                          placeholder="例如：.mkv，回车落一个"
                        />
                      </FormControl>
                      <FormDescription className="text-xs">这些扩展名的文件会生成 strm</FormDescription>
                    </FormItem>
                  )}
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="downloadExtensions"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>下载文件扩展名</FormLabel>
                      <FormControl>
                        <TagInput
                          value={field.value}
                          onChange={field.onChange}
                          normalize={normalizeExtension}
                          placeholder="例如：.srt，回车落一个"
                        />
                      </FormControl>
                      <FormDescription className="text-xs">
                        这些扩展名的文件会真的下到本地（字幕、nfo、海报）
                      </FormDescription>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="mediaMountPath"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>额外的媒体挂载路径</FormLabel>
                      <FormControl>
                        <TagInput
                          value={field.value}
                          onChange={field.onChange}
                          placeholder="/root/webdav/115，回车落一个"
                        />
                      </FormControl>
                      <FormDescription className="text-xs">
                        开了 302 的任务会自动把它的 strmPrefix 当作挂载路径，不用填在这里； 只填任务之外、也希望代理接管的前缀
                      </FormDescription>
                    </FormItem>
                  )}
                />
              </div>
            </section>

            <section id="throttle" className="scroll-mt-20 space-y-4 rounded-xl border bg-card p-6">
              <h2 className="text-base font-medium">下载限流配置</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="download.linkMaxPerSecond"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>链接获取每秒请求数</FormLabel>
                      <FormControl>
                        <Input inputMode="numeric" placeholder="2" {...field} />
                      </FormControl>
                      <FormDescription className="text-xs">控制获取下载链接的每秒请求数</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="download.linkMaxConcurrent"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>链接获取并发数</FormLabel>
                      <FormControl>
                        <Input inputMode="numeric" placeholder="10" {...field} />
                      </FormControl>
                      <FormDescription className="text-xs">控制同时获取下载链接的数量</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="download.downloadMaxConcurrent"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>文件下载并发数</FormLabel>
                      <FormControl>
                        <Input inputMode="numeric" placeholder="2" {...field} />
                      </FormControl>
                      <FormDescription className="text-xs">控制同时下载文件的数量</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </section>

            <section id="emby" className="scroll-mt-20 space-y-4 rounded-xl border bg-card p-6">
              <h2 className="text-base font-medium">Emby</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="emby.url"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Emby URL</FormLabel>
                      <FormControl>
                        <Input placeholder="http://host.docker.internal:8096" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="emby.apiKey"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Emby API Key</FormLabel>
                      <FormControl>
                        <SecretInput
                          value={field.value}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          name={field.name}
                          masked={saved?.emby?.apiKey}
                          placeholder="xxxxxxxxxxxxxxxx"
                        />
                      </FormControl>
                      <FormDescription className="text-xs">改动即替换，清空即删除</FormDescription>
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="emby.allowAnonymousRedirect"
                render={({ field }) => (
                  // 后果不进 ⓘ：开了之后谁都能拿到直链，这句必须一眼看见
                  <SwitchRow
                    label="允许未认证的请求换取直链"
                    description="默认关闭。开启后，任何能访问代理端口的人报一个条目 id 就能拿到你的媒体直链，无需登录 Emby。"
                    hint="不带 Emby 令牌的请求会改用上面那个 API Key 去解析直链。绝大多数播放器都会带令牌，只有确认播放器一个令牌都不发、且播放确实不走直连时才需要开启。"
                    checked={field.value === true}
                    onCheckedChange={field.onChange}
                  />
                )}
              />
            </section>

            <section id="tmdb" className="scroll-mt-20 space-y-4 rounded-xl border bg-card p-6">
              <h2 className="text-base font-medium">TMDB</h2>
              <p className="text-sm text-muted-foreground">
                配置后，在影库「加入影库」对话框中可通过 TMDB 搜索自动填充标题与封面。
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="tmdb.apiKey"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>TMDB API Key (v4 Bearer Token)</FormLabel>
                      <FormControl>
                        <SecretInput
                          value={field.value}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          name={field.name}
                          masked={saved?.tmdb?.apiKey}
                          placeholder="eyJhbGciOiJIUzI1NiJ9..."
                        />
                      </FormControl>
                      <FormDescription className="text-xs">改动即替换，清空即删除</FormDescription>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="tmdb.language"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>默认语言</FormLabel>
                      <FormControl>
                        <Input placeholder="zh-CN" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </section>

            <section id="hdhive" className="scroll-mt-20 space-y-4 rounded-xl border bg-card p-6">
              <h2 className="text-base font-medium">HDHive OpenAPI</h2>
              <p className="text-sm text-muted-foreground">
                配置后，可在顶部搜索框搜索影视并查询 HDHive 的可用资源（基于 TMDB ID）。
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="hdhive.apiKey"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>HDHive API Key (X-API-Key)</FormLabel>
                      <FormControl>
                        <SecretInput
                          value={field.value}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          name={field.name}
                          masked={saved?.hdhive?.apiKey}
                          placeholder="个人 API Key 或应用 Secret"
                        />
                      </FormControl>
                      <FormDescription className="text-xs">改动即替换，清空即删除</FormDescription>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="hdhive.baseUrl"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Base URL (可选)</FormLabel>
                      <FormControl>
                        <Input placeholder="https://hdhive.com" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </section>

            <section id="openlist-copy" className="scroll-mt-20 space-y-4 rounded-xl border bg-card p-6">
              <h2 className="text-base font-medium">复制到 OpenList</h2>
              <p className="text-sm text-muted-foreground">
                三项都配好后，「云下载」页添加任务（下载到 115 默认目录）时可以勾选
                「下载完成后让 OpenList 复制走」：115 下完，就通知 OpenList
                把产物从挂载的 115 存储复制到目标目录（比如挂载的本地磁盘）。
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="openlistCopy.account"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>OpenList 账号</FormLabel>
                      {openlistAccounts.length === 0 ? (
                        <p className="text-sm text-muted-foreground">还没有 openlist 账号，先到「账户」页添加一个。</p>
                      ) : (
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="选择账号" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {openlistAccounts.map((name) => (
                              <SelectItem key={name} value={name}>
                                {name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      <FormDescription className="text-xs">用这个账号调 OpenList 的接口</FormDescription>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="openlistCopy.srcDir"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>源目录</FormLabel>
                      <FormControl>
                        <Input placeholder="/115/云下载" {...field} />
                      </FormControl>
                      <FormDescription className="text-xs">
                        115 默认下载目录在 OpenList 里的完整路径（挂载路径 + 目录）
                      </FormDescription>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="openlistCopy.dstDir"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>目标目录</FormLabel>
                      <FormControl>
                        <Input placeholder="/local/downloads" {...field} />
                      </FormControl>
                      <FormDescription className="text-xs">
                        复制到 OpenList 的哪个目录（另一个存储里的路径）
                      </FormDescription>
                    </FormItem>
                  )}
                />
              </div>
            </section>

            <FormField
              control={form.control}
              name="organize"
              render={({ field }) => <OrganizeSection value={field.value ?? {}} onChange={field.onChange} />}
            />

            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" disabled={backingUp} onClick={onBackup}>
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
                  <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => form.reset()}>
                    放弃更改
                  </Button>
                  <Button type="submit" size="sm" disabled={saving}>
                    {saving ? "保存中..." : "保存"}
                  </Button>
                </div>
              </div>
            )}
          </form>
        </Form>
        <SectionNav sections={SECTIONS} />
      </div>
    </div>
  );
}
