"use client";
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import axiosInstance from "@/lib/axios";

type Settings = {
  "user-agent"?: string;
  strmExtensions?: string[];
  downloadExtensions?: string[];
  emby?: { url?: string; apiKey?: string };
  download?: {
    maxConcurrent?: number;
    maxPerSecond?: number;
    linkMaxConcurrent?: number;
  };
} & Record<string, unknown>;

export default function SettingsPage() {
  const [data, setData] = useState<Settings>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [strmExtensionsInput, setStrmExtensionsInput] = useState("");
  const [downloadExtensionsInput, setDownloadExtensionsInput] = useState("");

  useEffect(() => {
    axiosInstance.get("/api/settings")
      .then((r) => {
        const settings = r.data || {};
        setData(settings);
        setStrmExtensionsInput((settings.strmExtensions || []).join(", "));
        setDownloadExtensionsInput((settings.downloadExtensions || []).join(", "));
      })
      .finally(() => setLoading(false));
  }, []);

  const onSave = async () => {
    setSaving(true);
    try {
      // 处理strmExtensions输入
      const strmExtensions = strmExtensionsInput
        .split(",")
        .map(ext => ext.trim())
        .filter(ext => ext.length > 0)
        .map(ext => ext.startsWith(".") ? ext : `.${ext}`)
        .map(ext => ext.toLowerCase()); // 确保扩展名都是小写
      
      // 处理downloadExtensions输入
      const downloadExtensions = downloadExtensionsInput
        .split(",")
        .map(ext => ext.trim())
        .filter(ext => ext.length > 0)
        .map(ext => ext.startsWith(".") ? ext : `.${ext}`)
        .map(ext => ext.toLowerCase()); // 确保扩展名都是小写
      
      const saveData = {
        ...data,
        strmExtensions,
        downloadExtensions
      };
      
      await axiosInstance.put("/api/settings", saveData);
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
              placeholder="请输入 例如：.mkv, .mp4, .mp3"
            />
            <p className="text-xs text-muted-foreground">
              用逗号分隔，自动添加点号前缀
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>下载文件扩展名</Label>
            <Input
              value={downloadExtensionsInput}
              onChange={(e) => setDownloadExtensionsInput(e.target.value)}
              placeholder="请输入 例如：.srt, .ass, .sub, .nfo"
            />
            <p className="text-xs text-muted-foreground">
              用逗号分隔，自动添加点号前缀
            </p>
          </div>
        </div>
      </section>

      <Separator />

      <section className="space-y-4">
        <h2 className="text-base font-medium">下载限流配置</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label>每秒最大请求数 (maxPerSecond)</Label>
            <Input
              type="number"
              min="1"
              max="100"
              value={data.download?.maxPerSecond || 2}
              onChange={(e) =>
                setData({
                  ...data,
                  download: { 
                    ...(data.download || {}), 
                    maxPerSecond: parseInt(e.target.value) || 2 
                  },
                })
              }
              placeholder="2"
            />
            <p className="text-xs text-muted-foreground">
              控制每秒最多发送的请求数量
            </p>
          </div>
          <div className="space-y-2">
            <Label>最大并发数 (maxConcurrent)</Label>
            <Input
              type="number"
              min="1"
              max="50"
              value={data.download?.maxConcurrent || 5}
              onChange={(e) =>
                setData({
                  ...data,
                  download: { 
                    ...(data.download || {}), 
                    maxConcurrent: parseInt(e.target.value) || 5 
                  },
                })
              }
              placeholder="5"
            />
            <p className="text-xs text-muted-foreground">
              控制同时进行的下载任务数量
            </p>
          </div>
          <div className="space-y-2">
            <Label>链接获取并发数 (linkMaxConcurrent)</Label>
            <Input
              type="number"
              min="1"
              max="50"
              value={data.download?.linkMaxConcurrent || 10}
              onChange={(e) =>
                setData({
                  ...data,
                  download: { 
                    ...(data.download || {}), 
                    linkMaxConcurrent: parseInt(e.target.value) || 10 
                  },
                })
              }
              placeholder="10"
            />
            <p className="text-xs text-muted-foreground">
              控制同时获取下载链接的数量
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


