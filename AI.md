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
- `release/YYYY-MM-DD` — for production releases (with optional `-N` suffix for same-day releases)
- `hotfix/issue-N-short-description` — for emergency production fixes
- One branch per GitHub issue only

**Critical guardrails:**

- **Always develop on a feature or fix branch** (`feature/issue-N-*` or `fix/issue-N-*`). Never commit directly to `dev` or `main`.
- **Pull requests** go `feature|fix/* → dev` for integration testing and review.
- **Release branches** go `release/YYYY-MM-DD → main` when you instruct the AI to prepare a release.
- **Hotfixes** branch from `main`, not `dev`, for emergency production fixes.
- **Never force-push** to shared branches (`dev`, `main`). Only force-push to your own feature branch if absolutely necessary.
- **Only you merge to `main`** — approve all PRs to main. AI creates branches and PRs, you approve merges.

## Expected AI Workflow

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
- Comment a plan on the issue before starting work
- Ask for clarification if requirements are ambiguous

### 3. Implementation
- Create a `feature/issue-N-*` or `fix/issue-N-*` branch from `dev`
- Commit regularly with clear messages
- Keep changes focused — one issue per branch
- Push commits as you go (don't wait until done)

### 4. PR to Dev
Once implementation is complete:
- Raise a PR from the branch → `dev`
- Link the issue number (`Closes #N`)
- Include a clear summary of what changed and why
- Wait for review, testing, and approval before merging

**You** will review, test locally, and merge when ready. The AI does not merge PRs.

### 5. Release to Production

When you are ready to release to production, instruct the AI with:
```
Create a release branch for today and raise a PR to main
```

The AI will:
1. Create a `release/YYYY-MM-DD` branch from `dev` (or `release/YYYY-MM-DD-2`, etc. if already released today)
2. Fetch all commits since the last release
3. Raise a PR from `release/YYYY-MM-DD` → `main` with a summary:
   - All features added (with issue numbers)
   - All bugs fixed (with issue numbers)
   - Any breaking changes or deployment notes
   - Links to all related PRs merged since last release

**You** will:
- Review the release summary
- Test any critical paths on `release/YYYY-MM-DD` if needed
- Approve and merge the PR to `main` (the AI does not merge)
- The deployment script will pull from `main` and go live

### 6. Hotfixes (Emergency Production Fixes)

If a critical bug is discovered on production:

1. Instruct the AI to create a hotfix: `Create hotfix/issue-N-short-description for the production bug`
2. The AI will branch from `main`, fix, commit, and raise a PR → `main`
3. You review and approve the hotfix PR
4. After merging to `main`, instruct: `Merge hotfix into dev to keep branches in sync`
5. The AI will merge `main` back to `dev`

### Branching diagram

```
main  ←(you approve)── release/YYYY-MM-DD ←── dev ←── feature/issue-N-*
 ↑                                              ←── fix/issue-N-*
 └── hotfix/issue-N-* ────────────────────────(emergency fixes only)
```

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

## Developer Environment

### Terminal

- **Preferred terminal: PowerShell** (Windows). Use PowerShell syntax for all shell commands, scripts, and examples provided by the AI.
- Use backtick (`` ` ``) for line continuation, not `\`.
- Use `curl.exe` (not `curl`) to invoke real curl — `curl` in PowerShell is an alias for `Invoke-WebRequest` and behaves differently.
- Escape inner double-quotes in `-d` bodies with `\"` when using `curl.exe`.
- For multi-line `curl.exe` commands:

```powershell
curl.exe -s -X POST http://localhost/api/contact `
  -H 'Content-Type: application/json' `
  -d '{\"name\":\"Test\",\"email\":\"test@example.com\",\"message\":\"Hello\"}'
```

- Bash scripts (`*.sh`) are still used for Pi/server-side operations and Docker. When providing commands intended to run on the Pi or inside a container, Bash syntax is correct. When providing commands to run on your local Windows machine, use PowerShell.

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

**ES Modules & Code Organization**
- Frontend uses ES modules for all JavaScript (no inline scripts except minimal setup)
- Create shared utilities in `resources/java/utils/*` instead of duplicating functions
- Example patterns: `escapeHtml()`, `formatVisitDate()`, `formatRelativeDate()` are shared exports
- Import utilities as: `import { escapeHtml, formatVisitDate } from './utils/html.js'`
- Avoid copy-pasting logic across multiple files — extract to utils first

**HTML & CSS**
- Keep CSS organized by component/feature
- Prefer editing existing files over creating new ones
- Delete unused code completely (no `// removed` comments)
- Use semantic HTML (`<article>`, `<header>`, `<nav>`, `<button>` with proper `aria-` attributes)

**JavaScript**
- Use vanilla JS when possible, jQuery only for legacy compatibility
- Use `const/let` in modern ES modules (use `var` only in legacy jQuery files)
- For security-critical operations (escaping, DOM manipulation), always use shared utilities
- Prevent XSS: escape user input with `escapeHtml()` before setting `innerHTML`
- Prevent SQL injection: use parameterized queries on backend (never string concatenation)

**Design Patterns (Anti-Debt)**
- **DRY (Don't Repeat Yourself):** Extract repeated logic to utilities or shared functions
- **Single Responsibility:** Each function/module has one clear purpose
- **No Quick Fixes:** If tempted to duplicate code, create a utility instead
- **Testability:** Write utilities to be testable independently of DOM

## Architecture Notes

- **Frontend:** ES modules for JavaScript, shared utilities in `resources/java/utils/*`; HTML/CSS, jQuery for legacy compat; no build step
- **Backend:** Node.js/Express (ES modules), PostgreSQL with parameterized queries
- **Reverse proxy:** Nginx (`/api/*` → backend, `/*` → static files)
- **Auth:** JWT + WebAuthn/FIDO2 passkeys
- **Dev setup:** Docker Compose (recommended) or manual Node + PostgreSQL

## Testing Before Merge

- Test locally in Docker or manual dev setup
- Verify the golden path and edge cases
- Check for regressions in related features
- Type checking and linting provide code correctness, **not feature correctness** — test the UI
- When providing manual test commands, use `curl.exe` PowerShell syntax (see Developer Environment above)

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

## Hotfixes

For urgent production bugs that can't wait for the normal release cycle:

- Branch from `main` as `hotfix/issue-N-short-description`
- Fix, commit, and raise a PR → `main` with a hotfix summary
- After merging to `main`, also merge back to `dev` to keep branches in sync
- Pattern: `hotfix/issue-N-* → main` (you approve), then `main → dev`

## Context for AI Models

When working with this project:

- **Architecture:** Nginx reverse proxy (`/api/*` → Node backend), static frontend served by Nginx
- **Database:** PostgreSQL with UUID primary keys, idempotent schema migrations
- **Frontend:** No build step — vanilla JS/HTML/CSS with jQuery for compatibility
- **Stack:** Node.js/Express backend, WebAuthn/JWT auth, PM2 process manager
- **Deployment:** Smart deploy script detects changes and restarts only what's needed
- **Terminal:** Developer uses PowerShell on Windows. Provide PowerShell-compatible commands for local machine operations. Bash is correct for Pi/server/container operations.

See README.md for full details, scripts, and local dev setup.

## When in Doubt

1. Check the README.md for architecture and deployment info
2. Review recent commits to match code style
3. Ask: "Is this change isolated, testable, and reversible?"
4. If a task is too large, break it into smaller PRs
5. Test locally before proposing changes (use Docker Compose or manual setup)
