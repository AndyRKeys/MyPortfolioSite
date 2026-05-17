# Operator Runbook

Short, practical guide for running and troubleshooting the dev and prod environments for andykeys.me.

This is aimed at **future you on a tired evening** — copy-paste commands first, details later.

---

## Environments at a Glance

| Environment | Host | Compose file | Backend service | Nginx service | DB name |
|-------------|------|--------------|-----------------|---------------|---------|
| Dev server | `ak-home-server` (LAN) | `docker-compose.dev-server.yml` | `backend-dev` | `nginx-dev` | `portfolio_dev` |
| Prod | `ak-home-server` (public `andykeys.me`) | `docker-compose.prod.yml` | `backend` | `nginx` | `portfolio_prod` |

See **[docs/DEV_ENVIRONMENT.md](./DEV_ENVIRONMENT.md)** and **[docs/PROD_ENVIRONMENT.md](./PROD_ENVIRONMENT.md)** for full details.

---

## Common Tasks

### 1. Check "is prod healthy?"

From your Windows machine:

```powershell
# Hit the homepage and a simple API endpoint (unauthenticated)
curl.exe -s https://andykeys.me/ | Select-Object -First 5
curl.exe -s https://andykeys.me/api/health
```

Expected:
- HTML for the homepage in the first call
- A small JSON health payload or 200 OK for `/api/health`

If either fails, go to **Check logs** below.

---

### 2. Check logs

SSH into the server first:

```bash
ssh ak-home-server
cd ~/MyPortfolioSite-prod
```

Then:

```bash
# Backend logs (prod)
docker compose -f docker-compose.prod.yml logs --tail=100 backend

# Nginx logs (prod)
docker compose -f docker-compose.prod.yml logs --tail=100 nginx

# Dev backend logs
cd ~/MyPortfolioSite-dev
docker compose -f docker-compose.dev-server.yml logs --tail=100 backend-dev
```

If containers are not running, see **Restart services**.

---

### 3. Restart services

On the server:

```bash
# Prod stack
cd ~/MyPortfolioSite-prod

# Restart just backend
docker compose -f docker-compose.prod.yml restart backend

# Restart just nginx
docker compose -f docker-compose.prod.yml restart nginx

# Restart whole stack (backend + nginx + postgres)
docker compose -f docker-compose.prod.yml up -d --build
```

Dev server equivalent:

```bash
cd ~/MyPortfolioSite-dev

docker compose -f docker-compose.dev-server.yml restart backend-dev
# or full stack
docker compose -f docker-compose.dev-server.yml up -d --build
```

If `up -d --build` fails, run `docker compose ... logs` and `docker compose ... ps` to see which container is unhealthy.

---

### 4. Deploy new version to prod

From Windows:

```powershell
# From repo root on your Windows machine
.\scripts\deploy\prod-deploy.ps1
```

This will:
- SSH into `ak-home-server`
- Pull the latest `main`
- Rebuild images
- Apply schema (idempotent)
- Restart the prod stack
- Run automated backend tests and regression checks as part of the deploy (see **docs/TESTING.md**)

If the script reports a failure, it will roll back; check the backend logs on the server.

---

### 5. Run regression tests manually

On the server (dev stack):

```bash
cd ~/MyPortfolioSite-dev
bash scripts/tests/test-regression.sh \
  --base-url https://dev.andykeys.me:3001 \
  --compose-file docker-compose.dev-server.yml \
  --service backend-dev \
  --insecure
```

On the server (prod stack, only if needed and safe):

```bash
cd ~/MyPortfolioSite-prod
bash scripts/tests/test-regression.sh \
  --base-url https://andykeys.me \
  --compose-file docker-compose.prod.yml \
  --service backend \
  --insecure
```

For a specific PR, run its PowerShell smoke test from Windows against dev (see **docs/TESTING.md** and `scripts/tests/Test-PR<N>.ps1`).

---

## When Something Is Broken

### 1. Narrow it down

Ask three questions:
- Is it **frontend only** (layout/JS), **API only** (HTTP errors), or **everything** (site down)?
- Does it reproduce on both **dev** and **prod**, or just one?
- Did a deploy just happen?

This tells you whether to look at frontend files, backend logs, or the deploy scripts.

### 2. "Site is down" (cannot reach andykeys.me)

On the server:

```bash
# Check containers
cd ~/MyPortfolioSite-prod
docker compose -f docker-compose.prod.yml ps

# If nginx is missing or exited, check logs
docker compose -f docker-compose.prod.yml logs --tail=100 nginx

# If backend is missing or exited
docker compose -f docker-compose.prod.yml logs --tail=100 backend
```

Common fixes:
- Fix any config error reported in logs (env var, port conflict, bad nginx config)
- Re-run `docker compose -f docker-compose.prod.yml up -d --build`

If DNS/SSL is the issue (cert expired, host unreachable), follow **docs/INFRASTRUCTURE.md**.

### 3. "API returns 5xx" but site loads

Check backend logs while reproducing the error:

```bash
cd ~/MyPortfolioSite-prod
docker compose -f docker-compose.prod.yml logs -f backend
```

Look for:
- Stack traces or structured error logs around the failing endpoint
- Database connection errors
- Auth errors (JWT / WebAuthn)

If it looks like a regression from a recent change, see **Rolling back a bad deploy**.

---

## Rolling Back a Bad Deploy

If a prod deploy introduces a serious regression and you need to roll back quickly:

1. Identify the last known-good release in **docs/RELEASE_NOTES.md** and its commit/branch.
2. On your local machine, create a hotfix branch from that known-good state if needed (see README and docs/AI.md for hotfix flow).
3. On the server, you can temporarily roll back the running containers to the previous image tag if you have it, or redeploy `main` at the last good commit.

> This section intentionally stays high-level; when a more specific rollback recipe is in place, link or inline it here.

---

## Where to Read More

- **[docs/INFRASTRUCTURE.md](./INFRASTRUCTURE.md)** — host-level infrastructure, both environments, backups, Dropbear unlock
- **[docs/DEV_ENVIRONMENT.md](./DEV_ENVIRONMENT.md)** — dev server Docker stack, dev `.env`, dev deploy scripts
- **[docs/PROD_ENVIRONMENT.md](./PROD_ENVIRONMENT.md)** — prod Docker stack, prod `.env`, prod deploy scripts
- **[docs/TESTING.md](./TESTING.md)** — automated deploy-time checks, regression tests, PR smoke tests
- **[docs/DEPLOYMENT_LESSONS_LEARNED.md](./DEPLOYMENT_LESSONS_LEARNED.md)** — past incidents and what changed as a result
