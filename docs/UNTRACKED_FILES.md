# Untracked Files & Directories

This document lists files and directories that are **not tracked in git** but are **essential for the application to work**. These are production/environment-specific and must be created manually or via deployment scripts.

## Critical Files (Must Exist)

### `.env` — Environment Configuration
**Location:** `~/.env` (dev server) or `$(git rev-parse --show-toplevel)/.env` (local testing)

**Purpose:** Secrets, credentials, and environment-specific settings that must never be committed.

**How it's created:**
- Deployment script copies from `.env.dev-server.example` template
- Or manually: `cp .env.dev-server.example .env`
- Then edit with real values (LAN_IP, passwords, API keys, etc.)

**What goes in it:**
```bash
# Network & WebAuthn
LAN_IP=192.168.x.x
WEBAUTHN_RP_ID=192.168.x.x
WEBAUTHN_ORIGIN=https://192.168.x.x:3001
FRONTEND_URL=https://192.168.x.x:3001
DOMAIN=yourdomain.example.com

# Secrets (never commit these!)
DB_PASSWORD=your_secure_password_here
JWT_SECRET=long_random_string_min_32_chars

# Email (optional)
SMTP_HOST=smtp.gmail.com
SMTP_USER=your@email.com
SMTP_PASS=app_password_here
ADMIN_EMAIL=you@example.com
```

**How Docker uses it:**
- Docker Compose reads `.env` automatically from the working directory
- Variables are injected into container environments
- Nginx templates use `${VARIABLE}` syntax (envsubst substitution)

### `scripts/config/certs/` — SSL Certificates (Dev Only)
**Location:** `scripts/config/certs/`

**Files:**
- `dev-server.crt` — Self-signed certificate (generated for dev HTTPS)
- `dev-server.key` — Private key (generated for dev HTTPS)

**How they're created:**
- Automatically by deployment: `bash scripts/setup/generate-dev-certs.sh $LAN_IP`
- Or manually: `bash scripts/setup/generate-dev-certs.sh 192.168.68.81`

**Why it's untracked:**
- Private key should never be committed
- Certificate is specific to server IP/hostname
- Regenerated when LAN_IP changes

### `uploads/` — User-Uploaded Files
**Location:** `uploads/` (repository root)

**Purpose:** Stores user uploads (PDFs, images) from the admin console.

**How it's managed:**
- Created automatically by deployment: `mkdir -p uploads/`
- Persisted in Docker volume: `uploads_dev_data:/app/uploads`
- Never committed (`.gitignore`)

**Why it's untracked:**
- Contains user data
- Can be large
- Server-specific

## Important Directories That Persist

### `scripts/config/certs/` — Certificate Metadata
Stores:
- `dev-server.crt` — SSL certificate
- `dev-server.key` — SSL key
- (Previously) `dev-server.lan_ip` — IP used when cert was generated (deprecated, now checks cert CN/SAN)

### Volumes (Docker Data)
**Not directly in repo, but critical:**
- `postgres_dev_data` — Database files
- `uploads_dev_data` — Uploaded files
- Database is initialized from `backend/db/schema.sql` (tracked in repo)
- Uploads directory is created on first deploy

## Deployment Script Checklist

The deployment script (`scripts/deploy/deploy.sh --env dev`) automatically:
1. ✅ Clones repo (if needed)
2. ✅ Creates `.env` from template if missing
3. ✅ Validates `.env` (required variables, no placeholders)
4. ✅ Generates certificates if needed (skips if LAN_IP unchanged)
5. ✅ Creates `uploads/` directory
6. ✅ Initializes database from `backend/db/schema.sql`
7. ✅ Starts containers with Docker Compose

**What the script does NOT do** (requires manual setup):
- UFW firewall rules (optional, prompted after deploy)
- Systemd autostart service (optional, prompted after deploy)
- Email configuration (set in `.env`, tested in admin console)

## Restoring After Disaster

### Rebuild everything from scratch:
```bash
# On dev server:
rm -rf ~/MyPortfolioSite-dev
.\scripts\deploy\dev-deploy.ps1  # from Windows
# or from the server directly:
bash ~/MyPortfolioSite-dev/scripts/deploy/switch-branch.sh dev ~/MyPortfolioSite-dev
bash ~/MyPortfolioSite-dev/scripts/deploy/deploy.sh --env dev dev
```

This will:
1. Clone the repo
2. Create `.env` (you configure it)
3. Generate certificates
4. Initialize database
5. Start containers

### Recover database only (keep existing data):
```bash
# Docker volumes persist, so data isn't lost
docker compose -f ~/MyPortfolioSite-dev/docker-compose.dev-server.yml up -d
```

### Recover uploads only:
```bash
# If uploads/ was accidentally deleted:
mkdir -p ~/MyPortfolioSite-dev/uploads
docker compose -f ~/MyPortfolioSite-dev/docker-compose.dev-server.yml up -d
```

## Local Development Checklist

When cloning locally for testing:
```bash
git clone https://github.com/AndyRKeys/MyPortfolioSite.git
cd MyPortfolioSite

# Create .env for local testing
cp .env.dev-server.example .env
# Edit .env with your LAN_IP and other values

# Start dev environment
docker compose -f docker-compose.dev-server.yml up -d --build

# Or use PowerShell helper
. scripts/dev/dev-local.ps1 up
```

## Security Notes

**Never commit:**
- `.env` (secrets, passwords, API keys)
- `scripts/config/certs/dev-server.key` (private key)
- `uploads/` (user data)

**Always use .gitignore:**
These are already in `.gitignore`:
```
.env
.env.local
scripts/config/certs/
uploads/
node_modules/
.DS_Store
```

Verify with: `git check-ignore .env`

## Reference: How Variables Flow

```
.env file (secrets)
    ↓
docker-compose.yml reads .env automatically
    ↓
Passes ${VAR} to container environments
    ↓
Nginx template uses envsubst to substitute ${DOMAIN}, ${APP_PORT}, etc.
    ↓
Rendered config served by nginx
    ↓
Backend app reads env vars directly (process.env.JWT_SECRET, etc.)
```

Example: WEBAUTHN_ORIGIN flow:
```
.env: WEBAUTHN_ORIGIN=https://192.168.68.81:3001
  ↓
docker-compose.yml backend environment: WEBAUTHN_ORIGIN: ${WEBAUTHN_ORIGIN}
  ↓
backend/app.js: const origin = process.env.WEBAUTHN_ORIGIN
  ↓
Used in WebAuthn validation
```
