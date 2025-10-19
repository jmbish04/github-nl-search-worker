import { chunkArray, dedupeBy } from './util';

export interface SessionRow {
  session_id: string;
  created_at: string;
  natural_language_request: string;
  deleted_at: string | null;
}

export interface RepoRow {
  id: string;
  full_name: string;
  html_url: string;
  description: string | null;
  stars: number | null;
  language: string | null;
  topics: string | null;
  updated_at: string | null;
  etag: string | null;
}

export interface SearchAttemptRow {
  id: number;
  session_id: string;
  timestamp: string;
  result_group: number;
  search_query: string;
  query_hash: string | null;
  judge_model: string | null;
  judge_model_version: string | null;
  search_strategy_version: string | null;
}

export interface JudgeReviewRow {
  id: number;
  session_id: string;
  search_attempt_id: number;
  overall_judge_findings: string;
  judge_recommendations: string;
  created_at: string;
}

export interface SearchResultRow {
  id: number;
  session_id: string;
  search_attempt_id: number;
  repo_id: string;
  repo_url: string;
  readme_content: string | null;
  judge_finding: string | null;
  judge_relevance_score: number | null;
  batch_id: number | null;
  inserted_at: string;
}

export interface ScaffoldRow {
  id: number;
  scaffold_id: string;
  created_at: string;
  session_id: string;
  attempt_id: number | null;
  title: string;
  user_prompt: string;
  selected_repo_ids: string;
  mcp_doc_queries: string;
  mcp_doc_evidence: string | null;
  artifact_key: string;
  cf_bindings: string | null;
  status: string;
}

export class Database {
  constructor(private readonly db: D1Database) {}

  async createSession(sessionId: string, naturalLanguageRequest: string): Promise<SessionRow> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO sessions (session_id, natural_language_request)
         VALUES (?1, ?2)`
      )
      .bind(sessionId, naturalLanguageRequest)
      .run();

    const row = await this.db
      .prepare(
        `SELECT session_id, created_at, natural_language_request, deleted_at
         FROM sessions
         WHERE session_id = ?1`
      )
      .bind(sessionId)
      .first<SessionRow>();

    if (!row) {
      throw new Error('failed_to_create_session');
    }
    return row;
  }

  async listSessions(limit = 20, cursor?: string | null): Promise<{ items: SessionRow[]; nextCursor: string | null }> {
    const params: unknown[] = [limit];
    let cursorClause = '';
    if (cursor) {
      params.push(cursor);
      cursorClause = 'AND created_at < ?2';
    }
    const query = `SELECT session_id, created_at, natural_language_request, deleted_at
      FROM sessions
      WHERE deleted_at IS NULL
      ${cursorClause}
      ORDER BY created_at DESC
      LIMIT ?1`;
    const rows = await this.db.prepare(query).bind(...params).all<SessionRow>();
    const items = rows.results;
    const nextCursor = items.length === limit ? items[items.length - 1].created_at : null;
    return { items, nextCursor };
  }

  async getSession(sessionId: string): Promise<SessionRow | null> {
    return this.db
      .prepare(
        `SELECT session_id, created_at, natural_language_request, deleted_at
         FROM sessions
         WHERE session_id = ?1`
      )
      .bind(sessionId)
      .first<SessionRow>();
  }

  async getLatestAttemptSummary(sessionId: string): Promise<(SearchAttemptRow & { judge_summary: string | null; recommendations: string[] }) | null> {
    const row = await this.db
      .prepare(
        `SELECT a.id, a.session_id, a.timestamp, a.result_group, a.search_query,
                a.query_hash, a.judge_model, a.judge_model_version, a.search_strategy_version,
                jr.overall_judge_findings, jr.judge_recommendations
         FROM search_attempts a
         LEFT JOIN judge_reviews jr ON jr.search_attempt_id = a.id
         WHERE a.session_id = ?1
         ORDER BY a.timestamp DESC
         LIMIT 1`
      )
      .bind(sessionId)
      .first<
        SearchAttemptRow & {
          overall_judge_findings: string | null;
          judge_recommendations: string | null;
        }
      >();
    if (!row) {
      return null;
    }
    return {
      ...row,
      judge_summary: row.overall_judge_findings,
      recommendations: row.judge_recommendations ? JSON.parse(row.judge_recommendations) : [],
    };
  }

  async nextResultGroup(sessionId: string): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COALESCE(MAX(result_group), 0) + 1 AS next_group FROM search_attempts WHERE session_id = ?1`)
      .bind(sessionId)
      .first<{ next_group: number }>();
    return row?.next_group ?? 1;
  }

  async createSearchAttempt({
    sessionId,
    resultGroup,
    searchQuery,
    queryHash,
    judgeModel,
    judgeModelVersion,
    searchStrategyVersion,
  }: {
    sessionId: string;
    resultGroup: number;
    searchQuery: string;
    queryHash?: string | null;
    judgeModel?: string | null;
    judgeModelVersion?: string | null;
    searchStrategyVersion?: string | null;
  }): Promise<SearchAttemptRow> {
    await this.db
      .prepare(
        `INSERT INTO search_attempts (session_id, result_group, search_query, query_hash, judge_model, judge_model_version, search_strategy_version)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
      )
      .bind(sessionId, resultGroup, searchQuery, queryHash ?? null, judgeModel ?? null, judgeModelVersion ?? null, searchStrategyVersion ?? null)
      .run();

    const row = await this.db
      .prepare(`SELECT * FROM search_attempts WHERE session_id = ?1 ORDER BY id DESC LIMIT 1`)
      .bind(sessionId)
      .first<SearchAttemptRow>();
    if (!row) {
      throw new Error('failed_to_create_attempt');
    }
    return row;
  }

  async insertRepos(repos: RepoRow[]): Promise<void> {
    for (const repo of repos) {
      await this.db
        .prepare(
          `INSERT OR REPLACE INTO repos (id, full_name, html_url, description, stars, language, topics, updated_at, etag)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
        )
        .bind(
          repo.id,
          repo.full_name,
          repo.html_url,
          repo.description ?? null,
          repo.stars ?? null,
          repo.language ?? null,
          repo.topics ?? null,
          repo.updated_at ?? null,
          repo.etag ?? null
        )
        .run();
    }
  }

  async insertSearchResults(rows: Array<Omit<SearchResultRow, 'id' | 'inserted_at'>>): Promise<void> {
    for (const row of rows) {
      await this.db
        .prepare(
          `INSERT OR IGNORE INTO search_results (session_id, search_attempt_id, repo_id, repo_url, readme_content, judge_finding, judge_relevance_score, batch_id)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
        )
        .bind(
          row.session_id,
          row.search_attempt_id,
          row.repo_id,
          row.repo_url,
          row.readme_content ?? null,
          row.judge_finding ?? null,
          row.judge_relevance_score ?? null,
          row.batch_id ?? null
        )
        .run();
    }
  }

  async upsertJudgeReview(data: {
    sessionId: string;
    searchAttemptId: number;
    overallFindings: string;
    recommendations: string[];
  }): Promise<void> {
    const existing = await this.db
      .prepare(`SELECT id FROM judge_reviews WHERE search_attempt_id = ?1`)
      .bind(data.searchAttemptId)
      .first<{ id: number }>();
    if (existing) {
      await this.db
        .prepare(`UPDATE judge_reviews SET overall_judge_findings = ?2, judge_recommendations = ?3 WHERE id = ?1`)
        .bind(existing.id, data.overallFindings, JSON.stringify(data.recommendations))
        .run();
      return;
    }
    await this.db
      .prepare(
        `INSERT INTO judge_reviews (session_id, search_attempt_id, overall_judge_findings, judge_recommendations)
         VALUES (?1, ?2, ?3, ?4)`
      )
      .bind(data.sessionId, data.searchAttemptId, data.overallFindings, JSON.stringify(data.recommendations))
      .run();
  }

  async updateResultScores(attemptId: number, scores: Array<{ repo_id: string; score: number; note: string }>): Promise<void> {
    for (const batch of chunkArray(scores, 25)) {
      const stmt = this.db.prepare(
        `UPDATE search_results SET judge_relevance_score = ?3, judge_finding = ?4
         WHERE search_attempt_id = ?1 AND repo_id = ?2`
      );
      for (const item of batch) {
        await stmt.bind(attemptId, item.repo_id, item.score, item.note).run();
      }
    }
  }

  async listAttempts(sessionId: string): Promise<
    Array<{
      attempt_id: number;
      result_group: number;
      search_query: string;
      timestamp: string;
      judge_summary: string | null;
      recommendations: string[];
    }>
  > {
    const rows = await this.db
      .prepare(
        `SELECT a.id AS attempt_id, a.result_group, a.search_query, a.timestamp,
                jr.overall_judge_findings AS judge_summary, jr.judge_recommendations
         FROM search_attempts a
         LEFT JOIN judge_reviews jr ON jr.search_attempt_id = a.id
         WHERE a.session_id = ?1
         ORDER BY a.timestamp DESC`
      )
      .bind(sessionId)
      .all<{ attempt_id: number; result_group: number; search_query: string; timestamp: string; judge_summary: string | null; judge_recommendations: string | null }>();

    return rows.results.map((row) => ({
      attempt_id: row.attempt_id,
      result_group: row.result_group,
      search_query: row.search_query,
      timestamp: row.timestamp,
      judge_summary: row.judge_summary,
      recommendations: row.judge_recommendations ? JSON.parse(row.judge_recommendations) : [],
    }));
  }

  async listResults({
    sessionId,
    attemptId,
    minScore,
    query,
    dedupe,
    sort,
    limit,
    cursor,
    excludeRepoIds,
  }: {
    sessionId: string;
    attemptId?: number;
    minScore?: number;
    query?: string;
    dedupe?: boolean;
    sort?: 'score_desc' | 'stars_desc' | 'time_desc';
    limit: number;
    cursor?: string | null;
    excludeRepoIds?: string[];
  }): Promise<{ items: Array<SearchResultRow & { repo: RepoRow | null }>; nextCursor: string | null }> {
    const params: unknown[] = [sessionId];
    let where = 'r.session_id = ?1';
    if (attemptId) {
      params.push(attemptId);
      where += ` AND r.search_attempt_id = ?${params.length}`;
    }
    if (minScore !== undefined) {
      params.push(minScore);
      where += ` AND r.judge_relevance_score >= ?${params.length}`;
    }
    if (query) {
      params.push(`%${query.toLowerCase()}%`);
      where += ` AND (LOWER(repo.full_name) LIKE ?${params.length} OR LOWER(repo.description) LIKE ?${params.length})`;
    }
    if (excludeRepoIds?.length) {
      const placeholders = excludeRepoIds.map(() => '?').join(',');
      params.push(...excludeRepoIds);
      where += ` AND r.repo_id NOT IN (${placeholders})`;
    }

    let orderBy = 'r.inserted_at DESC';
    if (sort === 'score_desc') {
      orderBy = 'r.judge_relevance_score IS NULL, r.judge_relevance_score DESC';
    } else if (sort === 'stars_desc') {
      orderBy = 'repo.stars IS NULL, repo.stars DESC';
    }

    const cursorClause = cursor ? `AND r.id < ?${params.length + 1}` : '';
    if (cursor) {
      params.push(Number(cursor));
    }
    const baseQuery = `SELECT r.*, repo.full_name, repo.html_url, repo.description, repo.stars, repo.language, repo.topics
      FROM search_results r
      LEFT JOIN repos repo ON repo.id = r.repo_id
      WHERE ${where} ${cursorClause}
      ORDER BY ${orderBy}
      LIMIT ${limit}`;
    const rows = await this.db.prepare(baseQuery).bind(...params).all<any>();
    const results = rows.results.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      search_attempt_id: row.search_attempt_id,
      repo_id: row.repo_id,
      repo_url: row.repo_url,
      readme_content: row.readme_content,
      judge_finding: row.judge_finding,
      judge_relevance_score: row.judge_relevance_score,
      batch_id: row.batch_id,
      inserted_at: row.inserted_at,
      repo: row.full_name
        ? {
            id: row.repo_id,
            full_name: row.full_name,
            html_url: row.html_url,
            description: row.description,
            stars: row.stars,
            language: row.language,
            topics: row.topics,
            updated_at: null,
            etag: null,
          }
        : null,
    }));

    if (dedupe) {
      const deduped = dedupeBy(results, (row) => row.repo_id);
      const limited = deduped.slice(0, limit);
      return {
        items: limited,
        nextCursor: limited.length === limit ? String(limited[limited.length - 1].id) : null,
      };
    }

    return {
      items: results,
      nextCursor: results.length === limit ? String(results[results.length - 1].id) : null,
    };
  }

  async createScaffold(data: {
    scaffoldId: string;
    sessionId: string;
    attemptId?: number;
    title: string;
    userPrompt: string;
    selectedRepoIds: string[];
    mcpDocQueries: string[];
    mcpDocEvidence: unknown;
    artifactKey: string;
    cfBindings: unknown;
    status: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO scaffolds (scaffold_id, session_id, attempt_id, title, user_prompt, selected_repo_ids, mcp_doc_queries, mcp_doc_evidence, artifact_key, cf_bindings, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
      )
      .bind(
        data.scaffoldId,
        data.sessionId,
        data.attemptId ?? null,
        data.title,
        data.userPrompt,
        JSON.stringify(data.selectedRepoIds),
        JSON.stringify(data.mcpDocQueries),
        data.mcpDocEvidence ? JSON.stringify(data.mcpDocEvidence) : null,
        data.artifactKey,
        data.cfBindings ? JSON.stringify(data.cfBindings) : null,
        data.status
      )
      .run();
  }

  async listScaffolds({ sessionId, limit, cursor }: { sessionId?: string; limit: number; cursor?: string | null }): Promise<{
    items: ScaffoldRow[];
    nextCursor: string | null;
  }> {
    const params: unknown[] = [];
    let where = '1=1';
    if (sessionId) {
      params.push(sessionId);
      where += ` AND session_id = ?${params.length}`;
    }
    if (cursor) {
      params.push(cursor);
      where += ` AND created_at < ?${params.length}`;
    }
    const rows = await this.db
      .prepare(
        `SELECT * FROM scaffolds WHERE ${where} ORDER BY created_at DESC LIMIT ${limit}`
      )
      .bind(...params)
      .all<ScaffoldRow>();
    return {
      items: rows.results,
      nextCursor: rows.results.length === limit ? rows.results[rows.results.length - 1].created_at : null,
    };
  }

  async getReposByIds(ids: string[]): Promise<RepoRow[]> {
    if (!ids.length) return [];
    const placeholders = ids.map((_, idx) => `?${idx + 1}`).join(',');
    const rows = await this.db
      .prepare(`SELECT * FROM repos WHERE id IN (${placeholders})`)
      .bind(...ids)
      .all<RepoRow>();
    return rows.results;
  }

  async getResultsForSession(sessionId: string, repoIds: string[]): Promise<SearchResultRow[]> {
    if (!repoIds.length) return [];
    const placeholders = repoIds.map((_, idx) => `?${idx + 2}`).join(',');
    const rows = await this.db
      .prepare(`SELECT * FROM search_results WHERE session_id = ?1 AND repo_id IN (${placeholders})`)
      .bind(sessionId, ...repoIds)
      .all<SearchResultRow>();
    return rows.results;
  }

  async getScaffold(scaffoldId: string): Promise<ScaffoldRow | null> {
    return this.db
      .prepare(`SELECT * FROM scaffolds WHERE scaffold_id = ?1`)
      .bind(scaffoldId)
      .first<ScaffoldRow>();
  }

  async countAttempts(sessionId: string): Promise<number> {
    const row = await this.db
      .prepare('SELECT COUNT(*) as count FROM search_attempts WHERE session_id = ?1')
      .bind(sessionId)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  async countResults(sessionId: string): Promise<number> {
    const row = await this.db
      .prepare('SELECT COUNT(*) as count FROM search_results WHERE session_id = ?1')
      .bind(sessionId)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }


  async getRepoIdsForSessions(sessionIds: string[]): Promise<string[]> {
    if (!sessionIds.length) return [];
    const placeholders = sessionIds.map((_, idx) => `?${idx + 1}`).join(',');
    const rows = await this.db
      .prepare(`SELECT DISTINCT repo_id FROM search_results WHERE session_id IN (${placeholders})`)
      .bind(...sessionIds)
      .all<{ repo_id: string }>();
    return rows.results.map((row) => row.repo_id);
  }

  async getRepoEtags(repoFullNames: string[]): Promise<Map<string, string>> {
    if (!repoFullNames.length) return new Map();
    const placeholders = repoFullNames.map((_, idx) => `?${idx + 1}`).join(',');
    const rows = await this.db
      .prepare(`SELECT full_name, etag FROM repos WHERE full_name IN (${placeholders}) AND etag IS NOT NULL`)
      .bind(...repoFullNames)
      .all<{ full_name: string; etag: string }>();
    return new Map(rows.results.map((row) => [row.full_name, row.etag]));
  }
}
