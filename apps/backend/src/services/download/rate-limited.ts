import axios from "axios";
import Bottleneck from "bottleneck";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { defer, firstValueFrom, lastValueFrom, Observable, retry, Subscription, throwError, timer } from "rxjs";
import { getIdToPath, getDownloadUrlWeb } from "../cloud-115/client.js";
import type { AccountInfo } from "@openstrm/shared";
import { readAppSettings } from "../../db/repositories/settings.js";
import { strmContent, toStrmPath } from "../strm/naming.js";
import { moduleLogger } from "../../lib/logger.js";
import { DEFAULT_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS, guardIdleStream } from "../../lib/http.js";

const log = moduleLogger("download");

interface Progress {
  filePath?: string;
  percent?: number;
  overallPercent?: string;
  done?: boolean;
  error?: string;
}

const limiters = new Map<string, Bottleneck>();
const sharedLimiters = new Map<string, Bottleneck>();

/**
 * 丢掉现有限流器，之后的请求按当前设置新建。
 *
 * 旧的让它排空：stop() 默认会把排队中的任务全部拒绝掉，正在跑的全量任务就此卡成永远 processing。
 * 顺序也有讲究：账号限流器链在共享限流器上，任务（包括 stop 自己放进去的收尾哨兵）
 * 是异步提交给父级的——父级先停，子级的收尾就会被父级拒掉。所以先等子级全部收完，再停父级。
 */
export function clearRateLimiters(): void {
  const children = [...limiters.values()];
  const shared = [...sharedLimiters.values()];
  limiters.clear();
  sharedLimiters.clear();
  void Promise.allSettled(children.map((l) => l.stop({ dropWaitingJobs: false }))).then(() =>
    Promise.allSettled(shared.map((l) => l.stop({ dropWaitingJobs: false }))),
  );
}

function getSharedLimiter(account: string): Bottleneck {
  const accountType = account.split(":")[0];
  if (!sharedLimiters.has(accountType)) {
    const reservoir = readAppSettings().download?.linkMaxPerSecond || 2;
    sharedLimiters.set(
      accountType,
      new Bottleneck({ reservoir, reservoirRefreshAmount: reservoir, reservoirRefreshInterval: 1000 })
    );
  }
  return sharedLimiters.get(accountType)!;
}

/**
 * 账号 + 通道一把并发限流器，链在账号级的每秒配额上。
 * 并发数只在第一次建的时候生效，改了设置要 clearRateLimiters 才按新值重建。
 */
function getLimiter(accountKey: string, maxConcurrent: number): Bottleneck {
  let limiter = limiters.get(accountKey);
  if (!limiter) {
    limiter = new Bottleneck({ maxConcurrent });
    limiter.chain(getSharedLimiter(accountKey.split(":")[0]));
    limiters.set(accountKey, limiter);
  }
  return limiter;
}

/**
 * 单次请求的账号限流（取直链、115 接口）。Bottleneck 本来就是 Promise 接口：
 * 槽位随 Promise 落定归还，没有订阅 / 退订那一层。signal 已中止的任务轮到时直接拒绝，不再发请求。
 */
export function scheduleForAccount<T>(
  accountKey: string,
  fn: () => Promise<T>,
  maxConcurrent = 2,
  signal?: AbortSignal,
): Promise<T> {
  return getLimiter(accountKey, maxConcurrent).schedule(async () => {
    signal?.throwIfAborted();
    return fn();
  });
}

/**
 * 会发进度的流排进账号限流器（下载用；单次请求用 scheduleForAccount）。
 * 限流器在订阅时才取：clearRateLimiters 之后再订阅的拿到新建的，而不是已经 stop 的旧限流器。
 */
export function enqueueForAccount<T>(
  accountKey: string,
  fn: () => Observable<T>,
  maxConcurrent = 2
): Observable<T> {
  return new Observable<T>((observer) => {
    const limiter = getLimiter(accountKey, maxConcurrent);
    let cancelled = false;
    let inner: Subscription | null = null;
    /** 任务已开始时，调它就是把限流器的槽位还回去 */
    let release: (() => void) | null = null;
    limiter
      .schedule(
        () =>
          new Promise<void>((resolve) => {
            // 排到队头时订阅方早已退订（任务取消）：直接放过，别再发请求、写盘
            if (cancelled) return resolve();
            release = resolve;
            inner = fn().subscribe({
              next: (v) => observer.next(v),
              // 错误只走 observer；这里 resolve 是为了让限流器释放槽位
              error: (err) => { observer.error(err); resolve(); },
              complete: () => { observer.complete(); resolve(); },
            });
          }),
      )
      // 限流器被 stop、fn 同步抛出之类的失败以前被丢掉，订阅方永远等不到结果
      .catch((err) => observer.error(err));
    return () => {
      cancelled = true;
      inner?.unsubscribe();
      // 订阅方退订了也要还槽位——不只是任务取消：firstValueFrom 这类"拿到第一个值就退订"的消费者
      // 退订之后，内层随后的 complete 送不到这里。只靠 complete 来 resolve 的话，一个账号的两个槽位
      // 两次请求就全部漏光，第三次起所有调用永远排队（rc.9 的 request115 就是这样挂死的）
      release?.();
    };
  });
}

export async function getRealDownloadLink(
  filePath: string,
  account: string,
  accounts: AccountInfo[],
  maxRetries = 3,
  retryDelay = 2000
): Promise<string> {
  const settings = readAppSettings();
  const accountInfo = accounts.find((acc) => acc.name === account);
  if (!accountInfo) throw new Error(`No cookie found for account: ${account}`);

  const createRetryObservable = (fn: () => Observable<string>) =>
    defer(fn).pipe(
      retry({
        count: maxRetries,
        delay: (_err, i) => {
          log.warn(`获取下载链接失败，正在重试 ${i}/${maxRetries}`);
          return timer(retryDelay);
        },
      })
    );

  const createAccountObservable = (): Observable<string> => {
    if (accountInfo.accountType === "115") {
      const userAgent = settings["user-agent"];
      return new Observable<string>((observer) => {
        getRealDownloadLinkDirect115(filePath, accountInfo, userAgent)
          .then((url) => { observer.next(url); observer.complete(); })
          .catch((err) => observer.error(err));
      });
    }
    // openlist / other
    return enqueueForAccount(
      account,
      () =>
        new Observable<string>((observer) => {
          getRealDownloadLinkDirect(filePath, accountInfo)
            .then((url) => { observer.next(url); observer.complete(); })
            .catch((err) => observer.error(err));
        }),
      settings.download?.linkMaxConcurrent || 2
    );
  };

  return firstValueFrom(createRetryObservable(createAccountObservable));
}

async function getRealDownloadLinkDirect115(
  filePath: string,
  accountInfo: { name: string; cookie: string; accountType?: string },
  userAgent: string | undefined,
): Promise<string> {
  const pickcode = await getIdToPath({ path: filePath, userAgent, accountInfo });
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
      timeout: DEFAULT_TIMEOUT_MS,
    });
    const result = response.data;
    if (result.code !== 200) throw new Error(`Failed to get file info: ${result.message}`);
    if (!result.data.raw_url) throw new Error(`No raw_url found for file: ${filePath}`);
    return result.data.raw_url;
  }
  throw new Error(`Unsupported account type: ${accountInfo.accountType}`);
}

export interface DownloadOptions {
  asStrm?: boolean;
  displayPath?: string;
  strmPrefix?: string;
  enablePathEncoding?: boolean;
  /** 下载流多久没数据算卡死。默认 STREAM_IDLE_TIMEOUT_MS，测试调小 */
  idleTimeoutMs?: number;
}

export function downloadOrCreateStrm(url: string, savePath: string, opts?: DownloadOptions): Observable<Progress> {
  const asStrm = !!opts?.asStrm;
  const displayPath = opts?.displayPath ?? savePath;
  const strmPrefix = opts?.strmPrefix ?? "";
  const enablePathEncoding = !!opts?.enablePathEncoding;
  const idleTimeoutMs = opts?.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
  const dir = path.dirname(savePath);

  return new Observable<Progress>((observer) => {
    if (asStrm) {
      // 异步写：全量任务一次会订阅几万个，同步 writeFileSync 就是几万次阻塞写挤在一个 tick 里
      (async () => {
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(toStrmPath(savePath), strmContent(strmPrefix, url, enablePathEncoding), "utf8");
        observer.next({ percent: 100, filePath: displayPath });
        observer.complete();
      })().catch((err) => observer.error(err));
      return;
    }
    const userAgent = readAppSettings()["user-agent"];
    const controller = new AbortController();
    // 先写到 .part，写完再改名：中途断掉的半截文件不会顶着正式文件名，
    // 下次同步按文件名对照时也就不会把它当成"已存在"而永远不重下
    const partPath = `${savePath}.part`;
    let writer: fs.WriteStream | null = null;
    let settled = false;
    const discardPart = () => fsp.rm(partPath, { force: true }).catch(() => {});
    const failWith = (err: unknown) => {
      if (settled) return;
      settled = true;
      // 写盘失败（磁盘满等）也要把请求掐掉：不然下面挂着的 data 监听会让旧响应把整个 body 拉完，
      // 而 retry 那边已经开始下一次尝试了。对已经出错 / 已中止的请求，abort 是空操作
      controller.abort();
      writer?.destroy();
      void discardPart();
      observer.error(err);
    };

    fsp
      .mkdir(dir, { recursive: true })
      .then(() =>
        axios.get(url, {
          headers: { "User-Agent": userAgent },
          responseType: "stream",
          timeout: DEFAULT_TIMEOUT_MS,
          signal: controller.signal,
        }),
      )
      .then((response) => {
        if (settled) {
          response.data.destroy();
          return;
        }
        const total = parseInt(response.headers["content-length"] || "0", 10);
        let received = 0;
        // 进度只在整数百分比变化时发一次：一个大文件几万个 chunk，每个都发一条会把 SSE 和日志缓冲灌满。
        // 最多报到 99——100 只在改名完成后发一次，收到 100 就等于文件已经就位
        let lastStep = -1;
        writer = fs.createWriteStream(partPath);
        // 卡住的下载会被销毁并走到 failWith，由 downloadOrCreateStrmLimited 的 retry 重来
        guardIdleStream(response.data, idleTimeoutMs, `下载 ${displayPath}`);
        response.data.on("data", (chunk: Buffer) => {
          received += chunk.length;
          const step = total ? Math.min(Math.floor((received / total) * 100), 99) : 0;
          if (step === lastStep) return;
          lastStep = step;
          observer.next({ percent: step, filePath: displayPath });
        });
        response.data.on("error", failWith);
        writer.on("error", failWith);
        writer.on("finish", () => {
          fsp.rename(partPath, savePath).then(() => {
            if (settled) return;
            settled = true;
            observer.next({ percent: 100, filePath: displayPath });
            observer.complete();
          }, failWith);
        });
        response.data.pipe(writer);
      })
      .catch(failWith);

    // 退订（任务取消）：中止请求、关掉写入、删掉半截文件
    return () => {
      if (settled) return;
      settled = true;
      controller.abort();
      writer?.destroy();
      void discardPart();
    };
  });
}

/** 写一个 strm（Promise 版）。要进度流的全量任务用 downloadOrCreateStrm，其它调用方用这个 */
export async function writeStrm(
  remotePath: string,
  savePath: string,
  opts?: Pick<DownloadOptions, "displayPath" | "strmPrefix" | "enablePathEncoding">,
): Promise<void> {
  await lastValueFrom(downloadOrCreateStrm(remotePath, savePath, { ...opts, asStrm: true }));
}

/**
 * 下载一个文件到 savePath（Promise 版），.part 改名完成才 resolve。
 * 下载流是多值的（每个整数百分比一条），别在它上面用 firstValueFrom：拿到第一条就退订会把下载掐掉
 */
export async function downloadFile(
  url: string,
  savePath: string,
  opts?: Pick<DownloadOptions, "displayPath" | "idleTimeoutMs">,
): Promise<void> {
  await lastValueFrom(downloadOrCreateStrm(url, savePath, { ...opts, asStrm: false }));
}

export function downloadOrCreateStrmLimited(
  filePathOrUrl: string,
  savePath: string,
  account: string,
  opts?: DownloadOptions,
  maxRetries = 10,
  retryDelay = 2000
): Observable<Progress> {
  const maxConcurrent = readAppSettings().download?.downloadMaxConcurrent || 5;
  return defer(() =>
    enqueueForAccount(
      `${account}:download`,
      () => downloadOrCreateStrm(filePathOrUrl, savePath, opts),
      maxConcurrent
    )
  ).pipe(
    retry({
      count: maxRetries,
      delay: (error, retryCount) => {
        // 404 / 410 换多少次都一样：链接指向的文件已经没了，别再拿同一个链接重试 10 次白等 20 秒
        if (isPermanentFailure(error)) return throwError(() => error);
        log.warn(`下载失败，正在重试 ${retryCount}/${maxRetries}`);
        return timer(retryDelay);
      },
    })
  );
}

function isPermanentFailure(err: unknown): boolean {
  const status = axios.isAxiosError(err) ? err.response?.status : undefined;
  return status === 404 || status === 410;
}
