"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// 静态导出没有服务端 redirect()，首页在客户端跳到 /home
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/home");
  }, [router]);
  return null;
}
