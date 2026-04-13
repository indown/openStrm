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
}

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
    errorMessage?: string;
  };
  taskInfo: {
    account: string;
    originPath: string;
    targetPath: string;
    removeExtraFiles: boolean;
  };
}
