import { eq, desc } from "drizzle-orm";
import type { MediaLibraryEntry } from "@openstrm/shared";
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

function deserialize(row: Row): MediaLibraryEntry {
  return {
    id: row.id,
    shareUrl: row.shareUrl,
    shareCode: row.shareCode,
    receiveCode: row.receiveCode,
    title: row.title,
    fileCount: row.fileCount,
    coverUrl: row.coverUrl,
    tags: safeParseTags(row.tags),
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function insert(entry: MediaLibraryEntry): void {
  db.insert(mediaLibrary)
    .values({
      id: entry.id,
      shareUrl: entry.shareUrl,
      shareCode: entry.shareCode,
      receiveCode: entry.receiveCode,
      title: entry.title,
      fileCount: entry.fileCount,
      coverUrl: entry.coverUrl,
      tags: JSON.stringify(entry.tags ?? []),
      notes: entry.notes,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    })
    .run();
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
  db.update(mediaLibrary)
    .set({
      shareUrl: merged.shareUrl,
      shareCode: merged.shareCode,
      receiveCode: merged.receiveCode,
      title: merged.title,
      fileCount: merged.fileCount,
      coverUrl: merged.coverUrl,
      tags: JSON.stringify(merged.tags ?? []),
      notes: merged.notes,
      updatedAt: merged.updatedAt,
    })
    .where(eq(mediaLibrary.id, id))
    .run();
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
  const row = db.select().from(mediaLibrary).where(eq(mediaLibrary.shareCode, shareCode)).get();
  return row ? deserialize(row) : null;
}

export function getAll(): MediaLibraryEntry[] {
  const rows = db.select().from(mediaLibrary).orderBy(desc(mediaLibrary.updatedAt)).all();
  return rows.map(deserialize);
}
