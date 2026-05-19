#!/bin/bash

# Gather infrastructure information for docs/INFRASTRUCTURE.md
# Run on production server: bash scripts/ops/gather-infrastructure-info.sh
# Output can be pasted directly into documentation

set +e  # Don't exit on errors — collect what we can

# shellcheck source=../deploy/output-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../deploy/output-lib.sh"

_print_multi_box "" 60 "INFRASTRUCTURE INFO GATHERING" \
  "Run this on the Ubuntu Server, pipe output to a file or copy"
echo ""

# ── System Info ────────────────────────────────────────────────────────────
echo "## System Information"
echo ""
echo "**OS:**"
cat /etc/os-release | grep PRETTY_NAME
echo ""
echo "**Hostname:**"
hostname
echo ""
echo "**Kernel:**"
uname -r
echo ""

# ── Directory Structure ────────────────────────────────────────────────────
echo "## Directory Structure"
echo ""
echo "**Repository location:**"
pwd
echo ""
echo "**Key directories:**"
ls -la ~/ | grep -E "MyPortfolioSite|backups|\.env"
echo ""

# ── Docker & Compose ───────────────────────────────────────────────────────
echo "## Docker & Docker Compose"
echo ""
echo "**Docker version:**"
docker --version
echo ""
echo "**Docker Compose version:**"
docker compose version
echo ""
echo "**Compose files in repo:**"
find . -maxdepth 1 -name "docker-compose*.yml" -o -name ".env*" | grep -v ".git" | sort
echo ""
echo "**Running containers:**"
docker compose -f docker-compose.prod.yml ps 2>/dev/null || echo "(docker compose not running or file not found)"
echo ""

# ── Nginx Config ───────────────────────────────────────────────────────────
echo "## Nginx Configuration"
echo ""
echo "**Nginx config location in repo:**"
find . -name "*nginx*.conf*" | grep -v ".git" | sort
echo ""
echo "**Template variables (from docker-compose.prod.yml):**"
grep -E "DOMAIN|REPO_DIR|APP_PORT|BACKEND_HOST" docker-compose.prod.yml 2>/dev/null | head -20
echo ""

# ── SSL Certificates ───────────────────────────────────────────────────────
echo "## SSL Certificates (Let's Encrypt)"
echo ""
echo "**Cert location:**"
ls -la /etc/letsencrypt/live/ 2>/dev/null | tail -n +4 || echo "(no certs found or permission denied)"
echo ""
echo "**Certificate details (if accessible):**"
sudo ls -lah /etc/letsencrypt/live/*/cert.pem 2>/dev/null || echo "(requires sudo)"
echo ""
echo "**Certbot config:**"
sudo ls -la /etc/letsencrypt/ 2>/dev/null | head -10 || echo "(requires sudo)"
echo ""

# ── PostgreSQL & Database ──────────────────────────────────────────────────
echo "## PostgreSQL Database"
echo ""
echo "**Container name (from compose):**"
grep "postgres:" docker-compose.prod.yml 2>/dev/null | head -3
echo ""
echo "**Database credentials location:**"
echo "  File: ~/.env.prod (not shown — contains secrets)"
echo "  Contents should include: DB_USER, DB_PASSWORD, DB_NAME, DB_HOST"
echo ""
echo "**Database backup location:**"
ls -lah ~/backups/ 2>/dev/null || echo "(no backups yet or directory doesn't exist)"
echo ""

# ── Backups & Cron ────────────────────────────────────────────────────────
echo "## Backups & Cron Jobs"
echo ""
echo "**Backup script location:**"
ls -la scripts/backup/
echo ""
echo "**Cron jobs (user):**"
crontab -l 2>/dev/null || echo "(no user crontab)"
echo ""
echo "**Cron jobs (root):**"
sudo crontab -l 2>/dev/null || echo "(no root crontab or permission denied)"
echo ""

# ── Environment Variables ──────────────────────────────────────────────────
echo "## Environment Variables"
echo ""
echo "**Files:**"
ls -la ~/.env* 2>/dev/null || echo "(no .env files)"
echo ""
echo "**Current environment (non-sensitive):**"
echo "  NODE_ENV: $(echo $NODE_ENV | grep -oE 'production|development|test' || echo 'not set')"
echo "  DOCKER_BUILDKIT: $DOCKER_BUILDKIT"
echo "  (Full .env.prod contents not shown — contains secrets)"
echo ""

# ── Service Status ────────────────────────────────────────────────────────
echo "## Service Status"
echo ""
echo "**Docker services:**"
docker compose -f docker-compose.prod.yml ps 2>/dev/null || echo "(docker compose not initialized)"
echo ""
echo "**Systemd services (if using):**"
systemctl status docker 2>/dev/null | head -5
echo ""

# ── Health Checks ─────────────────────────────────────────────────────────
echo "## Health Checks"
echo ""
echo "**Backend health endpoint:**"
curl -s http://localhost:8080/health 2>/dev/null | head -1 || echo "(backend not responding on localhost:8080)"
echo ""
echo "**HTTPS endpoint:**"
curl -s https://localhost/health 2>/dev/null | head -1 || echo "(nginx not responding or SSL not configured)"
echo ""

# ── Deployment & Git ──────────────────────────────────────────────────────
echo "## Git & Deployment"
echo ""
echo "**Current branch:**"
git branch --show-current
echo ""
echo "**Latest commits:**"
git log --oneline -5
echo ""
echo "**Remote origin:**"
git config --get remote.origin.url
echo ""

# ── Network & Ports ───────────────────────────────────────────────────────
echo "## Network & Ports"
echo ""
echo "**Port usage:**"
sudo lsof -i -P -n 2>/dev/null | grep LISTEN || echo "(requires sudo, or lsof not available)"
echo ""
echo "**Public IP:**"
curl -s ifconfig.me 2>/dev/null || echo "(cannot reach ifconfig.me)"
echo ""
echo "**DNS resolution:**"
nslookup $(grep 'server_name' scripts/config/nginx-portfolio.conf.template 2>/dev/null | head -1 | awk '{print $2}') 2>/dev/null | head -5 || echo "(DNS lookup failed)"
echo ""

# ── Summary ────────────────────────────────────────────────────────────────
echo "═══════════════════════════════════════════════════════════════"
echo "INFRASTRUCTURE SNAPSHOT COMPLETE"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "1. Copy output above to a text file"
echo "2. Share with your AI agent to populate docs/INFRASTRUCTURE.md"
echo "3. The agent will use this to create comprehensive documentation"
echo ""
