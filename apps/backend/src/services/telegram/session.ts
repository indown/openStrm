/**
 * 多步交互的中间状态：用户贴了链接、机器人问"下到哪里"、用户点按钮。
 * callback_data 最多 64 字节，装不下链接本身，所以把待处理的内容存在内存里，按钮只带一个短 token。
 * 进程重启就没了——十分钟内没点的按钮再点会提示"已过期，重新发一次链接"。
 */
import { randomBytes } from "node:crypto";

export type PendingAction =
  | { kind: "offline"; urls: string[] }
  | {
      kind: "share";
      link: string;
      shareCode: string;
      receiveCode: string;
      name: string;
      fileIds: string[];
      items: Array<{ name: string; isDir: boolean }>;
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

export function __test_clearPending(): void {
  store.clear();
}
