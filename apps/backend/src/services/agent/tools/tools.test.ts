/**
 * 智能体工具的三道闸：
 *   1. 档位 / 工具集过滤：只读令牌看不到写工具
 *   2. 入参 schema 可移植：Claude、ChatGPT、Codex、Open WebUI、各种开源项目都要能用
 *   3. 工具清单快照：工具名、档位、注解、参数结构就是对外 API，改了必须显式更新快照
 *
 *   CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/agent/tools/tools.test.ts
 *   更新快照：UPDATE_SNAPSHOTS=1 CONFIG_DIR=... DATA_DIR=... pnpm test:file src/services/agent/tools/tools.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { z } from "zod";
import { AGENT_TOOLS, toolsFor } from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = path.join(here, "tools.snapshot.json");

const names = (tools: ReadonlyArray<{ name: string }>) => tools.map((t) => t.name).sort();

test("只读令牌只看到只读工具", () => {
  const tools = toolsFor({ scopes: ["read"], toolsets: ["sync", "transfer"] });
  assert.ok(tools.length > 0);
  for (const t of tools) assert.equal(t.annotations.readOnly, true, `${t.name} 不该给只读令牌`);
  assert.ok(!names(tools).includes("share_save"));
  assert.ok(!names(tools).includes("sync_start"));
});

test("日常档位看到全部 P1 工具", () => {
  assert.deepEqual(names(toolsFor({ scopes: ["read", "run", "write"], toolsets: ["sync", "transfer"] })), names(AGENT_TOOLS));
});

test("工具集只收窄分组工具，基础工具总在", () => {
  const sync = names(toolsFor({ scopes: ["read", "run", "write"], toolsets: ["sync"] }));
  assert.ok(sync.includes("sync_start"));
  assert.ok(!sync.includes("share_save"));
  for (const core of ["overview", "tasks_list", "job_status"]) assert.ok(sync.includes(core), core);
});

test("工具名唯一、只用字母数字下划线、不超过 64 个字符", () => {
  const all = names(AGENT_TOOLS);
  assert.equal(new Set(all).size, all.length);
  for (const n of all) assert.match(n, /^[a-z][a-z0-9_]{0,63}$/);
});

type Json = Record<string, unknown>;

function inputJsonSchema(schema: z.ZodType): Json {
  return z.toJSONSchema(schema, { io: "input" }) as Json;
}

/** 规则见 .claude/plans/agent-access.md「工具 → 设计原则」第 10 条 */
function portabilityProblems(name: string, schema: Json): string[] {
  const problems: string[] = [];
  if (schema.type !== "object") problems.push(`${name}: 根不是 object`);
  for (const k of ["oneOf", "anyOf", "allOf", "$ref", "not"]) if (k in schema) problems.push(`${name}: 根上有 ${k}`);
  const walk = (node: unknown, at: string) => {
    if (!node || typeof node !== "object") return;
    const n = node as Json;
    for (const k of ["oneOf", "anyOf", "allOf", "$ref", "$defs", "default"]) if (k in n) problems.push(`${name}${at}: 有 ${k}`);
    const props = n.properties as Record<string, Json> | undefined;
    if (props) {
      for (const [key, child] of Object.entries(props)) {
        if (!("type" in child)) problems.push(`${name}${at}.${key}: 没写 type`);
        walk(child, `${at}.${key}`);
      }
    }
    if (n.items) walk(n.items, `${at}[]`);
  };
  walk(schema, "");
  const size = Buffer.byteLength(JSON.stringify(schema));
  if (size > 5 * 1024) problems.push(`${name}: schema ${size} 字节，超过 5 KB（Codex 会先删字段描述）`);
  return problems;
}

test("入参 schema 可移植：根是普通对象、没有 union / $ref / default、每个字段有 type、不超过 5 KB", () => {
  const problems = AGENT_TOOLS.flatMap((t) => portabilityProblems(t.name, inputJsonSchema(t.input)));
  assert.deepEqual(problems, []);
});

test("每个工具都有中文描述和四个注解", () => {
  for (const t of AGENT_TOOLS) {
    assert.ok(t.description.length >= 20, `${t.name} 描述太短`);
    for (const k of ["readOnly", "destructive", "idempotent", "openWorld"] as const) {
      assert.equal(typeof t.annotations[k], "boolean", `${t.name}.${k}`);
    }
    // 改网盘的工具描述里要写明先征得同意：有的客户端不读服务端说明
    if (t.scope === "write" || t.scope === "danger") assert.match(t.description, /同意/, `${t.name} 描述里没写先征得同意`);
  }
});

/** 快照只钉结构：去掉描述（改措辞不算破坏兼容） */
function stripDescriptions(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripDescriptions);
  if (!node || typeof node !== "object") return node;
  return Object.fromEntries(
    Object.entries(node as Json)
      .filter(([k]) => k !== "description" && k !== "$schema")
      .map(([k, v]) => [k, stripDescriptions(v)]),
  );
}

test("工具清单快照：名字、档位、工具集、注解、参数结构", () => {
  const current = AGENT_TOOLS.map((t) => ({
    name: t.name,
    scope: t.scope,
    toolset: t.toolset,
    annotations: t.annotations,
    input: stripDescriptions(inputJsonSchema(t.input)),
  }));
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    fs.writeFileSync(SNAPSHOT, `${JSON.stringify(current, null, 2)}\n`);
    return;
  }
  // 快照丢了不能当通过：CI 上一份新检出的代码会把改坏的工具清单直接写成新快照
  assert.ok(fs.existsSync(SNAPSHOT), "没有工具清单快照：确认工具清单没问题后用 UPDATE_SNAPSHOTS=1 生成，并提交进仓库");
  const saved = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")) as unknown;
  assert.deepEqual(
    current,
    saved,
    "工具清单变了。自建工作流会把工具名和参数写死：只加不改。确认是有意的改动，再用 UPDATE_SNAPSHOTS=1 更新快照",
  );
});
