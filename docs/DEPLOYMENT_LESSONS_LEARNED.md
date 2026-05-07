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
   - `/login.html` (authentication)
   - `/admin.html` (admin panel, via magic link)
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

2. **Port Forwarding Validation:**
   ```bash
   # After setup, test external accessibility
   curl --connect-timeout 5 http://$DOMAIN/ || \
     echo "WARNING: Port 80 not accessible from internet"
   ```

3. **Certbot Helper File Creation:**
   ```bash
   # Create missing files if not present
   [ -f /etc/letsencrypt/options-ssl-nginx.conf ] || \
     create_ssl_nginx_conf
   
   [ -f /etc/letsencrypt/ssl-dhparams.pem ] || \
     openssl dhparam -out /etc/letsencrypt/ssl-dhparams.pem 2048
   ```

4. **Don't add excessive waiting/retries for database issues**
   - If postgres is healthy but backend can't connect, it's a Docker state issue
   - Extra delays and retries won't fix underlying state problems
   - A system reboot fixes the issue immediately
   - Focus on preventing Docker state issues instead (see Issue #5)

5. **Better Error Reporting:**
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

---

## Post-Deployment Verification Checklist

After deployment, verify these manually:

```bash
# Check site accessibility
curl https://yourdomain.com/health           # Backend health
curl https://yourdomain.com/api/posts        # Public API
curl https://yourdomain.com/login.html       # Admin login page
curl https://yourdomain.com/admin.html       # Admin console (after login)

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

Key takeaway: **Start simple (HTTP), validate each phase, then add complexity (SSL, backups, monitoring).**
