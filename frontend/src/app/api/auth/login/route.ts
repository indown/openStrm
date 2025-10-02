import { NextResponse, NextRequest } from "next/server";
import { generateToken } from "@/lib/jwt";
import path from "path";
import fs from "fs";

export async function POST(req: NextRequest) {
  const { username, password } = await req.json();

  const configFile = path.join(process.cwd(), "../config/config.json");
  const config = fs.readFileSync(
    configFile,
    "utf-8"
  );
  const configData = JSON.parse(config);
  if (username === configData.username && password === configData.password) {
    // 生成JWT token
    const token = await generateToken(username);
    
    console.log("Login successful, token generated for user:", username);
    
    return NextResponse.json({ 
      message: "登录成功",
      token,
      user: { username }
    });
  }

  return NextResponse.json({ error: "账号或密码错误" }, { status: 401 });
}
