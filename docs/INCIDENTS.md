# Incidents and Postmortems

A lightweight log of production or dev incidents that were significant enough to investigate. Use this format to capture what happened, how it was fixed, and what changed to prevent recurrence.

Each new incident should be appended as a new section at the top of this file.

---

## Template

### Incident YYYY-MM-DD — short title

**Summary**  
One or two sentences describing what broke and when.

**Impact**  
Who was affected (you only, public visitors), and how (downtime, errors, data issue).

**Timeline**  
- `HH:MM` — Issue noticed
- `HH:MM` — First mitigation
- `HH:MM` — Root cause identified
- `HH:MM` — Fixed

**Root cause**  
What actually caused the problem (be as specific as possible).

**Fix**  
What you changed to restore service.

**Follow-ups**  
Links to:
- Code changes (PRs, commits)
- Documentation updates (e.g. RUNBOOK, BACKUP, INFRASTRUCTURE)
- Any new monitoring or alerts added

---

## Example (filled in lightly)

### Incident 2026-01-01 — Dev deploy left stale backend container

**Summary**  
Dev deployments started serving old backend code despite successful deploy script completion.

**Impact**  
Only affected dev environment; prod not impacted.

**Timeline**  
- `21:05` — Noticed new API route 404ing on dev after deploy
- `21:15` — Confirmed new code was on disk but container was old image
- `21:30` — Manually removed orphan container and re-ran deploy
- `21:45` — New route working as expected

**Root cause**  
Old container with the same name was not being removed; deploy script updated images but left the existing container running.

**Fix**  
Updated deploy script to use `docker compose up -d --force-recreate` and added explicit container removal step.

**Follow-ups**  
- Linked script change in `scripts/deploy/dev-deploy.sh`
- Added note to **docs/DEPLOYMENT_LESSONS_LEARNED.md** and referenced this incident
- Added a check to regression tests to hit the new route explicitly
