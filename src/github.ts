import { dedupeBy } from './util';
import type { RepoRow } from './db';

export interface GitHubSearchOptions {
  query: string;
  baseKeywords?: boolean;
  maxResults?: number;
  token?: string;
  searchWithinRepos?: string[];
}

export interface GitHubRepository {
  id: string;
  node_id: string;
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  language: string | null;
  topics: string[];
  updated_at: string;
  default_branch: string;
  etag?: string;
}

export interface GitHubSearchResponse {
  query: string;
  items: GitHubRepository[];
}

const WORKER_KEYWORD_TEMPLATE = (
  query: string
) => `"Cloudflare Workers" AND ${query}`;

const LANGUAGE_TOPIC_TEMPLATE = (
  query: string
) => `(topic:cloudflare-workers OR in:readme "cloudflare workers") AND (language:TypeScript OR language:JavaScript) AND ${query}`;

const FRAMEWORK_TEMPLATE = (
  query: string
) => `(hono OR "itty-router") AND (in:readme cloudflare) AND ${query}`;

export function buildSearchQueries(naturalLanguage: string, baseKeywords = false): string[] {
  const sanitized = naturalLanguage.replace(/"/g, ' ');
  const tokens = sanitized
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const additional = tokens.length ? tokens.join(' ') : naturalLanguage;
  if (!baseKeywords) {
    return [additional];
  }
  return [
    WORKER_KEYWORD_TEMPLATE(additional),
    LANGUAGE_TOPIC_TEMPLATE(additional),
    FRAMEWORK_TEMPLATE(additional),
  ];
}

async function fetchGitHub(url: string, token?: string, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'GitHub-NL-Search-Worker',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(url, {
    ...init,
    headers: {
      ...headers,
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${body}`);
  }
  return res;
}

export async function fetchReadme(
  fullName: string,
  token?: string,
  etag?: string
): Promise<{ content: string | null; etag?: string }> {
  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.raw+json',
    };
    if (etag) {
      headers['If-None-Match'] = etag;
    }
    const res = await fetchGitHub(`https://api.github.com/repos/${fullName}/readme`, token, {
      headers,
    });
    if (res.status === 304) {
      return { content: null, etag };
    }
    const newEtag = res.headers.get('etag') ?? undefined;
    const contentType = res.headers.get('content-type');
    const text = contentType?.includes('application/json') ? await res.json() : await res.text();
    if (typeof text === 'object' && text && 'content' in text) {
      return { content: atob((text as any).content), etag };
    }
    return { content: typeof text === 'string' ? text : JSON.stringify(text), etag };
  } catch (err: any) {
    if (err instanceof Error && err.message.includes('404')) {
      return { content: null };
    }
    throw err;
  }
}

export async function runGitHubSearch(options: GitHubSearchOptions): Promise<GitHubSearchResponse[]> {
  const {
    query,
    baseKeywords = false,
    maxResults = 30,
    token,
    searchWithinRepos = [],
  } = options;
  const queries = buildSearchQueries(query, baseKeywords);
  const perQueryLimit = Math.max(1, Math.floor(maxResults / queries.length));

  const outputs: GitHubSearchResponse[] = [];

  for (const q of queries) {
    const searchParams = new URLSearchParams({
      q: q,
      per_page: String(perQueryLimit),
      sort: 'stars',
      order: 'desc',
    });
    const url = `https://api.github.com/search/repositories?${searchParams.toString()}`;
    const res = await fetchGitHub(url, token);
    const json = (await res.json()) as { items: any[] };

    const repos = dedupeBy(json.items ?? [], (item) => item.node_id);

    outputs.push({
      query: q,
      items: repos.map((repo) => ({
        id: repo.node_id || repo.id,
        node_id: repo.node_id || repo.id,
        full_name: repo.full_name,
        html_url: repo.html_url,
        description: repo.description,
        stargazers_count: repo.stargazers_count,
        language: repo.language,
        topics: Array.isArray(repo.topics) ? repo.topics : [],
        updated_at: repo.updated_at,
        default_branch: repo.default_branch,
      })),
    });
  }

  if (searchWithinRepos.length) {
    outputs.push({
      query: 'session-bias',
      items: searchWithinRepos.map((id) => ({
        repo: {
          id,
          node_id: id,
          full_name: id,
          html_url: `https://github.com/${id}`,
          description: null,
          stargazers_count: 0,
          language: null,
          topics: [],
          updated_at: new Date().toISOString(),
          default_branch: 'main',
        },
        readme: null,
        sourceQuery: 'session-bias',
      })),
    });
  }

  return outputs;
}

export function mapRepoToRow(repo: GitHubRepository): RepoRow {
  return {
    id: repo.node_id,
    full_name: repo.full_name,
    html_url: repo.html_url,
    description: repo.description,
    stars: repo.stargazers_count,
    language: repo.language,
    topics: JSON.stringify(repo.topics),
    updated_at: repo.updated_at,
    etag: repo.etag ?? null,
  };
}
