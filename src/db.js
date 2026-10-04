import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite persistence (Node's built-in node:sqlite, no native build step).
 * Every row is scoped by provider + data_mode so DEMO / SANDBOX data can never
 * be mixed into LIVE history.
 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL, data_mode TEXT NOT NULL, route_key TEXT NOT NULL,
  trigger TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
  dates_total INTEGER NOT NULL DEFAULT 0, dates_ok INTEGER NOT NULL DEFAULT 0,
  dates_cached INTEGER NOT NULL DEFAULT 0, dates_failed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running', error TEXT
);
CREATE TABLE IF NOT EXISTS date_results (
  provider TEXT NOT NULL, data_mode TEXT NOT NULL, route_key TEXT NOT NULL, departure_date TEXT NOT NULL,
  fetched_at TEXT NOT NULL, provider_updated_at TEXT, offer_count INTEGER NOT NULL,
  min_total REAL, currency TEXT, offers_json TEXT NOT NULL, booking_search_url TEXT,
  PRIMARY KEY (provider, data_mode, route_key, departure_date)
);
CREATE TABLE IF NOT EXISTS date_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL,
  provider TEXT NOT NULL, data_mode TEXT NOT NULL, route_key TEXT NOT NULL, departure_date TEXT NOT NULL,
  min_total REAL, currency TEXT, offer_count INTEGER NOT NULL, observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snap ON date_snapshots (provider, data_mode, route_key, departure_date, observed_at);
CREATE TABLE IF NOT EXISTS offer_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL,
  provider TEXT NOT NULL, data_mode TEXT NOT NULL, route_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL, departure_date TEXT NOT NULL,
  total_price REAL NOT NULL, currency TEXT NOT NULL, observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs ON offer_observations (provider, data_mode, route_key, fingerprint, observed_at);
CREATE TABLE IF NOT EXISTS provider_calls (
  day TEXT NOT NULL, provider TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider)
);
`;

export function openDatabase(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return createStore(db);
}

function createStore(db) {
  const q = {
    startRun: db.prepare(`INSERT INTO runs (provider, data_mode, route_key, trigger, started_at, dates_total) VALUES (?, ?, ?, ?, ?, ?)`),
    finishRun: db.prepare(`UPDATE runs SET finished_at = ?, dates_ok = ?, dates_cached = ?, dates_failed = ?, status = ?, error = ? WHERE id = ?`),
    lastRun: db.prepare(`SELECT * FROM runs WHERE provider = ? AND data_mode = ? AND route_key = ? ORDER BY id DESC LIMIT 1`),
    lastOkRun: db.prepare(`SELECT * FROM runs WHERE provider = ? AND data_mode = ? AND route_key = ? AND dates_ok > 0 ORDER BY id DESC LIMIT 1`),
    upsertDate: db.prepare(`INSERT INTO date_results (provider, data_mode, route_key, departure_date, fetched_at, provider_updated_at, offer_count, min_total, currency, offers_json, booking_search_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (provider, data_mode, route_key, departure_date) DO UPDATE SET
        fetched_at = excluded.fetched_at, provider_updated_at = excluded.provider_updated_at, offer_count = excluded.offer_count,
        min_total = excluded.min_total, currency = excluded.currency, offers_json = excluded.offers_json, booking_search_url = excluded.booking_search_url`),
    allDates: db.prepare(`SELECT * FROM date_results WHERE provider = ? AND data_mode = ? AND route_key = ?`),
    insertSnap: db.prepare(`INSERT INTO date_snapshots (run_id, provider, data_mode, route_key, departure_date, min_total, currency, offer_count, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertObs: db.prepare(`INSERT INTO offer_observations (run_id, provider, data_mode, route_key, fingerprint, departure_date, total_price, currency, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    dateHistory: db.prepare(`SELECT observed_at AS observedAt, min_total AS minTotal, currency, offer_count AS offerCount FROM date_snapshots
      WHERE provider = ? AND data_mode = ? AND route_key = ? AND departure_date = ? ORDER BY observed_at ASC, id ASC`),
    dateStats: db.prepare(`WITH ranked AS (
        SELECT departure_date, min_total, observed_at,
          ROW_NUMBER() OVER (PARTITION BY departure_date ORDER BY observed_at DESC, id DESC) AS rn
        FROM date_snapshots WHERE provider = ? AND data_mode = ? AND route_key = ? AND min_total IS NOT NULL AND currency = 'EUR')
      SELECT departure_date AS date, MIN(min_total) AS lowest, MAX(min_total) AS highest, COUNT(*) AS samples,
        MAX(CASE WHEN rn = 2 THEN min_total END) AS previous,
        MAX(CASE WHEN rn = 1 THEN min_total END) AS latest
      FROM ranked GROUP BY departure_date`),
    offerStats: db.prepare(`WITH ranked AS (
        SELECT fingerprint, total_price, ROW_NUMBER() OVER (PARTITION BY fingerprint ORDER BY observed_at DESC, id DESC) AS rn
        FROM offer_observations WHERE provider = ? AND data_mode = ? AND route_key = ? AND currency = 'EUR' AND departure_date >= ? AND departure_date <= ?)
      SELECT fingerprint, MIN(total_price) AS lowest, MAX(total_price) AS highest, COUNT(*) AS samples,
        MAX(CASE WHEN rn = 2 THEN total_price END) AS previous
      FROM ranked GROUP BY fingerprint`),
    offerHistory: db.prepare(`SELECT observed_at AS observedAt, total_price AS totalPrice, currency FROM offer_observations
      WHERE provider = ? AND data_mode = ? AND route_key = ? AND fingerprint = ? ORDER BY observed_at ASC, id ASC`),
    overallLow: db.prepare(`SELECT MIN(min_total) AS lowest, MAX(min_total) AS highest FROM date_snapshots WHERE provider = ? AND data_mode = ? AND route_key = ? AND currency = 'EUR'`),
    bumpCalls: db.prepare(`INSERT INTO provider_calls (day, provider, calls) VALUES (?, ?, 1) ON CONFLICT (day, provider) DO UPDATE SET calls = calls + 1`),
    getCalls: db.prepare(`SELECT calls FROM provider_calls WHERE day = ? AND provider = ?`),
  };

  return {
    raw: db,
    startRun({ provider, dataMode, routeKey, trigger, startedAt, datesTotal }) {
      return Number(q.startRun.run(provider, dataMode, routeKey, trigger, startedAt, datesTotal).lastInsertRowid);
    },
    finishRun(id, { finishedAt, ok, cached, failed, status, error = null }) {
      q.finishRun.run(finishedAt, ok, cached, failed, status, error, id);
    },
    lastRun: (scope) => q.lastRun.get(scope.provider, scope.dataMode, scope.routeKey) || null,
    lastSuccessfulRun: (scope) => q.lastOkRun.get(scope.provider, scope.dataMode, scope.routeKey) || null,

    /** Saves the latest per-date result (cache) plus its history rows, atomically. */
    recordDateResult(scope, { runId, date, fetchedAt, providerUpdatedAt, offers, bookingSearchUrl }) {
      const eur = offers.filter((o) => o.currency === 'EUR');
      const min = eur.length ? Math.min(...eur.map((o) => o.totalPrice)) : null;
      db.exec('BEGIN');
      try {
        q.upsertDate.run(scope.provider, scope.dataMode, scope.routeKey, date, fetchedAt, providerUpdatedAt || null, offers.length, min, min === null ? null : 'EUR', JSON.stringify(offers), bookingSearchUrl || null);
        q.insertSnap.run(runId, scope.provider, scope.dataMode, scope.routeKey, date, min, min === null ? null : 'EUR', offers.length, fetchedAt);
        for (const o of offers) {
          q.insertObs.run(runId, scope.provider, scope.dataMode, scope.routeKey, o.fingerprint, date, o.totalPrice, o.currency, fetchedAt);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    loadDateResults(scope) {
      return q.allDates.all(scope.provider, scope.dataMode, scope.routeKey).map((r) => ({
        date: r.departure_date,
        fetchedAt: r.fetched_at,
        providerUpdatedAt: r.provider_updated_at,
        offers: safeParse(r.offers_json),
        bookingSearchUrl: r.booking_search_url,
      }));
    },
    dateHistory: (scope, date) => q.dateHistory.all(scope.provider, scope.dataMode, scope.routeKey, date),
    dateStats: (scope) => q.dateStats.all(scope.provider, scope.dataMode, scope.routeKey),
    offerStats: (scope, from, to) => q.offerStats.all(scope.provider, scope.dataMode, scope.routeKey, from, to),
    offerHistory: (scope, fp) => q.offerHistory.all(scope.provider, scope.dataMode, scope.routeKey, fp),
    overall: (scope) => q.overallLow.get(scope.provider, scope.dataMode, scope.routeKey),
    countCall(day, provider) {
      q.bumpCalls.run(day, provider);
    },
    callsToday: (day, provider) => q.getCalls.get(day, provider)?.calls ?? 0,
    close: () => db.close(),
  };
}

function safeParse(text) {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
