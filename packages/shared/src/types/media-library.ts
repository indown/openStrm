export type ScrapeStatus = "pending" | "done" | "failed";
export type MediaType = "movie" | "tv" | "collection" | "unknown";

/** 抄目录树建索引：pending 排队 / indexing 在抄 / done 抄完 / failed 停了 */
export type LibraryIndexStatus = "pending" | "indexing" | "done" | "failed";

/** 分享死活：unknown 没查过 / ok / suspect 疑似失效（等复查）/ expired 已失效 / locked 提取码不对 */
export type LibraryShareStatus = "unknown" | "ok" | "suspect" | "expired" | "locked";

export interface LibraryShareHealth {
  status: LibraryShareStatus;
  /** 最近一次失败时网盘说的原话（截短） */
  reason: string;
  /** unix 秒；没查过是 null */
  checkedAt: number | null;
  expiredAt: number | null;
}

/** 影库里的一个来源：收藏的一个分享，或者其中一个目录 */
export interface MediaLibraryEntry {
  id: string;
  shareUrl: string;
  shareCode: string;
  receiveCode: string;
  sharePath: string;
  shareRootCid: string;
  rawName: string;
  title: string;
  fileCount: number;
  coverUrl: string;
  tags: string[];
  notes: string;
  mediaType: MediaType;
  tmdbId: number | null;
  year: string;
  overview: string;
  scrapeStatus: ScrapeStatus;
  createdAt: number;
  updatedAt: number;
  /** 分享自己的标题（「老K」）；老数据抄过一次才有 */
  shareTitle: string;
  indexStatus: LibraryIndexStatus;
  indexError: string;
  /** 最近一次抄完的时间（unix 秒）；没抄完过是 null */
  indexedAt: number | null;
  /** 本轮已经发现的目录数 / 已经列过下一层的目录数 */
  dirsTotal: number;
  dirsListed: number;
  /** 最近一次抄完时的统计：节点（目录 + 文件）、视频文件、总大小（字节） */
  nodeCount: number;
  videoCount: number;
  totalSize: number;
  /** 超过单个来源的上限，没抄完 */
  truncated: boolean;
  /** 所在分享的死活；列表接口带，别处可能没有 */
  health?: LibraryShareHealth;
}

/** 搜索结果里目录下的一个文件（给人 / 智能体判断对不对：英文原名、年份、集数都在这） */
export interface LibraryHitFile {
  name: string;
  size: number | null;
}

/** 面包屑的一段：id 是分享里的目录 id，打开分享弹框时直接定位 */
export interface LibraryCrumb {
  id: string;
  name: string;
}

/** 影库搜索的一条：一个目录 */
export interface LibraryHit {
  sourceId: string;
  /** 这个目录在分享里的 id（share_inspect 的 dirId；share_save 的 itemIds） */
  nodeId: string;
  /** 上一级目录的 id（share_save 的 dirId）；分享根下的是 "0" */
  parentId: string;
  name: string;
  /** 分享内完整路径，不带前导 / */
  path: string;
  /** 从分享根到它自己（含自己），打开弹框用 */
  crumbs: LibraryCrumb[];
  shareKind: "115" | "quark";
  shareCode: string;
  /** 带提取码的链接 */
  shareUrl: string;
  shareTitle: string;
  /** 夸克转存要的 share_fid_token（115 没有） */
  token?: string;
  /** 子树合计大小；没抄完是 null */
  size: number | null;
  /** 视频文件数：子树合计（剧目录的视频在季目录里）；没抄完的只算直接放着的 */
  videoCount: number;
  /** 视频样例：直接放着的取前几个（三个以内按大小、正片在前，多了按名字）；没有的从第一个有视频的子目录（季目录）里按名字取 */
  files: LibraryHitFile[];
  /** 直接放着的视频一个都没有时，下一层的目录名（按名字前几个）：季目录、版本目录，一看就知道里面是什么 */
  subdirs: string[];
  /** 下一层一共几个目录（subdirs 只给前几个）；有直接视频的不数，是 0 */
  subdirCount: number;
  /** 从名字认出的画质 / 片源 / 音轨 / 字幕 / 季集 / 体积标签；自己名字里没有的取下一层目录名的 */
  tags: string[];
  /** 名字里就有全部关键词 / 靠里面的文件名 / 只靠路径（上级目录）命中 */
  matched: "name" | "files" | "path";
  /** 收进这一条的子目录命中数 */
  childHits: number;
  /** 从名字提的片名（去掉发布信息和年份）：失效了拿它找替代 */
  keyword: string;
  health: LibraryShareHealth;
  /** 来源最近一次抄完的时间；还没抄完是 null */
  indexedAt: number | null;
}

export interface LibrarySearchResult {
  hits: LibraryHit[];
  /** 有效（非失效）的命中总数，可以翻页 */
  total: number;
  /** 已失效分享里的命中数；要明细时 expiredHits 才有 */
  expired: number;
  expiredHits?: LibraryHit[];
  /** 还在抄的来源数：大于 0 时结果可能不全 */
  indexing: number;
}
