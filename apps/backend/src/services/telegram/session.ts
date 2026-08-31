/**
 * 多步交互的中间状态：用户贴了链接、机器人问"下到哪里"、用户点按钮。
 * callback_data 最多 64 字节，装不下链接本身，所以把待处理的内容存在内存里，按钮只带一个短 token。
 * 进程重启就没了——十分钟内没点的按钮再点会提示"已过期，重新发一次链接"。
 */
import { randomBytes } from "node:crypto";

/** 选完目的地后的目录浏览状态：往哪一层放、当前层有哪些子目录（按钮按序号引用，中文目录名塞不进 callback_data 的 64 字节） */
export interface BrowseState {
  /** 浏览任务目录时的任务 id；OpenList 目的地浏览（openlistBase 模式）下是空串 */
  taskId: string;
  /**
   * 「115 默认目录 + OpenList 复制走」的目的地浏览：根是进入浏览时设置页的 dstDir，
   * 冻结在这里；设上就代表在浏览 OpenList，segments 相对它
   */
  openlistBase?: string;
  /** 已进入的子目录段，相对 task.originPath / openlistBase */
  segments: string[];
  /** 当前层的子目录名 */
  dirs: string[];
  /** 当前显示的页码（0 起） */
  page: number;
}

export type PendingAction =
  | { kind: "offline"; urls: string[]; browse?: BrowseState }
  | {
      kind: "share";
      link: string;
      shareCode: string;
      receiveCode: string;
      name: string;
      fileIds: string[];
      items: Array<{ name: string; isDir: boolean }>;
      browse?: BrowseState;
    };

export interface Pending {
  token: string;
  chatId: string;
  userId: number;
  action: PendingAction;
  createdAt: number;
}

const TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 200;
const store = new Map<string, Pending>();

function prune(now = Date.now()): void {
  for (const [token, p] of store) if (now - p.createdAt > TTL_MS) store.delete(token);
  // 极端情况下（有人狂贴链接）只留最新的
  while (store.size > MAX_PENDING) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

export function createPending(chatId: string | number, userId: number, action: PendingAction): string {
  prune();
  const token = randomBytes(6).toString("base64url");
  store.set(token, { token, chatId: String(chatId), userId, action, createdAt: Date.now() });
  return token;
}

/** 取走：一个 token 只能用一次，连点两下不会重复提交 */
export function takePending(token: string): Pending | null {
  prune();
  const p = store.get(token) ?? null;
  if (p) store.delete(token);
  return p;
}

/** 看一眼但不取走：选任务 → 逐层进目录是多步交互，同一个 token 要用到「就放这里」 */
export function peekPending(token: string): Pending | null {
  prune();
  return store.get(token) ?? null;
}

/** 更新交互状态。createdAt 不刷新：整套操作限在 10 分钟内做完 */
export function updatePending(token: string, action: PendingAction): void {
  const p = store.get(token);
  if (p) p.action = action;
}

export function __test_clearPending(): void {
  store.clear();
}
