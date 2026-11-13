# SignalDeck

A self-hosted web console for the **HackerGadgets RTL-SDR / LoRa / GPS / RTC HAT** on a Raspberry Pi. Install it on top of Raspberry Pi OS (or any Debian-based Pi OS) and control every function of the HAT from a phone or desktop browser — no separate app, no desktop session, no VNC.

```
┌───────────────────────────── Raspberry Pi ─────────────────────────────┐
│  rtl_tcp ──► IQ over WebSocket ─┐                                     │
│  gpsd  ────► TPV / SKY JSON ────┤                                     │
│  meshtasticd ◄─► Python bridge ─┤──► SignalDeck (Node) ──► browser   │
│  openHop Repeater ◄── bridge ───┤      REST + WebSocket               │
│  RTC / services / config.txt ───┘                                     │
└────────────────────────────────────────────────────────────────────────┘
```

## What it does

| Page | Capabilities |
| --- | --- |
| **Dashboard** | Live health of every subsystem, alerts, service state, quick actions |
| **SDR** | Spectrum + waterfall, click/drag tuning, AM / NFM / WFM / USB / LSB demodulation, squelch, gain, PPM correction, bias tee, HF direct sampling, channel scanner, presets, WAV recording |
| **Meshtastic** | Connect to meshtasticd, channels and messages, node list with distance, region/preset/power/role configuration, position request, traceroute, reboot |
| **MeshCore** | Standalone on the HAT's SX1262 via openHop Repeater, or an external companion over TCP/serial; contacts, channels, direct and channel messaging, adverts, battery, preset setup |
| **GPS** | Fix, position, map, track log with GPX export, sky plot, per-satellite SNR, gpsd or direct NMEA, receiver settings |
| **Time & RTC** | System clock, NTP/chrony status, PCF85063A drift, GNSS time offset, sync RTC ↔ system |
| **System** | Radio ownership and handover, systemd service control, journal logs, boot overlay checks and one-click fix, meshtasticd config generator, GPIO power rails (uConsole AIO), reboot/shutdown |
| **Settings** | Station identity, mesh stack handover, radio pinout, password, API tokens |

The SDR demodulator runs **in the browser** from raw 8-bit IQ: the Pi only runs `rtl_tcp`, so the CPU stays free and audio/waterfall latency is low. Sample rates from 240 kS/s to 2.4 MS/s are available; 1.024 MS/s uses roughly 2 MB/s of network bandwidth.

## Hardware

Published specification for the HAT (from HackerGadgets):

| Function | Chip | Host interface | Defaults used by SignalDeck |
| --- | --- | --- | --- |
| SDR | RTL2832U + R860, TCXO, 5 V bias tee | USB | `rtl_tcp`, device 0 |
| LoRa | Semtech SX1262, 860–960 MHz, 22 dBm, TCXO | SPI, DIO2 RF switch, DIO3 TCXO | `spidev0.0`, IRQ 26, BUSY 24, RESET 25 |
| GNSS | GPS / BeiDou / Galileo, active or passive antenna | UART 9600 8N1 | `/dev/ttyS0` (Pi 4), `/dev/ttyAMA0` (Pi 5) |
| RTC | PCF85063A + backup cell | I2C | `dtoverlay=i2c-rtc,pcf85063a` |

The Pi HAT's per-board pin map is configurable in **Settings → Radio wiring**, because HackerGadgets has not yet published a Pi-HAT-specific setup page (the uConsole AIO values above are the ones they document today). If your board differs, change the SPI device and pins there, then write the generated `meshtasticd` config from **System**.

## Install

Requirements: Raspberry Pi 3/4/5 or Zero 2 W, Raspberry Pi OS Bookworm/Trixie (64-bit recommended), network access, and a user with sudo.

```bash
git clone https://github.com/aporzio1/signaldeck.git
cd signaldeck
sudo ./install.sh
```

The installer:

1. installs `rtl-sdr`, `gpsd`, Python, build prerequisites and Node.js 22 when needed,
2. copies the app to `/opt/signaldeck` and builds the web console,
3. creates a Python virtualenv with `meshtastic` and `meshcore` bridges,
4. installs [openHop Repeater](https://github.com/openhop-dev/openhop_repeater) so MeshCore can drive the HAT's own SX1262 (skip with `--without-meshcore`),
5. adds the service user to `gpio`, `spi`, `i2c`, `dialout`, `plugdev`, `audio`, `video`,
6. installs and starts a hardened `signaldeck.service`,
7. adds a **narrow** sudoers file (`/etc/sudoers.d/signaldeck`) limited to `hwclock`, `systemctl` for `meshtasticd`/`openhop-repeater`/reboot/poweroff, `timedatectl set-ntp`, and config-file copies.

Options:

```bash
sudo ./install.sh --port 8080        # HTTP port
sudo ./install.sh --tls              # self-signed HTTPS on the same port
sudo ./install.sh --dir /srv/signaldeck --skip-apt
sudo ./install.sh --without-meshcore   # companion-only MeshCore, no openHop
```

Then open `http://<pi-ip>:8080` and create the console password. Nothing else is reachable until that password exists.

After installation, complete the hardware setup:

1. **System → HAT interfaces** — add any missing `config.txt` lines (SPI, I2C, RTC overlay, UART), then reboot.
2. **Settings → Radio wiring** — verify the SPI device and pins.
3. **System → meshtasticd config** — write the generated config and restart the daemon.
4. **GPS** — set the serial device if you are on a Pi 5 (`/dev/ttyAMA0`).

## Remote access

The server binds `0.0.0.0` so any device on your network can use it. For access away from home, **do not port-forward it**. Use one of:

- **Tailscale / WireGuard** — install on the Pi, reach `http://<tailscale-name>:8080` from any device.
- **SSH tunnel** — `ssh -L 8080:localhost:8080 pi@host`.
- **Reverse proxy with TLS** — Caddy/nginx in front, or `sudo ./install.sh --tls` for a self-signed certificate.

The API also accepts bearer tokens (`Authorization: Bearer sdt_…`) created in **Settings → API tokens**, which is what a future native app would use.

## HTTP API

All routes are under `/api/v1`, JSON in/out, session cookie or bearer token.

```
GET    /health                       public health + setup state
GET    /auth/status                  setup/authentication state
POST   /auth/setup | /auth/login     password auth
GET    /overview                     dashboard aggregate
GET    /sdr                          state, presets, scanner list, bands
POST   /sdr/start | /sdr/stop | /sdr/tune
GET    /sdr/devices                  rtl_test probe
POST   /sdr/presets                  save a preset
PUT    /sdr/scan-channels            replace scanner list
GET    /gps                          fix, satellites, receiver settings
POST   /gps/config | /gps/restart
GET    /gps/track | /track.gpx
GET    /mesh                         both bridge states + stored history
POST   /mesh/:kind/start | /stop | /send | /command
PUT    /mesh/:kind/config
GET    /radio                        current radio owner, daemons and warnings
POST   /mesh/mode                    { mode, transport } — stops the old owner, starts the new one
GET    /mesh/native                  openHop state, presets, rendered + installed config
POST   /mesh/native/provision        write config, start openHop, attach the bridge
POST   /mesh/native/config | /restart
POST   /mesh/native/apply            regenerate config, restart openHop, reattach the bridge
PUT    /mesh/native/settings         MeshCore preset, power, node name, companion port
GET    /time                         system clock, NTP, RTC devices
POST   /time/sync                    { direction: to-rtc|from-rtc, device }
GET    /system                       stats, services, hardware detection
GET    /system/logs?unit=&lines=
POST   /system/services/:unit/:action
GET    /system/hardware              boot overlays, spidev, RTC, i2c, tools
POST   /system/hardware/apply        append missing overlay lines
GET    /system/meshtasticd           current + generated config
POST   /system/meshtasticd/write
POST   /system/rails                 GPIO power rails (AIO V2)
POST   /system/power                 reboot | shutdown
GET    /settings                     sanitised settings
PUT    /settings
POST   /auth/tokens                  create API token
```

WebSocket: `ws://host/ws`, authenticated with the same cookie or `?token=`.

```jsonc
// client → server
{ "op": "subscribe", "channels": ["status", "sdr", "sdr-iq", "gps", "mesh"] }

// server → client (text)
{ "type": "status", "data": { /* system, sdr, gps, services, mesh */ } }
{ "type": "gps",    "data": { /* fix, satellites, … */ } }
{ "type": "mesh",   "data": { "kind": "meshtastic", "event": { /* … */ } } }

// server → client (binary): [0x01, ...interleaved unsigned 8-bit IQ]
```

The mobile-app design constraint is honoured by keeping all state on the server and exposing it through this versioned API, with the web UI as one client among others.

## Radio notes

**Meshtastic.** meshtasticd must own the SX1262. The generated config is:

```yaml
Lora:
  Module: sx1262
  DIO2_AS_RF_SWITCH: true
  DIO3_TCXO_VOLTAGE: true
  spidev: spidev0.0
  IRQ: 26
  Busy: 24
  Reset: 25
GPS:
  SerialPath: /dev/ttyS0
```

SignalDeck's Python bridge connects to `127.0.0.1:4403` and forwards messages, nodes and configuration.

**MeshCore (standalone).** MeshCore can run on the HAT's own SX1262. `install.sh` installs [openHop Repeater](https://github.com/openhop-dev/openhop_repeater), which owns the radio and exposes a companion endpoint on `127.0.0.1:5000`. SignalDeck generates `/etc/openhop_repeater/config.yaml` from **Settings → Radio wiring** and the MeshCore preset (frequency, bandwidth, spreading factor, coding rate, TCXO and DIO2 switch), including a persistent identity at `/var/lib/openhop_repeater/identity.key`.

Choose **MeshCore — HAT radio** under **Settings → Mesh stack**. SignalDeck stops `meshtasticd`, starts openHop, waits for the companion port, and only then attaches the bridge; switching back stops openHop and restarts `meshtasticd`. The saved choice is re-applied at boot, so exactly one process ever holds the radio. `GET /api/v1/radio` reports the current owner and any conflicts.

Changing the MeshCore preset, node name or the SX1262 pin map regenerates `/etc/openhop_repeater/config.yaml`, restarts openHop (with a timestamped backup of the previous file) and reattaches the bridge. The existing `identity_key`/`identity_file` and admin password are carried into the new file, so the node keeps its MeshCore identity across changes; identical configs are not rewritten. The MeshCore page shows every apply step and any warnings.

An external MeshCore companion over TCP or USB serial is still supported (**MeshCore — external companion**); in that mode SignalDeck leaves the HAT radio free and talks to the companion you point it at.

**RTL-SDR.** The R860 tunes 24 MHz–1.766 GHz. Below 28.8 MHz enable `Direct sampling: Q branch`. The bias tee feeds 5 V up the coax; enable it only for an antenna/LNA that expects power.

**RTC.** `sudo hwclock --rtc=/dev/rtc0 -w` (system → RTC) is exposed on the Time page; the installed sudoers rule allows exactly these commands.

## Operations

```bash
systemctl status signaldeck
journalctl -u signaldeck -f
sudo systemctl restart signaldeck
```

Update:

```bash
cd signaldeck
git pull
sudo ./install.sh          # rebuilds the web UI, keeps data/settings
```

Data lives in `/opt/signaldeck/data` (`settings.json`, `state.json` with presets, track and message history, optional TLS certificate). It survives reinstallation.

Remove:

```bash
sudo ./uninstall.sh          # keeps data
sudo ./uninstall.sh --purge  # deletes everything
```

## Troubleshooting

| Symptom | Check |
| --- | --- |
| SDR page says “Demo IQ source” | `rtl_test -t` on the Pi; check USB, then `rtl_tcp` presence and the System logs |
| Waterfall empty but receiver started | Lower the sample rate, reload the tab, check the browser supports WebSocket |
| No audio | Press **Listen** (browser autoplay requires a gesture), raise volume, open squelch |
| No GNSS fix | Antenna outdoors, `enable_uart=1`, serial console disabled, correct `/dev/ttyS0` vs `/dev/ttyAMA0` |
| gpsd never starts | `sudo systemctl status gpsd`, then set `DEVICES=/dev/ttyS0` in `/etc/default/gpsd` |
| No RTC | `dtoverlay=i2c-rtc,pcf85063a` in config.txt, battery installed, `i2cdetect -y 1` shows `0x51` |
| meshtasticd won't start | `journalctl -u meshtasticd -b`; verify `spidev1.0`/`spidev0.0` matches the board |
| Mesh page: Python library missing | `sudo /opt/signaldeck/venv/bin/pip install meshtastic meshcore` |
| openHop won't start | `journalctl -u openhop-repeater -b`; verify the SPI bus/CS and pins under Settings → Radio wiring, then re-apply the handover |
| Two mesh stacks running | Open **System → Radio ownership** and pick one stack; SignalDeck stops the other process for you |
| Password forgotten | Stop the service, delete `auth` from `data/settings.json`, restart, create a new password |

## Development

```bash
cd server && npm install && SIGNALDECK_DEMO=1 npm start   # http://127.0.0.1:8080
cd web && npm install && npm run dev                      # http://127.0.0.1:5173, proxies API
npm run build                                             # typecheck + production bundle
```

`SIGNALDECK_DEMO=1` replaces the radio, GPS and services with synthetic sources so the UI can be developed on any machine.

## Scope and status

- Built against HackerGadgets' published HAT specifications. The Pi-HAT setup page was not published at the time of writing, so SPI device and pins are configurable rather than hard-coded.
- The installer targets Raspberry Pi OS / Debian with systemd. Other distributions work if the packages and systemd unit are adapted.
- SDR demodulation is mono; stereo WFM and RDS are not implemented. ADS-B and other digital decoders are not included — the waterfall will show the 1090 MHz energy, but decoding needs `readsb`/`dump1090`.
- Map tiles come from CARTO/OpenStreetMap and need internet; the position and track remain available offline.

## License

MIT. Meshtastic, MeshCore, rtl-sdr, gpsd and Raspberry Pi OS are separate projects with their own licences.
