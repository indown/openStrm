/**
 * 路径映射的纯函数测试。
 *
 * 这层出错的表现是"能播但播错文件"或"整库都不 302"，比崩溃更难查，
 * 所以边界情况都钉在这里：
 *   npx tsx src/services/resolve/direct-link.test.ts
 */
import assert from "node:assert/strict";
import type { TaskDefinition } from "@openstrm/shared";
import { accountNameByTask, safeDecode, stripMountPath } from "./direct-link.js";

let pass = 0;
const t = (name: string, fn: () => void) => {
  fn();
  pass++;
  console.log("  ok  " + name);
};

console.log("stripMountPath");
t("剥掉挂载前缀，剩下的就是盘内路径", () => {
  const r = stripMountPath("/mnt/pan/tv/Show/ep1.mkv", ["/mnt/pan"]);
  assert.deepEqual(r, { mount: "/mnt/pan", rest: "/tv/Show/ep1.mkv" });
});

t("互为前缀的挂载点取最长匹配", () => {
  // /mnt/115 排在前面也不能抢走 /mnt/115-4k 的路径
  const r = stripMountPath("/mnt/115-4k/movie.mkv", ["/mnt/115", "/mnt/115-4k"]);
  assert.equal(r?.mount, "/mnt/115-4k");
  assert.equal(r?.rest, "/movie.mkv");
});

t("配置里的尾部斜杠不影响匹配", () => {
  const r = stripMountPath("/mnt/pan/a.mkv", ["/mnt/pan/"]);
  assert.equal(r?.mount, "/mnt/pan");
  assert.equal(r?.rest, "/a.mkv");
});

t("路径正好等于挂载点", () => {
  assert.deepEqual(stripMountPath("/mnt/pan", ["/mnt/pan"]), { mount: "/mnt/pan", rest: "/" });
});

t("不在挂载点下返回 null——本地文件不该被 302", () => {
  assert.equal(stripMountPath("/media/local/movie.mkv", ["/mnt/pan"]), null);
});

t("前缀相同但不是目录边界，不算命中", () => {
  // /mnt/panda 不该被 /mnt/pan 匹配掉
  assert.equal(stripMountPath("/mnt/panda/a.mkv", ["/mnt/pan"]), null);
});

t("挂载点没配时返回 null", () => {
  assert.equal(stripMountPath("/mnt/pan/a.mkv", []), null);
});

console.log("safeDecode");
t("还原 encodeURI 过的中文路径", () => {
  assert.equal(safeDecode("/mnt/pan/%E7%94%B5%E5%BD%B1/a.mkv"), "/mnt/pan/电影/a.mkv");
});

t("解不开的百分号原样返回，不抛异常", () => {
  assert.equal(safeDecode("/mnt/pan/100%/a.mkv"), "/mnt/pan/100%/a.mkv");
});

console.log("accountNameByTask");
const tasks: TaskDefinition[] = [
  { id: "1", account: "主号", originPath: "/tv", targetPath: "/data/tv", strmPrefix: "/mnt/pan" },
  { id: "2", account: "小号", originPath: "movie", targetPath: "/data/movie", strmPrefix: "/mnt/pan" },
  { id: "3", account: "别的盘", originPath: "/tv", targetPath: "/data/x", strmPrefix: "/mnt/other" },
];

t("按 strmPrefix + originPath 反查到账号", () => {
  assert.equal(accountNameByTask("/mnt/pan", "/tv/Show/ep1.mkv", tasks), "主号");
});

t("originPath 没写前导斜杠也能匹配", () => {
  assert.equal(accountNameByTask("/mnt/pan", "/movie/x.mkv", tasks), "小号");
});

t("挂载点不同的任务不会被误选", () => {
  assert.equal(accountNameByTask("/mnt/other", "/tv/a.mkv", tasks), "别的盘");
});

t("originPath 只是名字前缀但不是目录边界，不算命中", () => {
  // /tvshows 不该匹配到 originPath 为 /tv 的任务
  assert.equal(accountNameByTask("/mnt/pan", "/tvshows/a.mkv", tasks), null);
});

t("路径正好是 originPath 本身也算命中", () => {
  assert.equal(accountNameByTask("/mnt/pan", "/tv", tasks), "主号");
});

t("没有匹配的任务返回 null，交给后面的兜底逻辑", () => {
  assert.equal(accountNameByTask("/mnt/pan", "/music/a.flac", tasks), null);
});

t("originPath 为空表示整个挂载点都归这个任务", () => {
  const whole: TaskDefinition[] = [
    { id: "9", account: "整盘", originPath: "", targetPath: "/data", strmPrefix: "/mnt/all" },
  ];
  assert.equal(accountNameByTask("/mnt/all", "/anything/a.mkv", whole), "整盘");
});

console.log(`\n${pass} passed`);
