"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  CloudDownload,
  History,
  Link2Off,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Search,
  SearchX,
  Settings as SettingsIcon,
  Telescope,
  X,
} from "lucide-react";
import type { ResourceHit, ResourceKind } from "@openstrm/shared";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { CardListSkeleton } from "@/components/loading";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { InputGroup, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ShareDetailDialog } from "@/components/ShareDetailDialog";
import { AddOfflineTaskDialog } from "@/app/offline/components/AddOfflineTaskDialog";
import { useShareDetail } from "@/hooks/use-share-detail";
import { TOTAL_ROUNDS, useResourceSearch } from "@/hooks/use-resource-search";
import { useLinkCheck } from "@/hooks/use-link-check";
import { api } from "@/lib/api";
import { inputKindOf, unsupportedInputMessage } from "@/lib/share";
import { OFFLINE_ADD_MAX, offlineHandoffHref } from "@/lib/offline";
import { KIND_LABEL, KIND_TABS, YEAR_FILTER, clearRecent, loadRecent, passesTagFilters, rememberRecent } from "@/lib/resource";
import { cn } from "@/lib/utils";
import { ResultRow } from "./components/ResultRow";
import { TagFilterBar } from "./components/TagFilterBar";
import { TmdbStrip, type TmdbPick } from "./components/TmdbStrip";

/** 输入框按钮的字：贴的是分享就是「查看」，磁力就是「云下载」 */
const SUBMIT_LABEL = { share: "查看", offline: "云下载", unsupported: "查看", search: "搜索" } as const;

/** 关键词最长多少字：后端 /api/resource/search 同一个数 */
const KEYWORD_MAX = 100;

const NOT_CONFIGURED_TOAST = "还没配置资源搜索：到设置页「资源搜索」填 PanSou 的地址";

/** 一个 tab 先显示多少条，「显示更多」一次加多少 */
const PAGE_SIZE = 30;
/** 列表顶端离视口顶部不到这么多（顶栏 56 再留点余量）就算人已经滚进列表了 */
const LIST_HOLD_TOP = 72;

const DESCRIPTION = "通过 PanSou 按片名搜网盘分享和磁力：115 / 夸克的分享一键转存，磁力交给 115 云下载";

export default function SearchPage() {
  return (
    <div className="space-y-6">
      <PageHeader icon={Telescope} title="资源搜索" description={DESCRIPTION} />
      {/* 要读 ?q=，静态导出下必须包在 Suspense 里 */}
      <Suspense fallback={<CardListSkeleton />}>
        <SearchView />
      </Suspense>
    </div>
  );
}

/** 设置里的几项：配没配、要不要检测有效性、有没有 TMDB（有才出候选那一排）。读到之前是 null */
interface SearchConfig {
  configured: boolean;
  checkLinks: boolean;
  tmdb: boolean;
}

const EMPTY_SET: ReadonlySet<string> = new Set();
/** 账号列表没读到时给结果行的：固定一个，别每次渲染都新建一个空数组，让 memo 住的行白白重画 */
const NO_ACCOUNTS: string[] = [];

function withoutYear(set: ReadonlySet<string>): ReadonlySet<string> {
  if (!set.has(YEAR_FILTER)) return set;
  const next = new Set(set);
  next.delete(YEAR_FILTER);
  return next;
}

function SearchView() {
  const router = useRouter();
  const params = useSearchParams();
  const q = params.get("q")?.trim() ?? "";
  const kindParam = params.get("kind");
  // 选了 TMDB 候选：是哪一部、它的年份（加亮、只看这一年）、外文原名（交给 PanSou 认它的插件）
  const tmdbParam = params.get("tmdb");
  const yearParam = params.get("year");
  const year = yearParam && /^(?:19|20)\d{2}$/.test(yearParam) ? yearParam : null;
  const titleEn = params.get("en") ?? "";

  const [config, setConfig] = useState<SearchConfig | null>(null);
  /** 能云下载的 115 账号；null = 还没读到（或者读失败了） */
  const [offlineAccounts, setOfflineAccounts] = useState<string[] | null>(null);
  const [input, setInput] = useState(q);
  const [recent, setRecent] = useState<string[]>([]);
  const [kind, setKind] = useState<ResourceKind | null>(null);
  const [hideDead, setHideDead] = useState(false);
  const [shown, setShown] = useState(PAGE_SIZE);
  /** picked：这次打开是「云下载所选」，加成功了清掉勾选 */
  const [offline, setOffline] = useState<{ open: boolean; account: string; urls: string; picked?: boolean }>({ open: false, account: "", urls: "" });
  /** 按标签筛：换关键词清空，换 tab 保留 */
  const [tagFilter, setTagFilter] = useState<ReadonlySet<string>>(EMPTY_SET);
  /** 磁力 / 电驴勾选的：key → 链接。换关键词清空，换 tab 保留（磁力和电驴能一起选） */
  const [picked, setPicked] = useState<ReadonlyMap<string, string>>(new Map());
  /** 正在打开转存框的那一条 */
  const [openingKey, setOpeningKey] = useState<string | null>(null);

  const share = useShareDetail();
  const linkCheck = useLinkCheck(config?.checkLinks === true);
  const listRef = useRef<HTMLDivElement>(null);
  const rs = useResourceSearch({
    // 有人在操作时新一轮先攒着：转存 / 云下载框开着，或者已经滚进了列表（列表顶端到了顶栏底下）。
    // 不按「滚过多少屏」算：结果不多时页面只能滚一两百像素，那种条件永远到不了
    shouldHold: () =>
      share.open || offline.open || picked.size > 0 || (listRef.current ? listRef.current.getBoundingClientRect().top < LIST_HOLD_TOP : false),
  });

  useEffect(() => {
    setRecent(loadRecent());
    api.settings
      .get()
      .then((s) =>
        setConfig({ configured: Boolean(s.pansou?.baseUrl?.trim()), checkLinks: s.pansou?.checkLinks !== false, tmdb: Boolean(s.tmdb?.apiKey?.trim()) }),
      )
      .catch(() => setConfig({ configured: true, checkLinks: false, tmdb: false }));
    api.accounts
      .list()
      .then((list) => setOfflineAccounts(list.filter((a) => a.accountType === "115").map((a) => a.name)))
      .catch(() => {});
  }, []);

  // 地址里的 q 搜不了的两种：太长（后端只收 100 个字，重试也是一样的错）、是个链接（深链或者旧书签；输入框会按链接处理它）
  const qProblem: "long" | "link" | null = !q ? null : q.length > KEYWORD_MAX ? "long" : inputKindOf(q) !== "search" ? "link" : null;

  // 地址栏的 q 变了（顶栏、⌘K、最近搜索、深链都走这里）就搜；没配置、搜不了的 q 都不发请求，也不记进最近搜索
  const { search, reset } = rs;
  useEffect(() => {
    setInput(q);
    setKind(kindParam && (KIND_TABS as string[]).includes(kindParam) ? (kindParam as ResourceKind) : null);
    setShown(PAGE_SIZE);
    setTagFilter(EMPTY_SET);
    setPicked(new Map());
    if (!config?.configured) return;
    if (!q || qProblem) {
      reset();
      return;
    }
    search(q, { titleEn });
    setRecent(rememberRecent(q));
    // kindParam、titleEn 只在换关键词时读一次：之后切 tab 由这一页自己管；取消 TMDB 候选时去掉 en 不该重搜
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, qProblem, config?.configured, search, reset]);

  /**
   * 选 TMDB 候选：名字和当前关键词不一样就按它重搜（换一个地址，带上是哪一部、年份、外文原名）；
   * 一样就只记下选了哪部。null 是取消
   */
  const pickTmdb = (pick: TmdbPick | null) => {
    // 「只看这一年」跟着候选走：换了、取消了都去掉，免得拿新的年份悄悄筛
    setTagFilter((prev) => withoutYear(prev));
    const next = new URLSearchParams(params.toString());
    for (const k of ["tmdb", "year", "en"]) next.delete(k);
    if (!pick) {
      router.replace(`/search?${next}`, { scroll: false });
      return;
    }
    const name = pick.title.trim();
    const original = pick.originalTitle.trim();
    const withPick = (p: URLSearchParams) => {
      p.set("tmdb", pick.key);
      if (/^(?:19|20)\d{2}$/.test(pick.year)) p.set("year", pick.year);
      return p;
    };
    if (name && name !== q) {
      const fresh = withPick(new URLSearchParams({ q: name }));
      // 原名是外文、和中文名不一样的才带：PanSou 有的插件拿它去搜英文站
      if (original && original !== name && /[a-z]/i.test(original)) fresh.set("en", original);
      router.push(`/search?${fresh}`);
    } else {
      router.replace(`/search?${withPick(next)}`, { scroll: false });
    }
  };

  const submit = (text: string = input) => {
    const t = text.trim();
    if (!t) return;
    // 贴的是分享链接：直接打开转存框；磁力、电驴、下载链接：直接打开云下载框；认不出的链接当场说
    const inputKind = inputKindOf(t);
    if (inputKind === "unsupported") {
      toast.error(unsupportedInputMessage(t));
      return;
    }
    if (inputKind === "share") {
      void share.load(t);
      return;
    }
    if (inputKind === "offline") {
      // 账号列表还没读到（或读失败了）：交给云下载页，它自己读账号、出错也会说
      if (offlineAccounts === null) router.push(offlineHandoffHref(t));
      else if (offlineAccounts.length === 0) toast.error("还没有 115 账号：云下载要用 115，先到「账户」页添加一个");
      else setOffline({ open: true, account: offlineAccounts[0], urls: t });
      return;
    }
    // 没配置时这个框只收链接；片名太长的当场说，别带着它去搜（后端只收 100 个字）
    if (!config?.configured) {
      toast.error(NOT_CONFIGURED_TOAST);
      return;
    }
    if (t.length > KEYWORD_MAX) {
      toast.error(`关键词最多 ${KEYWORD_MAX} 个字`);
      return;
    }
    if (t === q) {
      // 同一个词再按一次：重搜（地址不变，上面的 effect 不会跑）
      search(t, { titleEn });
      setRecent(rememberRecent(t));
      setShown(PAGE_SIZE);
      return;
    }
    router.push(`/search?${new URLSearchParams({ q: t })}`);
  };

  const result = rs.result;
  const tabs = useMemo(() => KIND_TABS.filter((k) => (result?.counts[k] ?? 0) > 0), [result]);
  // 默认落在第一个「有结果、也有账号接得住」的 tab；落定之后就钉住，后面几轮补来别的类型也不跳走
  const defaultKind = useMemo(
    () => tabs.find((k) => result?.items.some((h) => h.kind === k && h.action)) ?? tabs[0] ?? null,
    [tabs, result],
  );
  useEffect(() => {
    if (!kind && defaultKind) setKind(defaultKind);
  }, [kind, defaultKind]);
  const active = kind && tabs.includes(kind) ? kind : defaultKind;

  const chooseTab = (k: ResourceKind) => {
    setKind(k);
    setShown(PAGE_SIZE);
    const next = new URLSearchParams(params.toString());
    next.set("kind", k);
    router.replace(`/search?${next}`, { scroll: false });
  };
  /** 类型 tab 的方向键：左右换一个、Home / End 到头，焦点跟着走（只有选中的那个在 Tab 顺序里） */
  const onTabKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!active) return;
    const at = tabs.indexOf(active);
    const to =
      e.key === "ArrowRight" ? (at + 1) % tabs.length : e.key === "ArrowLeft" ? (at - 1 + tabs.length) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
    if (to < 0 || tabs[to] === active) return;
    e.preventDefault();
    chooseTab(tabs[to]);
    document.getElementById(`search-tab-${tabs[to]}`)?.focus();
  };

  /** 这一类的全部（筛选按钮上的条数按它数） */
  const tabHits = useMemo(() => (result?.items ?? []).filter((h) => h.kind === active), [result, active]);
  // 地址里没年份了（浏览器后退到选候选之前）：「只看这一年」不生效，也不算选着
  const activeFilter = useMemo(() => (year ? tagFilter : withoutYear(tagFilter)), [tagFilter, year]);
  const items = useMemo(
    () => tabHits.filter((h) => !(hideDead && linkCheck.states.get(h.key) === "bad") && passesTagFilters(h, activeFilter, year)),
    [tabHits, hideDead, linkCheck.states, activeFilter, year],
  );
  const toggleTag = (tag: string) => {
    setTagFilter((prev) => {
      const next = new Set(prev);
      if (!next.delete(tag)) next.add(tag);
      return next;
    });
    setShown(PAGE_SIZE);
  };
  /** 这一类（磁力 / 电驴）当前筛选下、已经显示出来的能勾的：「全选」只选看得见的 */
  const pickableItems = useMemo(
    () => items.slice(0, shown).filter((h) => (h.kind === "magnet" || h.kind === "ed2k") && h.action === "offline"),
    [items, shown],
  );
  const allPicked = pickableItems.length > 0 && pickableItems.every((h) => picked.has(h.key));
  const pickOne = useCallback((hit: ResourceHit, on: boolean) => {
    setPicked((prev) => {
      const next = new Map(prev);
      if (on) next.set(hit.key, hit.url);
      else next.delete(hit.key);
      return next;
    });
  }, []);
  const pickAll = (on: boolean) => {
    setPicked((prev) => {
      const next = new Map(prev);
      for (const h of pickableItems) {
        if (on) next.set(h.key, h.url);
        else next.delete(h.key);
      }
      return next;
    });
  };
  const deadCount = useMemo(
    () => (result?.items ?? []).filter((h) => h.kind === active && linkCheck.states.get(h.key) === "bad").length,
    [result, active, linkCheck.states],
  );

  const { mark } = linkCheck;
  const openShare = useCallback(
    async (hit: ResourceHit) => {
      setOpeningKey(hit.key);
      const r = await share.load(hit.url);
      setOpeningKey((k) => (k === hit.key ? null : k));
      // 用账号读一次才是准的：分享没了记成失效；提取码不对或没带的分享其实还在，记成「要提取码」
      if (!r.ok && r.code === "SHARE_GONE") mark(hit.key, r.reason === "password" ? "locked" : "bad");
      else if (r.ok) mark(hit.key, "ok");
    },
    // share.load 每次渲染都是新函数；这里只该跟着 mark 变
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mark],
  );
  const openOffline = useCallback(
    (hit: ResourceHit, account: string | undefined) => {
      if (account) setOffline({ open: true, account, urls: hit.url });
      // 账号列表没读到（或读失败了）：交给云下载页，它自己读账号、出错也会说
      else router.push(offlineHandoffHref(hit.url));
    },
    [router],
  );
  const tooManyPicked = picked.size > OFFLINE_ADD_MAX;
  const offlinePicked = () => {
    if (picked.size === 0 || tooManyPicked) return;
    const urls = [...picked.values()].join("\n");
    if (offlineAccounts === null) router.push(offlineHandoffHref(urls));
    else if (offlineAccounts.length === 0) toast.error("还没有 115 账号：云下载要用 115，先到「账户」页添加一个");
    else setOffline({ open: true, account: offlineAccounts[0], urls, picked: true });
  };

  if (config === null) return <CardListSkeleton />;

  // 没配置时照样给输入框：顶栏的框在这一页藏起来了，分享链接、磁力得有地方粘
  const notConfigured = !config.configured || rs.errorCode === "PANSOU_NOT_CONFIGURED";
  const searching = rs.status === "loading" || rs.status === "refining";
  const total = result?.items.length ?? 0;

  return (
    // 勾着磁力时底部浮着一条：页面底下留出它的高度，最后一行和「显示更多」不被盖住
    <div className={cn("space-y-4", picked.size > 0 && "pb-20")}>
      <div className="space-y-2">
        <InputGroup className="h-10 bg-card">
          <Search className="ml-3 size-4 shrink-0 text-muted-foreground" />
          <InputGroupInput
            autoFocus={!q}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              // 贴磁力回车会当场打开云下载框、焦点跳进它的输入框：不拦的话这个回车会落进去，链接前面多一个空行
              e.preventDefault();
              submit();
            }}
            placeholder={notConfigured ? "粘贴 115 / 夸克分享或磁力链接" : "片名、剧名，或者直接粘贴分享 / 磁力链接"}
            aria-label="搜索资源"
          />
          {input && (
            <InputGroupButton className="border-l-0 px-2" aria-label="清空" onClick={() => setInput("")}>
              <X />
            </InputGroupButton>
          )}
          <InputGroupButton onClick={() => submit()} disabled={!input.trim() || share.loading}>
            {share.loading && !openingKey ? <Loader2 className="animate-spin" /> : null}
            {SUBMIT_LABEL[inputKindOf(input)]}
          </InputGroupButton>
        </InputGroup>
        {!notConfigured && recent.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <History className="size-3.5" />
            {recent.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => submit(k)}
                className={cn("rounded-md border px-2 py-0.5 hover:bg-accent hover:text-foreground", k === q && "border-brand/40 text-foreground")}
              >
                {k}
              </button>
            ))}
            <button
              type="button"
              className="px-1 hover:text-foreground"
              onClick={() => {
                clearRecent();
                setRecent([]);
              }}
            >
              清空
            </button>
          </div>
        )}
      </div>

      {notConfigured && (
        <EmptyState
          icon={Telescope}
          title="还没配置资源搜索"
          description="接上自己部署的 PanSou，就能按片名搜网盘分享和磁力：115 / 夸克的分享直接转存，磁力交给 115 云下载。没配置也能在上面的框里粘分享链接和磁力。"
          action={
            <Button asChild>
              <Link href="/settings#pansou">
                <SettingsIcon />
                去设置
              </Link>
            </Button>
          }
        />
      )}

      {!notConfigured && config.tmdb && q && !qProblem && <TmdbStrip keyword={q} selected={tmdbParam} year={year} onSelect={pickTmdb} />}

      {!notConfigured && qProblem === "long" && (
        <EmptyState icon={SearchX} title="关键词太长了" description={`最多 ${KEYWORD_MAX} 个字：删短一点再搜。`} />
      )}
      {!notConfigured && qProblem === "link" && (
        <EmptyState
          icon={Link2Off}
          title="这是链接，不是片名"
          description="在上面的输入框里按回车：分享链接会打开转存框，磁力和下载链接交给云下载。"
        />
      )}

      {/* 地址里有词、还没开始搜（设置刚读回来，effect 还没跑）也当加载中：不然先闪一下「搜点什么」 */}
      {!notConfigured && rs.status === "idle" && !q && (
        <EmptyState
          icon={Telescope}
          title="搜点什么"
          description="按片名、剧名搜，结果按网盘分开放。PanSou 边搜边补，头几秒之后结果还会再多一些。"
        />
      )}

      {!notConfigured && rs.status === "error" && (
        <EmptyState
          icon={SearchX}
          title="搜索失败"
          description={rs.error}
          action={
            <Button variant="outline" onClick={() => search(rs.keyword, { titleEn })}>
              <RefreshCw />
              重试
            </Button>
          }
        />
      )}

      {!notConfigured && (rs.status === "loading" || (rs.status === "idle" && q && !qProblem)) && <CardListSkeleton />}

      {!notConfigured && result && (rs.status === "refining" || rs.status === "done") && (
        <>
          {rs.pending && (
            <button
              type="button"
              onClick={rs.applyPending}
              className="sticky top-16 z-10 mx-auto flex items-center gap-1.5 rounded-full border border-brand/30 bg-card px-3 py-1 text-xs text-brand shadow-sm hover:bg-accent"
            >
              <RefreshCw className="size-3.5" />
              又找到 {rs.pending.items.length - total} 条 · 更新列表
            </button>
          )}

          {total === 0 ? (
            rs.status === "refining" ? (
              <EmptyState icon={Telescope} title="暂时没搜到，还在补充结果" description={`PanSou 还在搜（第 ${rs.round}/${TOTAL_ROUNDS} 轮）`} />
            ) : result.blocked ? (
              <EmptyState
                icon={SearchX}
                title={`搜到的 ${result.blocked} 条都被屏蔽词藏掉了`}
                description="屏蔽词在设置页「资源搜索」一节，删掉几个或者换个说法再搜。"
                action={
                  <Button variant="outline" asChild>
                    <Link href="/settings#pansou">
                      <SettingsIcon />
                      去看屏蔽词
                    </Link>
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={SearchX}
                title={`没搜到「${rs.keyword}」`}
                description="换个说法试试：去掉年份和画质词，用别名或英文名。也可能是 PanSou 那边没配频道和插件。"
              />
            )
          ) : (
            <div ref={listRef} className="overflow-hidden rounded-xl border bg-card">
              {/* tab 独占一行（横向滑），状态和操作在下一行；xl 起才并排：右边那组控件（屏蔽词、全选、补充状态、隐藏已失效）
                  不窄，带侧栏时 1024 上并排就会把 tab 挤得看不全，手机上更是挤成 0 宽 */}
              <div className="flex flex-col gap-2 border-b px-4 py-2 xl:flex-row xl:items-center xl:gap-3">
                <div
                  role="tablist"
                  aria-label="网盘类型"
                  onKeyDown={onTabKey}
                  // 类型最多五个，多数屏幕放得下；放不下时横着滑，滚动条藏起来（常显滚动条的系统上那一道很碍眼）
                  className="-mx-1 flex min-w-0 gap-1 overflow-x-auto px-1 [scrollbar-width:none] xl:flex-1 [&::-webkit-scrollbar]:hidden"
                >
                  {tabs.map((k) => (
                    <button
                      key={k}
                      id={`search-tab-${k}`}
                      type="button"
                      role="tab"
                      aria-selected={k === active}
                      aria-controls="search-tabpanel"
                      tabIndex={k === active ? 0 : -1}
                      onClick={() => chooseTab(k)}
                      className={cn(
                        "shrink-0 rounded-md px-2.5 py-1 text-sm transition-colors",
                        k === active ? "bg-brand/10 font-medium text-brand" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      )}
                    >
                      {KIND_LABEL[k]}
                      <span className="ml-1 text-xs tabular-nums opacity-70">{result.counts[k]}</span>
                    </button>
                  ))}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {result.blocked ? (
                    <Link href="/settings#pansou" className="hover:text-foreground" title="设置页「资源搜索」里的屏蔽词">
                      屏蔽词藏了 {result.blocked} 条
                    </Link>
                  ) : null}
                  {pickableItems.length > 0 && (
                    <label className="flex cursor-pointer items-center gap-1.5">
                      <Checkbox checked={allPicked} onCheckedChange={(v) => pickAll(v === true)} />
                      全选
                    </label>
                  )}
                  {searching ? (
                    <span className="flex items-center gap-1.5" aria-live="polite">
                      <Loader2 className="size-3.5 animate-spin" />
                      还在补充结果（第 {rs.round}/{TOTAL_ROUNDS} 轮）
                    </span>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={rs.fetchMore}
                      title="PanSou 的插件在后台还可能补到新的：再问一次（走缓存，很快）"
                    >
                      <RefreshCw className="size-3.5" />
                      再取一次
                    </Button>
                  )}
                  {((config.checkLinks && !linkCheck.stopped) || deadCount > 0) && (active === "115" || active === "quark") && (
                    <label className="flex cursor-pointer items-center gap-1.5">
                      <Checkbox checked={hideDead} onCheckedChange={(v) => setHideDead(v === true)} />
                      隐藏已失效{deadCount > 0 ? `（${deadCount}）` : ""}
                    </label>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="size-7" aria-label="更多">
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem disabled={searching} onSelect={() => search(rs.keyword, { refresh: true, titleEn })}>
                        <RefreshCw />
                        不用缓存重搜
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              <TagFilterBar
                hits={tabHits}
                selected={activeFilter}
                year={year}
                onToggle={toggleTag}
                onClear={() => {
                  setTagFilter(EMPTY_SET);
                  setShown(PAGE_SIZE);
                }}
              />

              <div role="tabpanel" id="search-tabpanel" aria-labelledby={active ? `search-tab-${active}` : undefined} className="divide-y">
                {items.slice(0, shown).map((hit) => (
                  <ResultRow
                    key={hit.key}
                    hit={hit}
                    keyword={year ? `${rs.keyword} ${year}` : rs.keyword}
                    activeTags={activeFilter}
                    pickable={(hit.kind === "magnet" || hit.kind === "ed2k") && hit.action === "offline"}
                    picked={picked.has(hit.key)}
                    onPickChange={pickOne}
                    state={linkCheck.states.get(hit.key)}
                    checkable={config.checkLinks && !linkCheck.stopped && (hit.kind === "115" || hit.kind === "quark")}
                    observe={linkCheck.observe}
                    offlineAccounts={offlineAccounts ?? NO_ACCOUNTS}
                    opening={openingKey === hit.key && share.loading}
                    onShare={openShare}
                    onOffline={openOffline}
                  />
                ))}
                {items.length === 0 &&
                  (activeFilter.size > 0 ? (
                    <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                      这一类里没有同时符合这几个筛选的。
                      <button type="button" className="ml-1 text-brand hover:underline" onClick={() => setTagFilter(EMPTY_SET)}>
                        清除筛选
                      </button>
                    </div>
                  ) : (
                    <p className="px-4 py-8 text-center text-sm text-muted-foreground">这一类的都失效了，取消「隐藏已失效」能看到它们</p>
                  ))}
              </div>
              {items.length > shown && (
                <div className="border-t p-2 text-center">
                  <Button variant="ghost" size="sm" onClick={() => setShown((n) => n + PAGE_SIZE)}>
                    显示更多（还有 {items.length - shown} 条）
                  </Button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* 勾了磁力 / 电驴：底部浮一条，滚到哪都点得到 */}
      {picked.size > 0 && (
        // 外面这一整条是透明的：pointer-events-none，别挡住它两边的按钮
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-30 flex justify-center px-4">
          <div className="pointer-events-auto flex items-center gap-2 rounded-full border bg-card py-1.5 pr-1.5 pl-4 text-sm shadow-lg">
            <span className={cn("tabular-nums", tooManyPicked && "text-destructive")}>
              已选 {picked.size} 条{tooManyPicked ? `（一次最多 ${OFFLINE_ADD_MAX} 条）` : ""}
            </span>
            <Button size="sm" className="h-8 rounded-full" onClick={offlinePicked} disabled={tooManyPicked}>
              <CloudDownload />
              云下载所选
            </Button>
            <Button size="sm" variant="ghost" className="h-8 rounded-full" onClick={() => setPicked(new Map())}>
              清空
            </Button>
          </div>
        </div>
      )}

      <ShareDetailDialog {...share.dialogProps} />
      <AddOfflineTaskDialog
        open={offline.open}
        onOpenChange={(open) => setOffline((o) => ({ ...o, open }))}
        account={offline.account}
        accounts={offlineAccounts ?? NO_ACCOUNTS}
        initialUrls={offline.urls}
        onAdded={(added) => {
          if (!offline.picked) return;
          const done = new Set(added);
          setPicked((prev) => new Map([...prev].filter(([, url]) => !done.has(url))));
        }}
      />
    </div>
  );
}
