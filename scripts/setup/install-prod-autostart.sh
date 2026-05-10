#!/usr/bin/env bash
# Install systemd service for production Docker Compose stack autostart on reboot.
#
# Usage: sudo bash scripts/setup/install-prod-autostart.sh
#
# This creates /etc/systemd/system/myportfolio-prod.service and enables it.
# The service will automatically start the production docker-compose stack on boot.

set -euo pipefail

if [ "$EUID" -ne 0 ]; then
    echo "This script must be run as root (use sudo)"
    exit 1
fi

REPO_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cat > /etc/systemd/system/myportfolio-prod.service << EOF
[Unit]
Description=MyPortfolio Production Docker Compose Stack
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$REPO_PATH
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable myportfolio-prod.service

echo "✓ Production autostart service installed"
echo "  Start now: sudo systemctl start myportfolio-prod"
echo "  View status: sudo systemctl status myportfolio-prod"
echo "  View logs: sudo journalctl -u myportfolio-prod -n 50"
