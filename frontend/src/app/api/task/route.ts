import { readTasks, saveTasks, readSettings, writeSettings } from "@/lib/serverUtils";
import { downloadTasks } from "@/lib/downloadTaskManager";
import { NextRequest, NextResponse } from "next/server";
import { exec } from "child_process";

export async function GET() {
  const tasks = readTasks();
  
  // 获取运行中的任务ID
  const runningTaskIds = new Set(Object.keys(downloadTasks));
  
  // 为任务添加状态信息
  const tasksWithStatus = tasks.map((task: { id: string; [key: string]: unknown }) => ({
    ...task,
    status: runningTaskIds.has(task.id) ? "processing" : "pending"
  }));
  
  return NextResponse.json(tasksWithStatus);
}

// 辅助函数：当开启302时，把前缀路径添加到 mediaMountPath
function updateMediaMountPathFor302(taskData: { enable302?: boolean; strmPrefix?: string; account?: string }) {
  if (!taskData.enable302 || !taskData.strmPrefix || !taskData.account) {
    return;
  }
  
  // 构建完整的前缀路径：strmPrefix + "/" + account
  const prefix = (taskData.strmPrefix || "").replace(/\/+$/, "");
  const fullPath = `${prefix}/${taskData.account}`;
  
  // 读取当前设置
  const settings = readSettings();
  const mediaMountPath: string[] = Array.isArray(settings.mediaMountPath) 
    ? settings.mediaMountPath as string[] 
    : [];
  
  // 检查是否已经存在
  if (!mediaMountPath.includes(fullPath)) {
    mediaMountPath.push(fullPath);
    settings.mediaMountPath = mediaMountPath;
    writeSettings(settings);
    
    // 重载 nginx 使配置生效
    exec('nginx -s reload', (err) => {
      if (err) console.error('nginx reload failed:', err);
      else console.log('nginx reloaded for mediaMountPath update');
    });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const tasks = readTasks();

  // 自动生成 ID
  const newTask = {
    id: Date.now().toString(),
    ...body,
  };
  tasks.push(newTask);
  saveTasks(tasks);

  // 如果开启了302，更新 mediaMountPath
  updateMediaMountPathFor302(newTask);

  return NextResponse.json(newTask, { status: 201 });
}

export async function PUT(req: NextRequest) {
  const body = await req.json();
  const { id, ...updateData } = body;

  const tasks = readTasks();
  const index = tasks.findIndex((t: { id: string; }) => t.id === id);
  if (index === -1) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  tasks[index] = { ...tasks[index], ...updateData };
  saveTasks(tasks);

  // 如果开启了302，更新 mediaMountPath
  updateMediaMountPathFor302(tasks[index]);

  return NextResponse.json(tasks[index]);
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "Task ID required" }, { status: 400 });
  }

  const tasks = readTasks();
  const filtered = tasks.filter((t: { id: string; }) => t.id !== id);
  if (filtered.length === tasks.length) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  saveTasks(filtered);
  return NextResponse.json({ success: true });
}
