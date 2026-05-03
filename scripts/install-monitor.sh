#!/bin/bash
# ============================================================
# install-monitor.sh — Register monitor.sh as a cron job
# Run once: bash ~/MyPortfolioSite/scripts/install-monitor.sh
# ============================================================

SCRIPT_PATH="$HOME/MyPortfolioSite/scripts/monitor.sh"
chmod +x "$SCRIPT_PATH"
mkdir -p "$HOME/logs"

# Allow dropping caches and restarting services without password prompt
SUDO_LINE="$USER ALL=(ALL) NOPASSWD: /usr/bin/tee /proc/sys/vm/drop_caches, /bin/systemctl restart postgresql, /bin/systemctl start nginx, /bin/systemctl reload nginx, /usr/bin/journalctl --vacuum-size=50M"

if ! sudo grep -qF "drop_caches" /etc/sudoers 2>/dev/null; then
  echo "$SUDO_LINE" | sudo tee -a /etc/sudoers.d/portfolio-monitor > /dev/null
  sudo chmod 0440 /etc/sudoers.d/portfolio-monitor
  echo "sudoers entry added"
else
  echo "sudoers entry already present"
fi

# Add cron job (every 5 minutes)
CRON_LINE="*/5 * * * * /bin/bash $SCRIPT_PATH >> $HOME/logs/monitor.log 2>&1"
( crontab -l 2>/dev/null | grep -v 'monitor.sh'; echo "$CRON_LINE" ) | crontab -

echo ""
echo "✅ Monitor installed. Runs every 5 minutes."
echo "   Logs: ~/logs/monitor.log"
echo "   Health JSON: ~/logs/health_status.json"
echo ""
echo "Test it now:"
echo "  bash ~/MyPortfolioSite/scripts/monitor.sh"
echo "  cat ~/logs/health_status.json"
