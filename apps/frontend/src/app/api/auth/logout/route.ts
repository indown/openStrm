import { NextResponse, NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  // JWT是无状态的，服务端不需要做任何处理
  // 客户端清除token即可
  return NextResponse.json({ message: "已退出" });
}
