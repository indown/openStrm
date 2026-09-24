"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Form, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { AuthShell } from "@/components/auth-shell";
import { apiErrorMessage, clearToken } from "@/lib/axios";
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
  // ?required=1：还在用默认密码被拦过来的；从顶栏菜单主动来改的没有这个参数，文案和返回链接不一样。
  // null 表示还没读到 URL（静态导出的首屏），这时两种文案都不画，免得先画一种再闪成另一种
  const [required, setRequired] = useState<boolean | null>(null);
  useEffect(() => {
    setRequired(new URLSearchParams(window.location.search).get("required") === "1");
  }, []);
  // 智能体令牌、已连接的网页客户端都不随改密码失效：有的话给个选项一并撤销（怀疑泄露来改密码，多半也想收回它们）。
  // 只连了网页客户端、没建过令牌的也要给——提档到删除档的客户端刷新令牌一直能续。
  // 强制改默认密码时不查：那时除了改密码别的接口都进不去，也不可能有令牌
  const [agentTokens, setAgentTokens] = useState(0);
  const [agentGrants, setAgentGrants] = useState(0);
  const [revokeTokens, setRevokeTokens] = useState(false);
  useEffect(() => {
    if (required !== false) return;
    api.agent
      .tokens()
      .then((list) => setAgentTokens(list.length))
      .catch(() => {});
    api.agent
      .oauth()
      .then((state) => setAgentGrants(state.grants.length))
      .catch(() => {});
  }, [required]);
  const revokeWhat = [agentTokens > 0 ? `${agentTokens} 个智能体令牌` : "", agentGrants > 0 ? `${agentGrants} 个已连接的网页客户端` : ""].filter(Boolean).join("和");
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
      const res = await api.auth.changePassword(values.currentPassword, values.newPassword, { revokeAgentTokens: revokeTokens });
      // 旧 token 仍然有效，但让用户用新密码走一遍登录，省得以为没生效
      toast.success(
        res.revokedAgentTokens ? `密码已修改，智能体令牌和网页客户端一共撤销了 ${res.revokedAgentTokens} 个，请用新密码登录` : "密码已修改，请用新密码登录",
      );
      clearToken();
      router.push("/login");
    } catch (err) {
      toast.error(apiErrorMessage(err, "修改失败，请重试"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell
      title="修改密码"
      description={
        required === null ? "\u00A0" : required ? "当前仍是默认密码，改掉之后才能使用其他功能" : "改完需要用新密码重新登录"
      }
      footer={
        required === false && (
          <Link href="/home" className="hover:text-foreground">
            返回
          </Link>
        )
      }
    >
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FormField
            control={form.control}
            name="currentPassword"
            rules={{ required: "请输入当前密码" }}
            render={({ field }) => (
              <FormItem>
                <FormLabel>当前密码</FormLabel>
                <Input type="password" placeholder="请输入当前密码" autoComplete="current-password" {...field} />
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
                <Input type="password" placeholder={`至少 ${MIN_LENGTH} 位`} autoComplete="new-password" {...field} />
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
                <Input type="password" placeholder="请再次输入新密码" autoComplete="new-password" {...field} />
                <FormMessage />
              </FormItem>
            )}
          />

          {revokeWhat && (
            <label className="flex items-start gap-2 text-sm text-muted-foreground">
              <Checkbox className="mt-0.5" checked={revokeTokens} onCheckedChange={(v) => setRevokeTokens(v === true)} />
              <span>同时撤销全部 {revokeWhat}。改密码不会让它们失效，怀疑泄露的话一起收回，之后在设置里重新建、在客户端里重新连接。</span>
            </label>
          )}

          <Button type="submit" className="mt-2 w-full" disabled={submitting}>
            {submitting ? "提交中..." : "确认修改"}
          </Button>
        </form>
      </Form>
    </AuthShell>
  );
}
