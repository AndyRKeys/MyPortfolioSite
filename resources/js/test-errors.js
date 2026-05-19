/**
 * test-errors.js — Triggers test errors for error-logger verification
 * Used by /api/debug/test-errors endpoint for post-deployment testing
 * Runs after error-logger.js has loaded
 */

import { API_BASE } from './config.js';

// Wait for error logger to load, then trigger test errors
setTimeout(() => {
  console.log('Testing error logger...');

  // Test 1: console.error
  console.error('Test error #1: console.error triggered');

  // Test 2: console.warn
  console.warn('Test error #2: console.warn triggered');

  // Test 3: uncaught error
  setTimeout(() => {
    throw new Error('Test error #3: uncaught JavaScript error');
  }, 100);

  // Test 4: unhandled rejection
  setTimeout(() => {
    Promise.reject(new Error('Test error #4: unhandled promise rejection'));
  }, 200);

  // Report back after errors are logged
  setTimeout(() => {
    fetch(`${API_BASE}/debug/test-complete`, { method: 'POST' }).catch(() => {});
  }, 1000);
}, 500);
