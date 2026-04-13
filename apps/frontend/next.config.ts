import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true, // ⚠ 构建时忽略 ESLint 报警
  },
  typescript: {
    ignoreBuildErrors: true, // ⚠ 忽略 TypeScript 报错
  },
};

export default nextConfig;
