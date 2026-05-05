# Backend Troubleshooting for PR #118 Testing

If you're seeing database errors, 502 errors, or "Status unavailable: NetworkError" in the deployment screen, follow these steps.

## Quick diagnosis

**502 Bad Gateway** during testing = backend is crashing or not responding.

Try this first:

```powershell
curl http://localhost:8080/api/health
```

- If this returns `{"status":"ok"}`, the backend is running but deploy endpoints have an issue
- If this times out or returns 502, the backend itself isn't responding — check logs (step 2)

## 1. Verify the dev environment is running

```powershell
docker compose ps
```

You should see:
- `backend` — running on port 8080
- `postgres` — running on port 5432

If either is not running, start them:

```powershell
. scripts\dev\dev-local.ps1 up
```

Wait 10-15 seconds for Postgres to initialize before testing.

## 2. Check backend logs for errors

```powershell
docker compose logs backend --tail 100
```

Look for:
- `ECONNREFUSED` — postgres not ready yet (wait a few seconds and retry)
- `Error: ENOENT: no such file or directory, open '/app/backend/.env'` — .env file missing
- `git: command not found` — git isn't installed in the container (expected in some dev setups; /deploy endpoints degrade gracefully)
- `TypeError` or `SyntaxError` — code error in deploy routes (shouldn't happen with latest push)
- `Port 8080 already in use` — another service is listening on 8080

## 3. Test backend health directly

```powershell
curl http://localhost:8080/api/health
```

Should return: `{"status":"ok"}`

**If you get 502:** the backend is running Nginx but the app crashed. Check logs (step 2).

**If you get connection refused:** the backend isn't listening. Make sure Docker is running and containers are up (step 1).

## 4. Test deploy endpoints specifically

```powershell
# Without auth (should return 401)
curl http://localhost:8080/api/deploy/status

# With a valid JWT (if available)
curl -H "Authorization: Bearer YOUR_TOKEN_HERE" http://localhost:8080/api/deploy/status
```

**Expected responses:**

- **With no git/in dev:** `200` with `{"branch":"unknown","canDeploy":false,...}`
- **Without auth:** `401 Unauthorized`
- **Git available:** `200` with real branch/commit info

## 5. Isolate to check if it's just deploy endpoints

```powershell
# Get published blog posts (no auth, no git needed)
curl http://localhost:8080/api/posts

# Should return a JSON array: []  (or posts if any exist)
```

If this fails, the issue is the backend itself, not the deploy panel.

If this works but `/api/deploy/*` fails, the deploy routes have an issue (check logs).

## 6. Run the full test script

Once the backend is healthy:

```powershell
.\scripts\tests\Test-PR118.ps1
```

This will test all deploy endpoints with proper auth and capture results to `test-results/PR118-<timestamp>.txt`.

## Common issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Backend keeps restarting | Postgres not ready | Wait 15s after `docker compose up` |
| 502 on all endpoints | .env missing in backend/ | Copy `.env.example` to `.env` |
| `git: command not found` in logs | Git not in container | Expected in dev; deploy endpoints return graceful fallback (`canDeploy: false`) |
| `EADDRINUSE: port 8080 already in use` | Another service on 8080 | Kill the process: `lsof -i :8080` then `kill -9 <pid>` |
| `Status unavailable: NetworkError` in admin panel | Backend not responding | Check `/api/health`; if that fails, check Docker logs |

## Still stuck?

Try a full reset:

```powershell
# Shut down and remove all containers and volumes
docker compose down -v

# Start fresh (postgres will re-initialize)
. scripts\dev\dev-local.ps1 up

# Wait 20 seconds for postgres to be ready
Start-Sleep -Seconds 20

# Test health
curl http://localhost:8080/api/health
```

If problems persist, check that:
- `.env` exists in `backend/` with `JWT_SECRET` set
- Docker has enough disk space (`docker system df`)
- No firewall rules blocking localhost:8080
