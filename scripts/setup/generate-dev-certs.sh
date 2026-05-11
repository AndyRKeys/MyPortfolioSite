#!/usr/bin/env bash
# Generate self-signed certificate for dev server HTTPS.
# Usage: bash scripts/setup/generate-dev-certs.sh [LAN_IP]
# Example: bash scripts/setup/generate-dev-certs.sh 192.168.68.81

set -euo pipefail

LAN_IP="${1:-192.168.68.81}"
CERT_DIR="scripts/config/certs"
CERT_KEY="${CERT_DIR}/dev-server.key"
CERT_CRT="${CERT_DIR}/dev-server.crt"

# Create cert directory if it doesn't exist
mkdir -p "$CERT_DIR"

# Check if cert already exists for this IP
if [ -f "$CERT_CRT" ]; then
    EXISTING_IP=$(openssl x509 -in "$CERT_CRT" -noout -text 2>/dev/null | grep -oP "DNS:\K[^,)]+" | head -1 || echo "")
    if [ "$EXISTING_IP" = "$LAN_IP" ]; then
        echo "✓ Certificate already exists for $LAN_IP"
        exit 0
    else
        echo "Regenerating certificate for new IP: $LAN_IP (was: $EXISTING_IP)"
        rm -f "$CERT_KEY" "$CERT_CRT"
    fi
fi

echo "Generating self-signed certificate for $LAN_IP..."

openssl req -x509 \
    -newkey rsa:2048 \
    -keyout "$CERT_KEY" \
    -out "$CERT_CRT" \
    -days 3650 \
    -nodes \
    -subj "/C=US/ST=State/L=City/O=Dev/CN=$LAN_IP" \
    -addext "subjectAltName=IP:$LAN_IP,DNS:localhost"

echo "✓ Certificate generated:"
echo "  Key:  $CERT_KEY"
echo "  Cert: $CERT_CRT"
echo ""
echo "Certificate details:"
openssl x509 -in "$CERT_CRT" -noout -text | grep -A 1 "Subject:\|Not Before\|Not After\|Subject Alternative Name"
