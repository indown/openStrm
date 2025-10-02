import { NextRequest, NextResponse } from "next/server";
import { downloadTasks } from "@/lib/downloadTaskManager";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const taskId = body.taskId || body.id; // 支持两种参数名

    console.log('Cancelling task:', taskId);

    const task = downloadTasks[taskId];
    if (!task) {
      console.log('Task not found:', taskId);
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    console.log('Found task, cancelling...');
    
    // 停止下载流
    if (task.subscription) {
      task.subscription.unsubscribe();
    }
    
    // 发送取消通知给前端
    task.subject.next({ 
      done: true, 
      message: "任务已取消" 
    });
    
    // 完成subject
    task.subject.complete();
    
    // 从任务列表中删除
    delete downloadTasks[taskId];
    
    console.log('Task cancelled successfully:', taskId);
    
    return NextResponse.json({ 
      message: "Task cancelled successfully",
      taskId: taskId
    });
  } catch (error) {
    console.error('Error cancelling task:', error);
    return NextResponse.json({ 
      error: "Failed to cancel task" 
    }, { status: 500 });
  }
}
