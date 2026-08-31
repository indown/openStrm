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

/** 主动推送哪些事件；缺省值见后端 telegram/notify.ts 的 DEFAULT_NOTIFY（任务开始默认关，其它默认开） */
export type TelegramNotifySettings = {
  taskStart?: boolean;
  taskDone?: boolean;
  taskFailed?: boolean;
  offline?: boolean;
  /** 115 cookie 失效 / 被封控 */
  accountAlert?: boolean;
  /** 分享追更：转存了新文件、分享失效、长期没更新 */
  follow?: boolean;
  /** Emby 入库：新条目被收进媒体库（按剧聚合） */
  embyNew?: boolean;
};

export type TelegramSettings = {
  botToken?: string;
  /** 通知发到哪个会话；也是唯一会响应命令的群 */
  chatId?: string;
  /** 老版本的字段，已不再使用（webhook 模式已移除） */
  webhookUrl?: string;
  allowedUsers?: number[];
  /**
   * 会产生副作用的动作各有一个开关，默认全关：
   * 按钮一按就会真的跑任务 / 往网盘里加东西，需要显式开启。
   */
  allowTaskStart?: boolean;
  allowOfflineAdd?: boolean;
  allowShareReceive?: boolean;
  /** 轮询开关的落库副本：轮询状态只在内存里，进程重启后据此自动恢复 */
  pollingEnabled?: boolean;
  notify?: TelegramNotifySettings;
};

export type AppSettings = {
  "user-agent"?: string;
  strmExtensions?: string[];
  downloadExtensions?: string[];
  /** 下载限流：每秒取直链次数、取直链并发、文件下载并发 */
  download?: {
    linkMaxPerSecond?: number;
    linkMaxConcurrent?: number;
    downloadMaxConcurrent?: number;
  };
  /** 手填的额外挂载前缀；开了 302 的任务的 strmPrefix 会自动算作挂载点，不用填在这里 */
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
  telegram?: TelegramSettings;
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
  /** 云下载完成后，让 OpenList 把产物复制到另一个存储（如挂载的本地磁盘） */
  openlistCopy?: OpenlistCopySettings;
} & Record<string, unknown>;

/** 「复制到 OpenList」：三项都填了才算配置完成 */
export type OpenlistCopySettings = {
  /** 用哪个 openlist 账号调 API（「账户」页里的账号名） */
  account?: string;
  /** 115 默认下载目录在 OpenList 里的完整路径，如 /115/云下载 */
  srcDir?: string;
  /** 复制目标目录（另一个存储里的路径），如 /local/downloads */
  dstDir?: string;
};
