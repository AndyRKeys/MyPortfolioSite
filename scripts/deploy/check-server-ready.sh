#!/bin/bash

# Pre-deployment server readiness check
# Validates that a server meets all requirements before running server-setup.sh
# Usage: bash check-server-ready.sh [domain]
# Example: bash check-server-ready.sh andykeys.me

set +e  # Don't exit on first error — run all checks

DOMAIN="${1:-}"
CHECKS_PASSED=0
CHECKS_FAILED=0
WARNINGS=0

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Helper functions
check_pass() {
    echo -e "${GREEN}✓${NC} $1"
    ((CHECKS_PASSED++))
}

check_fail() {
    echo -e "${RED}✗${NC} $1"
    ((CHECKS_FAILED++))
}

check_warn() {
    echo -e "${YELLOW}⚠${NC} $1"
    ((WARNINGS++))
}

section() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "$1"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

# Validate arguments
if [ -z "$DOMAIN" ]; then
    echo "Usage: bash check-server-ready.sh <domain>"
    echo "Example: bash check-server-ready.sh andykeys.me"
    exit 1
fi

section "1. OS & Basic System Checks"

# Ubuntu version
if [ -f /etc/os-release ]; then
    . /etc/os-release
    if [[ "$ID" == "ubuntu" ]]; then
        check_pass "Ubuntu OS detected: $PRETTY_NAME"
    else
        check_fail "Not Ubuntu: detected $PRETTY_NAME"
    fi
else
    check_fail "Cannot determine OS (no /etc/os-release)"
fi

# Internet connectivity
if ping -c 1 8.8.8.8 >/dev/null 2>&1; then
    check_pass "Internet connectivity working"
else
    check_fail "No internet connectivity"
fi

# Time synchronization
if timedatectl status 2>/dev/null | grep -q "System clock synchronized: yes"; then
    check_pass "System clock is synchronized"
else
    check_warn "System clock may not be synchronized (check: timedatectl status)"
fi

section "2. Disk Space & Storage"

# Disk space (need 10GB free)
AVAILABLE=$(df / | awk 'NR==2 {print $4}')  # In 1K blocks
AVAILABLE_GB=$((AVAILABLE / 1024 / 1024))
REQUIRED_GB=10

if [ "$AVAILABLE_GB" -ge "$REQUIRED_GB" ]; then
    check_pass "Sufficient disk space: ${AVAILABLE_GB}GB available (need ${REQUIRED_GB}GB)"
else
    check_fail "Insufficient disk space: ${AVAILABLE_GB}GB available (need ${REQUIRED_GB}GB)"
fi

section "3. Port Availability"

# Check if ports 80 and 443 are free
for PORT in 80 443; do
    if lsof -i :$PORT >/dev/null 2>&1; then
        PROCESS=$(lsof -i :$PORT | tail -n +2 | awk '{print $1}' | sort -u | tr '\n' ',' | sed 's/,$//')
        check_fail "Port $PORT is in use by: $PROCESS"
    else
        check_pass "Port $PORT is available"
    fi
done

section "4. Conflicting Software"

# Check for web servers
WEB_SERVERS=()
if dpkg -l 2>/dev/null | grep -q apache2; then
    WEB_SERVERS+=("apache2")
fi
if dpkg -l 2>/dev/null | grep -q nginx; then
    WEB_SERVERS+=("nginx")
fi
if dpkg -l 2>/dev/null | grep -q httpd; then
    WEB_SERVERS+=("httpd")
fi

if [ ${#WEB_SERVERS[@]} -eq 0 ]; then
    check_pass "No conflicting web servers installed"
else
    check_fail "Found conflicting web server(s): ${WEB_SERVERS[*]}"
fi

# Check for conflicting snaps
SNAP_CONFLICTS=()
if command -v snap >/dev/null 2>&1; then
    while IFS= read -r snap_name; do
        case "$snap_name" in
            nextcloud|apache|apache2|nginx|httpd)
                SNAP_CONFLICTS+=("$snap_name")
                ;;
        esac
    done < <(snap list 2>/dev/null | tail -n +2 | awk '{print $1}' || true)
fi

if [ ${#SNAP_CONFLICTS[@]} -eq 0 ]; then
    check_pass "No conflicting snaps installed"
else
    check_fail "Found conflicting snap(s): ${SNAP_CONFLICTS[*]}"
fi

section "5. Network & DNS"

# DNS resolution
if nslookup "$DOMAIN" >/dev/null 2>&1; then
    IP=$(nslookup "$DOMAIN" 2>/dev/null | grep -A1 "Name:" | tail -1 | awk '{print $2}')
    check_pass "Domain resolves: $DOMAIN → $IP"
else
    check_fail "Domain does not resolve: $DOMAIN"
fi

# Public IP
PUBLIC_IP=$(curl -s --connect-timeout 3 ifconfig.me 2>/dev/null || echo "unknown")
if [ "$PUBLIC_IP" != "unknown" ]; then
    check_pass "Public IP accessible: $PUBLIC_IP"
else
    check_warn "Could not fetch public IP (firewall may block outbound to ifconfig.me)"
fi

section "6. External Port Accessibility (from Internet)"

# Test if port 80 is accessible from internet
if [ "$PUBLIC_IP" != "unknown" ] && [ "$IP" != "unknown" ]; then
    if [ "$PUBLIC_IP" = "$IP" ] || [ "$IP" = "127.0.0.1" ]; then
        check_warn "Domain IP ($IP) doesn't match public IP ($PUBLIC_IP) — verify router port forwarding"
    else
        check_pass "Domain IP ($IP) matches public IP ($PUBLIC_IP)"
    fi
fi

# Detailed port forwarding test (from external)
EXTERNAL_TEST=$(curl -s --connect-timeout 5 "http://$DOMAIN:80/" >/dev/null 2>&1 && echo "ok" || echo "fail")
if [ "$EXTERNAL_TEST" = "ok" ]; then
    check_pass "Port 80 accessible from internet"
else
    check_warn "Port 80 not accessible from internet (port forwarding not yet configured?)"
fi

section "7. Required Software"

# Check for Docker
if command -v docker >/dev/null 2>&1; then
    DOCKER_VERSION=$(docker --version | awk '{print $3}' | sed 's/,//')
    check_pass "Docker installed: version $DOCKER_VERSION"
else
    check_fail "Docker not installed (will be installed by server-setup.sh)"
fi

# Check for Git
if command -v git >/dev/null 2>&1; then
    GIT_VERSION=$(git --version | awk '{print $3}')
    check_pass "Git installed: version $GIT_VERSION"
else
    check_fail "Git not installed (will be installed by server-setup.sh)"
fi

# Check for curl
if command -v curl >/dev/null 2>&1; then
    check_pass "curl installed"
else
    check_fail "curl not installed (required for deployment)"
fi

section "8. Summary"

TOTAL=$((CHECKS_PASSED + CHECKS_FAILED))
echo ""
echo "Checks passed:  ${GREEN}${CHECKS_PASSED}${NC}"
echo "Checks failed:  ${RED}${CHECKS_FAILED}${NC}"
echo "Warnings:       ${YELLOW}${WARNINGS}${NC}"
echo ""

if [ $CHECKS_FAILED -eq 0 ]; then
    echo -e "${GREEN}✓ Server is ready for deployment${NC}"
    if [ $WARNINGS -gt 0 ]; then
        echo -e "${YELLOW}Note: Review warnings above before proceeding${NC}"
    fi
    echo ""
    echo "Next step: Run server-setup.sh"
    echo "  bash scripts/deploy/server-setup.sh $DOMAIN"
    exit 0
else
    echo -e "${RED}✗ Server is NOT ready for deployment${NC}"
    echo ""
    echo "Fix the failures above, then run this check again:"
    echo "  bash scripts/deploy/check-server-ready.sh $DOMAIN"
    exit 1
fi
