Goal
Create a Cloudflare Worker backend that:
	•	Exposes REST API, WebSocket API, and an MCP server.
	•	Runs GitHub repository search from natural language, uses LLM-as-a-judge to evaluate/refine, and persists everything in D1 with dedupe and audit trail.
	•	Serves openapi.json via ASSETS.
	•	Supports base search templates and “search within prior sessions”.
	•	Lets users select example repo(s) and generate a best-practice Worker scaffold to R2, precreating Cloudflare bindings via API and injecting their IDs into the scaffold’s wrangler.toml. Include AGENT.md and .agents/project_tasks.json.
	•	Before scaffolding, the Worker queries latest Cloudflare docs via an embedded MCP client to a remote cloudflare-docs MCP (Vectorize-backed) to ensure current best practices.
	•	Lists previously scaffolded projects and returns a curl command to download (like “git clone” for the zip).

⸻

Stack & Repo Layout
	•	TypeScript; Hono (or itty-router) for REST; native/standard WebSocket for WS; MCP over WS.
	•	D1 (FKs enabled) for persistence; R2 for scaffold artifacts; ASSETS for openapi.json and /docs page.
	•	Judge model: @cloudflare/agents/files/openai-sdk/llm-as-a-judge.
	•	GitHub: REST or GraphQL.
	•	Repo structure

/src
  index.ts
  routes.ts
  ws.ts
  mcp.ts                     // local MCP server
  mcp_cloudflare_docs_client.ts  // embedded client to remote cloudflare-docs MCP
  github.ts
  judge.ts
  db.ts
  scaffolder.ts
  cf_api.ts
  util.ts
/migrations/*.sql
/seeds/*.ts
/public/openapi.json
/public/docs.html
wrangler.toml
README.md
.modelcontext.json           // for local dev clients (see below)


⸻

Bindings, Secrets, Config
	•	wrangler.toml bindings:
	•	[[d1_databases]] → binding = "DB"
	•	[[r2_buckets]] → binding = "ARTIFACTS" (scaffold zips)
	•	[[assets]] → binding = "ASSETS", bucket = "./public"
	•	Secrets:
	•	GITHUB_TOKEN
	•	OPENAI_API_KEY (or compatible judge provider key)
	•	CF_API_TOKEN (to create bindings via Cloudflare API)
	•	MCP_REMOTE_URL="https://docs.mcp.cloudflare.com/sse"
	•	Optional dev file (checked in):

// .modelcontext.json
{
  "mcpServers": {
    "cloudflare": {
      "command": "npx",
      "args": ["mcp-remote", "https://docs.mcp.cloudflare.com/sse"]
    }
  }
}

The Worker itself must embed a lightweight SSE/HTTP client (mcp_cloudflare_docs_client.ts) that queries the remote cloudflare-docs MCP from inside the Worker before scaffolding.

⸻

Data Model (D1) — use exact DDL below

Enable FKs: PRAGMA foreign_keys=ON;

-- Sessions: external stable identifier for a user intent
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT UNIQUE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  natural_language_request TEXT NOT NULL,
  deleted_at DATETIME
);

-- Normalized repo catalog (global dedupe)
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,                 -- GitHub node_id (or owner/name consistently)
  full_name TEXT NOT NULL,             -- owner/name
  html_url TEXT NOT NULL,
  description TEXT,
  stars INTEGER,
  language TEXT,
  topics TEXT,                         -- JSON array string
  updated_at DATETIME,
  etag TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_repos_fullname ON repos(full_name);

-- Search attempts within a session (judge/search versioning for reproducibility)
CREATE TABLE IF NOT EXISTS search_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  result_group INTEGER NOT NULL,               -- 1 initial, 2+ refinements
  search_query TEXT NOT NULL,                  -- expanded query string(s)
  query_hash TEXT,
  judge_model TEXT,
  judge_model_version TEXT,
  search_strategy_version TEXT,
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_attempts_session_group ON search_attempts(session_id, result_group);
CREATE INDEX IF NOT EXISTS idx_attempts_session_time ON search_attempts(session_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_attempts_query_hash ON search_attempts(query_hash);

-- Judge reviews per attempt
CREATE TABLE IF NOT EXISTS judge_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  search_attempt_id INTEGER NOT NULL,
  overall_judge_findings TEXT NOT NULL,
  judge_recommendations TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
  FOREIGN KEY(search_attempt_id) REFERENCES search_attempts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_judge_attempt ON judge_reviews(search_attempt_id);

-- Results per attempt referencing normalized repos
CREATE TABLE IF NOT EXISTS search_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  search_attempt_id INTEGER NOT NULL,
  repo_id TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  readme_content TEXT,
  judge_finding TEXT,
  judge_relevance_score REAL,
  batch_id INTEGER,
  inserted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (session_id, search_attempt_id, repo_id),
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
  FOREIGN KEY(search_attempt_id) REFERENCES search_attempts(id) ON DELETE CASCADE,
  FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_results_session_repo ON search_results(session_id, repo_id);
CREATE INDEX IF NOT EXISTS idx_results_score ON search_results(session_id, judge_relevance_score DESC);

-- Scaffolds registry (artifacts generated to R2)
CREATE TABLE IF NOT EXISTS scaffolds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scaffold_id TEXT UNIQUE NOT NULL,        -- UUID
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  session_id TEXT NOT NULL,
  attempt_id INTEGER,
  title TEXT NOT NULL,
  user_prompt TEXT NOT NULL,
  selected_repo_ids TEXT NOT NULL,         -- JSON array of repo_ids
  mcp_doc_queries TEXT NOT NULL,           -- JSON array of doc queries
  mcp_doc_evidence TEXT,                   -- JSON array of {title,url,snippet}
  artifact_key TEXT NOT NULL,              -- R2 object key for zip
  cf_bindings TEXT,                        -- JSON of created binding ids/names
  status TEXT NOT NULL DEFAULT 'ready',    -- ready|error
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_scaffolds_session ON scaffolds(session_id, created_at DESC);

Example dedupe across groups (session-local):

SELECT r2.repo_url
FROM search_results r2
JOIN search_attempts a2 ON a2.id = r2.search_attempt_id
WHERE a2.session_id = ? AND a2.result_group = 2
AND NOT EXISTS (
  SELECT 1
  FROM search_results r1
  JOIN search_attempts a1 ON a1.id = r1.search_attempt_id
  WHERE a1.session_id = a2.session_id
    AND a1.result_group < a2.result_group
    AND r1.repo_id = r2.repo_id
);


⸻

REST API (JSON; Bearer auth recommended; rate-limit with Retry-After)

Sessions
	•	POST /api/sessions → create session
Body: { "natural_language_request": "...", "session_id?": "uuid" }
Res: { "session_id": "...", "created_at": "...", "natural_language_request": "..." }
	•	GET /api/sessions?limit=&cursor= → list sessions (cursor pagination)
	•	GET /api/sessions/:session_id → summary incl. latest attempt & counts

Search lifecycle
	•	POST /api/sessions/:session_id/search?wait=bool → start attempt (auto result_group)
Body:

{
  "query": "natural language or explicit terms",
  "base_keywords": true,
  "max_results": 50,
  "search_within_sessions": ["<session_id>", "..."],
  "retry_policy": { "max_attempts": 3, "min_score": 0.65 }
}

Res: { attempt_id, result_group, expanded_queries, started_at } (+ final summary if wait=true)

	•	GET /api/sessions/:session_id/attempts → list attempts with judge summaries
Res: [{ attempt_id, result_group, search_query, timestamp, judge_summary, recommendations }]
	•	GET /api/sessions/:session_id/results?attempt_id=&min_score=&q=&dedupe=&sort=&cursor=
sort: score_desc|stars_desc|time_desc. Returns paginated repo rows.

Scaffolder
	•	POST /api/scaffolds → select repos & prompt → docs-informed scaffold
Body:

{
  "session_id": "uuid",
  "attempt_id": 123,
  "selected_repo_ids": ["<repo_node_id>", "..."],
  "user_prompt": "use these as a guideline to <build X>",
  "scaffold_title": "my-worker-X",
  "bindings": {
    "d1": [{"name":"DB","database_name":"..."}],
    "r2": [{"name":"ARTIFACTS","bucket":"..."}],
    "kv": [{"name":"CACHE"}],
    "queues": [{"name":"EVENTS"}]
  }
}

Server flow:
	1.	Summarize selected repos (metadata + README excerpts).
	2.	Judge LLM: produce best-practice plan + doc query set.
	3.	Docs prefetch (embedded MCP): call cloudflare-docs MCP with judge queries; capture {title,url,snippet} evidence.
	4.	Use Cloudflare API (CF_API_TOKEN) to create requested resources; capture IDs/names.
	5.	Generate scaffold tree: wrangler.toml (with created binding IDs), package.json (deploy/migrate scripts), migrations stub, minimal Worker (REST/WS shape), AGENT.md (instructions), .agents/project_tasks.json (actionable tasks).
	6.	Zip → put to R2 (ARTIFACTS), create scaffolds row (store doc evidence, bindings JSON, artifact key).
Res: { scaffold_id, title, artifact_key, curl_download, cf_bindings, mcp_doc_evidence }

	•	GET /api/scaffolds?session_id=&limit=&cursor= → list scaffolds
Res: [{ scaffold_id, title, created_at, artifact_key }]
	•	GET /api/scaffolds/:scaffold_id → scaffold detail (evidence, bindings, prompt)
	•	GET /api/scaffolds/:scaffold_id/download → returns a pre-signed URL (or direct streaming) and a curl command (e.g., curl -L "<url>" -o my-worker.zip)

Errors (all endpoints): { code, message, details? }

⸻

WebSocket API
	•	GET /ws/sessions/:session_id
	•	Client → Server:
	•	{"type":"start_search","query":"...","base_keywords":true,"max_results":50}
	•	{"type":"cancel_attempt","attempt_id":123}
	•	Server → Client events:
	•	attempt_started {attempt_id,result_group,search_query}
	•	github_batch {attempt_id,count,repos:[{full_name,html_url,...}]}
	•	judge_update {attempt_id,stage:"initial"|"refine",score_summary:{median,top5_mean},findings,recommendations}
	•	refined_search {attempt_id,result_group,search_query}
	•	finalized {attempt_id,total,deduped_total,threshold,elapsed_ms}
	•	error {attempt_id,code,message}
	•	Throttle WS emissions (coalesce every 250–500ms or N=20).

⸻

MCP Server (local) + Embedded cloudflare-docs client
	•	Local MCP tools exposed under /mcp:
	•	run_search(session_id, query, base_keywords=true, max_results=50, search_within_sessions=[])
	•	list_sessions(limit=50, cursor=null)
	•	list_attempts(session_id)
	•	list_results(session_id, attempt_id=null, min_score=null, q=null, dedupe=true)
	•	get_openapi_spec()
	•	cloudflare_docs_query(query, topK=8) → delegates to embedded client
	•	Embedded client (mcp_cloudflare_docs_client.ts) connects to MCP_REMOTE_URL (SSE/HTTP) and returns an array of {title,url,snippet}. Use this before any scaffold is generated.

⸻

Default Search Strategy

When base_keywords=true, expand NL query into multiple GitHub queries and union + dedupe:
	1.	Workers config + keywords

("wrangler.toml" OR "wrangler.json" OR "wrangler.jsonc")
AND ("Cloudflare Workers" OR "cloudflare worker" OR "cf worker")
AND <additional keywords>

	2.	Language/topic bias

(topic:cloudflare-workers OR in:readme "cloudflare workers")
AND (language:TypeScript OR language:JavaScript)
AND <additional keywords>

	3.	Framework hints

(shadcn OR hono OR "itty-router" OR wretch)
AND (in:readme cloudflare OR in:readme wrangler)
AND <additional keywords>

Search within prior sessions: accept DSL like (session_id:A OR session_id:B) AND shadcn; resolve to prior repo_ids and either intersect or bias (return which strategy used).

⸻

Judge Flow (LLM-as-a-Judge)

Input = NL request + repo metadata + README excerpt (first 1–2k chars).
Output (validate with Zod):

{
  "overall_findings": "≤5 lines",
  "recommendations": ["boolean query 1","boolean query 2","boolean query 3"],
  "per_repo": [{"full_name":"owner/name","score":0.0-1.0,"note":"≤1 line"}]
}

Rubric: 0.0 off-topic, 0.3 adjacent, 0.6 useful, 0.8 strong, 0.9+ excellent.
Refine if median < 0.65 and top-5 mean < 0.75; max refinements = 2 (configurable).
Persist: search_attempts, judge_reviews, and update search_results with per-repo scores/notes.

⸻

OpenAPI & Assets
	•	Put complete public/openapi.json describing all endpoints/schemas/examples.
	•	Serve at /openapi.json (ASSETS) and a minimal /docs page.
	•	Keep OpenAPI the source of truth; ensure handlers match; add a simple check in CI.

⸻

Security & Ops
	•	REST: Bearer token; WS: short-lived signed token (HMAC of {session_id, exp}).
	•	Rate limiting: simple token bucket per IP/session.
	•	Logging: structured JSON (session_id, attempt_id, stage, lat_ms, github_calls, judge_cost).
	•	Consistent timestamps in UTC (ISO 8601).
	•	Backpressure on WS.
	•	Health endpoints: /api/health and /api/metrics (JSON ok).

⸻

Implementation Notes
	•	Modules:
	•	github.ts → query builders + fetches + pagination (+ README fetch with ETag caching into repos.etag).
	•	judge.ts → call judge, enforce schema, return scores/recs.
	•	db.ts → prepared statements; INSERT OR IGNORE for (session_id, search_attempt_id, repo_id).
	•	routes.ts → REST handlers.
	•	ws.ts → session WS manager.
	•	mcp.ts → MCP tools; reuse same service funcs as REST.
	•	mcp_cloudflare_docs_client.ts → SSE/HTTP client to MCP_REMOTE_URL.
	•	scaffolder.ts → orchestration: (judge plan → docs queries → CF API bindings → scaffold tree → zip to R2).
	•	cf_api.ts → helpers to create D1/KV/R2/Queues bindings; return IDs/names for wrangler.toml.
	•	Persist ASAP; dedupe before insert.
	•	Return the expanded queries used in each search attempt.

⸻

README (deliver with repo)
	•	Setup secrets, run migrations, local dev.
	•	Example curl for: create session, start search (wait=true), list results, create scaffold, download scaffold (show the generated curl -L "<signed-url>" -o <title>.zip).
	•	MCP usage notes (how to call local MCP and what tools exist).

⸻

Acceptance Checklist
	•	POST /api/sessions then POST /api/sessions/:session_id/search?wait=true returns persisted attempts/results and emits WS events.
	•	GET /api/sessions/:id/results supports filters, dedupe, sorting.
	•	POST /api/scaffolds generates an R2 artifact after consulting cloudflare-docs MCP; wrangler.toml contains real binding IDs returned by Cloudflare API; AGENT.md and .agents/project_tasks.json included.
	•	GET /api/scaffolds lists; GET /api/scaffolds/:id/download returns pre-signed URL and a ready-to-run curl command.
	•	/openapi.json and /docs are served from ASSETS.
	•	MCP endpoint /mcp exposes both local tools and a proxy tool cloudflare_docs_query.

⸻

Build it exactly as specified.



name = "github-search-worker"
main = "src/index.ts"
compatibility_date = "2024-01-01"
compatibility_flags = ["nodejs_compat"]

# D1 Database binding
[[d1_databases]]
binding = "DB"
database_name = "github-search-db"
database_id = "d657ff22-4451-4c7c-8728-d608ea5d7442"

# KV namespace binding
[[kv_namespaces]]
binding = "CACHE"
id = "c3423e811c154a08835d82b63a6595e3"

# R2 bucket binding
[[r2_buckets]]
binding = "STORAGE"
bucket_name = "github-search-storage"

# Queue binding (producer)
[[queues.producers]]
binding = "SEARCH_QUEUE"
queue = "github-search-queue"

# Queue consumer
[[queues.consumers]]
queue = "github-search-queue"
max_batch_size = 10
max_batch_timeout = 30

# Vectorize binding (for semantic search)
[[vectorize]]
binding = "VECTORIZE"
index_name = "github-embeddings"

# Workflow binding
[[workflows]]
binding = "WORKFLOW"
name = "github-search-workflow"

# Environment variables
[vars]
GITHUB_API_URL = "https://api.github.com"

# Assets (if you have static files)
[[assets]]
binding = "ASSETS"
bucket = "./public"

# Durable Objects (optional, for stateful operations)
[[durable_objects.bindings]]
name = "SEARCH_STATE"
class_name = "SearchState"
script_name = "github-search-worker"

# Analytics Engine (for tracking)
[[analytics_engine_datasets]]
binding = "ANALYTICS"
