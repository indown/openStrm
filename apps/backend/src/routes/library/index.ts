import type { FastifyInstance } from "fastify";
import type { MediaLibraryEntry } from "@openstrm/shared";
import {
  getAll,
  getById,
  getByShareCode,
  insert,
  remove,
  update,
} from "../../db/repositories/media-library.js";
import { shareExtractPayload, getShareData } from "../../services/cloud-115/share.js";

function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function sanitizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const t = raw.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export default async function (fastify: FastifyInstance) {
  fastify.get("/api/library", { preHandler: [fastify.authenticate] }, async () => {
    return getAll();
  });

  fastify.post("/api/library", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const shareUrl = typeof body.shareUrl === "string" ? body.shareUrl.trim() : "";
    if (!shareUrl) {
      return reply.code(400).send({ code: 400, message: "shareUrl is required" });
    }

    let shareCode = "";
    let receiveCode = "";
    try {
      const parsed = shareExtractPayload(shareUrl);
      shareCode = parsed.share_code;
      receiveCode = parsed.receive_code;
    } catch {
      return reply.code(400).send({ code: 400, message: "Invalid share url" });
    }
    if (!shareCode) {
      return reply.code(400).send({ code: 400, message: "Cannot parse shareCode from url" });
    }

    const existing = getByShareCode(shareCode);
    if (existing) {
      return reply.code(409).send({ code: 409, message: "该分享已在影库中", data: existing });
    }

    let title = typeof body.title === "string" ? body.title.trim() : "";
    let fileCount = typeof body.fileCount === "number" ? body.fileCount : 0;

    if (!title || !fileCount) {
      const accounts = fastify.readAccounts();
      const account115 = accounts.find((a) => a.accountType === "115") as any;
      if (account115) {
        try {
          const data = (await getShareData(account115, shareCode, receiveCode)) as Record<string, any>;
          const shareInfo = (data?.share_info ?? {}) as Record<string, any>;
          if (!title) title = String(shareInfo.share_title ?? shareInfo.name ?? "").trim();
          if (!fileCount) fileCount = Number(shareInfo.file_size ?? shareInfo.file_count ?? 0) || 0;
        } catch {
          // ignore — allow saving without metadata enrichment
        }
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const entry: MediaLibraryEntry = {
      id: randomId(),
      shareUrl,
      shareCode,
      receiveCode,
      title,
      fileCount,
      coverUrl: typeof body.coverUrl === "string" ? body.coverUrl.trim() : "",
      tags: sanitizeTags(body.tags),
      notes: typeof body.notes === "string" ? body.notes : "",
      createdAt: now,
      updatedAt: now,
    };

    insert(entry);
    return reply.code(201).send(entry);
  });

  fastify.put("/api/library/:id", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    const existing = getById(id);
    if (!existing) {
      return reply.code(404).send({ code: 404, message: "Entry not found" });
    }

    const updates: Partial<MediaLibraryEntry> = {};
    if (typeof body.title === "string") updates.title = body.title.trim();
    if (typeof body.coverUrl === "string") updates.coverUrl = body.coverUrl.trim();
    if (typeof body.notes === "string") updates.notes = body.notes;
    if (Array.isArray(body.tags)) updates.tags = sanitizeTags(body.tags);
    if (typeof body.receiveCode === "string") updates.receiveCode = body.receiveCode.trim();

    const merged = update(id, updates);
    if (!merged) {
      return reply.code(404).send({ code: 404, message: "Entry not found" });
    }
    return merged;
  });

  fastify.delete("/api/library/:id", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = getById(id);
    if (!existing) {
      return reply.code(404).send({ code: 404, message: "Entry not found" });
    }
    remove(id);
    return { success: true };
  });
}
