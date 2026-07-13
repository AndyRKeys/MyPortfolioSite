# Design: Full OS Migration to 1 TB SSD

**Date:** 2026-07-12  
**Status:** Approved  
**Author:** Andy Keys + Claude

---

## Context

`ak-home-server` (old gaming PC, Ubuntu Server 24.04) currently boots from a 37.3 GB encrypted SSD (`sda`) that is 93% full (31 GB used, 2.6 GB free). A 1 TB SSD (`sdb`) has been installed and has a single unformatted partition.

Goal: migrate the entire OS to `sdb` with full LUKS encryption, giving the server ~929 GB of usable space.

---

## Strategy

Both SSDs remain installed throughout the migration. A fresh Ubuntu Server install goes onto `sdb`; once the new OS is running, `sda` is decrypted and mounted from within the new system to rsync data across. `sda` stays intact as a cold fallback until everything on `sdb` is verified working.

No clone/resize approach — fresh install gives a clean 1 TB LVM layout from the start and avoids resizing an encrypted volume.

---

## New Disk Layout (`sdb`, 1 TB)

| Partition | Size | Role |
|-----------|------|------|
| `sdb1` | 1 MB | BIOS boot (or EFI if UEFI motherboard) |
| `sdb2` | 2 GB | `/boot` — ext4, unencrypted |
| `sdb3` | ~929 GB | LUKS-encrypted → LVM → `ubuntu-vg/ubuntu-lv` (ext4, `/`) |

Mirrors the current `sda` structure; the Ubuntu Server installer handles this via its "custom storage" option.

---

## Migration Inventory

### Migrated via rsync (Phase 4, from mounted `sda`)

| What | Source path | Notes |
|------|-------------|-------|
| Production site | `~/MyPortfolioSite/` | Includes `.env` (never committed) |
| Dev site | `~/MyPortfolioSite-dev/` | Includes `.env` |
| Backups | `~/backups/` | DB dumps + upload archives |
| SSL certs | `/etc/letsencrypt/` | Avoids re-issuance and rate limits |
| Docker volumes | `/var/lib/docker/volumes/` | Postgres data for prod + dev; Ollama models |

Docker volumes must be migrated with both Compose stacks **stopped** and the Docker daemon **stopped**. Copying a live Postgres volume corrupts data.

### Reinstalled fresh on `sdb` (not migrated)

- Docker CE (apt, not snap) — existing `server-setup.sh` covers this
- UFW rules — small, re-applied from migration manifest
- Dropbear + initramfs — must be configured fresh for the new LUKS volume
- Glances systemd service — `setup-glances-monitoring.sh` re-runs it
- Docker images — pulled fresh on first deploy; no value in carrying stale layers
- ddclient (DDNS) — reinstalled and reconfigured from manifest

---

## Phase 1 Scripts

Two scripts added to `scripts/ops/`:

### `scripts/ops/migration-capture.sh`

Snapshots current system state to `~/migration-manifest.txt`. Referenced during Phase 3 (OS rebuild) to avoid guesswork.

Captures:
- System info: hostname, username, Ubuntu version, kernel
- UFW rules (numbered export)
- Root crontab + user crontab
- Docker version + `/etc/docker/daemon.json` (if present)
- Enabled systemd services (filtered: glances, ddclient, dropbear, cron)
- Dropbear config (`/etc/dropbear-initramfs/config` if present)
- Ollama container: reconstructed `docker run` command from `docker inspect`
- Installed apt packages filtered to: docker-ce, ddclient, glances, certbot, rclone, micro

Output: `~/migration-manifest.txt`

### `scripts/ops/migration-backup.sh`

Takes a fresh snapshot of everything that must survive the migration.

- Calls existing `db-backup.sh` for the prod DB
- Separately dumps the dev DB (`portfolio_dev`) to `~/backups/dev-YYYYMMDD-HHmmss.sql.gz`
- Archives `/etc/letsencrypt/` to `~/backups/letsencrypt-YYYYMMDD.tar.gz`
- Prints a summary of what was captured and file sizes

The rsync of project dirs and Docker volumes happens in Phase 4 (not here) — those are live data that must not be touched until both Compose stacks are stopped.

---

## Migration Phases

### Phase 1 — Pre-migration prep (~30 min, current system)

1. Run `migration-capture.sh` → `~/migration-manifest.txt`
2. Run `migration-backup.sh` → fresh DB dumps + SSL cert archive in `~/backups/`
3. Verify `~/backups/` contents look correct
4. Download Ubuntu Server 24.04 LTS ISO; write to USB (`dd` or Rufus)
5. Note the new LUKS passphrase in your password manager before starting Phase 2

### Phase 2 — Fresh Ubuntu install on `sdb` (~20 min, physical access)

1. Plug in monitor + keyboard
2. Set BIOS/UEFI boot order: USB first
3. Boot USB installer → Ubuntu Server 24.04 LTS
4. Custom storage layout on `sdb` (see disk layout above)
5. LUKS passphrase: new one, stored in password manager
6. Hostname: `ak-home-server`, username: `modnar3`
7. Complete install; set BIOS to boot `sdb` going forward
8. `sda` is untouched

### Phase 3 — Rebuild OS baseline on `sdb` (~30 min, remote SSH)

Using `~/migration-manifest.txt` as reference:

1. Install Docker CE via apt (`server-setup.sh` or manual steps from manifest)
2. Apply UFW rules from manifest
3. Configure Dropbear + update-initramfs for remote LUKS unlock on new volume
4. Install and enable Glances systemd service (`setup-glances-monitoring.sh`)
5. Install ddclient; restore config from manifest
6. Install rclone, certbot, micro as needed
7. Restore root crontab from manifest

### Phase 4 — Data migration (~60 min)

1. Decrypt and mount `sda` from within the new OS:
   ```bash
   sudo cryptsetup open /dev/sda3 old_crypt
   sudo vgscan
   # Both disks share the VG name "ubuntu-vg" — rename the old one first to avoid collision
   sudo vgrename $(sudo pvs --noheadings -o vg_name /dev/mapper/old_crypt | tr -d ' ') old-ubuntu-vg
   sudo vgchange -ay old-ubuntu-vg
   sudo mkdir -p /mnt/old
   sudo mount /dev/old-ubuntu-vg/ubuntu-lv /mnt/old
   ```
2. Stop Docker daemon: `sudo systemctl stop docker`
4. rsync project dirs:
   ```bash
   sudo rsync -av /mnt/old/home/modnar3/MyPortfolioSite/ ~/MyPortfolioSite/
   sudo rsync -av /mnt/old/home/modnar3/MyPortfolioSite-dev/ ~/MyPortfolioSite-dev/
   sudo rsync -av /mnt/old/home/modnar3/backups/ ~/backups/
   ```
5. rsync SSL certs:
   ```bash
   sudo rsync -av /mnt/old/etc/letsencrypt/ /etc/letsencrypt/
   ```
6. rsync Docker volumes:
   ```bash
   sudo rsync -av /mnt/old/var/lib/docker/volumes/ /var/lib/docker/volumes/
   ```
7. Start Docker daemon: `sudo systemctl start docker`
8. Start prod Compose stack; verify health
9. Start dev Compose stack; verify health
10. Unmount `sda`:
    ```bash
    sudo umount /mnt/old
    sudo vgchange -an old-ubuntu-vg
    sudo cryptsetup close old_crypt
    ```

### Phase 5 — Verify and decommission `sda` (ongoing)

1. Confirm site is live at `andykeys.me`
2. Test Dropbear remote unlock (reboot + reconnect on port 2222)
3. Confirm dev environment accessible on LAN port 3001
4. Confirm SSL cert is valid
5. Trigger a manual backup run; verify `~/backups/` output
6. Leave `sda` installed but unused for 2–4 weeks as cold fallback
7. When confident: wipe `sda` and repurpose or remove

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| New LUKS passphrase forgotten | Save in password manager before starting Phase 2 |
| Dropbear not configured → locked out after reboot | Test Dropbear unlock before ending Phase 3 session |
| Postgres volume corruption | Stop Docker daemon before rsync; never copy live volumes |
| LVM name collision (two `ubuntu-vg` volumes) | Phase 4 step 1 renames old VG to `old-ubuntu-vg` before activating it |
| SSL cert rate limit if re-issuing | rsync `/etc/letsencrypt/` directly — no re-issue needed |
| DDNS gap during migration | ddclient re-installed in Phase 3; minimal gap while DNS still points to same IP |

---

## Post-migration findings (discovered during actual Phase 4 execution)

- **Root LV sizing:** the Ubuntu installer's custom storage layout allocated only ~98 GB to `ubuntu-vg/ubuntu-lv`, leaving ~830 GB unallocated in the VG rather than using the full 929 GB. Not caught by this design doc. `migration-restore.sh` section 1 extends the LV with `lvextend -l +100%FREE` + `resize2fs` — run this before starting any Compose stacks.
- **GPU driver not covered:** this doc's "reinstalled fresh on `sdb`" list omitted the NVIDIA driver + `nvidia-container-toolkit` needed for Ollama's `--gpus all`. These require an interactive, hardware-specific install (driver version, secure boot MOK enrollment) and are not scripted; `migration-restore.sh` starts Ollama CPU-only as a fallback and flags the driver install as a manual follow-up. See `docs/INFRASTRUCTURE.md` for the confirmed driver version (535.309.01) for the GTX 970.
- **Dead root crontab entry:** the captured manifest showed a root crontab line using `~/MyPortfolioSite/...`, which resolves to `/root/MyPortfolioSite` under root's own crontab — a path that never existed. This entry was already non-functional on the old system; the real daily backup ran from the deploy user's own crontab (absolute path). `migration-restore.sh` restores only the working entry. `docs/INFRASTRUCTURE.md`'s backup section has been corrected to match.

## Files Changed

- `scripts/ops/migration-capture.sh` — new
- `scripts/ops/migration-backup.sh` — new
- `scripts/ops/migration-restore.sh` — new; scripted Phase 3/4 completion (LV extend, Docker CE, UFW, Dropbear, Glances, ddclient, crontabs, SSL cert + Docker volume rsync, Compose stack startup)
- `docs/INFRASTRUCTURE.md` — documented the new disk layout, migration scripts, and corrected the backup cron entry
