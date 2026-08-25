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
    /**
     * 请求不带任何 Emby 凭据时，是否仍用配置里的管理员 key 去解析并 302。
     *
     * 默认关闭：开着等于任何能访问代理端口的人都能拿到媒体直链，无需登录 Emby。
     * 只有那种连请求头里都不带令牌的客户端才需要打开，代价是放弃这道校验。
     */
    allowAnonymousRedirect?: boolean;
  };
  telegram?: {
    botToken?: string;
    chatId?: string;
    webhookUrl?: string;
    allowedUsers?: number[];
    /**
     * 是否允许从 Telegram 按钮直接启动同步任务。
     * 默认关闭：按钮一按就会真的跑任务，属于有副作用的动作，需要显式开启。
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
