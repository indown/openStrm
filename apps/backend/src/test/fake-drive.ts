/**
 * 内存假网盘：功能测试（分享转存 / 追更 / 监控 / strm 校验 / 路由）共用的 Provider 桩。
 * 通过 drive/registry.ts 的 setDriveProviderFactory 注入，替代以前各服务自己的 deps 桩。
 *
 * 路径一律 `/a/b` 形式；节点 id 自动分配（n1, n2…），根是 "0"。
 * 分享：shares 里每个分享码一棵树，receive 把节点复制进网盘树并回顶层 id。
 * 变更：测试往 changes.queue 推事件，pull 一次全吐出来。
 */
import type { AccountInfo, LifePullMode, TaskDefinition } from "@openstrm/shared";
import { syncViewFromPaths } from "../services/drive/subtree.js";
import {
  normalizePath,
  RemoteDirNotFoundError,
  ShareGoneError,
  splitPath,
  type AccountIssue,
  resolvedChange,
  type ChangeCursor,
  type ChangeEvent,
  type ChangeSource,
  type PullResult,
  type DriveEntry,
  type DriveKind,
  type DriveLink,
  type DriveNode,
  type DriveProvider,
  type ReceiveItem,
  type ReceiveResult,
  type ShareEntry,
  type ShareInfo,
  type ShareListPage,
  type ShareProvider,
  type ShareRef,
  type ShareSession,
  type SubtreeEntry,
  type ShareUpdateSignal,
  type ShareUpdates,
} from "../services/drive/types.js";

export interface FakeNode {
  id: string;
  isDir: boolean;
  size?: number;
  hash?: string;
  modifiedAt?: number;
}

const parentOf = (p: string): string => normalizePath(splitPath(p).slice(0, -1).join("/"));
const baseOf = (p: string): string => splitPath(p).pop() ?? "";
const isUnder = (p: string, dir: string): boolean => dir === "/" ? p !== "/" : p.startsWith(`${dir}/`);

/** 一棵以路径为键的树 */
export class FakeTree {
  readonly nodes = new Map<string, FakeNode>();
  private seq = 0;

  constructor(private readonly prefix: string) {}

  private nextId(): string {
    return `${this.prefix}${++this.seq}`;
  }

  addDir(path: string, extra: Partial<FakeNode> = {}): FakeNode {
    const p = normalizePath(path);
    if (p === "/") return { id: "0", isDir: true };
    const existing = this.nodes.get(p);
    if (existing) return existing;
    this.addDir(parentOf(p));
    const node: FakeNode = { id: this.nextId(), isDir: true, ...extra };
    this.nodes.set(p, node);
    return node;
  }

  addFile(path: string, extra: Partial<FakeNode> = {}): FakeNode {
    const p = normalizePath(path);
    this.addDir(parentOf(p));
    const node: FakeNode = { id: this.nextId(), isDir: false, size: 1, ...extra };
    this.nodes.set(p, node);
    return node;
  }

  remove(path: string): void {
    const p = normalizePath(path);
    for (const key of [...this.nodes.keys()]) if (key === p || isUnder(key, p)) this.nodes.delete(key);
  }

  /** 改名 / 移动：整棵子树跟着走，id 不变 */
  move(from: string, to: string): void {
    const a = normalizePath(from);
    const b = normalizePath(to);
    const moved: Array<[string, FakeNode]> = [];
    for (const [key, node] of this.nodes) {
      if (key === a || isUnder(key, a)) moved.push([`${b}${key.slice(a.length)}`, node]);
    }
    this.remove(a);
    this.addDir(parentOf(b));
    for (const [key, node] of moved) this.nodes.set(key, node);
  }

  pathOf(id: string): string | null {
    if (id === "0" || id === "/") return "/";
    for (const [p, n] of this.nodes) if (n.id === id) return p;
    return null;
  }

  get(path: string): FakeNode | undefined {
    const p = normalizePath(path);
    return p === "/" ? { id: "0", isDir: true } : this.nodes.get(p);
  }

  children(dir: string): Array<{ path: string; node: FakeNode }> {
    const d = normalizePath(dir);
    return [...this.nodes]
      .filter(([p]) => parentOf(p) === d && p !== "/")
      .map(([path, node]) => ({ path, node }))
      .sort((x, y) => x.path.localeCompare(y.path));
  }

  descendants(dir: string): Array<{ path: string; node: FakeNode }> {
    const d = normalizePath(dir);
    return [...this.nodes]
      .filter(([p]) => isUnder(p, d))
      .map(([path, node]) => ({ path, node }))
      .sort((x, y) => x.path.localeCompare(y.path));
  }
}

export interface FakeShareDef {
  title: string;
  password?: string;
  tree: FakeTree;
  /** 设为 true 模拟分享失效 */
  gone?: boolean;
}

export class FakeShare implements ShareProvider {
  readonly shares = new Map<string, FakeShareDef>();
  readonly calls = { info: 0, list: 0, receive: 0, resolvePath: 0, updates: 0 };
  /** 每次分享调用记一行 `<方法> <参数>` */
  readonly log: string[] = [];
  /** 每页条数，测翻页用 */
  pageSize = 100;
  /** 服务端「相对上次转存有没有新增」的信号；默认 unknown = 认不出，追更照常列目录 */
  updateSignal: ShareUpdateSignal = "unknown";
  /** 列目录结果先过它一手：测试用来塞进树里表示不了的条目（比如名字带 /） */
  listHook: ((dirId: string, entries: ShareEntry[]) => ShareEntry[]) | null = null;
  readonly updates: ShareUpdates = {
    check: async (s: ShareSession) => {
      this.calls.updates++;
      this.def(s.ref);
      return this.updateSignal;
    },
  };

  constructor(
    private readonly kind: DriveKind,
    private readonly drive: FakeDrive,
  ) {}

  /** 建一个分享：`fake://<kind>/<code>` */
  define(code: string, def: Omit<FakeShareDef, "tree"> & { tree?: FakeTree }): FakeTree {
    const tree = def.tree ?? new FakeTree(`s-${code}-`);
    this.shares.set(code, { ...def, tree });
    return tree;
  }

  linkFor(code: string): string {
    const def = this.shares.get(code);
    return `https://fake.share/${this.kind}/${code}${def?.password ? `?pwd=${def.password}` : ""}`;
  }

  parseLink(text: string): ShareRef | null {
    const m = new RegExp(`^https://fake\\.share/${this.kind}/([a-z0-9]+)(?:\\?pwd=([a-z0-9]+))?$`, "i").exec(text.trim());
    if (!m) return null;
    return { kind: this.kind, code: m[1], password: m[2] ?? "", url: text.trim() };
  }

  private def(ref: ShareRef): FakeShareDef {
    // 网盘那边设了 failWith（cookie 失效 / 风控），分享接口一样打不通
    if (this.drive.failWith) throw this.drive.failWith;
    const def = this.shares.get(ref.code);
    if (!def || def.gone) throw new ShareGoneError(`share not exist: ${ref.code}`, 4100);
    if (def.password && def.password !== ref.password) throw new ShareGoneError("wrong password", 4101);
    return def;
  }

  async open(ref: ShareRef): Promise<ShareSession> {
    this.def(ref);
    return { ref, token: `stoken-${ref.code}` };
  }

  async info(s: ShareSession): Promise<ShareInfo> {
    this.calls.info++;
    const def = this.def(s.ref);
    return { title: def.title, fileCount: def.tree.children("/").length };
  }

  private toEntry(path: string, node: FakeNode): ShareEntry {
    return {
      id: node.id,
      name: baseOf(path),
      isDir: node.isDir,
      size: node.size,
      hash: this.drive.withHash ? node.hash : undefined,
      token: `tok-${node.id}`,
      modifiedAt: node.modifiedAt,
    };
  }

  async list(s: ShareSession, dirId: string, cursor?: string, _opts?: { limit?: number }): Promise<ShareListPage> {
    this.calls.list++;
    this.log.push(`list ${dirId || "0"}${cursor ? `@${cursor}` : ""}`);
    const def = this.def(s.ref);
    const dir = def.tree.pathOf(dirId || "0");
    if (dir === null) return { entries: [], total: 0 };
    let all = def.tree.children(dir).map(({ path, node }) => this.toEntry(path, node));
    if (this.listHook) all = this.listHook(dirId || "0", all);
    const page = Number(cursor ?? 0) || 0;
    const start = page * this.pageSize;
    const entries = all.slice(start, start + this.pageSize);
    const hasMore = start + entries.length < all.length;
    return { entries, next: hasMore ? String(page + 1) : undefined, total: all.length };
  }

  async resolvePath(s: ShareSession, path: string): Promise<ShareEntry | null> {
    this.calls.resolvePath++;
    const def = this.def(s.ref);
    const p = normalizePath(path);
    if (p === "/") return null;
    const node = def.tree.get(p);
    return node ? this.toEntry(p, node) : null;
  }

  async receive(s: ShareSession, items: ReceiveItem[], toDirId: string): Promise<ReceiveResult> {
    this.calls.receive++;
    this.log.push(`receive ${items.map((i) => i.id).join(",")} -> ${toDirId}`);
    const def = this.def(s.ref);
    const target = this.drive.tree.pathOf(toDirId);
    if (target === null) throw new Error(`fake receive: unknown target dir ${toDirId}`);
    const topIds: string[] = [];
    for (const item of items) {
      const src = def.tree.pathOf(item.id);
      if (src === null) throw new Error(`fake receive: unknown share item ${item.id}`);
      const node = def.tree.get(src)!;
      const dest = `${target === "/" ? "" : target}/${baseOf(src)}`;
      const copied = node.isDir ? this.drive.tree.addDir(dest) : this.drive.tree.addFile(dest, { size: node.size, hash: node.hash });
      topIds.push(copied.id);
      if (node.isDir) {
        for (const { path, node: child } of def.tree.descendants(src)) {
          const rel = path.slice(src.length);
          if (child.isDir) this.drive.tree.addDir(`${dest}${rel}`);
          else this.drive.tree.addFile(`${dest}${rel}`, { size: child.size, hash: child.hash });
        }
      }
    }
    return { topIds };
  }
}

export class FakeChanges implements ChangeSource {
  readonly label = "fake";
  minIntervalSeconds = 1;
  readonly queue: ChangeEvent[] = [];
  prepareResult: { ok: boolean; message: string } = { ok: true, message: "ok" };
  pulls = 0;
  /** 下一次 pull 一起带出去的告警（模拟某个根列不了） */
  warnings: string[] = [];
  /** 监控在事件处理完之后调用了几次 commit */
  commits = 0;

  async prepare(): Promise<{ ok: boolean; message: string }> {
    return this.prepareResult;
  }

  initialCursor(mode: LifePullMode, saved: ChangeCursor | null): ChangeCursor {
    if (mode === "last" && saved) return saved;
    return { time: mode === "all" ? 0 : Math.floor(Date.now() / 1000), id: "0" };
  }

  async pull(cursor: ChangeCursor, _opts: { tasks: TaskDefinition[]; signal: AbortSignal }): Promise<PullResult> {
    this.pulls++;
    const events = this.queue.splice(0, this.queue.length);
    const last = events[events.length - 1];
    return {
      changes: events.map(resolvedChange),
      cursor: last ? { time: last.at, id: last.id } : cursor,
      warnings: this.warnings.length > 0 ? [...this.warnings] : undefined,
      commit: () => {
        this.commits++;
      },
    };
  }
}

export interface FakeDriveOptions {
  share?: boolean;
  changes?: boolean;
  /** 分享 / 目录条目带不带内容哈希（115 有、夸克没有） */
  withHash?: boolean;
  /** 直链的前缀：`${linkBase}/dl<path>` */
  linkBase?: string;
  notes?: { verify?: string };
}

export class FakeDrive implements DriveProvider {
  readonly tree: FakeTree;
  readonly rootId = "0";
  readonly capabilities: { share: boolean; changes: boolean };
  readonly share?: FakeShare;
  readonly changes?: FakeChanges;
  readonly notes?: { verify?: string };
  readonly withHash: boolean;
  readonly linkBase: string;
  readonly calls = { resolvePath: 0, listDir: 0, listSubtree: 0, walkSubtree: 0, downloadLink: 0 };
  /** 每次网盘调用记一行 `<方法> <参数>`，测试断言调用顺序 / 次数用 */
  readonly log: string[] = [];
  /** 设了就让所有网盘调用抛这个错（模拟 cookie 失效 / 风控） */
  failWith: Error | null = null;
  /** 每次网盘调用前先等它（模拟慢接口 / 卡住） */
  beforeCall: (() => Promise<void>) | null = null;

  constructor(
    readonly kind: DriveKind,
    readonly account: AccountInfo,
    opts: FakeDriveOptions = {},
  ) {
    this.tree = new FakeTree(`${kind}-${account.name}-`);
    this.withHash = opts.withHash ?? kind === "115";
    this.linkBase = opts.linkBase ?? "http://127.0.0.1:1";
    this.capabilities = { share: !!opts.share, changes: !!opts.changes };
    if (opts.share) this.share = new FakeShare(kind, this);
    if (opts.changes) this.changes = new FakeChanges();
    this.notes = opts.notes;
  }

  private async guard(method: string, arg: string): Promise<void> {
    this.log.push(`${method} ${arg}`);
    if (this.beforeCall) await this.beforeCall();
    if (this.failWith) throw this.failWith;
  }

  async resolvePath(path: string): Promise<DriveNode | null> {
    this.calls.resolvePath++;
    await this.guard("resolvePath", path);
    const node = this.tree.get(path);
    return node ? { id: node.id, isDir: node.isDir } : null;
  }

  async listDir(id: string): Promise<DriveEntry[]> {
    this.calls.listDir++;
    await this.guard("listDir", id);
    const dir = this.tree.pathOf(id);
    if (dir === null) return [];
    return this.tree.children(dir).map(({ path, node }) => ({
      id: node.id,
      name: baseOf(path),
      isDir: node.isDir,
      size: node.size,
      hash: this.withHash ? node.hash : undefined,
      token: node.id,
      modifiedAt: node.modifiedAt,
    }));
  }

  private rootPath(path: string, id?: string): string {
    const root = id ? this.tree.pathOf(id) : normalizePath(path);
    if (root === null) throw new RemoteDirNotFoundError(path);
    const node = this.tree.get(root);
    if (!node || !node.isDir) throw new RemoteDirNotFoundError(path);
    return root;
  }

  async listSubtree(path: string, opts?: { id?: string }): Promise<string[]> {
    this.calls.listSubtree++;
    await this.guard("listSubtree", opts?.id ?? path);
    const root = this.rootPath(path, opts?.id);
    return syncViewFromPaths(this.tree.descendants(root).map(({ path: p }) => splitPath(p.slice(root === "/" ? 0 : root.length))));
  }

  async walkSubtree(path: string, opts?: { id?: string }): Promise<SubtreeEntry[]> {
    this.calls.walkSubtree++;
    await this.guard("walkSubtree", opts?.id ?? path);
    const root = this.rootPath(path, opts?.id);
    return this.tree.descendants(root).map(({ path: p, node }) => ({
      path: splitPath(p.slice(root === "/" ? 0 : root.length)).join("/"),
      id: node.id,
      isDir: node.isDir,
      size: node.size,
      modifiedAt: node.modifiedAt,
    }));
  }

  async downloadLink(path: string): Promise<DriveLink> {
    this.calls.downloadLink++;
    await this.guard("downloadLink", path);
    const p = normalizePath(path);
    const node = this.tree.get(p);
    if (!node || node.isDir) throw new RemoteDirNotFoundError(p);
    return { url: `${this.linkBase}/dl${p}` };
  }

  classifyError(err: unknown): AccountIssue | null {
    if (err instanceof ShareGoneError) return "gone";
    const msg = err instanceof Error ? err.message : String(err);
    if (/cookie|login|登录/i.test(msg)) return "auth";
    if (/blocked|405|阻断|封控/i.test(msg)) return "blocked";
    return null;
  }
}
