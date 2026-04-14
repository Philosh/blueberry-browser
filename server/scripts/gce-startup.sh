#!/bin/bash
set -euo pipefail

# Startup script for GCE instances running the Blueberry exec server.
# This is intentionally self-contained (no repo changes required on the VM).

USER_NAME="SaugatPersonal"
APP_DIR="/home/${USER_NAME}/blueberry-browser/server"
ENV_FILE="/etc/blueberry-exec.env"
SERVICE_FILE="/etc/systemd/system/blueberry-exec.service"

if [ ! -d "$APP_DIR" ]; then
  echo "[startup] app dir not found: $APP_DIR"
  exit 0
fi

# Create an env file if it doesn't exist (safe defaults).
if [ ! -f "$ENV_FILE" ]; then
  cat >"$ENV_FILE" <<'EOF'
PORT=3000
HOST=0.0.0.0
TRUST_PROXY=1
MAX_CONCURRENT_VMS=2
RATE_LIMIT_MAX=30
RATE_LIMIT_WINDOW_MS=60000
EOF
  chmod 0644 "$ENV_FILE"
fi

# Create a systemd service to keep the server running.
cat >"$SERVICE_FILE" <<EOF
[Unit]
Description=Blueberry exec server (Firecracker)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/node ${APP_DIR}/dist/index.js
Restart=always
RestartSec=2

# If Firecracker needs these groups, run as the user that has them.
User=${USER_NAME}
Group=${USER_NAME}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable blueberry-exec.service
systemctl restart blueberry-exec.service

echo "[startup] blueberry-exec.service active:"
systemctl --no-pager status blueberry-exec.service || true

