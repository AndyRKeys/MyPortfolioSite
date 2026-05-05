#!/bin/bash
# Live log tail — run this in a terminal to watch the monitor in real time
# Usage: bash ~/MyPortfolioSite/scripts/watch-logs.sh

LOG="$HOME/logs/monitor.log"
[ ! -f "$LOG" ] && echo "No log yet — monitor hasn't run. Try: bash ~/MyPortfolioSite/scripts/monitor.sh" && exit 1

echo "=== Live monitor log (Ctrl+C to exit) ==="
tail -f "$LOG"
