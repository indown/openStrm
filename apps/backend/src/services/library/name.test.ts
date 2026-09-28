import assert from "node:assert/strict";
import { test } from "node:test";
import { libraryNameOf, withSuffix } from "./name.js";

const of = (rawName: string, sharePath = "") => libraryNameOf({ rawName, title: "", sharePath });

test("整个分享、普通子目录：就按自己的名字认", () => {
  assert.deepEqual(of("沙丘2"), { query: "沙丘2", suffix: "", tv: false });
  assert.deepEqual(of("怒呛人生 (2023)", "/美剧/怒呛人生 (2023)"), { query: "怒呛人生 (2023)", suffix: "", tv: false });
});

test("季目录往上找作品目录，季名留作后缀，按剧认", () => {
  assert.deepEqual(of("Season 2", "/美剧/怒呛人生 (2023)/Season 2"), { query: "怒呛人生 (2023)", suffix: "Season 2", tv: true });
  assert.deepEqual(of("第二季", "/庆余年/第二季"), { query: "庆余年", suffix: "第二季", tv: true });
  assert.deepEqual(of("S01", "/繁花/S01"), { query: "繁花", suffix: "S01", tv: true });
});

test("版本词、花絮目录也往上找；连着几层都跳过", () => {
  assert.deepEqual(of("导演剪辑版", "/凡人修仙传/导演剪辑版"), { query: "凡人修仙传", suffix: "导演剪辑版", tv: false });
  assert.deepEqual(of("花絮", "/某剧/Season 1/花絮"), { query: "某剧", suffix: "Season 1 花絮", tv: true });
});

test("路径里只有季目录自己：没得往上找，还是用它", () => {
  assert.deepEqual(of("Season 2", "/Season 2"), { query: "Season 2", suffix: "", tv: false });
});

test("没有 rawName 用 title；后缀只在两边都有时才拼", () => {
  assert.equal(libraryNameOf({ rawName: "", title: "三体", sharePath: "" }).query, "三体");
  assert.equal(withSuffix("怒呛人生", "Season 2"), "怒呛人生 · Season 2");
  assert.equal(withSuffix("怒呛人生", ""), "怒呛人生");
  assert.equal(withSuffix("", "Season 2"), "");
});
