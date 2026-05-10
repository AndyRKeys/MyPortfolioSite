#!/usr/bin/env bash
# kill-idle-ssh.sh — list and optionally kill idle SSH sessions for current user.
#
# Usage:
#   bash scripts/admin/kill-idle-ssh.sh                 # show your SSH sessions with idle times
#   bash scripts/admin/kill-idle-ssh.sh --kill 30       # kill your SSH sessions idle for >= 30 minutes
#
# Notes:
#   - Only affects sessions owned by the current user.
#   - Uses "who -u" to read idle times in the IDLE column.
#   - Intended for ad-hoc maintenance on the dev server.

set -euo pipefail

THRESHOLD_MINUTES=0
DO_KILL=false

if [ "${1-}" = "--kill" ] && [ -n "${2-}" ]; then
  DO_KILL=true
  THRESHOLD_MINUTES="$2"
fi

CURRENT_USER="$(whoami)"

echo "SSH sessions for user: $CURRENT_USER"
echo
who -u | awk -v user="$CURRENT_USER" '$1 == user && $2 ~ /^pts\// {print}' || true
echo

if [ "$DO_KILL" = false ]; then
  echo "No sessions killed. To kill idle sessions, run:"
  echo "  bash scripts/admin/kill-idle-ssh.sh --kill <minutes>"
  exit 0
fi

echo "Killing SSH sessions for $CURRENT_USER idle for >= ${THRESHOLD_MINUTES} minute(s)..."

# Parse who -u output: user tty date time host idle pid
who -u | awk -v user="$CURRENT_USER" -v threshold="$THRESHOLD_MINUTES" '
$1 == user && $2 ~ /^pts\// {
  idle = $6
  pid = $7

  # Convert IDLE to minutes:
  # formats are "." (active), "old", "MM:SS", "HH:MM"
  if (idle == "." ) {
    idle_min = 0
  } else if (idle == "old") {
    idle_min = 9999
  } else if (index(idle, ":") > 0) {
    split(idle, parts, ":")
    if (length(parts[1]) == 2 && length(parts[2]) == 2) {
      # MM:SS
      idle_min = parts[1]
    } else {
      # HH:MM
      idle_min = parts[1] * 60 + parts[2]
    }
  } else {
    idle_min = 0
  }

  if (idle_min >= threshold) {
    print pid
  }
}' | while read -r pid; do
  if [ -n "$pid" ]; then
    echo "  killing sshd pid $pid"
    kill "$pid" 2>/dev/null || echo "    failed to kill $pid"
  fi
done

echo "Done."
