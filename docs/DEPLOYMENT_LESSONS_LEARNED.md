# Deployment Lessons Learned — 2026-05-07

## Executive Summary

The first production deployment to Ubuntu Server (2026-05-07) succeeded but encountered numerous environmental, configuration, and procedural issues that extended the timeline significantly. This document captures those lessons and provides recommendations for improved deployment processes.

**Outcome:** Production deployment successful after ~4 hours of troubleshooting. Site is live and healthy.

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

### 2. Pre-Installed Apache + Nextcloud Conflicted with Deployment

**Symptom:** Port 80 and 443 in use by Apache (httpd), preventing both Let's Encrypt and nginx from starting.

**Root Cause:** Server had Apache and Nextcloud installed from previous hobby project. Not standard Ubuntu Server installations.

**Impact:** Certbot validation failed repeatedly. Nginx container crashed at startup.

**Resolution:**

- Killed Apache processes: `sudo killall -9 httpd`
- Removed Nextcloud: `sudo snap remove nextcloud`

**Lesson Learned:**

- For fresh deployments, use a **clean Ubuntu Server installation** (minimal packages only)
- If reusing an existing server, verify no conflicting services are installed
- Pre-flight checks should detect and warn about:
  - Existing web servers (Apache, Nginx, etc.)
  - Port conflicts (80, 443)
  - Pre-installed services that might interfere
- **Recommendation:** Always deploy to fresh OS when possible to avoid unexpected state

---

### 3. Missing Certbot Helper Files

**Symptom:** Nginx crashed with `unable to load /etc/letsencrypt/options-ssl-nginx.conf` and `/etc/letsencrypt/ssl-dhparams.pem`.

**Root Cause:** Initial certbot run failed due to port forwarding not being configured (see Issue #4). When port forwarding was fixed, we manually created the missing files instead of re-running certbot.

**Impact:** Unnecessary manual file creation. Wasted time on workarounds.

**What Actually Happened:**

1. Certbot failed (no port forwarding) → we created files manually
2. Could have simply: Fixed port forwarding → Re-run certbot → Files created automatically

**Resolution (Correct Approach):**

```bash
# After fixing port forwarding on router:
sudo certbot certonly --standalone -d yourdomain.com
# This creates options-ssl-nginx.conf and ssl-dhparams.pem automatically
```

**Lesson Learned:**

- **When certbot fails, re-run it after fixing the root cause — don't manually create files**
- Certbot handles all file creation automatically on successful runs
- The root causes (port forwarding, DNS resolution) matter more than file creation
- Manual file creation should only be used if certbot repeatedly fails for unrelated reasons

**For server-setup.sh:**

- Don't pre-create certbot files
- Verify port forwarding works before running certbot
- Let certbot create all necessary files on first successful run

---

### 4. Port Forwarding Not Configured on Router

**Symptom:** Let's Encrypt validation failed with "Failed to download the challenge file." Domain resolved correctly but external connections to port 80 failed.

**Root Cause:** Router didn't have port forwarding rules configured for 80/443 → server IP.

**Impact:** First certbot attempt failed, delaying SSL setup by ~1 hour.

**Resolution:** Manually configured port forwarding on router (not automated).

**Lesson Learned:** Documentation should include:

- Router port forwarding checklist
- How to verify port accessibility: `curl http://<public-ip>/`
- Alternative: document UPnP port mapping if router supports it

---

### 5. Docker Permission Errors & Stale Containers

**Symptom:** `docker compose down` failed with "permission denied" even after `usermod -aG docker`. Multiple restart/rebuild attempts failed with stale container errors.

**Root Cause:** Docker daemon permission issues after initial setup. User group membership not properly applied until after systemd restart.

**Impact:** Extended troubleshooting time (spent 45+ minutes trying incremental fixes). **Would have been resolved in 5 minutes with a system reboot.**

**Troubleshooting Attempts That Failed:**

- `sudo systemctl restart docker` → still failed
- `docker rm -f <container>` → permission denied
- Re-running `usermod -aG docker` → no effect
- Docker daemon restart → no effect

**Actual Resolution:** Full system reboot solved everything immediately.

**Lesson Learned:**

- **When Docker gets into permission/state issues, do a full system reboot FIRST, not last**
- Don't spend time on incremental Docker daemon restarts — they often don't clear kernel state
- User group membership changes require a full login session or reboot to take effect
- The 45 minutes spent troubleshooting could have been 5 minutes with a reboot

**Recommendation for server-setup.sh:**

```bash
# After Docker installation and user group changes
echo "System reboot recommended to apply Docker group membership..."
echo "Reboot now? (y/n)"
read -r REBOOT
if [[ "$REBOOT" =~ ^[Yy]$ ]]; then
  sudo reboot
fi
```

---

### 6. Database Connection Errors (Resolved by Reboot)

**Symptom:** Backend health check failed with "Health check failed: connect ETIMEDOUT 172.18.0.2:5432" even though postgres container showed healthy.

**Root Cause:** Part of the same Docker state issue (Issue #5). Not actually a database timing problem.

**What We Tried:**

- Added `sleep 15` waiting for postgres ❌ (didn't help)
- Added health check retries ❌ (didn't help)
- Increased timeouts ❌ (didn't help)

**Actual Resolution:** Full system reboot (which also fixed the Docker permission issues).

**Lesson Learned:**

- **Don't add delays and retries hoping they'll fix database issues** — if the backend can't connect after postgres is healthy, it's usually a Docker/OS state problem, not timing
- The symptom looked like a timing issue but wasn't
- System reboot fixes the underlying issue immediately, no delays needed

---

### 7. Windows/Git Bash Path Translation (Fixed Earlier)

**Symptom:** `dev-local.sh` failed when running psql because Git Bash translated `/docker-entrypoint-initdb.d/01-schema.sql` to Windows path.

**Root Cause:** MSYS path translation in Git Bash converts Unix absolute paths to Windows paths based on Git installation directory.

**Impact:** Local development blocked when running test suite from Windows machine.

**Resolution:** Changed from `psql -f /container-path` to piping via stdin: `psql < /host-path`.

**Lesson Learned:** Avoid absolute paths in scripts when run through Git Bash. Use stdin redirection or env vars instead.

---

### 8. Docker CE Migration — 2026-05-11

Lessons from the snap → Docker CE migration carried out on 2026-05-11.

#### 8a. `docker.socket` systemd activation issue

**Symptom:** Docker CE installed and `systemctl status docker` showed healthy, but `/run/docker.sock` did not exist, causing all `docker` commands to fail with "cannot connect to Docker daemon".

**Root Cause:** systemd socket activation — `docker.socket` had not been started, so the socket file was never created even though the service unit appeared active.

**Resolution:**

```bash
sudo systemctl stop docker docker.socket
sudo systemctl start docker.socket
sudo systemctl start docker
```

**Diagnostic clue:** The warning *"Stopping docker.service but its triggering units are still active: docker.socket"* during a `systemctl stop docker` is the key indicator that the socket unit is the root activation point.

**Lesson Learned:** After installing Docker CE, verify `/run/docker.sock` exists before running any `docker` commands. If missing, restart `docker.socket` first, then `docker`.

---

#### 8b. Duplicate apt source file after Docker CE install

**Symptom:** Every `apt update` after the migration printed warnings about a duplicate apt source for `download.docker.com`.

**Root Cause:** The migration script added a new apt source list entry, but a file created by a previous manual Docker CE install attempt was still present:

```text
/etc/apt/sources.list.d/archive_uri-https_download_docker_com_linux_ubuntu-noble.list
```

**Resolution:**

```bash
sudo rm /etc/apt/sources.list.d/archive_uri-https_download_docker_com_linux_ubuntu-noble.list
sudo apt update
```

**Lesson Learned:** After running the migration script, check for and remove any duplicate apt source files before continuing. This is a post-migration cleanup step — add it to the migration script's post-install checklist.

---

#### 8c. Snap removal must come after both stacks are confirmed healthy

**Symptom:** N/A — this went right tonight, but is worth making explicit.

**Lesson Learned:** `sudo snap remove --purge docker` should only be run **after**:

1. Both the dev and prod stacks are confirmed healthy under Docker CE (`docker compose ps`, `curl /health`)
2. You are satisfied there is no rollback needed

Do not include snap removal in the automated migration flow. Keep it as a manual, gated final step.

---

#### 8d. Health check response interpretation — 301 and empty body are healthy

**Symptom:** Post-migration health checks returned responses that looked like failures:

- **Prod** `curl https://andykeys.me/health` → `301 Moved Permanently`
- **Dev** `curl http://192.168.68.81:3001/health` → security headers with no response body

**Root Cause:** These are correct, expected responses:

- The prod 301 is the HTTP → HTTPS redirect working as intended; `curl -L` or a direct HTTPS request shows the real health response
- The dev empty body is nginx returning security headers for a request it can proxy correctly; the backend is reachable

**Resolution:** Use `curl -L https://andykeys.me/health` for prod to follow the redirect.

**Lesson Learned:** Document these expected response shapes so a future migration doesn't waste time second-guessing a healthy stack. A 301 from prod `/health` is a pass, not a fail.

---

## Pre-Deployment Checklist (New)

Before running `server-setup.sh`, verify:

- [ ] Fresh Ubuntu Server LTS (22.04+) with minimal packages
- [ ] No conflicting web servers installed:

  ```bash
  dpkg -l | grep -E 'apache2|nginx|httpd'  # Should return nothing
  ```

- [ ] No pre-installed snaps interfering:

  ```bash
  snap list | grep -E 'nextcloud|apache|nginx'  # Should return nothing
  ```

- [ ] Ports 80 and 443 are free:

  ```bash
  sudo netstat -tlnp | grep -E ':80|:443'  # Should return nothing
  lsof -i :80 -i :443 2>/dev/null         # Alternative check
  ```

- [ ] No systemd services using those ports:

  ```bash
  systemctl list-units --type=service | grep -E 'apache|httpd|nginx|nextcloud'
  ```

- [ ] Port 80/443 accessible from internet (after router config):

  ```bash
  curl --connect-timeout 5 http://yourserver-ip/ || echo "NOT accessible"
  ```

- [ ] Domain resolves correctly:

  ```bash
  nslookup yourdomain.com  # Should show server IP
  ```

- [ ] Router port forwarding configured (80→server, 443→server)
- [ ] Sufficient disk space:

  ```bash
  df -h /  # Should have 10GB+ free
  ```

- [ ] Internet connectivity:

  ```bash
  ping -c 1 8.8.8.8
  ```

- [ ] SSH access working and no known_hosts errors
- [ ] Time synchronized:

  ```bash
  timedatectl status  # Should show "System clock synchronized"
  ```

---

## Recommended Deployment Sequence

Instead of attempting everything at once, deploy incrementally:

### Phase 1: Core Infrastructure (HTTP only)

1. Run server-setup.sh (modified to skip SSL)
2. Bring up docker compose with HTTP-only nginx
3. Verify backend health: `curl http://localhost/health`
4. Verify database connection: backend logs show no DB errors
5. Test basic API: `curl http://localhost/api/posts`

### Phase 2: Verify DNS & Accessibility

1. Verify domain points to server: `nslookup yourdomain.com`
2. Test external access: `curl http://yourdomain.com/health` from another machine
3. Verify port forwarding: `nmap -p 80 yourdomain.com` (should show open)

### Phase 3: SSL Certificates

1. Run certbot: `sudo certbot certonly --standalone -d yourdomain.com`
2. Verify files exist: `ls /etc/letsencrypt/live/yourdomain.com/`
3. Create helpers if needed: `options-ssl-nginx.conf`, `ssl-dhparams.pem`
4. Switch nginx to production SSL config
5. Restart containers: `docker compose -f docker-compose.prod.yml up -d`
6. Verify HTTPS: `curl https://yourdomain.com/health`

### Phase 4: Final Verification

1. Test all endpoints:
   - `/health` (system health)
   - `/api/posts` (public content)
   - `/login/` (authentication)
   - `/admin/` (admin panel, via magic link)
2. Test backup scripts
3. Verify cron jobs: `sudo crontab -l`

---

## Improvements to Implement

### server-setup.sh Enhancements

1. **Pre-flight Checks — Installed Programs:**

   ```bash
   # Check for conflicting packages
   if dpkg -l | grep -qE 'apache2|nginx|httpd'; then
     echo "ERROR: Conflicting web server already installed"
     echo "Remove with: sudo apt remove apache2 nginx httpd"
     exit 1
   fi

   # Check for interfering snaps
   if snap list | grep -qE 'nextcloud|apache|nginx'; then
     echo "WARNING: Found snap services that may conflict"
     snap list | grep -E 'nextcloud|apache|nginx'
     echo "Remove with: sudo snap remove <snap-name>"
     exit 1
   fi
   ```

2. **Pre-flight Checks — Port Usage:**

   ```bash
   # Verify ports 80 and 443 are free
   check_port() {
     local port=$1
     if lsof -i :$port >/dev/null 2>&1; then
       echo "ERROR: Port $port is already in use by:"
       lsof -i :$port
       echo "Free the port and try again"
       exit 1
     fi
   }

   check_port 80
   check_port 443

   # Check systemd services
   if systemctl list-units --type=service | grep -qE 'apache|httpd|nginx|nextcloud'; then
     echo "WARNING: Found active web server services:"
     systemctl list-units --type=service | grep -E 'apache|httpd|nginx|nextcloud'
     echo "Stop them with: sudo systemctl stop <service>"
     exit 1
   fi
   ```

3. **Pre-flight Checks — Disk Space:**

   ```bash
   # Verify sufficient disk space
   AVAILABLE=$(df / | awk 'NR==2 {print $4}')  # In 1K blocks
   REQUIRED=$((10 * 1024 * 1024))               # 10GB in 1K blocks

   if [ "$AVAILABLE" -lt "$REQUIRED" ]; then
     echo "ERROR: Insufficient disk space"
     echo "Available: $(($AVAILABLE / 1024 / 1024)) GB"
     echo "Required: 10 GB"
     exit 1
   fi
   ```

4. **Pre-flight Checks — Network:**

   ```bash
   # Verify internet connectivity
   if ! ping -c 1 8.8.8.8 >/dev/null 2>&1; then
     echo "ERROR: No internet connectivity"
     exit 1
   fi

   # Verify DNS resolution
   if ! nslookup $DOMAIN >/dev/null 2>&1; then
     echo "ERROR: Domain $DOMAIN does not resolve"
     echo "Configure DNS or router port forwarding first"
     exit 1
   fi
   ```

5. **Port Forwarding Validation:**

   ```bash
   # After setup, test external accessibility
   curl --connect-timeout 5 http://$DOMAIN/ || \
     echo "WARNING: Port 80 not accessible from internet"
   ```

6. **Certbot Helper File Creation:**

   ```bash
   # Create missing files if not present
   [ -f /etc/letsencrypt/options-ssl-nginx.conf ] || \
     create_ssl_nginx_conf

   [ -f /etc/letsencrypt/ssl-dhparams.pem ] || \
     openssl dhparam -out /etc/letsencrypt/ssl-dhparams.pem 2048
   ```

7. **Don't add excessive waiting/retries for database issues**
   - If postgres is healthy but backend can't connect, it's a Docker state issue
   - Extra delays and retries won't fix underlying state problems
   - A system reboot fixes the issue immediately
   - Focus on preventing Docker state issues instead (see Issue #5)

8. **Better Error Reporting:**

   ```bash
   # Capture detailed errors for troubleshooting
   docker compose logs > /var/log/portfolio-setup-$(date +%s).log
   ```

---

## Documentation Updates

1. **docs/PRE_DEPLOYMENT_CHECKLIST.md** (new): Comprehensive checklist covering:
   - Router port forwarding configuration (step-by-step)
   - Network/DNS verification
   - Server prerequisites
   - Environment variable preparation
   - Pre-flight validation
   - Troubleshooting guide

2. **README.md:** Reference pre-deployment checklist
3. **docs/INFRASTRUCTURE.md:** Add "Deployment Sequence" with phase-by-phase steps
4. **scripts/deploy/server-setup.sh:**
   - Add `--check-only` flag for pre-flight validation
   - Add external port accessibility test
   - Add comments explaining each phase
5. **docs/TROUBLESHOOTING.md** (new): Common issues and fixes

---

## Docker Troubleshooting Strategy

If Docker gets into a bad state during setup:

1. **First attempt:** `docker compose down && docker system prune -f`
2. **Second attempt:** `sudo systemctl restart docker`
3. **If still failing:** Don't spend more than 5 minutes trying fixes — **just reboot**

   ```bash
   sudo reboot
   ```

**Why:** Docker can get into kernel-level state issues that daemon restarts can't clear. A full reboot is faster than extensive troubleshooting.

---

## Environment & Infrastructure Notes

### Server Configuration

- **OS:** Ubuntu Server 22.04 LTS (fresh installation recommended)
- **Architecture:** Moved from Raspberry Pi (initial Pi setup) to Ubuntu Server (production deployment)
- **Docker:** Single docker-compose.yml for both local dev and production
- **Database:** PostgreSQL in Docker container with health checks
- **Reverse Proxy:** Nginx in Docker container (production) or direct backend (local dev)

### Environment Variables Handling

- **Critical:** JWT_SECRET and DB_PASSWORD must be set before `docker compose up`
- **File:** `.env.prod` contains production values; not checked into git
- **Timing:** Environment vars needed at docker-compose startup, not during setup script runtime
- **Secrets:** Keep passwords in `.env.prod` and `~/.env` files, never in docker-compose.yml

### Docker Compose Differences

- **Local Dev:** docker-compose.yml with explicit bind mounts
- **Production:** Same compose file with `.env.prod` overrides (BACKEND_HOST=127.0.0.1 instead of 'backend')
- **Volume Mounts:** Use explicit `type: bind` for Windows path compatibility (MSYS translation issues)
- **Health Checks:** Backend waits for postgres health, not just service startup

---

## Troubleshooting Commands & Tools Used

### Most Useful Commands During Deployment

```bash
# Check port availability (most important pre-flight check)
sudo lsof -i :80 -i :443
sudo netstat -tlnp | grep -E ':80|:443'

# Find processes using ports
lsof -i :443
ps aux | grep <process-name>

# Kill stubborn processes
sudo killall -9 httpd
sudo killall -9 apache2

# Check service status
systemctl status <service-name>
sudo systemctl list-units --type=service

# Docker diagnostics
docker ps
docker compose ps
docker compose logs <service>
docker compose logs --tail=50 backend
docker system prune -f

# Network diagnostics
curl http://localhost/health
curl https://yourdomain.com/health
nslookup yourdomain.com
curl ifconfig.me  # Check public IP

# Disk space
df -h /
du -sh ~/*

# Time sync (critical for SSL)
timedatectl status
date

# Certbot diagnostics
sudo certbot certificates
ls -la /etc/letsencrypt/live/yourdomain.com/
```

### What Did NOT Help

- ❌ Adding `sleep` delays to database checks — timing was not the issue
- ❌ Restarting Docker daemon incrementally — kernel state issues require reboot
- ❌ Manually creating certbot helper files — should have re-run certbot instead
- ❌ Health check retries and timeouts — masked Docker state problem
- ❌ Incremental docker-compose down/up cycles — didn't clear stale containers

### What Solved Problems

- ✅ Full system reboot — immediately cleared Docker state issues
- ✅ Checking port availability BEFORE anything else — prevented cascading failures
- ✅ Re-running certbot after fixing port forwarding — created missing SSL files automatically
- ✅ `docker compose logs` — showed actual error messages (better than health check status)
- ✅ Fresh OS install — eliminated surprise pre-installed conflicting software
- ✅ Restarting `docker.socket` before `docker` — fixed missing `/run/docker.sock` after CE install
- ✅ Removing duplicate apt source file — cleared noisy `apt update` warnings

---

## Timing Breakdown (Actual Deployment)

| Phase | Estimated | Actual | Notes |
|-------|-----------|--------|-------|
| Server OS setup | 5 min | 5 min | ✓ Straightforward |
| Pre-flight checks | 5 min | 15 min | ⚠ Found Apache/Nextcloud issues |
| Remove Apache/Nextcloud | 5 min | 15 min | ⚠ Had to kill processes |
| Docker installation | 5 min | 10 min | ✓ Straightforward, applied user to docker group |
| Git clone repository | 2 min | 2 min | ✓ Straightforward |
| Environment setup | 5 min | 20 min | ⚠ Generating secrets, creating .env.prod |
| docker compose up | 3 min | 25 min | ⚠ Docker permission issues (reboot fixed) |
| Certbot SSL setup | 5 min | 45 min | ⚠ Port forwarding not configured initially |
| Backend health checks | 3 min | 25 min | ⚠ Docker state issue (reboot fixed) |
| Final verification | 5 min | 10 min | ✓ All endpoints working |
| **Total** | **43 min** | **4 hours** | Most time on troubleshooting |

**Key insight:** 75% of actual time was troubleshooting (mostly Docker state + port forwarding). With proper pre-flight checks and fresh OS, could be 40-45 minutes.

---

## What Worked Well

Things that went right and should be preserved:

1. **Docker Compose Approach** — Single compose file for both local and production is elegant; minimal differences via .env overrides
2. **Nginx as Reverse Proxy** — Clean separation; easy to understand; handles static files and SSL termination well
3. **Let's Encrypt Integration** — Certbot setup is straightforward once port forwarding is configured
4. **Backend Health Checks** — Even with timing issues initially, health checks correctly identify when backend isn't ready
5. **Database Idempotent Schema** — schema.sql with IF NOT EXISTS makes it safe to reapply; no migration tool needed
6. **Modular Route Structure** — Easy to understand what each route does; test coverage sufficient
7. **Static HTML/CSS/JS** — No build step means no webpack/babel issues; Nginx serves directly
8. **WebAuthn Auth** — FIDO2 passkeys work well; better than passwords; email magic links as fallback
9. **Guided migration script** — `migrate-from-snap-docker.sh` interactive flow worked cleanly; env backup/restore preserved all config

---

## Post-Deployment Verification Checklist

After deployment, verify these manually:

```bash
# Check site accessibility
curl -L https://yourdomain.com/health          # Backend health (follow redirect)
curl https://yourdomain.com/api/posts          # Public API
curl https://yourdomain.com/login/         # Admin login page
curl https://yourdomain.com/admin/         # Admin console (after login)

# Note: a 301 response from http://yourdomain.com/health is CORRECT —
# it is the HTTP→HTTPS redirect. Use curl -L or request via HTTPS directly.

# Check SSL certificate
openssl s_client -connect yourdomain.com:443 </dev/null | grep -E "subject|issuer|dates"

# Check database connectivity
docker compose exec backend npm run db:check  # (If this command exists)

# Check disk usage
df -h /

# Check container status
docker compose ps
docker compose logs --tail=20

# Verify uploads directory exists and is writable
ls -la uploads/
touch uploads/.test && rm uploads/.test

# Check Nginx logs for errors
docker compose logs nginx | grep -i error
```

---

## Testing & Validation

After implementing improvements, test the revised setup script:

- [ ] Test on fresh Ubuntu Server VM
- [ ] Test with pre-installed Apache (verify it's detected and error is clear)
- [ ] Test with limited disk space (verify error before download)
- [ ] Test with ports already in use (verify error)
- [ ] Test full deployment sequence end-to-end
- [ ] Document exact deployment time and any remaining issues

---

## Timeline & Impact

**Actual deployment time:** ~4 hours (most time spent troubleshooting)

**Estimated time with improvements:** ~30-45 minutes

**Risk mitigation:**

- Phase-by-phase validation catches issues early
- Pre-flight checks prevent common mistakes
- Better error messages reduce troubleshooting time

---

## Conclusion

The deployment succeeded despite numerous obstacles. The issues were primarily environmental (pre-installed software, missing files) rather than architectural. With the improvements outlined here, future deployments should be significantly faster and more reliable.

---

## Release 2026-05-18 Deployment — 2026-05-19

### Executive Summary

Release 2026-05-18 (security hardening + deploy automation) was deployed to production after an extended troubleshooting session. The deploy pipeline itself surfaced several configuration gaps in the prod compose and deploy scripts that were not caught during dev testing. All issues were resolved and the site is live and healthy.

**Outcome:** Successful after ~2.5 hours of troubleshooting across 8 distinct issues.

---

### Issue 1: Port 8080 Conflict — Wekan Snap

**Symptom:** `failed to bind host port 127.0.0.1:8080/tcp: address already in use` — backend container refused to start.

**Root Cause:** Wekan (a Kanban app installed as a snap) was running a Node.js process bound to `0.0.0.0:8080` on the host. The prod compose now explicitly binds `127.0.0.1:8080` for health checks, which collashed with Wekan's binding.

**Resolution:** `sudo snap stop wekan` before deploying.

**Root Cause Analysis:** Port assignments are not tracked centrally. The dev backend also binds internally to port 8080 (mapped to 8081 on the host), creating a second collision risk when both stacks run simultaneously.

**Lesson Learned:** All services on the host (Docker and non-Docker) must be audited for port usage before deploying. The pre-flight `check_disk_space` phase should include a port availability check for all ports the compose file will bind.

**Recommended Fix:** Add a port pre-flight check to `deploy-lib.sh`; change prod backend to a port that doesn't clash with dev or Wekan (see issue #297).

---

### Issue 2: `check_nginx_config` False-Fails in Standalone Container

**Symptom:** `nginx: [emerg] host not found in upstream "backend"` — deploy aborted at the nginx config test phase before any containers were up.

**Root Cause:** `check_nginx_config` runs `nginx -t` inside a standalone container outside the Docker Compose network. The `backend` hostname is only resolvable inside the compose network at runtime — nginx's upstream resolution fails in isolation.

**Resolution:** Manually commented out `check_nginx_config nginx` in `prod-deploy.sh` on the server.

**Root Cause Analysis:** The function was designed for dev where it worked incidentally (different network topology). It was ported to prod without accounting for the upstream resolution difference.

**Lesson Learned:** `nginx -t` validates config syntax but cannot validate upstream hostnames without the full network. The check needs to either use `resolver 127.0.0.11` in the nginx template or be restructured to run inside the running compose network.

---

### Issue 3: `NODE_ENV` and `LOG_LEVEL` Not Wired into Prod Compose

**Symptom:** Backend crashed immediately with `unable to determine transport target for "pino-pretty"` — `pino-pretty` is a dev dependency not present in the prod image.

**Root Cause:** `docker-compose.prod.yml` uses an explicit `environment:` block. `NODE_ENV` and `LOG_LEVEL` were in `.env` but not listed in the block, so they were never passed to the container. The logger defaulted to `pino-pretty` (non-production mode).

**Resolution:** Added `NODE_ENV` and `LOG_LEVEL` to the backend environment block in the compose file.

**Root Cause Analysis:** The explicit `environment:` pattern requires every variable to be listed — unlike `env_file:` which passes all variables wholesale. New env vars added to `.env` and the template are invisible to containers until explicitly wired into the compose file.

**Lesson Learned:** When adding new env vars, always check all three compose files (`docker-compose.yml`, `docker-compose.dev-server.yml`, `docker-compose.prod.yml`) and wire them in. The template sync only updates `.env` — it does not update compose files.

---

### Issue 4: Backend Port Not Exposed on Host in Prod Compose

**Symptom:** Even after fixing the `NODE_ENV` issue, the deploy health check at `http://localhost:8080/health` timed out — the backend was healthy inside Docker but unreachable from the host.

**Root Cause:** `docker-compose.prod.yml` had no `ports:` mapping for the backend service. The health check in `deploy-lib.sh` polls `http://localhost:${PORT}/health` from the host, which requires a host-bound port.

**Resolution:** Added `"127.0.0.1:${PORT:-8080}:${PORT:-8080}"` to the backend ports in the prod compose file.

**Root Cause Analysis:** This binding was documented as part of the #279 (`/health` internal-only) work but was not present in the version of the compose file that shipped. The dev compose had `8081:8081` explicitly; prod was missing the equivalent.

**Lesson Learned:** Always diff prod and dev compose files when making infrastructure changes. The port binding is intentionally localhost-only so the backend is not publicly exposed.

---

### Issue 5: `run_deploy_tests` Runs Vitest in Prod Image

**Symptom:** Deploy passed health checks but immediately rolled back with `sh: vitest: not found`.

**Root Cause:** `run_deploy_tests` executes `npm test` inside the running backend container. The prod image is built with `--omit=dev`, so `vitest` and all other devDependencies are absent.

**Resolution:** Commented out `run_deploy_tests backend` in `prod-deploy.sh`.

**Root Cause Analysis:** The function was designed for the dev stack (which uses `target: dev` and includes devDependencies). When ported to prod, this was not accounted for. In prod, post-deploy validation should use the regression smoke suite (`test-regression.sh`) run externally — not `npm test` inside the container.

**Lesson Learned:** Vitest belongs in dev; smoke tests belong in prod. `run_deploy_tests` should detect the build target / `NODE_ENV` and skip gracefully in production, with a clear log message directing operators to the regression suite instead.

---

### Issue 6: `HEALTH_INSECURE` Unbound Variable in Prod

**Symptom:** `deploy-lib.sh: line 963: HEALTH_INSECURE: unbound variable` — deploy aborted during CSP test phase.

**Root Cause:** `HEALTH_INSECURE` is set in `dev-deploy.sh` (needed for the self-signed cert) but was never added to `prod-deploy.sh`. The variable is referenced in `deploy-lib.sh` which is shared between both.

**Resolution:** Added `HEALTH_INSECURE=0` to `prod-deploy.sh`.

**Root Cause Analysis:** Shared library variables must be explicitly set in every caller. When `deploy-lib.sh` was extended with new variables, the prod deploy script was not updated in sync.

**Lesson Learned:** Shared deploy library variables should have documented defaults or use `${VAR:-default}` expansion throughout `deploy-lib.sh` to prevent unbound variable errors in `set -u` mode.

---

### Issue 7: Outlook Refresh Token Expired

**Symptom:** Magic link email silently failed — `invalid_grant: AADSTS70000: The provided value for the input parameter 'refresh_token' is not valid`.

**Root Cause:** The Outlook OAuth2 refresh token in `.env` had expired or been invalidated (Microsoft invalidates tokens if the client secret changes or the token is unused for 90 days).

**Resolution:** Re-ran `generate-outlook-refresh-token.js` on Windows to obtain a new token, updated `.env`, restarted containers.

**Lesson Learned:** Outlook refresh tokens are long-lived but not permanent. Add a proactive token validity check to the backend startup preflight. The magic link flow fails silently from the user's perspective (anti-enumeration response is always `{sent: true}`) — this makes expired tokens hard to detect without checking logs.

---

### Issue 8: Deploy Script Reverts Local Edits via `git reset --hard`

**Symptom:** Edits made to `docker-compose.prod.yml` and `prod-deploy.sh` were wiped on each deploy run because `update_to_branch` calls `git reset --hard origin/$BRANCH`.

**Root Cause:** By design — the deploy script ensures the server always runs exactly what's in the repo. But during an active debugging session this creates a frustrating loop where fixes must be committed before they can be tested.

**Lesson Learned:** All config fixes must be committed and pushed to the branch being deployed before running the deploy. Do not attempt to fix-and-deploy with local edits — they will be wiped. Use `--skip-regression` and `--quiet` during iterative debugging runs to speed up the cycle.

---

### Self-Healing Recommendation

Several issues above (port conflicts, unhealthy containers, unbound variables) could be mitigated by escalating self-healing in the deploy pipeline:

1. **Port pre-flight:** Detect bound ports before starting compose; kill or warn about conflicting non-Docker processes
2. **Nginx config test fix:** Run inside the compose network or use `resolver 127.0.0.11` to avoid upstream resolution failures
3. **Graceful `run_deploy_tests` skip:** Detect prod environment and skip vitest, emit a clear checkpoint instead
4. **Token validity pre-flight:** Test Outlook token at backend startup and emit a structured warning (not a crash) if invalid
5. **Unbound variable defaults:** Use `${VAR:-default}` throughout `deploy-lib.sh` to survive missing declarations in callers

These are captured in issue #298.

Key takeaway: **Start simple (HTTP), validate each phase, then add complexity (SSL, backups, monitoring).**

---

## 1 TB SSD Migration — 2026-07-13

### Executive Summary

Migrated `ak-home-server` from a 37.3 GB SSD to a 1 TB SSD (#529). `scripts/ops/migration-restore.sh` (#533) scripted Phase 3/4 (OS baseline + data restore) to remove typo risk on a one-shot, hard-to-reverse disk operation. The design doc (written before touching real hardware) missed several gaps that only surfaced by running the migration and independently verifying the live box afterward rather than trusting the script's own "done" output.

**Outcome:** Successful — all Compose stacks, backups, and GPU-accelerated Ollama confirmed healthy on the new disk. ~2 hours from design doc to fully verified, most of it spent on the GPU passthrough gaps below.

---

### Issue 1: Root LV Only Allocated ~98 GB of the 929 GB Disk

**Symptom:** `df -h /` showed the root filesystem far smaller than the physical disk after the initial OS install.

**Root Cause:** Ubuntu's guided/custom storage layout during install didn't allocate the full VG to `ubuntu-vg/ubuntu-lv`, leaving ~830 GB unallocated. Not caught by the design doc, which assumed the installer would use the whole disk.

**Resolution:** `migration-restore.sh` section 1 runs `sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv && sudo resize2fs /dev/mapper/ubuntu--vg-ubuntu--lv` before anything else starts.

**Lesson Learned:** Never assume an OS installer used the full disk — verify `df -h /` against the physical disk size as an explicit Phase 3 step, not an afterthought.

---

### Issue 2: Dead Root Crontab Entry Would Have Been Silently Carried Over

**Symptom:** The captured manifest showed a root crontab line using `~/MyPortfolioSite/scripts/backup/db-backup.sh`.

**Root Cause:** `~` in root's own crontab resolves to `/root`, which never had this repo checked out — the path never existed. This entry was already non-functional on the old system; the real daily backup ran from the deploy user's own crontab with an absolute path. A verbatim restore would have carried the dead entry forward without anyone noticing (cron doesn't alert on a nonexistent script path by default).

**Resolution:** `migration-restore.sh` filters out any crontab line containing a literal `~` before restoring root's crontab; the working, absolute-path entry in the deploy user's crontab is restored unmodified.

**Lesson Learned:** Restoring configuration "verbatim from the old system" isn't automatically correct — verify each entry still resolves to something real in the new context, especially path expansions that differ by user.

---

### Issue 3: Ollama Container Detection Silently Skipped Starting It

**Symptom:** Everything else in the migration checked out — Compose stacks healthy, backups running — but `docker ps -a` showed no `ollama` container at all, and port 11434 was unreachable. The script itself reported no errors.

**Root Cause:** Section 10's existence check was `docker inspect ollama`, which matches *any* Docker object by that name, not just containers. An `ollama` volume already existed (from an earlier partial attempt), so the check always succeeded and the script concluded the container was already running — even though it never existed. This was invisible from the script's own log output; it only surfaced by independently checking `docker ps -a` against the live box.

**Resolution:** Narrowed the check to `docker inspect --type container ollama` (fixed in #533's follow-up commit). Also hardened the CPU-only fallback to `docker rm -f ollama` first, since a failed `--gpus all` attempt leaves a stopped/created container behind that blocks the fallback from reusing the name.

**Lesson Learned:** `docker inspect <name>` is not a reliable existence check for a specific resource type — it silently matches volumes, networks, and images sharing the name. Idempotency checks in ops scripts need to name the resource type explicitly (`--type container`), and a script reporting no errors is not the same as verifying the end state actually matches what it claims to have done.

---

### Issue 4: GPU Driver Partially Installed, Nothing Actually Working

**Symptom:** `nvidia-smi` returned "command not found"; `docker run --gpus all` failed with "failed to discover GPU vendor from CDI: no known GPU vendor found".

**Root Cause:** Some NVIDIA library packages (`libnvidia-cfg1-580-server`, `libnvidia-compute-580-server`, `nvidia-headless-no-dkms-580-server`) were present from an earlier, incomplete attempt, but `dkms` itself wasn't installed, so no kernel module was ever built (`lsmod` showed nothing), and `nvidia-utils-580-server` (which provides `nvidia-smi`) was missing entirely. The design doc had flagged GPU setup as an unscripted manual follow-up but didn't capture what "complete" actually required.

**Resolution:** `sudo apt install dkms nvidia-driver-580-server nvidia-utils-580-server`, then reboot for the kernel module to load.

**Lesson Learned:** A partially-installed driver stack gives no obvious signal that it's incomplete — `dpkg -l | grep nvidia` showing packages doesn't mean the GPU is usable. Verify with `nvidia-smi` directly, not package presence.

---

### Issue 5: `nvidia-container-toolkit` Not in Default Repos

**Symptom:** `sudo apt install nvidia-container-toolkit` failed with `E: Unable to locate package nvidia-container-toolkit`.

**Root Cause:** The container toolkit isn't part of Ubuntu's default apt sources — it's only distributed via NVIDIA's own repo, which has to be added explicitly (signing key + `.list` file).

**Resolution:** Added the repo per NVIDIA's documented steps, then `apt update && apt install nvidia-container-toolkit` resolved cleanly. Full commands now in `docs/INFRASTRUCTURE.md`.

**Lesson Learned:** `apt`'s "unable to locate package" gives no hint that the fix is "add a different repo" versus "package renamed" versus "typo" — worth documenting the exact repo-add commands anywhere GPU setup is described, rather than relying on the error message to point the way.

---

### Issue 6: Docker Didn't See the GPU Even With the Toolkit Installed

**Symptom:** With the driver working (`nvidia-smi` confirmed) and the toolkit installed, `docker run --gpus all` still failed — this time with `AMD CDI spec not found`, on a box with no AMD hardware at all.

**Root Cause:** Installing `nvidia-container-toolkit` doesn't automatically register a runtime with Docker. `sudo nvidia-ctk runtime configure --runtime=docker` has to be run explicitly to write the `nvidia` runtime into `/etc/docker/daemon.json`, followed by a Docker daemon restart to pick it up. Without that, Docker falls through to CDI-based GPU resolution with no vendor spec registered for either vendor, producing the (misleading, vendor-mismatched) AMD error.

**Resolution:** `sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker`. All existing `--restart always` containers (both prod and dev Compose stacks) resumed automatically post-restart with no manual intervention.

**Lesson Learned:** The `AMD CDI spec not found` error is a red herring on NVIDIA-only hardware — it means "no CDI vendor spec is registered at all," not "wrong vendor detected." Confirm `docker info | grep -i runtime` lists `nvidia` before assuming the toolkit install alone was sufficient.

---

Key takeaway: **A script or driver install reporting success is not verification — for hardware-adjacent changes (GPU passthrough, disk migrations), independently check the actual live end state (`docker ps -a`, `nvidia-smi`, `docker info`) rather than trusting exit codes and log output alone.**
