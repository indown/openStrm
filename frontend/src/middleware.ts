import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getIronSession } from "iron-session";
import { sessionOptions, SessionData } from "@/lib/session";

// 注意：middleware 只能用 edge runtime，iron-session 支持
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 登录接口和静态资源直接放行
  if (
    pathname.startsWith("/login") ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/static") ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/logo")
  ) {
    return NextResponse.next();
  }

  const res = NextResponse.next();
  const session = await getIronSession<SessionData>(req.cookies, sessionOptions);

  // 如果没有用户信息
  if (!session.user) {
    if (pathname.startsWith("/api")) {
      return NextResponse.json({ error: "未登录" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", req.url));
  }
  // 如果过期
  if (Date.now() > session.user.expiresAt) {
    session.destroy();
    if (pathname.startsWith("/api")) {
      return NextResponse.json({ error: "登录已过期" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", req.url));
  }

  return res;
}

export const config = {
  matcher: ["/((?!_next|static|favicon.ico).*)"],
};
