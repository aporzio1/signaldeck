#!/usr/bin/env bash
# SignalDeck installer — Raspberry Pi OS / Debian.
# Installs Node, rtl-sdr, gpsd, the Python mesh bridges and a systemd service.
set -euo pipefail

APP_DIR="${SIGNALDECK_DIR:-/opt/signaldeck}"
PORT="${SIGNALDECK_PORT:-8080}"
WITH_TLS=0
SKIP_APT=0
WITH_MESHCORE=1
OPENHOP_SVC_USER=""
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Usage: sudo ./install.sh [options]

  --dir PATH     Install directory (default /opt/signaldeck)
  --port PORT    HTTP port (default 8080)
  --tls          Generate a self-signed certificate and serve HTTPS
  --skip-apt     Do not run apt-get (packages already installed)
  --without-meshcore
                 Do not install openHop Repeater (native MeshCore on the HAT)
  -h, --help     Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) APP_DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --tls) WITH_TLS=1; shift ;;
    --skip-apt) SKIP_APT=1; shift ;;
    --without-meshcore) WITH_MESHCORE=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "SignalDeck needs root to install packages and the systemd unit."
  exec sudo -E bash "$0" "$@"
fi

SERVICE_USER="${SUDO_USER:-$(logname 2>/dev/null || echo pi)}"
if [ "$SERVICE_USER" = "root" ]; then
  SERVICE_USER="pi"
fi
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "Cannot determine the desktop user; pass it via SUDO_USER."
  exit 1
fi

echo "==> SignalDeck installer"
echo "    install dir : $APP_DIR"
echo "    service user: $SERVICE_USER"
echo "    port        : $PORT"

if [ -r /etc/os-release ]; then
  . /etc/os-release
  echo "    system      : ${PRETTY_NAME:-unknown}"
fi

if [ "$SKIP_APT" = "0" ]; then
  echo "==> Installing system packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y --no-install-recommends \
    ca-certificates curl git gnupg \
    librtlsdr0 rtl-sdr \
    gpsd gpsd-clients \
    python3 python3-venv python3-pip \
    i2c-tools \
    alsa-utils \
    avahi-daemon \
    openssl
fi

NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$NODE_MAJOR" -ge 20 ]; then NODE_OK=1; fi
fi
if [ "$NODE_OK" = "0" ]; then
  echo "==> Installing Node.js 22 LTS"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "    node $(node -v), npm $(npm -v)"

echo "==> Copying application to $APP_DIR"
mkdir -p "$APP_DIR"
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  tar -C "$SRC_DIR" \
    --exclude='./.git' --exclude='./node_modules' --exclude='./data' \
    --exclude='./web/node_modules' --exclude='./web/dist' \
    -cf - . | tar -C "$APP_DIR" -xf -
fi
mkdir -p "$APP_DIR/data"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR"

echo "==> Installing backend dependencies"
cd "$APP_DIR/server"
sudo -u "$SERVICE_USER" npm ci --omit=dev --no-audit --no-fund

echo "==> Building the web console (this can take a minute on a Pi 4)"
cd "$APP_DIR/web"
sudo -u "$SERVICE_USER" npm ci --no-audit --no-fund
sudo -u "$SERVICE_USER" npm run build

echo "==> Creating the Python bridge environment"
if [ ! -x "$APP_DIR/venv/bin/python" ]; then
  sudo -u "$SERVICE_USER" python3 -m venv "$APP_DIR/venv"
fi
sudo -u "$SERVICE_USER" "$APP_DIR/venv/bin/pip" install --quiet --upgrade pip
sudo -u "$SERVICE_USER" "$APP_DIR/venv/bin/pip" install --quiet \
  meshtastic meshcore pyserial || echo "!! Mesh bridge packages failed to install; radio pages will show a setup hint."

if [ "$WITH_MESHCORE" = "1" ]; then
  echo "==> Installing the native MeshCore stack (openHop Repeater)"
  if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; then
    echo "!! openHop needs Python 3.10+; skipping. MeshCore still works with an external companion."
  else
    apt-get install -y --no-install-recommends python3-dev libgpiod2 >/dev/null 2>&1 || true
    if [ -d /opt/openhop_repeater/.git ]; then
      git -C /opt/openhop_repeater pull --ff-only >/dev/null 2>&1 || true
    else
      rm -rf /opt/openhop_repeater
      git clone --depth 1 https://github.com/openhop-dev/openhop_repeater.git /opt/openhop_repeater || \
        echo "!! Could not clone openHop Repeater; MeshCore native mode stays unavailable."
    fi
    if [ -f /opt/openhop_repeater/manage.sh ]; then
      # The installer is non-interactive in current releases. If it asks
      # anything, EOF lets it keep its defaults; SignalDeck writes config next.
      ( cd /opt/openhop_repeater && timeout 900 bash ./manage.sh install </dev/null ) || \
        echo "!! openHop install did not finish; check its output and re-run install.sh."
      OPENHOP_USER="$(systemctl show -p User --value openhop-repeater 2>/dev/null || true)"
      OPENHOP_USER="${OPENHOP_USER:-root}"
      OPENHOP_SVC_USER="$OPENHOP_USER"
      install -d -m 0755 /etc/openhop_repeater
      install -d -m 0700 -o "$OPENHOP_USER" -g "$OPENHOP_USER" /var/lib/openhop_repeater 2>/dev/null || \
        install -d -m 0700 /var/lib/openhop_repeater
      # SignalDeck owns radio handover, so leave the repeater stopped until
      # MeshCore is selected in the console.
      systemctl stop openhop-repeater >/dev/null 2>&1 || true
      systemctl enable openhop-repeater >/dev/null 2>&1 || true
      echo "    openHop installed; config is written by SignalDeck on first handover"
    fi
  fi
fi

echo "==> Adding $SERVICE_USER to hardware groups"
for group in gpio spi i2c dialout plugdev audio video; do
  getent group "$group" >/dev/null && usermod -aG "$group" "$SERVICE_USER" || true
done

TLS_CERT=""
TLS_KEY=""
if [ "$WITH_TLS" = "1" ]; then
  echo "==> Generating a self-signed certificate"
  TLS_CERT="$APP_DIR/data/tls.crt"
  TLS_KEY="$APP_DIR/data/tls.key"
  HOSTNAME_NOW="$(hostname)"
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
    -keyout "$TLS_KEY" -out "$TLS_CERT" \
    -subj "/CN=$HOSTNAME_NOW" \
    -addext "subjectAltName=DNS:$HOSTNAME_NOW,DNS:$HOSTNAME_NOW.local,IP:127.0.0.1" >/dev/null 2>&1
  chown "$SERVICE_USER":"$SERVICE_USER" "$TLS_CERT" "$TLS_KEY"
  chmod 600 "$TLS_KEY"
fi

echo "==> Writing service configuration"
node - "$APP_DIR" "$PORT" "$TLS_CERT" "$TLS_KEY" "$SERVICE_USER" <<'NODE'
const fs = require('fs');
const path = require('path');
const [, , dir, port, cert, key] = process.argv;
const file = path.join(dir, 'data', 'settings.json');
let settings = {};
try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
settings.server = {
  ...(settings.server || {}),
  port: Number(port) || 8080,
  host: '0.0.0.0',
  tlsCert: cert || '',
  tlsKey: key || '',
};
settings.stationName = settings.stationName || 'SignalDeck';
fs.writeFileSync(file, JSON.stringify(settings, null, 2), { mode: 0o600 });
NODE
chown "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR/data/settings.json"

echo "==> Installing the systemd unit"
sed "s/__USER__/$SERVICE_USER/g" "$APP_DIR/deploy/signaldeck.service" > /etc/systemd/system/signaldeck.service
systemctl daemon-reload
systemctl enable signaldeck >/dev/null
systemctl restart signaldeck

echo "==> Installing limited sudo rules (clock, services, power, config)"
SUDO_FILE=/etc/sudoers.d/signaldeck
cat > "$SUDO_FILE" <<EOF
# SignalDeck: narrow privilege escalation for clock, service and config actions.
$SERVICE_USER ALL=(root) NOPASSWD: /usr/sbin/hwclock *, /sbin/hwclock *
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart meshtasticd, /usr/bin/systemctl start meshtasticd, /usr/bin/systemctl stop meshtasticd
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart openhop-repeater, /usr/bin/systemctl start openhop-repeater, /usr/bin/systemctl stop openhop-repeater, /usr/bin/systemctl enable openhop-repeater
$SERVICE_USER ALL=(root) NOPASSWD: /bin/systemctl restart openhop-repeater, /bin/systemctl start openhop-repeater, /bin/systemctl stop openhop-repeater, /bin/systemctl enable openhop-repeater
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/systemctl reboot, /usr/bin/systemctl poweroff, /bin/systemctl reboot, /bin/systemctl poweroff
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/timedatectl set-ntp true
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/mkdir -p /etc/meshtasticd
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/test -f /etc/meshtasticd/config.yaml
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/cp /tmp/signaldeck-* /etc/meshtasticd/config.yaml
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/cp /etc/meshtasticd/config.yaml /etc/meshtasticd/config.yaml.signaldeck-*
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/cp /tmp/signaldeck-* /boot/firmware/config.txt
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/cp /boot/firmware/config.txt /boot/firmware/config.txt.signaldeck-*
$SERVICE_USER ALL=(root) NOPASSWD: /bin/cp /tmp/signaldeck-* /etc/meshtasticd/config.yaml
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/mkdir -p /etc/openhop_repeater
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/test -f /etc/openhop_repeater/config.yaml
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/test -f /etc/openhop_repeater/identity.key
$SERVICE_USER ALL=(root) NOPASSWD: /bin/test -f /etc/openhop_repeater/config.yaml
$SERVICE_USER ALL=(root) NOPASSWD: /bin/test -f /etc/openhop_repeater/identity.key
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/cp /tmp/signaldeck-* /etc/openhop_repeater/config.yaml
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/cp /etc/openhop_repeater/config.yaml /etc/openhop_repeater/config.yaml.signaldeck-*
$SERVICE_USER ALL=(root) NOPASSWD: /bin/cp /tmp/signaldeck-* /etc/openhop_repeater/config.yaml
$SERVICE_USER ALL=(root) NOPASSWD: /bin/cp /etc/openhop_repeater/config.yaml /etc/openhop_repeater/config.yaml.signaldeck-*
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/cat /etc/openhop_repeater/config.yaml
$SERVICE_USER ALL=(root) NOPASSWD: /bin/cat /etc/openhop_repeater/config.yaml
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/chown ${OPENHOP_SVC_USER:-root} /etc/openhop_repeater/config.yaml
$SERVICE_USER ALL=(root) NOPASSWD: /bin/chown ${OPENHOP_SVC_USER:-root} /etc/openhop_repeater/config.yaml
$SERVICE_USER ALL=(root) NOPASSWD: /bin/cp /tmp/signaldeck-* /boot/firmware/config.txt
EOF
chmod 0440 "$SUDO_FILE"
visudo -cf "$SUDO_FILE" >/dev/null

sleep 1
IP_ADDR="$(hostname -I 2>/dev/null | awk '{print $1}')"
PROTO="http"
[ -n "$TLS_CERT" ] && PROTO="https"
echo
echo "=============================================================="
echo " SignalDeck installed."
echo "   Local   : $PROTO://localhost:$PORT"
[ -n "$IP_ADDR" ] && echo "   Network : $PROTO://$IP_ADDR:$PORT"
echo "   Service : systemctl status signaldeck"
echo "   Logs    : journalctl -u signaldeck -f"
echo
echo " Open the web page to create the console password."
echo " Radio setup: System → HAT interfaces, then Settings → Radio wiring."
echo " Mesh stack: Settings → Mesh stack hands the SX1262 between Meshtastic and MeshCore."
echo "=============================================================="
