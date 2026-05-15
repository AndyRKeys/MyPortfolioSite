#!/usr/bin/env bash
# Generate self-signed certificate for dev server HTTPS.
#
# WebAuthn requires a domain name as the RP ID — IP addresses are rejected by
# the spec. The cert therefore covers a hostname (used for WebAuthn) as well as
# the LAN IP (used for IP-based health checks) and localhost (container-internal).
#
# Usage: bash scripts/setup/generate-dev-certs.sh [LAN_IP] [WEBAUTHN_HOST]
# Example: bash scripts/setup/generate-dev-certs.sh 192.168.68.81 dev.andykeys.me

set -euo pipefail

LAN_IP="${1:-192.168.68.81}"
WEBAUTHN_HOST="${2:-}"
CERT_DIR="scripts/config/certs"
CERT_KEY="${CERT_DIR}/dev-server.key"
CERT_CRT="${CERT_DIR}/dev-server.crt"

# The certificate CN and the primary SAN must be the hostname WebAuthn uses.
# Fall back to the IP only if no hostname is supplied (cert will still be
# generated, but WebAuthn will not work over an IP — see docs/SECURITY.md).
if [ -n "$WEBAUTHN_HOST" ]; then
    CERT_CN="$WEBAUTHN_HOST"
    SAN="DNS:${WEBAUTHN_HOST},IP:${LAN_IP},DNS:localhost"
else
    CERT_CN="$LAN_IP"
    SAN="IP:${LAN_IP},DNS:localhost"
fi

# Create cert directory if it doesn't exist
mkdir -p "$CERT_DIR"

# Idempotency: only regenerate if the cert doesn't already cover the values we
# need. Check both the hostname (if any) and the IP appear in the SAN list.
if [ -f "$CERT_CRT" ]; then
    EXISTING_SAN=$(openssl x509 -in "$CERT_CRT" -noout -text 2>/dev/null \
        | grep -A1 "Subject Alternative Name" | tail -1 || echo "")
    needs_regen=false
    if [ -n "$WEBAUTHN_HOST" ] && ! echo "$EXISTING_SAN" | grep -q "DNS:${WEBAUTHN_HOST}\b"; then
        needs_regen=true
    fi
    if ! echo "$EXISTING_SAN" | grep -q "IP Address:${LAN_IP}\b"; then
        needs_regen=true
    fi
    if [ "$needs_regen" = false ]; then
        echo "✓ Certificate already covers ${CERT_CN} (${SAN})"
        exit 0
    fi
    echo "Regenerating certificate — existing SAN: ${EXISTING_SAN:-<none>}"
    rm -f "$CERT_KEY" "$CERT_CRT"
fi

echo "Generating self-signed certificate for CN=${CERT_CN} (SAN: ${SAN})..."

openssl req -x509 \
    -newkey rsa:2048 \
    -keyout "$CERT_KEY" \
    -out "$CERT_CRT" \
    -days 3650 \
    -nodes \
    -subj "/C=US/ST=State/L=City/O=Dev/CN=${CERT_CN}" \
    -addext "subjectAltName=${SAN}"

echo "✓ Certificate generated:"
echo "  Key:  $CERT_KEY"
echo "  Cert: $CERT_CRT"
echo ""
echo "Certificate details:"
openssl x509 -in "$CERT_CRT" -noout -text | grep -A 1 "Subject:\|Not Before\|Not After\|Subject Alternative Name"
