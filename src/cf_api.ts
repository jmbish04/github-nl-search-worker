export interface CfEnv {
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
}

interface CfRequestOptions {
  method?: string;
  body?: unknown;
}

async function cfFetch(env: CfEnv, path: string, { method = 'POST', body }: CfRequestOptions = {}) {
  const token = env.CF_API_TOKEN;
  const accountId = env.CF_ACCOUNT_ID;
  if (!token || !accountId) {
    return {
      success: true,
      result: {
        id: `${path.split('/').pop() ?? 'binding'}-${Date.now()}`,
        name: path.split('/').pop() ?? 'binding',
      },
    };
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`cf_api_error ${res.status}`);
  }
  return res.json();
}

export type D1BindingRequest = { name: string; database_name: string };
export type R2BindingRequest = { name: string; bucket: string };
export type KvBindingRequest = { name: string };
export type QueueBindingRequest = { name: string };

export interface BindingProvisionRequest {
  d1?: D1BindingRequest[];
  r2?: R2BindingRequest[];
  kv?: KvBindingRequest[];
  queues?: QueueBindingRequest[];
}

export interface BindingProvisionResult {
  d1: Array<{ name: string; id: string; database_name: string }>;
  r2: Array<{ name: string; bucket: string; id: string }>;
  kv: Array<{ name: string; id: string }>;
  queues: Array<{ name: string; id: string }>;
}

export async function provisionBindings(env: CfEnv, request: BindingProvisionRequest): Promise<BindingProvisionResult> {
  const results: BindingProvisionResult = { d1: [], r2: [], kv: [], queues: [] };

  for (const entry of request.d1 ?? []) {
    const response: any = await cfFetch(env, `/d1/database`, {
      method: 'POST',
      body: { name: entry.database_name },
    });
    const id = response.result?.uuid ?? response.result?.id ?? crypto.randomUUID();
    results.d1.push({ name: entry.name, id, database_name: entry.database_name });
  }

  for (const entry of request.r2 ?? []) {
    const response: any = await cfFetch(env, `/r2/buckets`, {
      method: 'POST',
      body: { name: entry.bucket },
    });
    const id = response.result?.id ?? crypto.randomUUID();
    results.r2.push({ name: entry.name, bucket: entry.bucket, id });
  }

  for (const entry of request.kv ?? []) {
    const response: any = await cfFetch(env, `/storage/kv/namespaces`, {
      method: 'POST',
      body: { title: entry.name },
    });
    const id = response.result?.id ?? crypto.randomUUID();
    results.kv.push({ name: entry.name, id });
  }

  for (const entry of request.queues ?? []) {
    const response: any = await cfFetch(env, `/queues`, {
      method: 'POST',
      body: { name: entry.name },
    });
    const id = response.result?.id ?? crypto.randomUUID();
    results.queues.push({ name: entry.name, id });
  }

  return results;
}
