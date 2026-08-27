"use client";

import { TreeSelectDialog } from "@/components/TreeSelectDialog";
import { api } from "@/lib/api";

interface LocalDirectoryTreeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (path: string) => void;
}

/** 本地数据目录（DATA_DIR）下的目录选择 */
export function LocalDirectoryTreeDialog({ open, onOpenChange, onSelect }: LocalDirectoryTreeDialogProps) {
  return (
    <TreeSelectDialog
      open={open}
      onOpenChange={onOpenChange}
      title="选择本地目录"
      description="选择本地路径"
      load={api.directory.local}
      onConfirm={onSelect}
    />
  );
}
