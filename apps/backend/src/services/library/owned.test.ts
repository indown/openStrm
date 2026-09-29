/**
 * 收藏夹「已经有了」的本地那一份：扫各任务的本地 strm 目录，认得出 tmdbId 的作品目录（目录名的 id 标签、作品 nfo），剧带上季。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/library/owned.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { TaskDefinition } from "@openstrm/shared";
import { deleteTask, insertTask } from "../../db/repositories/tasks.js";
import { DATA_DIR } from "../../paths.js";
import { scanLocalWorks } from "../strm/poster.js";
import { __test_resetOwned, localOwned, ownedWorkKeys } from "./owned.js";

const root = path.join(DATA_DIR, "owned-lib");
const put = (rel: string, content = "http://x") => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
};

put("剧集/权力的游戏 (2011) [tmdbid=1399]/Season 01/权力的游戏 S01E01.strm");
put("剧集/权力的游戏 (2011) [tmdbid=1399]/Season 02/权力的游戏 S02E01.strm");
put("剧集/神探夏洛克 [tmdbid=19885]/神探夏洛克 S03E01.strm");
put("电影/黑客帝国/黑客帝国.strm");
put("电影/黑客帝国/movie.nfo", '<movie><title>黑客帝国</title><uniqueid type="tmdb">603</uniqueid></movie>');
put("电影/随便一部 1080p/随便一部.strm");

const task = { id: "owned-t1", account: "a", originPath: "/影视", targetPath: "owned-lib" } as TaskDefinition;

test("本地已有：目录名带 tmdbid 的、有作品 nfo 的都认得出，剧带上有哪几季（季目录或 strm 名字里的 SxxEyy）；没整理过的认不出", async () => {
  const works = await scanLocalWorks([task]);
  assert.deepEqual(works.map((w) => [w.mediaType, w.tmdbId, w.rel, w.seasons.join(",")]).sort(), [
    ["movie", 603, "电影/黑客帝国", ""],
    ["tv", 1399, "剧集/权力的游戏 (2011) [tmdbid=1399]", "1,2"],
    ["tv", 19885, "剧集/神探夏洛克 [tmdbid=19885]", "3"],
  ]);
  assert.ok(works.every((w) => w.taskId === "owned-t1"));
});

test("localOwned：还没扫过时不等就给 null，后台扫好以后给索引（带任务和目录）；ownedWorkKeys 是作品键", async () => {
  insertTask({ ...task, id: "owned-t2" });
  try {
    __test_resetOwned();
    assert.equal(await localOwned(0), null, "界面不等");
    const index = await localOwned(10_000);
    const got = index?.get("tv:1399");
    assert.deepEqual(got, [{ via: "local", taskId: "owned-t2", taskLabel: "a · /影视", path: "剧集/权力的游戏 (2011) [tmdbid=1399]", seasons: [1, 2] }]);
    const keys = ownedWorkKeys(index);
    assert.ok(keys.has("movie:603") && keys.has("tv:19885"));
    assert.ok(!keys.has("movie:1399"), "按目录的类型认：剧的 id 不当电影");
    assert.equal(await localOwned(0), index, "算过了直接给缓存");
  } finally {
    deleteTask("owned-t2");
    __test_resetOwned();
  }
});
