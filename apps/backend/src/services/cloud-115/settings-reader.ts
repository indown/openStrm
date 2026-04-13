import fs from "node:fs";
import path from "node:path";
import type { AppSettings } from "@openstrm/shared";

const CONFIG_DIR = process.env.CONFIG_DIR || path.resolve(process.cwd(), "config");
const settingsFile = path.join(CONFIG_DIR, "settings.json");

export function readSettings(): AppSettings {
  try {
    if (!fs.existsSync(settingsFile)) return {} as AppSettings;
    return JSON.parse(fs.readFileSync(settingsFile, "utf-8") || "{}");
  } catch {
    return {} as AppSettings;
  }
}
