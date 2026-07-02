#!/usr/bin/env bash
# This file is sourced by deploy-lib.sh — do not execute directly.
# set -euo pipefail is inherited from the parent shell.

check_port_availability() {
  # Checks that all ports required by nginx are free on the host before Docker
  # tries to bind them. Reports the holding process by name so the operator
  # knows exactly what to kill. Backend port is intentionally excluded — it is
  # no longer bound to the host (health checks go through nginx).
  local ports=("$@")
  local blocked=0

  dsection "Pre-flight: port availability"

  for port in "${ports[@]}"; do
    local holder
    # ss is available on all modern Ubuntu/Debian; grep the LISTEN state only.
    holder=$(ss -tlnp 2>/dev/null | awk -v p=":${port} " '$0 ~ p {match($0, /users:\(\("[^"]+/, a); gsub(/users:\(\("|".*/, "", a[0]); print a[0]; exit}')
    if [ -n "$holder" ]; then
      dstatus port-check status=blocked port="$port" process="$holder"
      dwarn "Port $port is already bound by: $holder"
      blocked=1
    else
      dstatus port-check status=free port="$port"
    fi
  done

  if [ "$blocked" -eq 1 ]; then
    dfail "One or more required ports are in use. Free them before deploying."
    dfail "Find the process: sudo lsof -i :<port>"
    return 1
  fi
}

check_disk_space() {
  local min_gb="${1:-1}"
  local min_kb=$(( min_gb * 1024 * 1024 ))
  local target_dir="${REPO_DIR:-$HOME}"
  local free_kb

  dsection "Pre-build disk space check"

  free_kb=$(df -k "$target_dir" 2>/dev/null | awk 'NR==2 {print $4}')
  if [ -z "$free_kb" ]; then
    dstatus disk status=unknown reason=df-failed
    dwarn "Could not determine free disk space — continuing anyway."
    return 0
  fi

  local free_gb=$(( free_kb / 1024 / 1024 ))
  local free_mb=$(( free_kb / 1024 ))

  if [ "$free_kb" -lt "$min_kb" ]; then
    dstatus disk status=low free="${free_mb}MB" min="${min_gb}GB"
    dwarn "Low disk space: ${free_mb}MB free (recommended ≥ ${min_gb}GB for Docker builds)."
    dwarn "Docker image builds may fail. Free space on $(df -k "$target_dir" | awk 'NR==2{print $6}') before retrying."
    dwarn "Continuing — this is a warning, not a hard stop."
  else
    dstatus disk status=ok free="${free_gb}GB"
    dok "Disk space OK: ${free_gb}GB free on $(df -k "$target_dir" | awk 'NR==2{print $6}')"
  fi
}

prune_client_errors() {
  local postgres_service="${POSTGRES_SERVICE:-postgres}"
  local deleted
  deleted=$(dc exec -T "$postgres_service" \
    psql -U "${DB_USER:-postgres}" -d "${DB_NAME:-portfolio_prod}" -tAc \
    "DELETE FROM client_errors WHERE received_at < NOW() - INTERVAL '30 days'; SELECT ROW_COUNT();" \
    2>/dev/null | tail -1 || echo "?")
  dinfo "client_errors pruned — ${deleted} rows older than 30 days removed"
}

# Warn if the public DNS A record for DOMAIN doesn't match the server's current
# public IP. Runs as a warning-only preflight — a mismatch means traffic is
# going to the wrong server but it shouldn't block the deploy itself.
# Requires: DOMAIN env var set, dig available (dnsutils), curl available.
check_ddns_sync() {
  local domain="${DOMAIN:-}"

  if [ -z "$domain" ]; then
    dwarn "DDNS check skipped — DOMAIN not set"
    return 0
  fi

  dsection "DDNS sync check"

  if ! command -v dig >/dev/null 2>&1; then
    dwarn "dig not found — install dnsutils to enable DDNS check: sudo apt install dnsutils"
    return 0
  fi

  local public_ip dns_ip
  public_ip=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || echo "")
  dns_ip=$(dig +short "$domain" @8.8.8.8 2>/dev/null | tail -1 || echo "")

  if [ -z "$public_ip" ]; then
    dwarn "Could not determine server public IP — skipping DDNS check"
    return 0
  fi

  if [ -z "$dns_ip" ]; then
    dwarn "Could not resolve DNS for $domain — skipping DDNS check"
    return 0
  fi

  dinfo "Server public IP : $public_ip"
  dinfo "DNS A record     : $dns_ip (for $domain)"

  if [ "$public_ip" = "$dns_ip" ]; then
    dstatus ddns status=ok domain="$domain"
    dok "DDNS in sync: $domain → $public_ip ✓"
  else
    dstatus ddns status=mismatch domain="$domain"
    dwarn "DDNS out of sync: $domain resolves to $dns_ip but server IP is $public_ip"
    dwarn "Traffic may be going to the wrong server."
    dwarn "Run: sudo ddclient -daemon=0 -verbose -noquiet"
    dwarn "Or update manually in Namecheap Advanced DNS."
    dwarn "Continuing deploy — site may be unreachable externally until DNS is fixed."
  fi
}

# Detect the primary non-loopback IPv4 address and write it into ENV_FILE when
# LAN_IP is unset or still a placeholder. Dev-only: prod uses a public domain.
# Reads: LAN_IP, PLACEHOLDER_PATTERNS, ENV_FILE. Exports LAN_IP on success.
auto_detect_lan_ip() {
  local current="${LAN_IP:-}"
  local is_placeholder=0

  if [ -z "$current" ]; then
    is_placeholder=1
  else
    for pattern in "${PLACEHOLDER_PATTERNS[@]}"; do
      if [[ "$current" == *"$pattern"* ]]; then
        is_placeholder=1
        break
      fi
    done
  fi

  if [ "$is_placeholder" = "0" ]; then
    dstatus lan-ip status=ok reason=already-configured
    return 0
  fi

  dinfo "LAN_IP is unset or a placeholder — attempting auto-detection..."

  local detected
  # ip route is most reliable on Ubuntu; hostname -I is the fallback
  detected=$(ip route get 1.1.1.1 2>/dev/null | awk '/src/{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)
  if [ -z "$detected" ]; then
    detected=$(hostname -I 2>/dev/null | awk '{print $1}')
  fi

  if [ -z "$detected" ] || [[ "$detected" == "127."* ]]; then
    dstatus lan-ip status=failed reason=no-non-loopback-ip
    dwarn "Could not detect a non-loopback LAN IP — set LAN_IP manually in $ENV_FILE"
    return 0
  fi

  dinfo "Detected LAN IP: $detected"

  if grep -qE '^LAN_IP=' "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^LAN_IP=.*|LAN_IP=${detected}|" "$ENV_FILE"
  else
    echo "LAN_IP=${detected}" >> "$ENV_FILE"
  fi

  export LAN_IP="$detected"
  dstatus lan-ip status=detected reason=written-to-env
  dok "LAN_IP set to $detected in $ENV_FILE"
}

# Warn if UFW is active but has no rule allowing the given port.
# Non-fatal — missing a rule is surfaced as a warning, not a deploy failure,
# since UFW may simply not be installed or the rule may use a different subnet.
# Usage: check_ufw_port <port>
check_ufw_port() {
  local port="${1:?check_ufw_port requires a port argument}"

  dsection "Checking firewall (UFW) for port $port"

  if ! command -v ufw &>/dev/null; then
    dstatus firewall status=skipped reason=ufw-not-installed
    dinfo "UFW not installed — skipping firewall check"
    return 0
  fi

  local ufw_status
  if ! ufw_status=$(try_root ufw status 2>/dev/null); then
    dstatus firewall status=skipped reason=needs-root-no-passwordless-sudo
    dinfo "Skipping UFW check — needs root and passwordless sudo is unavailable in this non-interactive deploy."
    dinfo "To enable the check, allow just this read-only command without a password:"
    dinfo "  echo \"\$USER ALL=(root) NOPASSWD: /usr/sbin/ufw status\" | sudo tee /etc/sudoers.d/deploy-ufw-status"
    return 0
  fi

  if echo "$ufw_status" | grep -q "$port"; then
    dstatus firewall status=ok port="$port"
    dok "UFW rule for port $port is present"
  else
    dstatus firewall status=warn port="$port" reason=no-rule
    dwarn "No UFW rule found for port $port."
    dwarn "The dev site may not be reachable from other LAN devices."
    dwarn "To open port $port to your LAN:"
    dwarn "  sudo ufw allow from 192.168.0.0/16 to any port $port comment 'Dev site LAN-only'"
    dwarn "Continuing anyway — this is a warning, not an error."
  fi
}

# Non-fatal: warns if scheduled backups are not configured or recent backup
# files are missing. Runs post-deploy so it surfaces in every deploy log.
# Checks:
#   1. A cron job or systemd timer referencing a backup script exists.
#   2. Recent backup files exist under ~/backups (within 2 days).
# Both checks are warn-only — missing backups don't block a deploy, but the
# warning is logged loudly so it cannot be silently ignored. (#164)
check_backup_health() {
  dsection "Backup health check"
  local ok=1
  # Scan the parent ~/backups tree rather than BACKUP_DIR from the deploy env.
  # The cron job always runs from ~/MyPortfolioSite and resolves its own BACKUP_DIR
  # from the prod .env — which may differ from the dev deploy env. Scanning the
  # parent with maxdepth 2 finds files under prod/, dev/, or a flat layout.
  local backup_dir="${HOME}/backups"
  local max_age_days=2

  # ── Check 1: cron/systemd timer configured ───────────────────────────────
  local cron_found=0
  if crontab -l 2>/dev/null | grep -q "db-backup"; then
    cron_found=1
  elif systemctl list-timers --all 2>/dev/null | grep -q "db-backup"; then
    cron_found=1
  fi

  local cron_entry="0 2 * * * ${REPO_DIR}/scripts/backup/db-backup.sh >> ${HOME}/backup.log 2>&1"

  if [ "$cron_found" = "1" ]; then
    dstatus backup-schedule status=ok
    dok "Backup schedule: cron/timer found ✓"
  else
    local install_cron=0
    if [ "${AUTO_YES:-0}" = "1" ]; then
      install_cron=1
    elif [ -t 0 ]; then
      printf "\n[backup] No backup cron job found. Install one now? [Y/n] "
      read -r answer
      [[ "$answer" =~ ^[Yy]?$ ]] && install_cron=1
    fi

    if [ "$install_cron" = "1" ]; then
      (crontab -l 2>/dev/null; echo "$cron_entry") | crontab -
      if crontab -l 2>/dev/null | grep -q "db-backup"; then
        dstatus backup-schedule status=installed
        dok "Installed backup cron: ${cron_entry}"
      else
        dstatus backup-schedule status=warn
        dwarn "Cron install attempted but could not be verified — add manually: crontab -e"
        dwarn "  ${cron_entry}"
        ok=0
      fi
    else
      dstatus backup-schedule status=warn
      dwarn "No backup cron job found — add manually: crontab -e"
      dwarn "  ${cron_entry}"
      ok=0
    fi
  fi

  # ── Check 2: backup directory exists (create if missing) (#352) ─────────
  # Sanity check: BACKUP_DIR must be under the current user's home. A path
  # like /home/ak/backups synced from a template with a hardcoded username
  # will fail mkdir for any other SSH user — catch it early with a clear fix.
  if [[ "$backup_dir" == /home/* ]] && [[ "$backup_dir" != "$HOME"* ]]; then
    dstatus backup-files status=warn dir="$backup_dir"
    dwarn "BACKUP_DIR (${backup_dir}) belongs to a different user (running as: $(whoami))."
    dwarn "Update BACKUP_DIR in .env — suggested value: ${HOME}/backups"
    ok=0
  elif [ ! -d "$backup_dir" ]; then
    local create=0
    if [ "${AUTO_YES:-0}" = "1" ]; then
      create=1
    elif [ -t 0 ]; then
      printf "\n[backup] Backup directory %s does not exist. Create it now? [Y/n] " "$backup_dir"
      read -r answer
      [[ "$answer" =~ ^[Yy]?$ ]] && create=1
    fi

    if [ "$create" = "1" ]; then
      if mkdir -p "$backup_dir" 2>/dev/null; then
        dstatus backup-files status=created dir="$backup_dir"
        dok "Created backup directory: ${backup_dir}"
        dinfo "Add the backup cron job if not already present:"
        dinfo "  crontab -e"
        dinfo "  ${cron_entry}"
      else
        dstatus backup-files status=warn dir="$backup_dir"
        dwarn "Could not create ${backup_dir} — permission denied."
        dwarn "Set BACKUP_DIR to a writable path in .env, e.g. ${HOME}/backups"
        ok=0
      fi
    else
      dstatus backup-files status=warn dir="$backup_dir"
      dwarn "Backup directory ${backup_dir} does not exist — backups not configured (#164)"
      ok=0
    fi
  fi

  # ── Check 3: recent backup files exist ───────────────────────────────────
  if [ -d "$backup_dir" ]; then
    local recent
    recent=$(find "$backup_dir" -maxdepth 2 -name "*.sql*" -o -name "*.dump" -o -name "*.tar*" \
      2>/dev/null | xargs -r ls -t 2>/dev/null | head -1)
    if [ -n "$recent" ]; then
      local age_days
      age_days=$(( ( $(date +%s) - $(stat -c %Y "$recent" 2>/dev/null || echo 0) ) / 86400 ))
      if [ "$age_days" -le "$max_age_days" ]; then
        dstatus backup-files status=ok age_days="$age_days"
        dok "Most recent backup: $(basename "$recent") (${age_days}d ago) ✓"
      else
        dstatus backup-files status=warn age_days="$age_days"
        dwarn "Most recent backup is ${age_days} days old (threshold: ${max_age_days}d) — check backup job (#164)"
        ok=0
      fi
    else
      local run_backup=0
      if [ "${AUTO_YES:-0}" = "1" ]; then
        run_backup=1
      elif [ -t 0 ]; then
        printf "\n[backup] No backup files found. Run an initial backup now? [Y/n] "
        read -r answer
        [[ "$answer" =~ ^[Yy]?$ ]] && run_backup=1
      fi

      if [ "$run_backup" = "1" ]; then
        dinfo "Running initial backup..."
        local timestamp
        timestamp=$(date +%Y%m%d-%H%M%S)
        local db_backup="${backup_dir}/portfolio-${timestamp}.sql.gz"
        if dc exec -T postgres \
            pg_dump -U "${DB_USER:-postgres}" "${DB_NAME:-portfolio}" \
            2>/dev/null | gzip > "$db_backup" && [ -s "$db_backup" ]; then
          dstatus backup-files status=ok dir="$backup_dir"
          dok "Initial backup created: $(basename "$db_backup") ($(du -sh "$db_backup" | cut -f1))"
        else
          rm -f "$db_backup"
          dstatus backup-files status=warn dir="$backup_dir"
          dwarn "Initial backup failed — check containers are healthy and DB credentials are correct"
          ok=0
        fi
      else
        dstatus backup-files status=warn dir="$backup_dir"
        dwarn "No backup files found in ${backup_dir} — backups may never have run (#164)"
        ok=0
      fi
    fi
  fi

  if [ "$ok" = "0" ]; then
    dwarn "Backup health: one or more checks failed — see RUNBOOK.md §Backups to set up automated backups"
  fi
}
