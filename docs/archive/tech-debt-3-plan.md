> ✅ Fully shipped in PR #96 (`feature/issue-79-tech-debt-3`) — archived per doc lifecycle policy.

# Tech Debt 3 — Validation Middleware, Error Shape & Cleanup

**Branch:** `feature/issue-79-tech-debt-3`  
**Issue:** #79 (remaining items)  
**Date:** 2026-05-04

---

## Scope

This branch completes the remaining items from issue #79 after PRs #85 and #86:

| # | Item | Priority | File(s) |
|---|---|---|---|
| 1 | Standardise error response shape to `{ error }` | 🟡 Medium | All routes |
| 2 | Add request validation middleware (Zod) | 🟡 Medium | `backend/middleware/validate.js` + all routes |
| 3 | Register centralised error handler | 🟡 Medium | `backend/middleware/errorHandler.js`, `backend/server.js` |
| 4 | Remove commented-out normalize.css import | 🟢 Low | `index.html` |

---

## Task 1 — Standardise Error Response Shape

**Goal:** Every route returns `{ error: '<message>' }` on failure. No `{ message }` responses.

**Audit each route file for `{ message:` responses and replace:**

- [ ] `backend/routes/auth.js`
- [ ] `backend/routes/contact.js`
- [ ] `backend/routes/posts.js`
- [ ] `backend/routes/travel.js`
- [ ] `backend/routes/stats.js`
- [ ] `backend/routes/upload.js`

**Search command:**

```bash
grep -rn '{ message:' backend/routes/
```

---

## Task 2 — Request Validation Middleware

**Goal:** Replace per-route `if (!field) return res.status(400)...` manual checks with a shared Zod middleware.

### Step 1 — Install Zod

```bash
cd backend && npm install zod
```

### Step 2 — Implement `backend/middleware/validate.js`

```js
const { z } = require('zod');

function validate(schema) {
    return (req, res, next) => {
        const result = schema.safeParse(req.body);
        if (!result.success) {
            const message = result.error.errors.map(e => e.message).join('; ');
            return res.status(400).json({ error: message });
        }
        req.body = result.data; // replace with coerced/defaulted values
        next();
    };
}

module.exports = { validate };
```

### Step 3 — Define schemas (one per mutating route)

Define schemas at the top of each route file, or in a new `backend/schemas/` directory.

**Suggested schemas to define:**

| Route | Method | Schema fields |
|---|---|---|
| `posts.js` | POST | `title` (required), `body_markdown` (required), `post_date` (optional, YYYY-MM-DD), `excerpt` (optional), `slug` (optional) |
| `posts.js` | PUT `:slug` | Same as POST but all optional (partial update) |
| `travel.js` | POST | `title` (required), `location` (optional), `visit_date` (optional), `notes` (optional), `lat` (optional, number), `lng` (optional, number) |
| `travel.js` | PUT `:id` | Same as POST but all optional |
| `contact.js` | POST | `name` (required), `email` (required, email format), `message` (required), `website` (optional, honeypot) |
| `auth.js` | POST email/send | `email` (required, email format) |

### Step 4 — Wire middleware into routes

Replace manual field checks with `validate(Schema)` in the route definition:

```js
// Before
router.post('/', authenticate, async (req, res) => {
    const { title, body_markdown } = req.body;
    if (!title || !body_markdown) return res.status(400).json({ error: 'Missing fields' });
    ...
});

// After
router.post('/', authenticate, validate(CreatePostSchema), async (req, res) => {
    const { title, body_markdown } = req.body; // guaranteed present by middleware
    ...
});
```

---

## Task 3 — Centralised Error Handler

**Goal:** Unhandled errors thrown in async route handlers return `{ error }` rather than crashing or returning HTML stack traces.

### Step 1 — Implement `backend/middleware/errorHandler.js`

```js
function errorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);
    const status = err.status || err.statusCode || 500;
    const message = err.message || 'Internal server error';
    if (process.env.NODE_ENV !== 'test') console.error('[ERROR]', err);
    res.status(status).json({ error: message });
}

module.exports = { errorHandler };
```

### Step 2 — Register in `backend/server.js`

```js
const { errorHandler } = require('./middleware/errorHandler');
// ... all route registrations ...
app.use(errorHandler); // must be last
```

### Step 3 — Wrap async routes (optional but recommended)

Async route handlers that throw will not be caught by Express 4 unless wrapped:

```js
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
```

Apply to all `async (req, res)` route handlers, or upgrade to Express 5 which handles this natively.

---

## Task 4 — Remove Commented-Out normalize.css Import

**File:** `index.html` line 6  
**Action:** Delete the commented-out `<link rel="stylesheet" href="reset.css">` or normalize.css line.  
**Risk:** None — it is already commented out and has no effect.

---

## Commit Strategy

```text
refactor(errors): standardise all route error responses to { error } shape
feat(validation): implement Zod validate() middleware
refactor(routes): replace manual field checks with validate() middleware
feat(errors): add centralised errorHandler middleware, register in server.js
chore: remove commented-out normalize.css import from index.html
```

---

## Out of Scope

- `posts` table nullable column null-checks (callers already guard these; low risk)
- Automated test suite (tracked separately)
- Any frontend changes
