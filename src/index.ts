import { createApiRouter, ApiEnv } from './routes';
import { handleSessionWebSocket } from './ws';
import { handleMcpRequest } from './mcp';

const api = createApiRouter();

export default {
  async fetch(request: Request, env: ApiEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/ws/')) {
      return handleSessionWebSocket(request, env);
    }
    if (url.pathname === '/mcp') {
      return handleMcpRequest(request, env);
    }
    if (url.pathname.startsWith('/api/')) {
      return api.fetch(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },
};
