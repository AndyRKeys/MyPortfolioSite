# AI Pair Programmer Instructions

Guidelines for AI-assisted development on this project (Claude, Perplexity, or other models).

## Branching Strategy

This project follows a three-tier branching model:

```
main (production)
 ↑
dev (integration)
 ↑
feature/* (per GitHub issue)
```

**Critical guardrails:**

- **Always develop on the feature branch** (`feature/issue-N-*`). Never commit directly to `dev` or `main`.
- **Feature branches** must be created from `dev` and named `feature/issue-N-short-description`.
- **Pull requests** go `feature/* → dev`, then `dev → main` for production.
- **Never force-push** to shared branches (`dev`, `main`). Only force-push to your own feature branch if absolutely necessary.

## Commit Conventions

Follow imperative style with optional Co-Authored-By:

```
Short imperative summary (50 chars max)

Optional explanation if the why isn't obvious.

Co-Authored-By: AI Model Name <noreply@ai-provider.com>
```

Replace "AI Model Name" with your actual model (e.g., `Claude Haiku`, `Perplexity Sonar`, `GPT-4`).

**Examples:**
- ✅ `fix(#81): use /api as API_BASE in blog-post.js`
- ✅ `feat(#78): add travel-post detail page`
- ✅ `refactor: simplify lightbox initialization`
- ❌ `Fixed bug` (too vague, missing scope)
- ❌ `WIP` (incomplete, no description)

## Code Style

### Comments

Keep comments **concise and rare**. Add them only when:

- The logic is unusual or non-obvious
- Explaining a workaround for a specific bug
- Documenting a hidden constraint or invariant
- The code does something surprising

**Do NOT comment:**
- What the code does (use clear variable names instead)
- The current task (that belongs in PR descriptions)
- Obvious operations

**Examples:**
```javascript
// Good: explains why, not what
var dateObj = new Date(String(d).slice(0, 10) + 'T00:00:00');

// Bad: obvious
var name = user.name; // Get the user's name
```

### HTML / CSS / JS

- Use vanilla JS when possible, jQuery only for cross-browser compat
- Keep CSS organized by component
- Prefer editing existing files over creating new ones
- Delete unused code completely (no `// removed` comments)
- Use `var` for compatibility (jQuery environment)

## Architecture Notes

- **Frontend:** Plain HTML/CSS/JS + jQuery, no build step
- **Backend:** Node.js/Express (ES modules), PostgreSQL
- **Reverse proxy:** Nginx (`/api/*` → backend, `/*` → static)
- **Auth:** JWT + WebAuthn/FIDO2 passkeys
- **Dev setup:** Docker Compose (recommended) or manual Node + PostgreSQL

## Testing Before Merge

- Test locally in Docker or manual dev setup
- Verify the golden path and edge cases
- Check for regressions in related features
- Type checking and linting provide code correctness, **not feature correctness** — test the UI

## Database

- PostgreSQL with UUID PKs and unique slug constraints
- Schema migrations are idempotent (use `IF NOT EXISTS`)
- Never use transaction-blocking operations in production code
- Use parameterized queries to prevent SQL injection

## Security

- Sanitize HTML output to prevent XSS
- Use parameterized queries for SQL
- Validate user input at system boundaries only
- Never log or commit sensitive data (`.env`, tokens, API keys)

## Context for AI Models

When working with this project:

- **Architecture:** Nginx reverse proxy (`/api/*` → Node backend), static frontend served by Nginx
- **Database:** PostgreSQL with UUID primary keys, idempotent schema migrations
- **Frontend:** No build step — vanilla JS/HTML/CSS with jQuery for compatibility
- **Stack:** Node.js/Express backend, WebAuthn/JWT auth, PM2 process manager
- **Deployment:** Smart deploy script detects changes and restarts only what's needed

See README.md for full details, scripts, and local dev setup.

## When in Doubt

1. Check the README.md for architecture and deployment info
2. Review recent commits to match code style
3. Ask: "Is this change isolated, testable, and reversible?"
4. If a task is too large, break it into smaller PRs
5. Test locally before proposing changes (use Docker Compose or manual setup)
