/**
 * 同步任务里单个文件失败的类别（后端 services/download/failure.ts 分的）在界面上的文案。
 * 事件和执行历史里带的 message / advice 已经是人话，这里只管类别名和按钮。
 */
import type { FileFailureAction, FileFailureKind } from "@openstrm/shared";

export const FILE_FAILURE_LABEL: Record<FileFailureKind, string> = {
  "name-too-long": "文件名过长",
  "invalid-name": "文件名含不允许的字符",
  "name-conflict": "同名文件和目录撞了",
  "no-space": "磁盘满",
  permission: "没有写入权限",
  "read-only": "只读挂载",
  "fs-transient": "本地临时错误",
  "io-error": "存储层出错",
  gone: "网盘上已没有",
  auth: "登录失效",
  blocked: "被风控",
  network: "网络错误",
  unknown: "其它错误",
};

/** 失败项旁边的按钮去哪、叫什么 */
export function failureActionLink(action: FileFailureAction, taskId: string): { href: string; label: string } {
  switch (action.type) {
    case "organize": {
      const params = new URLSearchParams({ task: taskId });
      if (action.subPath) params.set("path", action.subPath);
      return { href: `/organize?${params}`, label: "去整理这个目录" };
    }
    case "account":
      return { href: "/account", label: "查看账号" };
    case "settings":
      return { href: "/settings", label: "打开设置" };
  }
}
