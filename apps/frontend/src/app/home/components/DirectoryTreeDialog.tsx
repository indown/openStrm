"use client";

import * as React from "react";
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
import { TreeSelectDialog } from "@/components/TreeSelectDialog";
import { api } from "@/lib/api";

interface DirectoryTreeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: string;
  onSelect: (path: string) => void;
  /** 传了就在确认后追问一次是否按「账号名/远程路径」自动填本地路径 */
  onSelectWithTargetPath?: (originPath: string, targetPath: string) => void;
}

/** 远程目录选择：115 网盘和 OpenList 都走这里，按账号浏览，后端按账号类型分流 */
export function DirectoryTreeDialog({ open, onOpenChange, account, onSelect, onSelectWithTargetPath }: DirectoryTreeDialogProps) {
  const [pendingPath, setPendingPath] = React.useState<string | null>(null);
  const load = React.useCallback((path: string) => api.directory.remote(account, path), [account]);

  const finish = (fill: boolean) => {
    if (pendingPath == null) return;
    if (fill && onSelectWithTargetPath) onSelectWithTargetPath(pendingPath, `${account}/${pendingPath}`);
    else onSelect(pendingPath);
    setPendingPath(null);
    onOpenChange(false);
  };

  return (
    <>
      <TreeSelectDialog
        open={open && account !== ""}
        onOpenChange={onOpenChange}
        title="选择目录"
        description={<>选择远程路径，当前账户: {account}</>}
        load={load}
        onConfirm={(path) => {
          if (!onSelectWithTargetPath) {
            onSelect(path);
            return;
          }
          setPendingPath(path);
          return false;
        }}
      />
      <AlertDialog open={pendingPath != null} onOpenChange={(o) => !o && setPendingPath(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>自动填写本地路径</AlertDialogTitle>
            <AlertDialogDescription>
              将为您自动填写本地路径，是否需要？
              <br />
              <span className="font-medium text-foreground mt-2 block">
                本地路径: {pendingPath ? `${account}/${pendingPath}` : ""}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => finish(false)}>我不需要</AlertDialogCancel>
            <AlertDialogAction onClick={() => finish(true)}>好的</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
