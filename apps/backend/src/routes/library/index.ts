import type { FastifyInstance } from "fastify";
import type { MediaLibraryEntry } from "@openstrm/shared";
import {
  bulkInsert,
  getAll,
  getById,
  getByShareCode,
  getByShareCodeAndPath,
  insert,
  remove,
  update,
} from "../../db/repositories/media-library.js";
import { shareExtractPayload, getShareData } from "../../services/cloud-115/share.js";
import { scanShare } from "../../services/library/scan.js";
import { enqueue, enqueueOne } from "../../services/library/scrape-worker.js";
import { normalizeTitle } from "../../services/media-title.js";
import { randomId, sanitizeTags, shareRootCidForDb } from "./_util.js";

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

    const settings = fastify.readSettings();
    const hasTmdb = Boolean(settings.tmdb?.apiKey?.trim());
    const userAgent = typeof settings["user-agent"] === "string" ? settings["user-agent"] : undefined;
    const bodyTitle = typeof body.title === "string" ? body.title.trim() : "";
    const bodyCoverUrl = typeof body.coverUrl === "string" ? body.coverUrl.trim() : "";
    const bodyTags = sanitizeTags(body.tags);
    const bodyNotes = typeof body.notes === "string" ? body.notes : "";
    const cidStr = shareRootCidForDb(body.cid);
    const hasCidFromClient = Boolean(cidStr && cidStr !== "0");
    const bodyRawName = typeof body.rawName === "string" ? body.rawName.trim() : "";

    const now = Math.floor(Date.now() / 1000);

    // ==== 子目录直接入库模式：前端已定位到具体子目录 ====
    if (hasCidFromClient && bodyRawName) {
      const bodyPath =
        typeof body.sharePath === "string"
          ? body.sharePath.split("/").map((s) => s.trim()).filter(Boolean).join("/")
          : "";
      const sharePath = bodyPath ? `/${bodyPath}` : `/${bodyRawName}`;
      const existing = getByShareCodeAndPath(shareCode, sharePath);
      if (existing) {
        return reply.code(409).send({ code: 409, message: "该子目录已在影库中", data: existing });
      }
      const bodyFileCount = typeof body.fileCount === "number" ? body.fileCount : Number(body.fileCount ?? 0) || 0;
      const { title: normTitle, year: normYear } = normalizeTitle(bodyRawName);
      const entry: MediaLibraryEntry = {
        id: randomId(),
        shareUrl,
        shareCode,
        receiveCode,
        sharePath,
        shareRootCid: cidStr,
        rawName: bodyRawName,
        title: bodyTitle || normTitle || bodyRawName,
        fileCount: bodyFileCount,
        coverUrl: bodyCoverUrl,
        tags: bodyTags,
        notes: bodyNotes,
        mediaType: "unknown",
        tmdbId: null,
        year: normYear || "",
        overview: "",
        scrapeStatus: hasTmdb && !bodyCoverUrl ? "pending" : "done",
        createdAt: now,
        updatedAt: now,
      };
      insert(entry);
      if (entry.scrapeStatus === "pending") enqueueOne(entry.id);
      return reply.code(201).send({ mode: "subdir", entry });
    }

    const accounts = fastify.readAccounts();
    const account115 = accounts.find((a) => a.accountType === "115") as any;

    // 先扫一层顶层目录：>=2 子目录走合集拆分，否则走单片
    let subdirCount = 0;
    let scanCandidates: Awaited<ReturnType<typeof scanShare>>["candidates"] = [];
    if (account115) {
      try {
        const scan = await scanShare({ accountInfo: account115, shareUrl, userAgent });
        scanCandidates = scan.candidates;
        subdirCount = scanCandidates.length;
      } catch (err) {
        fastify.log.warn({ err }, "[library] top-level scan failed, falling back to single mode");
      }
    }

    // ==== 合集模式：>=2 子目录 ====
    if (subdirCount >= 2) {
      if (bodyTitle || bodyCoverUrl) {
        fastify.log.info(
          { subdirCount },
          "[library] collection detected, ignoring client-supplied title/coverUrl",
        );
      }
      const entries: MediaLibraryEntry[] = scanCandidates.map((c) => ({
        id: randomId(),
        shareUrl,
        shareCode,
        receiveCode,
        sharePath: `/${c.rawName}`,
        shareRootCid: shareRootCidForDb(c.cid),
        rawName: c.rawName,
        title: c.normalizedTitle || c.rawName,
        fileCount: c.fileCount || 0,
        coverUrl: "",
        tags: bodyTags,
        notes: bodyNotes,
        mediaType: "unknown",
        tmdbId: null,
        year: c.year || "",
        overview: "",
        scrapeStatus: hasTmdb ? "pending" : "done",
        createdAt: now,
        updatedAt: now,
      }));
      const { inserted, skipped, insertedIds } = bulkInsert(entries);
      if (hasTmdb && insertedIds.length > 0) enqueue(insertedIds);
      return reply.code(201).send({ mode: "split", inserted, skipped });
    }

    // ==== 单片模式：≤1 子目录 ====
    const existing = getByShareCode(shareCode);
    if (existing) {
      return reply.code(409).send({ code: 409, message: "该分享已在影库中", data: existing });
    }

    let title = bodyTitle;
    let fileCount = typeof body.fileCount === "number" ? body.fileCount : 0;

    if ((!title || !fileCount) && account115) {
      try {
        const data = (await getShareData(account115, shareCode, receiveCode)) as Record<string, any>;
        const shareInfo = (data?.share_info ?? {}) as Record<string, any>;
        if (!title) title = String(shareInfo.share_title ?? shareInfo.name ?? "").trim();
        if (!fileCount) fileCount = Number(shareInfo.file_size ?? shareInfo.file_count ?? 0) || 0;
      } catch {
        // ignore — allow saving without metadata enrichment
      }
    }

    const shouldScrape = hasTmdb && !bodyCoverUrl;
    const entry: MediaLibraryEntry = {
      id: randomId(),
      shareUrl,
      shareCode,
      receiveCode,
      sharePath: "",
      shareRootCid: "",
      rawName: title,
      title,
      fileCount,
      coverUrl: bodyCoverUrl,
      tags: bodyTags,
      notes: bodyNotes,
      mediaType: "unknown",
      tmdbId: null,
      year: "",
      overview: "",
      scrapeStatus: shouldScrape ? "pending" : "done",
      createdAt: now,
      updatedAt: now,
    };

    insert(entry);
    if (shouldScrape) enqueueOne(entry.id);
    return reply.code(201).send({ mode: "single", entry });
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
