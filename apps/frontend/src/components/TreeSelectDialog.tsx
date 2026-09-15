"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Check, ChevronRight, ChevronDown, Folder, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { DirectoryNode } from "@/lib/api";

export interface TreeSelectNode extends DirectoryNode {
  /** undefined = 还没加载过；[] = 加载过但没有子目录 */
  children?: TreeSelectNode[];
}

interface TreeSelectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  /** 取某个路径下的子目录；根目录传空串 */
  load: (path: string) => Promise<DirectoryNode[]>;
  /** 点确认时的回调；返回 false 表示由调用方接管（比如再弹一个确认框），不自动关闭 */
  onConfirm?: (path: string) => void | false;
  /** 多选：点一行勾上 / 取消，确认时一起交给 onConfirmMany */
  multiple?: boolean;
  onConfirmMany?: (paths: string[]) => void;
}

function updateTreeNode(nodes: TreeSelectNode[], targetId: TreeSelectNode["id"], updated: TreeSelectNode): TreeSelectNode[] {
  return nodes.map((node) => {
    if (node.id === targetId) return updated;
    if (node.children) return { ...node, children: updateTreeNode(node.children, targetId, updated) };
    return node;
  });
}

/**
 * 懒加载的目录树选择器。远程（115 目录）和本地（DATA_DIR）两个入口共用，
 * 区别只在 load 用哪个接口。
 */
export function TreeSelectDialog({ open, onOpenChange, title, description, load, onConfirm, multiple, onConfirmMany }: TreeSelectDialogProps) {
  const [tree, setTree] = React.useState<TreeSelectNode[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [expanded, setExpanded] = React.useState<Set<TreeSelectNode["id"]>>(new Set());
  const [loadingNodes, setLoadingNodes] = React.useState<Set<TreeSelectNode["id"]>>(new Set());
  const [selectedPath, setSelectedPath] = React.useState("");
  /** 多选模式下勾上的路径 */
  const [picked, setPicked] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setExpanded(new Set());
    setSelectedPath("");
    setPicked(new Set());
    setLoading(true);
    load("")
      .then((nodes) => { if (!cancelled) setTree(nodes ?? []); })
      .catch(() => { if (!cancelled) setTree([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, load]);

  const toggleNode = async (node: TreeSelectNode, currentPath: string) => {
    if (expanded.has(node.id)) {
      setExpanded((prev) => { const next = new Set(prev); next.delete(node.id); return next; });
      return;
    }
    if (node.children !== undefined) {
      setExpanded((prev) => new Set(prev).add(node.id));
      return;
    }
    setLoadingNodes((prev) => new Set(prev).add(node.id));
    try {
      const children = (await load(currentPath)) ?? [];
      // 即使为空也写回 []，表示已加载过
      setTree((prev) => updateTreeNode(prev, node.id, { ...node, children }));
      if (children.length > 0) setExpanded((prev) => new Set(prev).add(node.id));
    } catch {
      setTree((prev) => updateTreeNode(prev, node.id, { ...node, children: [] }));
    } finally {
      setLoadingNodes((prev) => { const next = new Set(prev); next.delete(node.id); return next; });
    }
  };

  const handleConfirm = () => {
    if (multiple) {
      if (picked.size === 0) return;
      onConfirmMany?.([...picked]);
      onOpenChange(false);
      return;
    }
    if (!selectedPath) return;
    if (onConfirm?.(selectedPath) === false) return;
    onOpenChange(false);
  };

  const togglePicked = (path: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const renderNode = (node: TreeSelectNode, parentPath = "", level = 0): React.ReactNode => {
    const currentPath = parentPath ? `${parentPath}/${node.name}` : node.name;
    const isExpanded = expanded.has(node.id);
    const isLoading = loadingNodes.has(node.id);
    const isSelected = multiple ? picked.has(currentPath) : selectedPath === currentPath;
    const loaded = node.children !== undefined;
    const hasChildren = loaded && (node.children?.length ?? 0) > 0;

    return (
      <div key={node.id} className="select-none">
        <div
          className={`flex items-center gap-1 px-2 py-1.5 rounded hover:bg-accent cursor-pointer ${isSelected ? "bg-brand/10 text-brand" : ""}`}
          style={{ paddingLeft: `${level * 20 + 8}px` }}
          onClick={(e) => {
            const target = e.target as HTMLElement;
            const onIcon = target.closest(".chevron-icon") || target.closest(".folder-icon");
            if (!onIcon) {
              if (multiple) togglePicked(currentPath);
              else setSelectedPath(currentPath);
            }
            // 多选时点名字只勾选、展开收起靠前面的箭头和文件夹图标：连着勾几个目录时树不会跟着开合乱跳
            if (node.isDir && (!multiple || onIcon)) void toggleNode(node, currentPath);
          }}
        >
          {node.isDir ? (
            <>
              {isLoading ? (
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground chevron-icon" />
              ) : loaded && !hasChildren ? (
                <div className="w-4 h-4" />
              ) : isExpanded ? (
                <ChevronDown className="w-4 h-4 text-muted-foreground chevron-icon" />
              ) : (
                <ChevronRight className="w-4 h-4 text-muted-foreground chevron-icon" />
              )}
              <Folder className="w-4 h-4 text-brand folder-icon" />
            </>
          ) : (
            <div className="w-4 h-4" />
          )}
          <span className="text-sm flex-1 truncate">{node.name}</span>
          {multiple && isSelected && <Check className="w-4 h-4 shrink-0 text-brand" />}
        </div>
        {node.isDir && isExpanded && hasChildren && (
          <div>{node.children!.map((child) => renderNode(child, currentPath, level + 1))}</div>
        )}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <div className="flex-1 min-h-[300px] max-h-[500px] border rounded-md p-2 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">加载中...</span>
            </div>
          ) : tree.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">暂无目录</div>
          ) : (
            <div>{tree.map((node) => renderNode(node))}</div>
          )}
        </div>

        {/* 这一栏一直占着位置：第一次选中时对话框不会变高、重新居中，下一下就不会点偏 */}
        <div className="text-sm text-muted-foreground px-2 py-1 bg-muted rounded break-all">
          {multiple ? (
            picked.size > 0 ? (
              <>
                已选 {picked.size} 个: <span className="font-medium">{[...picked].join("、")}</span>
              </>
            ) : (
              "点目录名勾选，可以勾多个；点箭头展开"
            )
          ) : selectedPath ? (
            <>
              已选择: <span className="font-medium">{selectedPath}</span>
            </>
          ) : (
            "点一个目录选中"
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={handleConfirm} disabled={multiple ? picked.size === 0 : !selectedPath}>
            {multiple && picked.size > 0 ? `确认（${picked.size}）` : "确认"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
