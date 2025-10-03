"use client";

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import axiosInstance from "@/lib/axios";
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
  accounts?: Array<{name: string, accountType: string}>;
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

  // 获取选中账户的类型
  const getAccountType = (accountName: string) => {
    const selectedAccount = accounts.find(acc => acc.name === accountName);
    return selectedAccount?.accountType || "";
  };

  const onSubmit = async (values: TaskFormValues) => {
    setLoading(true);
    try {
      // 自动获取选中账户的类型
      const accountType = getAccountType(values.account);
      const taskData = {
        ...values,
        accountType
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
                  <FormLabel>Account</FormLabel>
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
                  <FormLabel>Origin Path</FormLabel>
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
                  <FormLabel>Target Path</FormLabel>
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
                  <FormLabel>Strm Type</FormLabel>
                  <FormControl>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select strm type" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="local">local</SelectItem>
                        <SelectItem value="cloud" disabled>cloud</SelectItem>
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
                  <FormLabel>Strm Prefix</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="Strm Prefix" />
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
      </DialogContent>
    </Dialog>
  );
}
