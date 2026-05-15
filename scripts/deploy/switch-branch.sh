#!/usr/bin/env bash
# switch-branch.sh — Generic branch-switch wrapper.
#
# Ensures the given repo is on the requested branch and clean against
# origin before any deploy step runs. On a dirty working tree it performs
# a hard reset to origin/<branch> so the caller always starts from a
# known-good state.
#
# Designed to be called by any PS1 or shell deploy orchestrator as a
# discrete step that returns 0 on success and non-zero on failure.
# The caller is responsible for any follow-up steps (deploy, seed, etc.).
#
# Usage:
#   bash scripts/deploy/switch-branch.sh <branch> <repo-path>
#
# Arguments:
#   branch     — Target branch name (required)
#   repo-path  — Absolute path to the repo on this machine (required)
#
# Examples:
#   bash scripts/deploy/switch-branch.sh dev ~/MyPortfolioSite-dev
#   bash scripts/deploy/switch-branch.sh feat/202-seed-dev-data-ubuntu ~/MyPortfolioSite-dev
#
# Exit codes:
#   0 — Branch switched successfully and working tree is clean against origin
#   1 — Missing argument(s)
#   2 — Repo path does not exist or is not a git repo
#   3 — Branch does not exist on origin
#   4 — git operation failed

set -euo pipefail

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
if [ $# -lt 2 ]; then
  echo "[ERROR] Usage: switch-branch.sh <branch> <repo-path>" >&2
  exit 1
fi

TARGET_BRANCH="$1"
REPO_PATH="$2"

echo "[INFO][switch-branch] branch='$TARGET_BRANCH' repo='$REPO_PATH'"

# ---------------------------------------------------------------------------
# Validate repo path
# ---------------------------------------------------------------------------
if [ ! -d "$REPO_PATH/.git" ]; then
  echo "[ERROR][switch-branch] '$REPO_PATH' is not a git repository." >&2
  exit 2
fi

cd "$REPO_PATH"

# ---------------------------------------------------------------------------
# Fetch latest from origin
# ---------------------------------------------------------------------------
echo "[INFO][switch-branch] Fetching origin..."
if ! git fetch origin; then
  echo "[ERROR][switch-branch] git fetch failed." >&2
  exit 4
fi

# ---------------------------------------------------------------------------
# Verify branch exists on origin
# ---------------------------------------------------------------------------
if ! git show-ref --verify --quiet "refs/remotes/origin/$TARGET_BRANCH"; then
  echo "[ERROR][switch-branch] Branch '$TARGET_BRANCH' not found on origin." >&2
  exit 3
fi

# ---------------------------------------------------------------------------
# Switch to target branch
# ---------------------------------------------------------------------------
CURRENT_BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || echo "DETACHED")

if [ "$CURRENT_BRANCH" != "$TARGET_BRANCH" ]; then
  echo "[INFO][switch-branch] Current branch is '$CURRENT_BRANCH' — switching to '$TARGET_BRANCH'..."
  if ! git show-ref --verify --quiet "refs/heads/$TARGET_BRANCH"; then
    echo "[DEBUG][switch-branch] Creating local tracking branch '$TARGET_BRANCH' from origin."
    git checkout -B "$TARGET_BRANCH" "origin/$TARGET_BRANCH"
  else
    git checkout "$TARGET_BRANCH"
  fi
else
  echo "[INFO][switch-branch] Already on '$TARGET_BRANCH'."
fi

# ---------------------------------------------------------------------------
# Hard reset to origin to ensure clean state
# ---------------------------------------------------------------------------
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "[WARN][switch-branch] Dirty working tree detected — hard-resetting to origin/$TARGET_BRANCH."
fi

if ! git reset --hard "origin/$TARGET_BRANCH"; then
  echo "[ERROR][switch-branch] git reset --hard failed." >&2
  exit 4
fi

HEAD_SHA=$(git rev-parse --short HEAD)
echo "[OK][switch-branch] Repo is now on '$TARGET_BRANCH' at $HEAD_SHA."
exit 0
