/**
 * 执行日志攒批落库。
 *
 * 以前每完成一个文件就把这条记录的 logs 整块读出来、解析、追加、序列化、写回——
 * 两万个文件就是两万次读改写一个几百 KB 的字符串，全在事件循环上同步做，
 * 任务越往后 SSE 和 API 越卡。现在攒够 maxLines 行或过了 maxDelayMs 才写一次；
 * 任务结束（完成 / 失败 / 取消）时由调用方 flush 收尾。
 */
export class LogBatcher {
  private pending: string[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sink: (lines: string[]) => void,
    private readonly opts: { maxLines: number; maxDelayMs: number } = { maxLines: 100, maxDelayMs: 2000 },
  ) {}

  push(line: string): void {
    this.pending.push(line);
    if (this.pending.length >= this.opts.maxLines) {
      this.flush();
    } else if (!this.timer) {
      // unref：别让一个等着落盘的计时器把进程拖住
      this.timer = setTimeout(() => this.flush(), this.opts.maxDelayMs).unref();
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    const lines = this.pending;
    this.pending = [];
    this.sink(lines);
  }
}
