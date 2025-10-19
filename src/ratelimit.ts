// A token bucket rate limiter implementation
// This is a simplified implementation for demonstration purposes
// For production use, consider using a more robust solution like Cloudflare Rate Limiting

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, TokenBucket>();
const capacity = 20; // 20 tokens per bucket
const refillRate = 1; // 1 token per second

export function rateLimiter(ip: string) {
  const now = Date.now();
  if (!buckets.has(ip)) {
    buckets.set(ip, {
      tokens: capacity,
      lastRefill: now,
    });
  }

  const bucket = buckets.get(ip)!;
  const elapsed = (now - bucket.lastRefill) / 1000;
  const newTokens = elapsed * refillRate;
  bucket.tokens = Math.min(capacity, bucket.tokens + newTokens);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return {
      success: true,
      limit: capacity,
      remaining: Math.floor(bucket.tokens),
    };
  }

  return {
    success: false,
    limit: capacity,
    remaining: 0,
  };
}
