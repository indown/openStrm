"use client";

import * as React from "react";
import { useEffect, useState } from "react";

interface Progress {
  filePath?: string;
  percent?: number;
  overallPercent?: string;
  done?: boolean;
  error?: string;
}

export default function DownloadProgressPage({
  params,
}: {
  params: { taskId: string };
}) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-expect-error
  const { taskId } = React.use(params);
  const [logs, setLogs] = useState<Progress[]>([]);
  const [overall, setOverall] = useState<string>("0");

  useEffect(() => {
    const evtSource = new EventSource(`/api/taskLog/${taskId}`);

    evtSource.onmessage = (event) => {
      console.log(event.data);
      const data: Progress = JSON.parse(event.data);
      if (data.error) {
        // 没有任务的情况
        setLogs([]);
        setOverall("0");
        // 你可以单独加一个 state 来存错误提示
        return;
      }
      setLogs((prev) => {
        const idx = prev.findIndex((log) => log.filePath === data.filePath);
        if (idx !== -1) {
          const updated = [...prev];
          updated[idx] = { ...updated[idx], ...data };
          return updated;
        } else {
          return [...prev, data];
        }
      });

      if (data.overallPercent) setOverall(data.overallPercent);
    };

    evtSource.onerror = (e) => {
      evtSource.close();
    };

    return () => evtSource.close();
  }, [taskId]);

  return (
    <div style={{ padding: 20 }}>
      {logs.length === 0 ? (
        <p style={{ color: "#888" }}>📭 暂无下载任务</p>
      ) : (
        <>
          <h2>整体进度: {overall}%</h2>
          <div
            style={{
              border: "1px solid #ccc",
              width: "100%",
              height: 20,
              marginBottom: 20,
            }}
          >
            <div
              style={{
                width: `${overall}%`,
                height: "100%",
                backgroundColor: "#4caf50",
                transition: "width 0.2s",
              }}
            />
          </div>

          <ul>
            {logs.slice().reverse().map((log, index) => (
              <li key={index}>
                {log.filePath} - {log.percent ?? log.overallPercent ?? ""}%
                {log.strm ? " (strm)" : ""}
                {log.done && " ✅"}
                {log.error && ` ❌ ${log.error}`}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
