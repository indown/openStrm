"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { useRouter } from "next/navigation";
import { AlertCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Form, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { AuthShell } from "@/components/auth-shell";
import { apiErrorMessage, setToken } from "@/lib/axios";
import { api } from "@/lib/api";

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
      router.push(mustChangePassword ? "/change-password?required=1" : (safeNextPath() ?? "/"));
    } catch (err) {
      // 后端的 message 会说明是密码错还是被限流（"请 N 秒后再试"），原样给用户
      setError(apiErrorMessage(err, "登录失败，请检查用户名或密码"));
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthShell title="登录 OpenStrm" description="管理网盘同步与本地 strm 库">
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
            <Alert variant="destructive">
              <AlertCircle />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" className="mt-2 w-full" disabled={pending}>
            {pending ? "登录中..." : "登录"}
          </Button>
        </form>
      </Form>
    </AuthShell>
  );
}
