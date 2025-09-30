import { NextResponse } from "next/server";
import { getIronSession } from "iron-session";
import { sessionOptions, SessionData } from "@/lib/session";
import path from "path";
import fs from "fs";

export async function POST(req: Request) {
  const { username, password } = await req.json();

  const configFile = path.join(process.cwd(), "../config/config.json");
  const config = fs.readFileSync(
    configFile,
    "utf-8"
  );
  const configData = JSON.parse(config);
  if (username === configData.username && password === configData.password) {
    const res = NextResponse.json({ message: "登录成功" });

    const session = await getIronSession<SessionData>(req, res, sessionOptions);
    session.user = {
      username,
      expiresAt: Date.now() + 1000 * 60 * 60 * 24, // 1天有效期
    };
    await session.save();

    return res;
  }

  return NextResponse.json({ error: "账号或密码错误" }, { status: 401 });
}
