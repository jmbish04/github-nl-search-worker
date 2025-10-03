import { Database } from './db';
import { runSearchLifecycle } from './search';
import { queryCloudflareDocs } from './mcp_cloudflare_docs_client';
import type { ApiEnv } from './routes';
import { errorResponse, jsonResponse } from './util';

export async function handleMcpRequest(request: Request, env: ApiEnv): Promise<Response> {
  if (request.method !== 'POST') {
    return errorResponse('method_not_allowed', 'MCP endpoint expects POST', 405);
  }
  const payload = (await request.json()) as any;
  const tool = payload.tool as string;
  const params = payload.params ?? {};
  const db = new Database(env.DB);

  switch (tool) {
    case 'run_search': {
      const sessionId = params.session_id as string;
      const session = await db.getSession(sessionId);
      if (!session) {
        return errorResponse('not_found', 'Session not found', 404);
      }
      const lifecycle = await runSearchLifecycle(env, db, {
        sessionId,
        query: params.query ?? session.natural_language_request,
        naturalLanguageRequest: session.natural_language_request,
        baseKeywords: params.base_keywords ?? true,
        maxResults: params.max_results ?? 30,
        searchWithinSessions: params.search_within_sessions ?? [],
        retryPolicy: params.retry_policy,
      });
      return jsonResponse(lifecycle);
    }
    case 'list_sessions': {
      const limit = params.limit ?? 20;
      const cursor = params.cursor ?? null;
      const result = await db.listSessions(limit, cursor);
      return jsonResponse(result);
    }
    case 'list_attempts': {
      const sessionId = params.session_id as string;
      const result = await db.listAttempts(sessionId);
      return jsonResponse(result);
    }
    case 'list_results': {
      const sessionId = params.session_id as string;
      const session = await db.getSession(sessionId);
      if (!session) {
        return errorResponse('not_found', 'Session not found', 404);
      }
      const result = await db.listResults({
        sessionId,
        attemptId: params.attempt_id ?? undefined,
        minScore: params.min_score ?? undefined,
        query: params.q ?? undefined,
        dedupe: params.dedupe !== false,
        sort: params.sort ?? undefined,
        limit: params.limit ?? 20,
        cursor: params.cursor ?? undefined,
      });
      return jsonResponse(result);
    }
    case 'get_openapi_spec': {
      const res = await env.ASSETS.fetch(new Request('https://worker.local/openapi.json'));
      const json = await res.json();
      return jsonResponse(json);
    }
    case 'cloudflare_docs_query': {
      const query = params.query as string;
      const topK = params.topK ?? 8;
      const result = await queryCloudflareDocs(env, query, topK);
      return jsonResponse(result);
    }
    default:
      return errorResponse('unknown_tool', `Tool ${tool} is not supported`, 400);
  }
}
