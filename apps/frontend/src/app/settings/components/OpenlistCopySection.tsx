"use client";

import { useCallback, useEffect, useState } from "react";
import { FolderOpen, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { AccountInfo, OpenlistCopySettings } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TreeSelectDialog } from "@/components/TreeSelectDialog";
import { api } from "@/lib/api";
import { accountLabel } from "@/lib/drive";
import { apiErrorMessage } from "@/lib/axios";

/** OpenList 之外的账号都是「网盘」：以后接新网盘时这里不用动（services/drive 的规矩） */
const isDriveAccount = (a: AccountInfo): boolean => a.accountType !== "openlist";

type Props = {
  value: OpenlistCopySettings;
  onChange: (next: OpenlistCopySettings) => void;
};

/**
 * 「复制到 OpenList」：一个 OpenList 账号 + 一个默认目标目录 + 每个网盘账号在 OpenList 里的挂载根。
 *
 * 挂载根是这一节的关键：网盘上的绝对路径拼上它就是 OpenList 里的路径，
 * 所以任意目录、任意网盘的新文件都复制得了，不再只限 115 的默认下载目录。
 * 整块当一个值交给表单（同 OrganizeSection），行数不定的映射在这里自己管。
 */
export function OpenlistCopySection({ value, onChange }: Props) {
  const [accounts, setAccounts] = useState<AccountInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [browsing, setBrowsing] = useState<{ title: string; onPick: (path: string) => void } | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    api.accounts
      .list()
      .then(setAccounts)
      .catch(() => setFailed(true));
  }, []);

  const set = (patch: Partial<OpenlistCopySettings>) => onChange({ ...value, ...patch });
  const setMount = (account: string, path: string) => {
    const mounts = { ...(value.mounts ?? {}) };
    // 存之前去空白：粘进来的路径常带前后空格，带着存会拼成「/ /115」这种谁也打不开的路径
    if (path.trim()) mounts[account] = path.trim();
    else delete mounts[account];
    set({ mounts });
  };

  const olAccounts = (accounts ?? []).filter((a) => a.accountType === "openlist");
  const driveAccounts = (accounts ?? []).filter(isDriveAccount);
  const olName = value.account ?? "";
  const olMissing = olName !== "" && accounts !== null && !olAccounts.some((a) => a.name === olName);

  /** 从 OpenList 的根目录起浏览，给挂载根 / 目标目录选路径 */
  const loadDirs = useCallback(
    (path: string) => (olName ? api.directory.remote(olName, path ? `/${path}` : "/") : Promise.resolve([])),
    [olName],
  );

  const check = async () => {
    if (!olName) return;
    setChecking(true);
    try {
      const dirs = Object.entries(value.mounts ?? {});
      const targets = [...dirs.map(([acc, path]) => ({ what: `${acc} 的挂载根`, path })), { what: "目标目录", path: value.dstDir ?? "" }];
      const bad: string[] = [];
      for (const t of targets) {
        if (!t.path.trim()) continue;
        try {
          await api.directory.remote(olName, t.path);
        } catch (err) {
          bad.push(`${t.what}（${t.path}）：${apiErrorMessage(err, "打不开")}`);
        }
      }
      if (bad.length === 0) toast.success("都能在 OpenList 里打开");
      else toast.error(bad.join("；"));
    } finally {
      setChecking(false);
    }
  };

  const pathField = (key: string, label: string, current: string, onPick: (v: string) => void, placeholder: string, hint?: string) => (
    <div key={key} className="flex flex-col gap-1.5">
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      <InputGroup>
        <InputGroupInput value={current} placeholder={placeholder} onChange={(e) => onPick(e.target.value)} />
        <InputGroupButton
          disabled={!olName}
          title={olName ? "从 OpenList 里选" : "先选 OpenList 账号"}
          onClick={() => setBrowsing({ title: label, onPick: (p) => onPick(`/${p}`) })}
        >
          <FolderOpen />
        </InputGroupButton>
      </InputGroup>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );

  return (
    <section id="openlist-copy" className="scroll-mt-20 space-y-4 rounded-xl border bg-card p-6">
      <h2 className="text-base font-medium">复制到 OpenList</h2>
      <p className="text-sm text-muted-foreground">
        网盘上新落下的文件（云下载、转存、追更、网盘监控），让 OpenList 复制到另一个存储，比如挂载的本地磁盘。
        复制哪些由任务上的开关决定；这里配的是「用哪个 OpenList、复制到哪、各个网盘挂在 OpenList 的什么位置」。
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium text-muted-foreground">OpenList 账号</Label>
          <Select value={olName} onValueChange={(v) => set({ account: v })} disabled={olAccounts.length === 0 && !olMissing}>
            <SelectTrigger className="w-full">
              <SelectValue
                placeholder={accounts === null ? (failed ? "账号列表没读出来" : "加载中…") : olAccounts.length === 0 ? "还没有 openlist 账号" : "选择账号"}
              />
            </SelectTrigger>
            <SelectContent>
              {olMissing && <SelectItem value={olName}>{olName}（已不存在）</SelectItem>}
              {olAccounts.map((a) => (
                <SelectItem key={a.name} value={a.name}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className={olMissing ? "text-xs text-warning" : "text-xs text-muted-foreground"}>
            {failed
              ? "账号列表没读出来，刷新页面再试"
              : olMissing
                ? `账号「${olName}」已经不在了：换一个，或者到「账户」页重新添加`
                : accounts !== null && olAccounts.length === 0
                  ? "还没有 openlist 账号，先到「账户」页添加一个"
                  : "用这个账号调 OpenList 的接口"}
          </p>
        </div>
        {pathField("dst", "默认目标目录", value.dstDir ?? "", (v) => set({ dstDir: v.trim() }), "/local/downloads", "任务上没单独指定时复制到这里")}
      </div>

      <div className="space-y-3">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">各个网盘在 OpenList 里的挂载根</h3>
          <p className="text-xs text-muted-foreground">
            OpenList 把网盘挂在哪个目录下就填哪个，比如 115 挂在 <code>/115</code>。
            网盘上的路径拼上它就是 OpenList 里的路径；不填的账号不复制。
          </p>
        </div>
        {failed ? (
          <p className="text-sm text-destructive">账号列表没读出来，刷新页面再试。</p>
        ) : accounts === null ? (
          <p className="text-sm text-muted-foreground">加载中…</p>
        ) : driveAccounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有 115 / 夸克账号，先到「账户」页添加。</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {driveAccounts.map((a) =>
              pathField(a.name, accountLabel(a.name, a.accountType), value.mounts?.[a.name] ?? "", (v) => setMount(a.name, v), "/115"),
            )}
          </div>
        )}
        {value.srcDir && Object.keys(value.mounts ?? {}).length === 0 && (
          <p className="text-xs text-warning">
            旧配置里的源目录（{value.srcDir}）没能自动换算成挂载根（115 接口没通或默认下载目录变过）。
            在上面填好挂载根并保存，复制才会重新工作。
          </p>
        )}
        <Button type="button" variant="outline" size="sm" disabled={!olName || checking} onClick={() => void check()}>
          {checking ? <Loader2 className="size-4 animate-spin" /> : null}
          检查这些目录
        </Button>
      </div>

      {browsing && (
        <TreeSelectDialog
          open
          onOpenChange={(o) => !o && setBrowsing(null)}
          title={`选择${browsing.title}`}
          description={<>从 OpenList 账号 {olName} 的根目录里选</>}
          load={loadDirs}
          onConfirm={(path) => {
            browsing.onPick(path);
            setBrowsing(null);
          }}
        />
      )}
    </section>
  );
}
