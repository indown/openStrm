"use client";

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useForm, useWatch, type Control } from "react-hook-form";
import { toast } from "sonner";
import { FolderOpen } from "lucide-react";
import type { TaskDefinition } from "@openstrm/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { DirectoryTreeDialog } from "./DirectoryTreeDialog";
import { LocalDirectoryTreeDialog } from "./LocalDirectoryTreeDialog";

/** 5 段（或带秒的 6 段）就放行，字段是否合法由后端的 cron 库校验，失败会以 400 回来 */
const CRON_SHAPE = /^\S+(?:\s+\S+){4,5}$/;

export const taskFormSchema = z.object({
  account: z.string().min(1, "请选择账户"),
  originPath: z.string().trim().min(1, "远程路径不能为空"),
  targetPath: z.string().trim().min(1, "本地路径不能为空"),
  strmPrefix: z.string().trim().min(1, "Strm 前缀不能为空"),
  strmType: z.string().optional(),
  removeExtraFiles: z.boolean().optional(),
  enable302: z.boolean().optional(),
  enablePathEncoding: z.boolean().optional(),
  cronExpression: z
    .string()
    .trim()
    .refine((v) => v === "" || CRON_SHAPE.test(v), "cron 表达式应为 5 段，例如 0 3 * * *"),
});

export type TaskFormValues = z.infer<typeof taskFormSchema>;

/** 编辑时传进来的任务：定义 + 表单存的 strmType */
export type TaskEditable = Partial<Omit<TaskDefinition, "id">> & { id?: string; strmType?: string };

/** Select 的选项值不能是空串，用两个占位值表示"不定时"和"自定义" */
const NONE = "__none__";
const CUSTOM = "__custom__";
const CRON_PRESETS = [
  { value: "0 * * * *", label: "每小时" },
  { value: "0 */6 * * *", label: "每 6 小时" },
  { value: "0 3 * * *", label: "每天 03:00" },
  { value: "0 4 * * 1", label: "每周一 04:00" },
];

interface AddTaskDialogProps {
  task?: TaskEditable;
  trigger?: React.ReactNode;
  onSuccess?: () => void;
  accounts?: Array<{ name: string; accountType: string }>;
  accountsLoading?: boolean;
  /** 受控模式：页面统一管一个编辑弹框时传入 open / onOpenChange；不传则自己管 open（"新建任务"按钮那种用法） */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** 编辑时，如果启用了 302 且 strmPrefix 以账号结尾，需要去掉账号后缀（保存时会再拼回去） */
function stripAccountSuffix(task: TaskEditable): string {
  let prefix = task.strmPrefix || "";
  if (task.enable302 && task.account && prefix.endsWith("/" + task.account)) {
    prefix = prefix.slice(0, -(task.account.length + 1));
  }
  return prefix;
}

/** 当前应当显示的表单值：编辑时来自 task（去掉 302 拼上的账号后缀），新增时是空表单 */
function defaultsFor(task: TaskEditable | undefined): TaskFormValues {
  return {
    account: task?.account ?? "",
    originPath: task?.originPath ?? "",
    targetPath: task?.targetPath ?? "",
    strmPrefix: task ? stripAccountSuffix(task) : "",
    strmType: task?.strmType ?? "local",
    removeExtraFiles: task?.removeExtraFiles ?? true,
    enable302: task?.enable302 ?? false,
    enablePathEncoding: task?.enablePathEncoding ?? false,
    cronExpression: task?.cronExpression ?? "",
  };
}

function CheckboxRow({
  control,
  name,
  label,
  description,
}: {
  control: Control<TaskFormValues>;
  name: "removeExtraFiles" | "enable302" | "enablePathEncoding";
  label: string;
  description: string;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className="flex items-start gap-3 rounded-md border p-3 space-y-0">
          <FormControl>
            <Checkbox checked={field.value === true} onCheckedChange={(v) => field.onChange(v === true)} className="mt-0.5" />
          </FormControl>
          <div className="space-y-1 leading-snug">
            <FormLabel className="cursor-pointer font-medium">{label}</FormLabel>
            <FormDescription className="text-xs">{description}</FormDescription>
          </div>
        </FormItem>
      )}
    />
  );
}

export function AddTaskDialog({
  task,
  trigger,
  onSuccess,
  accounts = [],
  accountsLoading = false,
  open: openProp,
  onOpenChange,
}: AddTaskDialogProps) {
  const [openState, setOpenState] = React.useState(false);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : openState;
  const [loading, setLoading] = React.useState(false);
  const [directoryDialogOpen, setDirectoryDialogOpen] = React.useState(false);
  const [localDirectoryDialogOpen, setLocalDirectoryDialogOpen] = React.useState(false);
  /** 定时下拉选了"自定义"：表达式为空或不等于预设时也保持输入框可编辑 */
  const [customCron, setCustomCron] = React.useState(false);

  const form = useForm<TaskFormValues>({
    resolver: zodResolver(taskFormSchema),
    defaultValues: defaultsFor(task),
  });

  const account = useWatch({ control: form.control, name: "account" }) ?? "";
  const originPath = useWatch({ control: form.control, name: "originPath" }) ?? "";
  const strmPrefix = useWatch({ control: form.control, name: "strmPrefix" }) ?? "";
  const enable302 = useWatch({ control: form.control, name: "enable302" }) ?? false;

  const accountType = accounts.find((acc) => acc.name === account)?.accountType ?? "";
  const is115Account = accountType === "115";

  const setOpen = (next: boolean) => {
    if (!isControlled) setOpenState(next);
    onOpenChange?.(next);
  };

  // 每次打开都按当前的 task 重置：useForm 的 defaultValues 只在挂载时取一次，
  // 保存成功后再点"编辑"会显示改之前的值，再存一次就把新值盖回去了
  const handleOpenChange = (next: boolean) => {
    if (next) {
      form.reset(defaultsFor(task));
      setCustomCron(false);
    }
    setOpen(next);
  };

  // 受控打开不经过 handleOpenChange（是父组件改的 open），这里补上同样的重置
  React.useEffect(() => {
    if (isControlled && openProp) {
      form.reset(defaultsFor(task));
      setCustomCron(false);
    }
  }, [isControlled, openProp, task, form]);

  /** 115 + 302 时前缀后面会拼上 /账号名；示例路径让用户看到最终写进 strm 的样子 */
  const effectivePrefix =
    is115Account && enable302 && account ? `${strmPrefix.replace(/\/+$/, "")}/${account}` : strmPrefix.replace(/\/+$/, "");
  const preview =
    strmPrefix || originPath ? `${effectivePrefix}/${originPath.replace(/^\/+/, "").replace(/\/+$/, "")}/…/abc.mkv` : "";

  const onSubmit = async (values: TaskFormValues) => {
    setLoading(true);
    try {
      // 如果是 115 账户且开启了 302，在 strmPrefix 后拼接账户名（代理按这个前缀识别 302 挂载点）
      let finalStrmPrefix = values.strmPrefix;
      if (is115Account && values.enable302 && values.account) {
        finalStrmPrefix = finalStrmPrefix.replace(/\/+$/, "") + "/" + values.account;
      }
      const taskData = { ...values, strmPrefix: finalStrmPrefix, accountType };

      if (task?.id) {
        await api.tasks.update(task.id, taskData);
      } else {
        await api.tasks.create(taskData);
      }
      toast.success(task?.id ? "任务已保存" : "任务已创建");
      onSuccess?.();
      setOpen(false);
    } catch (err) {
      // handleSubmit 会把这里抛出的错误再抛出去：不接住的话保存失败没有任何提示
      toast.error(apiErrorMessage(err, "保存失败"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {(trigger !== undefined || !isControlled) && (
        <DialogTrigger asChild>{trigger ?? <Button variant="outline">{task ? "编辑" : "新增任务"}</Button>}</DialogTrigger>
      )}

      <DialogContent className="sm:max-w-[560px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{task ? "编辑任务" : "新建任务"}</DialogTitle>
          <DialogDescription>
            把网盘里的一个目录同步成本地的 strm 目录；媒体库扫本地目录即可播放。
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="account"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>账户</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="选择网盘账户" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent className="z-[60]">
                      {accountsLoading ? (
                        <SelectItem value="loading" disabled>
                          加载中...
                        </SelectItem>
                      ) : accounts.length === 0 ? (
                        <SelectItem value="no-accounts" disabled>
                          还没有账号，请先到「账户」页添加
                        </SelectItem>
                      ) : (
                        accounts.map((acc) => (
                          <SelectItem key={acc.name} value={acc.name}>
                            {acc.name}（{acc.accountType}）
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="originPath"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>远程路径</FormLabel>
                  <div className="flex items-center gap-2">
                    <FormControl>
                      <Input {...field} placeholder="例如：tv 或 kuake/tv" className="flex-1" />
                    </FormControl>
                    {is115Account && account && (
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => setDirectoryDialogOpen(true)}
                        title="浏览网盘目录"
                      >
                        <FolderOpen className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                  <FormDescription className="text-xs">网盘（或 OpenList）里要同步的目录，从根目录算起，不用带开头的斜杠。</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="targetPath"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>本地路径</FormLabel>
                  <div className="flex items-center gap-2">
                    <FormControl>
                      <Input {...field} placeholder="例如：tv" className="flex-1" />
                    </FormControl>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => setLocalDirectoryDialogOpen(true)}
                      title="浏览本地目录"
                    >
                      <FolderOpen className="w-4 h-4" />
                    </Button>
                  </div>
                  <FormDescription className="text-xs">
                    相对数据目录（DATA_DIR）的路径，strm 会按远程目录的结构生成到这里；媒体库扫这个目录。
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="strmPrefix"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Strm 前缀</FormLabel>
                  <div className="flex items-center gap-1">
                    <FormControl>
                      <Input {...field} placeholder="例如：http://192.168.1.10:8091/d" className="flex-1" />
                    </FormControl>
                    {is115Account && enable302 && account && (
                      <Input value={`/${account}`} disabled className="w-[120px] bg-muted font-medium shrink-0" title="开启 302 后自动拼上账号名" />
                    )}
                  </div>
                  <FormDescription className="text-xs">
                    写进 strm 文件的地址前缀，播放器要能访问到。
                    {preview && (
                      <>
                        {" "}
                        示例：<code className="break-all">{preview}</code>
                      </>
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="cronExpression"
              render={({ field }) => {
                const value = field.value ?? "";
                const matchesPreset = CRON_PRESETS.some((p) => p.value === value);
                const presetValue = customCron ? CUSTOM : value === "" ? NONE : matchesPreset ? value : CUSTOM;
                return (
                  <FormItem>
                    <FormLabel>定时执行</FormLabel>
                    <div className="flex items-center gap-2">
                      <Select
                        value={presetValue}
                        onValueChange={(v) => {
                          if (v === CUSTOM) {
                            setCustomCron(true);
                            return;
                          }
                          setCustomCron(false);
                          field.onChange(v === NONE ? "" : v);
                        }}
                      >
                        <SelectTrigger className="w-[150px] shrink-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="z-[60]">
                          <SelectItem value={NONE}>不定时</SelectItem>
                          {CRON_PRESETS.map((p) => (
                            <SelectItem key={p.value} value={p.value}>
                              {p.label}
                            </SelectItem>
                          ))}
                          <SelectItem value={CUSTOM}>自定义</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormControl>
                        <Input
                          value={value}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          placeholder="分 时 日 月 周，例如 0 3 * * *"
                          className="flex-1 font-mono"
                          disabled={presetValue === NONE}
                        />
                      </FormControl>
                    </div>
                    <FormDescription className="text-xs">
                      标准 cron 表达式，按服务器时区。不定时的任务只在手动点开始、或从分享转存时触发。
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                );
              }}
            />

            <div className="space-y-2">
              {is115Account && (
                <CheckboxRow
                  control={form.control}
                  name="enable302"
                  label="Emby 302 直链"
                  description="播放时由本工具的代理直接 302 到 115 直链，不再中转流量。前缀会自动拼上 /账号名，代理靠它识别挂载点。"
                />
              )}
              <CheckboxRow
                control={form.control}
                name="removeExtraFiles"
                label="删除本地多余文件"
                description="同步时删掉本地有、网盘已经没有的文件，保持两边一致。网盘目录读出来是空的时候会跳过，防止误删。"
              />
              <CheckboxRow
                control={form.control}
                name="enablePathEncoding"
                label="strm 路径 URL 编码"
                description="把 strm 里的路径做 URL 编码。有些播放器处理不了中文或空格时打开。"
              />
            </div>

            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={loading}>
                  取消
                </Button>
              </DialogClose>
              <Button type="submit" disabled={loading}>
                {loading ? "保存中..." : "保存"}
              </Button>
            </DialogFooter>
          </form>
        </Form>

        {is115Account && account && (
          <DirectoryTreeDialog
            open={directoryDialogOpen}
            onOpenChange={setDirectoryDialogOpen}
            account={account}
            onSelect={(path) => form.setValue("originPath", path, { shouldValidate: true })}
            onSelectWithTargetPath={(nextOrigin, nextTarget) => {
              form.setValue("originPath", nextOrigin, { shouldValidate: true });
              form.setValue("targetPath", nextTarget, { shouldValidate: true });
            }}
          />
        )}

        <LocalDirectoryTreeDialog
          open={localDirectoryDialogOpen}
          onOpenChange={setLocalDirectoryDialogOpen}
          onSelect={(path) => form.setValue("targetPath", path, { shouldValidate: true })}
        />
      </DialogContent>
    </Dialog>
  );
}
