/**
 * 换多少次都一样的失败：远端明确回答"没有这个对象"、凭据缺失、账号类型不支持之类。
 * 重试策略（取直链、下载）见到它就直接放弃，别再拿同一个请求白等几轮。
 */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}
