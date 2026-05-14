/**
 * Global error logger — captures all console errors/warnings and sends to backend
 * Useful for debugging production issues without requiring manual console inspection
 */

import { API_BASE } from './config.js';

console.log('[error-logger] Initializing global error logger');

// Track errors to avoid logging duplicates (same error multiple times)
const seenErrors = new Set();
const MAX_STORED_ERRORS = 100;

// Send error to backend
async function logToBackend(errorData) {
  try {
    console.log(`[error-logger] Sending ${errorData.type} to ${API_BASE}/debug/errors`);
    const response = await fetch(`${API_BASE}/debug/errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(errorData),
    });

    if (!response.ok) {
      console.error(`[error-logger] Server responded with HTTP ${response.status}: ${response.statusText}`);
      const text = await response.text();
      if (text) console.error(`[error-logger] Response body: ${text}`);
    } else {
      console.log(`[error-logger] ${errorData.type} sent successfully`);
    }
  } catch (e) {
    console.error('[error-logger] Fetch failed:', e.message);
  }
}

// Capture uncaught JavaScript errors
window.addEventListener('error', (event) => {
  const errorKey = `${event.filename}:${event.lineno}:${event.message}`;
  if (seenErrors.has(errorKey)) return;
  seenErrors.add(errorKey);
  if (seenErrors.size > MAX_STORED_ERRORS) seenErrors.clear();

  logToBackend({
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

// Capture unhandled promise rejections
window.addEventListener('unhandledrejection', (event) => {
  const errorKey = `promise:${String(event.reason).slice(0, 100)}`;
  if (seenErrors.has(errorKey)) return;
  seenErrors.add(errorKey);
  if (seenErrors.size > MAX_STORED_ERRORS) seenErrors.clear();

  logToBackend({
    type: 'unhandled-rejection',
    timestamp: new Date().toISOString(),
    reason: String(event.reason),
    stack: event.reason?.stack || 'no stack trace',
    url: window.location.href,
  });
});

// Intercept console.error and console.warn
const originalError = console.error;
const originalWarn = console.warn;

console.error = function(...args) {
  originalError.apply(console, args);

  const message = args.map(arg => {
    if (typeof arg === 'object') return JSON.stringify(arg);
    return String(arg);
  }).join(' ');

  const errorKey = `console-error:${message.slice(0, 100)}`;
  if (!seenErrors.has(errorKey)) {
    seenErrors.add(errorKey);
    if (seenErrors.size > MAX_STORED_ERRORS) seenErrors.clear();

    logToBackend({
      type: 'console-error',
      timestamp: new Date().toISOString(),
      message: message,
      url: window.location.href,
      stack: new Error().stack,
    });
  }
};

console.warn = function(...args) {
  originalWarn.apply(console, args);

  const message = args.map(arg => {
    if (typeof arg === 'object') return JSON.stringify(arg);
    return String(arg);
  }).join(' ');

  const errorKey = `console-warn:${message.slice(0, 100)}`;
  if (!seenErrors.has(errorKey)) {
    seenErrors.add(errorKey);
    if (seenErrors.size > MAX_STORED_ERRORS) seenErrors.clear();

    logToBackend({
      type: 'console-warn',
      timestamp: new Date().toISOString(),
      message: message,
      url: window.location.href,
    });
  }
};

// Capture CSP (Content-Security-Policy) violations
// These occur when a resource is blocked by security policy (e.g., loading from disallowed domain)
window.addEventListener('securitypolicyviolation', (event) => {
  const cspKey = `csp:${event.violatedDirective}:${event.blockedURI}`;
  if (seenErrors.has(cspKey)) return;
  seenErrors.add(cspKey);
  if (seenErrors.size > MAX_STORED_ERRORS) seenErrors.clear();

  console.warn(`CSP Violation: ${event.violatedDirective} blocked ${event.blockedURI}`);

  logToBackend({
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

// Provide manual export function for debugging
window.exportErrors = function() {
  const errors = JSON.parse(localStorage.getItem('frontendErrors') || '[]');
  console.log('Frontend errors:', errors);
  const blob = new Blob([JSON.stringify(errors, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `errors-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
};
