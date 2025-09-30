"use client";
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import axios from "axios";

type Settings = {
  "user-agent"?: string;
  strmExtensions?: string[];
  emby?: { url?: string; apiKey?: string };
} & Record<string, unknown>;

export default function SettingsPage() {
  const [data, setData] = useState<Settings>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [strmExtensionsInput, setStrmExtensionsInput] = useState("");

  useEffect(() => {
    axios.get("/api/settings")
      .then((r) => {
        const settings = r.data || {};
        setData(settings);
        setStrmExtensionsInput((settings.strmExtensions || []).join(", "));
      })
      .finally(() => setLoading(false));
  }, []);

  const onSave = async () => {
    setSaving(true);
    try {
      // 处理strmExtensions输入
      const extensions = strmExtensionsInput
        .split(",")
        .map(ext => ext.trim())
        .filter(ext => ext.length > 0)
        .map(ext => ext.startsWith(".") ? ext : `.${ext}`)
        .map(ext => ext.toLowerCase()); // 确保扩展名都是小写
      
      const saveData = {
        ...data,
        strmExtensions: extensions
      };
      
      await axios.put("/api/settings", saveData);
      setData(saveData);
      toast.success("保存成功");
    } catch {
      toast.error("保存失败");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div>Loading...</div>;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          配置全局选项与 Emby 通知
        </p>
      </div>

      <section className="space-y-4">
        <h2 className="text-base font-medium">基础设置</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>User-Agent</Label>
            <Input
              value={data["user-agent"] || ""}
              onChange={(e) =>
                setData({ ...data, ["user-agent"]: e.target.value })
              }
              placeholder="Mozilla/5.0 ..."
            />
          </div>
          <div className="space-y-2">
            <Label>Strm文件扩展名</Label>
            <Input
              value={strmExtensionsInput}
              onChange={(e) => setStrmExtensionsInput(e.target.value)}
              placeholder=".mkv, .mp4, .mp3"
            />
            <p className="text-xs text-muted-foreground">
              用逗号分隔，自动添加点号前缀
            </p>
          </div>
        </div>
      </section>

      <Separator />

      <section className="space-y-4">
        <h2 className="text-base font-medium">Emby</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Emby URL</Label>
            <Input
              value={data.emby?.url || ""}
              onChange={(e) =>
                setData({
                  ...data,
                  emby: { ...(data.emby || {}), url: e.target.value },
                })
              }
              placeholder="http://host.docker.internal:8096"
            />
          </div>
          <div className="space-y-2">
            <Label>Emby API Key</Label>
            <Input
              value={data.emby?.apiKey || ""}
              onChange={(e) =>
                setData({
                  ...data,
                  emby: { ...(data.emby || {}), apiKey: e.target.value },
                })
              }
              placeholder="xxxxxxxxxxxxxxxx"
            />
          </div>
        </div>
      </section>

      <div className="pt-2">
        <Button disabled={saving} onClick={onSave}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}


