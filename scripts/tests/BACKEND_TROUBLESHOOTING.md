# Backend Troubleshooting for PR #118 Testing

If you're seeing database errors or "Status unavailable: NetworkError" in the deployment screen, follow these steps:

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
docker compose logs backend --tail 50
```

Look for:
- Connection errors to Postgres
- Port already in use (8080)
- JWT_SECRET not set
- Schema migration failures

If you see a connection error like `could not translate host name "postgres"`, the database is still initializing — wait a few more seconds and retry.

## 3. Test backend health directly

```powershell
curl http://localhost:8080/api/health
```

Should return: `{"status":"ok"}`

If you get a connection refused, the backend isn't listening yet. Check the logs (step 2).

## 4. Test a non-deploy endpoint to isolate the issue

```powershell
# Get published blog posts (no auth needed)
curl http://localhost:8080/api/posts

# Should return a JSON array (empty if no posts in DB)
```

If this fails, the issue is the backend itself, not the new deploy endpoints.

If this works but `/api/deploy/status` fails with 404, the deploy routes aren't loaded — check that `app.use('/deploy', deployRoutes)` is in `backend/app.js`.

## 5. Run the full test script

Once the backend is healthy:

```powershell
.\scripts\tests\Test-PR118.ps1
```

This will test all deploy endpoints with proper auth and capture results to `test-results/PR118-<timestamp>.txt`.

## 6. Still stuck?

Check:
- `.env` file exists in the `backend/` directory with `JWT_SECRET` set
- Postgres volume is not corrupted: `docker compose down -v && docker compose up`
- No conflicting services on port 8080: `netstat -ano | findstr 8080` (Windows) or `lsof -i :8080` (Mac/Linux)
