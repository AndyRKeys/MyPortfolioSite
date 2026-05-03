# Agent Instructions

Rules for AI agents (Perplexity, Copilot, etc.) working on this repo.

## Scope

- Only make changes explicitly requested in the linked issue or conversation
- Never refactor, reorder, reformat, or "improve" code outside the stated scope
- Never convert literal Unicode characters to escape sequences — `—`, `…`, `©`, `✏`, `✈`, `☾`, `−` etc. must stay as-is
- If a change requires touching more than the requested lines, flag it and ask first — do not proceed

## Branching & commits

- Always branch from `dev`, never from `main`
- Branch naming: `feat/issue-{n}-short-description`, `fix/issue-{n}-short-description`, `chore/short-description`
- One feature or fix per branch and PR
- Commit messages must follow Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`
- PR title must reference the issue number where applicable: `feat: add X (#42)`

## Workflow

- Always read the current file from `dev` immediately before writing — never rely on a version read earlier in the session
- Since `push_files` rewrites whole files, flag it explicitly in the PR description with: ⚠️ Full file rewrite — please check diff carefully for unintended changes
- Raise PRs targeting `dev`; never push directly to `dev` or `main`
- One PR per issue — do not bundle unrelated changes

## Human-in-the-loop

- You raise PRs; the human reviews, approves, and merges — never auto-merge
- Deployments to the Pi are performed manually by the human via `deploy.sh`
- If anything is unclear or the scope is ambiguous, ask before acting
