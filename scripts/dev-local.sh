#!/bin/bash
# Local development helper for andykeys.me
# Mirrors prod-deploy.sh behaviour for the Docker dev environment.
#
# Commands:
#   up     — build & start all containers; auto-applies schema.sql if changed
#   down   — stop containers (DB volume is preserved)
#   reset  — full teardown including DB volume, then rebuild (clean slate)
#   logs   — tail backend container logs
#   db     — open a psql shell into the dev DB
#
# Run from the repo root: bash scripts/dev-local.sh <command>
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

case "$1" in

  up)
    # Detect uncommitted or committed-but-not-applied schema changes.
    # Covers both: changes staged/unstaged locally, and changes that were
    # just pulled (matching the prod-deploy.sh detection pattern).
    SCHEMA_CHANGED=$(git diff HEAD -- backend/db/schema.sql | wc -l)

    echo "=== Starting containers ==="
    docker compose up --build -d

    # Wait for Postgres to be healthy before attempting migration
    echo "=== Waiting for Postgres to be ready ==="
    until docker compose exec -T postgres pg_isready -U "${DB_USER:-postgres}" > /dev/null 2>&1; do
      sleep 1
    done

    if [ "$SCHEMA_CHANGED" -gt 0 ]; then
      echo "=== schema.sql changed — applying to dev DB ==="
      docker compose exec -T postgres psql \
        -U "${DB_USER:-postgres}" \
        -d "${DB_NAME:-portfolio_dev}" \
        -f /docker-entrypoint-initdb.d/01-schema.sql
      echo "  Schema applied."
    else
      echo "=== schema.sql unchanged — skipping migration ==="
    fi

    echo ""
    docker compose ps
    echo ""
    echo "Dev environment running at http://localhost"
    ;;

  down)
    echo "=== Stopping containers (DB volume preserved) ==="
    docker compose down
    ;;

  reset)
    echo "=== Full reset — removing containers and DB volume ==="
    echo "WARNING: All local dev data will be lost."
    read -r -p "Continue? [y/N] " confirm
    if [[ "$confirm" =~ ^[Yy]$ ]]; then
      docker compose down -v
      echo "=== Rebuilding from scratch ==="
      docker compose up --build -d
      echo ""
      echo "Clean dev environment running at http://localhost"
    else
      echo "Reset cancelled."
    fi
    ;;

  logs)
    docker compose logs -f backend
    ;;

  db)
    echo "=== Opening psql shell (${DB_NAME:-portfolio_dev}) ==="
    docker compose exec postgres psql \
      -U "${DB_USER:-postgres}" \
      -d "${DB_NAME:-portfolio_dev}"
    ;;

  *)
    echo "Usage: bash scripts/dev-local.sh [up|down|reset|logs|db]"
    echo ""
    echo "  up     Build & start all containers; auto-migrates schema if changed"
    echo "  down   Stop containers (DB volume preserved)"
    echo "  reset  Full teardown + rebuild — wipes local DB data"
    echo "  logs   Tail backend container logs"
    echo "  db     Open a psql shell into the dev DB"
    exit 1
    ;;

esac
