import { Database } from './db';
import { hashString } from './util';
import { mapRepoToRow, runGitHubSearch, GitHubSearchResponse } from './github';
import { computeStatistics, runJudge } from './judge';
import type { JudgeEnv } from './judge';

export interface SearchRetryPolicy {
  max_attempts?: number;
  min_score?: number;
}

export interface SearchCallbacks {
  onAttemptStart?: (payload: { resultGroup: number; query: string; attemptId: number }) => void | Promise<void>;
  onGitHubBatch?: (payload: { attemptId: number; repos: Array<{ full_name: string; html_url: string; description: string | null }>; count: number }) => void | Promise<void>;
  onJudgeUpdate?: (payload: { attemptId: number; findings: string; stats: { median: number; top5Mean: number }; recommendations: string[] }) => void | Promise<void>;
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
}

export interface SearchExecutionContext extends JudgeEnv {
  GITHUB_TOKEN?: string;
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

  const repoMap = new Map<string, { response: GitHubSearchResponse; index: number; readme: string | null; url: string }>();
  let repoIndex = 0;
  for (const response of searchResponses) {
    for (const item of response.items) {
      if (!repoMap.has(item.repo.node_id)) {
        repoMap.set(item.repo.node_id, {
          response,
          index: repoIndex++,
          readme: item.readme,
          url: item.repo.html_url,
        });
      }
    }
  }

  const repos = Array.from(repoMap.entries()).map(([id, value]) => ({
    id,
    repo: value.response.items.find((item) => item.repo.node_id === id)!.repo,
    readme: value.readme,
  }));

  callbacks?.onAttemptStart?.({ resultGroup, query: searchQuery, attemptId: attempt.id });

  await callbacks?.onGitHubBatch?.({
    attemptId: attempt.id,
    count: repos.length,
    repos: repos.map((entry) => ({ full_name: entry.repo.full_name, html_url: entry.repo.html_url, description: entry.repo.description })),
  });

  await db.insertRepos(repos.map((entry) => mapRepoToRow(entry.repo)));
  await db.insertSearchResults(
    repos.map((entry, idx) => ({
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
    repos: repos.slice(0, 20).map((entry) => ({
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
  await callbacks?.onJudgeUpdate?.({ attemptId: attempt.id, findings: judge.overall_findings, stats, recommendations: judge.recommendations });

  await db.upsertJudgeReview({
    sessionId,
    searchAttemptId: attempt.id,
    overallFindings: judge.overall_findings,
    recommendations: judge.recommendations,
  });

  const fullNameToNode = new Map(repos.map((entry) => [entry.repo.full_name, entry.repo.node_id]));
  const judgeScores = judge.per_repo
    .map((item) => ({ repo_id: fullNameToNode.get(item.full_name) ?? item.full_name, score: item.score, note: item.note }))
    .filter((item): item is { repo_id: string; score: number; note: string } => Boolean(item.repo_id));
  await db.updateResultScores(attempt.id, judgeScores);

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
  const baseKeywords = options.baseKeywords ?? true;
  const maxResults = options.maxResults ?? 30;
  const retryPolicy = options.retryPolicy ?? { max_attempts: 3, min_score: 0.65 };
  const searchWithin = await gatherSearchWithin(db, options.searchWithinSessions ?? []);

  const attempts: SearchAttemptSummary[] = [];
  let currentQuery = options.query;
  for (let attemptIndex = 0; attemptIndex < (retryPolicy.max_attempts ?? 1); attemptIndex++) {
    const summary = await executeSingleSearch(ctx, db, options.sessionId, options.naturalLanguageRequest, currentQuery, options.callbacks, {
      baseKeywords,
      maxResults,
      searchWithinRepoIds: searchWithin,
    });
    attempts.push(summary);
    await options.callbacks?.onAttemptComplete?.(summary);
    if (summary.stats.median >= (retryPolicy.min_score ?? 0.65) || summary.stats.top5Mean >= 0.75) {
      break;
    }
    if (!summary.recommendations.length) {
      break;
    }
    currentQuery = summary.recommendations[0];
  }

  return { attempts };
}
