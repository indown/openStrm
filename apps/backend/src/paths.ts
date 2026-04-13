import path from "node:path";

// Resolve project root from this file's location: apps/backend/src/paths.ts → 3 levels up
const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(new URL(".", import.meta.url).pathname, "../../../");

export const CONFIG_DIR = process.env.CONFIG_DIR || path.join(PROJECT_ROOT, "config");
export const DATA_DIR = process.env.DATA_DIR || path.join(PROJECT_ROOT, "data");
export const LOGS_DIR = process.env.LOGS_DIR || path.join(PROJECT_ROOT, "logs");
