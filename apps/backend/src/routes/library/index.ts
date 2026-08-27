import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Account115, MediaLibraryEntry } from "@openstrm/shared";
import {
  getAll,
  getById,
  getByShareCode,
  getByShareCodeAndPath,
  insert,
  remove,
  update,
} from "../../db/repositories/media-library.js";
import { shareExtractPayload, getShareData } from "../../services/cloud-115/share.js";
import { enqueueOne } from "../../services/library/scrape-worker.js";
import { normalizeTitle } from "../../services/media-title.js";
import { listAccounts } from "../../db/repositories/accounts.js";
import { readAppSettings } from "../../db/repositories/settings.js";
import { HttpError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";
import { cidSchema } from "../../schemas/entities.js";
import { randomId, sanitizeTags, shareRootCidForDb } from "./_util.js";

const idParamsSchema = z.object({ id: z.string().min(1) });

const createSchema = z.looseObject({
  shareUrl: z.string().trim().min(1, "shareUrl is required"),
  title: z.string().optional(),
  coverUrl: z.string().optional(),
  tags: z.array(z.unknown()).optional(),
  notes: z.string().optional(),
  cid: cidSchema.optional(),
  fileCount: z.union([z.number(), z.string()]).optional(),
  rawName: z.string().optional(),
  sharePath: z.string().optional(),
});

const patchSchema = z.object({
  title: z.string().optional(),
  coverUrl: z.string().optional(),
  notes: z.string().optional(),
  tags: z.array(z.unknown()).optional(),
  receiveCode: z.string().optional(),
});

export default async function (fastify: FastifyInstance) {
  fastify.get("/api/library", { preHandler: [fastify.authenticate] }, async () => getAll());

  fastify.post("/api/library", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = parse(createSchema, request.body);
    const shareUrl = body.shareUrl;

    let parsed: ReturnType<typeof shareExtractPayload>;
    try {
      parsed = shareExtractPayload(shareUrl);
    } catch {
      throw new HttpError(400, "Invalid share url");
    }
    const { share_code: shareCode, receive_code: receiveCode } = parsed;
    if (!shareCode) throw new HttpError(400, "Cannot parse shareCode from url");

    const settings = readAppSettings();
    const hasTmdb = Boolean(settings.tmdb?.apiKey?.trim());
    const bodyTitle = (body.title ?? "").trim();
    const bodyCoverUrl = (body.coverUrl ?? "").trim();
    const bodyTags = sanitizeTags(body.tags);
    const bodyNotes = body.notes ?? "";
    const cidStr = shareRootCidForDb(body.cid);
    const hasCidFromClient = Boolean(cidStr && cidStr !== "0");
    const bodyRawName = (body.rawName ?? "").trim();

    const now = Math.floor(Date.now() / 1000);

    // ==== 子目录直接入库模式：前端已定位到具体子目录 ====
    if (hasCidFromClient && bodyRawName) {
      const bodyPath = (body.sharePath ?? "").split("/").map((s) => s.trim()).filter(Boolean).join("/");
      const sharePath = bodyPath ? `/${bodyPath}` : `/${bodyRawName}`;
      const existing = getByShareCodeAndPath(shareCode, sharePath);
      if (existing) throw new HttpError(409, "该子目录已在影库中", { data: existing });

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

    const account115 = listAccounts().find((a): a is Account115 => a.accountType === "115");

    // ==== 单片模式 ====
    const existing = getByShareCode(shareCode);
    if (existing) throw new HttpError(409, "该分享已在影库中", { data: existing });

    let title = bodyTitle;
    let fileCount = typeof body.fileCount === "number" ? body.fileCount : 0;

    if ((!title || !fileCount) && account115) {
      try {
        const data = await getShareData(account115, shareCode, receiveCode);
        const shareInfo = (data.share_info ?? {}) as { share_title?: string; name?: string; file_size?: number; file_count?: number };
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

  fastify.put("/api/library/:id", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    const body = parse(patchSchema, request.body);
    if (!getById(id)) throw new HttpError(404, "Entry not found");

    const updates: Partial<MediaLibraryEntry> = {};
    if (body.title !== undefined) updates.title = body.title.trim();
    if (body.coverUrl !== undefined) updates.coverUrl = body.coverUrl.trim();
    if (body.notes !== undefined) updates.notes = body.notes;
    if (body.tags !== undefined) updates.tags = sanitizeTags(body.tags);
    if (body.receiveCode !== undefined) updates.receiveCode = body.receiveCode.trim();

    const merged = update(id, updates);
    if (!merged) throw new HttpError(404, "Entry not found");
    return merged;
  });

  fastify.delete("/api/library/:id", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    if (!getById(id)) throw new HttpError(404, "Entry not found");
    remove(id);
    return { success: true };
  });
}
