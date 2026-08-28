"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Form, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { apiErrorMessage, setToken } from "@/lib/axios";
import { api } from "@/lib/api";
import Image from "next/image";

interface LoginForm {
  username: string;
  password: string;
}

/** 登录后要回去的站内路径：只认以 / 开头的路径，// 开头（协议相对）、带反斜杠、指回登录页的都不要 */
function safeNextPath(): string | null {
  const next = new URLSearchParams(window.location.search).get("next");
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\") || next.startsWith("/login")) {
    return null;
  }
  return next;
}

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const form = useForm<LoginForm>({
    defaultValues: { username: "", password: "" },
  });

  const onSubmit = async (values: LoginForm) => {
    setError(null);
    setPending(true);
    try {
      const { token, mustChangePassword } = await api.auth.login(values.username, values.password);

      // 存储token
      setToken(token);

      // 还在用默认密码的话，先去改密码——其余接口在那之前都会被后端拒绝
      router.push(mustChangePassword ? "/change-password" : (safeNextPath() ?? "/"));
    } catch (err) {
      // 后端的 message 会说明是密码错还是被限流（"请 N 秒后再试"），原样给用户
      setError(apiErrorMessage(err, "登录失败，请检查用户名或密码"));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-gray-100">
      <div className="w-full max-w-md bg-white p-8 rounded-2xl shadow-lg">
        <div className="flex flex-col items-center mb-6">
          <Image
            src="/logo-128.png"
            alt="OpenStrm Logo"
            width={64}
            height={64}
            className="mb-4"
            unoptimized
            priority
          />
          <h1 className="text-2xl font-bold text-center">登录</h1>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="username"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>用户名</FormLabel>
                  <Input placeholder="请输入用户名" autoComplete="username" {...field} />
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
                  <Input type="password" placeholder="请输入密码" autoComplete="current-password" {...field} />
                  <FormMessage />
                </FormItem>
              )}
            />

            {error && (
              <p role="alert" className="text-sm text-red-600 text-center">
                {error}
              </p>
            )}

            <Button type="submit" className="w-full mt-2" disabled={pending}>
              {pending ? "登录中..." : "登录"}
            </Button>
          </form>
        </Form>
      </div>
    </div>
  );
}
