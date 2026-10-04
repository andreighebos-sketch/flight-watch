/** Error kinds understood by the monitor and the UI. */
export const ErrorKind = Object.freeze({
  CONFIG: 'config',
  AUTH: 'auth',
  RATE_LIMIT: 'rate_limit',
  QUOTA: 'quota',
  BUDGET: 'budget',
  BAD_REQUEST: 'bad_request',
  SERVER: 'server',
  TIMEOUT: 'timeout',
  NETWORK: 'network',
  INVALID_RESPONSE: 'invalid_response',
  ABORTED: 'aborted',
});

/** Errors that make every further request in the same sweep pointless. */
export const FATAL_KINDS = new Set([ErrorKind.CONFIG, ErrorKind.AUTH, ErrorKind.RATE_LIMIT, ErrorKind.QUOTA, ErrorKind.BUDGET]);

export class ProviderError extends Error {
  constructor(message, { kind, status = null, retryable = false, retryAfterMs = null, provider = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind ?? ErrorKind.SERVER;
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.provider = provider;
  }
}

export const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ProviderError('Aborted', { kind: ErrorKind.ABORTED }));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new ProviderError('Aborted', { kind: ErrorKind.ABORTED }));
    }, { once: true });
  });

/** Parses Retry-After / RateLimit-Reset style headers into a delay in ms. */
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 1e9) return Math.max(0, n * 1000 - nowMs); // epoch seconds
    return Math.max(0, n * 1000); // delta seconds
  }
  const at = Date.parse(s);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

/**
 * fetch() with a hard timeout. Returns { status, headers, json, text }.
 * Network failures and timeouts are converted into retryable ProviderErrors.
 */
export async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 30000, signal, provider, fetchImpl = fetch } = {}) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let res;
  try {
    res = await fetchImpl(url, { method, headers, body, signal: combined });
  } catch (err) {
    if (signal?.aborted) throw new ProviderError('Request aborted', { kind: ErrorKind.ABORTED, provider });
    if (timeoutSignal.aborted || err?.name === 'TimeoutError') {
      throw new ProviderError(`Provider did not respond within ${Math.round(timeoutMs / 1000)} s`, { kind: ErrorKind.TIMEOUT, retryable: true, provider });
    }
    throw new ProviderError(`Network error contacting provider: ${err?.message || err}`, { kind: ErrorKind.NETWORK, retryable: true, provider });
  }
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, headers: res.headers, json, text };
}

/** Retries only errors flagged retryable, with exponential backoff + jitter. */
export async function withRetry(fn, { retries = 2, baseDelayMs = 1000, maxDelayMs = 15000, signal, onRetry, sleepFn = sleep } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      const canRetry = err instanceof ProviderError && err.retryable && attempt < retries && !signal?.aborted;
      if (!canRetry) throw err;
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) + Math.floor(Math.random() * 250);
      const delay = err.retryAfterMs != null ? Math.min(Math.max(err.retryAfterMs, 500), 65000) : backoff;
      onRetry?.(err, attempt + 1, delay);
      await sleepFn(delay, signal);
      attempt += 1;
    }
  }
}
