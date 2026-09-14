/**
 * 失败类别的名字：通知和日志用。单独一个没有依赖的小模块，telegram/notify 引它不会把网盘客户端一起拉进来。
 * 界面上的文案在前端 lib/organize.ts 自己维护。
 */
import type { OrganizeErrorKind } from "@openstrm/shared";

/** classifyFailure 能给出的类别（mirror 不经它，由 run.ts 直接记） */
export type FailureKind = Exclude<OrganizeErrorKind, "" | "mirror">;

export const FAILURE_LABEL: Record<Exclude<OrganizeErrorKind, "">, string> = {
  transient: "临时失败",
  blocked: "网盘拒绝",
  stale: "预览后变了",
  rejected: "名字不被接受",
  mirror: "本地未同步",
};
