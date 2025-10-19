import { Database } from './db';
import { runSearchLifecycle, SearchCallbacks } from './search';
import { coalesceEvents, errorResponse, verifySessionToken } from './util';
import type { ApiEnv } from './routes';

export interface WsEnv extends ApiEnv {
  SESSION_TOKEN_SECRET?: string;
}

export async function handleSessionWebSocket(request: Request, env: WsEnv): Promise<Response> {
  const url = new URL(request.url);
  const sessionId = url.pathname.split('/').pop() ?? '';
  const token = url.searchParams.get('token');
  if (env.SESSION_TOKEN_SECRET) {
    if (!token) {
      return errorResponse('unauthorized', 'Missing websocket token', 401);
    }
    const verification = await verifySessionToken(env.SESSION_TOKEN_SECRET, token);
    if (!verification || verification.sessionId !== sessionId) {
      return errorResponse('unauthorized', 'Invalid websocket token', 401);
    }
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  const db = new Database(env.DB);

  server.accept();

  const send = (data: unknown) => {
    try {
      server.send(JSON.stringify(data));
    } catch (err) {
      console.error('ws_send_error', err);
    }
  };

  const { emit: emitGitHubBatch, flush: flushGitHubBatch } = coalesceEvents(
    (batch) => {
      const first = batch[0];
      const totalCount = batch.reduce((sum, item) => sum + item.count, 0);
      const allRepos = batch.flatMap((item) => item.repos);
      send({ type: 'github_batch', attempt_id: first.attemptId, count: totalCount, repos: allRepos });
    },
    { intervalMs: 300, maxBatch: 20 }
  );

  const { emit: emitJudgeUpdate, flush: flushJudgeUpdate } = coalesceEvents(
    (batch) => {
      const latest = batch[batch.length - 1];
      send({
        type: 'judge_update',
        attempt_id: latest.attemptId,
        stage: 'initial',
        score_summary: latest.stats,
        findings: latest.findings,
        recommendations: latest.recommendations,
      });
    },
    { intervalMs: 300, maxBatch: 1 }
  );

  server.addEventListener('message', async (event) => {
    try {
      const message = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data));
      if (message.type === 'start_search') {
        const session = await db.getSession(sessionId);
        if (!session) {
          send({ type: 'error', code: 'not_found', message: 'Session not found' });
          return;
        }
        const callbacks: SearchCallbacks = {
          onAttemptStart: ({ attemptId, resultGroup, query }) => {
            send({ type: 'attempt_started', attempt_id: attemptId, result_group: resultGroup, search_query: query });
          },
          onGitHubBatch: (payload) => {
            emitGitHubBatch(payload);
          },
          onJudgeUpdate: (payload) => {
            emitJudgeUpdate(payload);
          },
          onRefinedSearch: ({ previousQuery, newQuery }) => {
            send({ type: 'refined_search', previous_query: previousQuery, new_query: newQuery });
          },
          onAttemptComplete: async (summary) => {
            await flushGitHubBatch();
            await flushJudgeUpdate();

            send({
              type: 'finalized',
              attempt_id: summary.attemptId,
              result_group: summary.resultGroup,
              total: summary.totalRepos,
              deduped_total: summary.totalRepos,
              threshold: summary.stats.median,
              elapsed_ms: 0,
            });
          },
        };
        await runSearchLifecycle(env, db, {
          sessionId,
          query: message.query,
          naturalLanguageRequest: session.natural_language_request,
          baseKeywords: message.base_keywords,
          maxResults: message.max_results,
          callbacks,
        });
      } else if (message.type === 'cancel_attempt') {
        send({ type: 'ack', attempt_id: message.attempt_id });
      }
    } catch (err) {
      console.error('ws_message_error', err);
      send({ type: 'error', message: 'Internal error' });
    }
  });

  server.addEventListener('close', () => {
    console.log('websocket_closed', sessionId);
  });

  return new Response(null, { status: 101, webSocket: client });
}
