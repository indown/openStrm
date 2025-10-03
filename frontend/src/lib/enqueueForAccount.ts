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

export function enqueueForAccount<T>(
  account: string,
  fn: () => Observable<T>,
  maxPerSecond = 2,
  maxConcurrent = 2 // 新增参数，允许更多并发
): Observable<T> {
  if (!limiters.has(account)) {
    const limiter = new Bottleneck({
      reservoir: maxPerSecond,
      reservoirRefreshAmount: maxPerSecond,
      reservoirRefreshInterval: 1000,
      maxConcurrent: maxConcurrent,  // 使用参数而不是硬编码的1
    });
    limiters.set(account, limiter);
  }

  const limiter = limiters.get(account)!;

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
  account: string
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
  if (accountInfo.accountType === "115") {
    const cookie = accountInfo.cookie;
    const userAgent =
      settings["user-agent"] ||
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

    try {
      console.log(`Looking for file: ${filePath}`);
      // 1. 通过路径获取文件 ID
      const pickcode = await get_id_to_path({
        cookie,
        path: filePath,
        userAgent,
      });

      console.log(`Found pickcode: ${pickcode}`);

      if (!pickcode) {
        throw new Error(`No pickcode found for file: ${filePath}`);
      }

      // 3. 通过 pickcode 获取下载 URL
      console.log(`Getting download URL for pickcode: ${pickcode}`);
      const downloadUrl = await getDownloadUrlWeb(pickcode, {
        cookie,
        userAgent,
      });
      return downloadUrl;
    } catch (error) {
      console.error(`Failed to get download link for ${filePath}:`, error);
      throw error;
    }
  } else if (accountInfo.accountType === "openlist") {
    if (!accountInfo.url || !accountInfo.token) {
      throw new Error(`Missing openlist credentials for account: ${account}`);
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
    const userAgent =
      readSettings()["user-agent"] ||
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    // console.log("Using User-Agent:", userAgent);
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
 * 获取真实下载链接，账号限流 + 错误重试
 */
export function getRealDownloadLinkLimited(
  filePath: string,
  account: string,
  maxRetries = 3,
  retryDelay = 2000
): Promise<string> {
  const settings = readSettings();
  const downloadConfig = (settings as Record<string, unknown>).download as Record<string, number> || {};
  
  const obs$ = defer(() =>
    enqueueForAccount(
      account,
      () =>
        new Observable<string>((observer) => {
          getRealDownloadLink(filePath, account)
            .then((url) => {
              observer.next(url);
              observer.complete();
            })
            .catch((err) => observer.error(err));
        }),
      downloadConfig.maxPerSecond || 2,
      downloadConfig.linkMaxConcurrent || 2 
    )
  ).pipe(
    retry({
      count: maxRetries,
      delay: (err, i) => {
        console.warn(`获取真实下载链接失败，正在重试 ${i}/${maxRetries}`, err);
        return timer(retryDelay);
      },
    })
  );
  return firstValueFrom(obs$); // 保留 Promise 返回类型
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
      account, 
      () => downloadOrCreateStrm(filePathOrUrl, savePath, opts),
      downloadConfig.maxPerSecond || 2,
      downloadConfig.maxConcurrent || 2
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
