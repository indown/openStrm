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
  TaskDefinition,
  TaskExecutionHistory,
  TaskExecutionSummary,
} from "@openstrm/shared";

/* ------------------------------- 类型 ------------------------------- */

export type TaskStatus = "pending" | "processing";
/** GET /api/task 的行：任务定义 + 运行状态。strmType 是表单存的附加字段 */
export type TaskRow = TaskDefinition & { status: TaskStatus; strmType?: string };
/** 表单提交的任务字段；必填项由后端 schema 把关，这里只描述形状 */
export type TaskInput = Partial<Omit<TaskDefinition, "id">> & { strmType?: string };

export type StartTaskResult = {
  message: string;
  taskId?: string;
  extraFilesCount?: number;
  willDeleteExtraFiles?: boolean;
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
export type SaveToTaskChoice = { taskId: string; subPath: string; mode: "sync" | "async" };

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
export type LifeMonitorStatus = {
  running: boolean;
  account: string | null;
  cursor: { fromTime: number; fromId: string };
  interval: number;
  eventModes: LifeEventMode[];
  api: "web" | "ios" | "android";
  startedAt: number | null;
  lastPollAt: number | null;
  lastError: string | null;
  stats: { rounds: number; events: number; handled: number; skipped: number; failed: number };
  db: { lifeEvents: number; pathCache: number };
  embyRefresh: { configured: boolean; pendingCount: number; pendingSince: number | null };
  logs: string[];
};
export type LifeEventRow = {
  id: string;
  type: number;
  typeName: string;
  fileName: string;
  fileCategory: number;
  updateTime: number;
  status: string;
  detail: string;
};

export interface TelegramBotInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
  can_join_groups: boolean;
  can_read_all_group_messages: boolean;
  supports_inline_queries: boolean;
}
export interface TelegramWebhookInfo {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
  max_connections?: number;
  allowed_updates?: string[];
}
export type TelegramBotStatus =
  | { configured: false }
  | {
      configured: true;
      bot: { result: TelegramBotInfo };
      webhook: { result?: TelegramWebhookInfo };
      chatId: string;
      botToken: string;
    };
export type TelegramPollingStatus = { polling: boolean; webhook?: TelegramWebhookInfo; message: string };

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
      data(axiosInstance.post<ShareReceiveResult>(`/api/library/${id}/save-to-task`, choice)),
  },

  share: {
    info: (url: string) => data(axiosInstance.post<ShareInfo>("/api/115/share", { action: "info", url })),
    list: (url: string, cid: string | number = 0, page?: { limit: number; offset: number }) =>
      data(axiosInstance.post<ShareListPage>("/api/115/share", { action: "list", url, cid, ...page })),
    /** 转存到任务目录（带 taskId）或网盘目录（带 toPid） */
    receive: (body: {
      url: string;
      fileIds: string[];
      taskId?: string;
      subPath?: string;
      mode?: "sync" | "async";
      selectedItems?: { name: string; isDir: boolean }[];
      toPid?: string | number;
    }) => data(axiosInstance.post<ShareReceiveResult>("/api/115/share", { action: "receive", ...body })),
  },

  drive115: {
    /** 网盘目录内容（原始字段：cid / n / fc） */
    list: (cid: number) => data(axiosInstance.post<Drive115Item[]>("/api/115/files", { cid })),
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
      data(axiosInstance.post<{ success: boolean; message: string; status: LifeMonitorStatus }>("/api/life/monitor", { config })),
    stop: () => data(axiosInstance.delete<{ success: boolean; message: string }>("/api/life/monitor")),
    probe: (limit = 5) => data(axiosInstance.post<{ ok: boolean; message: string }>("/api/life/probe", { limit })),
  },

  telegram: {
    bot: {
      get: () => data(axiosInstance.get<TelegramBotStatus>("/api/telegram/bot")),
      configure: (input: { botToken: string; chatId?: string; webhookUrl?: string }) =>
        data(axiosInstance.post<{ success: boolean; bot: TelegramBotInfo; chatId: string; message: string }>("/api/telegram/bot", input)),
      remove: () => data(axiosInstance.delete<{ success: boolean; message: string }>("/api/telegram/bot")),
    },
    polling: {
      status: () => data(axiosInstance.get<TelegramPollingStatus>("/api/telegram/polling")),
      start: () => data(axiosInstance.post<{ success: boolean; message: string }>("/api/telegram/polling")),
      stop: () => data(axiosInstance.delete<{ success: boolean; message: string }>("/api/telegram/polling")),
    },
    users: {
      list: () => data(axiosInstance.get<{ users: { id: number }[] }>("/api/telegram/users")),
      add: (userId: string | number) => data(axiosInstance.post<{ success: boolean; message: string }>("/api/telegram/users", { userId })),
      remove: (userId: number) =>
        data(axiosInstance.delete<{ success: boolean; message: string }>(`/api/telegram/users?userId=${userId}`)),
    },
    send: (body: { message?: string; type?: string; data?: unknown }) =>
      data(axiosInstance.post<{ success: boolean }>("/api/telegram/send", body)),
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
