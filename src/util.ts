export type Paginated<T> = {
  items: T[];
  nextCursor: string | null;
};

const encoder = new TextEncoder();

async function hmacSHA256(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function hashString(input: string): Promise<string> {
  const data = encoder.encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      ...init.headers,
    },
    ...init,
  });
}

export function errorResponse(code: string, message: string, status = 400, details?: unknown): Response {
  return jsonResponse(
    {
      code,
      message,
      ...(details ? { details } : {}),
    },
    { status }
  );
}

function decodeCursor(cursor: string): number {
  return Number(atob(cursor));
}

function encodeCursor(index: number): string {
  return btoa(String(index));
}

export function paginateArray<T>(values: T[], limit: number, cursor?: string | null): Paginated<T> {
  const startIndex = cursor ? decodeCursor(cursor) : 0;
  const slice = values.slice(startIndex, startIndex + limit);
  const nextIndex = startIndex + slice.length;
  return {
    items: slice,
    nextCursor: nextIndex < values.length ? encodeCursor(nextIndex) : null,
  };
}

export async function signSessionToken(secret: string, sessionId: string, expiresAt: number): Promise<string> {
  const payload = `${sessionId}:${expiresAt}`;
  const signature = await hmacSHA256(secret, payload);
  return btoa(JSON.stringify({ sessionId, exp: expiresAt, sig: signature }));
}

export async function verifySessionToken(secret: string, token: string, now = Date.now()): Promise<{ sessionId: string } | null> {
  try {
    const decoded = JSON.parse(atob(token)) as {
      sessionId: string;
      exp: number;
      sig: string;
    };
    const expectedSig = await hmacSHA256(secret, `${decoded.sessionId}:${decoded.exp}`);
    if (expectedSig !== decoded.sig) {
      return null;
    }
    if (decoded.exp < now) {
      return null;
    }
    return { sessionId: decoded.sessionId };
  } catch {
    return null;
  }
}

export function utcNow(): string {
  return new Date().toISOString();
}

export function chunkArray<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

export class Logger {
  constructor(private context: Record<string, any> = {}) {}

  private log(level: 'info' | 'warn' | 'error', message: string, data: Record<string, any> = {}) {
    const fullData = { ...this.context, ...data };
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...fullData }));
  }

  info(message: string, data: Record<string, any> = {}) {
    this.log('info', message, data);
  }

  warn(message: string, data: Record<string, any> = {}) {
    this.log('warn', message, data);
  }

  error(message: string, data: Record<string, any> = {}) {
    this.log('error', message, data);
  }

  withContext(context: Record<string, any>) {
    return new Logger({ ...this.context, ...context });
  }
}

export function dedupeBy<T>(items: T[], getKey: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = getKey(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

export function coalesceEvents<T>(
  emit: (batch: T[]) => Promise<void> | void,
  {
    intervalMs = 300,
    maxBatch = 20,
  }: {
    intervalMs?: number;
    maxBatch?: number;
  } = {}
): { emit: (event: T) => Promise<void>; flush: () => Promise<void> } {
  let buffer: T[] = [];
  let timeout: number | undefined;
  let resolveFlush: (() => void) | undefined;
  let flushPromise: Promise<void> | undefined;

  const performFlush = async () => {
    if (!buffer.length) return;
    const batch = buffer;
    buffer = [];
    clearTimeout(timeout);
    timeout = undefined;
    await emit(batch);
    if (resolveFlush) {
      resolveFlush();
      resolveFlush = undefined;
      flushPromise = undefined;
    }
  };

  const flush = (): Promise<void> => {
    if (flushPromise) return flushPromise;

    if (buffer.length === 0) {
      return Promise.resolve();
    }

    // Wrap the flush operation in a promise to wait for completion
    flushPromise = new Promise<void>((resolve) => {
      resolveFlush = resolve;
      performFlush();
    });
    return flushPromise;
  };

  const emitEvent = async (event: T) => {
    buffer.push(event);
    if (buffer.length >= maxBatch) {
      await performFlush();
      return;
    }
    if (timeout === undefined) {
      timeout = setTimeout(() => {
        performFlush();
      }, intervalMs) as unknown as number;
    }
  };

  return { emit: emitEvent, flush };
}
