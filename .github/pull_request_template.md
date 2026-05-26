## Summary

<!-- One or two sentences describing what this PR does and why -->

Closes #<!-- issue number -->

## Changes

<!-- Bullet list of files/areas changed and what changed -->

- 
- 

## Test Plan

<!-- Specific steps to verify this works. Be precise — exact URLs, actions, expected results. -->

### Happy path

1. 
2. 
3. 

### Edge cases

- [ ] <!-- e.g. Empty state / no data -->
- [ ] <!-- e.g. Error handling (bad input, network failure) -->
- [ ] <!-- e.g. Mobile / small screen -->

### Regression checks

<!-- Features that could have been affected and should be verified still work -->

- [ ] 
- [ ] 

### Setup required before testing

<!-- Any seed data, env vars, or manual steps needed -->

- None

## Smoke Test

<!-- PRs that touch backend code must run both scripts before requesting review.
     See docs/TESTING.md for full instructions. -->

- [ ] `scripts/tests/Test-Regression.ps1` run and passing
- [ ] `scripts/tests/Test-PR<!-- N -->.ps1` created and passing
- [ ] N/A — no backend changes in this PR

## Documentation

<!-- Tick all that apply. If a box is not relevant, mark N/A. -->

- [ ] `docs/CHANGELOG.md` updated with an entry under `[Unreleased]`
- [ ] Behaviour docs updated if needed (`docs/AI.md` / `docs/STYLE_GUIDE.md` / `docs/DATABASE.md` / `docs/SECURITY.md` / `docs/TESTING.md`)
- [ ] Ops docs updated if needed (`docs/RUNBOOK.md` / `docs/BACKUP.md` / `docs/INCIDENTS.md` / `docs/INFRASTRUCTURE.md` / `docs/PROD_ENVIRONMENT.md` / `docs/DEV_ENVIRONMENT.md`)
- [ ] CSP allowlist (`scripts/config/nginx-security-headers.conf`) updated if any external resource or inline script was added/moved — or N/A
- [ ] N/A — behaviour and operator docs already match the change (no updates needed)

## Risk / Impact

<!-- For security/infra/ops changes, briefly note risk, impact, or threat mitigated. -->

- 

## Squash Commit Message

<!-- Mandatory — repo squash-merges, so this becomes the permanent history entry.
     Format: short imperative summary (≤50 chars), blank line, short why/what body
     (focus on WHY, not what — the diff shows what), then Co-Authored-By footer. -->

```text
<summary>

<body>

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

## Notes for Reviewer

<!-- Anything unusual, a known limitation, or a decision that warrants explanation.
     For security/infra PRs, you can also expand on risk/impact/threat mitigated here. -->

<!-- ⚠️ Full file rewrite — please check diff carefully for unintended changes -->
<!-- (uncomment the line above if any file was fully rewritten) -->
