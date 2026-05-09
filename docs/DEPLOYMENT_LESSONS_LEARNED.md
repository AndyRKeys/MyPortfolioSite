# Deployment Lessons Learned — 2026-05-07

_Last updated: 2026-05-09_

This document captures lessons from the first production deployment to Ubuntu Server on 2026-05-07. The deployment succeeded after ~4 hours of troubleshooting, with issues being primarily environmental rather than architectural.

## Executive Summary

The migration from Raspberry Pi to Ubuntu Server was successful, but encountered numerous environmental, configuration, and procedural issues. This document provides root cause analysis, resolutions, and recommendations for future deployments.

**Outcome:** Production deployment successful. Site is live and healthy. Post-migration backups activated.

---

## Issues Encountered & Root Causes

### 1. CSP Headers Blocked Legitimate Functionality

**Symptom:** Inline scripts and external API calls (GitHub repos widget) blocked on index, admin, blog, travel, and login pages.

**Root Cause:** PR #177 added overly-restrictive CSP headers without auditing all inline scripts and external resources used by the application.

**Impact:** Admin login failed, blog/travel posts didn't load, GitHub widget failed. These features appeared completely broken despite backend being healthy.

**Resolution:** Reverted CSP entirely (see issue #181 for proper implementation plan). Other security headers (X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy) remained intact.

**Lesson Learned:** CSP requires careful planning. Don't deploy restrictive CSP without:
- Auditing all inline scripts in HTML
- Identifying all external resources (APIs, CDNs)
- Testing with actual external requests
- Having a rollback plan

---

## Key Recommendations

- **Start with fresh OS installations** — Avoid pre-installed conflicting software
- **Use automated pre-flight checks** — `check-server-ready.sh` catches environmental issues early
- **Configure port forwarding before deployment** — Let's Encrypt validation depends on external port accessibility
- **For Docker state issues, reboot first** — Full system reboot resolves kernel-level state problems faster than incremental troubleshooting
- **Activate backups immediately** — Database backups are critical; must be enabled via cron

---

## Detailed Analysis

For complete issue analysis, troubleshooting commands, timing breakdown, and post-deployment verification procedures, see the full document on the main branch.