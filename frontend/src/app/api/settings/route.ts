import { NextRequest, NextResponse } from "next/server";
import { readSettings, writeSettings, AppSettings } from "@/lib/serverUtils";
import { clearRateLimiters } from "@/lib/enqueueForAccount";
import { downloadTasks } from "@/lib/downloadTaskManager";
import { exec } from "child_process";

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
  
  // 检查是否有正在执行的任务
  const runningTasks = Object.keys(downloadTasks);
  if (runningTasks.length > 0) {
    return NextResponse.json({ 
      message: "有任务正在执行中，无法保存设置。请等待任务完成后再试。",
      hasRunningTasks: true,
      runningTasks: runningTasks
    }, { status: 409 });
  }
  
  writeSettings(body);
  
  // 清除所有速率限制器缓存，使新设置立即生效
  clearRateLimiters();
  
  // 重载 nginx 使 mediaMountPath 等配置生效
  exec('nginx -s reload', (err) => {
    if (err) console.error('nginx reload failed:', err);
  });
  
  return NextResponse.json({ message: "ok" });
}


