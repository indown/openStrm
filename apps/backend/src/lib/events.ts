/**
 * 进程内的类型化事件。事件有哪些、谁发谁听，登记在 services/events.ts。
 *
 *   - 同步派发：emit 逐个调监听者；监听者抛错只记日志、不外抛——发事件的一方不该因为听的一方出错而失败。
 *   - 不排队、不持久化：进程内够用，出错的地方就在调用栈里。
 *   - on 返回注销函数；removeAll 只给测试收尾用。
 */
import type { moduleLogger } from "./logger.js";

type Logger = ReturnType<typeof moduleLogger>;

export interface TypedEmitter<E extends object> {
  on<K extends keyof E & string>(name: K, listener: (payload: E[K]) => void): () => void;
  off<K extends keyof E & string>(name: K, listener: (payload: E[K]) => void): void;
  emit<K extends keyof E & string>(name: K, payload: E[K]): void;
  /** 仅供测试：清掉所有监听者 */
  removeAll(): void;
}

export function createEmitter<E extends object>(log: Logger): TypedEmitter<E> {
  const listeners = new Map<string, Set<(payload: never) => void>>();
  return {
    on(name, listener) {
      let set = listeners.get(name);
      if (!set) {
        set = new Set();
        listeners.set(name, set);
      }
      set.add(listener as (payload: never) => void);
      return () => {
        set.delete(listener as (payload: never) => void);
      };
    },
    off(name, listener) {
      listeners.get(name)?.delete(listener as (payload: never) => void);
    },
    emit(name, payload) {
      const set = listeners.get(name);
      if (!set) return;
      // 拷一份再遍历：监听者里注销自己不影响这一轮
      for (const listener of [...set]) {
        try {
          (listener as (payload: E[typeof name]) => void)(payload);
        } catch (err) {
          log.warn({ err, event: name }, "事件监听者出错");
        }
      }
    },
    removeAll() {
      listeners.clear();
    },
  };
}
