# GitHub NL Search Worker

Cloudflare Worker that converts natural-language requests into GitHub repository searches, evaluates them with an LLM-as-a-judge, and persists results in D1. It can scaffold new Workers directly to R2 after consulting Cloudflare documentation via MCP.

## Features

- REST API backed by [Hono](https://hono.dev) with bearer authentication.
- WebSocket API for live search lifecycle updates.
- Embedded MCP server exposing search utilities and a proxy to the remote Cloudflare docs MCP.
- Persistence in D1 with normalized sessions, attempts, results, and scaffolds.
- Scaffold generator that provisions Cloudflare resources, produces Worker templates, and stores artifacts in R2.
- Static OpenAPI spec served from `/openapi.json` with a minimal docs page at `/docs`.

## Setup

1. Install dependencies for type-checking and OpenAPI validation:

   ```sh
   npm install
   ```

2. Configure secrets (one-time):

   ```sh
   wrangler secret put GITHUB_TOKEN
   wrangler secret put OPENAI_API_KEY
   wrangler secret put CF_API_TOKEN
   wrangler secret put MCP_REMOTE_URL
   wrangler secret put SESSION_TOKEN_SECRET
   ```

3. Update `wrangler.toml` bindings or environment variables as needed. Run the migrations locally:

   ```sh
   wrangler d1 execute github-search-db --local --file=./migrations/001_init.sql
   ```

## Running locally

```sh
npm run lint
wrangler dev
```

The Worker exposes the following key endpoints:

- `POST /api/sessions`
- `POST /api/sessions/{session_id}/search?wait=true`
- `GET /api/sessions/{session_id}/results`
- `POST /api/scaffolds`
- `GET /api/scaffolds/{scaffold_id}/download`
- `GET /openapi.json`
- `POST /mcp`

## Example usage

Create a session:

```sh
curl -X POST https://worker.example.com/api/sessions \
  -H "Authorization: Bearer $WORKER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"natural_language_request":"Build a Worker that indexes GitHub repos"}'
```

Start a search and wait for results:

```sh
curl -X POST https://worker.example.com/api/sessions/<session_id>/search?wait=true \
  -H "Authorization: Bearer $WORKER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"best Cloudflare Worker templates", "base_keywords":true, "max_results":30}'
```

List results filtered by score:

```sh
curl -G https://worker.example.com/api/sessions/<session_id>/results \
  -H "Authorization: Bearer $WORKER_API_KEY" \
  --data-urlencode "min_score=0.7"
```

Generate a scaffold:

```sh
curl -X POST https://worker.example.com/api/scaffolds \
  -H "Authorization: Bearer $WORKER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "<session_id>",
    "selected_repo_ids": ["MDEwOlJlcG9zaXRvcnkx"],
    "user_prompt": "Produce a TypeScript Worker following best practices",
    "scaffold_title": "worker-starter",
    "bindings": {
      "d1": [{"name":"DB","database_name":"worker-db"}],
      "r2": [{"name":"ARTIFACTS","bucket":"worker-artifacts"}]
    }
  }'
```

Download the generated artifact using the curl command returned in the response.

## MCP tools

The Worker exposes an MCP endpoint at `/mcp`. Send a JSON payload specifying the `tool` name and `params`:

```sh
curl -X POST https://worker.example.com/mcp \
  -H "Authorization: Bearer $WORKER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tool":"list_sessions","params":{"limit":10}}'
```

Available MCP tools:

- `run_search`
- `list_sessions`
- `list_attempts`
- `list_results`
- `get_openapi_spec`
- `cloudflare_docs_query`

For local MCP clients, see `.modelcontext.json` which configures the remote Cloudflare docs connector.
