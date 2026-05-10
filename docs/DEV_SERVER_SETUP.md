# Dev Server Setup

Sets up the `dev` branch as a second environment on the Ubuntu Server, accessible LAN-only at `http://<LAN_IP>:3001`.

The deploy script handles cloning, `.env` creation, building, and health-checking automatically. You only need to do three things manually before the first run.

---

## Step 1 — Find your LAN IP

SSH into the server and run:

```bash
ip -4 addr show | grep inet | grep -v 127.0.0.1
```

Note the address — it will look like `192.168.x.x`. You need it in step 3.

---

## Step 2 — Open port 3001 to LAN only

```bash
sudo ufw allow from 192.168.0.0/16 to any port 3001 comment 'Dev site LAN-only'
sudo ufw status | grep 3001
```

If your home network uses a `10.x.x.x` subnet, adjust the range accordingly.

---

## Step 2b — Install micro (optional but recommended)

For a modern text editor with familiar shortcuts (Ctrl+S to save, Ctrl+Q to quit):

```bash
sudo apt install micro
```

You'll use this to edit `.env` in step 3.

---

## Step 3 — Run the deploy script

**From Windows (recommended):**

```powershell
.\scripts\deploy\dev-server-deploy.ps1
```

**From the server directly:**

```bash
bash ~/MyPortfolioSite-dev/scripts/deploy/dev-server-deploy.sh
```

### What happens on the first run

The script checks for a `.env` file. If one doesn't exist it copies `.env.dev-server.example` into place and stops with instructions:

```
[WARN]  .env created but not yet configured.
[WARN]  Edit ~/MyPortfolioSite-dev/.env and set these values:
[WARN]    LAN_IP           — your server LAN IP (ip -4 addr show)
[WARN]    DB_PASSWORD      — strong random password
[WARN]    JWT_SECRET       — random string, min 32 chars (openssl rand -base64 32)
[WARN]    WEBAUTHN_RP_ID   — same as LAN_IP (bare IP, no protocol/port)
[WARN]    WEBAUTHN_ORIGIN  — http://<LAN_IP>:3001
[WARN]    FRONTEND_URL     — http://<LAN_IP>:3001
```

Edit the file with:

```bash
micro ~/MyPortfolioSite-dev/.env
```

Fill in the required values above. The rest of the file can stay as defaulted.

Generate secrets with:
```bash
openssl rand -base64 32
```

### What happens on the second run (and all future runs)

The script validates `.env`, builds the containers, and polls the health endpoint. On success:

```
══════════════════════════════════════════
║           Dev deploy complete ✓          ║
══════════════════════════════════════════
```

---

## Future deploys

Whenever you want to pull the latest `dev` branch to the server, run the same command:

```powershell
# From Windows
.\scripts\deploy\dev-server-deploy.ps1
```

```bash
# From the server
bash ~/MyPortfolioSite-dev/scripts/deploy/dev-server-deploy.sh
```

Logs are written to `~/dev-deploy.log` on the server.

---

## Useful commands

```bash
# Check container status
docker compose -f ~/MyPortfolioSite-dev/docker-compose.dev-server.yml ps

# View backend logs
docker compose -f ~/MyPortfolioSite-dev/docker-compose.dev-server.yml logs -f backend-dev

# Stop dev environment (frees resources when not needed)
docker compose -f ~/MyPortfolioSite-dev/docker-compose.dev-server.yml down

# Restart backend only
docker compose -f ~/MyPortfolioSite-dev/docker-compose.dev-server.yml restart backend-dev

# Edit .env with micro
micro ~/MyPortfolioSite-dev/.env
```

---

## Troubleshooting

**Health check fails after deploy**

The deploy script automatically dumps container logs on failure. To investigate manually:
```bash
docker compose -f ~/MyPortfolioSite-dev/docker-compose.dev-server.yml logs --tail=50 backend-dev
docker compose -f ~/MyPortfolioSite-dev/docker-compose.dev-server.yml logs --tail=20 postgres-dev
```

**Port 3001 not reachable from other LAN devices**
```bash
sudo ufw status        # confirm the allow rule is present
sudo lsof -i :3001     # confirm nginx-dev is listening
```

**WebAuthn / passkey errors on the dev site**
- Confirm `WEBAUTHN_RP_ID` in `.env` is the bare IP (no `http://`, no port)
- Confirm `WEBAUTHN_ORIGIN` is exactly `http://<LAN_IP>:3001`
- Passkeys registered on prod will not work on dev (different origin — expected)

**`.env` validation errors on deploy**

The deploy script checks all required vars on every run and tells you exactly which are missing or still set to placeholder values. Fix them in `~/MyPortfolioSite-dev/.env` and re-run.
