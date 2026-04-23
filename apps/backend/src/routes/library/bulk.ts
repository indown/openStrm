import type { FastifyInstance } from "fastify";
import type { MediaLibraryEntry } from "@openstrm/shared";
import {
  bulkInsert,
  getById,
  getPending,
  setScrapeStatus,
} from "../../db/repositories/media-library.js";
import { enqueue, enqueueOne, status as workerStatus } from "../../services/library/scrape-worker.js";
import { randomId, sanitizeTags, shareRootCidForDb } from "./_util.js";

interface BulkCandidate {
  shareCode: string;
  receiveCode: string;
  shareUrl: string;
  sharePath: string;
  shareRootCid: number | string;
  rawName: string;
  title: string;
  year: string;
  fileCount: number;
  tags?: string[];
  notes?: string;
}

export default async function (fastify: FastifyInstance) {
  fastify.post(
    "/api/library/bulk-insert",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const rawItems = Array.isArray(body.items) ? body.items : [];
      if (rawItems.length === 0) return reply.code(400).send({ code: 400, message: "items is empty" });

      const commonTags = sanitizeTags(body.commonTags);
      const settings = fastify.readSettings();
      const hasTmdb = Boolean(settings.tmdb?.apiKey?.trim());

      const now = Math.floor(Date.now() / 1000);
      const entries: MediaLibraryEntry[] = [];

      for (const raw of rawItems) {
        if (!raw || typeof raw !== "object") continue;
        const c = raw as Partial<BulkCandidate>;
        const shareCode = typeof c.shareCode === "string" ? c.shareCode.trim() : "";
        const shareUrl = typeof c.shareUrl === "string" ? c.shareUrl.trim() : "";
        const sharePath = typeof c.sharePath === "string" ? c.sharePath : "";
        if (!shareCode || !shareUrl || !sharePath) continue;
        const rawName = typeof c.rawName === "string" ? c.rawName : "";
        const title = typeof c.title === "string" && c.title.trim() ? c.title.trim() : rawName;
        const tags = Array.from(new Set([...commonTags, ...sanitizeTags(c.tags)]));

        entries.push({
          id: randomId(),
          shareUrl,
          shareCode,
          receiveCode: typeof c.receiveCode === "string" ? c.receiveCode : "",
          sharePath,
          shareRootCid: shareRootCidForDb(c.shareRootCid),
          rawName,
          title,
          fileCount: typeof c.fileCount === "number" ? c.fileCount : Number(c.fileCount ?? 0) || 0,
          coverUrl: "",
          tags,
          notes: typeof c.notes === "string" ? c.notes : "",
          mediaType: "unknown",
          tmdbId: null,
          year: typeof c.year === "string" ? c.year : "",
          overview: "",
          scrapeStatus: hasTmdb ? "pending" : "done",
          createdAt: now,
          updatedAt: now,
        });
      }

      if (entries.length === 0) return reply.code(400).send({ code: 400, message: "no valid items" });

      const { inserted, skipped, insertedIds } = bulkInsert(entries);

      if (hasTmdb && insertedIds.length > 0) enqueue(insertedIds);

      return reply.code(201).send({ inserted, skipped });
    },
  );

  fastify.get(
    "/api/library/scrape-status",
    { preHandler: [fastify.authenticate] },
    async () => {
      const pending = getPending();
      const s = workerStatus();
      return {
        code: 200,
        data: {
          pendingIds: pending.map((e) => e.id),
          pendingCount: pending.length,
          active: s.active,
          queued: s.queued,
        },
      };
    },
  );

  fastify.post(
    "/api/library/:id/scrape",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const entry = getById(id);
      if (!entry) return reply.code(404).send({ code: 404, message: "Entry not found" });

      const settings = fastify.readSettings();
      const hasTmdb = Boolean(settings.tmdb?.apiKey?.trim());
      if (!hasTmdb) {
        return reply.code(400).send({ code: 400, message: "TMDB 未配置，请先在设置中填入 API Key" });
      }

      setScrapeStatus(id, "pending");
      enqueueOne(id);
      return { code: 200, data: { id, status: "pending" } };
    },
  );
}
