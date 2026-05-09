#!/bin/bash

# Gather infrastructure information for docs/INFRASTRUCTURE.md
# Run on production server: bash scripts/ops/gather-infrastructure-info.sh
# Output can be pasted directly into documentation

set +e  # Don't exit on errors — collect what we can

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║  INFRASTRUCTURE INFO GATHERING                                 ║"
echo "║  Run this on the Ubuntu Server, pipe output to a file or copy ║"
echo "╚════════════════════════════════════════════════════════════════╝"
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
ls -la ~/ | grep -E "MyPortfolioSite|backups|.env"
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

echo "Script ready to run on Ubuntu Server."
echo "Output captures: system info, Docker setup, Nginx config, SSL certs, database, backups, environment, services, health checks, git deployment, and network details."
