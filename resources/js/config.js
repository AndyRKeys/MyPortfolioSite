// Single source of truth for dev-environment detection (hostname + port).
// Consumed by dev-env.js so the heuristic lives in exactly one place.
export const isDev =
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1' ||
  window.location.port === '3001';

// Before:
// export const API_BASE = isDev ? `http://${window.location.hostname}:8080` : '/api';

// After: always go through /api (dev and prod)
export const API_BASE = '/api';

// Deprecated alias remains:
export const API = API_BASE;
