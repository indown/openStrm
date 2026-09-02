/**
 * 后端接口的类型化客户端。页面只调这里的函数，不再手写路径和响应类型。
 *
 * 响应就是 payload 本身（后端已去掉 `{code,data}` 壳）；失败一律抛 axios 错误，
 * 错误体固定为 `{ message, ...extra }`，用 apiErrorMessage() 取文案。
 */
import axiosInstance from "./axios";
import type {
  AccountInfo,
  AppSettings,
  LifeMonitorSettings,
  MediaLibraryEntry,
  ShareFollowRun,
  ShareFollowSummary,
  TaskDefinition,
  TaskExecutionHistory,
  TaskExecutionSummary,
  TelegramNotifySettings,
} from "@openstrm/shared";

/* ------------------------------- 类型 ------------------------------- */

export type TaskStatus = "pending" | "processing";
/** GET /api/task 的行：任务定义 + 运行状态 + 上次执行 + 下次定时。strmType 是表单存的附加字段 */
export type TaskRow = TaskDefinition & {
  status: TaskStatus;
  strmType?: string;
  /** 最近一次执行（不带日志）；从没跑过是 null */
  lastRun: TaskExecutionSummary | null;
  /** 定时任务的下次触发时间（ISO）；没有定时是 null */
  nextRunAt: string | null;
};
/** 表单提交的任务字段；必填项由后端 schema 把关，这里只描述形状 */
export type TaskInput = Partial<Omit<TaskDefinition, "id">> & { strmType?: string };

export type StartTaskResult = {
  message: string;
  taskId?: string;
  extraFilesCount?: number;
  willDeleteExtraFiles?: boolean;
  /** 比如"远端为空，已跳过清理"这类不算失败但该让人知道的事 */
  warning?: string;
};

export interface ShareFileItem {
  id: number;
  name: string;
  is_dir: boolean;
  parent_id: number;
  size?: number;
  [k: string]: unknown;
}
export type ShareInfo = Record<string, unknown>;
export type ShareListPage = { list: ShareFileItem[]; count: number; limit: number; offset: number };
export type ShareReceiveResult = Record<string, unknown> & {
  mode?: "sync" | "async";
  taskId?: string;
  message?: string;
  generatedCount?: number;
  skippedCount?: number;
  strmGenerated?: boolean;
  /** 带 follow 参数时：建成的订阅，或没建成的原因（转存本身已成功） */
  follow?: ShareFollowSummary;
  followError?: string;
};

/** 115 网盘文件列表条目（原始字段名） */
export interface Drive115Item {
  cid: number;
  n: string;
  fc: number;
  [k: string]: unknown;
}

export interface DirectoryNode {
  name: string;
  id: string | number;
  isDir: boolean;
  hasChildren?: boolean;
}

export type LibraryAddResponse = { mode: "single" | "subdir"; entry: MediaLibraryEntry };
export type LibraryPatch = Partial<Pick<MediaLibraryEntry, "title" | "coverUrl" | "notes" | "tags" | "receiveCode">>;
export type LibraryCreateInput = {
  shareUrl: string;
  title?: string;
  coverUrl?: string;
  tags?: string[];
  notes?: string;
  cid?: string | number;
  fileCount?: number;
  rawName?: string;
  sharePath?: string;
};
export type ScrapeStatusSummary = { pendingIds: string[]; pendingCount: number; active: number; queued: number };
/** 设置里值是对象的顶层键（emby / telegram / lifeMonitor …），可以按组读-改-写 */
export type SettingsGroupKey = {
  [K in keyof AppSettings]-?: NonNullable<AppSettings[K]> extends readonly unknown[]
    ? never
    : NonNullable<AppSettings[K]> extends object
      ? K
      : never;
}[keyof AppSettings];
export type SaveToTaskChoice = {
  taskId: string;
  subPath: string;
  mode: "sync" | "async";
  /** 勾了「转存后追更」就带上；后端转存成功后顺手建订阅 */
  follow?: { intervalMinutes: number };
};

export interface TmdbSearchResult {
  id: number;
  mediaType: string;
  title: string;
  year: string;
  posterUrl: string;
  overview: string;
}

export interface HdhiveTmdbItem {
  id: number;
  mediaType: "movie" | "tv";
  title: string;
  year: string;
  posterUrl: string;
  overview: string;
}
export interface HdhiveResourceItem {
  slug: string;
  title: string | null;
  pan_type: string | null;
  share_size: string | null;
  video_resolution: string[];
  source: string[];
  subtitle_language: string[];
  subtitle_type: string[];
  unlock_points: number | null;
  is_unlocked: boolean;
  user: Record<string, unknown> | null;
  remark?: string | null;
}
export interface HdhiveUnlockResult {
  url: string;
  access_code: string;
  full_url: string;
  already_owned: boolean;
}
export type HdhiveSearchResult = {
  tmdb: HdhiveTmdbItem | null;
  alternatives: HdhiveTmdbItem[];
  resources: HdhiveResourceItem[];
  total: number;
};

export type LifeEventMode = "create" | "move" | "rename" | "remove";
export type LifeMonitorStats = { rounds: number; events: number; handled: number; skipped: number; failed: number };
/** 一个被监控账号的运行态；起不来的账号 running=false，原因在 lastError */
export type LifeAccountStatus = {
  name: string;
  running: boolean;
  cursor: { fromTime: number; fromId: string };
  api: "web" | "ios" | "android";
  startedAt: number | null;
  lastPollAt: number | null;
  lastError: string | null;
  stats: LifeMonitorStats;
};
export type LifeMonitorStatus = {
  /** 至少一个账号在跑 */
  running: boolean;
  accounts: LifeAccountStatus[];
  interval: number;
  eventModes: LifeEventMode[];
  startedAt: number | null;
  lastPollAt: number | null;
  /** 各账号合计 */
  stats: LifeMonitorStats;
  db: { lifeEvents: number; pathCache: number };
  embyRefresh: { configured: boolean; pendingCount: number; pendingSince: number | null };
  logs: string[];
};
export type LifeProbeResult = {
  ok: boolean;
  message: string;
  accounts: Array<{ account: string; ok: boolean; message: string }>;
};
export type LifeEventRow = {
  id: string;
  accountName: string;
  type: number;
  typeName: string;
  fileName: string;
  fileCategory: number;
  updateTime: number;
  status: string;
  detail: string;
};

/* ------------------------------- 115 云下载 ------------------------------- */

export type OfflineTaskState = "pending" | "downloading" | "done" | "failed" | "unknown";
export interface OfflineTask {
  infoHash: string;
  name: string;
  url: string;
  size: number;
  /** 0-100 */
  percent: number;
  status: number;
  state: OfflineTaskState;
  /** 115 给的中文说明 */
  statusText: string;
  /** unix 秒 */
  addTime: number;
  lastUpdate: number;
  leftTime: number;
  peers: number;
  rateDownload: number;
  dirId: string;
  resultId: string;
  resultName: string;
  isDir: boolean;
  move: number;
  pickCode: string;
}
export type OfflineFollowupStatus = "pending" | "done" | "failed";
/** 下载完成后的回执：生成 strm（缺省），或让 OpenList 复制走 */
export interface OfflineFollowup {
  /** 老记录没有这个字段，当 "strm" 看 */
  kind?: "strm" | "openlist-copy";
  infoHash: string;
  account: string;
  taskId: string;
  subPath: string;
  name: string;
  addedAt: number;
  status: OfflineFollowupStatus;
  detail: string;
  doneAt?: number;
  attempts: number;
  misses: number;
  copyWaits?: number;
  copyTaskId?: string;
  copySubmittedAt?: number;
  /** openlist-copy：复制目标目录 */
  copyDstDir?: string;
}
export interface OfflineWatcherStatus {
  running: boolean;
  pending: number;
  lastTickAt: number | null;
  lastError: string | null;
}
export interface OfflineListPage {
  account: string;
  page: number;
  pageCount: number;
  pageSize: number;
  count: number;
  quota: number | null;
  total: number | null;
  tasks: OfflineTask[];
  followups: OfflineFollowup[];
  watcher: OfflineWatcherStatus;
}
export interface OfflineAddResult {
  url: string;
  ok: boolean;
  infoHash?: string;
  name?: string;
  message?: string;
}
export interface OfflineAddResponse {
  account: string;
  dirId: string | null;
  dirPath: string | null;
  added: number;
  failed: number;
  invalid: string[];
  results: OfflineAddResult[];
  followup: boolean;
}
export interface OfflineAddInput {
  account?: string;
  /** 每行一条 */
  urls: string;
  dirId?: string;
  taskId?: string;
  subPath?: string;
  generateStrm?: boolean;
  /** 只能配合 115 默认目录（不带 dirId / taskId） */
  copyToOpenlist?: boolean;
  /** 这次复制到哪（OpenList 完整路径）；不给用设置页的 dstDir */
  copyDstDir?: string;
}
export interface OfflineDownPath {
  id: string;
  name: string;
  selected: boolean;
}

/* ------------------------------- 分享追更 ------------------------------- */

export interface FollowWatcherStatus {
  running: boolean;
  lastTickAt: number | null;
  lastError: string | null;
  /** 正在检查的订阅 id */
  checking: string[];
}
export type FollowListResponse = { follows: ShareFollowSummary[]; watcher: FollowWatcherStatus };
export type FollowCheckResult = { follow: ShareFollowSummary; run: ShareFollowRun | null };
export type FollowCreateInput = {
  shareUrl?: string;
  shareCode?: string;
  receiveCode?: string;
  watchCid?: string | number;
  watchPath?: string;
  scope?: string[];
  taskId: string;
  subPath?: string;
  intervalMinutes?: number;
  name?: string;
  libraryId?: string;
};
export type FollowPatch = Partial<{
  name: string;
  enabled: boolean;
  intervalMinutes: number;
  taskId: string;
  subPath: string;
  receiveCode: string;
}>;

export type TelegramNotifyPrefs = Required<TelegramNotifySettings>;
export type TelegramPermissions = { allowTaskStart: boolean; allowOfflineAdd: boolean; allowShareReceive: boolean };
export interface TelegramBotStatus {
  configured: boolean;
  /** 掩码后的 token，原样提交等于不改 */
  botToken: string;
  chatId: string;
  allowedUsers: number[];
  permissions: TelegramPermissions;
  notify: TelegramNotifyPrefs;
  notifyDefaults: TelegramNotifyPrefs;
  polling: boolean;
  commands: { command: string; description: string }[];
  bot: { id: number; first_name: string; username?: string } | null;
  botError: string | null;
}

/* ------------------------------- 客户端 ------------------------------- */

const data = <T>(p: Promise<{ data: T }>): Promise<T> => p.then((r) => r.data);

export const api = {
  auth: {
    login: (username: string, password: string) =>
      data(
        axiosInstance.post<{ message: string; token: string; user: { username: string }; mustChangePassword: boolean }>(
          "/api/auth/login",
          { username, password },
        ),
      ),
    changePassword: (currentPassword: string, newPassword: string) =>
      data(axiosInstance.post<{ message: string }>("/api/auth/password", { currentPassword, newPassword })),
    logout: () => data(axiosInstance.post<{ message: string }>("/api/auth/logout")),
  },

  settings: {
    get: () => data(axiosInstance.get<AppSettings>("/api/settings")),
    /** 按顶层键合并：只发本页拥有的键 */
    patch: (patch: Partial<AppSettings>) => data(axiosInstance.put<{ message: string }>("/api/settings", patch)),
    /**
     * 读-改-写一个顶层分组。PUT 是按顶层键整体替换，只改组内一个字段（比如 telegram.allowTaskStart）
     * 得先把库里的其它字段带上，不然 botToken / allowedUsers 会一起被抹掉。掩码的密钥原样回传等于不改。
     */
    patchGroup: async <K extends SettingsGroupKey>(key: K, partial: Partial<NonNullable<AppSettings[K]>>) => {
      const current = (await data(axiosInstance.get<AppSettings>("/api/settings")))[key];
      return data(
        axiosInstance.put<{ message: string }>("/api/settings", { [key]: { ...(current ?? {}), ...partial } }),
      );
    },
  },

  tasks: {
    list: () => data(axiosInstance.get<TaskRow[]>("/api/task")),
    create: (input: TaskInput) => data(axiosInstance.post<TaskDefinition>("/api/task", input)),
    update: (id: string, patch: Partial<TaskInput>) =>
      data(axiosInstance.put<TaskDefinition>("/api/task", { id, ...patch })),
    remove: (id: string) => data(axiosInstance.delete<{ success: true }>(`/api/task?id=${encodeURIComponent(id)}`)),
    /** 115 目录导出可能要等很久，超时放宽到 3 分钟 */
    start: (id: string) => data(axiosInstance.post<StartTaskResult>("/api/startTask", { id }, { timeout: 180_000 })),
    cancel: (id: string) => data(axiosInstance.post<{ message: string; taskId: string }>("/api/cancelTask", { taskId: id })),
    /** 任务是否正在跑（有实时日志可看） */
    isRunning: (id: string) =>
      axiosInstance
        .get<{ taskId: string }>(`/api/taskLog/${encodeURIComponent(id)}`)
        .then(() => true)
        .catch(() => false),
  },

  accounts: {
    list: () => data(axiosInstance.get<AccountInfo[]>("/api/account")),
    create: (input: Record<string, unknown>) => data(axiosInstance.post<AccountInfo>("/api/account", input)),
    update: (input: Record<string, unknown> & { name: string }) => data(axiosInstance.put<AccountInfo>("/api/account", input)),
    remove: (name: string) => data(axiosInstance.delete<{ message: string }>(`/api/account?name=${encodeURIComponent(name)}`)),
  },

  history: {
    /** 列表不带 logs；要看某次执行的日志用 get */
    list: (taskId?: string) =>
      data(axiosInstance.get<TaskExecutionSummary[]>(taskId ? `/api/taskHistory?taskId=${encodeURIComponent(taskId)}` : "/api/taskHistory")),
    get: (executionId: string) =>
      data(axiosInstance.get<TaskExecutionHistory>(`/api/taskHistory/${encodeURIComponent(executionId)}`)),
    remove: (executionId: string) =>
      data(axiosInstance.delete<{ success: true }>(`/api/taskHistory?executionId=${encodeURIComponent(executionId)}`)),
    clear: () => data(axiosInstance.delete<{ success: true; message: string }>("/api/taskHistory?action=cleanup")),
  },

  library: {
    list: () => data(axiosInstance.get<MediaLibraryEntry[]>("/api/library")),
    create: (input: LibraryCreateInput) => data(axiosInstance.post<LibraryAddResponse>("/api/library", input)),
    update: (id: string, patch: LibraryPatch) => data(axiosInstance.put<MediaLibraryEntry>(`/api/library/${id}`, patch)),
    remove: (id: string) => data(axiosInstance.delete<{ success: true }>(`/api/library/${id}`)),
    scrapeStatus: () => data(axiosInstance.get<ScrapeStatusSummary>("/api/library/scrape-status")),
    scrape: (id: string) => data(axiosInstance.post<{ id: string; status: string }>(`/api/library/${id}/scrape`)),
    saveToTask: (id: string, choice: SaveToTaskChoice) =>
      data(axiosInstance.post<ShareReceiveResult>(`/api/library/${id}/save-to-task`, choice, { timeout: 180_000 })),
  },

  follow: {
    list: () => data(axiosInstance.get<FollowListResponse>("/api/follow")),
    create: (input: FollowCreateInput) =>
      data(axiosInstance.post<ShareFollowSummary>("/api/follow", input, { timeout: 180_000 })),
    update: (id: string, patch: FollowPatch) =>
      data(axiosInstance.put<ShareFollowSummary>(`/api/follow/${encodeURIComponent(id)}`, patch)),
    remove: (id: string) => data(axiosInstance.delete<{ success: true }>(`/api/follow/${encodeURIComponent(id)}`)),
    /** 立即检查：要递归列分享目录，有新增还要转存，可能要等几十秒 */
    check: (id: string) =>
      data(axiosInstance.post<FollowCheckResult>(`/api/follow/${encodeURIComponent(id)}/check`, undefined, { timeout: 180_000 })),
  },

  share: {
    info: (url: string) => data(axiosInstance.post<ShareInfo>("/api/115/share", { action: "info", url })),
    list: (url: string, cid: string | number = 0, page?: { limit: number; offset: number }) =>
      data(axiosInstance.post<ShareListPage>("/api/115/share", { action: "list", url, cid, ...page })),
    /** 转存到任务目录（带 taskId）或网盘目录（带 toPid） */
    /** 同步生成 + 建追更订阅都可能要等一会，超时放宽 */
    receive: (body: {
      url: string;
      fileIds: string[];
      taskId?: string;
      subPath?: string;
      mode?: "sync" | "async";
      selectedItems?: { name: string; isDir: boolean }[];
      toPid?: string | number;
      /** 追更盯的目录（当前浏览的这一层）及其展示路径 / 订阅名 */
      cid?: string | number;
      follow?: { intervalMinutes: number };
      watchPath?: string;
      name?: string;
    }) => data(axiosInstance.post<ShareReceiveResult>("/api/115/share", { action: "receive", ...body }, { timeout: 180_000 })),
  },

  drive115: {
    /** 网盘目录内容（原始字段：cid / n / fc）；account 不传取第一个 115 账号 */
    list: (cid: number | string, account?: string) =>
      data(axiosInstance.post<Drive115Item[]>("/api/115/files", { cid, account })),
  },

  offline: {
    list: (account?: string, page = 1) =>
      data(axiosInstance.get<OfflineListPage>("/api/115/offline", { params: { account, page } })),
    /** 提交给 115 之前要解析目录，可能慢一点 */
    add: (input: OfflineAddInput) => data(axiosInstance.post<OfflineAddResponse>("/api/115/offline", input, { timeout: 60_000 })),
    remove: (body: { account?: string; infoHashes: string[]; deleteFiles?: boolean }) =>
      data(axiosInstance.post<{ success: true; removed: number }>("/api/115/offline/delete", body)),
    /** flag：0 已完成 / 1 全部 / 2 已失败 / 3 进行中 / 4 已完成+删源文件 / 5 全部+删源文件 */
    clear: (body: { account?: string; flag: number }) =>
      data(axiosInstance.post<{ success: true }>("/api/115/offline/clear", body)),
    restart: (body: { account?: string; infoHash: string }) =>
      data(axiosInstance.post<{ success: true }>("/api/115/offline/restart", body)),
    downPaths: (account?: string) =>
      data(axiosInstance.get<{ dirs: OfflineDownPath[] }>("/api/115/offline/downpath", { params: { account } })),
  },

  directory: {
    local: (basePath = "") => data(axiosInstance.post<DirectoryNode[]>("/api/directory/local/list", { basePath })),
    remote: (account: string, path = "") =>
      data(axiosInstance.post<DirectoryNode[]>("/api/directory/remote/list", { account, path })),
  },

  tmdb: {
    search: (query: string, language?: string) =>
      data(axiosInstance.post<TmdbSearchResult[]>("/api/library/tmdb/search", { query, language })),
  },

  hdhive: {
    search: (body: { query?: string; tmdbId?: number; mediaType?: "movie" | "tv" }) =>
      data(axiosInstance.post<HdhiveSearchResult>("/api/library/hdhive/search", body)),
    unlock: (slug: string) => data(axiosInstance.post<HdhiveUnlockResult>("/api/library/hdhive/unlock", { slug })),
  },

  life: {
    status: () => data(axiosInstance.get<LifeMonitorStatus>("/api/life/monitor")),
    events: (limit = 30) => data(axiosInstance.get<{ events: LifeEventRow[] }>(`/api/life/events?limit=${limit}`)),
    start: (config?: LifeMonitorSettings) =>
      data(
        axiosInstance.post<{ success: boolean; message: string; partial: boolean; status: LifeMonitorStatus }>(
          "/api/life/monitor",
          { config },
        ),
      ),
    stop: () => data(axiosInstance.delete<{ success: boolean; message: string }>("/api/life/monitor")),
    probe: (limit = 5, account?: string) =>
      data(axiosInstance.post<LifeProbeResult>("/api/life/probe", { limit, account })),
  },

  telegram: {
    status: () => data(axiosInstance.get<TelegramBotStatus>("/api/telegram/bot")),
    configure: (input: { botToken: string; chatId?: string }) =>
      data(axiosInstance.post<{ success: boolean; message: string }>("/api/telegram/bot", input)),
    remove: () => data(axiosInstance.delete<{ success: boolean; message: string }>("/api/telegram/bot")),
    test: () => data(axiosInstance.post<{ success: boolean }>("/api/telegram/test")),
    polling: {
      start: () => data(axiosInstance.post<{ success: boolean; message: string }>("/api/telegram/polling")),
      stop: () => data(axiosInstance.delete<{ success: boolean; message: string }>("/api/telegram/polling")),
      restart: () => data(axiosInstance.put<{ success: boolean; message: string }>("/api/telegram/polling")),
    },
    users: {
      add: (userId: string | number) => data(axiosInstance.post<{ success: boolean; message: string }>("/api/telegram/users", { userId })),
      remove: (userId: number) =>
        data(axiosInstance.delete<{ success: boolean; message: string }>(`/api/telegram/users?userId=${userId}`)),
    },
  },

  system: {
    clearDirectory: (targetPath: string) =>
      data(axiosInstance.post<{ message: string; clearedPath: string }>("/api/clearDirectory", { targetPath })),
    /** 一致性快照，返回文件内容和后端给的文件名 */
    backup: async (): Promise<{ blob: Blob; filename: string }> => {
      const res = await axiosInstance.get<Blob>("/api/system/backup", { responseType: "blob" });
      const disposition = String(res.headers["content-disposition"] ?? "");
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "openstrm.db";
      return { blob: res.data, filename };
    },
  },
};
