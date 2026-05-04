#!/bin/bash
# ============================================================
# monitor.sh — Resource monitor & self-healing for Pi
# Run via cron every 5 minutes:
#   */5 * * * * /bin/bash ~/MyPortfolioSite/scripts/monitor.sh 2>&1
# Also safe to run manually — always writes to ~/logs/monitor.log
# ============================================================

LOG_DIR="$HOME/logs"
LOG_FILE="$LOG_DIR/monitor.log"
HEALTH_FILE="$LOG_DIR/health_status.json"
mkdir -p "$LOG_DIR"

# Redirect all output to log file AND stdout
exec > >(tee -a "$LOG_FILE") 2>&1

# ── Thresholds ──────────────────────────────────────────────
MEM_WARN=75      # % used — log warning
MEM_CRIT=88      # % used — drop caches + restart app
MEM_KILL=94      # % used — restart everything
CPU_WARN=80      # % used (1-min load avg as % of cores)
DISK_WARN=85     # % used
DISK_CRIT=95     # % used — emergency cleanup

# ── Helpers ─────────────────────────────────────────────────
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
NCORES=$(nproc)

log() { echo "[$TIMESTAMP] $1"; }

# ── Gather metrics ──────────────────────────────────────────
MEM_TOTAL=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
MEM_AVAIL=$(awk '/MemAvailable/ {print $2}' /proc/meminfo)
MEM_USED_PCT=$(( (MEM_TOTAL - MEM_AVAIL) * 100 / MEM_TOTAL ))

LOAD1=$(awk '{print $1}' /proc/loadavg)
CPU_PCT=$(echo "$LOAD1 $NCORES" | awk '{printf "%d", ($1/$2)*100}')

DISK_PCT=$(df / | awk 'NR==2 {print $5}' | tr -d '%')

SWAP_TOTAL=$(awk '/SwapTotal/ {print $2}' /proc/meminfo)
SWAP_FREE=$(awk '/SwapFree/  {print $2}' /proc/meminfo)
if [ "$SWAP_TOTAL" -gt 0 ]; then
  SWAP_USED_PCT=$(( (SWAP_TOTAL - SWAP_FREE) * 100 / SWAP_TOTAL ))
else
  SWAP_USED_PCT=0
fi

log "MEM=${MEM_USED_PCT}% CPU=${CPU_PCT}% DISK=${DISK_PCT}% SWAP=${SWAP_USED_PCT}%"

# ── Write health JSON ────────────────────────────────────────
cat > "$HEALTH_FILE" <<EOF
{
  "timestamp": "$TIMESTAMP",
  "mem_pct": $MEM_USED_PCT,
  "cpu_pct": $CPU_PCT,
  "disk_pct": $DISK_PCT,
  "swap_pct": $SWAP_USED_PCT,
  "status": "ok"
}
EOF

# ── DISK: emergency cleanup ──────────────────────────────────
if [ "$DISK_PCT" -ge "$DISK_CRIT" ]; then
  log "CRITICAL: Disk ${DISK_PCT}% — running emergency cleanup"
  sudo journalctl --vacuum-size=50M 2>/dev/null
  npm cache clean --force 2>/dev/null
  find /tmp -type f -atime +1 -delete 2>/dev/null
  find ~/MyPortfolioSite -name 'npm-debug.log*' -delete 2>/dev/null
  log "Disk cleanup complete"
elif [ "$DISK_PCT" -ge "$DISK_WARN" ]; then
  log "WARNING: Disk at ${DISK_PCT}%"
fi

# ── MEMORY: graduated response ───────────────────────────────
if [ "$MEM_USED_PCT" -ge "$MEM_KILL" ]; then
  log "CRITICAL: Memory ${MEM_USED_PCT}% — restarting stack & dropping caches"
  sync
  echo 3 | sudo tee /proc/sys/vm/drop_caches > /dev/null 2>&1
  sudo systemctl restart postgresql 2>/dev/null
  sleep 3
  pm2 restart portfolio-backend 2>/dev/null
  sleep 2
  sudo systemctl reload nginx 2>/dev/null
  FREE_AFTER=$(awk '/MemAvailable/ {print $2}' /proc/meminfo)
  MEM_AFTER=$(( (MEM_TOTAL - FREE_AFTER) * 100 / MEM_TOTAL ))
  log "Full restart complete — MEM after: ${MEM_AFTER}%"

elif [ "$MEM_USED_PCT" -ge "$MEM_CRIT" ]; then
  log "HIGH: Memory ${MEM_USED_PCT}% — dropping caches & restarting app only"
  sync
  echo 1 | sudo tee /proc/sys/vm/drop_caches > /dev/null 2>&1
  pm2 restart portfolio-backend 2>/dev/null
  log "App restarted"

elif [ "$MEM_USED_PCT" -ge "$MEM_WARN" ]; then
  log "WARNING: Memory at ${MEM_USED_PCT}%"
fi

# ── PM2 process health check ─────────────────────────────────
BACKEND_STATUS=$(pm2 jlist 2>/dev/null | python3 -c "
import sys, json
try:
  procs = json.load(sys.stdin)
  p = next((x for x in procs if x.get('name')=='portfolio-backend'), None)
  print(p['pm2_env']['status'] if p else 'missing')
except: print('error')
")

if [ "$BACKEND_STATUS" != "online" ]; then
  log "ALERT: portfolio-backend is '$BACKEND_STATUS' — attempting restart"
  pm2 start ~/MyPortfolioSite/ecosystem.config.js 2>/dev/null || pm2 restart portfolio-backend 2>/dev/null
  sleep 3
  NEW_STATUS=$(pm2 jlist 2>/dev/null | python3 -c "
import sys, json
try:
  procs = json.load(sys.stdin)
  p = next((x for x in procs if x.get('name')=='portfolio-backend'), None)
  print(p['pm2_env']['status'] if p else 'missing')
except: print('error')
")
  log "  Status after restart attempt: $NEW_STATUS"
fi

# ── nginx health check ───────────────────────────────────────
if ! systemctl is-active --quiet nginx; then
  log "ALERT: nginx is down — restarting"
  sudo systemctl start nginx
fi

# ── Trim log file (keep last 500 lines) ──────────────────────
tail -n 500 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"

log "Monitor run complete"
