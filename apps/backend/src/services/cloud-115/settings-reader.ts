import type { AppSettings } from "@openstrm/shared";
import { readAppSettings } from "../../db/repositories/settings.js";

export function readSettings(): AppSettings {
  return readAppSettings();
}
