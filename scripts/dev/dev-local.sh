#!/bin/bash
# Local development helper for andykeys.me
# Mirrors prod-deploy.sh behaviour for the Docker dev environment.
#
# Commands:
#   up             — build & start all containers; always applies schema.sql on
#                    a fresh/empty DB; re-applies if schema.sql has changed
#   down           — stop containers (DB volume is preserved)
#   reset          — full teardown including DB volume, then rebuild (clean slate)
#   logs           — tail backend container logs
#   db             — open a psql shell into the dev DB
#   test           — run the automated test suite inside the backend container
#   test:coverage  — run tests with coverage report inside the backend container
#
# Run from the repo root: bash scripts/dev/dev-local.sh <command>
set -e

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_DIR"

# Default to the laptop-local compose file. The repo root's docker-compose.yml
# is the unified SERVER compose; local dev uses docker-compose.local.yml,
# which has source bind-mounts and exposes the DB port for psql.
export COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.local.yml}"

case "$1" in

  up)
    echo "=== Starting containers ==="
    docker compose up --build -d

    echo "=== Waiting for Postgres to be ready ==="
    until docker compose exec -T postgres pg_isready -U "${DB_USER:-postgres}" > /dev/null 2>&1; do
      sleep 1
    done

    TABLE_COUNT=$(docker compose exec -T postgres psql \
      -U "${DB_USER:-postgres}" \
      -d "${DB_NAME:-portfolio_dev}" \
      -tAc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';" 2>/dev/null || echo "0")
    TABLE_COUNT=$(echo "$TABLE_COUNT" | tr -d '[:space:]')

    SCHEMA_CHANGED=$(git diff HEAD -- backend/db/schema.sql | wc -l)

    if [ "$TABLE_COUNT" -eq 0 ]; then
      echo "=== Fresh DB detected — applying full schema ==="
      docker compose exec -T postgres psql \
        -U "${DB_USER:-postgres}" \
        -d "${DB_NAME:-portfolio_dev}" \
        -f /docker-entrypoint-initdb.d/01-schema.sql
      echo "  Schema applied."
    elif [ "$SCHEMA_CHANGED" -gt 0 ]; then
      echo "=== schema.sql changed — applying to dev DB ==="
      docker compose exec -T postgres psql \
        -U "${DB_USER:-postgres}" \
        -d "${DB_NAME:-portfolio_dev}" \
        -f /docker-entrypoint-initdb.d/01-schema.sql
      echo "  Schema applied."
    else
      echo "=== DB already populated and schema.sql unchanged — skipping migration ==="
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

      echo "=== Waiting for Postgres to be ready ==="
      until docker compose exec -T postgres pg_isready -U "${DB_USER:-postgres}" > /dev/null 2>&1; do
        sleep 1
      done

      echo "=== Applying full schema to clean DB ==="
      docker compose exec -T postgres psql \
        -U "${DB_USER:-postgres}" \
        -d "${DB_NAME:-portfolio_dev}" \
        -f /docker-entrypoint-initdb.d/01-schema.sql
      echo "  Schema applied."

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

  test)
    echo "=== Installing devDependencies inside backend container ==="
    docker compose exec backend npm install --silent
    echo "=== Running test suite ==="
    docker compose exec backend npm test
    ;;

  test:coverage)
    echo "=== Installing devDependencies inside backend container ==="
    docker compose exec backend npm install --silent
    echo "=== Running tests with coverage ==="
    docker compose exec backend npm run test:coverage
    ;;

  *)
    echo "Usage: bash scripts/dev/dev-local.sh [up|down|reset|logs|db|test|test:coverage]"
    echo ""
    echo "  up             Build & start all containers; auto-migrates schema"
    echo "  down           Stop containers (DB volume preserved)"
    echo "  reset          Full teardown + rebuild — wipes local DB data"
    echo "  logs           Tail backend container logs"
    echo "  db             Open a psql shell into the dev DB"
    echo "  test           Run automated test suite inside the backend container"
    echo "  test:coverage  Run tests with coverage report inside the backend container"
    exit 1
    ;;

esac
