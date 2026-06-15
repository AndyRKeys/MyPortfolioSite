# Logging and Redaction Guidelines

Deployment logs are shared with developers and stored in repositories. This document explains what information should be redacted and how to prevent sensitive data leaks.

---

## Sensitive Information Categories

### Always Redact

**In all contexts** (logs, output, error messages):

| Category | Examples | Why | Redaction |
|----------|----------|-----|-----------|
| **IP Addresses** | `192.168.68.81`, `10.0.0.5` | Reveals network topology, server location, LAN structure | `[REDACTED_IP]` |
| **Usernames** | `/home/modnar3`, `/home/andy` | Identifies individuals, may enable social engineering | `/home/[USER]` |
| **Hostnames** | `modnar3-laptop`, `gaming-pc` | Personal device names, enables targeting | `[REDACTED_HOST]` |
| **Full URLs with IPs** | `https://192.168.68.81:3001` | Combines IP + port info for targeting | `[REDACTED_URL]` |
| **Container Names** | `myportfoliosite-dev-backend-1` | Reveals project structure, infrastructure details | `[REDACTED_CONTAINER]` |
| **Service Names (in docker compose)** | `backend-dev`, `nginx-prod` | Infrastructure topology | `[REDACTED_SERVICE]` |
| **Project Paths** | `/home/user/MyPortfolioSite-dev` | Reveals deployment structure, directory layout | `/home/[USER]/[REDACTED_PROJECT]` |

### Okay to Show

These do NOT need redaction:

| Category | Examples | Why |
|----------|----------|-----|
| **Public domain names** | `andykeys.me`, `github.com` | Already public |
| **Localhost references** | `localhost`, `127.0.0.1` | Not sensitive, expected in dev logs |
| **Standard ports** | `:8080`, `:3001`, `:5432` | Not sensitive without IP context |
| **Generic paths** | `/app`, `/usr`, `/var` | Not sensitive when not tied to usernames |
| **Code/repo info** | Branch names, commit SHAs, repo names | Already public in GitHub |

---

## Automatic Redaction

The deployment script (`scripts/deploy/deploy-lib.sh`) includes `_redact_sensitive()` which is applied to **all output** that goes through the logging functions:

```bash
dinfo()      # Info messages — auto-redacted
dok()        # Success messages — auto-redacted
dwarn()      # Warnings — auto-redacted
dfail()      # Error messages — auto-redacted
dlog()       # Raw log lines — auto-redacted
```

**Example:**

```bash
# Input
dinfo "Backend running at https://192.168.68.81:3001 on host $(hostname)"

# Output in log
[INFO]  Backend running at [REDACTED_URL] on host [REDACTED_HOST]
```

---

## When to Use Redaction Functions

### ✅ Do Use Logging Functions

```bash
# ✅ GOOD — automatic redaction applied
dinfo "Deploying to https://192.168.68.81:3001"
dlog "Container myportfoliosite-dev-backend-1 started"
docker compose logs | dlog  # Will NOT work; pipe before dlog
```

### ❌ Don't Use Plain `echo`

```bash
# ❌ BAD — no redaction
echo "Running on host $(hostname)"
echo "Container $(docker ps)" | grep backend
```

---

## Handling Docker Compose Output

`docker compose` output often contains sensitive info (container names, service names, IP ranges in PORTS column). **Always filter before logging:**

```bash
# ❌ BAD — exposes container names and service details
docker compose logs >> $LOG_FILE

# ✅ GOOD — pipe through redaction
docker compose ps | _redact_sensitive | tee -a $LOG_FILE

# ✅ GOOD — use deployment function
dlog "$(docker compose ps | _redact_sensitive)"
```

---

## Handling Test Output

Test scripts (e.g., `test-error-logger.js`) may print URLs, IPs, or service names. **Capture and redact:**

```bash
# ❌ BAD
npm run test:error-logger $URL

# ✅ GOOD
test_output=$(npm run test:error-logger $URL 2>&1)
dlog "$test_output"  # Automatically redacted by dlog()
```

---

## Git Commit Messages

Commit messages **should NOT contain deployment secrets**, but **may contain redacted examples**:

```bash
# ❌ BAD
git commit -m "Deployed to 192.168.68.81 successfully"

# ✅ GOOD
git commit -m "Deploy script now redacts sensitive info in logs"
```

---

## Environment Variables

Never log `.env` files or environment variable contents directly:

```bash
# ❌ BAD
dlog "Configuration: $JWT_SECRET=$JWT_SECRET, FRONTEND_URL=$FRONTEND_URL"

# ✅ GOOD
dlog "Configuration loaded: $(wc -l < .env) variables set"
```

If validation needs to show values, use `**` masking:

```bash
# ✅ ACCEPTABLE
if [ -z "$JWT_SECRET" ]; then
  dfail "JWT_SECRET not set"
fi
dlog "JWT_SECRET: ******* ($(echo -n "$JWT_SECRET" | wc -c) chars)"
```

---

## Log File Access

The log file (`/home/[USER]/dev-deploy.log` or similar) is **local to the server**. Sensitive information is redacted before writing.

**Before sharing logs:**

1. Run through `_redact_sensitive()` again to verify
2. Check for missed IP addresses, usernames, paths
3. Use `grep -v` to filter if needed

```bash
# Verify redaction
_redact_sensitive < /home/user/dev-deploy.log | grep -i "192\|/home/[^[]"
# Should return nothing
```

---

## What Each Redaction Pattern Catches

| Pattern | Regex | Example → Redacted |
|---------|-------|-------------------|
| IP addresses | `([0-9]{1,3}\.){3}[0-9]{1,3}` | `192.168.1.1` → `[REDACTED_IP]` |
| Home paths | `/home/[user]` | `/home/modnar3/Project` → `/home/[USER]/Project` |
| Root home | `/root` | `/root/scripts` → `/home/[USER]/scripts` |
| Full URLs | `https?://\[REDACTED_IP\]:\d+` | `https://[REDACTED_IP]:3001` → `[REDACTED_URL]` |
| Container names | `myportfoliosite-dev-*` | `myportfoliosite-dev-backend-1` → `[REDACTED_CONTAINER]` |
| Service names | `(backend\|nginx\|postgres)-(dev\|prod\|local)` | `backend-dev` → `[REDACTED_SERVICE]` |
| Project paths | `/home/.*/MyPortfolioSite(-dev)?` | `/home/user/MyPortfolioSite-dev` → `/home/[USER]/[REDACTED_PROJECT]` |

---

## Checklist: Before Sharing Logs

- [ ] All IP addresses redacted (check for `[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}`)
- [ ] All usernames redacted (no `/home/[a-z]` that isn't `[USER]`)
- [ ] All hostnames redacted (no unredacted machine names)
- [ ] All container names redacted (no `myportfoliosite-*`)
- [ ] All service names redacted (no bare `backend-dev`, `nginx-dev`)
- [ ] No secrets in commit messages (API keys, tokens, passwords)
- [ ] No `.env` contents or sensitive env var values
- [ ] Project paths use `[REDACTED_PROJECT]` placeholder

---

## Related Issues

- #231 — Standardize docker-compose and nginx templates (to reduce manual redaction needs)
- #152 — Structured logging (will improve redaction and audit trails in future)
