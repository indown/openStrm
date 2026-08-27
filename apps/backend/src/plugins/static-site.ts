/**
 * 托管前端的静态导出产物（apps/frontend/out）。
 *
 * 生产环境只有这一个进程对外提供管理界面和 API。Next 的服务进程原本只干两件事：
 * 吐静态文件、把 /api 转给后端——不值得单独一个进程和一个端口。
 * 开发时不注册：next dev 自己在 3000 上跑，rewrites 把 /api 转过来。
 *
 * 路由规则和 Next 静态导出一致：/ → index.html，/home → home.html，
 * 找不到的走 404.html；/api 下没有的路由照旧回 JSON 404。
 */
import fs from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { HttpError } from "../lib/http-error.js";

const IMMUTABLE = "public, max-age=31536000, immutable";

function isFile(abs: string): boolean {
  return fs.statSync(abs, { throwIfNoEntry: false })?.isFile() ?? false;
}

export default async function staticSitePlugin(fastify: FastifyInstance, opts: { root: string }) {
  const root = path.resolve(opts.root);

  await fastify.register(fastifyStatic, {
    root,
    // 只要 reply.sendFile：哪个请求对应哪个文件由下面的路由决定
    serve: false,
    // _next/static 下的文件名带内容哈希，可以永久缓存；页面文件每次现取
    setHeaders(res, filePath) {
      const cacheable = filePath.includes(`${path.sep}_next${path.sep}static${path.sep}`);
      res.header("cache-control", cacheable ? IMMUTABLE : "no-cache");
    },
  });

  fastify.get("/*", async (request, reply) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    } catch {
      throw new HttpError(400, "Malformed URL");
    }
    if (pathname.startsWith("/api/")) {
      throw new HttpError(404, `${request.method} ${pathname} not found`, { code: "NOT_FOUND" });
    }

    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    for (const candidate of [rel, `${rel}.html`, path.join(rel, "index.html")]) {
      const abs = path.resolve(root, candidate);
      // 解析到 root 之外的一律不认：/..%2f.. 这种解码后就是目录穿越
      if (abs !== root && !abs.startsWith(root + path.sep)) break;
      if (isFile(abs)) return reply.sendFile(path.relative(root, abs));
    }
    return reply.code(404).sendFile("404.html");
  });
}
