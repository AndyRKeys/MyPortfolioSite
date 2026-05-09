# Dev Server Setup

Sets up the `dev` branch as a second environment on the Ubuntu Server, accessible LAN-only at `http://<LAN_IP>:3001`. Run these steps once; future updates use `dev-server-deploy.sh`.

---

## Step 1 — Find your LAN IP

```bash
ip -4 addr show | grep inet | grep -v 127.0.0.1
```

Note the address — it will look like `192.168.x.x`. You need it in step 3.

---

## Step 2 — Create the env file on the server

SSH into the server, then:

```bash
# The deploy script will clone the repo on first run, but you need
# the .env in place beforehand. Create it manually:
mkdir -p ~/MyPortfolioSite-dev
curl -fsSL https://raw.githubusercontent.com/AndyRKeys/MyPortfolioSite/dev/.env.dev-server.example \
  -o ~/MyPortfolioSite-dev/.env
nano ~/MyPortfolioSite-dev/.env
```

Set these values (generate secrets with `openssl rand -base64 32`):

| Variable | Value |
|----------|-------|
| `LAN_IP` | Your LAN IP from step 1 |
| `DB_PASSWORD` | Strong password — **different from prod** |
| `JWT_SECRET` | 32+ char random string — **different from prod** |
| `WEBAUTHN_RP_ID` | Same as `LAN_IP` (no protocol, no port) |
| `WEBAUTHN_ORIGIN` | `http://<LAN_IP>:3001` |
| `FRONTEND_URL` | `http://<LAN_IP>:3001` |

Everything else can stay as defaulted.

---

## Step 3 — Open port 3001 to LAN only

```bash
sudo ufw allow from 192.168.0.0/16 to any port 3001 comment 'Dev site LAN-only'
sudo ufw status | grep 3001
```

If your home network uses a `10.x.x.x` subnet, adjust the range accordingly.

---

## Step 4 — Run the deploy

**From Windows (recommended):**

```powershell
.\scripts\deploy\dev-server-deploy.ps1
```

This SSHes into `ak-home-server`, clones the repo on first run, and runs the full deploy script. Uses the same SSH config as `prod-deploy.ps1`.

**From the server directly (or via SSH manually):**

```bash
bash ~/MyPortfolioSite-dev/scripts/deploy/dev-server-deploy.sh
```

Expected output on success:

```
╔══════════════════════════════════════════╗
║           Dev deploy complete ✓          ║
╚══════════════════════════════════════════╝
```

---

## Future deploys

Whenever you want to pull the latest `dev` branch to the server:

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
```

---

## Troubleshooting

**Health check fails after deploy**

The deploy script automatically dumps logs on failure. To investigate manually:
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
- Confirm `WEBAUTHN_RP_ID` in `.env` is just the bare IP (no `http://`, no port)
- Confirm `WEBAUTHN_ORIGIN` is exactly `http://<LAN_IP>:3001`
- Passkeys registered on prod will not work on dev (different origin — expected)

**`.env` validation errors on deploy**

The deploy script checks all required vars on every run and prints exactly which ones are missing or still set to placeholder values. Fix the reported vars in `~/MyPortfolioSite-dev/.env` and re-run.
