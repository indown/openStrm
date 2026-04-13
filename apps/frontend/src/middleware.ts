import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifyToken, extractTokenFromHeader } from "@/lib/jwt";

// 注意：middleware 只能用 edge runtime，iron-session 支持
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 只对API路由进行token验证，页面路由交给客户端处理
  if (!pathname.startsWith("/api")) {
    return NextResponse.next();
  }

  // 登录相关API直接放行
  if (pathname.startsWith("/api/auth")) {
    return NextResponse.next();
  }

  // alist 兼容接口使用内部 API Token 验证 (/api/fs/*)
  if (pathname.startsWith("/api/fs")) {
    const authHeader = req.headers.get('authorization') || '';
    // 从环境变量或固定值获取内部 token
    const internalToken = process.env.ALIST_API_TOKEN || '';
    if (internalToken && authHeader === internalToken) {
      return NextResponse.next();
    }
    // 没有配置 token 或 token 不匹配时拒绝
    return NextResponse.json({ code: 401, message: "unauthorized" }, { status: 401 });
  }

  // 从Authorization头部获取token
  const authHeader = req.headers.get('authorization');
  const token = extractTokenFromHeader(authHeader);

  console.log("Middleware API check:", {
    pathname,
    hasAuthHeader: !!authHeader,
    hasToken: !!token,
  });

  if (!token) {
    console.log("No token found for API request");
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }

  // 验证token
  const payload = await verifyToken(token);
  if (!payload) {
    console.log("Invalid token for API request");
    return NextResponse.json({ error: "登录已过期" }, { status: 401 });
  }

  console.log("Token valid for API request, user:", payload.username);
  
  // 将用户信息添加到请求头中，供后续API使用
  const response = NextResponse.next();
  response.headers.set('x-user', payload.username);
  
  return response;
}

export const config = {
  matcher: ["/((?!_next|static|favicon.ico).*)"],
};
