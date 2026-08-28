import { and, desc, eq, lt, max } from "drizzle-orm";
import type { TaskExecutionHistory, TaskExecutionSummary } from "@openstrm/shared";
import { db } from "../client.js";
import { taskHistory } from "../schema.js";

type Row = typeof taskHistory.$inferSelect;
type SummaryRow = Omit<Row, "logs">;

/** 列表只取这些列：logs 是每条几千行的 JSON 块，列表里没人看 */
const summaryColumns = {
  id: taskHistory.id,
  taskId: taskHistory.taskId,
  startTime: taskHistory.startTime,
  endTime: taskHistory.endTime,
  status: taskHistory.status,
  summary: taskHistory.summary,
  taskInfo: taskHistory.taskInfo,
};

function deserializeSummary(row: SummaryRow): TaskExecutionSummary {
  return {
    id: row.id,
    taskId: row.taskId,
    startTime: row.startTime,
    endTime: row.endTime ?? undefined,
    status: row.status as TaskExecutionHistory["status"],
    summary: safeParse(row.summary, {
      totalFiles: 0,
      downloadedFiles: 0,
      deletedFiles: 0,
    }) as TaskExecutionHistory["summary"],
    taskInfo: safeParse(row.taskInfo, {
      account: "",
      originPath: "",
      targetPath: "",
      removeExtraFiles: false,
    }) as TaskExecutionHistory["taskInfo"],
  };
}

function deserialize(row: Row): TaskExecutionHistory {
  return { ...deserializeSummary(row), logs: safeParse(row.logs, []) as string[] };
}

function safeParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function insert(execution: TaskExecutionHistory): void {
  db.insert(taskHistory)
    .values({
      id: execution.id,
      taskId: execution.taskId,
      startTime: execution.startTime,
      endTime: execution.endTime ?? null,
      status: execution.status,
      logs: JSON.stringify(execution.logs ?? []),
      summary: JSON.stringify(execution.summary ?? {}),
      taskInfo: JSON.stringify(execution.taskInfo ?? {}),
    })
    .run();
}

export function update(executionId: string, updates: Partial<TaskExecutionHistory>): void {
  const row = db.select().from(taskHistory).where(eq(taskHistory.id, executionId)).get();
  if (!row) return;
  const current = deserialize(row);
  const merged = { ...current, ...updates };
  db.update(taskHistory)
    .set({
      taskId: merged.taskId,
      startTime: merged.startTime,
      endTime: merged.endTime ?? null,
      status: merged.status,
      logs: JSON.stringify(merged.logs ?? []),
      summary: JSON.stringify(merged.summary ?? {}),
      taskInfo: JSON.stringify(merged.taskInfo ?? {}),
    })
    .where(eq(taskHistory.id, executionId))
    .run();
}

/**
 * 追加一批日志行。logs 是一整块 JSON，每次追加都是读→解析→拼→序列化→写，
 * 所以调用方要攒一批再来（runner 用 LogBatcher），别一行一次。超过 5000 行只留最近 3000。
 */
export function appendLogs(executionId: string, lines: string[]): void {
  if (lines.length === 0) return;
  const row = db
    .select({ logs: taskHistory.logs })
    .from(taskHistory)
    .where(eq(taskHistory.id, executionId))
    .get();
  if (!row) return;
  let logs = safeParse<string[]>(row.logs, []);
  logs.push(...lines);
  if (logs.length > 5000) logs = logs.slice(-3000);
  db.update(taskHistory)
    .set({ logs: JSON.stringify(logs) })
    .where(eq(taskHistory.id, executionId))
    .run();
}

export function complete(
  executionId: string,
  status: "completed" | "failed" | "cancelled",
  summary?: Partial<TaskExecutionHistory["summary"]>,
): void {
  const row = db.select().from(taskHistory).where(eq(taskHistory.id, executionId)).get();
  if (!row) return;
  const current = deserialize(row);
  const merged = { ...current.summary, ...(summary ?? {}) };
  db.update(taskHistory)
    .set({
      status,
      endTime: Date.now(),
      summary: JSON.stringify(merged),
    })
    .where(eq(taskHistory.id, executionId))
    .run();
}

export function getById(executionId: string): TaskExecutionHistory | undefined {
  const row = db.select().from(taskHistory).where(eq(taskHistory.id, executionId)).get();
  return row ? deserialize(row) : undefined;
}

export function getByTaskId(taskId: string): TaskExecutionSummary[] {
  const rows = db
    .select(summaryColumns)
    .from(taskHistory)
    .where(eq(taskHistory.taskId, taskId))
    .orderBy(desc(taskHistory.startTime))
    .all();
  return rows.map(deserializeSummary);
}

/** 每个任务最近的一次执行（不带 logs）。任务列表页靠它显示"上次执行" */
export function getLatestPerTask(): TaskExecutionSummary[] {
  const latest = db
    .select({ taskId: taskHistory.taskId, startTime: max(taskHistory.startTime).as("max_start") })
    .from(taskHistory)
    .groupBy(taskHistory.taskId)
    .as("latest");
  const rows = db
    .select(summaryColumns)
    .from(taskHistory)
    .innerJoin(latest, and(eq(taskHistory.taskId, latest.taskId), eq(taskHistory.startTime, latest.startTime)))
    .all();
  // 同一毫秒两条记录（理论上）会各出一行，按 taskId 去重
  const seen = new Set<string>();
  const out: TaskExecutionSummary[] = [];
  for (const row of rows) {
    if (seen.has(row.taskId)) continue;
    seen.add(row.taskId);
    out.push(deserializeSummary(row));
  }
  return out;
}

export function getAll(): TaskExecutionSummary[] {
  const rows = db.select(summaryColumns).from(taskHistory).orderBy(desc(taskHistory.startTime)).all();
  return rows.map(deserializeSummary);
}

export function remove(executionId: string): void {
  db.delete(taskHistory).where(eq(taskHistory.id, executionId)).run();
}

export function removeAll(): void {
  db.delete(taskHistory).run();
}

export function cleanupOlderThan(cutoffMs: number): void {
  db.delete(taskHistory).where(lt(taskHistory.startTime, cutoffMs)).run();
}

/** 仍标着 running 的记录：执行早就随上个进程没了，标成 failed 并注明原因。返回处理条数 */
export function failInterrupted(reason: string): number {
  const rows = db.select().from(taskHistory).where(eq(taskHistory.status, "running")).all();
  if (rows.length === 0) return 0;
  db.transaction((tx) => {
    for (const row of rows) {
      const summary = { ...safeParse<Record<string, unknown>>(row.summary, {}), errorMessage: reason };
      tx.update(taskHistory)
        .set({ status: "failed", endTime: Date.now(), summary: JSON.stringify(summary) })
        .where(eq(taskHistory.id, row.id))
        .run();
    }
  });
  return rows.length;
}
