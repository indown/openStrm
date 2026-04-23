import { eq, desc, and } from "drizzle-orm";
import type { MediaLibraryEntry, ScrapeStatus, MediaType } from "@openstrm/shared";
import { db } from "../client.js";
import { mediaLibrary } from "../schema.js";

type Row = typeof mediaLibrary.$inferSelect;

function safeParseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function coerceMediaType(v: string): MediaType {
  return v === "movie" || v === "tv" || v === "collection" ? v : "unknown";
}

function coerceScrapeStatus(v: string): ScrapeStatus {
  return v === "pending" || v === "failed" ? v : "done";
}

function deserialize(row: Row): MediaLibraryEntry {
  return {
    id: row.id,
    shareUrl: row.shareUrl,
    shareCode: row.shareCode,
    receiveCode: row.receiveCode,
    sharePath: row.sharePath,
    shareRootCid: row.shareRootCid,
    rawName: row.rawName,
    title: row.title,
    fileCount: row.fileCount,
    coverUrl: row.coverUrl,
    tags: safeParseTags(row.tags),
    notes: row.notes,
    mediaType: coerceMediaType(row.mediaType),
    tmdbId: row.tmdbId ?? null,
    year: row.year,
    overview: row.overview,
    scrapeStatus: coerceScrapeStatus(row.scrapeStatus),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toRow(entry: MediaLibraryEntry) {
  return {
    id: entry.id,
    shareUrl: entry.shareUrl,
    shareCode: entry.shareCode,
    receiveCode: entry.receiveCode,
    sharePath: entry.sharePath ?? "",
    shareRootCid: entry.shareRootCid ?? "",
    rawName: entry.rawName ?? "",
    title: entry.title ?? "",
    fileCount: entry.fileCount ?? 0,
    coverUrl: entry.coverUrl ?? "",
    tags: JSON.stringify(entry.tags ?? []),
    notes: entry.notes ?? "",
    mediaType: entry.mediaType ?? "unknown",
    tmdbId: entry.tmdbId ?? null,
    year: entry.year ?? "",
    overview: entry.overview ?? "",
    scrapeStatus: entry.scrapeStatus ?? "done",
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

/** toRow minus {id, createdAt}; everything else is legally set-able by update(). */
function toUpdateRow(entry: MediaLibraryEntry) {
  const { id: _id, createdAt: _c, ...rest } = toRow(entry);
  return rest;
}

export function insert(entry: MediaLibraryEntry): void {
  db.insert(mediaLibrary).values(toRow(entry)).run();
}

export function bulkInsert(entries: MediaLibraryEntry[]): {
  inserted: number;
  skipped: number;
  insertedIds: string[];
} {
  if (entries.length === 0) return { inserted: 0, skipped: 0, insertedIds: [] };
  let inserted = 0;
  let skipped = 0;
  const insertedIds: string[] = [];
  db.transaction((tx) => {
    for (const entry of entries) {
      const dupe = tx
        .select({ id: mediaLibrary.id })
        .from(mediaLibrary)
        .where(and(eq(mediaLibrary.shareCode, entry.shareCode), eq(mediaLibrary.sharePath, entry.sharePath ?? "")))
        .get();
      if (dupe) {
        skipped += 1;
        continue;
      }
      tx.insert(mediaLibrary).values(toRow(entry)).run();
      inserted += 1;
      insertedIds.push(entry.id);
    }
  });
  return { inserted, skipped, insertedIds };
}

export function update(id: string, updates: Partial<MediaLibraryEntry>): MediaLibraryEntry | null {
  const row = db.select().from(mediaLibrary).where(eq(mediaLibrary.id, id)).get();
  if (!row) return null;
  const current = deserialize(row);
  const merged: MediaLibraryEntry = {
    ...current,
    ...updates,
    id: current.id,
    updatedAt: Math.floor(Date.now() / 1000),
  };
  db.update(mediaLibrary).set(toUpdateRow(merged)).where(eq(mediaLibrary.id, id)).run();
  return merged;
}

export interface ScrapeUpdate {
  title?: string;
  coverUrl?: string;
  year?: string;
  tmdbId?: number | null;
  mediaType?: MediaType;
  overview?: string;
  status: ScrapeStatus;
  notesAppend?: string;
}

export function updateScrape(id: string, patch: ScrapeUpdate): MediaLibraryEntry | null {
  const row = db.select().from(mediaLibrary).where(eq(mediaLibrary.id, id)).get();
  if (!row) return null;
  const current = deserialize(row);
  const merged: MediaLibraryEntry = {
    ...current,
    title: patch.title !== undefined && patch.title !== "" ? patch.title : current.title,
    coverUrl: patch.coverUrl !== undefined && patch.coverUrl !== "" ? patch.coverUrl : current.coverUrl,
    year: patch.year !== undefined ? patch.year : current.year,
    tmdbId: patch.tmdbId !== undefined ? patch.tmdbId : current.tmdbId,
    mediaType: patch.mediaType !== undefined ? patch.mediaType : current.mediaType,
    overview: patch.overview !== undefined ? patch.overview : current.overview,
    scrapeStatus: patch.status,
    notes: patch.notesAppend ? `${current.notes ? current.notes + "\n" : ""}${patch.notesAppend}` : current.notes,
    updatedAt: Math.floor(Date.now() / 1000),
  };
  db.update(mediaLibrary).set(toUpdateRow(merged)).where(eq(mediaLibrary.id, id)).run();
  return merged;
}

export function remove(id: string): void {
  db.delete(mediaLibrary).where(eq(mediaLibrary.id, id)).run();
}

export function getById(id: string): MediaLibraryEntry | null {
  const row = db.select().from(mediaLibrary).where(eq(mediaLibrary.id, id)).get();
  return row ? deserialize(row) : null;
}

export function getByShareCode(shareCode: string): MediaLibraryEntry | null {
  const row = db
    .select()
    .from(mediaLibrary)
    .where(and(eq(mediaLibrary.shareCode, shareCode), eq(mediaLibrary.sharePath, "")))
    .get();
  return row ? deserialize(row) : null;
}

export function getByShareCodeAndPath(shareCode: string, sharePath: string): MediaLibraryEntry | null {
  const row = db
    .select()
    .from(mediaLibrary)
    .where(and(eq(mediaLibrary.shareCode, shareCode), eq(mediaLibrary.sharePath, sharePath)))
    .get();
  return row ? deserialize(row) : null;
}

export function listByShareCode(shareCode: string): MediaLibraryEntry[] {
  const rows = db.select().from(mediaLibrary).where(eq(mediaLibrary.shareCode, shareCode)).all();
  return rows.map(deserialize);
}

export function getAll(): MediaLibraryEntry[] {
  const rows = db.select().from(mediaLibrary).orderBy(desc(mediaLibrary.updatedAt)).all();
  return rows.map(deserialize);
}

export function getPending(): MediaLibraryEntry[] {
  const rows = db.select().from(mediaLibrary).where(eq(mediaLibrary.scrapeStatus, "pending")).all();
  return rows.map(deserialize);
}

export function setScrapeStatus(id: string, status: ScrapeStatus): void {
  db.update(mediaLibrary)
    .set({ scrapeStatus: status, updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(mediaLibrary.id, id))
    .run();
}
