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

export const taskFormSchema = z.object({
  account: z.string().min(1, "Account 不能为空"),
  originPath: z.string().min(1, "Origin Path 不能为空"),
  targetPath: z.string().optional(),
  strmType: z.string().optional(),
  strmPrefix: z.string().optional(),
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
  const [formValues, setFormValues] = React.useState({
    strmPrefix: "",
    targetPath: "",
  });

  // 计算预览路径
  const getPreviewPath = () => {
    const { strmPrefix, targetPath } = formValues;
    if (!strmPrefix && !targetPath) {
      return "请输入 Strm Prefix 和 Target Path";
    }
    const prefix = strmPrefix || "";
    const target = targetPath || "";
    const combinedPath = prefix + "/" + target;
    return `${combinedPath}/....../abc.mkv`;
  };

  const form = useForm<TaskFormValues>({
    resolver: zodResolver(taskFormSchema),
    defaultValues: task ?? {
      account: "",
      originPath: "",
      targetPath: "",
      strmType: "local",
      strmPrefix: "",
    },
  });

  // 监听表单值变化
  React.useEffect(() => {
    const subscription = form.watch((value) => {
      setFormValues({
        strmPrefix: value.strmPrefix || "",
        targetPath: value.targetPath || "",
      });
    });
    return () => subscription.unsubscribe();
  }, [form]);

  // 初始化时同步表单值到状态
  React.useEffect(() => {
    if (task) {
      setFormValues({
        strmPrefix: task.strmPrefix || "",
        targetPath: task.targetPath || "",
      });
    }
  }, [task]);

  // 获取选中账户的类型
  const getAccountType = (accountName: string) => {
    const selectedAccount = accounts.find((acc) => acc.name === accountName);
    return selectedAccount?.accountType || "";
  };

  const onSubmit = async (values: TaskFormValues) => {
    setLoading(true);
    try {
      // 自动获取选中账户的类型
      const accountType = getAccountType(values.account);
      const taskData = {
        ...values,
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
                    <Input {...field} placeholder="Origin Path" />
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

            {/* Strm Type */}
            <FormField
              control={form.control}
              name="strmType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Strm 类型</FormLabel>
                  <FormControl>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select strm type" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="local">local</SelectItem>
                        <SelectItem value="cloud" disabled>
                          cloud
                        </SelectItem>
                      </SelectContent>
                    </Select>
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
                        用户生成strm文件的前缀，为Strm Prefix+target Path
                        <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-gray-800"></div>
                      </div>
                    </div>
                  </FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="Strm Prefix" />
                  </FormControl>
                  <div className="text-sm text-red-600 font-medium">
                    请确保emby可以访问到该路径: {getPreviewPath()}
                  </div>
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
      </DialogContent>
    </Dialog>
  );
}
