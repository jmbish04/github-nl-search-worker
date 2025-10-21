import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectNamespace } from '@cloudflare/workers-types';

const STATE_KEY = 'tokens';

interface RateLimiterState {
  tokens: number;
}

export interface RateLimiterBindings {
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
}

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  retryAfterMs?: number;
}

export class RateLimiter extends DurableObject {
  static milliseconds_per_request = 1;
  static milliseconds_for_updates = 5000;
  static capacity = 10000;

  private tokens?: number;

  async consume(): Promise<{ millisecondsToNextRequest: number; remaining: number }> {
    await this.initialize();
    const nextAlarm = await this.checkAndSetAlarm();

    if ((this.tokens ?? 0) > 0) {
      this.tokens = Math.max(0, (this.tokens ?? 0) - 1);
      await this.saveState();
      return {
        millisecondsToNextRequest: 0,
        remaining: Math.max(0, Math.floor(this.tokens ?? 0)),
      };
    }

    const wait = Math.max(0, nextAlarm - Date.now());
    return {
      millisecondsToNextRequest: wait,
      remaining: Math.max(0, Math.floor(this.tokens ?? 0)),
    };
  }

  override async alarm(): Promise<void> {
    await this.initialize();

    const currentTokens = this.tokens ?? RateLimiter.capacity;
    if (currentTokens < RateLimiter.capacity) {
      const tokensToAdd = RateLimiter.milliseconds_for_updates;
      this.tokens = Math.min(RateLimiter.capacity, currentTokens + tokensToAdd);
      await this.saveState();
    }

    if ((this.tokens ?? RateLimiter.capacity) < RateLimiter.capacity) {
      await this.ctx.storage.setAlarm(this.nextAlarmTime());
    }
  }

  private async initialize(): Promise<void> {
    if (this.tokens !== undefined) {
      return;
    }
    const stored = (await this.ctx.storage.get<RateLimiterState>(STATE_KEY))?.tokens;
    if (typeof stored === 'number') {
      this.tokens = stored;
      return;
    }
    this.tokens = RateLimiter.capacity;
    await this.saveState();
  }

  private async saveState(): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, { tokens: this.tokens ?? RateLimiter.capacity });
  }

  private async checkAndSetAlarm(): Promise<number> {
    const existingAlarm = await this.ctx.storage.getAlarm();
    if (existingAlarm !== null && existingAlarm !== undefined) {
      return existingAlarm;
    }
    const alarmTime = this.nextAlarmTime();
    await this.ctx.storage.setAlarm(alarmTime);
    return alarmTime;
  }

  private nextAlarmTime(): number {
    return Date.now() + RateLimiter.milliseconds_for_updates * RateLimiter.milliseconds_per_request;
  }
}

export async function checkRateLimit(env: RateLimiterBindings, identifier: string): Promise<RateLimitResult> {
  if (!env.RATE_LIMITER) {
    throw new Error('RATE_LIMITER durable object binding is not configured');
  }
  const stub = env.RATE_LIMITER.getByName(identifier);
  const { millisecondsToNextRequest, remaining } = await stub.consume();
  if (millisecondsToNextRequest > 0) {
    return {
      success: false,
      limit: RateLimiter.capacity,
      remaining,
      retryAfterMs: millisecondsToNextRequest,
    };
  }
  return {
    success: true,
    limit: RateLimiter.capacity,
    remaining,
  };
}
