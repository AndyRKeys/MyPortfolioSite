#!/bin/bash
# Snapshot current system state to ~/migration-manifest.txt before migrating to new SSD.
# Run this as your normal user (not root). Some sections use sudo automatically.
# Output is referenced during Phase 3 (OS rebuild on new disk).
OUT="$HOME/migration-manifest.txt"
TIMESTAMP=$(date -u +'%Y-%m-%dT%H:%M:%SZ')

log() { echo "$1" | tee -a "$OUT"; }
section() { log ""; log "════════════════════════════════════════════════════════════"; log "  $1"; log "════════════════════════════════════════════════════════════"; }

> "$OUT"
log "Migration Manifest — captured $TIMESTAMP"

# ── System info ───────────────────────────────────────────────────────────────
section "SYSTEM"
log "Hostname:   $(hostname)"
log "User:       $(whoami)"
log "OS:         $(lsb_release -ds 2>/dev/null || cat /etc/os-release | grep PRETTY_NAME | cut -d= -f2 | tr -d '"')"
log "Kernel:     $(uname -r)"
log "Uptime:     $(uptime -p)"

# ── Disk layout ───────────────────────────────────────────────────────────────
section "DISK LAYOUT (current)"
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT | tee -a "$OUT"
log ""
df -h | tee -a "$OUT"

# ── UFW rules ─────────────────────────────────────────────────────────────────
section "UFW RULES"
sudo ufw status numbered 2>/dev/null | tee -a "$OUT" || log "(ufw not active or not installed)"

# ── Cron jobs ─────────────────────────────────────────────────────────────────
section "CRON — root"
sudo crontab -l 2>/dev/null | tee -a "$OUT" || log "(no root crontab)"

section "CRON — $(whoami)"
crontab -l 2>/dev/null | tee -a "$OUT" || log "(no user crontab)"

# ── Docker ────────────────────────────────────────────────────────────────────
section "DOCKER"
log "Version:"
docker version --format 'Client: {{.Client.Version}}  Server: {{.Server.Version}}' 2>/dev/null | tee -a "$OUT" || log "(docker not running)"

log ""
log "daemon.json:"
if [ -f /etc/docker/daemon.json ]; then
    cat /etc/docker/daemon.json | tee -a "$OUT"
else
    log "(not present — using defaults)"
fi

log ""
log "Running containers:"
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null | tee -a "$OUT" || log "(none)"

log ""
log "Volumes:"
docker volume ls 2>/dev/null | tee -a "$OUT" || log "(none)"

# ── Ollama ────────────────────────────────────────────────────────────────────
section "OLLAMA"
if docker inspect ollama &>/dev/null; then
    log "Container config (relevant fields):"
    docker inspect ollama --format '
Image:          {{.Config.Image}}
RestartPolicy:  {{.HostConfig.RestartPolicy.Name}}
Ports:          {{range $p, $b := .HostConfig.PortBindings}}{{$p}} -> {{(index $b 0).HostPort}} {{end}}
Mounts:         {{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}} {{end}}
GPUs:           {{range .HostConfig.DeviceRequests}}driver={{.Driver}} count={{.Count}} caps={{.Capabilities}}{{end}}' 2>/dev/null | tee -a "$OUT"

    log ""
    log "Installed models:"
    docker exec ollama ollama list 2>/dev/null | tee -a "$OUT" || log "(could not list models)"

    log ""
    log "Reconstructed docker run command:"
    IMAGE=$(docker inspect ollama --format '{{.Config.Image}}')
    VOLUME=$(docker inspect ollama --format '{{range .Mounts}}{{if eq .Type "volume"}}-v {{.Name}}:{{.Destination}} {{end}}{{end}}')
    log "docker run -d --name ollama --restart always \\"
    log "  --gpus all \\"
    log "  -p 11434:11434 \\"
    log "  $VOLUME\\"
    log "  $IMAGE"
else
    log "(ollama container not found)"
fi

# ── Systemd services ──────────────────────────────────────────────────────────
section "SYSTEMD SERVICES (relevant)"
for svc in glances ddclient dropbear cron docker ssh ufw; do
    STATUS=$(systemctl is-enabled "$svc" 2>/dev/null || echo "not-found")
    ACTIVE=$(systemctl is-active "$svc" 2>/dev/null || echo "inactive")
    printf "  %-20s enabled=%-12s active=%s\n" "$svc" "$STATUS" "$ACTIVE" | tee -a "$OUT"
done

# ── Dropbear config ───────────────────────────────────────────────────────────
section "DROPBEAR CONFIG"
DROPBEAR_CONF="/etc/dropbear/initramfs/dropbear.conf"
DROPBEAR_CONF_OLD="/etc/dropbear-initramfs/config"
if [ -f "$DROPBEAR_CONF" ]; then
    log "($DROPBEAR_CONF):"
    cat "$DROPBEAR_CONF" | tee -a "$OUT"
elif [ -f "$DROPBEAR_CONF_OLD" ]; then
    log "($DROPBEAR_CONF_OLD):"
    cat "$DROPBEAR_CONF_OLD" | tee -a "$OUT"
else
    log "(no dropbear config found — may not be installed)"
fi

log ""
log "Authorized keys for initramfs unlock:"
KEYS="/etc/dropbear/initramfs/authorized_keys"
KEYS_OLD="/etc/dropbear-initramfs/authorized_keys"
if sudo test -f "$KEYS" 2>/dev/null; then
    sudo cat "$KEYS" | tee -a "$OUT"
elif sudo test -f "$KEYS_OLD" 2>/dev/null; then
    sudo cat "$KEYS_OLD" | tee -a "$OUT"
else
    log "(no authorized_keys found)"
fi

# ── Installed packages ────────────────────────────────────────────────────────
section "INSTALLED PACKAGES (relevant)"
for pkg in docker-ce ddclient glances certbot rclone micro python3 python3-pip; do
    VER=$(dpkg -l "$pkg" 2>/dev/null | awk '/^ii/{print $3}')
    printf "  %-20s %s\n" "$pkg" "${VER:-not installed}" | tee -a "$OUT"
done

# ── Network ───────────────────────────────────────────────────────────────────
section "NETWORK"
log "Interfaces:"
ip -4 addr show | grep -E '(^[0-9]+:|inet )' | tee -a "$OUT"

log ""
if command -v ddclient &>/dev/null; then
    log "ddclient config:"
    # Ubuntu <23.10 uses /etc/ddclient.conf; 24.04+ uses /etc/ddclient/ddclient.conf
    DDCLIENT_CONF=""
    if [ -f /etc/ddclient/ddclient.conf ]; then
        DDCLIENT_CONF="/etc/ddclient/ddclient.conf"
    elif [ -f /etc/ddclient.conf ]; then
        DDCLIENT_CONF="/etc/ddclient.conf"
    fi
    if [ -n "$DDCLIENT_CONF" ]; then
        log "  (path: $DDCLIENT_CONF)"
        sudo cat "$DDCLIENT_CONF" 2>/dev/null | sed 's/password=.*/password=[redacted]/g' | tee -a "$OUT" || log "(could not read $DDCLIENT_CONF)"
    else
        log "(ddclient installed but no config file found at /etc/ddclient.conf or /etc/ddclient/ddclient.conf)"
    fi
else
    log "ddclient: not installed"
fi

# ── SSL certs ─────────────────────────────────────────────────────────────────
section "SSL CERTS"
if sudo test -d /etc/letsencrypt/live 2>/dev/null; then
    sudo ls -la /etc/letsencrypt/live/ | tee -a "$OUT"
    log ""
    for domain in $(sudo ls /etc/letsencrypt/live/ 2>/dev/null | grep -v README); do
        EXPIRY=$(sudo openssl x509 -enddate -noout -in "/etc/letsencrypt/live/$domain/cert.pem" 2>/dev/null | cut -d= -f2 || echo "unknown")
        log "  $domain — expires $EXPIRY"
    done
else
    log "(no letsencrypt certs found)"
fi

log ""
log "════════════════════════════════════════════════════════════"
log "Manifest complete. Saved to: $OUT"
log "════════════════════════════════════════════════════════════"
