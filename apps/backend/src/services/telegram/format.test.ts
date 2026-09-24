/**
 * 截短不劈字符：emoji 这类占两个 UTF-16 单元的，切口落在中间就整个去掉——半个 emoji 发给 Bot API 会整条被拒。
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/telegram/format.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { clamp, cutText, esc, shortName, taskLabel } from "./format.js";

const half = /\p{Cs}/u;

test("cutText：没超上限原样返回；切口落在 emoji 中间时退一个单元，不留半个", () => {
  assert.equal(cutText("abc", 3), "abc");
  assert.equal(cutText("ab😀", 3), "ab");
  assert.equal(cutText("ab😀c", 4), "ab😀");
  assert.equal(cutText("ab😀c", 0), "");
});

test("shortName、clamp：截在 emoji 中间时整个去掉，长度照样不超过上限；放得下的 emoji 留着", () => {
  const cut = shortName(`${"a".repeat(46)}😀tail`);
  assert.equal(cut, `${"a".repeat(46)}…`);
  assert.doesNotMatch(cut, half);
  assert.ok(cut.length <= 48);
  assert.equal(shortName(`${"a".repeat(45)}😀tail`), `${"a".repeat(45)}😀…`);

  const clamped = clamp(`${"b".repeat(3799)}😀${"c".repeat(100)}`);
  assert.equal(clamped, `${"b".repeat(3799)}\n…（已截断）`);
  assert.doesNotMatch(clamped, half);
});

/** Telegram 的 HTML 模式认不认：标签成对、& 都是完整的实体、没有落单的 < > & */
function parses(html: string): boolean {
  const open: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-z][\w-]*)[^>]*>|&(?:amp|lt|gt|quot|#\d+|#x[\da-f]+);|[<>&]/gi)) {
    if (m[2]) {
      if (!m[1]) open.push(m[2]);
      else if (open.pop() !== m[2]) return false;
    } else if (m[0].length === 1) return false;
  }
  return open.length === 0;
}

/** 照 /tasks 的样子拼列表：路径里带 & 和 <>（转义成实体），每个任务一行 <b>、一个 <code> */
function taskList(n: number): string {
  const lines = [`<b>任务（${n}）</b>`];
  for (let i = 1; i <= n; i++) {
    const task = {
      originPath: `/媒体 & 资源/电视剧/<第 ${i} 部> 一个很长很长很长很长很长的剧名 & 特别篇 [4K] {tmdb-${i}}/Season 1`,
      targetPath: `/strm/电视剧 & 动漫/<第 ${i} 部> 一个很长很长很长很长很长的剧名/Season 1`,
    };
    lines.push(`\n<b>${i}. ${esc(taskLabel(task))}</b>\n账户 ${esc("115 & 夸克")} · ⏰ <code>${esc("0 3 * * *")}</code>\n✅ 成功 · 10/10 个文件 · 刚刚`);
  }
  return lines.join("\n");
}

const TAIL = "\n…（已截断）";

test("clamp 按 HTML 截：/tasks 那样的长列表截完标签照样成对、实体完整，补上的闭合也算在上限里", () => {
  const html = taskList(40);
  assert.ok(html.length > 3800 && parses(html));
  const out = clamp(html);
  assert.ok(parses(out), out.slice(-120));
  assert.ok(out.endsWith(TAIL));
  const body = out.slice(0, -TAIL.length);
  assert.ok(body.length <= 3800 && body.length > 3780, String(body.length));
});

test("clamp：每个切口都试一遍，落在 <b>、</b>、<code>、&amp;、&lt;、emoji 中间的都截得干净，不留空标签", () => {
  const sample = `${taskList(2)}\n😀 <i>${esc("A&B <c>")}</i> 尾巴`;
  for (let max = 1; max < sample.length; max++) {
    const out = clamp(sample, max);
    const body = out.slice(0, -TAIL.length);
    assert.ok(parses(out), `max=${max}: ${body.slice(-40)}`);
    assert.doesNotMatch(out, half, `max=${max}`);
    assert.doesNotMatch(body, /<([a-z]+)><\/\1>/, `max=${max}`);
    assert.ok(body.length <= max, `max=${max}`);
  }
});
