#!/usr/bin/env bash
# migrate-from-snap-docker.sh — Guided and partially automated migration
# from Snap Docker to the official Docker CE packages on Ubuntu Server.
#
# This script:
# - Logs relevant state using docker-migration-checklist.sh.
# - Asks for explicit y/N confirmation before each step.
# - Can run some commands for you once you confirm.
#
# WARNING:
# - This script is intended to be run on your Ubuntu host, not inside a container.
# - Some steps are destructive (stopping Snap Docker, removing the docker snap).
# - Read prompts carefully and answer "y" only when you are ready.
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

echo "[INFO] This script will walk you through the steps to migrate from Snap Docker"
echo "       to Docker CE on Ubuntu. It will ask for confirmation before running any"
echo "       potentially disruptive command."

echo ""
echo "Step 0: Inspect and log current Docker/Snap state (recommended)"
echo "----------------------------------------------------------------"
if confirm "Run docker-migration-checklist.sh now?"; then
  bash "$(dirname "$0")/docker-migration-checklist.sh" || echo "[WARN] checklist script failed"
fi

echo ""
echo "Step 1: Stop MyPortfolioSite dev stack and remove orphans"
echo "----------------------------------------------------------"
if confirm "Stop dev stack with docker compose down --remove-orphans now?"; then
  echo "[INFO] Stopping dev stack..."
  if cd "$HOME/MyPortfolioSite-dev" && docker compose -f docker-compose.dev-server.yml down --remove-orphans; then
    echo "[OK] Dev stack stopped."
  else
    echo "[WARN] Failed to stop dev stack. Check output above." ; fi
else
  echo "[INFO] Skipping automatic dev stack stop (you can do this manually)."
fi

echo ""
echo "Step 2: Stop Snap Docker daemon"
echo "--------------------------------"
echo "Command: sudo systemctl stop snap.docker.dockerd"
if confirm "Run this command now?"; then
  echo "[INFO] Stopping snap.docker.dockerd..."
  if sudo systemctl stop snap.docker.dockerd; then
    echo "[OK] snap.docker.dockerd stopped."
  else
    echo "[WARN] Failed to stop snap.docker.dockerd. Check output above." ; fi
else
  echo "[INFO] Skipping automatic stop of snap.docker.dockerd."
fi

echo ""
echo "Step 3: Remove Docker Snap package"
echo "-----------------------------------"
echo "Command: sudo snap remove docker"
echo "WARNING: This removes the Docker Snap package from the system."
if confirm "Run this command now?"; then
  echo "[INFO] Removing docker Snap package..."
  if sudo snap remove docker; then
    echo "[OK] docker Snap removed."
  else
    echo "[WARN] Failed to remove docker Snap. Check output above." ; fi
else
  echo "[INFO] Skipping automatic removal of docker Snap."
fi

echo ""
echo "Step 4: Install Docker CE from official apt repository"
echo "-------------------------------------------------------"
echo "The following commands are recommended (from Docker docs)."
echo "They will be run one by one if you confirm."

if confirm "Install prerequisites (ca-certificates, curl, gnupg)?"; then
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl gnupg
fi

if confirm "Set up Docker GPG key and apt repository?"; then
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \"$([ -r /etc/os-release ] && . /etc/os-release && echo "$VERSION_CODENAME")\" stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
  sudo apt-get update
fi

if confirm "Install Docker CE, CLI, containerd, and compose plugin?"; then
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

echo ""
echo "Step 5: Add your user to the docker group and apply change"
echo "---------------------------------------------------------"
echo "Command: sudo usermod -aG docker $USER"
echo "You may need to log out and back in, or run 'newgrp docker', for this to take effect."
if confirm "Run usermod now?"; then
  sudo usermod -aG docker "$USER"
  echo "[INFO] usermod executed. You may need to log out/in or run 'newgrp docker'."
else
  echo "[INFO] Skipping automatic usermod (you can run it manually)."
fi

echo ""
echo "Step 6: Verify Docker CE is working"
echo "------------------------------------"
echo "Suggested commands: docker info, docker ps, docker compose version"
if confirm "Run these verification commands now?"; then
  docker info || echo "[WARN] docker info failed"
  docker ps || echo "[WARN] docker ps failed"
  docker compose version || echo "[WARN] docker compose version failed"
fi

echo ""
echo "Step 7: Recreate MyPortfolioSite dev stack under Docker CE"
echo "-----------------------------------------------------------"
echo "Command: cd ~/MyPortfolioSite-dev && docker compose -f docker-compose.dev-server.yml up -d --build"
if confirm "Run this command now?"; then
  if cd "$HOME/MyPortfolioSite-dev" && docker compose -f docker-compose.dev-server.yml up -d --build; then
    echo "[OK] Dev stack recreated under Docker CE."
  else
    echo "[WARN] Failed to recreate dev stack. Check output above." ; fi
else
  echo "[INFO] Skipping automatic dev stack recreation (you can run it manually)."
fi

echo ""
echo "[INFO] Migration helper finished. Review the output above to ensure all steps completed as expected."
