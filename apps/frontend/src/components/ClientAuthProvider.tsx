"use client";

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';

interface ClientAuthProviderProps {
  children: React.ReactNode;
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

    // 检查localStorage中的token
    const token = localStorage.getItem('auth-token');
    
    if (!token) {
      console.log('ClientAuthProvider: No token found, redirecting to login');
      router.push('/login');
      return;
    }

    // 简单验证token格式（JWT应该有3个部分）
    const tokenParts = token.split('.');
    if (tokenParts.length !== 3) {
      console.log('ClientAuthProvider: Invalid token format, redirecting to login');
      localStorage.removeItem('auth-token');
      router.push('/login');
      return;
    }

    // 检查token是否过期
    try {
      const payload = JSON.parse(atob(tokenParts[1]));
      const now = Math.floor(Date.now() / 1000);
      
      if (payload.exp && payload.exp < now) {
        console.log('ClientAuthProvider: Token expired, redirecting to login');
        localStorage.removeItem('auth-token');
        router.push('/login');
        return;
      }
      
      console.log('ClientAuthProvider: Token valid, user authenticated');
      setIsAuthenticated(true);
    } catch (error) {
      console.log('ClientAuthProvider: Error parsing token, redirecting to login');
      localStorage.removeItem('auth-token');
      router.push('/login');
    }
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
