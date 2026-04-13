import axios from "axios";
import Bottleneck from "bottleneck";
import path from "node:path";
import fs from "node:fs";
import { defer, firstValueFrom, Observable, retry, timer } from "rxjs";
import { get_id_to_path, getDownloadUrlWeb } from "../cloud-115/client.js";
import { readSettings } from "../cloud-115/settings-reader.js";

interface Progress {
  filePath?: string;
  percent?: number;
  overallPercent?: string;
  done?: boolean;
  error?: string;
}

const limiters = new Map<string, Bottleneck>();
const sharedLimiters = new Map<string, Bottleneck>();

export function clearRateLimiters(): void {
  limiters.forEach((limiter) => limiter.stop());
  sharedLimiters.forEach((limiter) => limiter.stop());
  limiters.clear();
  sharedLimiters.clear();
}

function getSharedLimiter(account: string): Bottleneck {
  const accountType = account.split(":")[0];
  if (!sharedLimiters.has(accountType)) {
    const settings = readSettings();
    const downloadConfig = (settings as Record<string, unknown>).download as Record<string, number> || {};
    const reservoir = downloadConfig.linkMaxPerSecond || 2;
    sharedLimiters.set(
      accountType,
      new Bottleneck({ reservoir, reservoirRefreshAmount: reservoir, reservoirRefreshInterval: 1000 })
    );
  }
  return sharedLimiters.get(accountType)!;
}

export function enqueueForAccount<T>(
  accountKey: string,
  fn: () => Observable<T>,
  maxConcurrent = 2
): Observable<T> {
  const account = accountKey.split(":")[0];
  if (!limiters.has(accountKey)) {
    const limiter = new Bottleneck({ maxConcurrent });
    limiter.chain(getSharedLimiter(account));
    limiters.set(accountKey, limiter);
  }
  const limiter = limiters.get(accountKey)!;
  return new Observable<T>((observer) => {
    limiter.schedule(() =>
      new Promise<void>((resolve, reject) => {
        fn().subscribe({
          next: (v) => observer.next(v),
          error: (err) => { observer.error(err); reject(err); },
          complete: () => { observer.complete(); resolve(); },
        });
      })
    );
  });
}

export async function getRealDownloadLink(
  filePath: string,
  account: string,
  accounts: any[],
  maxRetries = 3,
  retryDelay = 2000
): Promise<string> {
  const settings = readSettings();
  const accountInfo = accounts.find((acc: any) => acc.name === account);
  if (!accountInfo) throw new Error(`No cookie found for account: ${account}`);

  const createRetryObservable = (fn: () => Observable<string>) =>
    defer(fn).pipe(
      retry({
        count: maxRetries,
        delay: (_err, i) => {
          console.warn(`获取下载链接失败，正在重试 ${i}/${maxRetries}`);
          return timer(retryDelay);
        },
      })
    );

  const createAccountObservable = (): Observable<string> => {
    const accountType = accountInfo.accountType || "unknown";
    if (accountType === "115") {
      const userAgent = settings["user-agent"];
      return new Observable<string>((observer) => {
        getRealDownloadLinkDirect115(filePath, accountInfo, userAgent)
          .then((url) => { observer.next(url); observer.complete(); })
          .catch((err) => observer.error(err));
      });
    }
    // openlist / other
    const downloadConfig = (settings as Record<string, unknown>).download as Record<string, number> || {};
    return enqueueForAccount(
      account,
      () =>
        new Observable<string>((observer) => {
          getRealDownloadLinkDirect(filePath, accountInfo)
            .then((url) => { observer.next(url); observer.complete(); })
            .catch((err) => observer.error(err));
        }),
      downloadConfig.linkMaxConcurrent || 2
    );
  };

  return firstValueFrom(createRetryObservable(createAccountObservable));
}

async function getRealDownloadLinkDirect115(
  filePath: string,
  accountInfo: { name: string; cookie: string; accountType?: string },
  userAgent: string
): Promise<string> {
  const pickcode = await get_id_to_path({ path: filePath, userAgent, accountInfo });
  if (!pickcode) throw new Error(`No pickcode found for file: ${filePath}`);
  return getDownloadUrlWeb(pickcode, { userAgent, accountInfo });
}

async function getRealDownloadLinkDirect(
  filePath: string,
  accountInfo: { name: string; accountType?: string; url?: string; token?: string }
): Promise<string> {
  if (accountInfo.accountType === "openlist") {
    if (!accountInfo.url || !accountInfo.token)
      throw new Error(`Missing openlist credentials for account: ${accountInfo.name}`);
    const response = await axios.post(`${accountInfo.url}/api/fs/get`, { path: filePath }, {
      headers: { Authorization: accountInfo.token },
    });
    const result = response.data;
    if (result.code !== 200) throw new Error(`Failed to get file info: ${result.message}`);
    if (!result.data.raw_url) throw new Error(`No raw_url found for file: ${filePath}`);
    return result.data.raw_url;
  }
  throw new Error(`Unsupported account type: ${accountInfo.accountType}`);
}

export function downloadOrCreateStrm(
  url: string,
  savePath: string,
  opts?: { asStrm?: boolean; displayPath?: string; strmPrefix?: string; enablePathEncoding?: boolean }
): Observable<Progress> {
  const asStrm = !!opts?.asStrm;
  const displayPath = opts?.displayPath ?? savePath;
  const strmPrefix = opts?.strmPrefix ?? "";
  const enablePathEncoding = !!opts?.enablePathEncoding;

  const dir = path.dirname(savePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  return new Observable<Progress>((observer) => {
    if (asStrm) {
      try {
        const ext = path.extname(savePath);
        const strmPath = savePath.replace(ext, ".strm");
        const fullPath = `${strmPrefix}/${url}`;
        const finalPath = enablePathEncoding ? encodeURI(fullPath) : fullPath;
        fs.writeFileSync(strmPath, finalPath, "utf8");
        observer.next({ percent: 100, filePath: displayPath });
        observer.complete();
      } catch (err: unknown) {
        observer.error(err);
      }
      return;
    }
    const userAgent = readSettings()["user-agent"];
    axios
      .get(url, { headers: { "User-Agent": userAgent }, responseType: "stream" })
      .then((response) => {
        const total = parseInt(response.headers["content-length"] || "0", 10);
        let received = 0;
        const writer = fs.createWriteStream(savePath);
        response.data.on("data", (chunk: Buffer) => {
          received += chunk.length;
          const percent = total ? (received / total) * 100 : 0;
          observer.next({ percent: Math.min(percent, 100), filePath: displayPath });
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

export function downloadOrCreateStrmLimited(
  filePathOrUrl: string,
  savePath: string,
  account: string,
  opts?: { asStrm?: boolean; displayPath?: string; strmPrefix?: string; enablePathEncoding?: boolean },
  maxRetries = 10,
  retryDelay = 2000
): Observable<Progress> {
  const settings = readSettings();
  const downloadConfig = (settings as Record<string, unknown>).download as Record<string, number> || {};
  return defer(() =>
    enqueueForAccount(
      `${account}:download`,
      () => downloadOrCreateStrm(filePathOrUrl, savePath, opts),
      downloadConfig.downloadMaxConcurrent || 5
    )
  ).pipe(
    retry({
      count: maxRetries,
      delay: (_error, retryCount) => {
        console.warn(`下载失败，正在重试 ${retryCount}/${maxRetries}`);
        return timer(retryDelay);
      },
    })
  );
}
