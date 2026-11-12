#!/usr/bin/env bash
# Remove SignalDeck. Data (settings, track, messages) is kept unless --purge is passed.
set -euo pipefail

APP_DIR="${SIGNALDECK_DIR:-/opt/signaldeck}"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

if [ "$(id -u)" -ne 0 ]; then
  exec sudo -E bash "$0" "$@"
fi

echo "==> Stopping SignalDeck"
systemctl disable --now signaldeck 2>/dev/null || true
rm -f /etc/systemd/system/signaldeck.service
systemctl daemon-reload

echo "==> Removing sudo rules"
rm -f /etc/sudoers.d/signaldeck

if [ "$PURGE" = "1" ]; then
  echo "==> Deleting $APP_DIR (including settings and logs)"
  rm -rf "$APP_DIR"
else
  echo "==> Keeping $APP_DIR/data (use --purge to delete it)"
fi

echo "Done. rtl-sdr, gpsd and meshtasticd packages were left installed."
