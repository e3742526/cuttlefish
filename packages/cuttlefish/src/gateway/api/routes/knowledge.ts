import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { listExternalOutboxItems } from "../../../sessions/registry.js";
import type { ApiContext } from "../context.js";
import { readJsonBody } from "../../http-helpers.js";
import { badRequest, json } from "../responses.js";

export async function handleKnowledgeRoutes(
  method: string,
  pathname: string,
  req: HttpRequest,
  url: URL,
  res: ServerResponse,
  context: ApiContext,
): Promise<boolean> {
  if (method === "GET" && pathname === "/api/knowledge/outbox") {
    const statusParam = url.searchParams.get("status");
    const limitParam = Number.parseInt(url.searchParams.get("limit") || "100", 10);
    const status = statusParam === "pending" || statusParam === "delivered" ? statusParam : undefined;
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 100;
    json(res, listExternalOutboxItems({ status, limit }));
    return true;
  }

  if (method === "POST" && pathname === "/api/knowledge/outbox/flush") {
    const result = await context.relayKnowledgeOutbox?.() ?? { attempted: 0, delivered: 0, failed: 0 };
    json(res, result);
    return true;
  }

  if (method === "POST" && pathname === "/api/knowledge/search") {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
      badRequest(res, "Invalid JSON body");
      return true;
    }
    const body = parsed.body as Record<string, unknown>;
    if (typeof body.query !== "string" || !body.query.trim()) {
      badRequest(res, "query is required");
      return true;
    }
    const response = await context.knowledgeReadProvider?.search({
      query: body.query.trim(),
      limit: typeof body.limit === "number" ? body.limit : undefined,
      workspace: typeof body.workspace === "string" ? body.workspace : null,
    }) ?? { results: [] };
    json(res, response);
    return true;
  }

  if (method === "POST" && pathname === "/api/knowledge/context") {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
      badRequest(res, "Invalid JSON body");
      return true;
    }
    const body = parsed.body as Record<string, unknown>;
    const response = await context.knowledgeReadProvider?.context({
      sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
      query: typeof body.query === "string" ? body.query : undefined,
      limit: typeof body.limit === "number" ? body.limit : undefined,
      workspace: typeof body.workspace === "string" ? body.workspace : null,
    }) ?? { items: [] };
    json(res, response);
    return true;
  }

  return false;
}
