/**
 * 快照式变更源：给没有事件流的网盘用（夸克）。
 *
 * 每轮把该账号每个同步任务的 originPath 整棵列一遍，和上一轮存在 drive_snapshots 里的对比，
 * 以网盘 id 为身份认出新增 / 删除 / 改名 / 移动。目录级的变化只报最上层那一条：新目录由处理器展开生成，
 * 移动 / 删除的目录本地整体搬 / 删，子项跟着走。
 *
 * 安全阀：一轮里要删的超过快照的三成先不删，只告警；下一轮还是同样的结果才执行（真机上整个目录被删掉就是这样，
 * 只压不放会永远收敛不了）。列目录失败是抛错而不是回空，所以列到 0 条就是真的空了，照常对比。
 * 首轮：latest / last 只存快照不发事件，all 把现有文件全部当新增。
 */
import type { LifePullMode } from "@openstrm/shared";
import { readDriveSnapshot, writeDriveSnapshot } from "../../../db/repositories/life.js";
import { isAbortError } from "../../../lib/errors.js";
import { moduleLogger } from "../../../lib/logger.js";
import { normalizePath, type ChangeCursor, type ChangeEvent, type ChangeKind, type ChangeSource, type DriveProvider, type PrepareResult, type ProbeResult, type PullOptions, type SubtreeEntry } from "../../drive/types.js";

const log = moduleLogger("life");

/** 快照里的一条：相对根的路径 + 网盘 id + 元数据 */
export type SnapEntry = SubtreeEntry;

export interface SnapshotChange {
  kind: ChangeKind;
  /** 相对根 */
  path: string;
  oldPath: string | null;
  isDir: boolean;
  id: string;
  size?: number;
}

const depthOf = (p: string): number => p.split("/").length;
const parentOf = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
};
const isUnder = (p: string, dir: string): boolean => p.startsWith(`${dir}/`);
const coveredBy = (p: string, dirs: string[]): boolean => dirs.some((d) => isUnder(p, d));

/** 两份快照的差：只报最上层的目录变化；文件内容变了（大小 / 时间）按新增再报一次，处理器会重下附件 */
export function diffSnapshot(prev: SnapEntry[], curr: SnapEntry[]): { changes: SnapshotChange[]; removed: number } {
  const prevById = new Map(prev.map((e) => [e.id, e]));
  const currById = new Map(curr.map((e) => [e.id, e]));
  const byDepth = (a: SnapEntry, b: SnapEntry) => depthOf(a.path) - depthOf(b.path) || a.path.localeCompare(b.path);
  const created: SnapshotChange[] = [];
  const moved: SnapshotChange[] = [];
  const changed: SnapshotChange[] = [];
  const removed: SnapshotChange[] = [];
  const newDirs: string[] = [];
  const movedDirs: Array<{ from: string; to: string }> = [];
  const removedDirs: string[] = [];

  for (const e of [...curr].sort(byDepth)) {
    const old = prevById.get(e.id);
    if (!old) {
      if (coveredBy(e.path, newDirs)) continue;
      created.push({ kind: "create", path: e.path, oldPath: null, isDir: e.isDir, id: e.id, size: e.size });
      if (e.isDir) newDirs.push(e.path);
      continue;
    }
    if (old.path !== e.path) {
      // 整个目录搬了：下面的条目路径都跟着变，不再单报
      if (movedDirs.some((m) => isUnder(old.path, m.from) && isUnder(e.path, m.to))) continue;
      moved.push({
        kind: parentOf(old.path) === parentOf(e.path) ? "rename" : "move",
        path: e.path,
        oldPath: old.path,
        isDir: e.isDir,
        id: e.id,
        size: e.size,
      });
      if (e.isDir) movedDirs.push({ from: old.path, to: e.path });
      continue;
    }
    if (!e.isDir && ((old.size ?? 0) !== (e.size ?? 0) || (old.modifiedAt ?? 0) !== (e.modifiedAt ?? 0))) {
      changed.push({ kind: "create", path: e.path, oldPath: null, isDir: false, id: e.id, size: e.size });
    }
  }

  let removedCount = 0;
  for (const e of [...prev].sort(byDepth)) {
    if (currById.has(e.id)) continue;
    removedCount++;
    if (coveredBy(e.path, removedDirs)) continue;
    removed.push({ kind: "remove", path: e.path, oldPath: null, isDir: e.isDir, id: e.id });
    if (e.isDir) removedDirs.push(e.path);
  }
  return { changes: [...created, ...moved, ...changed, ...removed], removed: removedCount };
}

/** 一轮里要删的超过快照的这个比例先不删，下一轮还这样才删 */
const REMOVE_RATIO_LIMIT = 0.3;
const REMOVE_RATIO_MIN_ENTRIES = 10;
/** 哪些根上一轮压下过大比例删除（`账号\0根`）；进程重启就忘，最多再多等一轮 */
const suppressedRoots = new Set<string>();

/** 仅供测试 */
export function __test_resetQuarkSnapshotSource(): void {
  suppressedRoots.clear();
}

export class QuarkSnapshotSource implements ChangeSource {
  readonly label = "snapshot";
  readonly minIntervalSeconds = 300;

  constructor(private readonly provider: DriveProvider) {}

  async prepare(signal: AbortSignal): Promise<PrepareResult> {
    try {
      await this.provider.listDir(this.provider.rootId, signal);
      return { ok: true, message: "已连接" };
    } catch (err) {
      if (signal.aborted || isAbortError(err)) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `网盘不可用：${msg}，请检查 cookie`, reason: msg, issue: this.provider.classifyError(err) };
    }
  }

  /** 游标的 id 记冷启动模式：首轮建快照时靠它决定要不要把现有文件当新增 */
  initialCursor(mode: LifePullMode, saved: ChangeCursor | null): ChangeCursor {
    if (mode === "last" && saved) return { ...saved, id: "last" };
    return { time: mode === "all" ? 0 : Math.floor(Date.now() / 1000), id: mode };
  }

  async pull(cursor: ChangeCursor, opts: PullOptions): Promise<{ events: ChangeEvent[]; cursor: ChangeCursor }> {
    const walk = this.provider.walkSubtree;
    if (!walk) throw new Error("这个网盘不支持快照监控");
    const account = this.provider.account.name;
    const scannedAt = Math.floor(Date.now() / 1000);
    const events: ChangeEvent[] = [];
    const roots = [...new Set(opts.tasks.map((t) => normalizePath(t.originPath)))].filter((r) => r !== "/");

    for (const root of roots) {
      if (opts.signal.aborted) break;
      const prev = readDriveSnapshot<SnapEntry>(account, root);
      const entries = await walk.call(this.provider, root, { signal: opts.signal });
      if (!prev) {
        writeDriveSnapshot(account, root, entries, scannedAt);
        if (cursor.id === "all") {
          const { changes } = diffSnapshot([], entries);
          events.push(...changes.map((c) => this.toEvent(account, root, c, scannedAt)));
        } else {
          opts.log?.("info", `${root} 首轮建立快照：${entries.length} 项记为现有`);
        }
        continue;
      }
      const { changes, removed } = diffSnapshot(prev.entries, entries);
      let list = changes;
      let toStore = entries;
      const key = `${account}\0${root}`;
      const massRemoval = prev.entries.length >= REMOVE_RATIO_MIN_ENTRIES && removed / prev.entries.length > REMOVE_RATIO_LIMIT;
      if (massRemoval && !suppressedRoots.has(key)) {
        // 第一次看到：先不删，被压下的删除留在快照里，下轮还是这样才执行
        suppressedRoots.add(key);
        const msg = `${root} 这轮有 ${removed}/${prev.entries.length} 项消失，超过 ${REMOVE_RATIO_LIMIT * 100}%，先不删本地文件；下一轮还是这样才删`;
        opts.log?.("warn", msg);
        log.warn({ account, root }, msg);
        list = list.filter((c) => c.kind !== "remove");
        const currIds = new Set(entries.map((e) => e.id));
        toStore = [...entries, ...prev.entries.filter((e) => !currIds.has(e.id))];
      } else {
        if (massRemoval) opts.log?.("warn", `${root} 连续两轮都少了 ${removed}/${prev.entries.length} 项，按真删除处理`);
        suppressedRoots.delete(key);
      }
      writeDriveSnapshot(account, root, toStore, scannedAt);
      events.push(...list.map((c) => this.toEvent(account, root, c, scannedAt)));
    }
    return { events, cursor: { time: scannedAt, id: "" } };
  }

  private toEvent(account: string, root: string, c: SnapshotChange, at: number): ChangeEvent {
    const abs = (rel: string) => (root === "/" ? `/${rel}` : `${root}/${rel}`);
    return {
      id: `q:${account}:${at}:${c.kind}:${c.id}`,
      kind: c.kind,
      path: abs(c.path),
      oldPath: c.oldPath ? abs(c.oldPath) : null,
      isDir: c.isDir,
      nodeId: c.id,
      size: c.size,
      token: c.id,
      at,
    };
  }

  async probe(_limit: number, signal?: AbortSignal): Promise<ProbeResult> {
    try {
      const entries = await this.provider.listDir(this.provider.rootId, signal);
      return {
        ok: true,
        message: `cookie 有效，根目录 ${entries.length} 项；这个网盘没有事件流，监控靠定时对比任务目录（最短 ${this.minIntervalSeconds} 秒一轮）`,
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
