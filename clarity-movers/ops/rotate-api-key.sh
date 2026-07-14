#!/usr/bin/env bash
# Rotate the API key for one tenant. Regenerates the key, rewrites .env's
# CLARITY_API_KEYS entry for that tenant, updates the hardcoded frontend
# consts, and rebuilds/restarts just the gateway container.
#
# Usage: ./rotate-api-key.sh <tenant_id>
#   e.g. ./rotate-api-key.sh 00000000-0000-0000-0000-000000000001
set -euo pipefail

TENANT_ID="${1:?Usage: ./rotate-api-key.sh <tenant_id>}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$APP_DIR/.env"
NEW_KEY="clarity-$(openssl rand -hex 16)"

if [ ! -f "$ENV_FILE" ]; then
  echo "GEMINI_API_KEY=" > "$ENV_FILE"
fi

CURRENT_KEYS="$(grep '^CLARITY_API_KEYS=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)"
if [ -z "$CURRENT_KEYS" ]; then
  CURRENT_KEYS="dev-key-change-me:00000000-0000-0000-0000-000000000001"
fi

# Drop any existing key mapped to this tenant, then add the new one.
UPDATED_KEYS="$(echo "$CURRENT_KEYS" | tr ',' '\n' | grep -v ":${TENANT_ID}\$" | paste -sd, -)"
if [ -n "$UPDATED_KEYS" ]; then
  UPDATED_KEYS="${UPDATED_KEYS},${NEW_KEY}:${TENANT_ID}"
else
  UPDATED_KEYS="${NEW_KEY}:${TENANT_ID}"
fi

if grep -q '^CLARITY_API_KEYS=' "$ENV_FILE" 2>/dev/null; then
  sed -i "s|^CLARITY_API_KEYS=.*|CLARITY_API_KEYS=${UPDATED_KEYS}|" "$ENV_FILE"
else
  echo "CLARITY_API_KEYS=${UPDATED_KEYS}" >> "$ENV_FILE"
fi

# Update the hardcoded frontend key. Only safe for the CLARITY-operated
# tenant (00000000-0000-0000-0000-000000000001) — other tenants embed
# their own key in their own frontend, not this one.
if [ "$TENANT_ID" = "00000000-0000-0000-0000-000000000001" ]; then
  sed -i "s/const API_KEY = '.*';/const API_KEY = '${NEW_KEY}';/" "$APP_DIR/frontend/app.js"
  sed -i "s/const API_KEY = '.*';/const API_KEY = '${NEW_KEY}';/" "$APP_DIR/frontend/chat.js"
fi

echo "New key for tenant ${TENANT_ID}: ${NEW_KEY}"
echo "Redeploying gateway..."
cd "$APP_DIR"
sudo docker compose up -d --build gateway

echo "Done. Old key for this tenant is now invalid."
