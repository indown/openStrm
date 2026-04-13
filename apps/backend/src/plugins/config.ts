import fp from "fastify-plugin";
import fs from "node:fs";
import path from "node:path";
import type { AppSettings, AccountInfo, TaskDefinition } from "@openstrm/shared";

import { CONFIG_DIR } from "../paths.js";

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

export const configPlugin = fp(async (fastify) => {
  const configDir = CONFIG_DIR;

  const filePaths = {
    config: path.join(configDir, "config.json"),
    account: path.join(configDir, "account.json"),
    tasks: path.join(configDir, "tasks.json"),
    settings: path.join(configDir, "settings.json"),
  };

  fastify.decorate("configDir", configDir);

  fastify.decorate("readConfig", () => readJsonFile<Record<string, unknown>>(filePaths.config, {}));
  fastify.decorate("readAccounts", () => readJsonFile<AccountInfo[]>(filePaths.account, []));
  fastify.decorate("writeAccounts", (data: AccountInfo[]) => writeJsonFile(filePaths.account, data));
  fastify.decorate("readTasks", () => readJsonFile<TaskDefinition[]>(filePaths.tasks, []));
  fastify.decorate("writeTasks", (data: TaskDefinition[]) => writeJsonFile(filePaths.tasks, data));
  fastify.decorate("readSettings", () => readJsonFile<AppSettings>(filePaths.settings, {} as AppSettings));
  fastify.decorate("writeSettings", (data: AppSettings) => writeJsonFile(filePaths.settings, data));
}, { name: "config" });

// Type augmentation for Fastify
declare module "fastify" {
  interface FastifyInstance {
    configDir: string;
    readConfig: () => Record<string, unknown>;
    readAccounts: () => AccountInfo[];
    writeAccounts: (data: AccountInfo[]) => void;
    readTasks: () => TaskDefinition[];
    writeTasks: (data: TaskDefinition[]) => void;
    readSettings: () => AppSettings;
    writeSettings: (data: AppSettings) => void;
  }
}
