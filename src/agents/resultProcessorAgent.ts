export const processResponse = async (db: any, data: any[]) = {
  // Store search results to D1
  await Promise.all(
    data.map(async (repo) = {
      const j = JSON.stringify(repo);
      return await db.exec('INSERT INTO repos_results (json) VALUES (?)', j);
    })
  );

  // Generate metrics
  const topics: Recordstring, number = {};
  let totalStars = 0;

  for (const repo of data) {
    if (repo.topics) {
      for (const t of repo.topics) {
        topics[t] = (topics[t] || 0) + 1;
      }
    }
    totalStars += repo.stargazers_count || 0;
  }

  const sortedRepos = data.sort((a, b) =
    b.stargazers_count - a.stargazers_count ||
    a.full_name.localeCompare(b.full_name)
  );
  const top10 = sortedRepos.slice(0, 10);
  const low10 = sortedRepos.slice(-10);

  return {
    totalRepos: data.length,
    totalStars,
    uniqueTopics: Object.entries(topics).sort((a, b) = b[1] - a[1]),
    top10,
    low10,
    repos: sortedRepos.map(repo = ({
      name: repo.full_name,
      url