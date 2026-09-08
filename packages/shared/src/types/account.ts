export interface Account115 {
  accountType: "115";
  name: string;
  cookie: string;
}

export interface AccountOpenlist {
  accountType: "openlist";
  name: string;
  account: string;
  password: string;
  url: string;
  /** 登录换来的令牌和过期时间（unix 秒），由同步任务写回 */
  token?: string;
  expiresAt?: number;
}

/** 夸克网盘，Cookie 模式（同 OpenList 的 Quark 驱动）；服务端轮换的 __puus 会由客户端写回这里 */
export interface AccountQuark {
  accountType: "quark";
  name: string;
  cookie: string;
}

export type AccountInfo = Account115 | AccountOpenlist | AccountQuark;
