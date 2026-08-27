"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import Image from "next/image";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Form, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { clearToken } from "@/lib/axios";
import { api } from "@/lib/api";

interface ChangePasswordForm {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

const MIN_LENGTH = 8;

export default function ChangePasswordPage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const form = useForm<ChangePasswordForm>({
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

  const onSubmit = async (values: ChangePasswordForm) => {
    if (values.newPassword !== values.confirmPassword) {
      form.setError("confirmPassword", { message: "两次输入的新密码不一致" });
      return;
    }

    setSubmitting(true);
    try {
      await api.auth.changePassword(values.currentPassword, values.newPassword);
      // 旧 token 仍然有效，但让用户用新密码走一遍登录，省得以为没生效
      toast.success("密码已修改，请用新密码登录");
      clearToken();
      router.push("/login");
    } catch (err) {
      const message =
        (err as { response?: { data?: { message?: string } } }).response?.data?.message ??
        "修改失败，请重试";
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-gray-100">
      <div className="w-full max-w-md bg-white p-8 rounded-2xl shadow-lg">
        <div className="flex flex-col items-center mb-6">
          <Image
            src="/logo.svg"
            alt="OpenStrm Logo"
            width={64}
            height={64}
            className="mb-4"
            unoptimized
            priority
          />
          <h1 className="text-2xl font-bold text-center">修改密码</h1>
          <p className="mt-2 text-sm text-center text-gray-500">
            当前仍是默认密码，改掉之后才能使用其他功能
          </p>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="currentPassword"
              rules={{ required: "请输入当前密码" }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>当前密码</FormLabel>
                  <Input type="password" placeholder="请输入当前密码" {...field} />
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="newPassword"
              rules={{
                required: "请输入新密码",
                minLength: { value: MIN_LENGTH, message: `新密码至少 ${MIN_LENGTH} 位` },
              }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>新密码</FormLabel>
                  <Input type="password" placeholder={`至少 ${MIN_LENGTH} 位`} {...field} />
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="confirmPassword"
              rules={{ required: "请再次输入新密码" }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>确认新密码</FormLabel>
                  <Input type="password" placeholder="请再次输入新密码" {...field} />
                  <FormMessage />
                </FormItem>
              )}
            />

            <Button type="submit" className="w-full mt-2" disabled={submitting}>
              {submitting ? "提交中..." : "确认修改"}
            </Button>
          </form>
        </Form>
      </div>
    </div>
  );
}
