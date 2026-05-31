# Code Style Guide

Coding conventions for the MyPortfolioSite project. All contributors (human and AI) must follow these rules.

---

## General Principles

- **DRY (Don't Repeat Yourself):** Extract repeated logic to shared utilities or functions.
- **Single Responsibility:** Each function, module, and file has one clear purpose.
- **Readability over cleverness:** Write code that a future reader can understand without running it.
- **No dead code:** Delete removed code completely — no commented-out blocks left behind.

---

## Alignment & Whitespace

Deliberate vertical alignment improves scannability of related values. Apply it consistently within a logical block.

### Object Properties

Align values when two or more related properties share a key–value pattern:

```javascript
// ✅ Aligned — easy to scan differences between entries
const routes = [
  { path: '/',        component: Home    },
  { path: '/about',   component: About   },
  { path: '/contact', component: Contact },
];

// ❌ Unaligned — harder to spot the value column
const routes = [
  { path: '/', component: Home },
  { path: '/about', component: About },
  { path: '/contact', component: Contact },
];
```

### Multi-value CSS

Align colons and values in logically grouped CSS declarations:

```css
/* ✅ Aligned */
.card {
  padding:    var(--space-4);
  background: var(--color-surface);
  border:     1px solid oklch(from var(--color-text) l c h / 0.12);
}

/* ❌ Unaligned */
.card {
  padding: var(--space-4);
  background: var(--color-surface);
  border: 1px solid oklch(from var(--color-text) l c h / 0.12);
}
```

### When NOT to align

- Single-property blocks (no alignment benefit)
- Long mixed-length values that would require excessive padding
- Auto-formatted files managed by a linter (let the tool decide)

---

## Naming Conventions

| Context      | Convention       | Example                        |
|--------------|------------------|--------------------------------|
| JS variables | camelCase        | `postSlug`, `visitDate`        |
| JS functions | camelCase        | `formatRelativeDate()`         |
| JS classes   | PascalCase       | `PostController`               |
| CSS classes  | kebab-case       | `.blog-card`, `.nav-link`      |
| CSS variables| kebab-case       | `--color-primary`, `--space-4` |
| Files        | kebab-case       | `blog-post.js`, `travel.css`   |
| DB columns   | snake_case       | `post_date`, `body_markdown`   |
| DB tables    | snake_case       | `blog_posts`, `travel_posts`   |
| Constants    | SCREAMING_SNAKE  | `MAX_RETRIES`, `API_BASE`      |
| Env vars     | SCREAMING_SNAKE  | `JWT_SECRET`, `DATABASE_URL`   |
| Test files   | Mirror source path, `.test.js` suffix | `tests/routes/posts.test.js` |

---

## JavaScript

### Variable Declarations

```javascript
// ES modules (modern files) — use const/let
const slug = post.slug;
let retries = 0;

// Legacy jQuery files — use var
var $modal = $('#modal');
```

### Functions

Prefer named function declarations for top-level utilities; arrow functions for callbacks:

```javascript
// ✅ Named declaration — clear in stack traces and easier to find
export function formatRelativeDate(dateStr) {
  // ...
}

// ✅ Arrow for callbacks
posts.map(post => formatRelativeDate(post.post_date));
```

### Conditionals

Avoid deep nesting — return early:

```javascript
// ✅ Early return
function getSlug(post) {
  if (!post) return null;
  if (!post.slug) return null;
  return post.slug;
}

// ❌ Nested
function getSlug(post) {
  if (post) {
    if (post.slug) {
      return post.slug;
    }
  }
  return null;
}
```

### Imports

Group imports: external libraries first, then internal modules, separated by a blank line:

```javascript
import express from 'express';
import { z }   from 'zod';

import { validate }     from '../middleware/validate.js';
import { escapeHtml }   from './utils/html.js';
import { formatDate }   from './utils/date.js';
```

---

## CSS

All CSS uses the project's design token system. See [docs/AI.md](docs/AI.md) → Architecture Notes for token structure.

### Tokens

Never hardcode pixel values, hex colours, or arbitrary numbers. Always reference a token:

```css
/* ✅ Token-based */
.card {
  padding:       var(--space-4);
  border-radius: var(--radius-md);
  background:    var(--color-surface);
  box-shadow:    var(--shadow-sm);
}

/* ❌ Hardcoded */
.card {
  padding: 16px;
  border-radius: 8px;
  background: #f9f8f5;
}
```

### Borders

Use alpha-blended borders, not solid greys:

```css
/* ✅ Adapts to light/dark mode */
border: 1px solid oklch(from var(--color-text) l c h / 0.12);

/* ❌ Hard grey — breaks in dark mode */
border: 1px solid #ddd;
```

### Organisation

Order properties: layout → box model → visual → typography → interaction:

```css
.element {
  /* Layout */
  display:        flex;
  align-items:    center;
  gap:            var(--space-2);

  /* Box model */
  padding:        var(--space-3) var(--space-4);
  border:         1px solid oklch(from var(--color-text) l c h / 0.12);
  border-radius:  var(--radius-md);

  /* Visual */
  background:     var(--color-surface);
  box-shadow:     var(--shadow-sm);

  /* Typography */
  font-size:      var(--text-sm);
  color:          var(--color-text);

  /* Interaction */
  cursor:         pointer;
  transition:     background var(--transition-interactive);
}
```

---

## HTML

### Semantic Elements

Always prefer semantic HTML over generic `<div>` elements:

```html
<!-- ✅ Semantic -->
<article class="blog-card">
  <header>
    <h2>Post Title</h2>
    <time datetime="2026-05-04">4 May 2026</time>
  </header>
  <p>Excerpt...</p>
</article>

<!-- ❌ Generic -->
<div class="blog-card">
  <div class="title">Post Title</div>
  <div class="date">4 May 2026</div>
  <div>Excerpt...</div>
</div>
```

### Forms

Every input must have an associated label. Use `<fieldset>` and `<legend>` for groups:

```html
<label for="contact-email">Email address</label>
<input type="email" id="contact-email" name="email" required autocomplete="email">
```

### Attributes

Boolean attributes do not need values. Attribute order: structural → semantic → accessibility → event:

```html
<button type="submit" class="btn btn-primary" aria-label="Submit contact form">Send</button>
```

---

## Node.js / Express

### Route Files

One resource per route file. Validate at the boundary with `validate()` middleware before the handler:

```javascript
router.post('/', validate(CreatePostSchema), async (req, res, next) => {
  try {
    const post = await createPost(req.body);
    res.status(201).json(post);
  } catch (err) {
    next(err);
  }
});
```

### Error Handling

Always pass errors to `next(err)` — never build inline error responses in route handlers. The central error handler in `backend/middleware/errorHandler.js` formats and sends all error responses.

### Database Queries

Always use parameterised queries. Never concatenate user input into SQL:

```javascript
// ✅ Parameterised
const result = await pool.query('SELECT * FROM blog_posts WHERE id = $1', [id]);

// ❌ Concatenated — SQL injection risk
const result = await pool.query(`SELECT * FROM blog_posts WHERE id = '${id}'`);
```

---

## Comments

Comments communicate **intent and structure** — not a running narration of what the code does.

Logical flow does not need to be described in comments. If a sequence of steps is hard to follow without explanation, that is a signal to extract a well-named function, not to add prose. Well-named functions, early returns, and clear variable names are the primary tools for communicating flow.

### Section header comments

Use section header comments to divide a long file into named regions. The canonical format is:

```javascript
// ── Section name
```

- Two em-dashes (`──`), a space, then the label — **no trailing fill, no padding to a fixed column width**
- Use sentence case, no trailing punctuation
- Apply consistently: if one section in a file gets a header, all top-level sections in that file get one
- Do not use section headers inside short functions — they are for file-level or module-level regions only

```javascript
// ✅ Correct
// ── Auth helpers
// ── Travel memories
// ── CV management

// ❌ Trailing fill — length varies unpredictably, causes noisy diffs
// ── Auth helpers ──────────────────────────────────────────────────
// ── Travel memories ───────────────────────────────────────────
```

### Block summary comments

Add a short summary comment above each distinct logical block within a function or file. This is the **primary use of comments** — acting as section headers that let a reader scan the shape of the code before reading the detail.

```javascript
async function createPost(data) {
    // Validate slug uniqueness
    const existing = await pool.query(
        'SELECT id FROM blog_posts WHERE slug = $1', [data.slug]
    );
    if (existing.rows.length) throw Object.assign(new Error('Slug already exists'), { status: 409 });

    // Build insert
    const { title, body_markdown, post_date, excerpt, slug } = data;
    const result = await pool.query(
        `INSERT INTO blog_posts (title, body_markdown, post_date, excerpt, slug)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [title, body_markdown, post_date, excerpt, slug]
    );

    // Return created row
    return result.rows[0];
}
```

Keep block summaries short — one line, imperative phrasing (`Build query`, `Validate input`, `Render card`). Do not restate the function name.

### Non-obvious logic

Add an inline comment when the *why* is not clear from the code itself:

```javascript
// ✅ Explains why — not obvious from the code
var dateObj = new Date(String(d).slice(0, 10) + 'T00:00:00');
// Force local midnight to avoid timezone offset shifting the display date

// ✅ Documents a workaround
req.body = result.data; // Zod coerces types — use result.data, not req.body directly
```

### Never comment

- What a line does when the code already says it clearly
- The current task or ticket number (put that in the PR description)
- Obvious operations

```javascript
// ❌ Redundant — the code says this
var name = user.name; // Get the user's name

// ❌ Task note — belongs in the PR, not the code
// TODO: fix this later
```

---

## Testing

> ⚠️ **Dev runs in Docker — do not run `npm test` directly on your local machine.**

See **[docs/TESTING.md](docs/TESTING.md)** for the full guide, including the smoke test script template. Key conventions:

### File structure

Test files mirror the source tree under `backend/tests/`:

```text
backend/tests/
  middleware/validate.test.js
  middleware/errorHandler.test.js
  routes/contact.test.js
  routes/posts.test.js
```

File naming: `<source-filename>.test.js` in a mirrored path.

### Naming

- `describe` block: matches the route or module name (`'POST /posts'`, `'validate middleware'`)
- `it` block: plain English description of behaviour (`'returns 400 when title is missing'`)

### Mocking conventions

- Mock `pg` at the **module level** with `vi.mock('pg', ...)` — never mock it inside a test
- Mock `nodemailer` the same way for routes that send email
- Never use a live database or live network in unit/integration tests
- Use `vi.fn().mockResolvedValue({ rows: [] })` as the default pg query stub; override per-test when needed

### Running tests

```powershell
. scripts\dev\dev-local.ps1 up             # ensure dev environment is running
. scripts\dev\dev-local.ps1 test           # run full suite
. scripts\dev\dev-local.ps1 test:coverage  # run with coverage report
```

### PR smoke test scripts

Every PR that touches backend code must include a `scripts/tests/Test-PRN.ps1` (where N is the PR number). The **Smoke Test** section of `.github/pull_request_template.md` must be ticked before requesting review — use the script template in [docs/TESTING.md](docs/TESTING.md) as your starting point.

- Run after `dev-local.ps1 up`: `.\scripts\tests\Test-PRN.ps1`
- Scripts use `docker compose exec` directly — no bash or WSL dependency
- Output is captured automatically via `Start-Transcript` — no extra flags needed

---

## Git & Commits

Follow the imperative style documented in [docs/AI.md](docs/AI.md) → Commit Conventions:

```text
feat(#78): add travel post detail page
fix(#81): use /api as API_BASE in blog-post.js
refactor: extract formatDate to shared utils
```

One logical change per commit. Do not bundle unrelated changes.

---

## Security

- **XSS:** Always escape user-generated content with `escapeHtml()` before setting `innerHTML`.
- **SQL injection:** Always use parameterised queries — never string concatenation.
- **Input validation:** Validate at system entry points using Zod schemas in `backend/middleware/validate.js`.
- **Sensitive data:** Never log or commit `.env` files, tokens, API keys, or passwords.
