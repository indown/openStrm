import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseJsonBigIntSafe, reachedCursor, type LifeEvent } from "../cloud-115/life.js";
import { matchTask, toStrmPath, type LifeContext } from "./handlers.js";
import { joinPanPath } from "../cloud-115/path-resolver.js";
import type { TaskDefinition } from "@openstrm/shared";
import { listTasks } from "../../db/repositories/tasks.js";

let pass = 0;
const t = (name: string, fn: () => void) => { fn(); pass++; console.log("  ok  " + name); };
const raw = (fn: () => void) => fn();

console.log("parseJsonBigIntSafe");
t("19 位 id 不丢精度", () => {
  const raw = '{"data":{"count":3,"list":[{"id":2618855323975851714,"file_id":3040163688862324736,"parent_id":0,"type":2}]}}';
  const o = parseJsonBigIntSafe<any>(raw);
  assert.equal(o.data.list[0].id, "2618855323975851714");
  assert.equal(o.data.list[0].file_id, "3040163688862324736");
  assert.equal(o.data.list[0].parent_id, 0, "短整数保持数字");
  assert.equal(o.data.count, 3);
});
t("已是字符串的 id 原样保留", () => {
  const o = parseJsonBigIntSafe<any>('{"file_id":"3040163688862324736"}');
  assert.equal(o.file_id, "3040163688862324736");
});
t("数组结尾的长整数也被引号包住", () => {
  const o = parseJsonBigIntSafe<any>('{"ids":[3040163688862324736]}');
  assert.equal(o.ids[0], "3040163688862324736");
});

t("字符串内部的长数字不被改动", () => {
  const raw = '{"file_name":"S01E01 [1234567890123456789] 4K.mkv","file_id":3040163688862324736}';
  const o = parseJsonBigIntSafe<any>(raw);
  assert.equal(o.file_name, "S01E01 [1234567890123456789] 4K.mkv");
  assert.equal(o.file_id, "3040163688862324736");
});
t("字符串里的转义引号不破坏扫描", () => {
  const o = parseJsonBigIntSafe<any>('{"n":"a\\"b","file_id":3040163688862324736}');
  assert.equal(o.n, 'a"b');
  assert.equal(o.file_id, "3040163688862324736");
});
t("浮点与短整数原样保留为数字", () => {
  const o = parseJsonBigIntSafe<any>('{"a":1.5,"b":123,"c":1e3,"d":0}');
  assert.equal(o.a, 1.5); assert.equal(o.b, 123); assert.equal(o.c, 1000); assert.equal(o.d, 0);
});

console.log("reachedCursor（列表倒序，命中即停）");
const ev = (id: string, ut: number) => ({ id, update_time: ut } as LifeEvent);
t("id 相等 → 停", () => assert.equal(reachedCursor(ev("100", 5), { fromId: "100", fromTime: 0 }), true));
t("id 更小 → 停", () => assert.equal(reachedCursor(ev("99", 5), { fromId: "100", fromTime: 0 }), true));
t("id 更大 → 继续", () => assert.equal(reachedCursor(ev("101", 5), { fromId: "100", fromTime: 0 }), false));
t("19 位 id 按长度先比，不走字典序", () => {
  assert.equal(reachedCursor(ev("2618855323975851715", 0), { fromId: "2618855323975851714", fromTime: 0 }), false);
  assert.equal(reachedCursor(ev("999999999999999999", 0), { fromId: "1000000000000000000", fromTime: 0 }), true, "18 位 < 19 位");
  assert.equal(reachedCursor(ev("1000000000000000000", 0), { fromId: "999999999999999999", fromTime: 0 }), false, "19 位 > 18 位");
});
t("update_time 早于游标 → 停", () => assert.equal(reachedCursor(ev("0", 100), { fromId: "0", fromTime: 200 }), true));
t("update_time 等于游标 → 继续（含）", () => assert.equal(reachedCursor(ev("0", 200), { fromId: "0", fromTime: 200 }), false));

console.log("joinPanPath");
t("根目录下拼接不出现双斜杠", () => assert.equal(joinPanPath("/", "tv"), "/tv"));
t("普通拼接", () => assert.equal(joinPanPath("/tv", "ShowA"), "/tv/ShowA"));
t("文件名里的 / 被转义", () => assert.equal(joinPanPath("/tv", "a/b"), "/tv/a\\/b"));

console.log("toStrmPath");
t(".mkv → .strm", () => assert.equal(toStrmPath("/d/a.mkv"), "/d/a.strm"));
t("目录名含点也不误伤", () => assert.equal(toStrmPath("/d.v2/a.mkv"), "/d.v2/a.strm"));

console.log("matchTask + strm 内容与全量任务一致");
const tasks: TaskDefinition[] = [
  { id: "t-tv", account: "acct", accountType: "115", originPath: "tv", targetPath: "tv", strmPrefix: "/prefix" },
  { id: "t-movie", account: "acct", accountType: "115", originPath: "movie", targetPath: "movie", strmPrefix: "/prefix" },
  { id: "t-sub", account: "acct", accountType: "115", originPath: "tv/anime", targetPath: "anime", strmPrefix: "/p" },
];
const ctx = { tasks } as unknown as LifeContext;
t("originPath 无前导斜杠时也能命中", () => {
  const m = matchTask(ctx, "/tv/ShowA/ep1.mkv");
  assert.equal(m?.task.id, "t-tv");
  assert.equal(m?.relPath, "ShowA/ep1.mkv");
});
t("命中最长（最具体）的 originPath", () => {
  const m = matchTask(ctx, "/tv/anime/SubShow/ep1.mkv");
  assert.equal(m?.task.id, "t-sub");
  assert.equal(m?.relPath, "SubShow/ep1.mkv");
});
t("不在任何 originPath 下 → null", () => assert.equal(matchTask(ctx, "/other/x.mkv"), null));
t("前缀相同但不是子路径 → 不命中", () => assert.equal(matchTask(ctx, "/tvshows/x.mkv"), null));
t("originPath 自身 → relPath 为空", () => assert.equal(matchTask(ctx, "/tv")?.relPath, ""));

function findFirstStrm(dir: string): string | null {
  let items: fs.Dirent[];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isDirectory()) { const hit = findFirstStrm(full); if (hit) return hit; }
    else if (it.name.endsWith(".strm")) return full;
  }
  return null;
}

raw(() => {
  // 拿库里真实配置的 115 任务，随便找一个它已经生成的 strm，
  // 用本模块的公式反推内容，两边必须完全相同——这是防止 strm 格式跑偏的回归线。
  const real = listTasks().filter((t) => (t.accountType ?? "115") === "115" && t.strmPrefix);
  for (const task of real) {
    const root = path.resolve(import.meta.dirname, "../../../../../data", task.targetPath);
    const sample = fs.existsSync(root) ? findFirstStrm(root) : null;
    if (!sample) continue;

    const onDisk = fs.readFileSync(sample, "utf8");
    const relFile = path.relative(root, sample).replace(/\.strm$/, path.extname(onDisk));
    const m = matchTask({ tasks: [task] } as unknown as LifeContext, `/${task.originPath}/${relFile}`)!;
    const generated = `${task.strmPrefix}/${task.originPath}/${m.relPath}`;
    assert.equal(generated, onDisk);
    console.log(`  ok  生成的 strm 内容与磁盘上已有的逐字节一致（任务 ${task.id}）`);
    pass++;
    return;
  }
  console.log("  --  跳过：本地没有可对照的 strm 样本");
});

console.log(`\n${pass} passed`);
