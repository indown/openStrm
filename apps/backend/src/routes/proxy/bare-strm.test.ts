import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskDefinition } from "@openstrm/shared";
import { matchBareStrmRequest } from "./bare-strm-match.js";

const task: TaskDefinition = {
  id: "task-main",
  account: "main",
  accountType: "115",
  originPath: "library",
  targetPath: "strm/library",
  strmPrefix: "http://media.example:8098/main",
  enable302: true,
};

test("matches a direct request made from a configured HTTP STRM prefix", () => {
  const match = matchBareStrmRequest(
    "/main/library/movie.mkv",
    "media.example:8098",
    [task],
  );

  assert.equal(match?.task.id, "task-main");
  assert.equal(match?.embyPath, "http://media.example:8098/main/library/movie.mkv");
});

test("does not match another host, a path outside the task origin, or a disabled task", () => {
  assert.equal(
    matchBareStrmRequest("/main/library/movie.mkv", "other.example:8098", [task]),
    null,
  );
  assert.equal(
    matchBareStrmRequest("/main/private/movie.mkv", "media.example:8098", [task]),
    null,
  );
  assert.equal(
    matchBareStrmRequest(
      "/main/library/movie.mkv",
      "media.example:8098",
      [{ ...task, enable302: false }],
    ),
    null,
  );
});

test("prefers the most specific origin path when tasks share a prefix", () => {
  const child = { ...task, id: "task-child", originPath: "library/anime" };
  const match = matchBareStrmRequest(
    "/main/library/anime/episode.mkv",
    "media.example:8098",
    [task, child],
  );

  assert.equal(match?.task.id, "task-child");
});

test("matches a prefix whose URL has no path component", () => {
  const rootPrefixTask = { ...task, id: "task-root", strmPrefix: "http://media.example:8098" };
  const match = matchBareStrmRequest(
    "/library/movie.mkv",
    "media.example:8098",
    [rootPrefixTask],
  );

  assert.equal(match?.task.id, "task-root");
  assert.equal(match?.embyPath, "http://media.example:8098/library/movie.mkv");
});
