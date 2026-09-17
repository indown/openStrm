"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Loader2 } from "lucide-react";
import type { OrganizeUnit } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";

/**
 * 两个字段都当字符串收：空字符串是"按文件名 / 目录名判断"，和"填了 0"不是一回事，
 * 数字类型表达不了这个区别。合法性在这里拦住 —— 以前是 `Number(season)` 直接往后端送，
 * 随手打个 `1x` 会变成 NaN。
 */
const schema = z.object({
  season: z
    .string()
    .trim()
    .refine((v) => v === "" || /^\d{1,2}$/.test(v), "季填 0–99 的整数，留空表示按名字判断"),
  offset: z
    .string()
    .trim()
    .refine((v) => v === "" || /^-?\d{1,4}$/.test(v), "集偏移填整数，可以是负数"),
});

type Values = z.infer<typeof schema>;

/** 改季 / 集偏移：文件名里只有 [13] 这种绝对集数、或者季目录写错时用 */
export function AdjustDialog({
  unit,
  onOpenChange,
  onSave,
}: {
  unit: OrganizeUnit | null;
  onOpenChange: (open: boolean) => void;
  /** 成功返回 true 才关弹框；失败的提示由调用方给 */
  onSave: (patch: { seasonOverride: number | null; episodeOffset: number }) => Promise<boolean>;
}) {
  const open = unit != null;
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { season: "", offset: "0" } });
  const saving = form.formState.isSubmitting;

  useEffect(() => {
    if (!unit) return;
    form.reset({
      season: unit.seasonOverride == null ? "" : String(unit.seasonOverride),
      offset: String(unit.episodeOffset),
    });
  }, [unit, form]);

  const submit = async (values: Values) => {
    const ok = await onSave({
      seasonOverride: values.season === "" ? null : Number(values.season),
      episodeOffset: values.offset === "" ? 0 : Number(values.offset),
    });
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>季与集偏移</DialogTitle>
          <DialogDescription className="break-all">「{unit?.rawName}」</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} className="space-y-4 py-2">
            <FormField
              control={form.control}
              name="season"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>季</FormLabel>
                  <FormControl>
                    <Input inputMode="numeric" placeholder="留空按文件名 / 目录名判断" {...field} />
                  </FormControl>
                  <FormDescription className="text-xs">
                    强制把这个单元的所有集归到这一季；0 是特别篇（Season 00）。
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="offset"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>集偏移</FormLabel>
                  <FormControl>
                    <Input inputMode="numeric" {...field} />
                  </FormControl>
                  <FormDescription className="text-xs">
                    在解析出的集数上加减：文件名里是 13 而它其实是第二季第 1 集，就填 -12。
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
                取消
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : "重新规划"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
