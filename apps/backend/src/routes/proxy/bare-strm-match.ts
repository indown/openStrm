import type { TaskDefinition } from "@openstrm/shared";
import { safeDecode } from "../../services/strm/naming.js";

export interface BareStrmMatch {
  task: TaskDefinition;
  /** Reconstructed URL in the same shape as the URL stored in the .strm file. */
  embyPath: string;
}

function normalizePath(input: string): string {
  const decoded = safeDecode(input || "/");
  const withLeadingSlash = decoded.startsWith("/") ? decoded : `/${decoded}`;
  const collapsed = withLeadingSlash.replace(/\/{2,}/g, "/");
  if (collapsed === "/") return collapsed;
  return collapsed.replace(/\/+$/, "");
}

function originPathOf(task: TaskDefinition): string {
  return normalizePath(`/${task.originPath ?? ""}`);
}

function parsePrefix(task: TaskDefinition): URL | null {
  if (!task.enable302 || !task.strmPrefix) return null;

  try {
    const prefix = new URL(task.strmPrefix);
    if (prefix.protocol !== "http:" && prefix.protocol !== "https:") return null;
    if (prefix.search || prefix.hash) return null;
    prefix.pathname = normalizePath(prefix.pathname);
    return prefix;
  } catch {
    return null;
  }
}

/**
 * Find the task which owns a direct request for a URL written by OpenStrm.
 *
 * The request only contains a path, while the task stores the full strmPrefix.
 * Reconstructing the full URL here lets the existing resolver reuse its normal
 * task/account matching rules without exposing arbitrary paths below a prefix.
 */
export function matchBareStrmRequest(
  pathname: string,
  host: string | undefined,
  tasks: TaskDefinition[],
): BareStrmMatch | null {
  const requestPath = normalizePath(pathname);
  const requestHost = host?.toLowerCase();
  const matches: Array<{ task: TaskDefinition; embyPath: string; originLength: number; prefixLength: number }> = [];

  for (const task of tasks) {
    const prefix = parsePrefix(task);
    if (!prefix) continue;
    if (requestHost && prefix.host.toLowerCase() !== requestHost) continue;

    const prefixPath = normalizePath(prefix.pathname);
    const prefixMatches =
      prefixPath === "/" || requestPath === prefixPath || requestPath.startsWith(`${prefixPath}/`);
    if (!prefixMatches) continue;

    const rest = prefixPath === "/" ? requestPath : requestPath.slice(prefixPath.length) || "/";
    const origin = originPathOf(task);
    const withinOrigin = origin === "/" || rest === origin || rest.startsWith(`${origin}/`);
    if (!withinOrigin || rest === origin) continue;

    matches.push({
      task,
      embyPath: `${prefix.origin}${requestPath}`,
      originLength: origin.length,
      prefixLength: prefixPath.length,
    });
  }

  matches.sort((a, b) => b.originLength - a.originLength || b.prefixLength - a.prefixLength);
  const best = matches[0];
  return best ? { task: best.task, embyPath: best.embyPath } : null;
}
