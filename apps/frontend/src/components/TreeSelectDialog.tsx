"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { ChevronRight, ChevronDown, Folder, Loader2 } from "lucide-react";
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
  onConfirm: (path: string) => void | false;
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
export function TreeSelectDialog({ open, onOpenChange, title, description, load, onConfirm }: TreeSelectDialogProps) {
  const [tree, setTree] = React.useState<TreeSelectNode[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [expanded, setExpanded] = React.useState<Set<TreeSelectNode["id"]>>(new Set());
  const [loadingNodes, setLoadingNodes] = React.useState<Set<TreeSelectNode["id"]>>(new Set());
  const [selectedPath, setSelectedPath] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setExpanded(new Set());
    setSelectedPath("");
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
    if (!selectedPath) return;
    if (onConfirm(selectedPath) === false) return;
    onOpenChange(false);
  };

  const renderNode = (node: TreeSelectNode, parentPath = "", level = 0): React.ReactNode => {
    const currentPath = parentPath ? `${parentPath}/${node.name}` : node.name;
    const isExpanded = expanded.has(node.id);
    const isLoading = loadingNodes.has(node.id);
    const isSelected = selectedPath === currentPath;
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
            if (!onIcon) setSelectedPath(currentPath);
            if (node.isDir) void toggleNode(node, currentPath);
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

        {selectedPath && (
          <div className="text-sm text-muted-foreground px-2 py-1 bg-muted rounded">
            已选择: <span className="font-medium">{selectedPath}</span>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={handleConfirm} disabled={!selectedPath}>确认</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
