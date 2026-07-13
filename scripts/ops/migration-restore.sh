#!/bin/bash
# migration-restore.sh — Phase 3+4 completion for the sdb SSD migration (#529).
#
# Run this ON THE NEW SYSTEM (booted from sdb) as your normal user (modnar3),
# with sda3 already decrypted, VG-renamed, and mounted read-only at /mnt/old
# (per docs/superpowers/specs/2026-07-12-ssd-migration-design.md Phase 4 step 1).
#
# Safe to re-run: each section checks current state and skips if already done.
# Requires interactive sudo (will prompt for your password as needed).
#
# Usage:
#   bash scripts/ops/migration-restore.sh
set -euo pipefail

REPO_DIR="$HOME/MyPortfolioSite"
DEV_REPO_DIR="$HOME/MyPortfolioSite-dev"
OLD_ROOT="/mnt/old"

log()     { echo "[migration-restore] $*"; }
section() { echo ""; echo "════════════════════════════════════════════════════════════"; echo "  $*"; echo "════════════════════════════════════════════════════════════"; }
confirm() {
  read -r -p "$1 [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

if ! mountpoint -q "$OLD_ROOT"; then
  echo "ERROR: $OLD_ROOT is not mounted. This script expects the old sda3 volume" >&2
  echo "already mounted read-only there (Phase 4 step 1). Aborting." >&2
  exit 1
fi

# ── 1. Extend root LV to use full VG (not in original design doc — found during migration) ──
section "1. Extend root logical volume to use full disk"

CURRENT_LV_SIZE=$(df --output=size -B1 / | tail -1)
CURRENT_LV_GB=$((CURRENT_LV_SIZE / 1024 / 1024 / 1024))
log "Current / size: ~${CURRENT_LV_GB}G"

if [ "$CURRENT_LV_GB" -lt 500 ]; then
  echo "  The root LV is only ~${CURRENT_LV_GB}G — the 1 TB disk has ~830G sitting unallocated."
  if confirm "  Extend the root LV and filesystem to use all free space in the VG?"; then
    sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv
    sudo resize2fs /dev/mapper/ubuntu--vg-ubuntu--lv
    log "Root LV extended. New size:"
    df -h /
  else
    log "Skipped LV extend — re-run this script later to do it."
  fi
else
  log "Root LV already >= 500G — skipping."
fi

# ── 2. Docker CE ──────────────────────────────────────────────────────────────
section "2. Docker CE"

if ! command -v docker &>/dev/null; then
  log "Installing Docker CE..."
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER"
  echo ""
  echo "  Docker installed. You must log out and back in for the docker group"
  echo "  to take effect, then re-run this script to continue with the rest."
  exit 0
fi
log "Docker $(docker --version | cut -d' ' -f3 | tr -d ',') already installed."

if ! docker info &>/dev/null; then
  echo "ERROR: Docker is installed but you don't have permission to use it yet." >&2
  echo "Log out and back in (to pick up the docker group), then re-run." >&2
  exit 1
fi

# ── 3. UFW rules — copied from the old disk, never hardcoded here ────────────
section "3. UFW rules"

if ! sudo ufw status | grep -q "Status: active"; then
  OLD_UFW_RULES="$OLD_ROOT/etc/ufw/user.rules"
  OLD_UFW_RULES6="$OLD_ROOT/etc/ufw/user6.rules"

  if sudo test -f "$OLD_UFW_RULES"; then
    log "Staging UFW rules copied from the old disk (not re-typed — see $OLD_UFW_RULES)..."
    sudo cp "$OLD_UFW_RULES" /etc/ufw/user.rules
    sudo test -f "$OLD_UFW_RULES6" && sudo cp "$OLD_UFW_RULES6" /etc/ufw/user6.rules

    # Safety check before enabling: refuse to lock ourselves out over SSH.
    if ! sudo grep -qE -- '--dport 22\b' /etc/ufw/user.rules; then
      echo "ERROR: the copied rules don't appear to allow port 22 (SSH)." >&2
      echo "Refusing to enable UFW automatically — inspect /etc/ufw/user.rules by hand first." >&2
      exit 1
    fi

    echo "  Rules staged from the old disk:"
    sudo grep -E '^-A ufw-user-input' /etc/ufw/user.rules | sed 's/^/    /'
    if confirm "  Enable UFW with the rules above?"; then
      sudo ufw --force enable
      log "UFW enabled."
      sudo ufw status numbered
    else
      log "Skipped enabling — rules are staged; enable later with: sudo ufw --force enable"
    fi
  else
    echo "  WARN: no UFW rules found on the old disk at $OLD_UFW_RULES." >&2
    echo "  Configure firewall rules manually: sudo ufw allow <port>" >&2
  fi
else
  log "UFW already active — skipping (edit rules manually if they need updating)."
fi

# ── 4. Dropbear — config + authorized_keys copied from the old disk ──────────
section "4. Dropbear (remote LUKS unlock on boot)"

if ! dpkg -l dropbear-initramfs &>/dev/null; then
  log "Installing dropbear-initramfs..."
  sudo apt-get update -qq
  sudo apt-get install -y dropbear-initramfs
  sudo mkdir -p /etc/dropbear/initramfs

  # Old system used either the current path or the legacy pre-24.04 path.
  OLD_CONF="$OLD_ROOT/etc/dropbear/initramfs/dropbear.conf"
  OLD_CONF_LEGACY="$OLD_ROOT/etc/dropbear-initramfs/config"
  OLD_KEYS="$OLD_ROOT/etc/dropbear/initramfs/authorized_keys"
  OLD_KEYS_LEGACY="$OLD_ROOT/etc/dropbear-initramfs/authorized_keys"

  if sudo test -f "$OLD_CONF"; then
    sudo cp "$OLD_CONF" /etc/dropbear/initramfs/dropbear.conf
  elif sudo test -f "$OLD_CONF_LEGACY"; then
    sudo cp "$OLD_CONF_LEGACY" /etc/dropbear/initramfs/dropbear.conf
  else
    echo "  WARN: no dropbear config found on the old disk — using package defaults." >&2
  fi

  if sudo test -f "$OLD_KEYS"; then
    sudo cp "$OLD_KEYS" /etc/dropbear/initramfs/authorized_keys
  elif sudo test -f "$OLD_KEYS_LEGACY"; then
    sudo cp "$OLD_KEYS_LEGACY" /etc/dropbear/initramfs/authorized_keys
  else
    echo "  WARN: no authorized_keys found on the old disk — remote unlock won't work" >&2
    echo "  until you add your public key to /etc/dropbear/initramfs/authorized_keys" >&2
  fi
  sudo test -f /etc/dropbear/initramfs/authorized_keys && sudo chmod 600 /etc/dropbear/initramfs/authorized_keys

  sudo update-initramfs -u
  DBPORT=$(sudo grep -oP '(?<=-p )[0-9]+' /etc/dropbear/initramfs/dropbear.conf 2>/dev/null || echo 22)
  log "Dropbear configured (port ${DBPORT}, from copied config). TEST BEFORE RELYING ON IT:"
  log "  reboot, then from another machine: ssh -p ${DBPORT} root@<server-ip>"
else
  log "dropbear-initramfs already installed — skipping."
fi

# ── 5. Glances ─────────────────────────────────────────────────────────────────
section "5. Glances monitoring"

if ! command -v glances &>/dev/null; then
  log "Installing glances..."
  sudo apt-get install -y glances
fi
sudo bash "$DEV_REPO_DIR/scripts/ops/setup-glances-monitoring.sh"

# ── 6. ddclient (DDNS) ─────────────────────────────────────────────────────────
section "6. ddclient (DDNS)"

if systemctl is-enabled ddclient &>/dev/null; then
  log "ddclient already configured — skipping."
else
  log "Running setup-ddns.sh (will prompt for your Namecheap DDNS password)..."
  sudo bash "$DEV_REPO_DIR/scripts/infra/setup-ddns.sh"
fi

# ── 7. Crontabs — restored from the old disk's cron spool, not re-typed ──────
section "7. Crontabs"
# The old root crontab had a line using `~/...`, which resolves to /root for
# root's own crontab — a path that never existed there, so it was already
# dead on the old system. We drop only lines matching that pattern; everything
# else is carried over verbatim.

OLD_ROOT_CRON="$OLD_ROOT/var/spool/cron/crontabs/root"
OLD_USER_CRON="$OLD_ROOT/var/spool/cron/crontabs/$USER"

if sudo test -f "$OLD_ROOT_CRON"; then
  # Drop any command field containing a literal `~` — under root's own
  # crontab that expands to /root, which won't match a deploy user's home dir.
  FILTERED_ROOT_CRON=$(sudo cat "$OLD_ROOT_CRON" | grep -vE '^\s*[^#].*~')
  if ! sudo crontab -l 2>/dev/null | diff -q - <(echo "$FILTERED_ROOT_CRON") &>/dev/null; then
    echo "$FILTERED_ROOT_CRON" | sudo crontab -
    log "Root crontab restored from old disk (dead '~'-relative lines dropped)."
  else
    log "Root crontab already matches old disk — skipping."
  fi
else
  log "No root crontab found on old disk — skipping."
fi

if sudo test -f "$OLD_USER_CRON"; then
  if ! crontab -l 2>/dev/null | diff -q - <(sudo cat "$OLD_USER_CRON") &>/dev/null; then
    sudo cat "$OLD_USER_CRON" | crontab -
    log "User crontab restored from old disk."
  else
    log "User crontab already matches old disk — skipping."
  fi
else
  log "No user crontab found on old disk — skipping."
fi

# ── 8. SSL certs ───────────────────────────────────────────────────────────────
section "8. SSL certificates"

if ! sudo test -d /etc/letsencrypt/live/andykeys.me; then
  log "Rsyncing /etc/letsencrypt/ from old disk..."
  sudo rsync -av "$OLD_ROOT/etc/letsencrypt/" /etc/letsencrypt/
  log "Done."
else
  log "/etc/letsencrypt/live/andykeys.me already present — skipping."
fi

# ── 9. Docker volumes (Postgres + Ollama) ─────────────────────────────────────
section "9. Docker volumes"

if confirm "  Stop Docker and rsync /var/lib/docker/volumes/ from the old disk now?"; then
  sudo systemctl stop docker
  sudo rsync -av "$OLD_ROOT/var/lib/docker/volumes/" /var/lib/docker/volumes/
  sudo systemctl start docker
  log "Docker volumes restored."
else
  log "Skipped — re-run this script later to migrate volumes before starting the stacks."
  echo ""
  echo "Stopping here — the steps below assume Docker volumes are in place."
  exit 0
fi

# ── 10. Ollama container ───────────────────────────────────────────────────────
section "10. Ollama"

if ! docker inspect ollama &>/dev/null; then
  log "Starting Ollama container..."
  if ! docker run -d --name ollama --restart always --gpus all \
      -p 11434:11434 -v ollama:/root/.ollama ollama/ollama:latest 2>/dev/null; then
    log "WARN: --gpus all failed (NVIDIA driver/container-toolkit not installed yet)."
    log "Starting Ollama on CPU for now — restart it with --gpus all after GPU setup:"
    log "  docs/INFRASTRUCTURE.md has the confirmed driver version (535.309.01) for the GTX 970."
    docker run -d --name ollama --restart always \
      -p 11434:11434 -v ollama:/root/.ollama ollama/ollama:latest
  fi
else
  log "Ollama container already exists — skipping."
fi

# ── 11. Start Compose stacks ───────────────────────────────────────────────────
section "11. Start prod + dev Compose stacks"

cd "$REPO_DIR"
docker compose -f docker-compose.yml up -d --build
cd "$DEV_REPO_DIR"
docker compose -f docker-compose.yml up -d --build

log "Waiting for backend containers to report healthy..."
for repo in "$REPO_DIR" "$DEV_REPO_DIR"; do
  cd "$repo"
  MAX_WAIT=90; ELAPSED=0
  until docker compose -f docker-compose.yml exec -T backend wget -q --spider http://localhost:8080/health 2>/dev/null; do
    if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
      echo "  WARN: backend in $repo not healthy after ${MAX_WAIT}s — check: docker compose -f docker-compose.yml logs --tail=30 backend"
      break
    fi
    sleep 3; ELAPSED=$((ELAPSED + 3))
  done
  log "$repo backend check done."
done

# ── Summary ────────────────────────────────────────────────────────────────────
section "Summary — Phase 5 checklist"
cat <<'EOF'
  1. Confirm the site is live at your public domain
  2. Confirm dev is reachable on the LAN
  3. Reboot and test Dropbear remote unlock (port shown in section 4 above)
  4. Confirm SSL cert is valid (browser padlock, or openssl s_client)
  5. Trigger a manual backup run and check ~/backups/:
       bash ~/MyPortfolioSite/scripts/backup/db-backup.sh
  6. If Ollama started without GPU, install NVIDIA driver 535.309.01 +
     nvidia-container-toolkit, then: docker rm -f ollama and re-run section 10.
  7. Leave sda installed but unused for 2-4 weeks as cold fallback.
  8. When confident: wipe sda or repurpose it.
EOF
