/**
 * 分享详情里「加入影库」成功时广播一下：影库页开着就重新拉一次，新条目不用刷新页面就摆上去。
 * 分享详情弹框有好几个（顶栏、影库页、资源搜索页各一个），影库页只管听这一个事件
 */
export const LIBRARY_CHANGED_EVENT = "openstrm:library-changed";

export function notifyLibraryChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(LIBRARY_CHANGED_EVENT));
}
