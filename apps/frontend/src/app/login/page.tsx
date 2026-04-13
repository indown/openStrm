"use client";

import { useForm } from "react-hook-form";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Form, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import axiosInstance, { setToken } from "@/lib/axios";
import Image from "next/image";

interface LoginForm {
  username: string;
  password: string;
}

export default function LoginPage() {
  const router = useRouter();
  const form = useForm<LoginForm>({
    defaultValues: { username: "", password: "" },
  });

  const onSubmit = async (values: LoginForm) => {
    try {
      const response = await axiosInstance.post("/api/auth/login", values);
      const { token } = response.data;
      
      // 存储token
      setToken(token);
      
      // 跳转到首页
      router.push("/");
    } catch {
      alert("登录失败，请检查用户名或密码");
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
                  <Input placeholder="请输入用户名" {...field} />
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
                  <Input type="password" placeholder="请输入密码" {...field} />
                  <FormMessage />
                </FormItem>
              )}
            />

            <Button type="submit" className="w-full mt-2">
              登录
            </Button>
          </form>
        </Form>
      </div>
    </div>
  );
}
