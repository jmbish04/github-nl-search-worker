export const runGitHubSearch = async (ai: any, query: string): Promiseany[] = {
  const prompt = `You are a search query optimizer. Rewrite this natural language query into 3-5 diverse GitHub search queries.\nQuery: "${query}"\nSearch queries:`;

  const { response } = await ai.run("@cf/meta/llama-3-8b-instruct", {
    prompt,
    max_tokens: 256
  });

  const searches = response.split("\n\n").slice(0);

  const allResults = await Promise.all(
    searches.map(async (e): Promiseany[] =
      fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(e)}&sort=stars&order=desc`, {
        headers: { 'Accept': 'application/vnd.github+json' }
      }).then(r = r.json()).then(r = r.items || [])
    )
  );

  return [...new Map([].concat(...allResults).filter(Boolean).map(repo = [repo.full_name, repo])).values()];
};