import { NextRequest, NextResponse } from "next/server";
import { getAllTaskHistory, getTaskHistory, deleteTaskHistory, deleteAllHistory } from "@/lib/taskHistoryManager";

// 获取所有任务历史记录
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const taskId = searchParams.get("taskId");
    
    if (taskId) {
      // 获取特定任务的历史记录
      const history = getTaskHistory(taskId);
      return NextResponse.json(history);
    } else {
      // 获取所有任务历史记录
      const allHistory = getAllTaskHistory();
      return NextResponse.json(allHistory);
    }
  } catch (error) {
    console.error("Failed to get task history:", error);
    return NextResponse.json(
      { error: "Failed to get task history" },
      { status: 500 }
    );
  }
}

// 删除任务历史记录或清理重复日志
export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const executionId = searchParams.get("executionId");
    const action = searchParams.get("action");
    
    if (action === "cleanup") {
      // 删除所有历史记录
      deleteAllHistory();
      return NextResponse.json({ success: true, message: "All history deleted" });
    }
    
    if (!executionId) {
      return NextResponse.json(
        { error: "Execution ID is required" },
        { status: 400 }
      );
    }
    
    deleteTaskHistory(executionId);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete task history:", error);
    return NextResponse.json(
      { error: "Failed to delete task history" },
      { status: 500 }
    );
  }
}
