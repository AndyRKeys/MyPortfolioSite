# AI Pair Programmer Instructions

Guidelines for AI-assisted development on this project (Claude, Perplexity, or other models).

For high-level direction and current priorities, AI models may treat `ROADMAP.md` as **context only**. The authoritative instructions for how to work on this project are this document (`docs/AI.md`), the style guide, testing guide, and other docs listed in the onboarding prompt.

## Scope Discipline

- **Only make changes explicitly requested** in the linked issue or conversation
- If you spot an improvement while implementing (e.g. a refactoring that reduces duplication, a performance fix, a missing null check):
  - **If minor and clearly sensible** (e.g. renaming a variable for clarity, fixing an obvious bug): include it in the current PR with a note in the PR description
  - **If significant** (e.g. a larger refactor, architectural change, new abstraction): raise a new GitHub issue instead and continue with the original scope only. Ask the owner before proceeding with the improvement
  - **If unclear whether it's within scope**: ask before acting
- Never convert literal Unicode characters to escape sequences — `—`, `…`, `©`, `✏`, `✈`, `☾`, `−` etc. must stay as-is in source files
- If a change requires touching more than the requested lines, flag it and ask first — do not proceed
- Ask before acting if anything is unclear or the scope is ambiguous
- **One PR per issue**, unless issues are explicitly related:
  - Related issues (e.g. #80 and #81 fixing the same feature) can be bundled in one PR
  - Unrelated issues must go in separate PRs
  - If unsure whether issues are related, ask before bundling

## File Safety

- **Always read the current file from `dev`** immediately before editing — never rely on a version read earlier in the session
- When rewriting an entire file, flag it in the PR description with: ⚠️ Full file rewrite — please check diff carefully for unintended changes

---

## Documentation Hygiene

**Keeping docs up to date is part of every change — not an afterthought.**

Whenever a file is added, moved, renamed, or removed, update all relevant documentation in the **same commit**:

- `README.md` — update any script reference tables, command examples, or directory trees
- `docs/AI.md` — update any paths or workflow steps that reference the changed files
- `docs/TESTING.md` — update script paths, PR template examples, or test commands
- Any other doc that contains the old path or filename

This applies to:
- Scripts being added or reorganised (e.g. moving `scripts/foo.ps1` → `scripts/tests/foo.ps1`)
- Source files being renamed or relocated
- New docs or config files being introduced

The rule: **if the repo structure changes, the docs that describe that structure change in the same commit.**

---

## Markdown List Conventions

Use this rule consistently throughout this file and in all docs written by the AI:

- **Numbered lists** — for ordered sequences where the steps must happen in a specific order (e.g. a deployment procedure, a hotfix process)
- **Bullet lists** — for unordered collections of rules, properties, options, or items where sequence does not matter

---

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
- Expected vs actual behaviour
- Any relevant context (related PRs, design docs, etc.)

Use the appropriate issue template from `.github/ISSUE_TEMPLATE/` — `bug_report.md` for bugs, `feature_request.md` for new functionality.

### 2. Planning
Before writing code:
1. Read the issue and any linked context
2. Examine existing code patterns and architecture
3. Comment a plan on the issue before starting work
4. Ask for clarification if requirements are ambiguous

### 3. Implementation
1. Create a `feature/issue-N-*` or `fix/issue-N-*` branch from `dev`
2. Commit regularly with clear messages
3. Keep changes focused — one issue per branch
4. Push commits as you go (don't wait until done)

### 4. PR to Dev
Once implementation is complete:
1. Raise a PR from the branch → `dev`
2. Link the issue number (`Closes #N`)
3. Include a clear summary of what changed and why
4. Fill in the PR template at `.github/pull_request_template.md` in full — summary, changes, test plan, smoke test checkbox, and documentation checklist
5. Wait for review, testing, and approval before merging

The AI does not merge PRs — you will review, test locally, and merge when ready.

**PR test plans must include:**
- Specific steps to verify the happy path (e.g. exact URL, action, expected result)
- Edge cases to check (e.g. empty state, error handling, mobile view)
- Regression checks for related features that could have been affected
- Any manual setup needed before testing (e.g. seed data, env vars)
- The smoke test checkbox: a reference to `scripts/tests/Test-PRN.ps1` if backend code was touched, or an explicit N/A if not
- The documentation checklist: confirm `docs/CHANGELOG.md` updated and any relevant doc updated, or N/A

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
4. Append an entry to `docs/RELEASE_NOTES.md` (see [Doc Lifecycle](#doc-lifecycle) below)
5. Archive or clean up any planning docs whose work is now fully shipped (see [Doc Lifecycle](#doc-lifecycle) below)

You will:
1. Review the release summary
2. Test any critical paths on `release/YYYY-MM-DD` if needed
3. Approve and merge the PR to `main` (the AI does not merge)
4. The deployment script will pull from `main` and go live

### 6. Hotfixes (Emergency Production Fixes)

If a critical bug is discovered on production:
1. Instruct the AI to create a hotfix: `Create hotfix/issue-N-short-description for the production bug`
2. The AI will branch from `main`, fix, commit, and raise a PR → `main`
3. You review and approve the hotfix PR
4. After merging to `main`, instruct: `Merge hotfix into dev to keep branches in sync`
5. The AI will merge `main` back to `dev`
6. A hotfix entry is appended to `docs/RELEASE_NOTES.md`

### Branching diagram

```
main  ←(you approve)── release/YYYY-MM-DD ←── dev ←── feature/issue-N-*
 ↑                                              ←── fix/issue-N-*
 └── hotfix/issue-N-* ────────────────────────(emergency fixes only)
```

## Doc Lifecycle

Planning documents in `docs/` have a lifecycle — they should be kept tidy as work progresses.

### Planning docs

| State | What to do |
|-------|------------|
| Work in progress | Leave the plan doc in place |
| Partially complete | Add a `> ⚠️ Partially actioned — see issue #N` note at the top |
| Fully shipped in a release | Move to `docs/archive/` with no other changes |
| Superseded / abandoned | Move to `docs/archive/` and add a note explaining why |

- **Never delete** planning docs — they are useful historical context
- **Never edit** the content of an archived doc — only add a header note if needed
- `docs/archive/` is a flat folder; no sub-folders needed

### Release notes (`docs/RELEASE_NOTES.md`)

The AI maintains `docs/RELEASE_NOTES.md` as a running log of all production releases. Each release entry is **prepended** (newest first) in this format:

```markdown
## v YYYY-MM-DD[-N]

**Released:** YYYY-MM-DD  
**Branch:** release/YYYY-MM-DD  
**PR:** #N

### Features
- feat(#N): short description

### Bug Fixes
- fix(#N): short description

### Breaking Changes / Deployment Notes
- None  (or describe anything requiring manual steps on the server)

---
```

- Hotfixes get their own entry with a `🔥 Hotfix` prefix on the version line
- The file is created automatically on first release if it does not exist
- Do not manually edit this file — let the AI maintain it at release time

### When to action doc lifecycle

The AI performs doc lifecycle steps **as part of the release PR commit**, so the release branch contains both the code and the updated docs in one coherent snapshot.

---

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

**See [docs/STYLE_GUIDE.md](docs/STYLE_GUIDE.md) for the full coding style guide** — naming conventions, alignment & whitespace rules, JavaScript, CSS, HTML, and Express patterns.

Key points summarised here:

### Comments

Keep comments **concise and rare**. Add them only when:
- The logic is unusual or non-obvious
- Explaining a workaround for a specific bug
- Documenting a hidden constraint or invariant
- The code does something surprising

Do NOT comment:
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

> ⚠️ **Dev runs in Docker — do not run `npm test` directly on your local machine.** The canonical test environment is the backend container.

**See [docs/TESTING.md](docs/TESTING.md) for the full testing guide**, including test structure, what is/isn't tested, a template for new test files, and CI notes.

### Running the test suite

```powershell
# 1. Ensure the dev environment is running
. scripts\dev\dev-local.ps1 up

# 2. Run the full test suite inside the backend container
. scripts\dev\dev-local.ps1 test

# 3. Run with coverage report
. scripts\dev\dev-local.ps1 test:coverage
```

### PR smoke test scripts

Every PR that touches backend code **must** include a `scripts/tests/Test-PRN.ps1` smoke test script (where N is the PR number). This script is the definitive checklist for verifying the PR.

- The PR template's **Smoke Test** section must be ticked before requesting review
- The script runs `docker compose exec` directly — it does not require bash or WSL
- Run it after `. scripts\dev\dev-local.ps1 up` with: `.\scripts\tests\Test-PRN.ps1`

### What to verify

- Run `.\scripts\tests\Test-Regression.ps1` first — all baseline checks must pass
- Run `.\scripts\tests\Test-PRN.ps1` — all PR-specific checks must pass
- Verify the golden path and edge cases manually for UI changes
- Check for regressions in related features
- Type checking and linting provide code correctness, **not feature correctness** — test the behaviour
- When providing manual test commands, use `curl.exe` PowerShell syntax (see Developer Environment above)
- **See [docs/TESTING.md](docs/TESTING.md)** for the full testing guide, including how to capture verbose test output to a file while keeping live terminal feedback

## Database

- PostgreSQL with UUID PKs and unique slug constraints
- Schema migrations are idempotent (use `IF NOT EXISTS`)
- Never use transaction-blocking operations in production code
- Use parameterized queries to prevent SQL injection

## Security

- Sanitize HTML output to prevent XSS
- Use parameterized queries for SQL
- Validate user input at system entry points only
- Never log or commit sensitive data (`.env`, tokens, API keys)

## Hotfixes

For urgent production bugs that can't wait for the normal release cycle:

1. Branch from `main` as `hotfix/issue-N-short-description`
2. Fix, commit, and raise a PR → `main` with a hotfix summary
3. After merging to `main`, merge back to `dev` to keep branches in sync
4. Append a hotfix entry to `docs/RELEASE_NOTES.md`

Pattern: `hotfix/issue-N-* → main` (you approve), then `main → dev`

## Context for AI Models

When working with this project:

- **Architecture:** Nginx reverse proxy (`/api/*` → Node backend), static frontend served by Nginx
- **Database:** PostgreSQL with UUID primary keys, idempotent schema migrations
- **Frontend:** No build step — vanilla JS/HTML/CSS with jQuery for compatibility
- **Stack:** Node.js/Express backend, WebAuthn/JWT auth, PM2 process manager
- **Deployment:** Smart deploy script detects changes and restarts only what's needed
- **Terminal:** Developer uses PowerShell on Windows. Provide PowerShell-compatible commands for local machine operations. Bash is correct for Pi/server/container operations.
- **Testing:** All tests run inside the Docker backend container via `docker compose exec`. Never instruct the developer to run `npm test` directly on their local machine.

See README.md for full details, scripts, and local dev setup.

## When in Doubt

1. Check README.md for architecture and deployment info
2. Check [docs/STYLE_GUIDE.md](docs/STYLE_GUIDE.md) for naming, formatting, and code organisation rules
3. Check [docs/TESTING.md](docs/TESTING.md) before adding or modifying tests
4. Check [docs/DATABASE.md](docs/DATABASE.md) before adding or changing any routes, migrations, or queries
5. Check [docs/SECURITY.md](docs/SECURITY.md) before touching auth, sessions, or input handling
6. Check [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md) before adding, updating, or removing a dependency
7. Check `.github/pull_request_template.md` when raising a PR — every section must be filled in
8. Check `.github/ISSUE_TEMPLATE/` when creating an issue — use `bug_report.md` or `feature_request.md` as appropriate
9. Review recent commits to match code style
10. Ask: "Is this change isolated, testable, and reversible?"
11. If a task is too large, break it into smaller PRs
12. Test inside the Docker container before proposing changes — use `. scripts\dev\dev-local.ps1 test`
