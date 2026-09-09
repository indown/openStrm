import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import type { TaskDefinition } from "@openstrm/shared";
import { DATA_DIR } from "../../paths.js";
import { FakeDrive } from "../../test/fake-drive.js";
import { generateStrmForSelected, isSafeItemName } from "./share-strm.js";

const dir = path.join(DATA_DIR, "share-strm-test");
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("isSafeItemName：空、. / ..、含 / 都不行；前后空格、反斜杠、长名字可以", () => {
  for (const bad of ["", "  ", ".", "..", " ..", "a/b.mkv", "../x.mkv"]) assert.equal(isSafeItemName(bad), false, JSON.stringify(bad));
  for (const ok of [" ep1.mkv ", "a\\b.mkv", "x".repeat(300) + ".mkv"]) assert.equal(isSafeItemName(ok), true, JSON.stringify(ok));
});

test("不经过接口校验的入口：名字不合法的条目单独计数，不算「已存在」，其它照常生成", async () => {
  const drive = new FakeDrive("quark", { accountType: "quark", name: "ss", cookie: "c" });
  drive.tree.addDir("/kk/Show");
  drive.tree.addFile("/kk/Show/ep1.mkv");
  const task: TaskDefinition = { id: "ss-t", account: "ss", accountType: "quark", originPath: "kk", targetPath: "share-strm-test", strmPrefix: "/mnt" };
  const r = await generateStrmForSelected({
    task,
    provider: drive,
    selectedItems: [
      { name: "../escape.mkv", isDir: false },
      { name: "Show", isDir: true, id: drive.tree.get("/kk/Show")!.id },
    ],
    settings: { strmExtensions: [".mkv"] },
    subPath: "",
  });
  assert.deepEqual(r, { generatedCount: 1, skippedCount: 0, invalidNames: ["../escape.mkv"] });
  assert.ok(fs.existsSync(path.join(dir, "Show", "ep1.strm")));
  assert.ok(!fs.existsSync(path.join(DATA_DIR, "escape.strm")), "没有写到数据目录之外或别处");
});
