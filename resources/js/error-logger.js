/**
 * Global error logger — forwards client-side problems to /debug/errors so
 * prod issues are diagnosable without manual devtools inspection.
 *
 * Captures:
 *   - uncaught JS errors            (window 'error', bubble phase)
 *   - resource-load failures        (window 'error', capture phase — #332)
 *   - unhandled promise rejections  (window 'unhandledrejection')
 *   - CSP violations                (securitypolicyviolation)
 *   - explicit console.error/warn   (caught errors devs log by hand)
 *
 * Delivery is resilient (#334): failed sends are buffered in localStorage
 * (bounded) and flushed on load + after each successful send. logToBackend
 * swallows its own errors silently and a `sending` guard prevents re-entrant
 * fetch storms, so there is no recursion path even with the backend down.
 */

import { API_BASE } from './config.js';

// Load signal — a plain console.log (console.log is not overridden, so no
// recursion). The post-deploy error-logger test greps for this line to confirm
// the module initialised on every page.
console.log('[error-logger] Initializing global error logger');

const ENDPOINT = `${API_BASE}/debug/errors`;

// ── Request-ID correlation (#336) ─────────────────────────────────────────
// A stable ID for this page view — groups all errors from the same session
// so a spike of related reports is easy to identify in the server log.
const SESSION_ID = crypto.randomUUID();

// Track the most recent X-Request-Id seen from any API response. When an
// error fires shortly after an API call, this lets us correlate the frontend
// report with the exact backend log line (req.id from pino-http).
let _lastRequestId = null;
let _lastRequestTime = 0;

function getRecentRequestId() {
  // Discard after 10 s — too stale to be meaningfully correlated.
  return (Date.now() - _lastRequestTime < 10_000) ? _lastRequestId : null;
}

// Wrap window.fetch to harvest X-Request-Id from API responses.
// Uses the original fetch for all actual network I/O — no behaviour change.
const _originalFetch = window.fetch.bind(window);
window.fetch = async function (...args) {
  const response = await _originalFetch(...args);
  const rid = response.headers.get('X-Request-Id');
  if (rid) {
    _lastRequestId = rid;
    _lastRequestTime = Date.now();
  }
  return response;
};

// Attach correlation fields to every outgoing payload.
function withCorrelation(payload) {
  return { ...payload, sessionId: SESSION_ID, requestId: getRecentRequestId() };
}

// ── Extension-noise filter (#356) ──────────────────────────────────────────
// Browser extension content scripts run in the page's window context, so their
// uncaught errors (e.g. require('fs')/require('zlib') in Node-targeting
// extensions) bubble to our handlers. They are not site errors — discard them
// before they reach the dedup/send pipeline so they never pollute /debug/errors
// or contribute to alert thresholds (#333).
const EXTENSION_URL = /^(chrome|moz|safari)-extension:\/\//;

function isExtensionUrl(url) {
  return typeof url === 'string' && EXTENSION_URL.test(url);
}

// ── Dedup / buffer / send ──────────────────────────────────────────────────
// Suppress duplicate reports within a page view.
const seenErrors = new Set();
const MAX_STORED_ERRORS = 100;

// Persisted buffer for reports that fail to send (e.g. backend unreachable).
// Bounded so it can never grow without limit.
const BUFFER_KEY = 'errlog:buffer';
const BUFFER_MAX = 20;

let sending = false;

function readBuffer() {
  try {
    return JSON.parse(localStorage.getItem(BUFFER_KEY) || '[]');
  } catch (_) {
    return [];
  }
}

function writeBuffer(items) {
  try {
    localStorage.setItem(BUFFER_KEY, JSON.stringify(items.slice(-BUFFER_MAX)));
  } catch (_) {
    // localStorage full or disabled — drop silently.
  }
}

function buffer(payload) {
  const items = readBuffer();
  items.push(payload);
  writeBuffer(items);
}

// Single fetch attempt. Returns true only on a 2xx response. keepalive lets
// the report survive page unload/navigation.
async function send(payload) {
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    });
    return res.ok;
  } catch (_) {
    return false;
  }
}

// Best-effort drain of the persisted buffer. Entries that still fail are
// re-buffered for the next attempt. Uses send() directly (not logToBackend)
// so it bypasses the dedup/guard machinery.
async function flushBuffer() {
  const items = readBuffer();
  if (!items.length) return;
  const remaining = [];
  for (const item of items) {
    if (!(await send(item))) remaining.push(item);
  }
  writeBuffer(remaining);
}

async function logToBackend(payload) {
  // A send is already in flight — buffer rather than drop (#334). The guard
  // still prevents concurrent fetch storms from cascading errors.
  if (sending) {
    buffer(payload);
    return;
  }
  sending = true;
  try {
    if (await send(payload)) {
      // Connectivity is good — opportunistically drain any backlog.
      await flushBuffer();
    } else {
      buffer(payload);
    }
  } finally {
    sending = false;
  }
}

function dedupAndLog(key, payload) {
  if (seenErrors.has(key)) return;
  seenErrors.add(key);
  if (seenErrors.size > MAX_STORED_ERRORS) seenErrors.clear();
  logToBackend(payload);
}

// Uncaught runtime errors (bubble phase). event.target is window here.
window.addEventListener('error', (event) => {
  // Skip errors thrown by browser extension content scripts (#356).
  if (isExtensionUrl(event.filename)) return;
  const key = `${event.filename}:${event.lineno}:${event.message}`;
  dedupAndLog(key, withCorrelation({
    type: 'uncaught-error',
    timestamp: new Date().toISOString(),
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    stack: event.error?.stack || 'no stack trace',
    url: window.location.href,
  }));
});

// Resource-load failures (script/img/link/css that 404 or fail to fetch) fire
// an 'error' event ON THE ELEMENT and do NOT bubble, so they are only visible
// in the capture phase — the bubble listener above never sees them. This is
// the exact class of failure behind #330. (#332)
window.addEventListener('error', (event) => {
  const target = event.target;
  if (!target || !(target instanceof HTMLElement)) return; // runtime errors handled above
  const resourceUrl = target.src || target.href;
  // Skip missing URLs and extension-injected resources (#356).
  if (!resourceUrl || isExtensionUrl(resourceUrl)) return;
  const tag = target.tagName.toLowerCase();
  dedupAndLog(`resource:${tag}:${resourceUrl}`, withCorrelation({
    type: 'resource-error',
    timestamp: new Date().toISOString(),
    // message + filename map onto the fields /debug/errors already logs.
    message: `Failed to load <${tag}>: ${resourceUrl}`,
    filename: resourceUrl,
    url: window.location.href,
  }));
}, true); // capture: true — required for non-bubbling resource errors

window.addEventListener('unhandledrejection', (event) => {
  const key = `promise:${String(event.reason).slice(0, 100)}`;
  dedupAndLog(key, withCorrelation({
    type: 'unhandled-rejection',
    timestamp: new Date().toISOString(),
    reason: String(event.reason),
    stack: event.reason?.stack || 'no stack trace',
    url: window.location.href,
  }));
});

// CSP violations — ISP-injected inline scripts will trigger this. That is
// expected behaviour (blocking 3rd-party injection is correct). The report
// is forwarded so we have a server-side record when it occurs.
window.addEventListener('securitypolicyviolation', (event) => {
  const key = `csp:${event.violatedDirective}:${event.blockedURI}`;
  dedupAndLog(key, withCorrelation({
    type: 'csp-violation',
    timestamp: new Date().toISOString(),
    'violated-directive': event.violatedDirective,
    'blocked-uri': event.blockedURI,
    'document-uri': event.documentURI,
    'source-file': event.sourceFile,
    'line-number': event.lineNumber,
    'column-number': event.columnNumber,
  }));
});

// console.error/warn overrides — capture caught errors devs log explicitly
// (e.g. inside try/catch). These never reach window.onerror, so without the
// override they would be invisible in prod. Safe because send() swallows its
// own failures and the `sending` guard blocks re-entrancy.
const _origError = console.error;
const _origWarn = console.warn;

console.error = function (...args) {
  _origError.apply(console, args);
  const message = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  dedupAndLog(`console-error:${message.slice(0, 100)}`, withCorrelation({
    type: 'console-error',
    timestamp: new Date().toISOString(),
    message,
    url: window.location.href,
    stack: new Error().stack,
  }));
};

console.warn = function (...args) {
  _origWarn.apply(console, args);
  const message = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  dedupAndLog(`console-warn:${message.slice(0, 100)}`, withCorrelation({
    type: 'console-warn',
    timestamp: new Date().toISOString(),
    message,
    url: window.location.href,
  }));
};

// Drain any reports buffered from a previous page view where the backend was
// unreachable. (#334)
flushBuffer();
