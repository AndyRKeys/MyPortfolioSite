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
  const key = `${event.filename}:${event.lineno}:${event.message}`;
  dedupAndLog(key, {
    type: 'uncaught-error',
    timestamp: new Date().toISOString(),
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    stack: event.error?.stack || 'no stack trace',
    url: window.location.href,
  });
});

// Resource-load failures (script/img/link/css that 404 or fail to fetch) fire
// an 'error' event ON THE ELEMENT and do NOT bubble, so they are only visible
// in the capture phase — the bubble listener above never sees them. This is
// the exact class of failure behind #330. (#332)
window.addEventListener('error', (event) => {
  const target = event.target;
  if (!target || !(target instanceof HTMLElement)) return; // runtime errors handled above
  const resourceUrl = target.src || target.href;
  if (!resourceUrl) return;
  const tag = target.tagName.toLowerCase();
  dedupAndLog(`resource:${tag}:${resourceUrl}`, {
    type: 'resource-error',
    timestamp: new Date().toISOString(),
    // message + filename map onto the fields /debug/errors already logs.
    message: `Failed to load <${tag}>: ${resourceUrl}`,
    filename: resourceUrl,
    url: window.location.href,
  });
}, true); // capture: true — required for non-bubbling resource errors

window.addEventListener('unhandledrejection', (event) => {
  const key = `promise:${String(event.reason).slice(0, 100)}`;
  dedupAndLog(key, {
    type: 'unhandled-rejection',
    timestamp: new Date().toISOString(),
    reason: String(event.reason),
    stack: event.reason?.stack || 'no stack trace',
    url: window.location.href,
  });
});

// CSP violations — ISP-injected inline scripts will trigger this. That is
// expected behaviour (blocking 3rd-party injection is correct). The report
// is forwarded so we have a server-side record when it occurs.
window.addEventListener('securitypolicyviolation', (event) => {
  const key = `csp:${event.violatedDirective}:${event.blockedURI}`;
  dedupAndLog(key, {
    type: 'csp-violation',
    timestamp: new Date().toISOString(),
    'violated-directive': event.violatedDirective,
    'blocked-uri': event.blockedURI,
    'document-uri': event.documentURI,
    'source-file': event.sourceFile,
    'line-number': event.lineNumber,
    'column-number': event.columnNumber,
  });
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
  dedupAndLog(`console-error:${message.slice(0, 100)}`, {
    type: 'console-error',
    timestamp: new Date().toISOString(),
    message,
    url: window.location.href,
    stack: new Error().stack,
  });
};

console.warn = function (...args) {
  _origWarn.apply(console, args);
  const message = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  dedupAndLog(`console-warn:${message.slice(0, 100)}`, {
    type: 'console-warn',
    timestamp: new Date().toISOString(),
    message,
    url: window.location.href,
  });
};

// Drain any reports buffered from a previous page view where the backend was
// unreachable. (#334)
flushBuffer();
