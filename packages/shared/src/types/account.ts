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
}

export type AccountInfo = Account115 | AccountOpenlist;
