import { createParser } from 'eventsource-parser';

export interface McpDocEvidence {
  title: string;
  url: string;
  snippet: string;
}

export interface McpClientEnv {
  MCP_REMOTE_URL?: string;
}

export async function queryCloudflareDocs(env: McpClientEnv, query: string, topK = 8): Promise<McpDocEvidence[]> {
  const url = env.MCP_REMOTE_URL ?? 'https://docs.mcp.cloudflare.com/sse';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, topK }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`mcp_docs_error ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const docs: McpDocEvidence[] = [];
  const parser = createParser((event) => {
    if (event.type !== 'event' || !event.data) return;
    try {
      const data = JSON.parse(event.data);
      if (Array.isArray(data.results)) {
        for (const item of data.results) {
          if (item && item.title && item.url) {
            docs.push({
              title: item.title,
              url: item.url,
              snippet: item.snippet ?? '',
            });
          }
        }
      } else if (data.title && data.url) {
        docs.push({ title: data.title, url: data.url, snippet: data.snippet ?? '' });
      }
    } catch (err) {
      console.error('failed_to_parse_mcp_doc_event', err);
    }
  });

  let done = false;
  while (!done) {
    const { value, done: readerDone } = await reader.read();
    done = readerDone;
    if (value) {
      parser.feed(decoder.decode(value, { stream: !done }));
    }
  }
  return docs;
}
