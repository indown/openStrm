import { downloadTasks } from "@/lib/downloadTaskManager";
import { NextRequest } from "next/server";

export async function GET(
  request: NextRequest,
  { params }: { params: { taskId: string } }
) {
  const { taskId } = await params;
  const task = downloadTasks[taskId];

  const acceptHeader = request.headers.get("accept") || "";
  const isSSE = acceptHeader.includes("text/event-stream");

  if (!isSSE) {
    if (!task) {
      return new Response(JSON.stringify({ error: "Task not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ message: "Task found", taskId }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  const stream = new ReadableStream({
    start(controller) {
      // 先推历史日志
      task?.logs.forEach((line) => controller.enqueue(`data: ${line}\n\n`));

      // 订阅实时日志
      const subscription = task?.subject.subscribe({
        next: (data) => controller.enqueue(`data: ${JSON.stringify(data)}\n\n`),
        error: () => controller.close(),
        complete: () => controller.close(),
      });

      request.signal.addEventListener("abort", () => subscription?.unsubscribe());
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
