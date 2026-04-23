export type ScrapeStatus = "pending" | "done" | "failed";
export type MediaType = "movie" | "tv" | "collection" | "unknown";

export interface MediaLibraryEntry {
  id: string;
  shareUrl: string;
  shareCode: string;
  receiveCode: string;
  sharePath: string;
  shareRootCid: string;
  rawName: string;
  title: string;
  fileCount: number;
  coverUrl: string;
  tags: string[];
  notes: string;
  mediaType: MediaType;
  tmdbId: number | null;
  year: string;
  overview: string;
  scrapeStatus: ScrapeStatus;
  createdAt: number;
  updatedAt: number;
}
