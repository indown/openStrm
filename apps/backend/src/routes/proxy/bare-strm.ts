import type { FastifyReply, FastifyRequest } from "fastify";
import { listTasks } from "../../db/repositories/tasks.js";
import { matchBareStrmRequest } from "./bare-strm-match.js";
import { redirectBareStrm } from "./redirect.js";

export { matchBareStrmRequest } from "./bare-strm-match.js";

function requestPath(request: FastifyRequest): string {
  return new URL(request.url, "http://openstrm.local").pathname;
}

/**
 * Handle a direct request to the URL written inside a generated .strm file.
 *
 * Returning false is intentional: the catch-all proxy must keep its original
 * fallback behavior when the request is not one of our configured STRMs or
 * when link resolution fails.
 */
export async function handleBareStrm(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (request.method !== "GET" && request.method !== "HEAD") return false;

  let tasks;
  try {
    tasks = listTasks();
  } catch {
    return false;
  }

  const match = matchBareStrmRequest(requestPath(request), request.headers.host, tasks);
  if (!match) return false;

  return redirectBareStrm(
    request,
    reply,
    match.embyPath,
    `task:${match.task.id}:${match.embyPath}`,
  );
}
