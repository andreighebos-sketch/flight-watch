import { ROUTE_KEY, SEARCH } from './constants.js';
import { generateDateRange, utcDayKey } from './dates.js';
import { ErrorKind, FATAL_KINDS, ProviderError, sleep } from './http.js';
import { dedupeCheapest } from './normalize.js';
import { cheapestByDate, computeStats, sortOffers } from './shared/offer-logic.js';

const MANUAL_MIN_AGE_MINUTES = 10; // manual refresh skips dates fetched less than 10 min ago
const round2 = (v) => Math.round(v * 100) / 100;

function toPublicError(err) {
  if (err instanceof ProviderError) return { kind: err.kind, message: err.message, status: err.status };
  return { kind: ErrorKind.SERVER, message: err?.message || String(err), status: null };
}

/**
 * Orchestrates sweeps over the 27 departure dates: freshness-aware cache,
 * bounded concurrency with request spacing, per-date isolation of failures,
 * daily request budget, persistence of every real observation.
 */
export function createMonitor({ config, provider, store, currency, clock = () => Date.now(), logger = console }) {
  const dates = generateDateRange(SEARCH.startDate, SEARCH.endDate);
  const dateSet = new Set(dates);
  const scope = { provider: provider.id, dataMode: provider.dataMode, routeKey: ROUTE_KEY };
  const state = new Map(dates.map((d) => [d, { date: d, offers: [], fetchedAt: null, providerUpdatedAt: null, bookingSearchUrl: null, lastAttemptAt: null, lastError: null, outcome: 'never', pending: null, skippedItems: 0 }]));

  for (const r of store.loadDateResults(scope)) {
    if (!dateSet.has(r.date)) continue;
    Object.assign(state.get(r.date), { offers: r.offers, fetchedAt: r.fetchedAt, providerUpdatedAt: r.providerUpdatedAt, bookingSearchUrl: r.bookingSearchUrl, outcome: 'ok' });
  }

  const persistedLast = store.lastRun(scope);
  let lastRun = persistedLast ? summarizeRunRow(persistedLast) : null;
  let lastSweepStartedAt = persistedLast ? Date.parse(persistedLast.started_at) : 0;
  let lastManualAt = 0;
  let lastFatal = null;
  let run = null;
  let revision = 1;
  let ticker = null;
  let firstTimer = null;
  const listeners = new Set();

  function summarizeRunRow(r) {
    return { id: r.id, trigger: r.trigger, startedAt: r.started_at, finishedAt: r.finished_at, total: r.dates_total, ok: r.dates_ok, cached: r.dates_cached, failed: r.dates_failed, status: r.status, error: r.error };
  }

  const ageMs = (st) => (st.fetchedAt ? clock() - Date.parse(st.fetchedAt) : Infinity);
  const bump = () => {
    revision += 1;
    for (const fn of listeners) fn(revision);
  };

  function checkBudget() {
    if (config.dailyRequestLimit > 0) {
      const used = store.callsToday(utcDayKey(new Date(clock())), provider.id);
      if (used >= config.dailyRequestLimit) {
        throw new ProviderError(`Daily request budget reached (${used}/${config.dailyRequestLimit} provider calls today, DAILY_REQUEST_LIMIT). Cached results remain visible.`, { kind: ErrorKind.BUDGET, provider: provider.id });
      }
    }
  }

  async function searchOne(date, r) {
    const st = state.get(date);
    st.pending = 'searching';
    bump();
    try {
      checkBudget();
      store.countCall(utcDayKey(new Date(clock())), provider.id);
      const result = await provider.searchDate(date, { signal: r.controller.signal });
      if (result.mode && result.mode !== 'unknown' && result.mode !== scope.dataMode) {
        throw new ProviderError(`Provider answered in ${result.mode} mode but the app is configured for ${scope.dataMode}. Check your token.`, { kind: ErrorKind.CONFIG, provider: provider.id });
      }
      await currency.convertOffers(result.offers);
      const offers = sortOffers(dedupeCheapest(result.offers), 'cheapest').slice(0, config.maxOffersPerDate);
      const fetchedAt = result.fetchedAt || new Date(clock()).toISOString();
      store.recordDateResult(scope, { runId: r.id, date, fetchedAt, providerUpdatedAt: result.providerUpdatedAt, offers, bookingSearchUrl: result.googleFlightsUrl });
      Object.assign(st, { offers, fetchedAt, providerUpdatedAt: result.providerUpdatedAt || fetchedAt, bookingSearchUrl: result.googleFlightsUrl || null, lastError: null, outcome: 'ok', skippedItems: result.skipped || 0 });
      r.ok += 1;
    } catch (err) {
      const pub = toPublicError(err);
      if (pub.kind === ErrorKind.ABORTED) {
        st.outcome = 'skipped';
      } else {
        st.lastError = pub;
        st.outcome = 'error';
        if (FATAL_KINDS.has(pub.kind) && !r.abort) {
          r.abort = pub;
          lastFatal = { ...pub, at: new Date(clock()).toISOString() };
        }
        logger.warn?.(`[monitor] ${date}: ${pub.kind} — ${pub.message}`);
      }
      r.failed += 1;
    } finally {
      st.lastAttemptAt = new Date(clock()).toISOString();
      st.pending = null;
      r.checked += 1;
      bump();
    }
  }

  async function executeRun(r, toFetch) {
    const queue = [...toFetch];
    let nextSlot = 0;
    const skip = (date) => {
      const st = state.get(date);
      st.pending = null;
      st.outcome = 'skipped';
      st.lastError = { kind: r.abort.kind, message: `Not checked: ${r.abort.message}`, status: null };
      r.failed += 1;
      r.checked += 1;
      bump();
    };
    const worker = async () => {
      while (queue.length) {
        const date = queue.shift();
        if (r.abort) {
          skip(date);
          continue;
        }
        const slot = Math.max(clock(), nextSlot); // reserve a start slot synchronously
        nextSlot = slot + config.minSpacingMs;
        const wait = slot - clock();
        if (wait > 0) await sleep(wait).catch(() => {});
        if (r.abort) {
          skip(date);
          continue;
        }
        await searchOne(date, r);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(config.concurrency, Math.max(queue.length, 1)) }, worker));
    } finally {
      const status = r.abort ? 'aborted' : r.failed === 0 ? 'ok' : r.ok + r.cached > 0 ? 'partial' : 'failed';
      const finishedAt = new Date(clock()).toISOString();
      store.finishRun(r.id, { finishedAt, ok: r.ok, cached: r.cached, failed: r.failed, status, error: r.abort?.message || null });
      if (!r.abort && r.ok > 0) lastFatal = null;
      lastRun = { id: r.id, trigger: r.trigger, startedAt: r.startedAt, finishedAt, total: r.total, ok: r.ok, cached: r.cached, failed: r.failed, status, error: r.abort?.message || null };
      run = null;
      bump();
    }
  }

  function refresh({ trigger = 'manual', force = false } = {}) {
    if (!provider.isConfigured) return { started: false, reason: 'missing_key' };
    if (run) return { started: false, reason: 'running' };
    const nowMs = clock();
    if (trigger === 'manual') {
      const wait = lastManualAt + config.manualRefreshCooldownSeconds * 1000 - nowMs;
      if (wait > 0) return { started: false, reason: 'cooldown', retryInSeconds: Math.ceil(wait / 1000) };
      lastManualAt = nowMs;
    }
    const maxAgeMs = (force ? Math.min(MANUAL_MIN_AGE_MINUTES, config.cacheTtlMinutes) : config.cacheTtlMinutes) * 60000;
    const toFetch = [];
    let cached = 0;
    for (const d of dates) {
      const st = state.get(d);
      if (st.outcome === 'ok' && ageMs(st) < maxAgeMs) cached += 1;
      else {
        toFetch.push(d);
        st.pending = 'queued';
      }
    }
    const startedAt = new Date(nowMs).toISOString();
    const id = store.startRun({ ...scope, trigger, startedAt, datesTotal: dates.length });
    run = { id, trigger, startedAt, total: dates.length, toFetch: toFetch.length, checked: cached, cached, ok: 0, failed: 0, abort: null, controller: new AbortController() };
    lastSweepStartedAt = nowMs;
    bump();
    const promise = executeRun(run, toFetch).catch((err) => logger.error?.('[monitor] run crashed', err));
    return { started: true, runId: id, toFetch: toFetch.length, cached, promise };
  }

  function nextAutoRefreshAt() {
    if (!config.autoRefresh || !provider.isConfigured) return null;
    return new Date(Math.max(lastSweepStartedAt + config.refreshIntervalMinutes * 60000, clock())).toISOString();
  }

  function getStatus() {
    const okDates = dates.filter((d) => state.get(d).outcome === 'ok' || state.get(d).fetchedAt);
    const fetched = dates.map((d) => state.get(d).fetchedAt).filter(Boolean).sort();
    const providerTimes = dates.map((d) => state.get(d).providerUpdatedAt).filter(Boolean).sort();
    const nowMs = clock();
    return {
      revision,
      provider: { id: provider.id, label: provider.label, dataMode: provider.dataMode, website: provider.website, configured: provider.isConfigured, setup: provider.isConfigured ? null : provider.setupHelp },
      running: run ? { id: run.id, trigger: run.trigger, startedAt: run.startedAt, total: run.total, toFetch: run.toFetch, checked: run.checked, ok: run.ok, cached: run.cached, failed: run.failed } : null,
      lastRun,
      lastFatalError: lastFatal,
      lastSuccessfulUpdateAt: fetched.at(-1) || null,
      oldestDataAt: fetched[0] || null,
      lastProviderUpdateAt: providerTimes.at(-1) || null,
      datesWithData: okDates.length,
      totalDates: dates.length,
      refresh: {
        intervalMinutes: config.refreshIntervalMinutes,
        cacheTtlMinutes: config.cacheTtlMinutes,
        auto: config.autoRefresh,
        nextAutoRefreshAt: nextAutoRefreshAt(),
        manualCooldownSeconds: config.manualRefreshCooldownSeconds,
        manualAvailableInSeconds: Math.max(0, Math.ceil((lastManualAt + config.manualRefreshCooldownSeconds * 1000 - nowMs) / 1000)),
      },
      budget: { dailyLimit: config.dailyRequestLimit, usedToday: store.callsToday(utcDayKey(new Date(nowMs)), provider.id) },
      serverTime: new Date(nowMs).toISOString(),
    };
  }

  function getResults() {
    const all = dates.flatMap((d) => state.get(d).offers);
    const offerStats = new Map(store.offerStats(scope, SEARCH.startDate, SEARCH.endDate).map((s) => [s.fingerprint, s]));
    const offers = sortOffers(all, 'cheapest').map((o) => {
      const s = offerStats.get(o.fingerprint);
      const previous = s?.previous ?? null;
      return {
        ...o,
        priceHistory: {
          previous,
          change: previous !== null && o.currency === 'EUR' ? round2(o.totalPrice - previous) : null,
          lowest: s?.lowest ?? null,
          highest: s?.highest ?? null,
          samples: s?.samples ?? 0,
        },
      };
    });
    const dStats = new Map(store.dateStats(scope).map((s) => [s.date, s]));
    const perDate = cheapestByDate(offers, dates).map(({ date, minPrice, offer }) => {
      const st = state.get(date);
      const s = dStats.get(date);
      const previous = s?.previous ?? null;
      return {
        date,
        minPrice,
        currency: minPrice === null ? null : 'EUR',
        cheapestFingerprint: offer?.fingerprint || null,
        offerCount: st.offers.length,
        fetchedAt: st.fetchedAt,
        lastAttemptAt: st.lastAttemptAt,
        outcome: st.outcome,
        pending: st.pending,
        error: st.lastError,
        bookingSearchUrl: st.bookingSearchUrl,
        previousMin: previous,
        change: previous !== null && minPrice !== null && s?.latest === minPrice ? round2(minPrice - previous) : null,
        lowestSeen: s?.lowest ?? null,
        highestSeen: s?.highest ?? null,
        samples: s?.samples ?? 0,
      };
    });
    const priced = perDate.filter((d) => d.minPrice !== null);
    const cheapestDate = priced.reduce((best, d) => (!best || d.minPrice < best.minPrice ? d : best), null);
    const overall = store.overall(scope);
    return {
      search: { ...SEARCH, dates },
      status: getStatus(),
      stats: { ...computeStats(offers), cheapestDate: cheapestDate?.date || null, lowestSeen: overall?.lowest ?? null, highestSeen: overall?.highest ?? null },
      dates: perDate,
      offers,
    };
  }

  function getDateHistory(date) {
    return { date, points: store.dateHistory(scope, date) };
  }

  function getOfferHistory(fingerprint) {
    return { fingerprint, points: store.offerHistory(scope, fingerprint) };
  }

  function start() {
    if (!config.autoRefresh || !provider.isConfigured) return;
    firstTimer = setTimeout(() => refresh({ trigger: 'startup' }), 1500);
    ticker = setInterval(() => {
      if (!run && clock() - lastSweepStartedAt >= config.refreshIntervalMinutes * 60000) refresh({ trigger: 'auto' });
    }, 30_000);
    ticker.unref?.();
  }

  function stop() {
    clearTimeout(firstTimer);
    clearInterval(ticker);
    run?.controller.abort();
  }

  return { dates, scope, refresh, getStatus, getResults, getDateHistory, getOfferHistory, start, stop, onChange: (fn) => (listeners.add(fn), () => listeners.delete(fn)) };
}
