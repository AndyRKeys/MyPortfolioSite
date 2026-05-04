// ── Centralised error handler (issue #79 — tech-debt-3) ──────────────────────
//
// Standardises all error responses to: { error: '<message>' }
// Replaces the current mix of { error } and { message } shapes across routes.
//
// Usage — register LAST in server.js, after all routes:
//   const { errorHandler } = require('./middleware/errorHandler');
//   app.use(errorHandler);
//
// In route handlers, replace:
//   return res.status(400).json({ message: 'Not found' });   // ❌ inconsistent
// with:
//   return res.status(400).json({ error: 'Not found' });     // ✅ standardised
// or throw to the handler:
//   next(Object.assign(new Error('Not found'), { status: 400 }));

// TODO: Implement errorHandler middleware
// Shape: (err, req, res, next) => void  (4-arg Express error handler)
// Always responds with { error: err.message || 'Internal server error' }
// Uses err.status or err.statusCode if set, otherwise 500
// Logs err to console.error in non-test environments

module.exports = {
    // errorHandler: (err, req, res, next) => { ... }
};
