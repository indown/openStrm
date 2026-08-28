/**
 * 跨路由共用的实体 schema。`satisfies z.ZodType<…>` 把它们钉在 @openstrm/shared 的类型上：
 * schema 产出的形状对不上类型，这里就编译不过。
 */
import { z } from "zod";
import { validateCronExpression } from "cron";
import type { AppSettings, LifeMonitorSettings, TaskDefinition } from "@openstrm/shared";

/** 115 的 id 超过 JS 安全整数，前端有的地方传字符串、有的传数字 */
export const cidSchema = z.union([z.string(), z.number()]);

/** `/:id` 路由参数 */
export const idParamsSchema = z.object({ id: z.string().min(1) });

/**
 * 空串表示不定时（前端清空字段时就发空串）；其余必须能被 cron 解析。
 * 不在这里拦住的话，坏表达式会被存进库，之后每次启动排程都在 new CronJob 上炸。
 */
export const cronExpressionSchema = z
  .string()
  .refine((v) => v === "" || validateCronExpression(v).valid, { message: "invalid cron expression" });

export const taskInputSchema = z.looseObject({
  account: z.string().min(1),
  originPath: z.string(),
  targetPath: z.string().min(1),
  accountType: z.string().optional(),
  strmPrefix: z.string().optional(),
  removeExtraFiles: z.boolean().optional(),
  enablePathEncoding: z.boolean().optional(),
  enable302: z.boolean().optional(),
  cronExpression: cronExpressionSchema.optional(),
}) satisfies z.ZodType<Omit<TaskDefinition, "id">>;

export const taskPatchSchema = taskInputSchema.partial().extend({ id: z.string().min(1) });

const account115Schema = z.looseObject({
  accountType: z.literal("115"),
  name: z.string().min(1),
  cookie: z.string({ error: "cookie is required for 115 accounts" }).min(1, "cookie is required for 115 accounts"),
});

const accountOpenlistSchema = z.looseObject({
  accountType: z.literal("openlist"),
  name: z.string().min(1),
  account: z.string({ error: "account, password, and url are required for openlist accounts" }).min(1),
  password: z.string({ error: "account, password, and url are required for openlist accounts" }).min(1),
  url: z.string({ error: "account, password, and url are required for openlist accounts" }).min(1),
});

export const accountInputSchema = z.discriminatedUnion("accountType", [account115Schema, accountOpenlistSchema]);

/** 改账号：name 定位，其余字段可选；凭据是否齐全由路由按 accountType 再查 */
export const accountPatchSchema = z.looseObject({
  name: z.string().min(1),
  accountType: z.enum(["115", "openlist"]).optional(),
});

export const lifeMonitorSchema = z.looseObject({
  enabled: z.boolean().optional(),
  account: z.string().optional(),
  pullMode: z.enum(["latest", "all", "last"]).optional(),
  intervalSeconds: z.number().int().positive().optional(),
  eventModes: z.array(z.enum(["create", "move", "rename", "remove"])).optional(),
  mediaServerRefreshDelay: z.number().int().min(0).optional(),
  mediaServerRefreshMaxWait: z.number().int().min(0).optional(),
}) satisfies z.ZodType<LifeMonitorSettings>;

/** PUT /api/settings 的 body：只校验认识的键的类型，多出来的顶层键原样存 */
export const settingsPatchSchema = z.looseObject({
  "user-agent": z.string().optional(),
  strmExtensions: z.array(z.string()).optional(),
  downloadExtensions: z.array(z.string()).optional(),
  mediaMountPath: z.array(z.string()).optional(),
  emby: z
    .looseObject({
      url: z.string().optional(),
      apiKey: z.string().optional(),
      allowAnonymousRedirect: z.boolean().optional(),
    })
    .optional(),
  telegram: z
    .looseObject({
      botToken: z.string().optional(),
      chatId: z.string().optional(),
      webhookUrl: z.string().optional(),
      allowedUsers: z.array(z.number()).optional(),
      allowTaskStart: z.boolean().optional(),
      allowOfflineAdd: z.boolean().optional(),
      allowShareReceive: z.boolean().optional(),
      pollingEnabled: z.boolean().optional(),
      notify: z
        .looseObject({
          taskStart: z.boolean().optional(),
          taskDone: z.boolean().optional(),
          taskFailed: z.boolean().optional(),
          offline: z.boolean().optional(),
          accountAlert: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  tmdb: z.looseObject({ apiKey: z.string().optional(), language: z.string().optional() }).optional(),
  hdhive: z.looseObject({ apiKey: z.string().optional(), baseUrl: z.string().optional() }).optional(),
  download: z
    .looseObject({
      linkMaxPerSecond: z.number().positive().optional(),
      linkMaxConcurrent: z.number().positive().optional(),
      downloadMaxConcurrent: z.number().positive().optional(),
    })
    .optional(),
  lifeMonitor: lifeMonitorSchema.optional(),
}) satisfies z.ZodType<Partial<AppSettings>>;
