import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Loads ./.env into process.env (Node's built-in parser, no dependency). */
export function loadEnvFile() {
  const file = path.join(ROOT_DIR, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

const PROVIDER_DEFAULTS = {
  // SerpApi bills every uncached search. 27 dates = 27 searches per sweep.
  serpapi: { interval: 240, ttl: 240, concurrency: 2, spacingMs: 1200, dailyLimit: 162 },
  // Duffel live search limit is 10 requests / 60 s → 1 request every 6.5 s.
  duffel: { interval: 30, ttl: 30, concurrency: 1, spacingMs: 6500, dailyLimit: 0 },
  demo: { interval: 5, ttl: 5, concurrency: 3, spacingMs: 120, dailyLimit: 0 },
};

function readInt(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${name}="${raw}": expected an integer between ${min} and ${max}`);
  }
  return n;
}

function readBool(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new Error(`Invalid ${name}="${raw}": expected true or false`);
}

function readCode(env, name, fallback, re) {
  const raw = (env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (!re.test(raw)) throw new Error(`Invalid ${name}="${raw}"`);
  return raw;
}

export function readConfig(env = process.env) {
  const provider = (env.FLIGHT_PROVIDER || 'serpapi').trim().toLowerCase();
  if (!PROVIDER_DEFAULTS[provider]) {
    throw new Error(`Invalid FLIGHT_PROVIDER="${provider}". Use serpapi, duffel or demo.`);
  }
  const d = PROVIDER_DEFAULTS[provider];
  const refreshIntervalMinutes = readInt(env, 'REFRESH_INTERVAL_MINUTES', d.interval, 5, 10080);
  const dbPath = (env.DB_PATH || './data/flight-watch.sqlite').trim();

  return Object.freeze({
    provider,
    port: readInt(env, 'PORT', 3000, 1, 65535),
    host: (env.HOST || '127.0.0.1').trim(),
    refreshIntervalMinutes,
    cacheTtlMinutes: readInt(env, 'CACHE_TTL_MINUTES', Math.min(d.ttl, refreshIntervalMinutes), 1, 10080),
    autoRefresh: readBool(env, 'AUTO_REFRESH', true),
    manualRefreshCooldownSeconds: readInt(env, 'MANUAL_REFRESH_COOLDOWN_SECONDS', 60, 10, 3600),
    dailyRequestLimit: readInt(env, 'DAILY_REQUEST_LIMIT', d.dailyLimit, 0, 100000),
    maxOffersPerDate: readInt(env, 'MAX_OFFERS_PER_DATE', 25, 1, 200),
    requestTimeoutMs: readInt(env, 'REQUEST_TIMEOUT_MS', 60000, 5000, 180000),
    concurrency: d.concurrency,
    minSpacingMs: d.spacingMs,
    dbPath: dbPath === ':memory:' ? dbPath : path.resolve(ROOT_DIR, dbPath),
    serpapi: Object.freeze({
      apiKey: (env.SERPAPI_API_KEY || '').trim(),
      gl: readCode(env, 'SERPAPI_GL', 'md', /^[a-z]{2}$/),
      hl: readCode(env, 'SERPAPI_HL', 'en', /^[a-z]{2,3}(-[a-z0-9]{2,3})?$/),
      deepSearch: readBool(env, 'SERPAPI_DEEP_SEARCH', false),
    }),
    duffel: Object.freeze({
      accessToken: (env.DUFFEL_ACCESS_TOKEN || '').trim(),
      maxConnections: readInt(env, 'DUFFEL_MAX_CONNECTIONS', 2, 0, 2),
      supplierTimeoutMs: readInt(env, 'DUFFEL_SUPPLIER_TIMEOUT_MS', 20000, 2000, 60000),
    }),
  });
}
