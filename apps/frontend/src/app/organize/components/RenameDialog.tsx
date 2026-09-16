"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { OrganizeItem } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { baseName, dirName } from "@/lib/organize";

/** 冲突项「自己改名」：目录还是整理算出来的位置，名字自己填 */
export function RenameDialog({
  item,
  onOpenChange,
  onSave,
}: {
  item: OrganizeItem | null;
  onOpenChange: (open: boolean) => void;
  /** 成功返回 true 才关弹框；失败的提示由调用方给 */
  onSave: (name: string) => Promise<boolean>;
}) {
  const open = item != null;
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (item) setName(baseName(item.dstPath));
  }, [item]);

  const trimmed = name.trim();
  const bad = trimmed === "" ? "填个文件名" : trimmed.includes("/") ? "文件名不能带目录" : "";

  const save = async () => {
    if (bad) return;
    setSaving(true);
    try {
      if (await onSave(trimmed)) onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>自己改名</DialogTitle>
          <DialogDescription className="break-all">{item ? baseName(item.srcPath) : ""}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label htmlFor="organize-rename">整理后的文件名</Label>
          <Input
            id="organize-rename"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !bad) void save();
            }}
            autoFocus
          />
          <p className="break-all text-xs text-muted-foreground">放在 {item ? dirName(item.dstPath) : ""}/ 下；不写扩展名就沿用原来的。</p>
          {bad && <p className="text-xs text-destructive">{bad}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void save()} disabled={saving || !!bad}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : "重新规划"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
