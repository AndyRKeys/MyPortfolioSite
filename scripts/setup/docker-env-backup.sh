#!/usr/bin/env bash
# docker-env-backup.sh — Backup and restore dev/prod env files for Docker migration.
#
# This script helps preserve important environment configuration files for
# dev and prod during Docker migration.
#
# It supports two modes:
#   backup  - copy known env files into a timestamped backup directory
#   restore - copy from the latest backup back into expected locations
#
# Usage:
#   bash scripts/setup/docker-env-backup.sh backup
#   bash scripts/setup/docker-env-backup.sh restore

set -euo pipefail

MODE="${1:-}"
if [[ -z "${MODE}" ]]; then
  echo "Usage: $0 <backup|restore>" >&2
  exit 1
fi

# Adjust these paths/names if your env files differ.
DEV_PROJECT_ROOT="${DEV_PROJECT_ROOT:-$HOME/MyPortfolioSite-dev}"
PROD_PROJECT_ROOT="${PROD_PROJECT_ROOT:-$HOME/MyPortfolioSite}"

DEV_ENV_FILE="${DEV_ENV_FILE:-${DEV_PROJECT_ROOT}/.env}"
PROD_ENV_FILE="${PROD_ENV_FILE:-${PROD_PROJECT_ROOT}/.env}"

BACKUP_ROOT="${BACKUP_ROOT:-$HOME/docker-migration-backup}"
mkdir -p "${BACKUP_ROOT}"

backup_envs() {
  local timestamp
  timestamp="$(date +%Y%m%d-%H%M%S)"
  local backup_dir="${BACKUP_ROOT}/${timestamp}"
  mkdir -p "${backup_dir}"

  echo "[INFO] Backing up env files to: ${backup_dir}"

  local any=0

  if [[ -f "${DEV_ENV_FILE}" ]]; then
    cp "${DEV_ENV_FILE}" "${backup_dir}/.env.dev"
    echo "[OK] Backed up dev env: ${DEV_ENV_FILE}"
    any=1
  else
    echo "[WARN] Dev env file not found: ${DEV_ENV_FILE}"
  fi

  if [[ -f "${PROD_ENV_FILE}" ]]; then
    cp "${PROD_ENV_FILE}" "${backup_dir}/.env.prod"
    echo "[OK] Backed up prod env: ${PROD_ENV_FILE}"
    any=1
  else
    echo "[WARN] Prod env file not found: ${PROD_ENV_FILE}"
  fi

  if [[ "${any}" -eq 0 ]]; then
    echo "[WARN] No env files were backed up. Check paths and try again."
  else
    echo "[INFO] Backup complete."
  fi
}

restore_envs() {
  # Find latest backup directory
  if [[ ! -d "${BACKUP_ROOT}" ]]; then
    echo "[ERROR] Backup root does not exist: ${BACKUP_ROOT}" >&2
    exit 1
  fi

  local latest
  latest="$(ls -1 "${BACKUP_ROOT}" | sort | tail -n 1 || true)"
  if [[ -z "${latest}" ]]; then
    echo "[ERROR] No backups found under ${BACKUP_ROOT}" >&2
    exit 1
  fi

  local backup_dir="${BACKUP_ROOT}/${latest}"
  echo "[INFO] Restoring env files from: ${backup_dir}"

  local any=0

  if [[ -f "${backup_dir}/.env.dev" ]]; then
    if [[ -f "${DEV_ENV_FILE}" ]]; then
      echo "[INFO] Dev env already exists at ${DEV_ENV_FILE}; leaving in place."
    else
      cp "${backup_dir}/.env.dev" "${DEV_ENV_FILE}"
      echo "[OK] Restored dev env to: ${DEV_ENV_FILE}"
      any=1
    fi
  else
    echo "[WARN] Dev env backup not found in: ${backup_dir}"
  fi

  if [[ -f "${backup_dir}/.env.prod" ]]; then
    if [[ -f "${PROD_ENV_FILE}" ]]; then
      echo "[INFO] Prod env already exists at ${PROD_ENV_FILE}; leaving in place."
    else
      cp "${backup_dir}/.env.prod" "${PROD_ENV_FILE}"
      echo "[OK] Restored prod env to: ${PROD_ENV_FILE}"
      any=1
    fi
  else
    echo "[WARN] Prod env backup not found in: ${backup_dir}"
  fi

  if [[ "${any}" -eq 0 ]]; then
    echo "[WARN] No env files were restored. Check backups and paths." >&2
  else
    echo "[INFO] Restore complete."
  fi
}

case "${MODE}" in
  backup)
    backup_envs ;;
  restore)
    restore_envs ;;
  *)
    echo "Usage: $0 <backup|restore>" >&2
    exit 1 ;;
 esac
