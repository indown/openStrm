/**
 * 影库里的分享死活（按分享码）。
 *
 * 信号从哪来：drive/registry 的分享旁听者——弹框、转存、智能体、Telegram、追更、抄目录、巡检，谁用到分享谁顺带报。
 * 只记影库里有的分享码。
 *
 * 怎么判：
 *   - 只有「分享本身」上的失败算（打开、看信息、列根目录）；列子目录失败先复核：根好、那个目录再列一次还是不行，
 *     才是那个目录没了（标 missing、让上一级重抄），不牵连整个分享。115 把大部分分享接口报错都当成「分享没了」，
 *     子目录不存在也可能这样报，一次就判整包死误伤太大
 *   - 提取码问题 → locked；根上明确说取消 / 过期 / 不存在 → expired；其余含糊的 → suspect，隔 30 分钟、3 小时复查，
 *     连续 3 次 → expired（同追更的 EXPIRE_STREAK）；任何一次成功 → ok
 *   - 网络、账号（cookie 失效、风控）这类不是分享的问题：不记
 *
 * 巡检：每 10 分钟一轮，到点的疑似失效复查；设置开着时，超过 24 小时没查过的逐个查一次（每个分享一次请求）。
 * 巡检确认失效的推一条 Telegram；正在用的时候发现的由界面 / 工具结果当场说。
 */
import type { LibraryShareHealth } from "@openstrm/shared";
import { getAll, healthOf, listByShareCode, setIndexState } from "../../db/repositories/media-library.js";
import { findNode, markMissing, markUnlisted } from "../../db/repositories/library-nodes.js";
import { ensureShare, getShare, listDueChecks, listShares, updateShare, deleteShareIfUnused } from "../../db/repositories/library-shares.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { messageOf } from "../../lib/errors.js";
import { moduleLogger } from "../../lib/logger.js";
import { SHARE_PASSWORD_PROBLEM } from "../drive/errors.js";
import { setShareObserver, shareProviderForRef, parseShareRef } from "../drive/registry.js";
import { ShareGoneError, type ShareRef } from "../drive/types.js";
import { notify } from "../telegram/notify.js";
import { onShareStatusChange } from "./indexer.js";

const log = moduleLogger("library-health");

/** 已经是 ok 的，多久才再写一次库（抄目录一秒一次成功，别每次都写） */
const OK_WRITE_INTERVAL_S = 10 * 60;
/** 疑似失效第 n 次之后多久复查 */
const RECHECK_AFTER_S = [30 * 60, 3 * 3600];
export const EXPIRE_STREAK = 3;
/** 巡检：多久没查过的要查 */
const PATROL_AGE_S = 24 * 3600;
const TICK_MS = 10 * 60 * 1000;
/** 根上说了这些才直接判失效：取消 / 过期 / 失效 / 删除 / 不存在 / 违规封禁 */
const DEFINITIVE = /取消|过期|失效|删除|不存在|违规|封禁|屏蔽|cancel|expire|not[\s_-]*exist|deleted|forbid/i;
const REASON_MAX = 200;

/* ------------------------------- 依赖（测试换掉） ------------------------------- */

export type LibraryHealthEvent = { type: "library-expired"; shareCode: string; shareTitle: string; sources: number };

interface Deps {
  now: () => number;
  notify: (e: LibraryHealthEvent) => Promise<void>;
  /** 分享确认失效 / 恢复时，让抄目录的工人停下 / 接着抄 */
  onShareStatus: (shareCode: string, status: LibraryShareHealth["status"]) => void;
  /** 子目录复核前等多久（真机上给网盘一点喘息，测试里是 0） */
  verifyDelayMs: number;
}

const realDeps: Deps = {
  now: () => Math.floor(Date.now() / 1000),
  notify: async (e) => {
    await notify(e);
  },
  onShareStatus: onShareStatusChange,
  verifyDelayMs: 3000,
};
let deps: Deps = { ...realDeps };

export function setLibraryHealthDeps(partial: Partial<Deps> | null): void {
  deps = partial ? { ...deps, ...partial } : { ...realDeps };
}

/* ------------------------------- 影库里有哪些分享码 ------------------------------- */

let codes: Set<string> | null = null;

function knownCodes(): Set<string> {
  if (!codes) codes = new Set(listShares().map((r) => r.shareCode));
  return codes;
}

/** 加来源时登记分享码 */
export function trackShare(shareCode: string, kind: string): void {
  ensureShare(shareCode, kind);
  knownCodes().add(shareCode);
}

/** 删来源后：没来源了就不再记这个分享 */
export function untrackShareIfUnused(shareCode: string): void {
  deleteShareIfUnused(shareCode);
  if (!getShare(shareCode)) knownCodes().delete(shareCode);
}

/* ------------------------------- 记录 ------------------------------- */

/** 巡检正在查的分享码：确认失效时要不要推通知 */
const patrolling = new Set<string>();

function recordOk(code: string): void {
  const now = deps.now();
  const row = getShare(code);
  if (!row) return;
  if (row.status === "ok" && row.checkedAt != null && now - row.checkedAt < OK_WRITE_INTERVAL_S) return;
  updateShare(code, { status: "ok", reason: "", failStreak: 0, checkedAt: now, lastOkAt: now, nextCheckAt: null, expiredAt: null });
  if (row.status !== "ok") {
    log.info({ code, from: row.status }, "影库里的分享又能打开了");
    deps.onShareStatus(code, "ok");
  }
}

function expire(code: string, reason: string, streak: number): void {
  const now = deps.now();
  const row = getShare(code);
  if (!row || row.status === "expired") return;
  updateShare(code, { status: "expired", reason, failStreak: streak, checkedAt: now, expiredAt: now, nextCheckAt: null });
  log.warn({ code, reason }, "影库里的分享已失效");
  deps.onShareStatus(code, "expired");
  if (patrolling.has(code)) {
    const sources = listByShareCode(code);
    const title = sources.find((s) => s.shareTitle)?.shareTitle || sources[0]?.title || code;
    void deps.notify({ type: "library-expired", shareCode: code, shareTitle: title, sources: sources.length }).catch(() => {});
  }
}

function recordRootFailure(code: string, err: ShareGoneError): void {
  const now = deps.now();
  const row = getShare(code);
  if (!row) return;
  const reason = messageOf(err).slice(0, REASON_MAX);
  if (SHARE_PASSWORD_PROBLEM.test(reason)) {
    if (row.status !== "locked") deps.onShareStatus(code, "locked");
    updateShare(code, { status: "locked", reason, failStreak: 0, checkedAt: now, nextCheckAt: null });
    return;
  }
  if (row.status === "expired") {
    updateShare(code, { checkedAt: now, reason });
    return;
  }
  const streak = row.failStreak + 1;
  if (DEFINITIVE.test(reason) || streak >= EXPIRE_STREAK) {
    expire(code, reason, streak);
    return;
  }
  const wait = RECHECK_AFTER_S[Math.min(streak - 1, RECHECK_AFTER_S.length - 1)];
  updateShare(code, { status: "suspect", reason, failStreak: streak, checkedAt: now, nextCheckAt: now + wait });
  if (row.status !== "suspect") deps.onShareStatus(code, "suspect");
}

/** 子目录打不开：根好、再列一次还是不行，才标这个目录没了 */
const verifying = new Set<string>();

function verifyDir(ref: ShareRef, dirId: string): void {
  const key = `${ref.code}/${dirId}`;
  if (verifying.has(key)) return;
  verifying.add(key);
  const run = async () => {
    const provider = shareProviderForRef(ref);
    if (!provider?.share) return;
    const share = provider.share;
    let session;
    try {
      session = await share.open(ref);
      await share.info(session);
    } catch {
      // 根也打不开：旁听者已经按分享失败记过了
      return;
    }
    try {
      await share.list(session, dirId, undefined, { limit: 1 });
    } catch (err) {
      if (!(err instanceof ShareGoneError)) return;
      for (const node of findNode(ref.code, dirId)) {
        markMissing(node.sourceId, node);
        if (node.parentId) markUnlisted(node.sourceId, node.parentId);
        // 上一级要重列：来源已经抄完的，挪回「在抄」接着这一轮
        setIndexState(node.sourceId, { indexStatus: "indexing", indexRetryAt: null });
        log.info({ code: ref.code, path: node.path }, "分享还在，这个目录打不开了：标成 missing，重抄上一级");
      }
      deps.onShareStatus(ref.code, "ok");
    }
  };
  setTimeout(() => {
    void run()
      .catch((err: unknown) => log.warn({ err, code: ref.code, dirId }, "复核子目录出错"))
      .finally(() => verifying.delete(key));
  }, deps.verifyDelayMs).unref?.();
}

/** 装到 drive/registry 上的旁听者 */
const observer = {
  // 列得动子目录也说明分享在
  ok(ref: ShareRef) {
    if (knownCodes().has(ref.code)) recordOk(ref.code);
  },
  fail(ref: ShareRef, err: unknown, at: "root" | "dir", dirId: string) {
    if (!knownCodes().has(ref.code) || !(err instanceof ShareGoneError)) return;
    if (at === "root") recordRootFailure(ref.code, err);
    else verifyDir(ref, dirId);
  },
};

/* ------------------------------- 主动查 ------------------------------- */

function refOfCode(code: string): ShareRef | null {
  const source = listByShareCode(code)[0];
  if (!source) return null;
  const parsed = parseShareRef(source.shareUrl);
  if (!parsed) return null;
  return { kind: parsed.kind, code: source.shareCode, password: source.receiveCode, url: source.shareUrl || parsed.url };
}

/** 查一个分享：打开 + 看信息（每个分享一次请求）；结果由旁听者记。没有能打开它的账号就不查 */
export async function checkShare(code: string, opts: { patrol?: boolean } = {}): Promise<LibraryShareHealth> {
  const ref = refOfCode(code);
  const provider = ref ? shareProviderForRef(ref) : null;
  if (ref && provider?.share) {
    if (opts.patrol) patrolling.add(code);
    try {
      const session = await provider.share.open(ref);
      await provider.share.info(session);
    } catch {
      // 旁听者已经记了；网络、账号问题不算分享的错，这次就当没查
    } finally {
      patrolling.delete(code);
    }
  }
  return healthOf(getShare(code));
}

/** 搜索时查：超过 maxAge 没查过的才查，一次最多 max 个，串行 */
export async function checkShares(codes: string[], opts: { maxAgeS?: number; max?: number } = {}): Promise<Record<string, LibraryShareHealth>> {
  const maxAge = opts.maxAgeS ?? 6 * 3600;
  const now = deps.now();
  const out: Record<string, LibraryShareHealth> = {};
  for (const code of [...new Set(codes)].slice(0, opts.max ?? 10)) {
    const row = getShare(code);
    if (!row) continue;
    const fresh = row.checkedAt != null && now - row.checkedAt < maxAge;
    out[code] = fresh || row.status === "expired" ? healthOf(row) : await checkShare(code);
  }
  return out;
}

let patrolRunning = false;

/** 一轮巡检：到点的疑似失效复查；设置开着时再查超过 24 小时没查过的 */
export async function patrolOnce(): Promise<number> {
  if (patrolRunning) return 0;
  patrolRunning = true;
  try {
    const now = deps.now();
    const enabled = readAppSettings().library?.patrol !== false;
    const due = listDueChecks(now, enabled ? now - PATROL_AGE_S : null);
    for (const row of due) await checkShare(row.shareCode, { patrol: true });
    return due.length;
  } finally {
    patrolRunning = false;
  }
}

let timer: NodeJS.Timeout | null = null;

/** 启动时调：装上旁听者，开始巡检。升级上来的老来源还没登记分享码，这里补上 */
export function startLibraryHealth(opts: { patrol?: boolean } = {}): void {
  codes = null;
  for (const s of getAll()) ensureShare(s.shareCode, parseShareRef(s.shareUrl)?.kind ?? "115");
  setShareObserver(observer);
  if (opts.patrol === false || timer) return;
  timer = setInterval(() => {
    void patrolOnce().catch((err: unknown) => log.warn({ err }, "影库巡检出错"));
  }, TICK_MS);
  timer.unref?.();
}

export function stopLibraryHealth(): void {
  setShareObserver(null);
  if (timer) clearInterval(timer);
  timer = null;
  codes = null;
}
