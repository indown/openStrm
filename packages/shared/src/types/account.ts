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

export type AccountInfo = Account115 | AccountOpenlist;
