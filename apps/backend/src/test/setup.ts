/**
 * node --test 的前置模块，package.json 的 test 脚本用 --import 挂上。
 * 每个测试文件跑在独立进程里，所以这里的逻辑对每个文件各执行一次。
 *
 * - 没指定 CONFIG_DIR / DATA_DIR 直接拒绝：多数用例会改写 settings / auth 表、
 *   会往 DATA_DIR 里建删目录，跑在开发者真实的库和 strm 目录上会把它们改掉。
 * - 建库跑迁移：用例直接读表，库没建好会以 "no such table" 失败。
 * - 日志默认静音，只看 reporter 的输出。
 */
for (const name of ["CONFIG_DIR", "DATA_DIR"]) {
  if (!process.env[name]) {
    throw new Error(`拒绝在默认 ${name} 上运行测试：请把 CONFIG_DIR / DATA_DIR 指到临时目录`);
  }
}
process.env.LOG_LEVEL ??= "silent";

// 动态导入：LOG_LEVEL 必须在 logger 模块求值之前设好
const { initDb } = await import("../db/migrate.js");
await initDb();

export {};
