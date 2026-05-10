#!/usr/bin/env bash
# Install systemd service for dev environment Docker Compose stack autostart on reboot.
#
# Usage: sudo bash scripts/setup/install-dev-autostart.sh
#
# This creates /etc/systemd/system/myportfolio-dev.service and enables it.
# The service will automatically start the dev docker-compose stack on boot.

set -euo pipefail

if [ "$EUID" -ne 0 ]; then
    echo "This script must be run as root (use sudo)"
    exit 1
fi

DEV_REPO="${HOME}/MyPortfolioSite-dev"

if [ ! -d "$DEV_REPO" ]; then
    echo "Error: Dev repo not found at $DEV_REPO"
    echo "Run the dev server deploy script first to clone it."
    exit 1
fi

cat > /etc/systemd/system/myportfolio-dev.service << EOF
[Unit]
Description=MyPortfolio Dev Environment Docker Compose Stack
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$DEV_REPO
ExecStart=/usr/bin/docker compose -f docker-compose.dev-server.yml up -d
ExecStop=/usr/bin/docker compose -f docker-compose.dev-server.yml down
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable myportfolio-dev.service

echo "✓ Dev environment autostart service installed"
echo "  Start now: sudo systemctl start myportfolio-dev"
echo "  View status: sudo systemctl status myportfolio-dev"
echo "  View logs: sudo journalctl -u myportfolio-dev -n 50"
