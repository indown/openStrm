/**
 * 检查更新：当前跑的版本 vs GitHub 上最新的发布。
 * 只读一个匿名接口、不带任何数据；结果缓存在库里，页面读缓存，不会因为刷新页面就去联网。
 */

/** GitHub 上的一次发布 */
export interface UpdateRelease {
  /** 裸版本号（去掉 v 前缀）：2.8.0 */
  version: string;
  /** git tag：v2.8.0 */
  tag: string;
  /** 发布页地址 */
  url: string;
  /** 秒 */
  publishedAt: number;
  prerelease: boolean;
  /** 更新说明原文（Markdown），长了会截断 */
  notes: string;
}

/** 上一次检查的结果，存在 settings 表的 `update.state` 里 */
export interface UpdateState {
  /** 秒；0 = 从来没查过 */
  checkedAt: number;
  /** 这一次查成功没有 */
  ok: boolean;
  /** 失败原因（连不上、被限流、回的东西看不懂）；成功就是空串 */
  error: string;
  /** 查到的最新发布；查失败时保留上一次的结果 */
  latest: UpdateRelease | null;
  /** 已经推过 Telegram 的版本：同一个版本只推一次 */
  notifiedVersion: string;
}

/** GET /api/update */
export interface UpdateStatus {
  /** 当前跑的版本（裸版本号） */
  current: string;
  /** 定时检查开着没有 */
  enabled: boolean;
  /** 有没有比当前新的版本 */
  outdated: boolean;
  /** 正在查 */
  checking: boolean;
  state: UpdateState;
}
