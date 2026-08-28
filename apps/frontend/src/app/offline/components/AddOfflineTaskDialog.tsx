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
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronRight, FolderOpen, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api, type DirectoryNode, type OfflineAddResult, type TaskRow } from "@/lib/api";
import { apiErrorBody, apiErrorMessage } from "@/lib/axios";
import { DirectoryPickerDialog } from "@/components/DirectoryPickerDialog";

type Mode = "task" | "dir";

interface AddOfflineTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 往哪个 115 账号加 */
  account: string;
  /** 至少加成功一条时回调，页面据此刷新列表 */
  onAdded: () => void;
}

/**
 * 添加云下载任务。目标位置二选一：
 *   - 同步任务的目录（可进子目录）：下载完成后由后端自动为产物生成 strm
 *   - 任意网盘目录：只是下载，不管 strm
 */
export function AddOfflineTaskDialog({ open, onOpenChange, account, onAdded }: AddOfflineTaskDialogProps) {
  const [urls, setUrls] = useState("");
  const [mode, setMode] = useState<Mode>("task");
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [taskId, setTaskId] = useState("");
  const [subSegments, setSubSegments] = useState<string[]>([]);
  const [subdirs, setSubdirs] = useState<DirectoryNode[]>([]);
  const [subdirLoading, setSubdirLoading] = useState(false);
  const [generateStrm, setGenerateStrm] = useState(true);
  /** 空串 = 交给 115 的默认目录；"0" = 根目录 */
  const [dirId, setDirId] = useState("");
  const [dirPath, setDirPath] = useState("");
  const [defaultDir, setDefaultDir] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<OfflineAddResult[] | null>(null);
  const [invalid, setInvalid] = useState<string[]>([]);

  // 每次打开都从头来：清链接、回到任务目录、重新拉这个账号的任务和 115 的默认目录
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setUrls("");
    setResults(null);
    setInvalid([]);
    setSubSegments([]);
    setDirId("");
    setDirPath("");
    setGenerateStrm(true);
    setTasksLoading(true);
    api.tasks
      .list()
      .then((rows) => {
        if (cancelled) return;
        const mine = rows.filter((t) => t.account === account);
        setTasks(mine);
        setTaskId((prev) => (prev && mine.some((t) => t.id === prev) ? prev : (mine[0]?.id ?? "")));
        setMode(mine.length > 0 ? "task" : "dir");
      })
      .catch((err) => {
        if (!cancelled) toast.error(apiErrorMessage(err, "加载任务列表失败"));
      })
      .finally(() => {
        if (!cancelled) setTasksLoading(false);
      });
    api.offline
      .downPaths(account)
      .then((r) => {
        if (cancelled) return;
        setDefaultDir(r.dirs.find((d) => d.selected)?.name ?? r.dirs[0]?.name ?? null);
      })
      .catch(() => {
        if (!cancelled) setDefaultDir(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, account]);

  const selectedTask = useMemo(() => tasks.find((t) => t.id === taskId), [tasks, taskId]);
  // 子目录请求只跟任务 id 和路径走，不跟任务对象的引用走（和 SaveToDriveDialog 一个道理）
  const taskAccount = selectedTask?.account;
  const taskOriginPath = selectedTask?.originPath;

  useEffect(() => {
    if (!open || mode !== "task" || !taskId || taskAccount == null || taskOriginPath == null) return;
    let cancelled = false;
    const fullPath = subSegments.length ? `${taskOriginPath}/${subSegments.join("/")}` : taskOriginPath;
    setSubdirLoading(true);
    api.directory
      .remote(taskAccount, fullPath)
      .then((dirs) => {
        if (!cancelled) setSubdirs(dirs ?? []);
      })
      .catch(() => {
        if (!cancelled) setSubdirs([]);
      })
      .finally(() => {
        if (!cancelled) setSubdirLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, mode, taskId, taskAccount, taskOriginPath, subSegments]);

  const lineCount = urls
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean).length;

  const submit = async () => {
    if (lineCount === 0) {
      toast.error("请先粘贴链接");
      return;
    }
    if (mode === "task" && !taskId) {
      toast.error("请选择一个同步任务");
      return;
    }
    setSubmitting(true);
    setResults(null);
    setInvalid([]);
    try {
      const target =
        mode === "task"
          ? { taskId, subPath: subSegments.join("/"), generateStrm }
          : dirId
            ? { dirId }
            : {};
      const res = await api.offline.add({ account, urls, ...target });
      setResults(res.results);
      setInvalid(res.invalid);
      if (res.added > 0) {
        toast.success(
          `已添加 ${res.added} 个云下载任务${res.followup ? "，下载完成后会自动生成 strm" : ""}`,
        );
        onAdded();
      }
      if (res.failed === 0 && res.invalid.length === 0) {
        onOpenChange(false);
      } else if (res.added === 0) {
        toast.error("没有任务被添加，原因见下方");
      }
    } catch (err) {
      const body = apiErrorBody(err) as { invalid?: string[] };
      if (Array.isArray(body.invalid) && body.invalid.length) setInvalid(body.invalid);
      toast.error(apiErrorMessage(err, "添加云下载任务失败"));
    } finally {
      setSubmitting(false);
    }
  };

  const dirLabel = dirId
    ? dirPath || "根目录"
    : defaultDir
      ? `115 默认目录（${defaultDir}）`
      : "115 默认目录";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>添加云下载</DialogTitle>
          <DialogDescription>
            由 115 在云端下载到网盘。账号：{account}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-auto min-h-0 space-y-4 py-2">
          <div className="space-y-2">
            <label className="text-sm font-medium">链接（每行一条）</label>
            <Textarea
              value={urls}
              onChange={(e) => setUrls(e.target.value)}
              rows={5}
              placeholder={"magnet:?xt=urn:btih:...\ned2k://|file|...|/\nhttps://example.com/file.mkv"}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              支持磁力、ed2k、http(s)、ftp；直接贴 40 位 info hash 也行。当前 {lineCount} 条。
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">下载到</label>
            <div className="space-y-2">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="offlineTarget"
                  value="task"
                  checked={mode === "task"}
                  onChange={() => setMode("task")}
                  className="mt-1"
                  disabled={tasks.length === 0 && !tasksLoading}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">同步任务的目录</div>
                  <div className="text-xs text-muted-foreground">
                    下载完成后自动为下载的文件生成 strm，不用再跑全量同步。
                  </div>
                </div>
              </label>

              {mode === "task" && (
                <div className="ml-6 space-y-2">
                  {tasksLoading ? (
                    <div className="text-sm text-muted-foreground">加载中...</div>
                  ) : tasks.length === 0 ? (
                    <div className="text-sm text-muted-foreground">
                      这个账号下还没有同步任务，请先到首页创建，或改成下载到网盘目录。
                    </div>
                  ) : (
                    <Select
                      value={taskId}
                      onValueChange={(v) => {
                        setTaskId(v);
                        setSubSegments([]);
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="选择任务" />
                      </SelectTrigger>
                      <SelectContent>
                        {tasks.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.originPath} → {t.targetPath || "(未配置)"}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}

                  {selectedTask && (
                    <div className="border rounded-md overflow-hidden">
                      <div className="flex items-center gap-1 px-3 py-2 text-xs bg-muted/40 border-b flex-wrap min-w-0">
                        <button
                          type="button"
                          onClick={() => setSubSegments([])}
                          className={`hover:text-foreground truncate max-w-[240px] ${
                            subSegments.length === 0 ? "font-medium text-foreground cursor-default" : "underline cursor-pointer"
                          }`}
                          title={selectedTask.originPath}
                        >
                          {selectedTask.originPath}
                        </button>
                        {subSegments.map((seg, idx) => (
                          <span key={idx} className="flex items-center gap-1 min-w-0">
                            <ChevronRight className="h-3 w-3 shrink-0" />
                            <button
                              type="button"
                              onClick={() => setSubSegments((prev) => prev.slice(0, idx + 1))}
                              className={`hover:text-foreground truncate max-w-[120px] ${
                                idx === subSegments.length - 1
                                  ? "font-medium text-foreground cursor-default"
                                  : "underline cursor-pointer"
                              }`}
                              title={seg}
                            >
                              {seg}
                            </button>
                          </span>
                        ))}
                      </div>
                      <div className="max-h-[160px] overflow-auto">
                        {subdirLoading ? (
                          <div className="p-3 text-center text-xs text-muted-foreground">加载中...</div>
                        ) : subdirs.length === 0 ? (
                          <div className="p-3 text-center text-xs text-muted-foreground">此目录下没有子文件夹</div>
                        ) : (
                          <ul className="py-1">
                            {subdirs.map((d) => (
                              <li key={d.id}>
                                <button
                                  type="button"
                                  onClick={() => setSubSegments((prev) => [...prev, d.name])}
                                  className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-accent text-left text-sm"
                                >
                                  <FolderOpen className="h-4 w-4 text-amber-500 shrink-0" />
                                  <span className="truncate">{d.name}</span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  )}

                  <label className="flex items-center gap-2 cursor-pointer text-sm">
                    <Checkbox checked={generateStrm} onCheckedChange={(v) => setGenerateStrm(v === true)} />
                    下载完成后自动生成 strm
                  </label>
                </div>
              )}

              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="offlineTarget"
                  value="dir"
                  checked={mode === "dir"}
                  onChange={() => setMode("dir")}
                  className="mt-1"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">网盘里的任意目录</div>
                  <div className="text-xs text-muted-foreground">只下载，不生成 strm。</div>
                </div>
              </label>

              {mode === "dir" && (
                <div className="ml-6 flex items-center gap-2 flex-wrap text-sm">
                  <span className="text-muted-foreground">保存到：</span>
                  <span className="font-medium truncate max-w-[260px]" title={dirLabel}>
                    {dirLabel}
                  </span>
                  <Button type="button" variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
                    选择目录
                  </Button>
                  {dirId && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setDirId("");
                        setDirPath("");
                      }}
                    >
                      用默认目录
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>

          {(results?.some((r) => !r.ok) || invalid.length > 0) && (
            <div className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
              {results
                ?.filter((r) => !r.ok)
                .map((r) => (
                  <div key={r.url} className="flex gap-2 min-w-0">
                    <span className="truncate max-w-[220px] text-muted-foreground" title={r.url}>
                      {r.url}
                    </span>
                    <span className="text-destructive">{r.message || "115 未接受"}</span>
                  </div>
                ))}
              {invalid.map((u) => (
                <div key={u} className="flex gap-2 min-w-0">
                  <span className="truncate max-w-[220px] text-muted-foreground" title={u}>
                    {u}
                  </span>
                  <span className="text-destructive">115 不支持这种链接</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button onClick={submit} disabled={submitting || lineCount === 0 || (mode === "task" && !taskId)}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            添加
          </Button>
        </DialogFooter>
      </DialogContent>

      <DirectoryPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        account={account}
        onSelect={(cid, path) => {
          setDirId(String(cid));
          setDirPath(path);
        }}
      />
    </Dialog>
  );
}
