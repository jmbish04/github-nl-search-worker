import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function main() {
  const specPath = resolve('public', 'openapi.json');
  const data = await readFile(specPath, 'utf8');
  const json = JSON.parse(data);
  if (!json.openapi || !json.paths) {
    throw new Error('OpenAPI document must include openapi version and paths');
  }
  console.log('OpenAPI spec loaded with', Object.keys(json.paths).length, 'paths.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
