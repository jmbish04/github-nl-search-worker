import { Router } from 'itty-router';
import { runGitHubSearch } from './agents/githubQueryAgent';
import { processResponse } from './agents/resultProcessorAgent';

const router = Router();

router.post('/search', async (req, env) = {
  const { query } = await req.json();

  // GitHub Agent: Run query and fetch matching repositories
  const results = await runGitHubSearch(env.AI, query);

  // Result Agent: Store to D1 and return metrics with AI rationale
  const output = await processResponse(env.DB, results);

  return new Response(JSON.stringify(output), {
    headers: { 'Content-Type': 'application/json' },
  });
});

export default {
  fetch: router.handle,
};