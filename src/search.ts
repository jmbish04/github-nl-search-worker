import { Database } from './db';
import { hashString, Logger } from './util';
import { mapRepoToRow, runGitHubSearch, GitHubSearchResponse, fetchReadme } from './github';
import { computeStatistics, runJudge } from './judge';
import type { JudgeEnv } from './judge';

export interface SearchRetryPolicy {
  max_attempts?: number;
  min_score?: number;
}

export interface SearchCallbacks {
  onAttemptStart?: (payload: { resultGroup: number; query: string; attemptId: number }) => void | Promise<void>;
  onGitHubBatch?: (payload: { attemptId: number; repos: Array<{ full_name: string; html_url: string; description: string | null }>; count: number }) => void | Promise<void>;
  onJudgeUpdate?: (payload: {
    attemptId: number;
    findings: string;
    stats: { median: number; top5Mean: number };
    recommendations: string[];
    perRepo: Array<{ full_name: string; score: number; note: string }>;
  }) => void | Promise<void>;
  onRefinedSearch?: (payload: { previousQuery: string; newQuery: string }) => void | Promise<void>;
  onAttemptComplete?: (summary: SearchAttemptSummary) => void | Promise<void>;
}

export interface SearchOptions {
  sessionId: string;
  query: string;
  naturalLanguageRequest: string;
  baseKeywords?: boolean;
  maxResults?: number;
  searchWithinSessions?: string[];
  retryPolicy?: SearchRetryPolicy;
  callbacks?: SearchCallbacks;
  logger?: Logger;
}

export interface SearchExecutionContext extends JudgeEnv {
  GITHUB_TOKEN?: string;
  logger: Logger;
}

export interface SearchAttemptSummary {
  attemptId: number;
  resultGroup: number;
  expandedQueries: string[];
  judgeFindings: string;
  recommendations: string[];
  stats: { median: number; top5Mean: number };
  totalRepos: number;
}

export interface SearchLifecycleResult {
  attempts: SearchAttemptSummary[];
}

async function gatherSearchWithin(db: Database, sessionIds: string[]): Promise<string[]> {
  if (!sessionIds.length) return [];
  return db.getRepoIdsForSessions(sessionIds);
}

async function executeSingleSearch(
  ctx: SearchExecutionContext,
  db: Database,
  sessionId: string,
  naturalRequest: string,
  searchQuery: string,
  callbacks: SearchCallbacks | undefined,
  options: {
    baseKeywords: boolean;
    maxResults: number;
    searchWithinRepoIds: string[];
  }
): Promise<{
  attemptId: number;
  resultGroup: number;
  expandedQueries: string[];
  judgeFindings: string;
  recommendations: string[];
  stats: { median: number; top5Mean: number };
  totalRepos: number;
}> {
  const logger = ctx.logger.withContext({ session_id: sessionId, query: searchQuery });
  logger.info('execute_search_started');
  const start = Date.now();

  const searchResponses = await runGitHubSearch({
    query: searchQuery,
    baseKeywords: options.baseKeywords,
    maxResults: options.maxResults,
    token: ctx.GITHUB_TOKEN,
    searchWithinRepos: options.searchWithinRepoIds,
  });

  const expandedQueries = searchResponses.map((s) => s.query);
  const queryHash = await hashString(JSON.stringify(expandedQueries));

  const resultGroup = await db.nextResultGroup(sessionId);
  const attempt = await db.createSearchAttempt({
    sessionId,
    resultGroup,
    searchQuery: JSON.stringify(expandedQueries),
    queryHash,
    judgeModel: ctx.JUDGE_MODEL ?? 'gpt-4o-mini',
    judgeModelVersion: '2024-05-01',
    searchStrategyVersion: 'workers-v1',
  });

  const repos = searchResponses.flatMap((response) => response.items);
  callbacks?.onAttemptStart?.({ resultGroup, query: searchQuery, attemptId: attempt.id });

  const repoFullNames = repos.map((repo) => repo.full_name);
  const etags = await db.getRepoEtags(repoFullNames);

  const readmeResults = await Promise.all(
    repos.map(async (repo) => {
      const etag = etags.get(repo.full_name);
      const readme = await fetchReadme(repo.full_name, ctx.GITHUB_TOKEN, etag);
      return { repo, readme };
    })
  );

  const reposWithReadmes = await Promise.all(
    readmeResults.map(async ({ repo, readme }) => {
      let content = readme.content;
      if (content === null && readme.etag !== null) {
        const cachedReadme = await db.getReadmeContent(repo.node_id);
        if (cachedReadme) {
          content = cachedReadme;
        }
      }
      return {
        repo: { ...repo, etag: readme.etag },
        readme: content,
      };
    })
  );

  const filteredRepos = reposWithReadmes.filter((entry) => entry.readme !== null);

  await callbacks?.onGitHubBatch?.({
    attemptId: attempt.id,
    count: filteredRepos.length,
    repos: filteredRepos.map((entry) => ({
      full_name: entry.repo.full_name,
      html_url: entry.repo.html_url,
      description: entry.repo.description,
    })),
  });

  await db.insertRepos(filteredRepos.map((entry) => mapRepoToRow(entry.repo)));
  await db.insertSearchResults(
    filteredRepos.map((entry, idx) => ({
      session_id: sessionId,
      search_attempt_id: attempt.id,
      repo_id: entry.repo.node_id,
      repo_url: entry.repo.html_url,
      readme_content: entry.readme,
      judge_finding: null,
      judge_relevance_score: null,
      batch_id: idx,
    }))
  );

  const judgePayload = {
    natural_language_request: naturalRequest,
    repos: filteredRepos.slice(0, 20).map((entry) => ({
      full_name: entry.repo.full_name,
      html_url: entry.repo.html_url,
      description: entry.repo.description,
      stars: entry.repo.stargazers_count,
      language: entry.repo.language,
      topics: entry.repo.topics,
      readme_excerpt: entry.readme ? entry.readme.slice(0, 2000) : null,
    })),
  };
  const judge = await runJudge(ctx, judgePayload);
  const stats = computeStatistics(judge.per_repo);
  await callbacks?.onJudgeUpdate?.({
    attemptId: attempt.id,
    findings: judge.overall_findings,
    stats,
    recommendations: judge.recommendations,
    perRepo: judge.per_repo,
  });

  await db.upsertJudgeReview({
    sessionId,
    searchAttemptId: attempt.id,
    overallFindings: judge.overall_findings,
    recommendations: judge.recommendations,
  });

  const fullNameToNode = new Map(repos.map((entry) => [entry.full_name, entry.node_id]));
  const judgeScores = judge.per_repo
    .map((item) => ({
      repo_id: fullNameToNode.get(item.full_name) ?? item.full_name,
      score: item.score,
      note: item.note,
    }))
    .filter((item): item is { repo_id: string; score: number; note: string } => Boolean(item.repo_id));
  await db.updateResultScores(attempt.id, judgeScores);

  const latency = Date.now() - start;
  logger.info('execute_search_finished', {
    latency,
    total_repos: repos.length,
    median_score: stats.median,
  });

  return {
    attemptId: attempt.id,
    resultGroup: attempt.result_group,
    expandedQueries,
    judgeFindings: judge.overall_findings,
    recommendations: judge.recommendations,
    stats,
    totalRepos: repos.length,
  };
}

export async function runSearchLifecycle(
  ctx: SearchExecutionContext,
  db: Database,
  options: SearchOptions
): Promise<SearchLifecycleResult> {
  const logger = options.logger ?? new Logger();
  const baseKeywords = options.baseKeywords ?? true;
  const maxResults = options.maxResults ?? 30;
  const retryPolicy = options.retryPolicy ?? { max_attempts: 3, min_score: 0.65 };
  const searchWithin = await gatherSearchWithin(db, options.searchWithinSessions ?? []);

  const attempts: SearchAttemptSummary[] = [];
  let currentQuery = options.query;
  for (let attemptIndex = 0; attemptIndex < (retryPolicy.max_attempts ?? 1); attemptIndex++) {
    const summary = await executeSingleSearch(
      { ...ctx, logger },
      db,
      options.sessionId,
      options.naturalLanguageRequest,
      currentQuery,
      options.callbacks,
      {
        baseKeywords,
        maxResults,
        searchWithinRepoIds: searchWithin,
      }
    );
    attempts.push(summary);
    await options.callbacks?.onAttemptComplete?.(summary);
    if (summary.stats.median >= (retryPolicy.min_score ?? 0.65) || summary.stats.top5Mean >= 0.75) {
      break;
    }
    if (!summary.recommendations.length) {
      break;
    }
    const previousQuery = currentQuery;
    currentQuery = summary.recommendations[0];
    options.callbacks?.onRefinedSearch?.({ previousQuery, newQuery: currentQuery });
    logger.info('refined_search', {
      session_id: options.sessionId,
      previous_query: previousQuery,
      new_query: summary.recommendations[0],
      reason: 'low_score',
      median_score: summary.stats.median,
      top5_mean_score: summary.stats.top5Mean,
    });
  }

  return { attempts };
}
