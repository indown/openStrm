"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { OrganizeUnit } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** 改季 / 集偏移：文件名里只有 [13] 这种绝对集数、或者季目录写错时用 */
export function AdjustDialog({
  unit,
  onOpenChange,
  onSave,
}: {
  unit: OrganizeUnit | null;
  onOpenChange: (open: boolean) => void;
  onSave: (patch: { seasonOverride: number | null; episodeOffset: number }) => Promise<void>;
}) {
  const open = unit != null;
  const [season, setSeason] = useState("");
  const [offset, setOffset] = useState("0");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!unit) return;
    setSeason(unit.seasonOverride == null ? "" : String(unit.seasonOverride));
    setOffset(String(unit.episodeOffset));
  }, [unit]);

  const save = async () => {
    setSaving(true);
    try {
      await onSave({ seasonOverride: season.trim() === "" ? null : Number(season), episodeOffset: Number(offset) || 0 });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>季与集偏移</DialogTitle>
          <DialogDescription className="break-all">「{unit?.rawName}」</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="organize-season">季</Label>
            <Input id="organize-season" type="number" min={0} max={99} value={season} onChange={(e) => setSeason(e.target.value)} placeholder="留空按文件名 / 目录名判断" />
            <p className="text-xs text-muted-foreground">强制把这个单元的所有集归到这一季；0 是特别篇（Season 00）。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="organize-offset">集偏移</Label>
            <Input id="organize-offset" type="number" value={offset} onChange={(e) => setOffset(e.target.value)} />
            <p className="text-xs text-muted-foreground">在解析出的集数上加减：文件名里是 13 而它其实是第二季第 1 集，就填 -12。</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : "重新规划"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
