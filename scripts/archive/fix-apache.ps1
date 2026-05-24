# ============================================================
# DEPRECATED — DO NOT USE
# ============================================================
# Pi-era one-off: targets the old `raspberrypi3` SSH alias and
# swaps host Apache→Nginx. Production now runs on Ubuntu Server
# (ak-home-server) with containerised Nginx — there is no host
# Apache/Nginx to fix. Kept for historical reference only.
# See docs/TERMINOLOGY.md and docs/INFRASTRUCTURE.md.
# ============================================================
ssh raspberrypi3 "sudo systemctl stop apache2 && sudo systemctl disable apache2 && sudo systemctl enable nginx && sudo systemctl start nginx && sudo nginx -t && sudo systemctl reload nginx && sudo ss -tlnp | grep :80"
