# AI Pair Programmer Instructions

Guidelines for AI-assisted development on this project (Claude, Perplexity, or other models).

For high-level direction and current priorities, AI models may treat `ROADMAP.md` as **context only**. The authoritative instructions for how to work on this project are this document (`docs/AI.md`), the style guide, testing guide, and other docs listed in the onboarding prompt.

## Scope Discipline

- **Only make changes explicitly requested** in the linked issue or conversation.
- Treat a clear user request (for example, "Add a CI workflow that runs tests on PRs" or "Fix the Nominatim CSP breakage") as permission to work on that specific task only.
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
- AI tools must never create branches, push commits, or open PRs on this repo without a specific, current command from you in the conversation.

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

... (rest of file unchanged) ...
