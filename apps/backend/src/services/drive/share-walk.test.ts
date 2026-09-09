import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeDrive } from "../../test/fake-drive.js";
import { listWholeShareDir, resolveSharePath } from "./share-walk.js";

function setup() {
  const drive = new FakeDrive("quark", { accountType: "quark", name: "walk", cookie: "c" }, { share: true });
  const share = drive.share!;
  share.pageSize = 2;
  const tree = share.define("code", { title: "t" });
  tree.addDir("/S1");
  tree.addFile("/S1/E01.mkv");
  tree.addFile("/S1/E02.mkv");
  tree.addFile("/S1/E03.mkv");
  tree.addFile("/S1 notes.txt");
  tree.addFile("/top.mkv");
  return { share, session: { ref: share.parseLink(share.linkFor("code"))!, token: "stk" } };
}

test("listWholeShareDir 把翻页拼齐", async () => {
  const { share, session } = setup();
  const s1 = (await listWholeShareDir(share, session, "0")).find((e) => e.name === "S1")!;
  const files = await listWholeShareDir(share, session, s1.id);
  assert.deepEqual(files.map((e) => e.name).sort(), ["E01.mkv", "E02.mkv", "E03.mkv"]);
  assert.equal(share.calls.list, 4, "根目录 2 页 + S1 2 页");
});

test("resolveSharePath 逐级找：中间段必须是目录，最后一段文件目录都行，找不到和空路径都是 null", async () => {
  const { share, session } = setup();
  assert.equal((await resolveSharePath(share, session, "S1/E02.mkv"))?.name, "E02.mkv");
  assert.equal((await resolveSharePath(share, session, "/S1/"))?.isDir, true);
  assert.equal(await resolveSharePath(share, session, "top.mkv/x"), null, "top.mkv 是文件，不能当中间段");
  assert.equal(await resolveSharePath(share, session, "S1/nope.mkv"), null);
  assert.equal(await resolveSharePath(share, session, ""), null);
});
