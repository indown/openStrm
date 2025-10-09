import axios from "axios";
import Bottleneck from "bottleneck";
import path from "path";
import fs from "fs";
import { defer, firstValueFrom, Observable, retry, timer } from "rxjs";
import { get_id_to_path, getDownloadUrlWeb } from "./115";
import { readSettings, readAccounts } from "./serverUtils";

interface Progress {
  filePath?: string;
  percent?: number;
  overallPercent?: string;
  done?: boolean;
  error?: string;
}

const limiters = new Map<string, Bottleneck>();
const sharedLimiters = new Map<string, Bottleneck>();

// 根据账户类型获取共享限制器
function getSharedLimiter({account, maxPerSecond = 2}: {account : string, maxPerSecond: number}): Bottleneck {
  // 从账户名中提取类型，例如 "115:abc123" -> "115"
  
  if (!sharedLimiters.has(account)) { // 默认每秒2次
    
    const sharedLimiter = new Bottleneck({
      reservoir: maxPerSecond,
      reservoirRefreshAmount: maxPerSecond,
      reservoirRefreshInterval: 1000, // 每秒重置
    });
    
    sharedLimiters.set(account, sharedLimiter);
  }
  
  return sharedLimiters.get(account)!;
}

export function enqueueForAccount<T>(
  accountKey: string,
  fn: () => Observable<T>,
  maxConcurrent = 2
): Observable<T> {
  // 每个账户都有自己的 limiter，但共享同类型的速率
  const account = accountKey.split(':')[0];

  if (!limiters.has(accountKey)) {
    const settings = readSettings();
    const downloadConfig = (settings as Record<string, unknown>).download as Record<string, number> || {};
    const limiter = new Bottleneck({
      maxConcurrent, // 每个账号自己的并发限制
    });

    // 让它继承同类型账户的共享速率控制
    const sharedLimiter = getSharedLimiter({account, maxPerSecond: downloadConfig.linkMaxPerSecond || 2});
    limiter.chain(sharedLimiter);

    limiters.set(accountKey, limiter);
  }

  const limiter = limiters.get(accountKey)!;

  return new Observable<T>((observer) => {
    limiter.schedule(() => {
      return new Promise<void>((resolve, reject) => {
        fn().subscribe({
          next: (v) => observer.next(v),
          error: (err) => {
            observer.error(err);
            reject(err);
          },
          complete: () => {
            observer.complete();
            resolve();
          },
        });
      });
    });
  });
}

export async function getRealDownloadLink(
  filePath: string,
  account: string,
  maxRetries = 3,
  retryDelay = 2000
): Promise<string> {
  const settings = readSettings();
  const accounts = readAccounts();

  // 从 account.json 中查找账号
  const accountInfo = accounts.find(
    (acc: { name: string; cookie: string }) => acc.name === account
  );
  if (!accountInfo) {
    throw new Error(`No cookie found for account: ${account}`);
  }
  
  // 创建带重试的 Observable
  const createRetryObservable = (fn: () => Observable<string>) => {
    return defer(fn).pipe(
      retry({
        count: maxRetries,
        delay: (err, i) => {
          console.warn(`获取下载链接失败，正在重试 ${i}/${maxRetries}`, err);
          return timer(retryDelay);
        },
      })
    );
  };

  // 根据账户类型创建对应的 Observable
  const createAccountObservable = (): Observable<string> => {
    const accountType = accountInfo.accountType || "unknown";
    
    switch (accountType) {
      case "115":
        // 115账户直接调用，不使用限流
        const userAgent = settings["user-agent"];
        return new Observable<string>((observer) => {
          getRealDownloadLinkDirect115(filePath, accountInfo, userAgent)
            .then((url) => {
              observer.next(url);
              observer.complete();
            })
            .catch((err) => observer.error(err));
        });
        
      case "openlist":
      case "other":
      default:
        // 非115账户使用限流
        const downloadConfig = (settings as Record<string, unknown>).download as Record<string, number> || {};
        
        return enqueueForAccount(
          account,
          () =>
            new Observable<string>((observer) => {
              getRealDownloadLinkDirect(filePath, accountInfo)
                .then((url) => {
                  observer.next(url);
                  observer.complete();
                })
                .catch((err) => observer.error(err));
            }),
          downloadConfig.linkMaxConcurrent || 2
        );
    }
  };

  // 创建带重试的 Observable 并执行
  const obs$ = createRetryObservable(createAccountObservable);
  return firstValueFrom(obs$);
}

// 115账户直接获取下载链接的内部函数
async function getRealDownloadLinkDirect115(
  filePath: string,
  accountInfo: { name: string; cookie: string; accountType?: string },
  userAgent: string
): Promise<string> {
  try {
    console.log(`Looking for file: ${filePath}`);
    // 1. 通过路径获取文件 ID
    const pickcode = await get_id_to_path({
      path: filePath,
      userAgent,
      accountInfo,
    });

    console.log(`Found pickcode: ${pickcode}`);

    if (!pickcode) {
      throw new Error(`No pickcode found for file: ${filePath}`);
    }

    // 3. 通过 pickcode 获取下载 URL
    console.log(`Getting download URL for pickcode: ${pickcode}`);
    const downloadUrl = await getDownloadUrlWeb(pickcode, {
      userAgent,
      accountInfo,
    });
    return downloadUrl;
  } catch (error) {
    console.error(`Failed to get download link for ${filePath}:`, error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    // 检测115账号封控错误
    if (errorMessage.includes('<!doctypehtml>') || 
        errorMessage.includes('405') || 
        errorMessage.includes('您的访问被阻断') ||
        errorMessage.includes('potential threats to the server')) {
      throw new Error("115账号被封控，账号访问被阿里云阻断");
    }
    
    throw error;
  }
}

// 直接获取下载链接的内部函数（不包含限流逻辑）
async function getRealDownloadLinkDirect(
  filePath: string,
  accountInfo: { name: string; accountType?: string; url?: string; token?: string }
): Promise<string> {
  
  if (accountInfo.accountType === "openlist") {
    if (!accountInfo.url || !accountInfo.token) {
      throw new Error(`Missing openlist credentials for account: ${accountInfo.name}`);
    }

    try {
      console.log(`Getting openlist raw_url for file: ${filePath}`);
      
      // 使用 fs/get 接口获取文件的原始下载链接
      const response = await axios.post(`${accountInfo.url}/api/fs/get`, {
        path: filePath
      }, {
        headers: {
          'Authorization': accountInfo.token
        }
      });

      const result = response.data;
      if (result.code !== 200) {
        throw new Error(`Failed to get file info: ${result.message}`);
      }

      const raw_url = result.data.raw_url;
      if (!raw_url) {
        throw new Error(`No raw_url found for file: ${filePath}`);
      }

      console.log(`Found raw_url: ${raw_url}`);
      return raw_url;
    } catch (error) {
      console.error(`Failed to get openlist download link for ${filePath}:`, error);
      if (axios.isAxiosError(error)) {
        throw new Error(`Failed to get openlist download link: ${error.response?.statusText || error.message}`);
      }
      throw error;
    }
  } else {
    throw new Error(`Unsupported account type: ${accountInfo.accountType}`);
  }
}

// 下载或生成 strm
export function downloadOrCreateStrm(
  url: string,
  savePath: string,
  opts?: { asStrm?: boolean; displayPath?: string; strmPrefix?: string }
): Observable<Progress> {
  const asStrm = !!opts?.asStrm;
  const displayPath = opts?.displayPath ?? savePath;
  const strmPrefix = opts?.strmPrefix ?? "";

  const dir = path.dirname(savePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  return new Observable<Progress>((observer) => {
    if (asStrm) {
      try {
        const ext = path.extname(savePath);
        const strmPath = savePath.replace(ext, ".strm");
        fs.writeFileSync(strmPath, `${strmPrefix}/${url}`, "utf8");
        observer.next({ percent: 100, filePath: displayPath });
        observer.complete();
      } catch (err: unknown) {
        observer.error(err);
      }
      return;
    }
    const userAgent = readSettings()["user-agent"];
    const headers = {
      "User-Agent": userAgent,
    };
    axios
      .get(url, { headers, responseType: "stream" })
      .then((response) => {
        const total = parseInt(response.headers["content-length"] || "0", 10);
        let received = 0;

        const writer = fs.createWriteStream(savePath);
        response.data.on("data", (chunk: Buffer) => {
          received += chunk.length;
          const percent = total ? (received / total) * 100 : 0;
          observer.next({
            percent: percent > 100 ? 100 : percent,
            filePath: displayPath,
          });
        });

        response.data.on("error", (err: unknown) => observer.error(err));
        writer.on("error", (err) => observer.error(err));

        writer.on("finish", () => {
          observer.next({ percent: 100, filePath: displayPath });
          observer.complete();
        });

        response.data.pipe(writer);
      })
      .catch((err) => observer.error(err));
  });
}


/**
 * 下载或生成 strm 文件，带账号级别限流和错误重试
 * 内部进度由 downloadOrCreateStrm Observable 发射，不在这里重复通知
 */
export function downloadOrCreateStrmLimited(
  filePathOrUrl: string,
  savePath: string,
  account: string,
  opts?: { asStrm?: boolean; displayPath?: string; strmPrefix?: string },
  maxRetries = 10,
  retryDelay = 2000
): Observable<Progress> {
  const settings = readSettings();
  const downloadConfig = (settings as Record<string, unknown>).download as Record<string, number> || {};
  
  return defer(() =>
    // defer 保证每次订阅才创建 Observable
    enqueueForAccount(
      `${account}:download`, 
      () => downloadOrCreateStrm(filePathOrUrl, savePath, opts),
      downloadConfig.downloadMaxConcurrent || 5
    )
  ).pipe(
    retry({
      count: maxRetries,
      delay: (error, retryCount) => {
        console.warn(`下载失败，正在重试 ${retryCount}/${maxRetries}`, error);
        return timer(retryDelay);
      },
    })
  );
}
