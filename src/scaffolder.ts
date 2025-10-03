import JSZip from 'jszip';
import { Database, RepoRow } from './db';
import { provisionBindings, BindingProvisionRequest, BindingProvisionResult, CfEnv } from './cf_api';
import { queryCloudflareDocs, McpDocEvidence, McpClientEnv } from './mcp_cloudflare_docs_client';
import { JudgeEnv } from './judge';

export interface ScaffolderEnv extends CfEnv, McpClientEnv, JudgeEnv {
  ARTIFACTS: R2Bucket;
}

export interface ScaffoldRequest {
  sessionId: string;
  attemptId?: number;
  selectedRepoIds: string[];
  userPrompt: string;
  scaffoldTitle: string;
  bindings: BindingProvisionRequest;
}

export interface ScaffoldResult {
  scaffold_id: string;
  title: string;
  artifact_key: string;
  cf_bindings: BindingProvisionResult;
  mcp_doc_evidence: McpDocEvidence[];
  mcp_doc_queries: string[];
  curl_download: string;
}

interface RepoSummary {
  repo: RepoRow;
  readme: string | null;
}

async function summarizeRepos(db: Database, sessionId: string, repoIds: string[]): Promise<RepoSummary[]> {
  const repos = await db.getReposByIds(repoIds);
  const results = await db.getResultsForSession(sessionId, repoIds);
  return repoIds
    .map((id) => {
      const repo = repos.find((r) => r.id === id);
      if (!repo) return null;
      const readme = results.find((r) => r.repo_id === id)?.readme_content ?? null;
      return { repo, readme } as RepoSummary;
    })
    .filter((value): value is RepoSummary => Boolean(value));
}

async function generatePlan(env: JudgeEnv, request: { userPrompt: string; repos: RepoSummary[] }): Promise<{ docQueries: string[]; plan: string[] }> {
  const repoDetails = request.repos.map((entry) => ({
    full_name: entry.repo.full_name,
    description: entry.repo.description,
    topics: entry.repo.topics,
    readme_excerpt: entry.readme ? entry.readme.slice(0, 1500) : null,
  }));

  if (!env.OPENAI_API_KEY) {
    throw new Error('missing_openai_api_key');
  }

  const messages = [
    {
      role: 'system',
      content:
        'You design production-ready Cloudflare Worker scaffolds. Given repository inspirations and a user prompt, produce JSON with doc_queries (<=5) and plan (<=8 bullet summaries).',
    },
    {
      role: 'user',
      content: JSON.stringify({ prompt: request.userPrompt, repos: repoDetails }),
    },
  ];

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env.JUDGE_MODEL ?? 'gpt-4o-mini',
      temperature: 0,
      messages,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) {
    throw new Error(`scaffold_plan_error ${res.status}`);
  }
  const json = (await res.json()) as any;
  const content = json.choices?.[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(content);
  return {
    docQueries: Array.isArray(parsed.doc_queries) ? parsed.doc_queries.slice(0, 5) : [],
    plan: Array.isArray(parsed.plan) ? parsed.plan.slice(0, 8) : [],
  };
}

function renderWranglerToml(title: string, bindings: BindingProvisionResult): string {
  const lines = [`name = "${title}"`, 'main = "src/index.ts"', 'compatibility_date = "2024-01-01"', 'compatibility_flags = ["nodejs_compat"]'];
  if (bindings.d1.length) {
    lines.push('', '[[d1_databases]]');
    for (const entry of bindings.d1) {
      lines.push(`binding = "${entry.name}"`, `database_id = "${entry.id}"`, `database_name = "${entry.database_name}"`, '');
    }
  }
  if (bindings.r2.length) {
    for (const entry of bindings.r2) {
      lines.push('[[r2_buckets]]', `binding = "${entry.name}"`, `bucket_name = "${entry.bucket}"`, '');
    }
  }
  if (bindings.kv.length) {
    for (const entry of bindings.kv) {
      lines.push('[[kv_namespaces]]', `binding = "${entry.name}"`, `id = "${entry.id}"`, '');
    }
  }
  if (bindings.queues.length) {
    for (const entry of bindings.queues) {
      lines.push('[[queues.producers]]', `binding = "${entry.name}"`, `queue = "${entry.id}"`, '');
    }
  }
  lines.push('', '[[assets]]', 'binding = "ASSETS"', 'bucket = "./public"');
  return lines.join('\n');
}

function renderScaffoldIndex(): string {
  return `import { Hono } from 'hono';
import { handle } from 'hono/cloudflare-workers';

const app = new Hono();

app.get('/api/health', (c) => c.json({ status: 'ok' }));
app.get('/api/metrics', (c) => c.json({ uptime: Date.now() }));

export default { fetch: handle(app) };
`;
}

function renderAgentMd(): string {
  return `# Generated Worker Scaffold

- Keep endpoints aligned with openapi.json.
- Persist D1 schema migrations before deploy.
- Update .agents/project_tasks.json when tasks change.
`;
}

function renderProjectTasks(): string {
  return JSON.stringify(
    {
      tasks: [
        { id: 'docs', description: 'Review Cloudflare docs referenced in scaffold generation.' },
        { id: 'migrations', description: 'Fill in D1 migrations before deploy.' },
      ],
    },
    null,
    2
  );
}

async function generateZip(title: string, plan: string[], bindings: BindingProvisionResult): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('README.md', `# ${title}\n\n## Plan\n\n${plan.map((item) => `- ${item}`).join('\n')}`);
  zip.file('wrangler.toml', renderWranglerToml(title, bindings));
  zip.file('AGENT.md', renderAgentMd());
  zip.file('.agents/project_tasks.json', renderProjectTasks());
  zip.file('package.json', JSON.stringify({ name: title, scripts: { deploy: 'wrangler deploy' } }, null, 2));
  zip.file('src/index.ts', renderScaffoldIndex());
  zip.folder('migrations')?.file('.keep', '');
  zip.folder('public')?.file('openapi.json', '{}');
  return zip.generateAsync({ type: 'uint8array' });
}

export async function createScaffold(env: ScaffolderEnv, db: Database, request: ScaffoldRequest): Promise<ScaffoldResult> {
  const repoSummaries = await summarizeRepos(db, request.sessionId, request.selectedRepoIds);
  if (!repoSummaries.length) {
    throw new Error('no_repos_selected');
  }

  const plan = await generatePlan(env, { userPrompt: request.userPrompt, repos: repoSummaries });
  const docEvidence: McpDocEvidence[] = [];
  for (const query of plan.docQueries) {
    const evidence = await queryCloudflareDocs(env, query);
    docEvidence.push(...evidence);
  }

  const bindingResult = await provisionBindings(env, request.bindings);

  const zipBytes = await generateZip(request.scaffoldTitle, plan.plan, bindingResult);
  const scaffoldId = crypto.randomUUID();
  const artifactKey = `${request.sessionId}/${scaffoldId}.zip`;

  await env.ARTIFACTS.put(artifactKey, zipBytes, {
    httpMetadata: {
      contentType: 'application/zip',
    },
  });

  const curlDownload = `curl -L "https://example.com/download/${artifactKey}" -o ${request.scaffoldTitle}.zip`;

  await db.createScaffold({
    scaffoldId,
    sessionId: request.sessionId,
    attemptId: request.attemptId,
    title: request.scaffoldTitle,
    userPrompt: request.userPrompt,
    selectedRepoIds: request.selectedRepoIds,
    mcpDocQueries: plan.docQueries,
    mcpDocEvidence: docEvidence,
    artifactKey,
    cfBindings: bindingResult,
    status: 'ready',
  });

  return {
    scaffold_id: scaffoldId,
    title: request.scaffoldTitle,
    artifact_key: artifactKey,
    cf_bindings: bindingResult,
    mcp_doc_evidence: docEvidence,
    mcp_doc_queries: plan.docQueries,
    curl_download: curlDownload,
  };
}
