import type { NextConfig } from "next";
import { createRequire } from "node:module";
import { join } from "node:path";

// next build 时 NODE_ENV 固定是 production；next dev 时是 development。
// 生产构建输出纯静态站点，由后端进程直接托管（见 backend 的 static-site 插件）；
// 开发时仍是 next dev + rewrites 把 /api 转给 4000 的后端。
const isExport = process.env.NODE_ENV === "production";

// 侧栏显示的版本号：release 工作流传 APP_VERSION（git tag），本地构建退回 package.json 的版本。
// 用 createRequire 读而不是 import package.json：后者会把整份依赖清单打进浏览器包。
// next 从项目目录启动（pnpm --filter 会 cd 过去），相对 cwd 解析即可，不依赖 import.meta / __filename。
const requireFromProject = createRequire(join(process.cwd(), "next.config.ts"));
const { version: packageVersion } = requireFromProject("./package.json") as { version: string };

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: isExport ? "export" : undefined,
  // 静态导出没有图片优化服务
  images: { unoptimized: true },
  env: {
    NEXT_PUBLIC_APP_VERSION: process.env.APP_VERSION || packageVersion,
  },
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
