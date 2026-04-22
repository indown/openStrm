export interface MediaLibraryEntry {
  id: string;
  shareUrl: string;
  shareCode: string;
  receiveCode: string;
  title: string;
  fileCount: number;
  coverUrl: string;
  tags: string[];
  notes: string;
  createdAt: number;
  updatedAt: number;
}
