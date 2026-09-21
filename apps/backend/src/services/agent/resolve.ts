/**
 * 模型说「电影任务」「tv」，这里认出是哪个同步任务。任务没有名称字段，界面上的叫法是「账号 · 网盘路径」，
 * 所以依次比：id → 网盘路径 / 本地路径（完整）→ 「账号 · 网盘路径」→ 路径最后一段 → 包含关系。
 * 每一步只要唯一命中就用；命中多个就报错并列出候选，让模型拿 id 再来。
 */
import type { TaskDefinition } from "@openstrm/shared";
import { listTasks } from "../../db/repositories/tasks.js";
import { ToolError } from "./define.js";

const norm = (p: string) =>
  p
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
const lastSegment = (p: string) => norm(p).split("/").pop() ?? "";

/** 模型看到的任务样子：label 就是界面上的叫法 */
export function taskBrief(task: TaskDefinition): { id: string; label: string; account: string; drivePath: string; localPath: string } {
  return {
    id: task.id,
    label: `${task.account} · ${task.originPath}`,
    account: task.account,
    drivePath: task.originPath,
    localPath: task.targetPath,
  };
}

export function resolveTask(ref: string, tasks: TaskDefinition[] = listTasks()): TaskDefinition {
  const q = ref.trim();
  if (!q) throw new ToolError("VALIDATION", "task 不能为空", "用 tasks_list 看有哪些任务。");
  const byId = tasks.find((t) => t.id === q);
  if (byId) return byId;

  const n = norm(q);
  const steps: Array<(t: TaskDefinition) => boolean> = [
    (t) => norm(t.originPath) === n || norm(t.targetPath) === n,
    (t) => norm(`${t.account} · ${t.originPath}`) === n || norm(`${t.account}/${t.originPath}`) === n,
    (t) => lastSegment(t.originPath) === n || lastSegment(t.targetPath) === n,
    (t) => norm(t.originPath).includes(n) || norm(t.targetPath).includes(n),
  ];
  for (const match of steps) {
    const hits = tasks.filter(match);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      throw new ToolError("AMBIGUOUS_TASK", `「${q}」能对上 ${hits.length} 个任务`, "用候选里的 id 再调一次。", {
        candidates: hits.slice(0, 10).map(taskBrief),
      });
    }
  }
  throw new ToolError("TASK_NOT_FOUND", `没有找到任务「${q}」`, "用 tasks_list 看有哪些任务，传 id 最稳。");
}
