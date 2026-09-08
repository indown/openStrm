/**
 * 115 的变更源：生活事件。
 *
 * 115 会把用户在网盘上的每一次操作记成一条生活事件，倒序拉出来就能感知变动。
 * 事件只带 parent_id 不带路径，所以这里靠 path-resolver（内存 LRU → path_cache 表 → 祖先链接口）把它还原成绝对路径，
 * 移动 / 改名 / 删除的旧路径只能来自 path_cache——缓存也在这里维护：pull 的时候网盘侧的事实已经变了，先改缓存再交出去。
 *
 * proapi ↔ webapi 互为兜底：只有 405 才降级，连续 3 次就固定走 webapi 24 小时；状态按账号各存一份（KEY.lifeAppFallback）。
 */
import type { LifePullMode } from "@openstrm/shared";
import { KEY } from "../../../db/keys.js";
import { dropSubtree, readKv, repathSubtree, writeKv } from "../../../db/repositories/life.js";
import { isAbortError } from "../../../lib/errors.js";
import type { AccountInfo as Cloud115Account } from "../../cloud-115/client.js";
import {
  BEHAVIOR_TYPE_TO_NAME,
  CREATE_TYPES,
  MOVE_TYPES,
  NEW_FOLDER_TYPES,
  REMOVE_TYPES,
  RENAME_TYPES,
  enableLifeCalendar,
  is405,
  pullLifeEvents,
  type LifeApp,
  type LifeCursor,
  type LifeEvent,
  type PullOptions as LifePullOptions,
} from "../../cloud-115/life.js";
import { joinPanPath, lookupCachedPath, rememberPath, resolveDirPath } from "../../cloud-115/path-resolver.js";
import type {
  ChangeCursor,
  ChangeEvent,
  ChangeKind,
  ChangeLog,
  ChangeSource,
  PrepareResult,
  ProbeResult,
  PullOptions,
} from "../../drive/types.js";

const WEB_FALLBACK_MS = 24 * 60 * 60 * 1000;
const ZERO_CURSOR: LifeCursor = { fromTime: 0, fromId: "0" };
const noLog: ChangeLog = () => {};

/* -------------------------------- 依赖注入 -------------------------------- */

interface Deps {
  /** 拉一轮生活事件。真实现打 115 接口，测试换成本地桩 */
  pull: typeof pullLifeEvents;
  /** 开启 115 生活事件开关 */
  enable: typeof enableLifeCalendar;
}
const realDeps: Deps = { pull: pullLifeEvents, enable: enableLifeCalendar };
let deps: Deps = { ...realDeps };
/** 测试用：传 null 恢复真实现 */
export function setCloud115SourceDeps(partial: Partial<Deps> | null): void {
  deps = partial ? { ...realDeps, ...partial } : { ...realDeps };
}

/* ------------------------------ 接口降级状态 ------------------------------ */

interface AppFallbackState {
  ios405Count?: number;
  webFallbackUntil?: number;
}

function readFallback(name: string): AppFallbackState {
  return readKv<AppFallbackState>(KEY.lifeAppFallback(name)) ?? {};
}

export function currentApp(name: string): LifeApp {
  const st = readFallback(name);
  if (st.webFallbackUntil && Date.now() < st.webFallbackUntil) return "web";
  if (st.webFallbackUntil) writeKv(KEY.lifeAppFallback(name), { ...st, webFallbackUntil: undefined });
  return "ios";
}

function recordIos405(name: string, logTo: ChangeLog): void {
  const st = readFallback(name);
  const count = (st.ios405Count ?? 0) + 1;
  if (count >= 3) {
    writeKv(KEY.lifeAppFallback(name), { ios405Count: 0, webFallbackUntil: Date.now() + WEB_FALLBACK_MS });
    logTo("warn", "proapi 连续 3 次 405 而 webapi 正常，接下来 24h 固定走 webapi");
  } else {
    writeKv(KEY.lifeAppFallback(name), { ...st, ios405Count: count });
  }
}

function resetIos405(name: string): void {
  const st = readFallback(name);
  if (st.ios405Count) writeKv(KEY.lifeAppFallback(name), { ...st, ios405Count: 0 });
}

function clearWebFallback(name: string): void {
  const st = readFallback(name);
  if (st.webFallbackUntil) writeKv(KEY.lifeAppFallback(name), { ...st, webFallbackUntil: undefined });
}

/** proapi ↔ webapi 互为兜底，只有 405 才降级，其它错误照常抛 */
async function pullWithFallback(
  account: Cloud115Account,
  cursor: LifeCursor,
  signal: AbortSignal | undefined,
  logTo: ChangeLog,
  extra: Pick<LifePullOptions, "maxPages" | "firstBatchSize" | "cooldownMs"> = {},
): Promise<LifeEvent[]> {
  const name = account.name;
  const app = currentApp(name);
  const pull = (via: LifeApp) => deps.pull({ accountInfo: account, cursor, app: via, signal, ...extra });
  try {
    const events = await pull(app);
    if (app === "ios") resetIos405(name);
    return events;
  } catch (err) {
    if (!is405(err)) throw err;
    if (app === "web") {
      logTo("warn", "webapi 返回 405，改用 proapi 重试");
      clearWebFallback(name);
      return pull("ios");
    }
    logTo("warn", "proapi 返回 405，改用 webapi 重试");
    const events = await pull("web");
    recordIos405(name, logTo);
    return events;
  }
}

function kindOf(type: number): ChangeKind | null {
  if (CREATE_TYPES.has(type)) return "create";
  if (MOVE_TYPES.has(type)) return "move";
  if (RENAME_TYPES.has(type)) return "rename";
  if (REMOVE_TYPES.has(type)) return "remove";
  if (NEW_FOLDER_TYPES.has(type)) return "folder";
  return null;
}

/* ---------------------------------- 变更源 ---------------------------------- */

export class Cloud115ChangeSource implements ChangeSource {
  readonly minIntervalSeconds = 5;

  constructor(private readonly account: Cloud115Account) {}

  get label(): string {
    return currentApp(this.account.name) === "web" ? "webapi" : "proapi";
  }

  /**
   * 注意 calendar/setoption 对失效 cookie 也会返回成功，光看它会漏掉「请重新登录」，
   * 所以必须再真拉一条，否则只会在后台 30s 一轮地空转重试。
   */
  async prepare(signal: AbortSignal, log: ChangeLog = noLog): Promise<PrepareResult> {
    try {
      const gate = await deps.enable(this.account, signal);
      if (!gate.ok) {
        return { ok: false, message: `115 生活事件开关未能开启（${gate.message}），请检查 cookie`, reason: gate.message };
      }
      await pullWithFallback(this.account, ZERO_CURSOR, signal, log, { maxPages: 1, firstBatchSize: 1, cooldownMs: 0 });
      return { ok: true, message: "已连接" };
    } catch (err) {
      if (signal.aborted || isAbortError(err)) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `115 生活事件不可用：${msg}，请检查 cookie`, reason: msg };
    }
  }

  initialCursor(mode: LifePullMode, saved: ChangeCursor | null): ChangeCursor {
    if (mode === "all") return { time: 0, id: "0" };
    if (mode === "last" && saved) return saved;
    return { time: Math.floor(Date.now() / 1000), id: "0" };
  }

  async pull(cursor: ChangeCursor, opts: PullOptions): Promise<{ events: ChangeEvent[]; cursor: ChangeCursor }> {
    const log = opts.log ?? noLog;
    const raw = await pullWithFallback(this.account, { fromTime: cursor.time, fromId: cursor.id }, opts.signal, log);
    const events: ChangeEvent[] = [];
    // 事件是倒序拉回来的，按时间正序交出去才能保证「先建后删」这类因果关系
    for (const ev of [...raw].reverse()) {
      if (opts.signal.aborted) break;
      events.push(await this.toChange(ev));
    }
    const last = events[events.length - 1];
    return { events, cursor: last ? { time: last.at || cursor.time, id: last.id } : cursor };
  }

  private async toChange(ev: LifeEvent): Promise<ChangeEvent> {
    const type = Number(ev.type);
    const isDir = Number(ev.file_category) === 0;
    const base = {
      id: String(ev.id),
      nodeId: String(ev.file_id),
      isDir,
      size: Number(ev.file_size ?? 0),
      hash: ev.sha1 || undefined,
      token: ev.pick_code || undefined,
      at: Number(ev.update_time) || 0,
      rawType: type,
    };
    const kind = kindOf(type);
    if (!kind) return { ...base, kind: "create", path: ev.file_name, oldPath: null, problem: `未处理的事件类型 ${type}` };
    const name = ev.file_name ?? "";
    const parentId = String(ev.parent_id);
    const fileId = String(ev.file_id);
    const accountName = this.account.name;

    if (kind === "remove") {
      // 缓存里没有就用 parent_id 反推；两样都没有就只能跳过
      let path = lookupCachedPath(accountName, fileId);
      if (!path) {
        const dir = await resolveDirPath(this.account, parentId);
        if (!dir) return { ...base, kind, path: name, oldPath: null, problem: `无法确定 ${name} 的路径，跳过删除` };
        path = joinPanPath(dir, name);
      }
      dropSubtree(path);
      return { ...base, kind, path, oldPath: null };
    }

    const dir = await resolveDirPath(this.account, parentId);
    if (!dir) return { ...base, kind, path: name, oldPath: null, problem: `父目录 ${parentId} 无法解析` };
    const path = joinPanPath(dir, name);
    const oldPath = kind === "move" || kind === "rename" ? lookupCachedPath(accountName, fileId) : null;
    // 缓存先更新：无论本地怎么处理，网盘侧的事实已经变了
    rememberPath({ fileId, parentId, name, path, isDir, accountName });
    if (isDir && oldPath && oldPath !== path) repathSubtree(oldPath, path);
    return { ...base, kind, path, oldPath: oldPath && oldPath !== path ? oldPath : null };
  }

  /** 只拉不处理：确认「事件开关是否已开、能不能拉到数据」 */
  async probe(limit: number, signal?: AbortSignal): Promise<ProbeResult> {
    try {
      await deps.enable(this.account, signal);
      const raw = await pullWithFallback(this.account, ZERO_CURSOR, signal, noLog, {
        maxPages: 1,
        firstBatchSize: Math.max(1, Math.min(limit, 100)),
        cooldownMs: 0,
      });
      return {
        ok: true,
        message: `拉到 ${raw.length} 条事件`,
        events: raw.slice(0, limit).map((e) => ({
          id: String(e.id),
          kind: BEHAVIOR_TYPE_TO_NAME[Number(e.type)] ?? `type_${e.type}`,
          name: e.file_name,
          at: Number(e.update_time) || 0,
        })),
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
