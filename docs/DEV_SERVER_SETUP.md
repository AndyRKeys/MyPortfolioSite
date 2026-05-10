# Dev Server Setup

Sets up the `dev` branch as a second environment on the Ubuntu Server, accessible LAN-only at `https://<LAN_IP>:3001` (HTTPS with self-signed certificate).

The deploy script handles cloning, `.env` creation, building, certificate generation, and health-checking automatically. You only need to do three things manually before the first run.

---

## Step 1 — Find your LAN IP

SSH into the server and run:

\`\`\`bash
ip -4 addr show | grep inet | grep -v 127.0.0.1
\`\`\`

Note the address — it will look like `192.168.x.x`. You need it in step 3.

---

## Step 2 — Configure firewall (UFW)

> ⚠️ **Add SSH first.** If you enable UFW without an SSH rule, you will lock yourself out of the server.

Run these in order:

\`\`\`bash
# 1. Allow SSH (CRITICAL — do this before enabling UFW)
sudo ufw allow 2222/tcp comment 'SSH'

# 2. Allow dev site from LAN only
sudo ufw allow from 192.168.0.0/16 to any port 3001 comment 'Dev site LAN-only'

# 3. Enable UFW
sudo ufw enable

# Verify all rules are in place
sudo ufw status
\`\`\`

Expected output should show rules for port 2222 and 3001. If your home network uses a `10.x.x.x` subnet, adjust the port 3001 rule accordingly.

**Required firewall rules summary:**

| Port | Protocol | Source | Purpose |
|------|----------|---------|---------|
| 2222 | TCP | Any | SSH access |
| 3001 | TCP | 192.168.0.0/16 | Dev site (LAN-only) |

---

## Step 2b — Install micro (optional but recommended)

For a modern text editor with familiar shortcuts (Ctrl+S to save, Ctrl+Q to quit):

\`\`\`bash
sudo apt install micro
\`\`\`

You'll use this to edit `.env` in step 3.

---

## Step 3 — Run the deploy script

**From Windows (recommended):**

\`\`\`powershell
.\scripts\deploy\dev-server-deploy.ps1
\`\`\`

**From the server directly:**

\`\`\`bash
bash ~/MyPortfolioSite-dev/scripts/deploy/dev-server-deploy.sh
\`\`\`

### What happens on the first run

The script checks for a `.env` file. If one doesn't exist it copies `.env.dev-server.example` into place and stops with instructions:

\`\`\`
[WARN]  .env created but not yet configured.
[WARN]  Edit ~/MyPortfolioSite-dev/.env and set these values:
[WARN]    LAN_IP           — your server LAN IP (ip -4 addr show)
[WARN]    DB_PASSWORD      — strong random password
[WARN]    JWT_SECRET       — random string, min 32 chars (openssl rand -base64 32)
[WARN]    WEBAUTHN_RP_ID   — same as LAN_IP (bare IP, no protocol/port)
[WARN]    WEBAUTHN_ORIGIN  — https://<LAN_IP>:3001
[WARN]    FRONTEND_URL     — https://<LAN_IP>:3001
\`\`\`

Edit the file with:

\`\`\`bash
micro ~/MyPortfolioSite-dev/.env
\`\`\`

Fill in the required values above. The rest of the file can stay as defaulted.

Generate secrets with:
\`\`\`bash
openssl rand -base64 32
\`\`\`

### Automatic certificate generation

On the first run (and whenever LAN_IP changes), the deploy script automatically generates a self-signed HTTPS certificate for your LAN IP. This is required because WebAuthn (passkey registration) only works over HTTPS or localhost.

The certificate is generated with:
- **Valid for 10 years** — covers the lifetime of most dev environments
- **Self-signed** — no external CA needed, your browser will warn once and then cache it
- **Includes both IP and localhost** — works whether you access via IP or hostname

**On your first visit to `https://<LAN_IP>:3001`:**

Your browser will show a certificate warning (self-signed). Click "Advanced" → "Accept the risk and continue" (or equivalent). The certificate is then cached and you won't see the warning again until the certificate expires or changes.

To verify the certificate details on the server:
\`\`\`bash
openssl x509 -in ~/MyPortfolioSite-dev/scripts/config/certs/dev-server.crt -noout -text
\`\`\`

### What happens on the second run (and all future runs)

The script validates `.env`, generates/verifies the certificate, builds the containers, and polls the health endpoint. On success:

\`\`\`
╔══════════════════════════════════════════╗
║           Dev deploy complete ✓          ║
╚══════════════════════════════════════════╝
\`\`\`

---

## Testing Feature Branches Before PR

The deploy script automatically detects your current git branch and deploys it. This enables rapid testing without creating a PR first.

### Workflow

1. Check out your feature/fix branch locally:
   \`\`\`bash
   git checkout fix/some-issue
   \`\`\`

2. Make your changes and commit:
   \`\`\`bash
   git add .
   git commit -m "fix: description"
   git push -u origin fix/some-issue
   \`\`\`

3. Deploy directly to the dev server:
   \`\`\`powershell
   .\scripts\deploy\dev-server-deploy.ps1
   \`\`\`

   The script detects you're on `fix/some-issue` and deploys from that branch. You'll see it in the deploy summary:
   \`\`\`
   [OK]    Branch:  fix/some-issue
   [OK]    Commit:  a1b2c3d
   \`\`\`

4. Test on the dev server at `https://<LAN_IP>:3001` (accept the self-signed certificate warning in your browser)

5. When testing passes, create a PR and merge to `dev`:
   \`\`\`bash
   git push -u origin fix/some-issue
   # Create PR via GitHub UI or: gh pr create --base dev
   \`\`\`

### Explicit branch override (optional)

If you want to deploy a specific branch instead of your current one:

\`\`\`powershell
.\scripts\deploy\dev-server-deploy.ps1 -Branch fix/different-issue
\`\`\`

---

## Future deploys

To pull the latest `dev` branch (or any other branch) to the server, run:

\`\`\`powershell
# From Windows — auto-detects current branch
.\scripts\deploy\dev-server-deploy.ps1
\`\`\`

\`\`\`bash
# From the server — deploy latest dev
bash ~/MyPortfolioSite-dev/scripts/deploy/dev-server-deploy.sh
\`\`\`

Logs are written to `~/dev-deploy.log` on the server.

---

## Useful commands

\`\`\`bash
# Check container status
docker compose -f ~/MyPortfolioSite-dev/docker-compose.dev-server.yml ps

# View backend logs
docker compose -f ~/MyPortfolioSite-dev/docker-compose.dev-server.yml logs -f backend-dev

# Stop dev environment (frees resources when not needed)
docker compose -f ~/MyPortfolioSite-dev/docker-compose.dev-server.yml down

# Restart backend only
docker compose -f ~/MyPortfolioSite-dev/docker-compose.dev-server.yml restart backend-dev

# Edit .env with micro
micro ~/MyPortfolioSite-dev/.env
\`\`\`

---

## Troubleshooting

**Health check fails after deploy**

The deploy script automatically dumps container logs on failure. To investigate manually:
\`\`\`bash
docker compose -f ~/MyPortfolioSite-dev/docker-compose.dev-server.yml logs --tail=50 backend-dev
docker compose -f ~/MyPortfolioSite-dev/docker-compose.dev-server.yml logs --tail=20 postgres-dev
\`\`\`

**Port 3001 not reachable from other LAN devices**
\`\`\`bash
sudo ufw status        # confirm the allow rule is present
sudo lsof -i :3001     # confirm nginx-dev is listening
\`\`\`

**SSH connection timeout (port 2222)**
\`\`\`bash
# On the server, check SSH is allowed through UFW:
sudo ufw status | grep 2222
# If missing, add the rule:
sudo ufw allow 2222/tcp comment 'SSH'
\`\`\`

**WebAuthn / passkey errors on the dev site**
- Browsers only allow WebAuthn on HTTPS (or localhost). The dev server uses a self-signed HTTPS certificate for this reason.
- Confirm `WEBAUTHN_RP_ID` in `.env` is the bare IP (no `https://`, no port)
- Confirm `WEBAUTHN_ORIGIN` is exactly `https://<LAN_IP>:3001`
- Accept the self-signed certificate warning in your browser
- Passkeys registered on prod will not work on dev (different origin — expected)

**`.env` validation errors on deploy**

The deploy script checks all required vars on every run and tells you exactly which are missing or still set to placeholder values. Fix them in `~/MyPortfolioSite-dev/.env` and re-run.

**Docker permission errors when stopping containers**

If you see `cannot stop container: permission denied` errors during deploy, the Docker daemon needs to restart:
\`\`\`bash
sudo systemctl restart docker
# If that doesn't work, reboot the server:
sudo reboot
\`\`\`

---

## Recovery & Self-Healing

The deploy script automatically attempts recovery before giving up. All actions are scoped to the **dev stack only** — the production site is unaffected. When the health check fails after a deploy, it escalates through three tiers before rolling back:

| Tier | Action | Scope | When |
|------|--------|-------|------|
| 1 | Restart backend container only | Dev stack | Health check fails after `up` |
| 2 | Full `down` + `up` (no rebuild) | Dev stack | Tier 1 fails |
| Rollback | Reset to previous commit + rebuild | Dev stack | Tier 2 fails |

### Consecutive failure tracking

The script tracks consecutive failures in `~/.dev-deploy-failures`. On success this file is cleared. If failures accumulate:

- **2 failures** — script recommends `sudo systemctl restart docker`
  - ⚠️ **WARNING:** Docker daemon restart **WILL INTERRUPT BOTH DEV AND PRODUCTION** briefly
  - Only run if dev site won't come up and you've ruled out other issues
  - Re-run the deploy script after restart completes

- **3+ failures** — script recommends nuclear rebuild (see below)
  - Only affects dev stack (containers, images, networks)
  - Dev database is preserved
  - **Does NOT affect production site**
  - But persistent failures suggest deeper infrastructure problems; monitor system resources

Check the current failure count:
\`\`\`bash
cat ~/.dev-deploy-failures 2>/dev/null || echo "0"
\`\`\`

Reset manually (e.g. after fixing a known issue):
\`\`\`bash
rm -f ~/.dev-deploy-failures
\`\`\`

### Nuclear rebuild (last resort)

When normal recovery fails, the nuclear rebuild tears down dev containers, images, and networks and rebuilds from scratch.

**Important:**
- **Only affects the dev stack** — production site is completely unaffected
- **Database is preserved by default** — you keep your dev data
- Teardown and rebuild takes ~2-5 minutes depending on system load

\`\`\`bash
bash ~/MyPortfolioSite-dev/scripts/setup/nuclear-rebuild.sh
\`\`\`

You must type `nuclear` at the prompt to confirm. After it completes, re-run the deploy script:

\`\`\`bash
bash ~/MyPortfolioSite-dev/scripts/deploy/dev-server-deploy.sh
\`\`\`

**Reset dev database (if schema is corrupt — very rare):**

Use `--wipe-db` only when you know dev data is unrecoverable:
\`\`\`bash
bash ~/MyPortfolioSite-dev/scripts/setup/nuclear-rebuild.sh --wipe-db
\`\`\`

⚠️ `--wipe-db` **permanently destroys dev blog posts, users, and all dev data**. There is no undo. This does **NOT** affect production.

### Optional: Manual Docker cleanup

If you want to free up disk space by removing Docker build cache and dangling images:

\`\`\`bash
# WARNING: This is a GLOBAL operation that affects ALL services on the server
# (both dev and production). Only run this if you understand the impact.
docker system prune -f
\`\`\`

This removes:
- Dangling images (images not tagged and not used by any container)
- Build cache from previous builds
- Unused networks

**Safe alternatives:**
- \`docker image prune -f\` — only removes dangling images (safer, scoped to images only)
- \`docker builder prune -f\` — only clears build cache (safest)

⚠️ **Do NOT run \`docker system prune\` if the production site is being served from Docker**, unless you understand you're affecting both dev and production.

---

## Docker Maintenance

To keep the dev server stable and prevent Docker issues, maintain the Docker system regularly:

\`\`\`bash
# Weekly: Remove dangling images, volumes, and stopped containers
docker system prune -f --volumes

# Check Docker disk usage
docker system df

# View Docker daemon logs
sudo journalctl -u docker -n 50
\`\`\`

**Add to cron for automatic weekly cleanup:**
\`\`\`bash
sudo crontab -e
# Add this line:
0 2 * * 0 /usr/bin/docker system prune -f --volumes >> /var/log/docker-prune.log 2>&1
\`\`\`

This runs `docker system prune` every Sunday at 2 AM, removing unused images and volumes that can accumulate over time.

---

## Autostart on Reboot

To automatically bring the dev environment online after a system reboot, install the systemd autostart service:

\`\`\`bash
# Enable autostart for the dev stack
sudo bash ~/MyPortfolioSite-dev/scripts/setup/install-dev-autostart.sh

# Verify the service is enabled
systemctl list-unit-files | grep myportfolio-dev

# Start it manually (or wait for reboot)
sudo systemctl start myportfolio-dev

# View status
sudo systemctl status myportfolio-dev

# View startup logs
sudo journalctl -u myportfolio-dev -n 50
\`\`\`

The service will automatically start the dev containers on boot, no manual intervention needed after reboot.