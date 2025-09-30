import { NextRequest, NextResponse } from "next/server";
import { downloadTasks, DownloadProgress } from "@/lib/downloadTaskManager";
import { readTasks } from "@/lib/serverUtils";

export async function POST(req: NextRequest) {
  const body = await req.json();

  const task = downloadTasks[body.id];
  if (task) {
    task.subscription.unsubscribe(); // 停止下载流
    task.subject.complete(); // 通知前端任务已结束
    delete downloadTasks[body.id];
  }
  // startDownloadTask(filePaths, saveDir)
  return NextResponse.json({ message: "success" });
}
