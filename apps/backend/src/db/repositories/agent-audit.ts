import { desc, eq, lt } from "drizzle-orm";
import type { AgentCall } from "@openstrm/shared";
import { db } from "../client.js";
import { agentAudit } from "../schema.js";

type Row = typeof agentAudit.$inferSelect;

function deserialize(row: Row): AgentCall {
  return {
    id: row.id,
    tokenId: row.tokenId,
    tokenName: row.tokenName,
    ip: row.ip,
    tool: row.tool,
    args: row.args,
    ok: row.ok,
    error: row.error,
    durationMs: row.durationMs,
    at: row.at,
  };
}

export function recordAgentCall(entry: Omit<AgentCall, "id" | "at"> & { at?: number }): void {
  db.insert(agentAudit)
    .values({
      tokenId: entry.tokenId,
      tokenName: entry.tokenName,
      ip: entry.ip,
      tool: entry.tool,
      args: entry.args,
      ok: entry.ok,
      error: entry.error,
      durationMs: entry.durationMs,
      ...(entry.at !== undefined ? { at: entry.at } : {}),
    })
    .run();
}

/** 最近的调用，新的在前；给了 tokenId 就只看这个令牌的 */
export function listAgentCalls(opts: { tokenId?: string; limit?: number } = {}): AgentCall[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const q = db.select().from(agentAudit);
  const rows = (opts.tokenId ? q.where(eq(agentAudit.tokenId, opts.tokenId)) : q)
    .orderBy(desc(agentAudit.at), desc(agentAudit.id))
    .limit(limit)
    .all();
  return rows.map(deserialize);
}

export function deleteAgentCallsBefore(ts: number): number {
  return db.delete(agentAudit).where(lt(agentAudit.at, ts)).run().changes;
}
