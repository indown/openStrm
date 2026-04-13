"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import axiosInstance from "@/lib/axios";
import { ChevronRight, ChevronDown, Folder, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface TreeNode {
  name: string;
  id: string; // 使用路径作为ID
  isDir: boolean;
  hasChildren?: boolean; // 标记是否有子目录（API返回的）
  children?: TreeNode[]; // 已加载的子节点
}

interface LocalDirectoryTreeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (path: string) => void;
}

export function LocalDirectoryTreeDialog({
  open,
  onOpenChange,
  onSelect,
}: LocalDirectoryTreeDialogProps) {
  const [tree, setTree] = React.useState<TreeNode[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [expandedNodes, setExpandedNodes] = React.useState<Set<string>>(
    new Set()
  );
  const [loadingNodes, setLoadingNodes] = React.useState<Set<string>>(
    new Set()
  );
  const [selectedPath, setSelectedPath] = React.useState<string>("");

  // 加载目录树
  const loadTree = React.useCallback(
    async (basePath: string = "") => {
      setLoading(true);
      try {
        const response = await axiosInstance.post("/api/directory/local/list", {
          basePath,
        });

        if (response.data.code === 200) {
          setTree(response.data.data || []);
        } else {
          console.error("Failed to load directory tree:", response.data.message);
          setTree([]);
        }
      } catch (error) {
        console.error("Error loading directory tree:", error);
        setTree([]);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  // 当对话框打开时加载根目录
  React.useEffect(() => {
    if (open) {
      loadTree("");
      setExpandedNodes(new Set());
      setSelectedPath("");
    }
  }, [open, loadTree]);

  // 展开/折叠节点
  const toggleNode = async (node: TreeNode, parentPath: string = "") => {
    const currentPath = parentPath ? `${parentPath}/${node.name}` : node.name;

    if (expandedNodes.has(node.id)) {
      // 折叠
      setExpandedNodes((prev) => {
        const next = new Set(prev);
        next.delete(node.id);
        return next;
      });
    } else {
      // 展开 - 如果还没有加载子节点，先加载
      if (node.children === undefined) {
        setLoadingNodes((prev) => new Set(prev).add(node.id));
        try {
          const response = await axiosInstance.post("/api/directory/local/list", {
            basePath: currentPath,
          });

          if (response.data.code === 200) {
            const children = response.data.data || [];
            const updatedTree = updateTreeNode(tree, node.id, {
              ...node,
              children: children,
            });
            setTree(updatedTree);
            if (children.length > 0) {
              setExpandedNodes((prev) => new Set(prev).add(node.id));
            }
          }
        } catch (error) {
          console.error("Error loading children:", error);
          const updatedTree = updateTreeNode(tree, node.id, {
            ...node,
            children: [],
          });
          setTree(updatedTree);
        } finally {
          setLoadingNodes((prev) => {
            const next = new Set(prev);
            next.delete(node.id);
            return next;
          });
        }
      } else {
        setExpandedNodes((prev) => new Set(prev).add(node.id));
      }
    }
  };

  // 更新树节点
  const updateTreeNode = (
    nodes: TreeNode[],
    targetId: string,
    updatedNode: TreeNode
  ): TreeNode[] => {
    return nodes.map((node) => {
      if (node.id === targetId) {
        return updatedNode;
      }
      if (node.children) {
        return {
          ...node,
          children: updateTreeNode(node.children, targetId, updatedNode),
        };
      }
      return node;
    });
  };

  // 选择路径
  const handleSelect = (path: string) => {
    setSelectedPath(path);
  };

  // 确认选择
  const handleConfirm = () => {
    if (selectedPath) {
      onSelect(selectedPath);
      onOpenChange(false);
    }
  };

  // 渲染树节点
  const renderTreeNode = (
    node: TreeNode,
    parentPath: string = "",
    level: number = 0
  ): React.ReactNode => {
    const currentPath = parentPath
      ? `${parentPath}/${node.name}`
      : node.name;
    const isExpanded = expandedNodes.has(node.id);
    const isLoading = loadingNodes.has(node.id);
    const isSelected = selectedPath === currentPath;
    const hasLoadedChildren = node.children !== undefined;
    const hasChildrenToShow =
      hasLoadedChildren && node.children && node.children.length > 0;

    return (
      <div key={node.id} className="select-none">
        <div
          className={`flex items-center gap-1 px-2 py-1.5 rounded hover:bg-gray-100 cursor-pointer ${
            isSelected ? "bg-blue-50 text-blue-600" : ""
          }`}
          style={{ paddingLeft: `${level * 20 + 8}px` }}
          onClick={(e) => {
            const target = e.target as HTMLElement;
            if (
              target.closest(".chevron-icon") ||
              target.closest(".folder-icon")
            ) {
              if (node.isDir) {
                toggleNode(node, parentPath);
              }
            } else {
              handleSelect(currentPath);
              if (node.isDir) {
                toggleNode(node, parentPath);
              }
            }
          }}
        >
          {node.isDir ? (
            <>
              {isLoading ? (
                <Loader2 className="w-4 h-4 animate-spin text-gray-400 chevron-icon" />
              ) : hasLoadedChildren && hasChildrenToShow ? (
                isExpanded ? (
                  <ChevronDown className="w-4 h-4 text-gray-400 chevron-icon" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-gray-400 chevron-icon" />
                )
              ) : hasLoadedChildren && !hasChildrenToShow ? (
                <div className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4 text-gray-400 chevron-icon" />
              )}
              <Folder className="w-4 h-4 text-blue-500 folder-icon" />
            </>
          ) : (
            <div className="w-4 h-4" />
          )}
          <span className="text-sm flex-1 truncate">{node.name}</span>
        </div>
        {node.isDir && isExpanded && hasChildrenToShow && (
          <div>
            {node.children!.map((child) =>
              renderTreeNode(child, currentPath, level + 1)
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>选择本地目录</DialogTitle>
          <DialogDescription>选择本地路径</DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-[300px] max-h-[500px] border rounded-md p-2 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
              <span className="ml-2 text-sm text-gray-500">加载中...</span>
            </div>
          ) : tree.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-sm text-gray-500">
              暂无目录
            </div>
          ) : (
            <div>{tree.map((node) => renderTreeNode(node))}</div>
          )}
        </div>

        {selectedPath && (
          <div className="text-sm text-gray-600 px-2 py-1 bg-gray-50 rounded">
            已选择: <span className="font-medium">{selectedPath}</span>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleConfirm} disabled={!selectedPath}>
            确认
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
