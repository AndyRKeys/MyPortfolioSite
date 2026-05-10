#!/usr/bin/env bash
# migrate-from-snap-docker.sh — Guided checklist for moving from Snap Docker
# to the official Docker CE packages on Ubuntu Server.
#
# IMPORTANT:
# - This script is intentionally conservative. It does NOT automatically remove
#   Snap or install docker-ce; instead, it prints the commands and asks you to
#   confirm at each destructive step.
# - Run this script from the Ubuntu host (not inside a container).
#
# Usage:
#   bash scripts/setup/migrate-from-snap-docker.sh

set -euo pipefail

confirm() {
  local prompt="$1"
  read -r -p "$prompt [y/N] " ans
  case "${ans}" in
    [yY][eE][sS]|[yY]) return 0 ;;
    *) return 1 ;;
  esac
}

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   Migrate Snap Docker → Docker CE (apt)  ║"
echo "╚══════════════════════════════════════════╝"
echo ""

echo "[INFO] This script will walk you through the high-level steps to migrate" \
     "from Snap Docker to Docker CE on Ubuntu. It will NOT run destructive" \
     "commands without your confirmation."

echo ""
echo "Step 0: Inspect current Docker/Snap state (recommended)"
echo "-------------------------------------------------------"
if confirm "Run docker-migration-checklist.sh now?"; then
  bash "$(dirname "$0")/docker-migration-checklist.sh" || echo "[WARN] checklist script failed"
fi

echo ""
echo "Step 1: Stop dev stack and ensure important data is in named volumes"
echo "---------------------------------------------------------------------"
echo "Suggested commands (run manually in another shell if not already done):"
echo "  cd ~/MyPortfolioSite-dev"
echo "  docker compose -f docker-compose.dev-server.yml down --remove-orphans"
echo ""
echo "Make sure any important data is in named volumes (e.g. postgres_dev_data, uploads_dev_data)," \
     "not just anonymous containers."
echo ""

if ! confirm "Have you stopped the dev stack and confirmed data is safe in volumes?"; then
  echo "[INFO] Aborting migration script at Step 1."
  exit 0
fi

echo ""
echo "Step 2: Stop Snap Docker daemon"
echo "--------------------------------"
echo "Command to run manually:" 
echo "  sudo systemctl stop snap.docker.dockerd"
echo ""
if ! confirm "Have you stopped snap.docker.dockerd (or are you ready to do so now)?"; then
  echo "[INFO] Aborting migration script at Step 2."
  exit 0
fi

echo ""
echo "Step 3: Remove Snap Docker (snap remove docker)"
echo "-----------------------------------------------"
echo "Command to run manually:" 
echo "  sudo snap remove docker"
echo ""
echo "WARNING: This removes the Snap package. Docker data under the Snap-managed"
echo "root may be cleaned up, so be sure you have backups / volumes as needed."
echo ""
if ! confirm "Have you removed the docker Snap, or are you ready to do so now?"; then
  echo "[INFO] Aborting migration script at Step 3."
  exit 0
fi

echo ""
echo "Step 4: Install Docker CE from the official apt repository"
echo "-----------------------------------------------------------"
echo "Suggested commands (Ubuntu, from Docker docs):"
echo "  sudo apt-get update"
echo "  sudo apt-get install ca-certificates curl gnupg"
echo "  sudo install -m 0755 -d /etc/apt/keyrings"
echo "  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \"
echo "    sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg"
echo "  echo \"deb [arch=\$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \" \
       "https://download.docker.com/linux/ubuntu \" \
       "\"\$(. /etc/os-release && echo \"$VERSION_CODENAME\")\" stable" | \"
       "sudo tee /etc/apt/sources.list.d/docker.list > /dev/null"
echo "  sudo apt-get update"
echo "  sudo apt-get install docker-ce docker-ce-cli containerd.io \"
echo "       docker-buildx-plugin docker-compose-plugin"
echo ""
if ! confirm "Have you installed Docker CE from the apt repository?"; then
  echo "[INFO] Aborting migration script at Step 4."
  exit 0
fi

echo ""
echo "Step 5: Add your user to the docker group and restart session"
echo "--------------------------------------------------------------"
echo "Suggested commands:"
echo "  sudo usermod -aG docker $USER"
echo "  newgrp docker    # or log out/in to apply group change"
echo ""
if ! confirm "Have you added your user to the docker group and restarted your session?"; then
  echo "[INFO] Aborting migration script at Step 5."
  exit 0
fi

echo ""
echo "Step 6: Verify Docker CE is working"
echo "------------------------------------"
echo "Suggested commands:"
echo "  docker info"
echo "  docker ps"
echo "  docker compose version"
echo ""
if ! confirm "Have you verified Docker CE is working as expected?"; then
  echo "[INFO] Aborting migration script at Step 6."
  exit 0
fi

echo ""
echo "Step 7: Recreate MyPortfolioSite dev stack under Docker CE"
echo "-----------------------------------------------------------"
echo "Suggested commands:"
echo "  cd ~/MyPortfolioSite-dev"
echo "  docker compose -f docker-compose.dev-server.yml up -d --build"
echo ""

if ! confirm "Have you recreated the dev stack and confirmed it works under Docker CE?"; then
  echo "[INFO] Migration checklist complete, but dev stack recreation not confirmed."
  exit 0
fi

echo ""
echo "[OK] Migration steps completed. Snap Docker should be removed and Docker CE in use."
echo "[OK] Ensure any references to snap.docker.dockerd are cleaned up in scripts/services."
