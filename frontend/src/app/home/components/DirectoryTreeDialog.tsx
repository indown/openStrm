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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface TreeNode {
  name: string;
  id: number;
  isDir: boolean;
  hasChildren?: boolean; // 标记是否有子目录（API返回的）
  children?: TreeNode[]; // 已加载的子节点
}

interface DirectoryTreeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: string;
  onSelect: (path: string) => void;
  onSelectWithTargetPath?: (originPath: string, targetPath: string) => void; // 同时设置远程和本地路径的回调
}

export function DirectoryTreeDialog({
  open,
  onOpenChange,
  account,
  onSelect,
  onSelectWithTargetPath,
}: DirectoryTreeDialogProps) {
  const [tree, setTree] = React.useState<TreeNode[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [expandedNodes, setExpandedNodes] = React.useState<Set<number>>(
    new Set()
  );
  const [loadingNodes, setLoadingNodes] = React.useState<Set<number>>(
    new Set()
  );
  const [selectedPath, setSelectedPath] = React.useState<string>("");
  const [showAutoFillDialog, setShowAutoFillDialog] = React.useState(false);

  // 加载目录树
  const loadTree = React.useCallback(
    async (path: string = "") => {
      if (!account) return;

      setLoading(true);
      try {
        const response = await axiosInstance.post("/api/directory/remote/list", {
          account,
          path,
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
    [account]
  );

  // 当对话框打开时加载根目录
  React.useEffect(() => {
    if (open && account) {
      loadTree("");
      setExpandedNodes(new Set());
      setSelectedPath("");
    }
  }, [open, account, loadTree]);

  // 展开/折叠节点
  const toggleNode = async (node: TreeNode, parentPath: string = "") => {
    const currentPath = parentPath
      ? `${parentPath}/${node.name}`
      : node.name;

    if (expandedNodes.has(node.id)) {
      // 折叠
      setExpandedNodes((prev) => {
        const next = new Set(prev);
        next.delete(node.id);
        return next;
      });
    } else {
      // 展开 - 如果还没有加载子节点，先加载
      // 如果children属性不存在，说明还没有加载过
      if (node.children === undefined) {
        setLoadingNodes((prev) => new Set(prev).add(node.id));
        try {
          const response = await axiosInstance.post("/api/directory/remote/list", {
            account,
            path: currentPath,
          });

          if (response.data.code === 200) {
            const children = response.data.data || [];
            const updatedTree = updateTreeNode(tree, node.id, {
              ...node,
              children: children, // 即使为空数组也设置，表示已加载过
            });
            setTree(updatedTree);
            // 如果有子节点，自动展开
            if (children.length > 0) {
              setExpandedNodes((prev) => new Set(prev).add(node.id));
            }
          }
        } catch (error) {
          console.error("Error loading children:", error);
          // 加载失败时，设置children为空数组，表示已尝试加载
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
        // 已经加载过，直接展开
        setExpandedNodes((prev) => new Set(prev).add(node.id));
      }
    }
  };

  // 更新树节点
  const updateTreeNode = (
    nodes: TreeNode[],
    targetId: number,
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
    if (!selectedPath) return;
    
    // 如果有回调函数，总是显示确认对话框
    if (onSelectWithTargetPath) {
      setShowAutoFillDialog(true);
      return;
    }
    
    // 否则直接选择
    onSelect(selectedPath);
    onOpenChange(false);
  };

  // 自动填充确认
  const handleAutoFillConfirm = () => {
    if (!selectedPath || !onSelectWithTargetPath) return;
    
    // 自动填充本地路径：账号名/远程路径
    const autoTargetPath = `${account}/${selectedPath}`;
    onSelectWithTargetPath(selectedPath, autoTargetPath);
    setShowAutoFillDialog(false);
    onOpenChange(false);
  };

  // 不自动填充
  const handleAutoFillCancel = () => {
    if (!selectedPath) return;
    
    // 只设置远程路径，不设置本地路径
    onSelect(selectedPath);
    setShowAutoFillDialog(false);
    onOpenChange(false);
  };

  // 渲染树节点
  const renderTreeNode = (
    node: TreeNode,
    parentPath: string = "",
    level: number = 0
  ): React.ReactNode => {
    // 构建当前路径，根目录时parentPath为空字符串
    const currentPath = parentPath
      ? `${parentPath}/${node.name}`
      : node.name;
    const isExpanded = expandedNodes.has(node.id);
    const isLoading = loadingNodes.has(node.id);
    const isSelected = selectedPath === currentPath;
    // 如果children为undefined，表示还没有加载过
    const hasLoadedChildren = node.children !== undefined;
    // 是否有子节点可以显示
    const hasChildrenToShow = hasLoadedChildren && node.children && node.children.length > 0;

    return (
      <div key={node.id} className="select-none">
        <div
          className={`flex items-center gap-1 px-2 py-1.5 rounded hover:bg-gray-100 cursor-pointer ${
            isSelected ? "bg-blue-50 text-blue-600" : ""
          }`}
          style={{ paddingLeft: `${level * 20 + 8}px` }}
          onClick={(e) => {
            // 点击图标区域时展开/折叠
            const target = e.target as HTMLElement;
            if (target.closest('.chevron-icon') || target.closest('.folder-icon')) {
              if (node.isDir) {
                toggleNode(node, parentPath);
              }
            } else {
              // 点击其他区域时选择路径
              handleSelect(currentPath);
              // 如果是目录，也展开/折叠
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
                // 已加载但没有子目录，显示空图标
                <div className="w-4 h-4" />
              ) : (
                // 未加载，显示展开图标（表示可以展开）
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
          <DialogTitle>选择目录</DialogTitle>
          <DialogDescription>
            选择远程路径，当前账户: {account}
          </DialogDescription>
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

      {/* 自动填充本地路径确认对话框 */}
      <AlertDialog open={showAutoFillDialog} onOpenChange={setShowAutoFillDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>自动填写本地路径</AlertDialogTitle>
            <AlertDialogDescription>
              将为您自动填写本地路径，是否需要？
              <br />
              <span className="font-medium text-gray-700 mt-2 block">
                本地路径: {selectedPath ? `${account}/${selectedPath}` : ""}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleAutoFillCancel}>
              我不需要
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleAutoFillConfirm}>
              好的
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
