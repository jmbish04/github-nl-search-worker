import { z } from 'zod';

export interface JudgeEnv {
  OPENAI_API_KEY?: string;
  JUDGE_MODEL?: string;
}

const JudgeResponseSchema = z.object({
  overall_findings: z.string().max(500),
  recommendations: z.array(z.string()).min(1).max(5),
  per_repo: z
    .array(
      z.object({
        full_name: z.string(),
        score: z.number().min(0).max(1),
        note: z.string().max(240),
      })
    )
    .nonempty(),
});

export type JudgeResponse = z.infer<typeof JudgeResponseSchema>;

export interface JudgeRequestRepo {
  full_name: string;
  html_url: string;
  description: string | null;
  stars: number;
  language: string | null;
  topics: string[];
  readme_excerpt: string | null;
}

export interface JudgeRequest {
  natural_language_request: string;
  repos: JudgeRequestRepo[];
}

const SYSTEM_PROMPT = `You are an expert evaluator tasked with reviewing GitHub repositories for suitability in fulfilling a user request about Cloudflare Workers. Return a JSON object with keys overall_findings, recommendations (boolean GitHub search queries), and per_repo (scored findings). Use rubric: 0.0 off-topic, 0.3 adjacent, 0.6 useful, 0.8 strong, 0.9+ excellent.`;

export async function runJudge(env: JudgeEnv, payload: JudgeRequest): Promise<JudgeResponse> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('missing_openai_api_key');
  }
  const model = env.JUDGE_MODEL ?? 'gpt-4o-mini';

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: JSON.stringify(payload, null, 2),
    },
  ];

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) {
    throw new Error(`judge_api_error ${res.status}`);
  }
  const json = (await res.json()) as any;
  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('judge_empty_response');
  }
  const parsed = JudgeResponseSchema.parse(JSON.parse(content));
  return parsed;
}

export function computeStatistics(perRepo: JudgeResponse['per_repo']): { median: number; top5Mean: number } {
  const scores = perRepo.map((r) => r.score).sort((a, b) => a - b);
  const mid = Math.floor(scores.length / 2);
  const median = scores.length % 2 ? scores[mid] : (scores[mid - 1] + scores[mid]) / 2;
  const top5 = scores.slice(-5);
  const top5Mean = top5.length ? top5.reduce((sum, v) => sum + v, 0) / top5.length : 0;
  return { median, top5Mean };
}
