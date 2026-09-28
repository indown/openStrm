/**
 * 抄目录：把收藏的分享（或其中一个目录）的目录树抄进 library_nodes，建搜索索引。
 *
 *   - 宽度优先：每次取本轮还没列过的目录里最浅的一个。浅层（分类、作品目录名）几秒就能搜，文件名在后台慢慢补
 *   - 让路：一次只抄一个来源、一次只发一个请求；发之前看账号的每秒配额上有没有别人在排队，有就先等（最多几秒，免得饿死）
 *   - 可续：进度都在库里（本轮 listed_gen 还小的目录就是待抄），重启后接着抄
 *   - 刷新：轮次（gen）加一重抄，旧节点照常能搜，抄完删掉轮次更小的（分享里删掉的就没了）
 *   - 出错：网络 / 超时同一个目录退避重试，还不行整个来源暂停一会儿再续；账号失效暂停一小时；
 *     分享本身打不开交给分享死活（health.ts）判，判成失效 / 提取码不对就停，疑似失效等复查；
 *     子目录打不开先暂停半分钟，health 那边复核完（真没了会标 missing）再续
 */
import type { LibraryShareHealth, MediaLibraryEntry } from "@openstrm/shared";
import * as sources from "../../db/repositories/media-library.js";
import * as nodes from "../../db/repositories/library-nodes.js";
import { getShare } from "../../db/repositories/library-shares.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { readKv, writeKv } from "../../db/repositories/life.js";
import { KEY } from "../../db/keys.js";
import { isAbortError, messageOf } from "../../lib/errors.js";
import { moduleLogger } from "../../lib/logger.js";
import { accountIssueOf } from "../drive/errors.js";
import { KIND_LABEL, parseShareRef, shareProviderForRef } from "../drive/registry.js";
import { listWholeShareDir } from "../drive/share-walk.js";
import { ShareGoneError, type DriveProvider, type ShareEntry, type ShareRef } from "../drive/types.js";
import { accountBusy } from "../download/rate-limited.js";
import { enqueueOne as enqueueScrape } from "./scrape-worker.js";
import { SEARCH_TEXT_VERSION, dirSearchText, isVideoName } from "./search-text.js";

const log = moduleLogger("library-index");

/** 单个来源的上限：超了停下标 truncated */
export const INDEX_LIMITS = { MAX_DIRS: 50_000, MAX_NODES: 200_000 };
const PROGRESS_EVERY = 10;
/** 轮流抄：一个来源一次最多列这么多个目录，有别的来源在等就让出来（大包不把后加的小分享堵上二十分钟） */
export const INDEX_SLICE = { DIRS: 40 };
const PAUSE_TRANSIENT_S = 10 * 60;
const PAUSE_ACCOUNT_S = 60 * 60;
/** 子目录打不开：等 health 复核完再续 */
const PAUSE_DIR_S = 30;
/** 疑似失效时，health 没给复查时间就按这个 */
const PAUSE_SUSPECT_S = 30 * 60;

/* ------------------------------- 依赖（测试换掉） ------------------------------- */

interface Deps {
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  busy: (account: string) => boolean;
  /** 同一目录网络出错时的重试间隔 */
  retryDelaysMs: number[];
  /** 两次列目录之间的间隔 */
  gapMs: number;
  /** 让路最多等多久 */
  yieldMaxMs: number;
}

const realSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

const realDeps: Deps = {
  now: () => Math.floor(Date.now() / 1000),
  sleep: realSleep,
  busy: accountBusy,
  retryDelaysMs: [2000, 10_000, 30_000],
  gapMs: 200,
  yieldMaxMs: 5000,
};
let deps: Deps = { ...realDeps };

export function setIndexerDeps(partial: Partial<Deps> | null): void {
  deps = partial ? { ...deps, ...partial } : { ...realDeps };
}

/* ------------------------------- 错误分类 ------------------------------- */

/** 暂停一会儿再续（状态留在 indexing，到 retry 时间接着这一轮） */
class PauseError extends Error {
  constructor(
    message: string,
    readonly retryAfterS: number,
  ) {
    super(message);
    this.name = "PauseError";
  }
}

/** 这一轮抄够了、有别的来源在等：让出来，状态不变，下次轮到接着抄 */
class YieldSignal extends Error {
  constructor() {
    super("轮到别的来源");
    this.name = "YieldSignal";
  }
}

/** 停下，要人处理（状态 failed） */
class StopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StopError";
  }
}

/** 网络、超时这类：退避重试；账号问题直接暂停；分享打不开、取消原样抛 */
async function attempt<T>(provider: DriveProvider, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (signal.aborted || isAbortError(err) || err instanceof ShareGoneError) throw err;
      const issue = accountIssueOf(provider, err);
      if (issue === "auth") throw new PauseError(`账号「${provider.account.name}」登录失效了：到「账户」页更新 cookie 后会接着抄`, PAUSE_ACCOUNT_S);
      if (issue === "blocked") throw new PauseError(`账号「${provider.account.name}」被网盘风控了，过一会儿再接着抄`, PAUSE_ACCOUNT_S);
      if (i >= deps.retryDelaysMs.length) throw new PauseError(`网盘暂时连不上（${messageOf(err).slice(0, 120)}），过一会儿接着抄`, PAUSE_TRANSIENT_S);
      await deps.sleep(deps.retryDelaysMs[i], signal);
    }
  }
}

/** 发请求前让一让：账号配额上有别人在排队就先等 */
async function politeWait(account: string, signal: AbortSignal): Promise<void> {
  const start = Date.now();
  while (deps.busy(account) && Date.now() - start < deps.yieldMaxMs) await deps.sleep(250, signal);
}

/* ------------------------------- 抄一个来源 ------------------------------- */

function refOf(source: MediaLibraryEntry): ShareRef | null {
  const parsed = parseShareRef(source.shareUrl);
  if (!parsed) return null;
  return { kind: parsed.kind, code: source.shareCode, password: source.receiveCode, url: source.shareUrl || parsed.url };
}

/** 整个分享的来源：根用 "0" */
export function isWholeShare(source: Pick<MediaLibraryEntry, "shareRootCid" | "sharePath">): boolean {
  return (!source.shareRootCid || source.shareRootCid === "0") && !source.sharePath.replace(/^\/+/, "");
}

/** 名字里带 / 的（少见）落进路径时换成全角，别凭空多出一段 */
const segOf = (name: string) => name.replace(/\//g, "／");

async function crawl(source: MediaLibraryEntry, signal: AbortSignal): Promise<void> {
  const id = source.id;
  const ref = refOf(source);
  if (!ref) throw new StopError("认不出这个分享链接");
  const provider = shareProviderForRef(ref);
  if (!provider?.share) throw new PauseError(`没有能打开${KIND_LABEL[ref.kind]}分享的账号：先到「账户」页加一个`, PAUSE_ACCOUNT_S);
  const share = provider.share;

  const state = sources.getIndexGen(id);
  if (!state) return;
  const fresh = state.status === "pending";
  const gen = fresh ? state.gen + 1 : Math.max(state.gen, 1);
  const now = deps.now();
  sources.setIndexState(id, {
    indexStatus: "indexing",
    indexGen: gen,
    indexError: "",
    indexRetryAt: null,
    ...(fresh ? { indexStartedAt: now, dirsTotal: 0, dirsListed: 0, truncated: false } : {}),
  });

  const session = await attempt(provider, signal, () => share.open(ref, signal));
  const info = await attempt(provider, signal, () => share.info(session, signal));
  const shareTitle = info.title?.trim() || source.shareTitle;
  if (shareTitle && shareTitle !== source.shareTitle) sources.setIndexState(id, { shareTitle });

  const whole = isWholeShare(source);
  const rootId = whole ? "0" : source.shareRootCid;
  const rootPath = whole ? "" : source.sharePath.replace(/^\/+|\/+$/g, "") || segOf(source.rawName);
  const rootName = whole ? shareTitle || source.title || source.shareCode : source.rawName || rootPath.split("/").pop() || rootPath;
  // 根目录的 search_text 带上分享标题：搜「老K」能搜到这个来源
  const rootSegs = whole ? [rootName] : rootPath.split("/");
  if (fresh || !nodes.getNode(id, rootId)) {
    nodes.upsertNodes(id, gen, [{ nodeId: rootId, parentId: "", name: rootName, path: rootPath, isDir: true, depth: 0, size: null, token: null, searchText: dirSearchText(rootSegs) }]);
  }

  let sinceProgress = 0;
  let listedThisTurn = 0;
  let truncated = false;
  for (;;) {
    if (signal.aborted) return;
    const dir = nodes.nextUnlistedDir(id, gen);
    if (!dir) break;
    // 抄够一轮、又有别的来源在等：让出来（进度都在库里，下次接着来）
    if (listedThisTurn >= INDEX_SLICE.DIRS && sources.dueToIndex(deps.now()).some((s) => s.id !== id)) {
      const p = nodes.crawlProgress(id, gen);
      sources.setIndexState(id, { dirsTotal: p.dirsTotal, dirsListed: p.dirsListed });
      throw new YieldSignal();
    }
    if (sinceProgress === 0) {
      const p = nodes.crawlProgress(id, gen);
      sources.setIndexState(id, { dirsTotal: p.dirsTotal, dirsListed: p.dirsListed });
      if (p.dirsTotal > INDEX_LIMITS.MAX_DIRS || p.nodes > INDEX_LIMITS.MAX_NODES) {
        truncated = true;
        break;
      }
    }
    await politeWait(provider.account.name, signal);
    let entries: ShareEntry[];
    try {
      entries = await attempt(provider, signal, () => listWholeShareDir(share, session, dir.nodeId, signal));
    } catch (err) {
      // 子目录打不开：health 在复核（真没了会标 missing），先歇一会儿；来源根（子目录来源）打不开也一样
      if (err instanceof ShareGoneError && dir.nodeId !== "0") throw new PauseError("有个目录暂时打不开，确认一下再接着抄", PAUSE_DIR_S);
      throw err;
    }
    const children: nodes.NodeInput[] = entries.map((e) => {
      const path = dir.path ? `${dir.path}/${segOf(e.name)}` : segOf(e.name);
      return {
        nodeId: e.id,
        parentId: dir.nodeId,
        name: e.name,
        path,
        isDir: e.isDir,
        depth: dir.depth + 1,
        size: e.isDir ? null : (e.size ?? null),
        token: e.token ?? null,
        searchText: e.isDir ? dirSearchText(path.split("/")) : "",
      };
    });
    nodes.upsertNodes(id, gen, children);
    const files = entries.filter((e) => !e.isDir);
    const segs = dir.depth === 0 ? rootSegs : dir.path.split("/");
    const directSize = files.reduce((sum, f) => sum + (f.size ?? 0), 0);
    nodes.markListed(id, dir.nodeId, gen, dirSearchText(segs, files.map((f) => f.name)), files.filter((f) => isVideoName(f.name)).length, directSize);
    sinceProgress = (sinceProgress + 1) % PROGRESS_EVERY;
    listedThisTurn++;
    if (deps.gapMs > 0) await deps.sleep(deps.gapMs, signal);
  }
  if (signal.aborted) return;

  const root = nodes.getNode(id, rootId);
  if (!root || root.missing) {
    throw new StopError("收藏的目录在分享里找不到了（可能被挪走或删掉了）：用「更新链接」换个新链接，或者移除");
  }
  // 没抄完（超上限）的不删旧节点：宁可留着上一轮的
  if (!truncated) nodes.deleteStale(id, gen);
  const stats = nodes.finalizeSizes(id, isVideoName);
  const p = nodes.crawlProgress(id, gen);
  sources.setIndexState(id, {
    indexStatus: "done",
    indexError: truncated ? `超过单个来源的上限（${INDEX_LIMITS.MAX_DIRS} 个目录 / ${INDEX_LIMITS.MAX_NODES} 个条目），只抄了一部分` : "",
    indexedAt: deps.now(),
    indexRetryAt: null,
    dirsTotal: p.dirsTotal,
    dirsListed: p.dirsListed,
    nodeCount: stats.nodeCount,
    videoCount: stats.videoCount,
    totalSize: stats.totalSize,
    truncated,
  });
  log.info({ id, share: ref.code, dirs: p.dirsTotal, nodes: stats.nodeCount }, "影库来源抄完了");
  maybeScrape(id);
}

/**
 * 看起来是一部作品（直接放着视频的目录最多一个）、没封面、配了 TMDB 的才去刮海报；
 * 整包（「老K」这种几百部）不刮，免得配上一张不相干的海报。第二阶段换成按作品识别
 */
function maybeScrape(id: string): void {
  const source = sources.getById(id);
  if (!source || source.coverUrl || source.scrapeStatus === "pending") return;
  if (!readAppSettings().tmdb?.apiKey?.trim()) return;
  if (nodes.countVideoDirs(id) > 1) return;
  sources.setScrapeStatus(id, "pending");
  enqueueScrape(id);
}

/* ------------------------------- 工人 ------------------------------- */

let started = false;
let looping = false;
/** 轮流抄：每个来源上次轮到的序号 */
const lastTurn = new Map<string, number>();
let turnSeq = 0;
/** 没进展就立刻回来的次数（防空转） */
const idleSpins = new Map<string, number>();
let again = false;
let wake: NodeJS.Timeout | null = null;
let current: { id: string; ac: AbortController } | null = null;
let idleWaiters: Array<() => void> = [];

/** 停下时按库里的实际情况记一次进度：「暂停（已抄 x/y）」别停在上一次整批写的数 */
function flushProgress(id: string): void {
  const state = sources.getIndexGen(id);
  if (!state) return;
  const p = nodes.crawlProgress(id, state.gen);
  sources.setIndexState(id, { dirsTotal: p.dirsTotal, dirsListed: p.dirsListed });
}

async function runOne(source: MediaLibraryEntry): Promise<void> {
  const ac = new AbortController();
  current = { id: source.id, ac };
  try {
    await crawl(source, ac.signal);
  } catch (err) {
    if (ac.signal.aborted || isAbortError(err) || err instanceof YieldSignal) return;
    flushProgress(source.id);
    const now = deps.now();
    if (err instanceof PauseError) {
      sources.setIndexState(source.id, { indexStatus: "indexing", indexError: err.message, indexRetryAt: now + err.retryAfterS });
      log.info({ id: source.id, err: err.message }, "影库抄目录暂停");
      return;
    }
    if (err instanceof StopError) {
      sources.setIndexState(source.id, { indexStatus: "failed", indexError: err.message, indexRetryAt: null });
      return;
    }
    if (err instanceof ShareGoneError) {
      // 分享本身打不开：health 已经记了，看它判成什么
      const h = getShare(source.shareCode);
      if (h?.status === "expired") sources.setIndexState(source.id, { indexStatus: "failed", indexError: `${SHARE_EXPIRED_ERROR}：${h.reason}`, indexRetryAt: null });
      else if (h?.status === "locked") sources.setIndexState(source.id, { indexStatus: "failed", indexError: SHARE_LOCKED_ERROR, indexRetryAt: null });
      else {
        const retry = h?.nextCheckAt ?? now + PAUSE_SUSPECT_S;
        sources.setIndexState(source.id, { indexStatus: "indexing", indexError: "分享暂时打不开（可能已失效），等复查后接着抄", indexRetryAt: Math.max(retry, now + 60) });
      }
      return;
    }
    log.error({ err, id: source.id }, "影库抄目录出错");
    sources.setIndexState(source.id, { indexStatus: "failed", indexError: `抄目录出错：${messageOf(err).slice(0, 200)}`, indexRetryAt: null });
  } finally {
    current = null;
  }
}

async function loop(): Promise<void> {
  if (looping) {
    again = true;
    return;
  }
  looping = true;
  try {
    for (;;) {
      // 停了（进程要退出）：手上这个已经中止，别再接下一个
      if (!started) break;
      const due = sources.dueToIndex(deps.now());
      if (due.length === 0) break;
      // 轮流：挑最久没轮到的（从没轮到过的最先，同样的按先来后到）
      const next = due.reduce((best, s) => ((lastTurn.get(s.id) ?? 0) < (lastTurn.get(best.id) ?? 0) ? s : best));
      lastTurn.set(next.id, ++turnSeq);
      const listedBefore = next.dirsListed;
      await runOne(next);
      // 跑完这一趟，它还是「该抄」、目录却一个没多（让出来的一趟至少列了一轮，正常不会这样）：连着几次就歇一分钟，防空转
      const stillDue = sources.dueToIndex(deps.now()).find((s) => s.id === next.id);
      if (stillDue && stillDue.dirsListed === listedBefore) {
        const spins = (idleSpins.get(next.id) ?? 0) + 1;
        idleSpins.set(next.id, spins);
        if (spins > 3) {
          idleSpins.delete(next.id);
          sources.setIndexState(next.id, { indexRetryAt: deps.now() + 60 });
        }
      } else idleSpins.delete(next.id);
    }
  } finally {
    looping = false;
    if (again) {
      again = false;
      void loop();
    } else {
      scheduleWake();
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const w of waiters) w();
    }
  }
}

function scheduleWake(): void {
  if (wake) clearTimeout(wake);
  wake = null;
  if (!started) return;
  const at = sources.nextIndexRetryAt();
  if (at == null) return;
  const ms = Math.max(1000, at * 1000 - Date.now());
  wake = setTimeout(() => {
    wake = null;
    void loop();
  }, Math.min(ms, 2 ** 31 - 1));
  wake.unref?.();
}

/** 有新活（加入、刷新、改提取码）：叫醒工人 */
export function kickIndexer(): void {
  if (!started) return;
  void loop();
}

/** 启动时调：接着抄没抄完的 */
/**
 * 搜索文本的规则变了（SEARCH_TEXT_VERSION）：按库里已有的目录树就地重算，抄完的顺带回填子树统计，不用重抄网盘。
 * 在工人开工之前同步做（几万个目录一两秒），免得和抄目录抢着写
 */
export function rebuildSearchTextIfStale(): void {
  if (readKv<number>(KEY.librarySearchTextVersion) === SEARCH_TEXT_VERSION) return;
  let dirs = 0;
  for (const s of sources.getAll()) {
    dirs += nodes.rebuildSearchTexts(s.id, dirSearchText);
    if (s.indexStatus === "done") nodes.finalizeSizes(s.id, isVideoName);
  }
  writeKv(KEY.librarySearchTextVersion, SEARCH_TEXT_VERSION);
  if (dirs > 0) log.info({ dirs, version: SEARCH_TEXT_VERSION }, "影库搜索规则更新了，按已有的目录树重算了搜索文本");
}

export function startIndexer(): void {
  rebuildSearchTextIfStale();
  started = true;
  void loop();
}

export function stopIndexer(): void {
  started = false;
  current?.ac.abort();
  if (wake) clearTimeout(wake);
  wake = null;
}

/** 排队（重新）抄一个来源：下次开抄时轮次加一 */
export function enqueueIndex(id: string): void {
  if (current?.id === id) current.ac.abort();
  sources.setIndexState(id, { indexStatus: "pending", indexError: "", indexRetryAt: null });
  kickIndexer();
}

/** 来源要删 / 换链接：正在抄就停下 */
export function stopIndexing(id: string): void {
  if (current?.id === id) current.ac.abort();
}

/** 因为分享本身停下的来源（indexError 以它们开头）：分享又能打开了就接着抄 */
export const SHARE_EXPIRED_ERROR = "分享已失效";
export const SHARE_LOCKED_ERROR = "提取码不对：改好提取码后会重新抄";

function stoppedByShare(s: MediaLibraryEntry): boolean {
  return s.indexStatus === "failed" && (s.indexError.startsWith(SHARE_EXPIRED_ERROR) || s.indexError === SHARE_LOCKED_ERROR);
}

/**
 * health 报分享状态变了：失效 / 提取码不对的停下；恢复了（谁用到分享发现能打开都算）的马上续——
 * 暂停着的清掉等待，因为分享停下的接着那一轮抄（一个目录没抄过的从头来）。已经抄完的不用动
 */
export function onShareStatusChange(shareCode: string, status: LibraryShareHealth["status"]): void {
  for (const s of sources.listByShareCode(shareCode)) {
    if (status === "expired" || status === "locked") {
      if (s.indexStatus !== "pending" && s.indexStatus !== "indexing") continue;
      stopIndexing(s.id);
      sources.setIndexState(s.id, {
        indexStatus: "failed",
        indexError: status === "expired" ? SHARE_EXPIRED_ERROR : SHARE_LOCKED_ERROR,
        indexRetryAt: null,
      });
    } else if (status === "ok" && s.indexStatus === "indexing") {
      sources.setIndexState(s.id, { indexRetryAt: null });
    } else if (status === "ok" && stoppedByShare(s)) {
      sources.setIndexState(s.id, { indexStatus: s.dirsListed > 0 ? "indexing" : "pending", indexError: "", indexRetryAt: null });
    }
  }
  if (status === "ok") kickIndexer();
}

export function currentIndexing(): string | null {
  return current?.id ?? null;
}

/** 仅供测试：等工人闲下来 */
export function __test_whenIdle(): Promise<void> {
  if (!looping) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}
