"use client";

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useForm } from "react-hook-form";

import axiosInstance from "@/lib/axios";
import { Button } from "@/components/ui/button";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Info } from "lucide-react";
import { toast } from "sonner";

// 表单验证规则
export const accountFormSchema = z.object({
  accountType: z.string().min(1, "账户类型不能为空"),
  name: z.string().min(1, "账户名称不能为空"),
  // 115 类型字段
  cookie: z.string().optional(),
  // openlist 类型字段
  account: z.string().optional(),
  password: z.string().optional(),
  url: z.string().optional(),
}).refine((data) => {
  if (data.accountType === "115") {
    return data.cookie && data.cookie.length > 0;
  } else if (data.accountType === "openlist") {
    return data.account && data.password && data.url;
  }
  return true;
}, {
  message: "请填写对应账户类型的必需字段",
  path: ["accountType"]
});

export type AccountFormValues = z.infer<typeof accountFormSchema>;

interface AddAccountDialogProps {
  account?: AccountFormValues; // 编辑模式
  trigger?: React.ReactNode;   // 自定义按钮
  onSuccess?: () => void;      // 新增/编辑成功后的回调
}

export function AddAccountDialog({ account, trigger, onSuccess }: AddAccountDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);

  const form = useForm<AccountFormValues>({
    resolver: zodResolver(accountFormSchema),
    defaultValues: account ?? {
      accountType: "",
      name: "",
      cookie: "",
      account: "",
      password: "",
      url: "",
    },
  });

  const watchAccountType = form.watch("accountType");

  const onSubmit = async (values: AccountFormValues) => {
    setLoading(true);
    try {
      if (account) {
        // 编辑 → PUT
        await axiosInstance.put("/api/account", values);
        toast("账号更新成功");
      } else {
        // 新增 → POST
        await axiosInstance.post("/api/account", values);
        toast("账号添加成功");
      }

      // 调用回调刷新列表
      onSuccess?.();

      setOpen(false);
      form.reset();
    } catch (err) {
      console.error("提交失败:", err);
      toast.error("操作失败");
    } finally {
      setLoading(false);
    }
  };

  // 模拟可选账号类型
  const accountTypes = ["115", "openlist"];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline">{account ? "Edit Account" : "Add Account"}</Button>
        )}
      </DialogTrigger>

      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{account ? "编辑账户" : "新增账户"}</DialogTitle>
          <DialogDescription>
            {account ? "编辑你的账户信息" : "添加一个新的网盘账户"}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {/* 账号类型 */}
            <FormField
              control={form.control}
              name="accountType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>账户类型</FormLabel>
                  <FormControl>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <SelectTrigger>
                        <SelectValue placeholder="选择账户类型" />
                      </SelectTrigger>
                      <SelectContent>
                        {accountTypes.map((type) => (
                          <SelectItem key={type} value={type}>
                            {type}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* 账户名称 */}
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>账户名称</FormLabel>
                  <FormControl>
                    <Input placeholder="输入账户名称" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* 115 类型字段 */}
            {watchAccountType === "115" && (
              <>
                <FormField
                  control={form.control}
                  name="cookie"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Cookie</FormLabel>
                      <FormControl>
                        <Input placeholder="输入 115 网盘的 Cookie" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Alert>
                  <Info className="h-4 w-4" />
                  <AlertDescription>
                    如果希望使用 302 重定向功能，推荐将账户名称与 openlist、cd2 的 115 账户用户名保持一致，这样可以保证正确回源。
                  </AlertDescription>
                </Alert>
              </>
            )}

            {/* openlist 类型字段 */}
            {watchAccountType === "openlist" && (
              <>
                <FormField
                  control={form.control}
                  name="account"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>用户名</FormLabel>
                      <FormControl>
                        <Input placeholder="输入用户名" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>密码</FormLabel>
                      <FormControl>
                        <Input type="password" placeholder="输入密码" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="url"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>服务器地址</FormLabel>
                      <FormControl>
                        <Input placeholder="输入服务器地址，如: https://example.com" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            )}

            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" disabled={loading}>
                  取消
                </Button>
              </DialogClose>
              <Button type="submit" disabled={loading}>
                {loading ? "保存中..." : "保存"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
