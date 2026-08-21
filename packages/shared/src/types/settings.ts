/** 冷启动时从哪里开始拉生活事件 */
export type LifePullMode = "latest" | "all" | "last";

/** 生活事件里需要落到本地的动作类型 */
export type LifeEventMode = "create" | "move" | "rename" | "remove";

export type LifeMonitorSettings = {
  enabled?: boolean;
  /** 要监控的 115 账号名，为空时取第一个 115 账号 */
  account?: string;
  /** latest=只处理启动之后的事件；all=全量补齐；last=从上次停止的游标继续 */
  pullMode?: LifePullMode;
  /** 两轮轮询之间的间隔秒数，默认 15 */
  intervalSeconds?: number;
  /** 允许的事件动作，默认全开 */
  eventModes?: LifeEventMode[];
  /** 本地文件变更后，安静多少秒才通知 Emby 刷新，默认 30 */
  mediaServerRefreshDelay?: number;
  /** 从第一次变更算起最多等多少秒，防止事件不断把刷新饿死，默认 300 */
  mediaServerRefreshMaxWait?: number;
};

export type AppSettings = {
  "user-agent"?: string;
  internalToken?: string;
  strmExtensions?: string[];
  downloadExtensions?: string[];
  linkMaxPerSecond?: number;
  linkMaxConcurrent?: number;
  downloadMaxConcurrent?: number;
  mediaMountPath?: string[];
  emby?: {
    url?: string;
    apiKey?: string;
  };
  telegram?: {
    botToken?: string;
    chatId?: string;
    webhookUrl?: string;
    allowedUsers?: number[];
    /**
     * 是否允许从 Telegram 按钮直接启动同步任务。
     * 默认关闭：这条链路此前因为请求地址和鉴权都是错的而从未真正生效过，
     * 修好之后需要显式开启，避免一次升级就让它悄悄开始跑任务。
     */
    allowTaskStart?: boolean;
  };
  tmdb?: {
    apiKey?: string;
    language?: string;
  };
  hdhive?: {
    apiKey?: string;
    baseUrl?: string;
  };
  /** 115 生活事件监控（增量监测网盘文件变动） */
  lifeMonitor?: LifeMonitorSettings;
} & Record<string, unknown>;
