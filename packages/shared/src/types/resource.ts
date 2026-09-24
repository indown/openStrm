/**
 * 资源搜索（PanSou）的结果形状：网页、智能体、Telegram 共用。
 * 标题、频道名、插件名都是资源发布者写的第三方内容，只当数据展示，不拼进提示句。
 */

/** OpenStrm 接得住的几类；别的网盘（百度、阿里、UC…）一律 other，只能复制链接 */
export type ResourceKind = "115" | "quark" | "magnet" | "ed2k" | "other";

/** 这一条在这里能做什么：share 打开转存框，offline 交给 115 云下载，null 只能复制链接 */
export type ResourceAction = "share" | "offline" | null;

export interface ResourceSource {
  /** tg = TG 频道，plugin = PanSou 的插件（各类资源站） */
  type: "tg" | "plugin" | "unknown";
  /** 频道名 / 插件名 */
  name: string;
}

export interface ResourceHit {
  /** 去重键，也是有效性缓存的键：分享 = 类型:分享码，磁力 = magnet:btih，电驴 = ed2k:hash，其它 = other:链接 */
  key: string;
  kind: ResourceKind;
  /** PanSou 给的网盘类型（115 / quark / baidu / aliyun / uc…） */
  panType: string;
  /** 这家网盘的中文名（百度、阿里、UC…）：kind 是 other 时拿它显示是哪家。名字表只在后端一份 */
  panLabel: string;
  /** 拿来就能用的链接：分享带好提取码（115 ?password=、夸克 ?pwd=），磁力只留 xt */
  url: string;
  /** 提取码；url 里已经带上了，单独给一份方便复制 */
  password?: string;
  title: string;
  /** ISO 时间；PanSou 给的 0001 年这类占位日期当没有 */
  publishedAt?: string;
  source: ResourceSource;
  action: ResourceAction;
  /**
   * 从标题里认出的标签，固定先后：分辨率（4K / 1080p / 720p）、HDR、杜比视界、片源（原盘 / REMUX / WEB / 蓝光 / 枪版）、
   * 全景声、国语、粤语、中字、季（第 2 季）、集（全 30 集 / 更新至 12 集 / 1-30 集 / 30 集）、完结、合集、体积（56G）。没有就不给
   */
  tags?: string[];
  /**
   * 这个分享订过追更（按网盘 + 分享码对追更表）：active 还在追，stopped 停了（分享失效、长期没更新或手动暂停）。
   * 两种都别再订一遍：同一个分享同一个目录只能有一条订阅，停了的到追更页「继续」
   */
  followed?: "active" | "stopped";
}

export interface ResourceSearchResult {
  keyword: string;
  /** 按 115、夸克、磁力、电驴、其它排；同一类里保持 PanSou 的顺序（它按分数排好了，分数不透出，所以没法跨类合排） */
  items: ResourceHit[];
  counts: Partial<Record<ResourceKind, number>>;
  /** 设置里的屏蔽词藏掉了几条（不在 items、counts 里）；没藏就不给 */
  blocked?: number;
}

/** 链接有效性：ok 有效 / bad 失效 / locked 要提取码或提取码不对 / unsupported 这家不支持检测 / uncertain 说不准 */
export type ResourceLinkState = "ok" | "bad" | "locked" | "unsupported" | "uncertain";

export interface ResourceCheckResult {
  /** false：PanSou 这个版本没有检测接口，别再查了 */
  supported: boolean;
  results: Array<{ key: string; state: ResourceLinkState; summary?: string }>;
}

/** 设置页「检查连接」的结果 */
export interface ResourceStatus {
  /** 填了地址 */
  configured: boolean;
  /** 连得上，开了登录的话也登得进去 */
  ok: boolean;
  authEnabled?: boolean;
  /** 启用的插件、TG 频道各几个（PanSou 的 health 给的） */
  plugins?: number;
  channels?: number;
  /** 连不上、登不进时说为什么 */
  message?: string;
}
