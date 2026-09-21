/**
 * OAuth 协议里的错误：回给客户端的是 RFC 6749 那种 { error, error_description }，不是我们自己的 { message } 壳。
 * status 401 的是客户端认证失败（invalid_client）。
 *
 * error_description 规范只许 ASCII（RFC 6749 §5.2、RFC 7591 §3.2.2），写英文；
 * 给人看的中文放 hint，授权页和它的脚本、日志用。
 */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
    readonly hint?: string,
  ) {
    super(hint ?? description);
    this.name = "OAuthError";
  }

  /** 给人看的那句：有中文用中文 */
  get forHuman(): string {
    return this.hint ?? this.description;
  }

  toJSON() {
    return { error: this.error, error_description: this.description };
  }
}
