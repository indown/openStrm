import type { NextConfig } from "next";

// next build 时 NODE_ENV 固定是 production；next dev 时是 development。
// 生产构建输出纯静态站点，由后端进程直接托管（见 backend 的 static-site 插件）；
// 开发时仍是 next dev + rewrites 把 /api 转给 4000 的后端。
const isExport = process.env.NODE_ENV === "production";

const nextConfig: NextConfig = {
  reactStrictMode: false,
  output: isExport ? "export" : undefined,
  // 静态导出没有图片优化服务
  images: { unoptimized: true },
  ...(isExport
    ? {}
    : {
        async rewrites() {
          const backendUrl = process.env.BACKEND_URL || "http://localhost:4000";
          return [{ source: "/api/:path*", destination: `${backendUrl}/api/:path*` }];
        },
      }),
};

export default nextConfig;
