/** 检查更新的小事件：设置页查完之后让侧栏的角标立刻跟上，不用等它自己那一轮 */
export const UPDATE_CHANGED_EVENT = "openstrm:update-changed";

export function notifyUpdateChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(UPDATE_CHANGED_EVENT));
}
