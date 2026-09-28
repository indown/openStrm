import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MediaLibraryEntry } from "@openstrm/shared";
import {
  freshIndexFields,
  getById,
  healthOf,
  insert,
  listByShareCode,
  listWithHealth,
  remove,
  setIndexState,
  update,
} from "../../db/repositories/media-library.js";
import { getShare, listExpiredCodes } from "../../db/repositories/library-shares.js";
import { childrenOf, deleteAll } from "../../db/repositories/library-nodes.js";
import { matchShareLink, parseShareText } from "../../services/drive/registry.js";
import { listWholeShareDir } from "../../services/drive/share-walk.js";
import { driveErrorToHttp } from "../../services/drive/errors.js";
import { libraryNameOf, withSuffix } from "../../services/library/name.js";
import { checkShare, checkShares, trackShare, untrackShareIfUnused } from "../../services/library/health.js";
import { SHARE_EXPIRED_ERROR, SHARE_LOCKED_ERROR, enqueueIndex, isWholeShare, stopIndexing } from "../../services/library/indexer.js";
import { searchLibrary } from "../../services/library/search.js";
import { normalizeTitle } from "../../services/media-title.js";
import { HttpError, upstreamError } from "../../lib/http-error.js";
import { parse } from "../../lib/validate.js";
import { cidSchema, idParamsSchema } from "../../schemas/entities.js";
import { randomId, sanitizeTags, shareRootCidForDb } from "./_util.js";

const createSchema = z.looseObject({
  shareUrl: z.string().trim().min(1, "shareUrl is required"),
  title: z.string().optional(),
  coverUrl: z.string().optional(),
  tags: z.array(z.unknown()).optional(),
  notes: z.string().optional(),
  cid: cidSchema.optional(),
  fileCount: z.union([z.number(), z.string()]).optional(),
  rawName: z.string().optional(),
  sharePath: z.string().optional(),
});

const patchSchema = z.object({
  title: z.string().optional(),
  coverUrl: z.string().optional(),
  notes: z.string().optional(),
  tags: z.array(z.unknown()).optional(),
  receiveCode: z.string().optional(),
});

const searchSchema = z.object({
  q: z.string().trim().max(200, "关键词最多 200 个字").default(""),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
  /** 要失效分享里的明细 */
  expired: z.enum(["0", "1"]).optional(),
  sourceId: z.string().max(100).optional(),
});

const checkSchema = z.object({
  codes: z.array(z.string().trim().min(1).max(100)).min(1, "至少给一个分享码").max(10, "一次最多查 10 个"),
});

const relinkSchema = z.object({
  shareUrl: z.string().trim().min(1, "shareUrl is required"),
  /** 新链接的内容和原来差很多时，第一次会 409 要确认；确认了再带 true */
  confirm: z.boolean().optional(),
});

/** 链接里的提取码换成新的：原链接用哪个参数名（password / pwd）就换哪个，没有就按网盘加 */
function withPassword(url: string, kind: string, password: string): string {
  try {
    const u = new URL(url);
    const key = u.searchParams.has("pwd") ? "pwd" : u.searchParams.has("password") ? "password" : kind === "quark" ? "pwd" : "password";
    if (password) u.searchParams.set(key, password);
    else u.searchParams.delete(key);
    return u.toString();
  } catch {
    return url;
  }
}

/** 分享码现在记的死活（刚登记、还没查过是 unknown） */
const checkedHealth = (shareCode: string) => getShare(shareCode)?.status ?? "unknown";

/** 分享内路径统一成不带首尾斜杠的样子再比 */
const normPath = (p: string) => p.replace(/^\/+|\/+$/g, "");
const isUnder = (child: string, parent: string) => parent === "" || child === parent || child.startsWith(`${parent}/`);

export default async function (fastify: FastifyInstance) {
  fastify.get("/api/library", { preHandler: [fastify.authenticate] }, async () => listWithHealth());

  fastify.get("/api/library/search", { preHandler: [fastify.authenticate], config: { agentScope: "read", agentToolset: "transfer" } }, async (request) => {
    const q = parse(searchSchema, request.query, "query");
    return searchLibrary({ q: q.q, limit: q.limit, offset: q.offset, includeExpired: q.expired === "1", sourceId: q.sourceId });
  });

  // 搜索结果里的分享顺手查一下死活：超过 6 小时没查过的才真去问网盘，每个分享一次请求
  fastify.post("/api/library/shares/check", { preHandler: [fastify.authenticate], config: { agentScope: "read", agentToolset: "transfer" } }, async (request) => {
    const body = parse(checkSchema, request.body);
    return { health: await checkShares(body.codes) };
  });

  fastify.post("/api/library", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = parse(createSchema, request.body);

    // 和 /api/share 收一样的写法（转存框就是拿用户贴的原话去开的）：整段「链接：… 提取码：…」也认。
    // 存认出来的链接（提取码拼在里面），不存那一整段：影库页、转存到任务都要按链接认网盘
    const ref = parseShareText(body.shareUrl);
    if (!ref) throw new HttpError(400, "Invalid share url");
    const shareUrl = ref.url;
    const shareCode = ref.code;
    const receiveCode = ref.password;

    const bodyTitle = (body.title ?? "").trim();
    const bodyCoverUrl = (body.coverUrl ?? "").trim();
    const bodyTags = sanitizeTags(body.tags);
    const bodyNotes = body.notes ?? "";
    const cidStr = shareRootCidForDb(body.cid);
    const bodyRawName = (body.rawName ?? "").trim();
    const subdir = Boolean(cidStr && cidStr !== "0" && bodyRawName);
    const now = Math.floor(Date.now() / 1000);

    // 同一个分享的来源不重叠：已经收了它的上级（或整包）就不再收；收了它下面的子目录，新的这条把它们吸收掉
    const bodyPath = subdir ? (body.sharePath ?? "").split("/").map((s) => s.trim()).filter(Boolean).join("/") || bodyRawName : "";
    const sharePath = subdir ? `/${bodyPath}` : "";
    const siblings = listByShareCode(shareCode);
    const covering = siblings.find((s) => isUnder(bodyPath, normPath(s.sharePath)) && (isWholeShare(s) || normPath(s.sharePath) !== ""));
    if (covering) {
      const message = isWholeShare(covering)
        ? `已经在影库里了：整个分享「${covering.shareTitle || covering.title || shareCode}」都收着`
        : normPath(covering.sharePath) === bodyPath
          ? subdir
            ? "该子目录已在影库中"
            : "该分享已在影库中"
          : `已经在影库里了：它的上级目录「${covering.rawName || covering.title}」收着`;
      throw new HttpError(409, message, { data: covering });
    }
    const absorbed = siblings.filter((s) => !isWholeShare(s) && isUnder(normPath(s.sharePath), bodyPath));

    // 先登记分享码，再去问网盘：打不开时旁听者就能当场记下（提取码不对、已失效），不用等排队轮到它才发现
    trackShare(shareCode, ref.kind);
    const match = matchShareLink(shareUrl);
    let shareTitle = "";
    if (match) {
      try {
        const session = await match.provider.share!.open(match.ref);
        shareTitle = (await match.provider.share!.info(session)).title.trim();
      } catch {
        // 打不开也照样收：旁听者记了死活，抄目录那边按它处理
      }
    }

    let entry: MediaLibraryEntry;
    if (subdir) {
      // 目录叫 `Season 2` 这种的，标题和年份从上一级的作品目录来（见 services/library/name.ts）
      const naming = libraryNameOf({ rawName: bodyRawName, title: "", sharePath });
      const { title: normTitle, year: normYear } = normalizeTitle(naming.query);
      entry = {
        id: randomId(),
        shareUrl,
        shareCode,
        receiveCode,
        sharePath,
        shareRootCid: cidStr,
        rawName: bodyRawName,
        title: bodyTitle || withSuffix(normTitle, naming.suffix) || bodyRawName,
        fileCount: 0,
        coverUrl: bodyCoverUrl,
        tags: bodyTags,
        notes: bodyNotes,
        mediaType: "unknown",
        tmdbId: null,
        year: normYear || "",
        overview: "",
        // 海报等抄完再定：看起来是一部作品才刮（见 indexer.ts 的 maybeScrape）
        scrapeStatus: "done",
        createdAt: now,
        updatedAt: now,
        shareTitle,
        ...freshIndexFields(),
      };
    } else {
      // 标题：给了就用给的，没给用分享自己的标题（打不开就先空着，抄目录时再补）
      const title = bodyTitle || shareTitle;
      entry = {
        id: randomId(),
        shareUrl,
        shareCode,
        receiveCode,
        sharePath: "",
        shareRootCid: "",
        rawName: title,
        title,
        fileCount: 0,
        coverUrl: bodyCoverUrl,
        tags: bodyTags,
        notes: bodyNotes,
        mediaType: "unknown",
        tmdbId: null,
        year: "",
        overview: "",
        scrapeStatus: "done",
        createdAt: now,
        updatedAt: now,
        shareTitle,
        ...freshIndexFields(),
      };
    }
    // 被吸收的子目录：标签、备注并过来
    for (const a of absorbed) {
      for (const t of a.tags) if (!entry.tags.includes(t)) entry.tags.push(t);
      if (a.notes.trim() && !entry.notes.includes(a.notes.trim())) entry.notes = entry.notes ? `${entry.notes}\n${a.notes.trim()}` : a.notes.trim();
    }
    insert(entry);
    for (const a of absorbed) {
      stopIndexing(a.id);
      remove(a.id);
    }
    // 刚才一查就是失效 / 提取码不对：直接标停，不去排队
    const health = checkedHealth(shareCode);
    if (health === "expired" || health === "locked") {
      setIndexState(entry.id, { indexStatus: "failed", indexError: health === "expired" ? SHARE_EXPIRED_ERROR : SHARE_LOCKED_ERROR });
    } else enqueueIndex(entry.id);
    const saved = listWithHealth().find((e) => e.id === entry.id) ?? entry;
    return reply.code(201).send({ mode: subdir ? "subdir" : "single", entry: saved, ...(absorbed.length ? { absorbed: absorbed.length } : {}) });
  });

  fastify.put("/api/library/:id", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    const body = parse(patchSchema, request.body);
    const current = getById(id);
    if (!current) throw new HttpError(404, "Entry not found");

    const updates: Partial<MediaLibraryEntry> = {};
    if (body.title !== undefined) updates.title = body.title.trim();
    if (body.coverUrl !== undefined) updates.coverUrl = body.coverUrl.trim();
    if (body.notes !== undefined) updates.notes = body.notes;
    if (body.tags !== undefined) updates.tags = sanitizeTags(body.tags);

    const merged = update(id, updates);
    if (!merged) throw new HttpError(404, "Entry not found");
    // 提取码是分享的：同一个分享收的几处一起改，改完查一次、没抄完的重新抄
    const receiveCode = body.receiveCode?.trim();
    if (receiveCode !== undefined && receiveCode !== current.receiveCode) {
      const kind = parseShareText(current.shareUrl)?.kind ?? "115";
      for (const s of listByShareCode(current.shareCode)) update(s.id, { receiveCode, shareUrl: withPassword(s.shareUrl, kind, receiveCode) });
      const health = await checkShare(current.shareCode);
      if (health.status !== "expired" && health.status !== "locked") {
        for (const s of listByShareCode(current.shareCode)) if (s.indexStatus !== "done") enqueueIndex(s.id);
      }
      return { ...getById(id)!, health };
    }
    return merged;
  });

  /**
   * 重新抄：分享里加了片、上一轮没抄完。
   * 分享已失效 / 提取码不对的是「再查一次」：真去问一次网盘（巡检不再查失效的，审核完又能打开的分享只能靠这个捞回来），
   * 好了由 health 通知工人接着抄停下的，抄完的不重抄；还是打不开就说原因
   */
  fastify.post("/api/library/:id/refresh", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    const entry = getById(id);
    if (!entry) throw new HttpError(404, "Entry not found");
    const before = getShare(entry.shareCode);
    if (before?.status === "expired" || before?.status === "locked") {
      const health = await checkShare(entry.shareCode);
      if (health.status === "expired" || health.status === "locked") {
        // 查的时间没变：没问到网盘（网络、账号的问题不记在分享上）
        if (health.checkedAt === before.checkedAt) throw upstreamError("这次没查成：网盘没回话或者账号有问题，稍后再试");
        const locked = health.status === "locked";
        throw upstreamError(locked ? "提取码还是不对：用「改提取码」改好" : `分享还是打不开：${health.reason || "已失效"}`, {
          code: "SHARE_GONE",
          reason: locked ? "password" : "gone",
        });
      }
      return { ...getById(id)!, health };
    }
    enqueueIndex(id);
    return { ...getById(id)!, health: healthOf(getShare(entry.shareCode)) };
  });

  /**
   * 换链接：上传者重发了新链接。先确认新链接打得开；和原来的内容差很多（根下的名字对上的不到三成）时 409 要确认。
   * 换成整个新分享，索引清空重抄，标签备注保留
   */
  fastify.post("/api/library/:id/relink", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    const body = parse(relinkSchema, request.body);
    const current = getById(id);
    if (!current) throw new HttpError(404, "Entry not found");
    const match = matchShareLink(body.shareUrl);
    if (!match) {
      const ref = parseShareText(body.shareUrl);
      throw new HttpError(400, ref ? "没有能打开这个分享的账号：先到「账户」页加一个" : "认不出这个分享链接");
    }
    const share = match.provider.share!;
    let title: string;
    let names: string[];
    try {
      const session = await share.open(match.ref);
      title = (await share.info(session)).title.trim();
      names = (await listWholeShareDir(share, session, "0")).map((e) => e.name);
    } catch (err) {
      throw driveErrorToHttp(err, "新链接打不开");
    }
    if (!body.confirm) {
      const oldRoot = isWholeShare(current) ? "0" : current.shareRootCid;
      const oldNames = new Set(childrenOf(id, oldRoot).map((n) => n.name));
      if (oldNames.size > 0 && names.length > 0) {
        const overlap = names.filter((n) => oldNames.has(n)).length / Math.min(oldNames.size, names.length);
        if (overlap < 0.3) {
          throw new HttpError(409, `新链接「${title || match.ref.code}」里的内容和原来的对不上几条，确定要换吗？`, { code: "RELINK_MISMATCH", newTitle: title, overlap: Math.round(overlap * 100) });
        }
      }
    }
    stopIndexing(id);
    const oldCode = current.shareCode;
    update(id, {
      shareUrl: match.ref.url,
      shareCode: match.ref.code,
      receiveCode: match.ref.password,
      sharePath: "",
      shareRootCid: "",
      shareTitle: title,
      rawName: title || current.rawName,
    });
    trackShare(match.ref.code, match.ref.kind);
    if (oldCode !== match.ref.code) untrackShareIfUnused(oldCode);
    // 旧分享的索引作废：新旧分享的节点 id 不相干，先清干净再抄
    deleteAll(id);
    enqueueIndex(id);
    return getById(id);
  });

  /** 清理全部已失效的分享：只删影库里的记录和索引，网盘和 strm 都不动 */
  fastify.delete("/api/library/expired", { preHandler: [fastify.authenticate] }, async () => {
    const codes = listExpiredCodes();
    let removedSources = 0;
    for (const code of codes) {
      for (const s of listByShareCode(code)) {
        stopIndexing(s.id);
        remove(s.id);
        removedSources++;
      }
      untrackShareIfUnused(code);
    }
    return { shares: codes.length, sources: removedSources };
  });

  fastify.delete("/api/library/:id", { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = parse(idParamsSchema, request.params, "params");
    const entry = getById(id);
    if (!entry) throw new HttpError(404, "Entry not found");
    stopIndexing(id);
    remove(id);
    untrackShareIfUnused(entry.shareCode);
    return { success: true };
  });
}
