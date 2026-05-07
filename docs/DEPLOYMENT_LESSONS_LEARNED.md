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

**Root Cause:** Ubuntu Server image came with Apache web server and Nextcloud snap pre-installed from a previous setup.

**Impact:** Certbot validation failed repeatedly. Nginx container crashed at startup.

**Resolution:** 
- Killed Apache processes: `sudo killall -9 httpd`
- Removed Nextcloud: `sudo snap remove nextcloud`

**Lesson Learned:** Must verify clean server state before deployment. Pre-flight checks should detect and warn about:
- Existing web servers (Apache, Nginx, etc.)
- Port conflicts (80, 443)
- Pre-installed services that might interfere

---

### 3. Missing Certbot Helper Files

**Symptom:** Nginx crashed with `unable to load /etc/letsencrypt/options-ssl-nginx.conf` and `/etc/letsencrypt/ssl-dhparams.pem`.

**Root Cause:** Certbot didn't create these files during certificate request. These are normally created during initial certbot setup.

**Impact:** Nginx failed to start even though SSL certificates existed. Docker container restarted continuously.

**Resolution:** 
- Created `options-ssl-nginx.conf` manually with standard TLS config
- Generated `ssl-dhparams.pem` manually: `sudo openssl dhparam -out /etc/letsencrypt/ssl-dhparams.pem 2048`

**Lesson Learned:** The server-setup.sh script should:
- Detect missing certbot helper files and create them if absent
- Generate DH parameters during initial setup, not just during cert request
- Validate all SSL file paths before nginx startup

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

**Impact:** Extended troubleshooting time. Required system reboot to resolve.

**Resolution:** `sudo systemctl restart docker` + reboot, then containers behaved normally.

**Lesson Learned:** 
- User group membership changes may require session restart or systemd service restart
- Docker can get into inconsistent state requiring full system restart
- Implement retry logic with exponential backoff for container operations in setup script

---

### 6. Database Initialization Timing Issues

**Symptom:** Backend health check failed repeatedly with "Health check failed: connect ETIMEDOUT 172.18.0.2:5432" even though postgres container showed healthy.

**Root Cause:** Backend started before postgres fully initialized. Initial system state was inconsistent.

**Impact:** Containers failed health checks on first startup attempt.

**Resolution:** Full system reboot. After reboot, everything succeeded on first try.

**Lesson Learned:** 
- Add configurable health check retries and delays
- Implement explicit wait-for-database logic in server-setup.sh
- Document that first startup may require extra time/retries

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
- [ ] No pre-installed web servers: `systemctl list-units | grep -i apache`
- [ ] No conflicting snaps: `snap list | grep -i web`
- [ ] Port 80/443 accessible from internet
- [ ] Router port forwarding configured for 80 → server, 443 → server
- [ ] Sufficient disk space: `df -h` (recommend 10GB+ free)
- [ ] Internet connectivity: `ping 8.8.8.8`
- [ ] Domain name resolves to server IP: `nslookup yourdomain.com`
- [ ] SSH access working and no known key errors
- [ ] Time synchronized: `timedatectl status`

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

1. **Pre-flight Checks:**
   ```bash
   # Detect conflicting services
   systemctl list-units | grep -E 'apache|httpd|nginx'
   snap list | grep -E 'nextcloud|apache'
   
   # Verify ports are free
   netstat -tlnp | grep ':80\|:443'
   
   # Check disk space
   df /home | awk 'NR==2 {if($4 < 10000000) exit 1}'
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

4. **Database Health Waiting:**
   ```bash
   # Wait longer for database to be truly ready
   MAX_WAIT=60
   ELAPSED=0
   until docker compose exec -T postgres pg_isready ...; do
     if [ $ELAPSED -ge $MAX_WAIT ]; then exit 1; fi
     sleep 2
     ELAPSED=$((ELAPSED + 2))
   done
   ```

5. **Better Error Reporting:**
   ```bash
   # Capture detailed errors for troubleshooting
   docker compose logs > /var/log/portfolio-setup-$(date +%s).log
   ```

---

## Documentation Updates

1. **README.md:** Add "Pre-Deployment Checklist" section
2. **docs/INFRASTRUCTURE.md:** Add "Deployment Sequence" with phase-by-phase steps
3. **scripts/deploy/server-setup.sh:** Add comments explaining each phase
4. **docs/TROUBLESHOOTING.md** (new): Common issues and fixes

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
