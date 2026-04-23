"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ChevronDown, Loader2 } from "lucide-react";
import axiosInstance from "@/lib/axios";
import { toast } from "sonner";

export interface BulkScanLibraryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shareUrl: string;
  onSubmitted?: () => void;
}

interface Candidate {
  cid: number | string;
  rawName: string;
  normalizedTitle: string;
  year: string;
  fileCount: number;
  hasChildren: boolean;
  alreadyInLibrary: boolean;
  parentCid: number | string;
  parentName: string;
}

interface ScanData {
  shareCode: string;
  receiveCode: string;
  shareUrl: string;
  shareTitle: string;
  totalCount: number;
  candidates: Candidate[];
}

interface Row {
  key: string;
  sharePath: string;
  parentPath: string;
  candidate: Candidate;
  edited: string;
  expanding: boolean;
  depth: number;
}

function makeRow(c: Candidate, parentPath: string, depth: number): Row {
  const sharePath = `${parentPath}/${c.rawName}`;
  return {
    key: `${sharePath}-${c.cid}`,
    sharePath,
    parentPath,
    candidate: c,
    edited: c.normalizedTitle || c.rawName,
    expanding: false,
    depth,
  };
}

function splitTags(raw: string): string[] {
  return raw
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i);
}

export function BulkScanLibraryDialog({ open, onOpenChange, shareUrl, onSubmitted }: BulkScanLibraryDialogProps) {
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [scan, setScan] = useState<ScanData | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [commonTags, setCommonTags] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setScan(null);
      setRows([]);
      setSelected(new Set());
      try {
        const res = await axiosInstance.post<{ code: number; data?: ScanData; message?: string }>(
          "/api/library/scan",
          { shareUrl },
        );
        if (cancelled) return;
        if (res.data.code !== 200 || !res.data.data) {
          toast.error(res.data.message || "扫描失败");
          return;
        }
        const data = res.data.data;
        setScan(data);
        const initialRows = data.candidates.map((c) => makeRow(c, "", 0));
        setRows(initialRows);
        const autoSelect = new Set<string>();
        for (const r of initialRows) if (!r.candidate.alreadyInLibrary) autoSelect.add(r.key);
        setSelected(autoSelect);
      } catch (err) {
        if (cancelled) return;
        const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
        toast.error(msg || "扫描失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [open, shareUrl]);

  const selectableRows = useMemo(() => rows.filter((r) => !r.candidate.alreadyInLibrary), [rows]);

  const toggleOne = (key: string, alreadyInLibrary: boolean) => {
    if (alreadyInLibrary) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = (all: boolean) => {
    if (!all) {
      setSelected(new Set());
      return;
    }
    setSelected(new Set(selectableRows.map((r) => r.key)));
  };

  const handleEditTitle = (key: string, value: string) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, edited: value } : r)));
  };

  const handleExpand = async (row: Row) => {
    if (!scan) return;
    if (!row.candidate.hasChildren) return;
    setRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, expanding: true } : r)));
    try {
      const res = await axiosInstance.post<{ code: number; data?: { candidates: Candidate[] }; message?: string }>(
        "/api/library/scan/expand",
        {
          shareCode: scan.shareCode,
          receiveCode: scan.receiveCode,
          parentCid: row.candidate.cid,
          parentName: row.candidate.rawName,
          parentPath: row.sharePath,
        },
      );
      if (res.data.code !== 200 || !res.data.data) {
        toast.error(res.data.message || "展开失败");
        setRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, expanding: false } : r)));
        return;
      }
      const children = res.data.data.candidates;
      if (children.length === 0) {
        toast.info("该目录下没有子目录");
        setRows((prev) =>
          prev.map((r) =>
            r.key === row.key ? { ...r, expanding: false, candidate: { ...r.candidate, hasChildren: false } } : r,
          ),
        );
        return;
      }
      setRows((prev) => {
        const idx = prev.findIndex((r) => r.key === row.key);
        if (idx < 0) return prev;
        const newRows = children.map((c) => makeRow(c, row.sharePath, row.depth + 1));
        return [...prev.slice(0, idx), ...newRows, ...prev.slice(idx + 1)];
      });
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(row.key);
        for (const c of children) {
          const k = `${row.sharePath}/${c.rawName}-${c.cid}`;
          if (!c.alreadyInLibrary) next.add(k);
        }
        return next;
      });
    } catch (err) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg || "展开失败");
      setRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, expanding: false } : r)));
    }
  };

  const handleSubmit = async () => {
    if (!scan) return;
    if (selected.size === 0) {
      toast.error("请至少勾选一项");
      return;
    }
    setSubmitting(true);
    try {
      const items = rows
        .filter((r) => selected.has(r.key))
        .map((r) => ({
          shareCode: scan.shareCode,
          receiveCode: scan.receiveCode,
          shareUrl: scan.shareUrl,
          sharePath: r.sharePath,
          shareRootCid: r.candidate.cid,
          rawName: r.candidate.rawName,
          title: r.edited.trim(),
          year: r.candidate.year,
          fileCount: r.candidate.fileCount,
        }));
      const res = await axiosInstance.post<{
        inserted: number;
        skipped: number;
        message?: string;
      }>("/api/library/bulk-insert", {
        items,
        commonTags: splitTags(commonTags),
      });
      if (res.status >= 400) {
        toast.error(res.data.message || "入库失败");
        return;
      }
      toast.success(`已入库 ${res.data.inserted} 条，跳过 ${res.data.skipped} 条，后台刮削中...`);
      onOpenChange(false);
      if (onSubmitted) onSubmitted();
    } catch (err) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg || "入库失败");
    } finally {
      setSubmitting(false);
    }
  };

  const allSelected = selectableRows.length > 0 && selectableRows.every((r) => selected.has(r.key));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>批量入库</DialogTitle>
          <DialogDescription className="truncate">
            {scan?.shareTitle ? `${scan.shareTitle} · ` : ""}共 {rows.length} 个候选目录
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-auto border rounded-md min-h-0">
          {loading ? (
            <div className="p-10 text-center text-muted-foreground flex items-center justify-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在扫描分享目录...
            </div>
          ) : rows.length === 0 ? (
            <div className="p-10 text-center text-muted-foreground">
              此分享没有子目录，建议走「加入影库」单条入库
            </div>
          ) : (
            <Table>
              <TableHeader className="sticky top-0 bg-background z-10">
                <TableRow>
                  <TableHead className="w-[40px]">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={(v) => toggleAll(Boolean(v))}
                      aria-label="全选"
                    />
                  </TableHead>
                  <TableHead>原目录名</TableHead>
                  <TableHead>标题（可编辑）</TableHead>
                  <TableHead className="w-[60px]">年份</TableHead>
                  <TableHead className="w-[60px] text-right">文件</TableHead>
                  <TableHead className="w-[120px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const isSelected = selected.has(r.key);
                  const indent = r.depth > 0 ? <span className="inline-block" style={{ width: r.depth * 16 }} /> : null;
                  return (
                    <TableRow key={r.key} className={r.candidate.alreadyInLibrary ? "opacity-60" : ""}>
                      <TableCell className="py-1">
                        <Checkbox
                          checked={isSelected}
                          disabled={r.candidate.alreadyInLibrary}
                          onCheckedChange={() => toggleOne(r.key, r.candidate.alreadyInLibrary)}
                        />
                      </TableCell>
                      <TableCell
                        className="font-medium truncate max-w-[240px]"
                        title={r.candidate.rawName}
                      >
                        {indent}
                        {r.candidate.rawName}
                        {r.candidate.alreadyInLibrary && (
                          <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                            已在库
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="py-1">
                        <Input
                          value={r.edited}
                          onChange={(e) => handleEditTitle(r.key, e.target.value)}
                          className="h-7"
                          disabled={r.candidate.alreadyInLibrary}
                        />
                      </TableCell>
                      <TableCell className="text-muted-foreground">{r.candidate.year || "-"}</TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {r.candidate.fileCount || "-"}
                      </TableCell>
                      <TableCell className="py-1">
                        {r.candidate.hasChildren && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={r.expanding}
                            onClick={() => handleExpand(r)}
                            className="h-7"
                          >
                            {r.expanding ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <>
                                <ChevronDown className="h-3 w-3 mr-1" />
                                展开
                              </>
                            )}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>

        <div className="pt-3 space-y-2">
          <div className="flex items-center gap-2">
            <label className="text-sm w-20">公共标签</label>
            <Input
              value={commonTags}
              onChange={(e) => setCommonTags(e.target.value)}
              placeholder="用逗号分隔，应用到所有勾选项"
              className="h-8"
            />
          </div>
        </div>

        <DialogFooter className="flex-row justify-between sm:justify-between">
          <div className="text-sm text-muted-foreground self-center">
            已选 {selected.size} / {selectableRows.length}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              取消
            </Button>
            <Button onClick={handleSubmit} disabled={submitting || selected.size === 0}>
              {submitting ? "入库中..." : `确认入库 (${selected.size})`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
