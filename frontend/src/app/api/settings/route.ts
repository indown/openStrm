import { NextRequest, NextResponse } from "next/server";
import { readSettings, writeSettings, AppSettings } from "@/lib/serverUtils";

export async function GET() {
  const settings = readSettings();
  return NextResponse.json(settings);
}

export async function PUT(req: NextRequest) {
  const body = (await req.json()) as AppSettings;
  // 简单校验：只接受对象
  if (!body || typeof body !== "object") {
    return NextResponse.json({ message: "invalid payload" }, { status: 400 });
  }
  writeSettings(body);
  return NextResponse.json({ message: "ok" });
}


