import type { ZodType } from "zod";
import { HttpError } from "./http-error.js";

/**
 * 校验请求输入。失败即 400，message 指向第一个出错的字段，issues 原样放进 details。
 *
 * 没有 body 的请求按空对象处理：只有可选字段的 schema 照常通过，
 * 有必填字段的自然报"缺失"。
 */
export function parse<T>(
  schema: ZodType<T>,
  input: unknown,
  where: "body" | "query" | "params" = "body",
): T {
  const result = schema.safeParse(input ?? {});
  if (result.success) return result.data;
  const first = result.error.issues[0];
  const at = first?.path?.length ? first.path.map(String).join(".") : where;
  throw new HttpError(400, `${at}: ${first?.message ?? "invalid"}`, {
    code: "VALIDATION",
    details: result.error.issues,
  });
}
