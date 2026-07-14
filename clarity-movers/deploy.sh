#!/usr/bin/env bash
# End-to-end deploy for a fresh Debian/Ubuntu VM.
# Usage: GEMINI_API_KEY=xxxx ./deploy.sh
set -euo pipefail

REPO_URL="https://github.com/juliushill42/Clarity-movers.git"
APP_DIR="$HOME/Clarity-movers/clarity-movers"

if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "GEMINI_API_KEY not set — chat-service will fall back to ai-bridge (local model) only."
fi

# 1. Install Docker + compose plugin if missing
if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker..."
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi

# 2. Clone or update repo
if [ -d "$APP_DIR/.git" ]; then
  echo "Updating existing checkout..."
  cd "$APP_DIR" && git pull
else
  echo "Cloning repo..."
  mkdir -p "$(dirname "$APP_DIR")"
  git clone "$REPO_URL" "$(dirname "$APP_DIR")"
  cd "$APP_DIR"
fi

# 3. Write .env for docker compose
cat > "$APP_DIR/.env" <<EOF
GEMINI_API_KEY=${GEMINI_API_KEY:-}
EOF

# 4. Place a GGUF model if you have one staged at ~/model.gguf
if [ -f "$HOME/model.gguf" ]; then
  cp "$HOME/model.gguf" "$APP_DIR/ai-bridge/models/model.gguf"
  echo "Copied local GGUF model into ai-bridge/models/model.gguf"
else
  echo "No ~/model.gguf found — ai-bridge will report 'model not loaded' until one is placed at $APP_DIR/ai-bridge/models/model.gguf"
fi

# 5. Build and boot the full stack
cd "$APP_DIR"
sudo docker compose up --build -d

# 6. Health checks
echo "Waiting for services to come up..."
sleep 8
for svc in \
  "gateway:4000/health" \
  "chat-service:4004/health" \
  "ai-bridge:8000/health"; do
  name="${svc%%:*}"
  path="${svc#*:}"
  if curl -fsS "http://localhost:${path}" >/dev/null 2>&1; then
    echo "OK   $name"
  else
    echo "FAIL $name (check: sudo docker compose logs $name)"
  fi
done

VM_IP="$(curl -s ifconfig.me 2>/dev/null || echo YOUR_VM_IP)"
echo "Deploy complete. Frontend: http://${VM_IP}:4000"
