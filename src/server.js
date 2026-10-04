import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { ROOT_DIR, loadEnvFile, readConfig } from './config.js';
import { createCurrencyConverter } from './currency.js';
import { openDatabase } from './db.js';
import { formatDuration, isIsoDate } from './dates.js';
import { createMonitor } from './monitor.js';
import { createProvider } from './providers/index.js';
import { sortOffers, SORTS } from './shared/offer-logic.js';

const FINGERPRINT = /^[a-f0-9]{40}$/;

function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection guard
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function offersToCsv(offers) {
  const header = ['departure_date', 'departure_local', 'arrival_local', 'total_duration', 'stops', 'route', 'airlines', 'flight_numbers', 'total_for_2_adults', 'per_person', 'currency', 'self_transfer', 'provider', 'data_mode', 'checked_at', 'booking_url'];
  const rows = offers.map((o) => [
    o.departureDate, o.departureLocal, o.arrivalLocal, formatDuration(o.totalDurationMin), o.stops,
    [o.segments[0].origin.iata, ...o.segments.map((s) => s.destination.iata)].join('-'),
    o.airlines.join(' / '), o.segments.map((s) => s.flightNumber || '').join(' '),
    o.totalPrice.toFixed(2), o.pricePerPerson?.toFixed(2) ?? '', o.currency, o.selfTransfer ? 'yes' : 'no',
    o.sourceLabel, o.dataMode, o.fetchedAt, o.bookingUrl || '',
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function createApp({ monitor }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https://www.gstatic.com; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
    next();
  });
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '1kb', strict: true }));

  app.get('/api/status', (req, res) => res.json(monitor.getStatus()));
  app.get('/api/results', (req, res) => res.json(monitor.getResults()));

  app.post('/api/refresh', (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.force !== undefined && typeof body.force !== 'boolean') return res.status(400).json({ error: 'force must be a boolean' });
    const r = monitor.refresh({ trigger: 'manual', force: body.force !== false });
    if (r.started) return res.status(202).json({ started: true, runId: r.runId, toFetch: r.toFetch, cached: r.cached });
    if (r.reason === 'missing_key') return res.status(409).json({ started: false, reason: r.reason, error: 'Provider credentials are missing — see setup instructions.' });
    if (r.reason === 'cooldown') return res.status(429).json({ started: false, reason: r.reason, retryInSeconds: r.retryInSeconds, error: `Manual refresh is limited; try again in ${r.retryInSeconds} s.` });
    return res.status(409).json({ started: false, reason: r.reason, error: 'A search is already running.' });
  });

  app.get('/api/history/date/:date', (req, res) => {
    const { date } = req.params;
    if (!isIsoDate(date) || !monitor.dates.includes(date)) return res.status(400).json({ error: 'date must be a departure date between 2026-10-20 and 2026-11-15' });
    res.json(monitor.getDateHistory(date));
  });

  app.get('/api/history/offer/:fingerprint', (req, res) => {
    const { fingerprint } = req.params;
    if (!FINGERPRINT.test(fingerprint)) return res.status(400).json({ error: 'invalid fingerprint' });
    res.json(monitor.getOfferHistory(fingerprint));
  });

  app.get('/api/export.csv', (req, res) => {
    const sort = typeof req.query.sort === 'string' && SORTS[req.query.sort] ? req.query.sort : 'cheapest';
    const { offers, status } = monitor.getResults();
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="flight-watch-RMO-CXR-${status.provider.dataMode}.csv"`);
    res.send(offersToCsv(sortOffers(offers, sort)));
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/shared', express.static(path.join(ROOT_DIR, 'src', 'shared'), { index: false }));
  app.use(express.static(path.join(ROOT_DIR, 'public'), { index: 'index.html' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') return res.status(400).json({ error: 'Invalid request body' });
    console.error('[server]', err);
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

export function bootstrap(env = process.env) {
  const config = readConfig(env);
  const store = openDatabase(config.dbPath);
  const provider = createProvider(config);
  const monitor = createMonitor({ config, provider, store, currency: createCurrencyConverter() });
  const app = createApp({ monitor });
  return { config, store, provider, monitor, app };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  loadEnvFile();
  let ctx;
  try {
    ctx = bootstrap();
  } catch (err) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }
  const { config, provider, monitor, app, store } = ctx;
  const server = app.listen(config.port, config.host, () => {
    console.log(`Flight Watch → http://${config.host}:${config.port}`);
    console.log(`Provider: ${provider.label} [${provider.dataMode.toUpperCase()}]${provider.isConfigured ? '' : ` — NOT CONFIGURED (set ${provider.setupHelp.envVar} in .env)`}`);
    console.log(`Auto refresh: ${config.autoRefresh ? `every ${config.refreshIntervalMinutes} min` : 'off'}, cache TTL ${config.cacheTtlMinutes} min, daily request cap ${config.dailyRequestLimit || 'none'}`);
    monitor.start();
  });
  const shutdown = () => {
    monitor.stop();
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
