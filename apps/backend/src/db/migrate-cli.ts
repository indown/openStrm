/**
 * 手动跑一次迁移。
 *
 * 平时迁移由 API 进程启动时执行（src/index.ts 的 initDb），但有两种场合需要单独跑：
 * - 测试：多数用例直接读表，库没建好会以 "no such table" 失败
 * - 运维：想在起服务之前先把 schema 升上去
 *
 *   CONFIG_DIR=... DATA_DIR=... npx tsx src/db/migrate-cli.ts
 */
import { initDb } from "./migrate.js";
import { sqlite } from "./client.js";

await initDb();
sqlite.close();
