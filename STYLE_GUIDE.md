# Coding Style Guide

The canonical reference for code style on this project. All contributors (human and AI) must follow these conventions.

> This guide is referenced from [AI.md](./AI.md). When in doubt, check here first.

---

## Table of Contents

1. [Alignment & Whitespace](#alignment--whitespace)
2. [Naming Conventions](#naming-conventions)
3. [JavaScript](#javascript)
4. [CSS](#css)
5. [HTML](#html)
6. [Express / Backend](#express--backend)
7. [Comments](#comments)
8. [Testing](#testing)
9. [Git & Commits](#git--commits)
10. [Security](#security)

---

## Alignment & Whitespace

Use blank lines and vertical alignment to make related code line up — this makes diffs easier to read and patterns easier to spot at a glance.

### Object/array alignment

When assigning multiple related properties, align the values:

```javascript
// ✅ Values aligned
const config = {
  host     : process.env.DB_HOST,
  port     : process.env.DB_PORT,
  database : process.env.DB_NAME,
  user     : process.env.DB_USER,
  password : process.env.DB_PASSWORD,
};

// ❌ No alignment
const config = {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
};
```

### Variable declarations

```javascript
// ✅ Aligned
const firstName = 'Andy';
const lastName  = 'Keys';
const email     = 'andy@example.com';

// ❌ Not aligned
const firstName = 'Andy';
const lastName = 'Keys';
const email = 'andy@example.com';
```

### Blank lines between logical sections

Use a single blank line to separate logically distinct blocks within a function. Use two blank lines between top-level declarations.

---

## Naming Conventions

| Context | Convention | Example |
|---|---|---|
| JS variables & functions | `camelCase` | `getUserById`, `postData` |
| JS classes & constructors | `PascalCase` | `UserSession`, `ApiError` |
| CSS classes & IDs | `kebab-case` | `.travel-card`, `#main-nav` |
| HTML files | `kebab-case` | `travel-post.html`, `blog.html` |
| JS/utility files | `kebab-case` | `error-handler.js`, `validate.js` |
| Database tables | `snake_case` | `travel_posts`, `blog_posts` |
| Database columns | `snake_case` | `created_at`, `body_markdown` |
| Constants / env vars | `SCREAMING_SNAKE_CASE` | `JWT_SECRET`, `MAX_RETRIES` |
| Test files | Mirror source path, `.test.js` suffix | `tests/routes/posts.test.js` |

---

## JavaScript

### Variable declarations

- Use `const` by default; `let` when reassignment is needed
- Never use `var` in new code (only in legacy jQuery files for compatibility)
- Declare variables at the top of their scope

### Functions

- Prefer named functions for top-level declarations — aids stack traces
- Arrow functions are fine for callbacks and short inline expressions
- Avoid deeply nested callbacks — use `async/await`

```javascript
// ✅ Named async function
async function createPost(data) {
  const result = await db.query(INSERT_POST, [data.title, data.slug]);
  return result.rows[0];
}

// ✅ Arrow for callback
router.get('/posts', async (req, res, next) => {
  try {
    const posts = await getPosts();
    res.json(posts);
  } catch (err) {
    next(err);
  }
});
```

### Early returns

Prefer early returns over deeply nested `if/else`:

```javascript
// ✅ Early return
function getSlug(post) {
  if (!post) return null;
  if (!post.slug) return null;
  return post.slug.toLowerCase();
}

// ❌ Nested
function getSlug(post) {
  if (post) {
    if (post.slug) {
      return post.slug.toLowerCase();
    }
  }
  return null;
}
```

### Import order

1. Node built-ins (`path`, `fs`, `url`)
2. Third-party packages (`express`, `pg`, `jsonwebtoken`)
3. Internal modules (`../middleware/validate.js`, `../db/pool.js`)

Separate each group with a blank line.

---

## CSS

- Use CSS custom properties (variables) for all colours, spacing, and font sizes
- Use `kebab-case` for all class names and IDs
- Alpha-blended borders: `border: 1px solid oklch(from var(--color-text) l c h / 0.12)` — not solid grey
- Property order within a rule: layout → box model → visual → typography → interaction

```css
/* ✅ Property order */
.card {
  /* Layout */
  display      : flex;
  flex-direction: column;
  gap          : var(--space-4);

  /* Box model */
  padding      : var(--space-6);
  border-radius: var(--radius-lg);

  /* Visual */
  background   : var(--color-surface);
  border       : 1px solid oklch(from var(--color-text) l c h / 0.12);
  box-shadow   : var(--shadow-sm);

  /* Typography */
  font-size    : var(--text-base);
  color        : var(--color-text);

  /* Interaction */
  transition   : box-shadow var(--transition-interactive);
  cursor       : pointer;
}
```

---

## HTML

- Use semantic elements: `<article>`, `<section>`, `<header>`, `<nav>`, `<main>`, `<footer>`, `<button>`
- Every `<img>` must have `alt`, `width`, `height`, and `loading="lazy"`
- Every `<input>` must have an associated `<label>`
- Attribute order: `id` → `class` → `type` → `name` → `href`/`src` → `aria-*` → `data-*`

---

## Express / Backend

- One resource per route file — `routes/posts.js` handles posts only
- Always pass errors to `next(err)` — never `res.status(500).send()` inline
- Validate at the boundary using the `validate` middleware before any DB calls
- Use parameterized queries — never string concatenation for SQL

```javascript
// ✅ Correct error handling pattern
router.post('/', validate(postSchema), async (req, res, next) => {
  try {
    const post = await db.query(INSERT_POST, [req.body.title]);
    res.status(201).json(post.rows[0]);
  } catch (err) {
    next(err);
  }
});
```

---

## Comments

Keep comments **concise and rare**. Add them only when:
- The logic is unusual or non-obvious
- Explaining a workaround for a specific bug
- Documenting a hidden constraint or invariant

Do NOT comment obvious operations or restate what the code does.

```javascript
// ✅ Good — explains why, not what
var dateObj = new Date(String(d).slice(0, 10) + 'T00:00:00');
// Slice to date-only before parsing to avoid UTC offset shifting the day

// ❌ Bad — obvious
const name = user.name; // Get the user's name
```

---

## Testing

> ⚠️ **Dev runs in Docker — do not run `npm test` directly on your local machine.**

See **[docs/TESTING.md](./docs/TESTING.md)** for the full guide. Key conventions:

### Running tests

```powershell
.\scripts\dev-local.ps1 up
.\scripts\dev-local.ps1 test           # run suite
.\scripts\dev-local.ps1 test:coverage  # with coverage
```

### File structure

Test files mirror the source tree under `backend/tests/`:

```
backend/tests/
  middleware/validate.test.js
  middleware/errorHandler.test.js
  routes/contact.test.js
  routes/posts.test.js
```

### Naming

- File: `<source-filename>.test.js` in a mirrored path
- `describe` block: matches the route or module name (`'POST /posts'`, `'validate middleware'`)
- `it` block: plain English description of behaviour (`'returns 400 when title is missing'`)

### Mocking conventions

- Mock `pg` at the **module level** with `vi.mock('pg', ...)` — never mock it inside a test
- Mock `nodemailer` the same way for routes that send email
- Never use a live database or live network in unit/integration tests
- Use `vi.fn().mockResolvedValue({ rows: [] })` as the default pg query stub; override per-test when needed

### PR smoke test scripts

Every PR that touches backend code must include a `scripts/Test-PRN.ps1` (where N is the PR number).

- Run after `dev-local.ps1 up`: `.\scripts\Test-PRN.ps1`
- The PR description Testing Checklist must reference it as the primary verification step
- Scripts use `docker compose exec` directly — no bash or WSL dependency

---

## Git & Commits

Follow conventional commits with issue scope:

```
type(#N): short imperative summary (50 chars max)

Optional body explaining the why.

Co-Authored-By: Perplexity Sonar <noreply@perplexity.ai>
```

**Types:** `feat`, `fix`, `refactor`, `docs`, `test`, `chore`

```
✅ feat(#92): add image upload to travel posts
✅ fix(#88): correct UTC offset in date formatter
✅ docs: update TESTING.md with Docker workflow
❌ fixed stuff
❌ WIP
```

---

## Security

- Always escape user input with `escapeHtml()` before inserting into the DOM
- Always use parameterized queries — never concatenate user input into SQL
- Validate at system boundaries only (incoming HTTP requests) — do not re-validate internal calls
- Never log or commit `.env`, tokens, passwords, or API keys
- Run `npm audit` before merging any dependency changes
