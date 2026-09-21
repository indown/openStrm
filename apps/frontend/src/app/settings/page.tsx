"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
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
import { FEATURES } from "@/lib/features";
import type { AppSettings, OrganizeSettings, UpdateSettings } from "@openstrm/shared";
import { OrganizeSection } from "./components/OrganizeSection";
import { UpdateSection } from "./components/UpdateSection";
import { AgentSection } from "./components/AgentSection";
import { SectionNav, type Section } from "./components/SectionNav";

/** 右侧导航的顺序就是页面顺序；id 对应各 section 上的锚点 */
const SECTIONS: Section[] = [
  { id: "update", title: "更新" },
  { id: "basic", title: "基础设置" },
  { id: "throttle", title: "下载限流" },
  { id: "emby", title: "Emby" },
  { id: "tmdb", title: "TMDB" },
  ...(FEATURES.hdhiveSearch ? [{ id: "hdhive", title: "HDHive" }] : []),
  { id: "openlist-copy", title: "复制到 OpenList" },
  { id: "organize", title: "整理与命名" },
  { id: "agent", title: "智能体接入" },
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

/** 公网地址只收 https 的源（不带路径）：OAuth 的地址都从它拼，和后端的校验一致 */
const httpsOrigin = (hint: string) =>
  z
    .string()
    .trim()
    .refine((v) => {
      if (v === "") return true;
      try {
        const u = new URL(v);
        return (
          u.protocol === "https:" &&
          !u.username &&
          !u.password &&
          (u.pathname === "/" || u.pathname === "") &&
          !u.search &&
          !u.hash &&
          !u.hostname.endsWith(".")
        );
      } catch {
        return false;
      }
    }, hint);

/** 两个地址是不是同一个源（大小写、默认端口、结尾的 / 不计较）：公网地址填的就是当前页面的地址 → 一个域名共用 */
function sameOrigin(value: string, origin: string): boolean {
  try {
    return new URL(value.trim()).origin === origin;
  } catch {
    return false;
  }
}

/** 只在局域网里解析得到的主机名后缀：从这样的地址打开的，外面的网页客户端连不上 */
const LAN_SUFFIXES = [".local", ".lan", ".home", ".internal", ".localdomain", ".home.arpa"];

/** 地址里的主机名（小写、去结尾的点）；不是合法地址返回 null */
function hostOfUrl(value: string): string | null {
  try {
    return new URL(value.trim()).hostname.toLowerCase().replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

/** 地址里写明的端口（没写、写的默认端口都是空） */
function portOf(value: string): string {
  try {
    return new URL(value.trim()).port;
  } catch {
    return "";
  }
}

/** 当前页面能不能当公网地址用：https、写的是公网域名（不是 IP、localhost、单段主机名、.local 这类局域网名字） */
function publicOriginOfPage(): string | null {
  const { protocol, hostname, port } = window.location;
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (protocol !== "https:" || host === "localhost" || /^[\d.]+$/.test(host) || host.startsWith("[")) return null;
  if (!host.includes(".") || host.endsWith(".localhost") || LAN_SUFFIXES.some((s) => host.endsWith(s))) return null;
  // 自己拼：location.origin 会留着域名结尾的点（nas.example.com.），填进去过不了校验
  return `https://${host}${port ? `:${port}` : ""}`;
}

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
  // 入口关着时这一节不显示，原样带回去就行：看不见的字段不能拦住保存（以前存进去的地址可能没带 http://）
  hdhive: z.object({
    apiKey: z.string(),
    baseUrl: FEATURES.hdhiveSearch ? httpUrl("填 http:// 或 https:// 开头的地址") : z.string(),
  }),
  openlistCopy: z.object({ account: z.string(), srcDir: z.string(), dstDir: z.string() }),
  organize: z.custom<OrganizeSettings>(),
  update: z.custom<UpdateSettings>(),
  agent: z.object({
    enabled: z.boolean(),
    uiBaseUrl: httpUrl("填 http:// 或 https:// 开头的地址，比如 http://nas:3000"),
    publicBaseUrl: httpsOrigin("填 https:// 开头的域名，不带路径，比如 https://nas.example.com"),
    publicServesUi: z.boolean(),
    allowPasswordApproval: z.boolean(),
    oauthCimd: z.boolean(),
  }),
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
    agent: {
      enabled: s.agent?.enabled === true,
      uiBaseUrl: s.agent?.uiBaseUrl ?? "",
      publicBaseUrl: s.agent?.publicBaseUrl ?? "",
      publicServesUi: s.agent?.publicServesUi === true,
      allowPasswordApproval: s.agent?.allowPasswordApproval === true,
      oauthCimd: s.agent?.oauthCimd === true,
    },
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
    agent: v.agent,
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

  // 当前页面的地址能不能直接当公网地址用（https、写的域名）：能就给「用当前地址」；pageHost 是现在打开管理界面用的主机名
  const [pageOrigin, setPageOrigin] = useState<string | null>(null);
  const [pageHost, setPageHost] = useState<string | null>(null);
  useEffect(() => {
    setPageOrigin(publicOriginOfPage());
    setPageHost(window.location.hostname.toLowerCase().replace(/\.$/, ""));
  }, []);
  /**
   * 「这个域名也用来打开管理界面」是对哪个域名开的：这次编辑里打开的记在这里，没有就看已保存的设置。
   * 公网地址换成别的域名时开关跟着关，不然新域名（比如给智能体单独开的子域名）下管理界面也打得开
   */
  const sharedHost = useRef<string | null>(null);
  // 公网地址下面的一句说明：两个开关为什么自己变了
  const [sharedNote, setSharedNote] = useState<"auto" | "unbound" | null>(null);
  const resetForm = useCallback(
    (values?: SettingsValues) => {
      form.reset(values);
      sharedHost.current = null;
      setSharedNote(null);
    },
    [form],
  );
  /**
   * 一个域名共用（多数人）：打开「这个域名也用来打开管理界面」，顺带打开授权页上的密码批准——
   * 这时登录页本来就在公网上，在客户端弹出的授权页上直接输密码批准是最顺的一步。两个开关之后仍然各自能关
   */
  const shareDomain = useCallback(() => {
    form.setValue("agent.publicServesUi", true, { shouldDirty: true });
    form.setValue("agent.allowPasswordApproval", true, { shouldDirty: true });
    sharedHost.current = pageOrigin ? hostOfUrl(pageOrigin) : null;
    setSharedNote("auto");
  }, [form, pageOrigin]);
  /** 公网地址填完（失焦）：开关开着、域名却换了，就关掉开关并说明；换成的是当前页面的地址就照旧共用 */
  const checkSharedHost = useCallback(() => {
    const value = form.getValues("agent.publicBaseUrl");
    const host = hostOfUrl(value);
    if (!host || !form.getValues("agent.publicServesUi")) return;
    const saved = form.formState.defaultValues?.agent;
    const bound = sharedHost.current ?? (saved?.publicServesUi && saved.publicBaseUrl ? hostOfUrl(saved.publicBaseUrl) : null);
    if (bound === null || host === bound || (pageOrigin && sameOrigin(value, pageOrigin))) {
      sharedHost.current = host;
      return;
    }
    form.setValue("agent.publicServesUi", false, { shouldDirty: true });
    sharedHost.current = null;
    setSharedNote("unbound");
  }, [form, pageOrigin]);

  useEffect(() => {
    api.settings
      .get()
      .then((s) => resetForm(fromSettings(s)))
      .catch((err) => toast.error(apiErrorMessage(err, "加载设置失败")))
      .finally(() => setLoading(false));
    // 「复制到 OpenList」里的账号下拉；拉不到就只剩空提示，不拦别的设置
    api.accounts
      .list()
      .then((rows) => setOpenlistAccounts(rows.filter((a) => a.accountType === "openlist").map((a) => a.name)))
      .catch(() => {});
  }, [resetForm]);

  const onSave = useCallback(
    async (v: SettingsValues) => {
      try {
        await api.settings.patch(toSettings(v));
        // 重读一次而不是拿刚发出去的当基准：密钥存进去之后服务端只回掩码，
        // 拿本地那份明文当基准的话，输入框会把刚打的密钥当成"已保存的掩码"明文摆出来
        try {
          resetForm(fromSettings(await api.settings.get()));
        } catch {
          resetForm(v);
        }
        toast.success("保存成功");
      } catch (error: unknown) {
        if (error && typeof error === "object" && "response" in error) {
          const apiError = error as { response?: { status?: number; data?: { message?: string } } };
          if (apiError.response?.status === 409) {
            // 有任务正在执行
            toast.error(apiError.response.data?.message || "有任务正在执行中，无法保存设置。请等待任务完成后再试。");
          } else if (apiError.response?.status === 400) {
            // 表单自己校验过的不会走到这；能到这的是只有服务端才判得了的（比如公网地址撞了管理界面的域名），原因要让人看见
            toast.error(`保存失败：${apiError.response.data?.message || "参数错误"}`);
          } else {
            toast.error("保存失败");
          }
        } else {
          toast.error("保存失败");
        }
      }
    },
    [resetForm],
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
                「整理」按它识别影视，不配就整理不了；「strm 管理」页的海报墙在目录里没有现成图片时，也从这里补海报。
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

            {FEATURES.hdhiveSearch && (
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
            )}

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

            <AgentSection
              enabled={saved?.agent?.enabled === true}
              publicBaseUrl={saved?.agent?.publicBaseUrl?.replace(/\/+$/, "") ?? ""}
              sharedDomain={saved?.agent?.publicServesUi === true}
              passwordApproval={saved?.agent?.allowPasswordApproval === true}
              fields={
                <div className="space-y-4">
                  <FormField
                    control={form.control}
                    name="agent.enabled"
                    render={({ field }) => (
                      <SwitchRow
                        label="开启智能体接入"
                        description="关着时 MCP 地址不对外，令牌也调不了接口"
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="agent.publicBaseUrl"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>公网地址（可选）</FormLabel>
                        <InputGroup>
                          <FormControl>
                            <InputGroupInput
                              placeholder="https://nas.example.com"
                              {...field}
                              onChange={(e) => {
                                field.onChange(e);
                                // 填的就是当前页面的地址：这个域名本来就用来打开管理界面，自动按共用处理
                                if (pageOrigin && sameOrigin(e.target.value, pageOrigin) && !form.getValues("agent.publicServesUi")) shareDomain();
                              }}
                              onBlur={() => {
                                field.onBlur();
                                checkSharedHost();
                              }}
                            />
                          </FormControl>
                          {pageOrigin && (
                            <InputGroupButton
                              onClick={() => {
                                form.setValue("agent.publicBaseUrl", pageOrigin, { shouldDirty: true, shouldValidate: true });
                                shareDomain();
                              }}
                              title={`填成 ${pageOrigin}`}
                            >
                              用当前地址
                            </InputGroupButton>
                          )}
                        </InputGroup>
                        <FormDescription className="text-xs">
                          claude.ai、ChatGPT 这类网页客户端从它们的服务器连过来，要一个公网 https 地址并走 OAuth 授权。多数人就填平时从外网打开这个界面的地址
                          {pageOrigin ? "（点「用当前地址」）" : "，并打开下面的「这个域名也用来打开管理界面」"}；给智能体单独开子域名的配法见 README
                        </FormDescription>
                        {sharedNote === "auto" && (
                          <p className="text-xs text-muted-foreground">
                            填的就是你现在打开这个页面的地址：已顺带打开「这个域名也用来打开管理界面」和「授权页上允许用管理员密码批准」。
                          </p>
                        )}
                        {sharedNote === "unbound" && (
                          <p className="text-xs text-warning">
                            公网地址换了域名，已关掉「这个域名也用来打开管理界面」：新域名下只放行智能体用的几个路径。它也用来打开管理界面的话，再把开关打开。
                          </p>
                        )}
                        {portOf(values.agent.publicBaseUrl) && (
                          <p className="text-xs text-warning">
                            带端口（:{portOf(values.agent.publicBaseUrl)}）的地址 claude.ai 连不上：它的服务器只往 443 端口连。443 被封的可以用 Cloudflare Tunnel，见 README。
                          </p>
                        )}
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="agent.publicServesUi"
                    render={({ field }) => {
                      const host = hostOfUrl(values.agent.publicBaseUrl);
                      return (
                        <SwitchRow
                          label="这个域名也用来打开管理界面"
                          description={
                            field.value ? (
                              `一个域名共用：${host ?? "这个域名"} 照常打开管理界面，智能体也从这里连。管理界面在公网上：密码要够长，放在反代 / Tunnel 后面要设 TRUST_PROXY；想再加一层可以套 Cloudflare Access（智能体的几个路径要放行，见 README）`
                            ) : host && host === pageHost ? (
                              <span className="text-destructive">
                                关着的话保存会被拒：你现在就是用 {host} 打开的管理界面，关掉后它会被挡在外面。要让这个域名只给智能体用，换局域网地址打开管理界面再关
                              </span>
                            ) : host ? (
                              <span className="text-warning">
                                关着：保存后 {host} 下只放行智能体用的几个路径，从外网用它打开管理界面会是 404。你平时就用这个地址打开管理界面的话，打开它
                              </span>
                            ) : (
                              "关着：这个域名下只放行智能体用的几个路径，管理界面在它下面打不开——给智能体单独开了子域名、管理界面不放公网时这么用"
                            )
                          }
                          checked={field.value}
                          onCheckedChange={(on) => {
                            field.onChange(on);
                            sharedHost.current = on ? host : null;
                            setSharedNote(null);
                            if (on) form.setValue("agent.allowPasswordApproval", true, { shouldDirty: true });
                          }}
                        />
                      );
                    }}
                  />
                  <FormField
                    control={form.control}
                    name="agent.allowPasswordApproval"
                    render={({ field }) => (
                      <SwitchRow
                        label="授权页上允许用管理员密码批准"
                        description="开着：在客户端里点连接、弹出授权页，直接在上面选档位、输密码批准（一个域名时推荐）。只对 claude.ai、ChatGPT、本机和局域网里的客户端有效，别的客户端照样用配对码，免得有人拿假冒的客户端骗你一键批了。关着：到这里的「待批准」输入授权页上的配对码批准（在 Telegram 页打开了「允许批准网页客户端的连接」的，也可以把配对码发给机器人）"
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="agent.uiBaseUrl"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>管理界面地址（可选）</FormLabel>
                        <FormControl>
                          <Input
                            placeholder={
                              values.agent.publicServesUi && values.agent.publicBaseUrl
                                ? `不填就用公网地址 ${values.agent.publicBaseUrl.replace(/\/+$/, "")}`
                                : "http://nas:3000"
                            }
                            {...field}
                          />
                        </FormControl>
                        <FormDescription className="text-xs">
                          工具结果里「在 OpenStrm 里打开」的链接用这个地址拼（比如 ChatGPT 做不了转存时，点链接就是预填好的转存框）。一个域名共用时不用填，默认用公网地址；填了就用填的（从外网打不开的话清空它）
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="agent.oauthCimd"
                    render={({ field }) => (
                      <SwitchRow
                        label="用 CIMD 认客户端"
                        description="默认关，客户端用动态注册。开了 claude.ai、ChatGPT 会改用 CIMD（授权页能显示它们经过核实的域名），但 OpenStrm 要能直接访问 claude.ai、chatgpt.com 去取客户端说明——国内网络一般不行，取不到就谁也连不上。开了之后点下面的「检查一遍」看取不取得到"
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    )}
                  />
                </div>
              }
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
                  <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => resetForm()}>
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
