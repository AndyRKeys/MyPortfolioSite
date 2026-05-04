# AI Pair Programmer Instructions

Guidelines for AI-assisted development on this project (Claude, Perplexity, or other models).

## Branching Strategy

This project follows a three-tier branching model:

```
main (production)
 ↑
dev (integration)
 ↑
feature/* or fix/* (per GitHub issue)
```

**Branch naming:**
- `feature/issue-N-short-description` — for new features
- `fix/issue-N-short-description` — for bug fixes
- One branch per GitHub issue only

**Critical guardrails:**

- **Always develop on a feature or fix branch** (`feature/issue-N-*` or `fix/issue-N-*`). Never commit directly to `dev` or `main`.
- **Pull requests** go `feature|fix/* → dev` for integration testing, then `dev → main` for production.
- **Never force-push** to shared branches (`dev`, `main`). Only force-push to your own feature branch if absolutely necessary.

## Expected AI Workflow

This is the standard workflow for AI-assisted work on this project:

### 1. Issue Creation
If the issue doesn't exist yet, create it on GitHub with:
- Clear title and description
- Steps to reproduce (for bugs)
- Expected vs actual behavior
- Any relevant context (related PRs, design docs, etc.)

### 2. Planning
Before writing code:
- Read the issue and any linked context
- Examine existing code patterns and architecture
- Draft a plan (can be brief: "I'll update X file, add Y function, then test Z")
- Ask for clarification if requirements are ambiguous

### 3. Implementation
- Create a feature or fix branch from `dev`
- Commit regularly with clear messages
- Keep changes focused — one issue per branch
- Test locally with Docker Compose or manual setup
- Push commits as you go (don't wait until done)

### 4. PR to Dev
Once implementation is complete:
- Create a PR from your branch → `dev`
- Include a summary of what changed and why
- Link the issue number (`Closes #N`)
- Self-review the diff for obvious issues
- Wait for your review and testing

**You** will:
- Review the PR
- Test the changes locally
- Approve or request changes
- Merge when ready

### 5. Release to Main
After testing on `dev`:
- Create a PR from `dev` → `main`
- Include release notes or changelog
- Merge to deploy to production

**Do not:**
- Create or merge PRs without being asked
- Force-push to `dev` or `main`
- Skip testing before asking you to review

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

## Release Branches (Optional)

Currently, the workflow is `feature/fix → dev → main`, but consider adding intermediate branches for:

- **`release/X.X.X`** — Staging branch before production release
  - Allows final testing and fixes without blocking ongoing dev work
  - Useful if you need to hotfix live issues separately from new features
  - Pattern: `release/1.2.0 ← dev`, test, then `release/1.2.0 → main`

- **`hotfix/issue-N-*`** — Emergency fixes for production issues
  - Branch from `main`, not `dev`
  - Merged back to both `main` and `dev`
  - Pattern: `hotfix/issue-X-critical-bug → main` (immediately), then cherry-pick to `dev`

**Current recommendation:** Keep the simple three-tier model (`main ← dev ← feature/fix`) until you need concurrent releases or frequent production hotfixes. This file can be updated when/if that's needed.

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
