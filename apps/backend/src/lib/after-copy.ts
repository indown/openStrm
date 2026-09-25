/**
 * 「复制到 OpenList」复制成功后源文件的去向（不动 / 删除 / 归档）：任务设置、复制记录、云下载回执共用的小工具。
 * 老数据只有 `deleteSource` 一个布尔，这里把它收成 `afterCopy`，别的代码只认 `afterCopy`。
 * 放在 lib 里是因为数据库仓库层（读任务时归一）和服务层都要用，服务层的模块不该被仓库层反向依赖。
 */
import type { CopyAfterCopy, TaskCopySettings } from "@openstrm/shared";

export const AFTER_COPY_VALUES = ["keep", "delete", "archive"] as const satisfies readonly CopyAfterCopy[];

/** 界面和说明里的叫法 */
export const AFTER_COPY_LABEL: Record<CopyAfterCopy, string> = { keep: "不动", delete: "删除", archive: "归档" };

/** 任务上复制成功后源文件怎么办：新字段优先，老数据按 deleteSource 算，都没有就是不动 */
export function afterCopyOf(cfg: Pick<TaskCopySettings, "afterCopy" | "deleteSource"> | undefined | null): CopyAfterCopy {
  return cfg?.afterCopy ?? (cfg?.deleteSource === true ? "delete" : "keep");
}

/** 把任务上的旧字段收成 afterCopy（读出来、写进去都过一遍）；没带旧字段的原样还回去（afterCopy 没填就是不动，不硬写） */
export function normalizeTaskCopy(cfg: TaskCopySettings | undefined): TaskCopySettings | undefined {
  if (!cfg || cfg.deleteSource === undefined) return cfg;
  const { deleteSource: _legacy, ...rest } = cfg;
  return { ...rest, afterCopy: afterCopyOf(cfg) };
}
