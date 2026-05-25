/**
 * Global error logger — captures uncaught JS errors, unhandled rejections,
 * and CSP violations, forwarding them to the backend for debugging.
 *
 * Deliberately does NOT override console.error/warn — that pattern creates
 * recursion risk (a failed fetch calls console.error → triggers the override
 * → fires another fetch) and interferes with browser devtools. Use the
 * window 'error' event for production-visible errors instead.
 */

import { API_BASE } from './config.js';

// Track seen keys to suppress duplicate reports.
const seenErrors = new Set();
const MAX_STORED_ERRORS = 100;

// Guard to prevent re-entrant calls (e.g., logToBackend itself throwing).
let sending = false;

async function logToBackend(errorData) {
  if (sending) return;
  sending = true;
  try {
    await fetch(`${API_BASE}/debug/errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(errorData),
    });
  } catch (_) {
    // Swallow — no console.error here to avoid recursion.
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

// console.error/warn overrides — capture caught errors that developers
// explicitly log (e.g. inside try/catch blocks). These never reach window.onerror
// so without this override they would be invisible in prod logs.
//
// Safe because logToBackend now swallows its own errors silently (no internal
// console.error call) and the `sending` guard prevents re-entrant calls, so
// there is no recursion path even if the backend is unreachable.
const _origError = console.error;
const _origWarn  = console.warn;

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
