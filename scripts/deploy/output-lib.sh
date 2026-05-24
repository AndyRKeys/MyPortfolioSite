#!/usr/bin/env bash
# output-lib.sh — Shared box-drawing helpers for deploy, test, and ops scripts.
#
# Source this file to get _visual_width, _print_box, and _print_multi_box.
# Callers supply their own colour escape strings; this lib provides _OUT_RESET.
#
# Log-file tee: if $LOG_FILE is set and non-empty in the calling script,
# all box output is automatically tee'd to that file.

# ── Colour reset (detected once at source time) ───────────────────────────────

if [ -t 1 ]; then
  _OUT_RESET='\033[0m'
  _OUT_BOLD='\033[1m'
else
  _OUT_RESET=''
  _OUT_BOLD=''
fi

# ── Internal emit helpers ─────────────────────────────────────────────────────

# Emit a line — tee to $LOG_FILE if set, otherwise plain stdout.
_out_emit() {
  if [ -n "${LOG_FILE:-}" ]; then
    echo -e "$*" | tee -a "$LOG_FILE"
  else
    echo -e "$*"
  fi
}

# printf variant of _out_emit — passes all args straight to printf.
_out_printf() {
  if [ -n "${LOG_FILE:-}" ]; then
    printf "$@" | tee -a "$LOG_FILE"
  else
    printf "$@"
  fi
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
