#!/usr/bin/env bash

# setup-glances-monitoring.sh
#
# Configure Glances to run in web server mode on this host via systemd, so that
# external monitoring (e.g. Home Assistant Glances integration) can scrape
# metrics from http://<host>:61208.
#
# This script is intended to be run directly on ak-home-server (Ubuntu) with
# sudo/root privileges:
#   sudo bash scripts/ops/setup-glances-monitoring.sh
#
# It is safe to re-run: the systemd unit will be created or updated in-place.

set -euo pipefail

UNIT_PATH="/etc/systemd/system/glances.service"

echo "[setup-glances-monitoring] Detecting glances binary..."
if ! GLANCES_BIN="$(command -v glances)"; then
  echo "ERROR: glances binary not found in PATH. Install glances first, e.g.:" >&2
  echo "  sudo apt update && sudo apt install glances" >&2
  exit 1
fi

echo "[setup-glances-monitoring] Using glances binary at: ${GLANCES_BIN}"

TMP_UNIT="$(mktemp)"
cat > "${TMP_UNIT}" <<EOF
[Unit]
Description=Glances in Web Server Mode
After=network.target

[Service]
ExecStart=${GLANCES_BIN} -w
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

echo "[setup-glances-monitoring] Installing systemd unit to ${UNIT_PATH}..."
cp "${TMP_UNIT}" "${UNIT_PATH}"
rm -f "${TMP_UNIT}"

chmod 644 "${UNIT_PATH}"

echo "[setup-glances-monitoring] Reloading systemd daemon..."
systemctl daemon-reload

echo "[setup-glances-monitoring] Enabling glances.service..."
systemctl enable glances.service

echo "[setup-glances-monitoring] Restarting glances.service..."
systemctl restart glances.service

systemctl --no-pager --full status glances.service || true

echo
echo "Glances systemd service configured. Verify from another host with, for example:"
echo "  curl http://<ak-home-server-ip>:61208/api/2/cpu"