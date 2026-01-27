"use client";

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import axiosInstance from "@/lib/axios";
import { HelpCircle } from "lucide-react";
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
import { FolderOpen } from "lucide-react";
import { DirectoryTreeDialog } from "./DirectoryTreeDialog";

export const taskFormSchema = z.object({
  account: z.string().min(1, "Account 不能为空"),
  originPath: z.string().min(1, "Origin Path 不能为空"),
  targetPath: z.string().optional(),
  strmType: z.string().optional(),
  strmPrefix: z.string().optional(),
  removeExtraFiles: z.boolean().optional(),
  enable302: z.boolean().optional(),
});

export type TaskFormValues = z.infer<typeof taskFormSchema>;

interface AddTaskDialogProps {
  task?: TaskFormValues & { name?: string; id?: string };
  trigger?: React.ReactNode;
  onSuccess?: () => void;
  accounts?: Array<{ name: string; accountType: string }>;
  accountsLoading?: boolean;
}
export function AddTaskDialog({
  task,
  trigger,
  onSuccess,
  accounts = [],
  accountsLoading = false,
}: AddTaskDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [directoryDialogOpen, setDirectoryDialogOpen] = React.useState(false);
  const [formValues, setFormValues] = React.useState({
    strmPrefix: "",
    originPath: "",
    account: "",
    enable302: false,
  });

  // 获取选中账户的类型
  const getAccountType = (accountName: string) => {
    const selectedAccount = accounts.find((acc) => acc.name === accountName);
    return selectedAccount?.accountType || "";
  };

  // 检查当前选中的账户是否是 115 类型
  const is115Account = getAccountType(formValues.account) === "115";

  // 计算预览路径
  const getPreviewPath = () => {
    const { strmPrefix, originPath, account, enable302 } = formValues;
    if (!strmPrefix && !originPath) {
      return "请输入 Strm Prefix 和 Origin Path";
    }
    let prefix = strmPrefix || "";
    // 如果是 115 账户且开启了 302，在前缀后拼接账户名
    if (is115Account && enable302 && account) {
      prefix = prefix.replace(/\/+$/, "") + "/" + account;
    }
    const origin = originPath || "";
    const combinedPath = prefix + "/" + origin;
    return `${combinedPath}/....../abc.mkv`;
  };

  // 编辑时，如果启用了302且strmPrefix以账号结尾，需要去掉账号后缀
  const getInitialStrmPrefix = () => {
    if (!task) return "";
    let prefix = task.strmPrefix || "";
    if (task.enable302 && task.account && prefix.endsWith("/" + task.account)) {
      prefix = prefix.slice(0, -(task.account.length + 1));
    }
    return prefix;
  };

  const form = useForm<TaskFormValues>({
    resolver: zodResolver(taskFormSchema),
    defaultValues: task ? {
      ...task,
      strmPrefix: getInitialStrmPrefix(),
    } : {
      account: "",
      originPath: "",
      targetPath: "",
      strmType: "local",
      strmPrefix: "",
      removeExtraFiles: true,
      enable302: false,
    },
  });

  // 监听表单值变化
  React.useEffect(() => {
    const subscription = form.watch((value) => {
      setFormValues({
        strmPrefix: value.strmPrefix || "",
        originPath: value.originPath || "",
        account: value.account || "",
        enable302: value.enable302 || false,
      });
    });
    return () => subscription.unsubscribe();
  }, [form]);

  // 初始化时同步表单值到状态
  React.useEffect(() => {
    if (task) {
      // 如果启用了302且strmPrefix以账号结尾，去掉账号后缀
      let prefix = task.strmPrefix || "";
      if (task.enable302 && task.account && prefix.endsWith("/" + task.account)) {
        prefix = prefix.slice(0, -(task.account.length + 1));
      }
      setFormValues({
        strmPrefix: prefix,
        originPath: task.originPath || "",
        account: task.account || "",
        enable302: task.enable302 || false,
      });
    }
  }, [task]);

  const onSubmit = async (values: TaskFormValues) => {
    setLoading(true);
    try {
      // 自动获取选中账户的类型
      const accountType = getAccountType(values.account);
      
      // 如果是115账户且开启了302，在strmPrefix后拼接账户名
      let finalStrmPrefix = values.strmPrefix || "";
      if (accountType === "115" && values.enable302 && values.account) {
        finalStrmPrefix = finalStrmPrefix.replace(/\/+$/, "") + "/" + values.account;
      }
      
      const taskData = {
        ...values,
        strmPrefix: finalStrmPrefix,
        accountType,
      };

      if (task?.id) {
        await axiosInstance.put("/api/task", { id: task.id, ...taskData });
      } else {
        await axiosInstance.post("/api/task", taskData);
      }

      onSuccess?.();
      setOpen(false);
      form.reset();
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline">{task ? "编辑" : "新增任务"}</Button>
        )}
      </DialogTrigger>

      <DialogContent className="sm:max-w-[450px]">
        <DialogHeader>
          <DialogTitle>{task ? "编辑任务" : "新增任务"}</DialogTitle>
          <DialogDescription>
            {task ? "编辑现有任务" : "添加一个新的任务"}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {/* 账号 */}
            <FormField
              control={form.control}
              name="account"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>账户</FormLabel>
                  <FormControl>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select account" />
                      </SelectTrigger>
                      <SelectContent className="z-[60]">
                        {accountsLoading ? (
                          <SelectItem value="loading" disabled>
                            加载中...
                          </SelectItem>
                        ) : accounts.length === 0 ? (
                          <SelectItem value="no-accounts" disabled>
                            暂无账号
                          </SelectItem>
                        ) : (
                          accounts.map((acc) => (
                            <SelectItem key={acc.name} value={acc.name}>
                              {acc.name} ({acc.accountType})
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* 开启 302 - 仅 115 账户显示 */}
            {is115Account && (
              <FormField
                control={form.control}
                name="enable302"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-1">
                      开启 302 重定向
                      <div className="group relative">
                        <HelpCircle className="w-4 h-4 text-gray-400 hover:text-gray-600 cursor-help" />
                        <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-2 bg-gray-800 text-white text-sm rounded-md opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10">
                          开启后，Strm 前缀会自动拼接 /账户名
                          <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-gray-800"></div>
                        </div>
                      </div>
                    </FormLabel>
                    <FormControl>
                      <div className="flex items-center space-x-2">
                        <input
                          type="checkbox"
                          id="enable302"
                          checked={field.value || false}
                          onChange={(e) => field.onChange(e.target.checked)}
                          className="rounded border-gray-300"
                        />
                        <label htmlFor="enable302" className="text-sm">
                          启用 302 重定向模式
                        </label>
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {/* Origin Path */}
            <FormField
              control={form.control}
              name="originPath"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="flex items-center gap-1">
                    远程路径
                    <div className="group relative">
                      <HelpCircle className="w-4 h-4 text-gray-400 hover:text-gray-600 cursor-help" />
                      <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-2 bg-gray-800 text-white text-sm rounded-md opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10">
                        在这里输入网盘路径或openlist的路径，如：tv 或 kuake/tv
                        <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-gray-800"></div>
                      </div>
                    </div>
                  </FormLabel>
                  <FormControl>
                    <div className="flex items-center gap-2">
                      <Input {...field} placeholder="Origin Path" className="flex-1" />
                      {is115Account && formValues.account && (
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          onClick={() => setDirectoryDialogOpen(true)}
                          title="选择目录"
                        >
                          <FolderOpen className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Target Path */}
            <FormField
              control={form.control}
              name="targetPath"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="flex items-center gap-1">
                    本地路径
                    <div className="group relative">
                      <HelpCircle className="w-4 h-4 text-gray-400 hover:text-gray-600 cursor-help" />
                      <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-2 bg-gray-800 text-white text-sm rounded-md opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10">
                        这里将生成strm文件到你的挂载目录里，比如填写 tv 将在挂载目录创建tv目录，并将 Origin Path 内所有的文件strm到TargetPath
                        <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-gray-800"></div>
                      </div>
                    </div>
                  </FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="Target Path" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />


            {/* Strm Prefix */}
            <FormField
              control={form.control}
              name="strmPrefix"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="flex items-center gap-1">
                    Strm 前缀
                    <div className="group relative">
                      <HelpCircle className="w-4 h-4 text-gray-400 hover:text-gray-600 cursor-help" />
                      <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-2 bg-gray-800 text-white text-sm rounded-md opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10">
                        用于生成strm文件的前缀，最终路径为 Strm Prefix + Origin Path
                        <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-gray-800"></div>
                      </div>
                    </div>
                  </FormLabel>
                  <FormControl>
                    <div className="flex items-center gap-1">
                      <Input {...field} placeholder="Strm Prefix" className={is115Account && formValues.enable302 ? "flex-1" : "w-full"} />
                      {is115Account && formValues.enable302 && (
                        <Input
                          value={`/${formValues.account}`}
                          disabled
                          className="w-[120px] bg-gray-100 text-gray-600 font-medium flex-shrink-0"
                        />
                      )}
                    </div>
                  </FormControl>
                  <div className="text-sm text-red-600 font-medium">
                    请确保emby可以访问到该路径: {getPreviewPath()}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Remove Extra Files */}
            <FormField
              control={form.control}
              name="removeExtraFiles"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="flex items-center gap-1">
                    删除多余文件
                    <div className="group relative">
                      <HelpCircle className="w-4 h-4 text-gray-400 hover:text-gray-600 cursor-help" />
                      <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-2 bg-gray-800 text-white text-sm rounded-md opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10">
                        开启后，任务执行时会删除本地存在但远程不存在的文件
                        <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-gray-800"></div>
                      </div>
                    </div>
                  </FormLabel>
                  <FormControl>
                    <div className="flex items-center space-x-2">
                      <input
                        type="checkbox"
                        id="removeExtraFiles"
                        checked={field.value || false}
                        onChange={(e) => field.onChange(e.target.checked)}
                        className="rounded border-gray-300"
                      />
                      <label htmlFor="removeExtraFiles" className="text-sm">
                        启用删除本地多余文件功能
                      </label>
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" disabled={loading}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={loading}>
                {loading ? "Saving..." : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </Form>

        {/* 目录树选择对话框 */}
        {is115Account && formValues.account && (
          <DirectoryTreeDialog
            open={directoryDialogOpen}
            onOpenChange={setDirectoryDialogOpen}
            account={formValues.account}
            onSelect={(path) => {
              form.setValue("originPath", path);
              setFormValues((prev) => ({ ...prev, originPath: path }));
            }}
            onSelectWithTargetPath={(originPath, targetPath) => {
              form.setValue("originPath", originPath);
              form.setValue("targetPath", targetPath);
              setFormValues((prev) => ({
                ...prev,
                originPath,
                targetPath,
              }));
            }}
          />
        )}

      </DialogContent>
    </Dialog>
  );
}
