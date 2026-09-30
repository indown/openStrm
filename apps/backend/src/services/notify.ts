/**
 * 主动推送的端口。业务代码只描述"发生了什么"（NotifyEvent），往这里发；
 * 渠道（Telegram，见 telegram/notify.ts）在启动时登记进来，各自决定发不发、怎么发。
 *
 *   - 领域模块只 import 这个文件，不认识任何具体渠道。
 *   - 渠道抛错只记日志，绝不抛到调用方；没登记渠道时（测试里、还没配）什么也不发、回 false。
 *   - 通知开关（notifyPrefs）也放这里：它是「通知偏好」，虽然眼下存在 settings.telegram.notify 下面。
 */
import type { AppSettings, OrganizeErrorKind, TaskDefinition, TelegramNotifySettings } from "@openstrm/shared";
import type { AccountIssue as DriveAccountIssue } from "./drive/types.js";
import { moduleLogger } from "../lib/logger.js";

const log = moduleLogger("notify");

/** 通知里带的任务：够渲染一行「远程 → 本地」和账号名 */
export type TaskRef = Pick<TaskDefinition, "id" | "originPath" | "targetPath" | "account">;

export type TaskTrigger = "manual" | "cron" | "telegram" | "share" | "agent";

export type NotifyEvent =
  | { type: "task-start"; task: TaskRef; total: number; trigger?: TaskTrigger }
  | {
      type: "task-done";
      task: TaskRef;
      status: "completed" | "failed" | "cancelled";
      total: number;
      finished: number;
      failed: number;
      durationMs: number;
      message?: string;
      /** 数量最多那一类失败的处理建议（整轮停时已经在 message 里） */
      advice?: string;
    }
  /** issue：网盘自己认出的账号问题（见 issueFromDrive）；没给就从 reason 文案里猜 */
  | { type: "task-start-failed"; task: TaskRef; reason: string; trigger?: TaskTrigger; issue?: AccountIssue | null }
  | { type: "offline-done"; name: string; detail: string; target: string }
  | { type: "offline-failed"; name: string; detail: string }
  /** 云下载完成后由 OpenList 复制到了目标目录。旧名字，留一轮给存量的调用方 */
  | { type: "offline-copied"; name: string; target: string }
  /** 云下载的「复制到 OpenList」没走完；旧名字，留一轮 */
  | { type: "offline-copy-failed"; name: string; detail: string }
  /**
   * OpenList 复制完了；一轮里完成的合成一条（队列是一个文件一条记录，逐条发会被限流吞掉）。
   * kept：源文件没按设置删 / 归档的原因；retrying：删 / 归档碰上临时错误、稍后自动再试的
   */
  | { type: "copy-done"; names: string[]; target: string; source: string; kept?: string[]; retrying?: string[] }
  /** 复制早就完成了，源文件的删 / 归档晚点再做也没成（或者核对没过）：收场时说一声，不然人一直以为稍后会处理 */
  | { type: "copy-kept"; source: string; kept: string[] }
  /** OpenList 复制失败，detail 里说清楚在哪一步 */
  | { type: "copy-failed"; names: string[]; detail: string; source: string }
  /** 追更转存了新文件 */
  | { type: "follow-added"; name: string; added: string[]; generated: number; target: string }
  /** 追更连续几次检查失败；按订阅 id 一小时只说一次 */
  | { type: "follow-failed"; id: string; name: string; detail: string }
  /** 分享已经打不开了，订阅已停；id 给「搜替代资源」按钮用 */
  | { type: "follow-expired"; id: string; name: string; reason: string }
  /** 太久没更新，订阅已自动暂停 */
  | { type: "follow-stale"; id: string; name: string; days: number }
  /** 收藏夹巡检确认有分享失效了（正在用时发现的由界面当场说，不推） */
  | { type: "library-expired"; shareCode: string; shareTitle: string; sources: number }
  /** OpenStrm 有新版本（默认关，同一个版本只推一次） */
  | { type: "update-available"; version: string; current: string; url: string }
  /** Emby 把新条目收进媒体库了；groups 为空表示这批太多、只报总数 */
  | { type: "emby-new"; groups: EmbyNewGroup[]; total: number }
  /** 整理执行完了 */
  | {
      type: "organize-done";
      task: TaskRef;
      runId: string;
      units: number;
      done: number;
      failed: number;
      reverted?: boolean;
      /** 还等着处理的失败按类别（transient / blocked / stale / rejected / mirror） */
      failedByKind?: Partial<Record<Exclude<OrganizeErrorKind, "">, number>>;
      /** 撤销：没退回的项数 */
      notReverted?: number;
    }
  /** 自动整理生成了待确认的清单（review 模式，或 auto 模式下有拿不准的） */
  | { type: "organize-review"; task: TaskRef; runId: string; units: number; planned: number; unsure: number; conflicts: number }
  /**
   * 账号层面的问题（cookie 失效、被封控）。issue 是调用方用网盘自己的规则认出来的（见 issueFromDrive）；
   * 没给就从 reason 文案里猜（115 的中文），两样都认不出就不发
   */
  | { type: "account-alert"; account: string; reason: string; source: string; issue?: AccountIssue | null };

export const DEFAULT_NOTIFY: Required<TelegramNotifySettings> = {
  taskStart: false,
  taskDone: true,
  taskFailed: true,
  offline: true,
  accountAlert: true,
  follow: true,
  embyNew: true,
  organize: true,
  update: false,
  library: true,
};

export function notifyPrefs(settings: AppSettings): Required<TelegramNotifySettings> {
  return { ...DEFAULT_NOTIFY, ...(settings.telegram?.notify ?? {}) };
}

/** Emby 入库通知里的一组：一部剧的一季，或一部电影 */
export interface EmbyNewGroup {
  kind: "tv" | "movie";
  name: string;
  year?: number;
  season?: number;
  /** 已排序去重的集号；specials 可能拿不到集号，count 才是准数 */
  episodes: number[];
  count: number;
}

export type AccountIssue = "cookie" | "blocked";

/** 网盘 Provider.classifyError 的结果换成通知这边的两档：分享失效（gone）不是账号问题 */
export function issueFromDrive(issue: DriveAccountIssue | null | undefined): AccountIssue | null {
  if (issue === "auth") return "cookie";
  if (issue === "blocked") return "blocked";
  return null;
}

/* ------------------------------- 渠道 ------------------------------- */

/** 一个通知渠道：收到事件后自己决定发不发，回是否真的发出去了 */
export type NotifySink = (event: NotifyEvent) => Promise<boolean>;

const sinks = new Set<NotifySink>();

/** 登记一个渠道（启动时 index.ts 登记 Telegram）；返回注销函数 */
export function registerNotifySink(sink: NotifySink): () => void {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

/** 发一条通知给登记的每个渠道：任一渠道发出去了就算发了。渠道抛错只记日志；没有渠道时回 false */
export async function notify(event: NotifyEvent): Promise<boolean> {
  let sent = false;
  for (const sink of [...sinks]) {
    try {
      if (await sink(event)) sent = true;
    } catch (err) {
      log.warn({ err, type: event.type }, "通知渠道出错");
    }
  }
  return sent;
}
