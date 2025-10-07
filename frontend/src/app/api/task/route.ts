import { readTasks, saveTasks } from "@/lib/serverUtils";
import { downloadTasks } from "@/lib/downloadTaskManager";
import { NextRequest, NextResponse } from "next/server";

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
