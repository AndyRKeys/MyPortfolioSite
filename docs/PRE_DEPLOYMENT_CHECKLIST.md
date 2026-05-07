# Pre-Deployment Checklist

Complete this checklist **before** running `server-setup.sh`. Each section must pass before proceeding to the next.

---

## 1. Network & Router Configuration

### Domain Setup
- [ ] Domain registered and you have access to DNS settings
- [ ] **DDNS provider configured** (for dynamic IP addresses):
  - [ ] Provider chosen (Namecheap, No-IP, DuckDNS, etc.)
  - [ ] DDNS credentials obtained from provider
  - [ ] DDNS client installed and configured on server (if not using docker-compose)
  - Example: Namecheap DDNS password saved for server-setup.sh
- [ ] Domain configured to point to your server's public IP
  ```bash
  # Verify: Run this on any machine
  nslookup yourdomain.com
  # Should show your server's public IP address
  ```

### Router Port Forwarding
**This is critical — Let's Encrypt will fail without this!**

- [ ] Log into your router's admin panel (usually http://192.168.1.1 or http://192.168.0.1)
- [ ] Find Port Forwarding settings (usually under "Advanced" or "NAT")
- [ ] Create forwarding rule:
  - **External Port:** 80
  - **Internal Port:** 80
  - **Internal IP:** Your server's local IP (e.g., 192.168.1.50)
  - **Protocol:** TCP
- [ ] Create forwarding rule:
  - **External Port:** 443
  - **Internal Port:** 443
  - **Internal IP:** Your server's local IP
  - **Protocol:** TCP
- [ ] Save and reboot router if prompted

### Verify Port Forwarding Works
Run these commands from a **different machine** (not the server):
```bash
# Test HTTP port
curl --connect-timeout 5 http://yourdomain.com/
# Should eventually time out or show a response (not "connection refused")

# Test DNS + port together
nslookup yourdomain.com  # Should return your public IP
curl -I http://yourdomain.com:80/  # Should connect (even if 404)
```

---

## 2. Server Prerequisites

### Fresh Ubuntu Server
- [ ] Ubuntu Server LTS 22.04 or later
- [ ] **Fresh installation (minimal packages only) — strongly recommended**
  - Avoid reusing servers that had previous hobby projects
  - Pre-installed services can conflict with deployment
- [ ] Root or sudo access
- [ ] Internet connection working
  ```bash
  ping -c 1 8.8.8.8  # Should succeed
  ```

### No Conflicting Software Installed
Run on the server:
```bash
# Check for web servers
dpkg -l | grep -E 'apache2|nginx|httpd'
# Should return NOTHING

# Check for snaps
snap list | grep -E 'nextcloud|apache|nginx'
# Should return NOTHING
```
- [ ] No Apache, Nginx, or Nextcloud installed
- [ ] If found, remove them:
  ```bash
  sudo apt remove apache2 nginx httpd
  sudo snap remove nextcloud
  ```

### Ports Available
Run on the server:
```bash
# Check if ports 80 and 443 are free
sudo lsof -i :80 -i :443
# Should return NOTHING
```
- [ ] Ports 80 and 443 are not in use
- [ ] If in use, identify and stop the service:
  ```bash
  sudo systemctl stop <service-name>
  sudo systemctl disable <service-name>
  ```

### Disk Space
Run on the server:
```bash
df -h /
# Look at "Available" column
```
- [ ] At least 10GB free disk space
- [ ] If less than 5GB, clean up before continuing:
  ```bash
  sudo apt clean
  sudo apt autoremove
  ```

### Time Synchronized
Run on the server:
```bash
timedatectl status
# Should show "System clock synchronized: yes"
```
- [ ] System time is synchronized (critical for SSL certificates)

---

## 3. SSH & Access

### SSH Access
- [ ] Can SSH into server: `ssh user@server-ip`
- [ ] Can run sudo commands without password prompt (ideally)
- [ ] SSH key-based auth working (if using keys)

---

## 4. Passwords & Secrets (Prepare Before Starting)

**⚠️ Have these ready BEFORE starting deployment — the setup script will ask for them:**

### Domain & DDNS
- [ ] **Domain name:** `andykeys.me` (or your domain)
- [ ] **DDNS provider configured** (if using dynamic IP):
  - [ ] Provider chosen and account created (Namecheap, No-IP, DuckDNS, etc.)
  - [ ] DDNS username/domain
  - [ ] DDNS password
  - Keep these safe — server-setup.sh will need them

### Application Secrets
Generate these strong random strings before starting:

- [ ] **Database password** — Generate with:
  ```bash
  openssl rand -base64 32
  ```
  Save as: `DB_PASSWORD=`________________

- [ ] **JWT secret** — Generate with:
  ```bash
  openssl rand -base64 32
  ```
  Save as: `JWT_SECRET=`________________

### Email Configuration (Optional)
Can be configured later if needed:

- [ ] SMTP Host: `smtp-mail.outlook.com` (or your provider)
- [ ] SMTP Port: `587`
- [ ] SMTP Username: your-email@outlook.com
- [ ] SMTP App-Specific Password (not your regular password)
- [ ] Admin Email Address

---

## 5. Docker & Git

### Docker Installation
Run on the server:
```bash
docker --version
# Should show: Docker version X.X.X
```
- [ ] Docker is installed and working
- [ ] If not: the setup script will install it

### Git Access
Run on the server:
```bash
git clone https://github.com/AndyRKeys/MyPortfolioSite.git /tmp/test
# Should succeed
rm -rf /tmp/test
```
- [ ] Can clone the repository
- [ ] GitHub is accessible from server

---

## 6. Final Verification

### Run Pre-Flight Checks
```bash
cd ~/MyPortfolioSite
bash scripts/deploy/server-setup.sh yourdomain.com --check-only
# Should pass all checks
```
- [ ] All pre-flight checks pass
- [ ] No errors or warnings shown

### Backup Current Server State (if migrating)
- [ ] Database backed up (if migrating from old server)
- [ ] Any custom data backed up
- [ ] Have rollback plan if needed

---

## 7. Ready to Deploy!

Once all items are checked:

```bash
cd ~/MyPortfolioSite
bash scripts/deploy/server-setup.sh yourdomain.com
```

**Estimated time:** 15-30 minutes

---

## Troubleshooting Common Issues

### "Port 80/443 Not Accessible"
- [ ] Verify router port forwarding is saved
- [ ] Check router is not blocking those ports
- [ ] Try from a different network (mobile hotspot)
- [ ] Verify public IP hasn't changed

### "Domain Doesn't Resolve"
- [ ] Wait 5-10 minutes for DNS propagation
- [ ] Check DNS settings in your registrar
- [ ] Verify public IP is correct: `curl ifconfig.me`
- [ ] Flush DNS cache: `ipconfig /flushdns` (Windows) or `sudo dscacheutil -flushcache` (Mac)

### "Certbot Fails"
- [ ] **First, identify the root cause:**
  - Port forwarding must be working (test with curl above)
  - Domain must resolve to your IP
  - Ports 80 must be externally accessible
  - Check firewall isn't blocking outbound connections

- [ ] **Fix the root cause, then re-run certbot**
  ```bash
  sudo certbot certonly --standalone -d yourdomain.com
  ```
  Don't manually create SSL files — certbot creates them automatically

- [ ] **Certbot creates these automatically:**
  - `/etc/letsencrypt/live/yourdomain.com/` (certificates)
  - `/etc/letsencrypt/options-ssl-nginx.conf`
  - `/etc/letsencrypt/ssl-dhparams.pem`

- [ ] Only if certbot repeatedly fails: check `/var/log/letsencrypt/letsencrypt.log` for details

### "Docker Permission Denied"
- [ ] User must be in docker group: `groups $USER`
- [ ] If not: `sudo usermod -aG docker $USER`
- [ ] **Logout/login or reboot** (group membership requires new shell session)
- [ ] If still failing: **Do a full system reboot**
  ```bash
  sudo reboot
  ```
  This is faster than trying incremental Docker daemon restarts

### "Database Connection Failed"
- [ ] Wait 30 seconds for postgres to initialize
- [ ] Check Docker is running: `docker ps`
- [ ] Check logs: `docker compose logs postgres`

---

## Notes

- **All checks must pass** before running setup
- **Port forwarding is non-negotiable** — Let's Encrypt validation will fail without it
- **Save your passwords somewhere safe** — you'll need them after setup
- **Setup script is idempotent** — safe to run multiple times if it fails
- **Total deployment time** — 30-45 minutes for experienced users, up to 1 hour first time

---

## Checklist Completion

**Date:** _______________  
**Server IP:** _______________  
**Domain:** _______________  
**Completed by:** _______________  

All items checked? → Ready to run `server-setup.sh`

✅ **Proceed to deployment**
