#!/usr/bin/env bash
# This file is sourced by deploy-lib.sh — do not execute directly.
# set -euo pipefail is inherited from the parent shell.

show_deployment_info() {
  dsection "Deployment details"

  cd "$REPO_DIR"

  local current_branch
  current_branch=$(git rev-parse --abbrev-ref HEAD)
  dinfo "Branch: $current_branch"

  local commit_sha
  commit_sha=$(git rev-parse --short HEAD)
  dinfo "Commit: $commit_sha"

  local commit_msg
  commit_msg=$(git log -1 --pretty=%B HEAD)
  dinfo "Message: $commit_msg"
}

log_deploy_summary() {
  local env_name="${1:-unknown}"
  local branch sha ts

  ts=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
  branch=$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  sha=$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")

  dstatus summary status=ok env="${env_name}" branch="${branch}" sha="${sha}"
}

# Loud final verdict banner printed immediately before the report box so the
# overall outcome is unmissable. Always printed (not gated by DEPLOY_QUIET).
# Usage: print_deploy_status <COMPLETE|ROLLED BACK|FAILED> <env-label>
print_deploy_status() {
  local status="$1" label="${2:-unknown}"
  local colour icon
  case "$status" in
    COMPLETE)      colour="${DEPLOY_GREEN}${DEPLOY_BOLD}";  icon="✅" ;;
    "DRY RUN")     colour="${DEPLOY_GREEN}${DEPLOY_BOLD}";  icon="🧪" ;;
    "ROLLED BACK") colour="${DEPLOY_YELLOW}${DEPLOY_BOLD}"; icon="↩️ " ;;
    *)             colour="${DEPLOY_RED}${DEPLOY_BOLD}";    icon="❌" ;;
  esac
  _print_box "$colour" "${icon}  DEPLOY ${status} — ${label} — $(_deploy_timestamp)"
}

# Print a human-readable final deploy report by extracting all [deploy:*] and
# [regression] checkpoint lines written to LOG_FILE during this run.
# Always printed — not suppressed by DEPLOY_QUIET.
# Call as the very last step of a deploy script (after regression tests).
print_deploy_report() {
  local label="${1:-unknown}"
  local _title
  _title="Deploy Report — ${label} — $(date '+%Y-%m-%d %H:%M:%S')"

  # Collect checkpoint lines for this run, strip ANSI and ts= field.
  local lines=()
  while IFS= read -r line; do
    lines+=("$line")
  done < <(
    tail -n +"$(( ${DEPLOY_LOG_START:-0} + 1 ))" "$LOG_FILE" 2>/dev/null \
      | grep -E '^\[deploy:' \
      | sed 's/\x1b\[[0-9;]*m//g' \
      | sed 's/ ts=[^ ]*$//'
  )

  # Compute width from longest content line (title or any checkpoint line).
  local width=${#_title}
  for line in "${lines[@]}"; do
    [ "${#line}" -gt "$width" ] && width=${#line}
  done
  # Minimum 60, add 2 padding chars each side (handled by printf %-Ns below).
  [ "$width" -lt 60 ] && width=60

  local border; border=$(printf '═%.0s' $(seq 1 $((width + 4))))
  local _title_pad=$(( width + 2 - ${#_title} ))

  _out_emit ""
  _out_emit "╔${border}╗"
  _out_printf "║  %s%*s║\n" "$_title" "$_title_pad" ""
  _out_emit "╠${border}╣"
  for line in "${lines[@]}"; do
    _out_printf "║  %-${width}s  ║\n" "$line"
  done
  _out_emit "╚${border}╝"
  _out_emit ""
}
