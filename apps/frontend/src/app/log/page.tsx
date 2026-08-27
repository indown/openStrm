"use client";

import * as React from "react";
import { useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { getToken } from "@/lib/axios";
import { api } from "@/lib/api";

interface Progress {
  filePath?: string;
  percent?: number;
  overallPercent?: string;
  done?: boolean;
  error?: string;
  strm?: boolean;
  cancelled?: boolean;
  message?: string;
}

/**
 * 静态导出没有运行时的动态路由段，任务 id 和执行记录 id 都走查询串：
 * /log?taskId=…&executionId=…
 * useSearchParams 在静态渲染时必须包在 Suspense 里，否则 next build 直接报错。
 */
export default function LogPage() {
  return (
    <React.Suspense fallback={<div style={{ padding: 24, color: "#6b7280" }}>加载中...</div>}>
      <LogRouter />
    </React.Suspense>
  );
}

function LogRouter() {
  const search = useSearchParams();
  const taskId = search.get("taskId") ?? "";
  const executionId = search.get("executionId") ?? undefined;
  if (!taskId) return <div style={{ padding: 24, color: "#6b7280" }}>缺少 taskId 参数</div>;
  return <DownloadProgress taskId={taskId} executionId={executionId} />;
}

function DownloadProgress({ taskId, executionId }: { taskId: string; executionId?: string }) {
  const [logs, setLogs] = useState<Progress[]>([]);
  const [overall, setOverall] = useState<string>("0");
  const [connectionStatus, setConnectionStatus] = useState<string>("连接中...");
  const [isCancelling, setIsCancelling] = useState<boolean>(false);
  const [taskStatus, setTaskStatus] = useState<string>("运行中");

  // 加载历史日志：按 id 取这一条（带 logs），别把整个历史列表拉下来再找
  const loadHistoryLogs = useCallback(async () => {
    if (!executionId) return;
    try {
      const execution = await api.history.get(executionId);
      setConnectionStatus("历史记录");
      setTaskStatus(execution.status === "completed" ? "已完成" :
                   execution.status === "failed" ? "失败" :
                   execution.status === "cancelled" ? "已取消" : "运行中");

      // 解析历史日志
      const parsedLogs: Progress[] = [];
      execution.logs.forEach((logLine: string) => {
        try {
          parsedLogs.push(JSON.parse(logLine));
        } catch {
          console.error("Failed to parse log line:", logLine);
        }
      });
      setLogs(parsedLogs);

      // 计算总体进度 - 查找最后一个有overallPercent的日志
      let finalOverallPercent = "0";
      for (let i = parsedLogs.length - 1; i >= 0; i--) {
        const pct = parsedLogs[i]?.overallPercent;
        if (pct) {
          finalOverallPercent = pct;
          break;
        }
      }
      setOverall(finalOverallPercent);
    } catch (error) {
      if ((error as { response?: { status?: number } } | null)?.response?.status === 404) {
        setConnectionStatus("历史记录不存在");
        setTaskStatus("不存在");
        return;
      }
      console.error("Failed to load history logs:", error);
      setConnectionStatus("加载历史记录失败");
    }
  }, [executionId]);

  useEffect(() => {
    let abortController: AbortController | null = null;

    const startSSE = async () => {
      abortController = new AbortController();
      setConnectionStatus("连接中...");

      try {
        // 如果是查看历史记录，直接加载历史日志
        if (executionId) {
          await loadHistoryLogs();
          return;
        }

        const response = await fetch(`/api/taskLog/${taskId}`, {
          method: 'GET',
          headers: {
            'Accept': 'text/event-stream',
            'Authorization': `Bearer ${getToken() ?? ""}`,
          },
          signal: abortController.signal,
        });

        
        if (response.status === 404) {
          // 后端对没在跑的任务直接 404；以前会把事件流头写出去然后一直挂着
          setConnectionStatus("任务未运行");
          setTaskStatus("未运行");
          return;
        }
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        setConnectionStatus("已连接");
        
        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('No reader available');
        }

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            setConnectionStatus("连接已断开");
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const dataStr = line.slice(6);
              if (dataStr.trim()) {
                try {
                  const data: Progress = JSON.parse(dataStr);
                  // {error} 是某个文件失败的记录（每个失败的 strm/下载都会发一条），任务还在跑，
                  // 照常当一行显示；"任务不存在"由上面的 404 分支处理

                  // 检查任务是否完成
                  if (data.cancelled) {
                    setTaskStatus("已取消");
                  } else if (data.done && data.overallPercent === "100.00") {
                    setTaskStatus("已完成");
                  } else if (data.done) {
                    setTaskStatus("已完成");
                  } else {
                    setTaskStatus("运行中");
                  }
                  
                  setLogs((prev) => {
                    // 只有带文件路径的进度才合并到同一行；{done} / {error} 这种没有路径的各自成行
                    const idx = data.filePath ? prev.findIndex((log) => log.filePath === data.filePath) : -1;
                    if (idx !== -1) {
                      const updated = [...prev];
                      updated[idx] = { ...updated[idx], ...data };
                      return updated;
                    } else {
                      return [...prev, data];
                    }
                  });

                  if (data.overallPercent) setOverall(data.overallPercent);
                } catch (e) {
                  console.error('Error parsing SSE data:', e, 'Raw data:', dataStr);
                }
              }
            }
          }
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          setConnectionStatus("连接已取消");
        } else {
          console.error('SSE connection error:', error);
          setConnectionStatus(`连接错误: ${error instanceof Error ? error.message : '未知错误'}`);
        }
      }
    };

    startSSE();

    return () => {
      if (abortController) {
        abortController.abort();
      }
    };
  }, [taskId, executionId, loadHistoryLogs]);

  // 取消任务函数
  const cancelTask = async () => {
    if (isCancelling) return;
    
    setIsCancelling(true);
    try {
      const response = await api.tasks.cancel(taskId);
      if (response.message) setTaskStatus("已取消");
    } catch (error: unknown) {
      console.error('Failed to cancel task:', error);
      const errorMessage = error instanceof Error && 'response' in error 
        ? (error as { response?: { data?: { message?: string } } }).response?.data?.message || '取消任务失败，请重试'
        : '取消任务失败，请重试';
      alert(errorMessage);
    } finally {
      setIsCancelling(false);
    }
  };

  return (
    <div style={{ 
      padding: 24, 
      maxWidth: 1200, 
      margin: '0 auto',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    }}>
      {/* 状态信息卡片 */}
      <div style={{ 
        marginBottom: 24, 
        padding: 20, 
        backgroundColor: "#ffffff",
        borderRadius: 12,
        boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
        border: "1px solid #e5e7eb"
      }}>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <div>
            <p style={{ margin: 0, fontSize: 14, color: "#6b7280" }}>任务ID</p>
            <p style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "#111827" }}>{taskId}</p>
          </div>
          <div>
            <p style={{ margin: 0, fontSize: 14, color: "#6b7280" }}>连接状态</p>
            <p style={{ 
              margin: 0, 
              fontSize: 16, 
              fontWeight: 600,
              color: connectionStatus === "已连接" ? "#059669" : 
                     connectionStatus.includes("错误") ? "#dc2626" : "#6b7280"
            }}>
              {connectionStatus}
            </p>
          </div>
          <div>
            <p style={{ margin: 0, fontSize: 14, color: "#6b7280" }}>文件数量</p>
            <p style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "#111827" }}>{logs.length}</p>
          </div>
          <div>
            <p style={{ margin: 0, fontSize: 14, color: "#6b7280" }}>任务状态</p>
            <p style={{ 
              margin: 0, 
              fontSize: 16, 
              fontWeight: 600,
              color: taskStatus === "已完成" ? "#059669" : 
                     taskStatus === "已取消" ? "#dc2626" : 
                     taskStatus === "运行中" ? "#3b82f6" : "#6b7280"
            }}>
              {taskStatus}
            </p>
          </div>
        </div>
        
        {/* 取消任务按钮 */}
        {taskStatus === "运行中" && (
          <div style={{ marginTop: 16, textAlign: 'right' }}>
            <button
              onClick={cancelTask}
              disabled={isCancelling}
              style={{
                padding: "8px 16px",
                backgroundColor: isCancelling ? "#9ca3af" : "#dc2626",
                color: "white",
                border: "none",
                borderRadius: 6,
                fontSize: 14,
                fontWeight: 500,
                cursor: isCancelling ? "not-allowed" : "pointer",
                transition: "background-color 0.2s",
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginLeft: "auto"
              }}
            >
              {isCancelling ? (
                <>
                  <div style={{
                    width: 12,
                    height: 12,
                    border: "2px solid transparent",
                    borderTop: "2px solid white",
                    borderRadius: "50%",
                    animation: "spin 1s linear infinite"
                  }} />
                  取消中...
                </>
              ) : (
                <>
                  ⏹️ 取消任务
                </>
              )}
            </button>
          </div>
        )}
      </div>
      
      {logs.length === 0 ? (
        <div style={{
          textAlign: 'center',
          padding: 48,
          backgroundColor: "#ffffff",
          borderRadius: 12,
          boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
          border: "1px solid #e5e7eb"
        }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>📭</div>
          <p style={{ color: "#6b7280", fontSize: 16, margin: 0 }}>暂无下载任务</p>
        </div>
      ) : (
        <>
          {/* 整体进度卡片 */}
          <div style={{
            marginBottom: 24,
            padding: 24,
            backgroundColor: "#ffffff",
            borderRadius: 12,
            boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
            border: "1px solid #e5e7eb"
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: "#111827" }}>整体进度</h2>
              <span style={{ 
                fontSize: 24, 
                fontWeight: 700, 
                color: "#059669",
                background: "linear-gradient(135deg, #059669, #10b981)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent"
              }}>
                {parseFloat(overall).toFixed(2)}%
              </span>
            </div>
            
            {/* 美化进度条 */}
            <div style={{
              position: 'relative',
              width: "100%",
              height: 12,
              backgroundColor: "#f3f4f6",
              borderRadius: 6,
              overflow: 'hidden',
              boxShadow: "inset 0 1px 3px rgba(0,0,0,0.1)"
            }}>
              <div
                style={{
                  width: `${overall}%`,
                  height: "100%",
                  background: "linear-gradient(90deg, #10b981, #059669, #047857)",
                  borderRadius: 6,
                  transition: "width 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
                  position: 'relative',
                  overflow: 'hidden'
                }}
              >
                {/* 进度条光泽效果 */}
                <div style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent)",
                  animation: "shimmer 2s infinite"
                }} />
              </div>
            </div>
          </div>

          {/* 文件列表卡片 */}
          <div style={{
            backgroundColor: "#ffffff",
            borderRadius: 12,
            boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
            border: "1px solid #e5e7eb",
            overflow: 'hidden'
          }}>
            <div style={{ 
              padding: 20, 
              borderBottom: "1px solid #e5e7eb",
              backgroundColor: "#f9fafb"
            }}>
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "#111827" }}>下载文件列表</h3>
            </div>
            
            <div style={{ maxHeight: 600, overflowY: 'auto' }}>
              {logs.slice().reverse().map((log, index) => (
                <div key={index} style={{
                  padding: 16,
                  borderBottom: index < logs.length - 1 ? "1px solid #f3f4f6" : "none",
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  transition: "background-color 0.2s"
                }}>
                  {/* 状态图标 */}
                  <div style={{ 
                    width: 32, 
                    height: 32, 
                    borderRadius: 6,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 16,
                    backgroundColor: log.done ? "#dcfce7" : log.error ? "#fee2e2" : "#dbeafe"
                  }}>
                    {log.done ? "✅" : log.error ? "❌" : "⏳"}
                  </div>
                  
                  {/* 文件信息 */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ 
                      fontSize: 14, 
                      fontWeight: 500, 
                      color: "#111827",
                      marginBottom: 4,
                      wordBreak: 'break-all'
                    }}>
                      {log.filePath}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ 
                        fontSize: 12, 
                        color: "#6b7280",
                        backgroundColor: "#f3f4f6",
                        padding: "2px 8px",
                        borderRadius: 4
                      }}>
                        {parseFloat(log.percent?.toString() ?? log.overallPercent?.toString() ?? "0").toFixed(2)}%
                      </span>
                      {log.strm && (
                        <span style={{ 
                          fontSize: 12, 
                          color: "#059669",
                          backgroundColor: "#dcfce7",
                          padding: "2px 8px",
                          borderRadius: 4,
                          fontWeight: 500
                        }}>
                          STRM
                        </span>
                      )}
                      {log.error && (
                        <span style={{ 
                          fontSize: 12, 
                          color: "#dc2626",
                          backgroundColor: "#fee2e2",
                          padding: "2px 8px",
                          borderRadius: 4
                        }}>
                          {log.error}
                        </span>
                      )}
                    </div>
                  </div>
                  
                  {/* 进度条 */}
                  {!log.done && !log.error && (
                    <div style={{
                      width: 100,
                      height: 6,
                      backgroundColor: "#f3f4f6",
                      borderRadius: 3,
                      overflow: 'hidden'
                    }}>
                      <div style={{
                        width: `${log.percent ?? 0}%`,
                        height: "100%",
                        background: "linear-gradient(90deg, #3b82f6, #1d4ed8)",
                        borderRadius: 3,
                        transition: "width 0.3s ease"
                      }} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
      
      {/* 添加CSS动画 */}
      <style jsx>{`
        @keyframes shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
