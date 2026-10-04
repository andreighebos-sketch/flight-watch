import { createDemoProvider } from './demo.js';
import { createDuffelProvider } from './duffel.js';
import { createSerpApiProvider } from './serpapi.js';

export function createProvider(config, deps = {}) {
  const opts = { timeoutMs: config.requestTimeoutMs, ...deps };
  switch (config.provider) {
    case 'serpapi':
      return createSerpApiProvider(config.serpapi, opts);
    case 'duffel':
      return createDuffelProvider(config.duffel, opts);
    case 'demo':
      return createDemoProvider();
    default:
      throw new Error(`Unknown provider ${config.provider}`);
  }
}
