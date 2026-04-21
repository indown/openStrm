import fp from "fastify-plugin";
import type { AppSettings, AccountInfo, TaskDefinition } from "@openstrm/shared";

import { CONFIG_DIR } from "../paths.js";
import { readAuthConfig } from "../db/repositories/auth.js";
import { listAccounts, writeAccounts } from "../db/repositories/accounts.js";
import { listTasks, writeTasks } from "../db/repositories/tasks.js";
import { readAppSettings, writeAppSettings } from "../db/repositories/settings.js";

export const configPlugin = fp(
  async (fastify) => {
    fastify.decorate("configDir", CONFIG_DIR);

    fastify.decorate("readConfig", () => readAuthConfig());

    fastify.decorate("readAccounts", () => listAccounts());
    fastify.decorate("writeAccounts", (data: AccountInfo[]) => writeAccounts(data));

    fastify.decorate("readTasks", () => listTasks());
    fastify.decorate("writeTasks", (data: TaskDefinition[]) => writeTasks(data));

    fastify.decorate("readSettings", () => readAppSettings());
    fastify.decorate("writeSettings", (data: AppSettings) => writeAppSettings(data));
  },
  { name: "config" },
);

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
