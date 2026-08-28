export interface TaskDefinition {
  id: string;
  account: string;
  accountType?: string;
  originPath: string;
  targetPath: string;
  strmPrefix?: string;
  removeExtraFiles?: boolean;
  enablePathEncoding?: boolean;
  enable302?: boolean;
  cronExpression?: string;
  /** 表单里的 strm 类型（local / …），引擎不读它 */
  strmType?: string;
}

/** 列表接口给的是这个：不带 logs。每条记录最多几千行日志，列表里没人看，白传几十 MB */
export type TaskExecutionSummary = Omit<TaskExecutionHistory, "logs">;

export interface TaskExecutionHistory {
  id: string;
  taskId: string;
  startTime: number;
  endTime?: number;
  status: "running" | "completed" | "failed" | "cancelled";
  logs: string[];
  summary: {
    totalFiles: number;
    downloadedFiles: number;
    deletedFiles: number;
    /** 单个文件失败的个数；失败的文件名在 errorMessage 里 */
    failedFiles?: number;
    errorMessage?: string;
  };
  taskInfo: {
    account: string;
    originPath: string;
    targetPath: string;
    removeExtraFiles: boolean;
  };
}
