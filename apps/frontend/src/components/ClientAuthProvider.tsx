"use client";

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { clearToken, getToken } from '@/lib/axios';

interface ClientAuthProviderProps {
  children: React.ReactNode;
}

/** 解出 JWT 的 payload。段是 base64url：-/_ 和缺的补位 atob 认不了，先换回标准 base64 */
function decodeJwtPayload(token: string): { exp?: number } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/** 登录页地址，带上当前位置，登录后回来（首页跳过去没意义，不带） */
function loginUrl(): string {
  const here = window.location.pathname + window.location.search;
  return here && here !== '/' ? `/login?next=${encodeURIComponent(here)}` : '/login';
}

export default function ClientAuthProvider({ children }: ClientAuthProviderProps) {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    // 检查是否是登录页面或公共页面
    const publicPaths = ['/login'];
    const isPublicPath = publicPaths.some(path => pathname.startsWith(path));

    if (isPublicPath) {
      setIsAuthenticated(true);
      return;
    }

    // 没有 token、格式不对或已过期都回登录页；用 replace，免得"后退"又弹回来
    const token = getToken();
    const payload = token ? decodeJwtPayload(token) : null;
    const now = Math.floor(Date.now() / 1000);
    if (!payload || (payload.exp != null && payload.exp < now)) {
      clearToken();
      router.replace(loginUrl());
      return;
    }

    setIsAuthenticated(true);
  }, [pathname, router]);

  // 显示加载状态，直到认证检查完成
  if (isAuthenticated === null) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mx-auto"></div>
          <p className="mt-2 text-gray-600">验证登录状态...</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
