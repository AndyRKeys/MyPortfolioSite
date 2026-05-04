// ── Request validation middleware (issue #79 — tech-debt-3) ──────────────────
//
// TODO: Install Zod:  npm install zod  (in backend/)
//
// Usage in a route:
//   const { validate } = require('../middleware/validate');
//   const { z } = require('zod');
//
//   const CreatePostSchema = z.object({
//       title:      z.string().min(1),
//       slug:       z.string().min(1).optional(),
//       body_markdown: z.string().min(1),
//       post_date:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
//       excerpt:    z.string().optional(),
//       post_type:  z.enum(['blog', 'travel']).default('blog'),
//   });
//
//   router.post('/', authenticate, validate(CreatePostSchema), async (req, res) => { ... });
//
// The middleware replaces manual `if (!title) return res.status(400).json(...)` checks
// in each route handler.

// TODO: Implement validate() middleware
// Shape: (schema) => (req, res, next) => void
// On failure: return res.status(400).json({ error: <zod formatted message> })
// On success: call next()

module.exports = {
    // validate: (schema) => (req, res, next) => { ... }
};
