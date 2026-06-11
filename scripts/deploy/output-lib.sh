#!/usr/bin/env bash
# output-lib.sh — Shared console output primitives for deploy, test, and ops scripts (#314).
#
# Source this file to get:
#   out_info / out_ok / out_warn / out_fail / out_section / out_die
#   _visual_width / _print_box / _print_multi_box
#
# Configuration (set before sourcing, or export from calling script):
#   OUTPUT_LOG_FILE — if set, all output is also tee'd to this file
#   OUTPUT_QUIET=1  — suppress info/ok/section; warnings and errors always shown
#
# Callers that already define LOG_FILE (deploy-lib.sh) can alias it:
#   export OUTPUT_LOG_FILE="$LOG_FILE"

# ── Colour detection (done once at source time) ───────────────────────────────

if [ -t 1 ]; then
  _OUT_RED='\033[0;31m'
  _OUT_YELLOW='\033[0;33m'
  _OUT_GREEN='\033[0;32m'
  _OUT_CYAN='\033[0;36m'
  _OUT_RESET='\033[0m'
  _OUT_BOLD='\033[1m'
else
  _OUT_RED=''
  _OUT_YELLOW=''
  _OUT_GREEN=''
  _OUT_CYAN=''
  _OUT_RESET=''
  _OUT_BOLD=''
fi

# ── Internal emit helpers ─────────────────────────────────────────────────────

# Emit a line — tee to $OUTPUT_LOG_FILE if set, otherwise plain stdout.
_out_emit() {
  if [ -n "${OUTPUT_LOG_FILE:-}" ]; then
    echo -e "$*" | tee -a "$OUTPUT_LOG_FILE"
  elif [ -n "${LOG_FILE:-}" ]; then
    # Legacy: deploy-lib.sh callers use LOG_FILE
    echo -e "$*" | tee -a "$LOG_FILE"
  else
    echo -e "$*"
  fi
}

# printf variant of _out_emit — passes all args straight to printf.
_out_printf() {
  if [ -n "${OUTPUT_LOG_FILE:-}" ]; then
    printf "$@" | tee -a "$OUTPUT_LOG_FILE"
  elif [ -n "${LOG_FILE:-}" ]; then
    printf "$@" | tee -a "$LOG_FILE"
  else
    printf "$@"
  fi
}

_out_quiet() { [ "${OUTPUT_QUIET:-0}" = "1" ]; }

# ── Message functions (#314) ──────────────────────────────────────────────────

# ℹ info line (cyan) — suppressed in quiet mode
out_info() {
  _out_quiet && return 0
  _out_emit "${_OUT_CYAN}${_OUT_BOLD}ℹ  ${_OUT_RESET} $*"
}

# ✅ success line (green) — suppressed in quiet mode
out_ok() {
  _out_quiet && return 0
  _out_emit "${_OUT_GREEN}${_OUT_BOLD}✅ ${_OUT_RESET} $*"
}

# ⚠️  warning line (yellow) — always shown
out_warn() {
  _out_emit "${_OUT_YELLOW}${_OUT_BOLD}⚠️  ${_OUT_RESET} $*"
}

# ❌ error line (red) — always shown
out_fail() {
  _out_emit "${_OUT_RED}${_OUT_BOLD}❌ ${_OUT_RESET} $*"
}

# 🔷 section header — suppressed in quiet mode
out_section() {
  _out_quiet && return 0
  _out_emit ""
  _out_emit "${_OUT_CYAN}${_OUT_BOLD}🔷 ── $* ───────────────────────────────────────────${_OUT_RESET}"
}

# Print error and exit 1 — always shown
out_die() {
  out_fail "$*"
  exit 1
}

# ── Width helper ──────────────────────────────────────────────────────────────

# Return the visual (terminal column) width of a plain-text string.
# ${#s} counts Unicode code points; wide emoji render as 2 columns, so add 1
# per occurrence to get the true display width.
_visual_width() {
  local s="$1" width
  width=${#s}
  local e
  for e in 🚀 ✅ ❌ 🧪 🔷 ↩️; do
    local stripped="${s//$e/}"
    local count=$(( ${#s} - ${#stripped} ))
    width=$(( width + count ))
  done
  echo "$width"
}

# ── Box primitives ────────────────────────────────────────────────────────────

# Print a single-line banner box sized dynamically to fit content.
# Usage: _print_box <colour> <plain_text_content>
# Example: _print_box "${CYAN}${BOLD}" "🚀 Deploy — 2026-05-19 21:37:00"
_print_box() {
  local colour="$1" content="$2"
  local inner_width; inner_width=$(_visual_width "$content")
  local border; border=$(printf '═%.0s' $(seq 1 $(( inner_width + 4 ))))
  _out_emit ""
  _out_emit "${colour}╔${border}╗${_OUT_RESET}"
  _out_emit "${colour}║  ${content}  ║${_OUT_RESET}"
  _out_emit "${colour}╚${border}╝${_OUT_RESET}"
  _out_emit ""
}

# Print a multi-line box: title row, divider, then one or more content rows.
# Content rows are left-padded with 2 spaces and right-padded to content_width.
# The title is padded to fill the same inner width.
# Usage: _print_multi_box <colour> <content_width> <title> [row ...]
# Example: _print_multi_box "$C" 60 "🧪 Regression — OK" "Passed : 20 / 20"
_print_multi_box() {
  local colour="$1" content_w="$2" title="$3"
  shift 3
  local inner_w=$(( content_w + 2 ))  # border width = content + 2 leading spaces
  local title_w; title_w=$(_visual_width "$title")
  local title_pad=$(( content_w - title_w ))  # pad fills content_w; leading 2 spaces are outside
  local border; border=$(printf '═%.0s' $(seq 1 $inner_w))
  _out_emit ""
  _out_emit "${colour}╔${border}╗${_OUT_RESET}"
  _out_printf "${colour}║  %s%*s║${_OUT_RESET}\n" "$title" "$title_pad" ""
  _out_emit "${colour}╠${border}╣${_OUT_RESET}"
  local row
  for row in "$@"; do
    _out_printf "${colour}║  %-${content_w}s║${_OUT_RESET}\n" "$row"
  done
  _out_emit "${colour}╚${border}╝${_OUT_RESET}"
  _out_emit ""
}
