import { Hono } from 'hono';
import { z } from 'zod';
import { Database } from './db';
import { errorResponse, jsonResponse, Logger } from './util';
import { rateLimiter } from './ratelimit';
import { runSearchLifecycle } from './search';
import { createScaffold } from './scaffolder';
import type { ScaffolderEnv } from './scaffolder';
import type { SearchExecutionContext } from './search';

export interface ApiEnv extends ScaffolderEnv, SearchExecutionContext {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  ASSETS: Fetcher;
  API_TOKEN?: string;
}

const createSessionSchema = z.object({
  natural_language_request: z.string().min(1),
  session_id: z.string().uuid().optional(),
});

const searchSchema = z.object({
  query: z.string().min(1),
  base_keywords: z.boolean().optional(),
  max_results: z.number().int().min(1).max(100).optional(),
  search_within_sessions: z.array(z.string()).optional(),
  retry_policy: z
    .object({
      max_attempts: z.number().int().min(1).max(5).optional(),
      min_score: z.number().min(0).max(1).optional(),
    })
    .optional(),
});

const scaffoldSchema = z.object({
  session_id: z.string(),
  attempt_id: z.number().optional(),
  selected_repo_ids: z.array(z.string()).min(1),
  user_prompt: z.string().min(1),
  scaffold_title: z.string().min(1),
  bindings: z
    .object({
      d1: z.array(z.object({ name: z.string(), database_name: z.string() })).optional(),
      r2: z.array(z.object({ name: z.string(), bucket: z.string() })).optional(),
      kv: z.array(z.object({ name: z.string() })).optional(),
      queues: z.array(z.object({ name: z.string() })).optional(),
    })
    .default({}),
});

export function createApiRouter() {
  const app = new Hono<{ Bindings: ApiEnv; Variables: { db: Database; logger: Logger } }>();

  app.use('*', async (c, next) => {
    c.set('db', new Database(c.env.DB));
    c.set('logger', new Logger());
    await next();
  });

  app.use('/api/*', async (c, next) => {
    const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? '127.0.0.1';
    const { success, limit, remaining } = rateLimiter(ip);
    c.res.headers.set('X-RateLimit-Limit', limit.toString());
    c.res.headers.set('X-RateLimit-Remaining', remaining.toString());
    if (!success) {
      return errorResponse('rate_limited', 'Too many requests', 429);
    }
    await next();
  });

  app.use('/api/*', async (c, next) => {
    const token = c.env.WORKER_API_KEY;
    if (!token) {
      return next();
    }
    const auth = c.req.header('Authorization');
    if (!auth || !auth.startsWith('Bearer ') || auth.slice(7) !== token) {
      return errorResponse('unauthorized', 'Missing or invalid bearer token', 401);
    }
    await next();
  });

  app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

  app.get('/api/metrics', (c) =>
    c.json({
      timestamp: new Date().toISOString(),
      version: '1.0.0'
    })
  );

  app.post('/api/sessions', async (c) => {
    const logger = c.get('logger');
    const body = await c.req.json();
    const parsed = createSessionSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse('invalid_request', 'Invalid session payload', 400, parsed.error.format());
    }
    const db = c.get('db');
    const sessionId = parsed.data.session_id ?? crypto.randomUUID();
    const session = await db.createSession(sessionId, parsed.data.natural_language_request);
    logger.info('session_created', { session_id: sessionId });
    return jsonResponse(session, { status: 201 });
  });

  app.get('/api/sessions', async (c) => {
    const limit = Number(c.req.query('limit') ?? '20');
    const cursor = c.req.query('cursor');
    const db = c.get('db');
    const result = await db.listSessions(limit, cursor);
    return jsonResponse(result);
  });

  app.get('/api/sessions/:session_id', async (c) => {
    const sessionId = c.req.param('session_id');
    const db = c.get('db');
    const session = await db.getSession(sessionId);
    if (!session) {
      return errorResponse('not_found', 'Session not found', 404);
    }
    const latest = await db.getLatestAttemptSummary(sessionId);
    const attemptsCount = await db.countAttempts(sessionId);
    const resultsCount = await db.countResults(sessionId);
    return jsonResponse({
      session,
      attempts_count: attemptsCount,
      results_count: resultsCount,
      latest_attempt: latest,
    });
  });

  app.post('/api/sessions/:session_id/search', async (c) => {
    const sessionId = c.req.param('session_id');
    const db = c.get('db');
    const session = await db.getSession(sessionId);
    if (!session) {
      return errorResponse('not_found', 'Session not found', 404);
    }
    const url = new URL(c.req.url);
    const wait = url.searchParams.get('wait') === 'true';
    const body = await c.req.json();
    const parsed = searchSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse('invalid_request', 'Invalid search payload', 400, parsed.error.format());
    }

    const logger = c.get('logger').withContext({ session_id: sessionId, query: parsed.data.query });
    logger.info('search_started');

    const start = Date.now();
    const lifecycle = await runSearchLifecycle(c.env, db, {
      sessionId,
      query: parsed.data.query,
      naturalLanguageRequest: session.natural_language_request,
      baseKeywords: parsed.data.base_keywords,
      maxResults: parsed.data.max_results,
      searchWithinSessions: parsed.data.search_within_sessions,
      retryPolicy: parsed.data.retry_policy,
      logger,
    });

    const first = lifecycle.attempts[0];
    const response: any = {
      attempt_id: first?.attemptId,
      result_group: first?.resultGroup,
      expanded_queries: first?.expandedQueries ?? [],
      started_at: new Date().toISOString(),
    };
    if (wait) {
      response.lifecycle = lifecycle;
    }
    const latency = Date.now() - start;
    logger.info('search_finished', { latency, cost: lifecycle.totalCost, attempts: lifecycle.attempts.length });
    return jsonResponse(response, { status: 202 });
  });

  app.get('/api/sessions/:session_id/attempts', async (c) => {
    const sessionId = c.req.param('session_id');
    const db = c.get('db');
    const session = await db.getSession(sessionId);
    if (!session) {
      return errorResponse('not_found', 'Session not found', 404);
    }
    const attempts = await db.listAttempts(sessionId);
    return jsonResponse({ attempts });
  });

  app.get('/api/sessions/:session_id/results', async (c) => {
    const sessionId = c.req.param('session_id');
    const db = c.get('db');
    const session = await db.getSession(sessionId);
    if (!session) {
      return errorResponse('not_found', 'Session not found', 404);
    }
    const attemptId = c.req.query('attempt_id');
    const minScore = c.req.query('min_score');
    const query = c.req.query('q');
    const dedupe = c.req.query('dedupe') !== 'false';
    const sortParam = c.req.query('sort');
    const limit = Number(c.req.query('limit') ?? '20');
    const cursor = c.req.query('cursor');
    const excludePreviousAttempts = c.req.query('exclude_previous_attempts') === 'true';

    let excludeRepoIds: string[] | undefined;
    if (excludePreviousAttempts && attemptId) {
      const previousAttempts = await db.listAttempts(sessionId);
      const previousRepoIds = new Set<string>();
      for (const attempt of previousAttempts) {
        if (attempt.attempt_id < Number(attemptId)) {
          const results = await db.listResults({ sessionId, attemptId: attempt.attempt_id, limit: 1000 });
          for (const result of results.items) {
            previousRepoIds.add(result.repo_id);
          }
        }
      }
      excludeRepoIds = Array.from(previousRepoIds);
    }

    const result = await db.listResults({
      sessionId,
      attemptId: attemptId ? Number(attemptId) : undefined,
      minScore: minScore ? Number(minScore) : undefined,
      query: query ?? undefined,
      dedupe,
      sort: sortParam as any,
      limit,
      cursor,
      excludeRepoIds,
    });
    return jsonResponse(result);
  });

  app.post('/api/scaffolds', async (c) => {
    const body = await c.req.json();
    const parsed = scaffoldSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse('invalid_request', 'Invalid scaffold payload', 400, parsed.error.format());
    }
    const db = c.get('db');
    const session = await db.getSession(parsed.data.session_id);
    if (!session) {
      return errorResponse('not_found', 'Session not found', 404);
    }
    const logger = c.get('logger').withContext({ session_id: parsed.data.session_id });
    logger.info('scaffold_started');
    const start = Date.now();
    const result = await createScaffold(c.env, db, {
      sessionId: parsed.data.session_id,
      attemptId: parsed.data.attempt_id,
      selectedRepoIds: parsed.data.selected_repo_ids,
      userPrompt: parsed.data.user_prompt,
      scaffoldTitle: parsed.data.scaffold_title,
      bindings: parsed.data.bindings,
    });
    const latency = Date.now() - start;
    logger.info('scaffold_finished', { latency, scaffold_id: result.scaffold_id });
    return jsonResponse(result, { status: 201 });
  });

  app.get('/api/scaffolds', async (c) => {
    const db = c.get('db');
    const sessionId = c.req.query('session_id');
    const limit = Number(c.req.query('limit') ?? '20');
    const cursor = c.req.query('cursor');
    const result = await db.listScaffolds({ sessionId: sessionId ?? undefined, limit, cursor });
    return jsonResponse(result);
  });

  app.get('/api/scaffolds/:scaffold_id', async (c) => {
    const db = c.get('db');
    const scaffold = await db.getScaffold(c.req.param('scaffold_id'));
    if (!scaffold) {
      return errorResponse('not_found', 'Scaffold not found', 404);
    }
    return jsonResponse(scaffold);
  });

  app.get('/api/scaffolds/:scaffold_id/download', async (c) => {
    const db = c.get('db');
    const scaffold = await db.getScaffold(c.req.param('scaffold_id'));
    if (!scaffold) {
      return errorResponse('not_found', 'Scaffold not found', 404);
    }
    const artifactKey = scaffold.artifact_key;
    let downloadUrl = `https://artifacts.example.com/${artifactKey}`;
    if ('createPresignedUrl' in c.env.ARTIFACTS) {
      try {
        // @ts-ignore - Workers runtime provides this helper
        const signed = await c.env.ARTIFACTS.createPresignedUrl({ method: 'GET', key: artifactKey, expiration: 3600 });
        if (signed) {
          downloadUrl = signed;
        }
      } catch (err) {
        console.error('failed_to_create_presigned_url', err);
      }
    }
    const curl = `curl -L "${downloadUrl}" -o ${scaffold.title}.zip`;
    return jsonResponse({ download_url: downloadUrl, curl });
  });

  return app;
}
