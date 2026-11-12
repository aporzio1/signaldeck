import { useEffect, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { fmtBytes, fmtDistance, fmtDuration, fmtHz, fmtTime, fmtAgo, fmtCoord } from '../format';
import { useApp, useNow } from '../state';
import { Badge, Button, Card, Empty, Meter, Stat, toast } from '../ui';

function serviceByUnit(services: any[], unit: string) {
  return services?.find((service) => service.unit === unit);
}

export function Dashboard() {
  const { overview, refresh } = useApp();
  const now = useNow(1000);
  const [mesh, setMesh] = useState<any>(null);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    api.get('/mesh').then(setMesh).catch(() => {});
  }, []);

  const system = overview?.system;
  const sdr = overview?.sdr;
  const gps = overview?.gps;
  const services = overview?.services || [];
  const hardware = overview?.hardware;
  const clocks = overview?.clocks;
  const meshtastic = mesh?.meshtastic;
  const lastMessage = meshtastic?.messages?.[meshtastic.messages.length - 1];
  const nodes = meshtastic?.nodes || [];
  const rtc = clocks?.rtc?.find((r: any) => r.device === hardware?.rtcPreferred) || clocks?.rtc?.[0];
  const ntp = clocks?.ntp;

  const act = async (label: string, fn: () => Promise<any>, message: string) => {
    setBusy(label);
    try {
      await fn();
      toast(message, 'good');
      await refresh();
    } catch (error: any) {
      toast(error?.message || 'Action failed', 'bad');
    } finally {
      setBusy('');
    }
  };

  if (!overview) {
    return (
      <div className="grid">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="card" style={{ height: 150 }} />
        ))}
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Station overview</h1>
          <p className="page-desc">
            Everything on the HAT in one place — spectrum, mesh radio, satellite fix and the hardware clock.
          </p>
        </div>
        <div className="row">
          <Badge tone={hardware?.allConfigured ? 'good' : 'warn'} dot>
            {hardware?.allConfigured ? 'Interfaces enabled' : 'Setup needed'}
          </Badge>
          <Button icon="refresh" size="sm" onClick={() => refresh()}>Refresh</Button>
        </div>
      </div>

      {overview.alerts?.length > 0 && (
        <div className="grid tight">
          {overview.alerts.map((alert: any, index: number) => (
            <div key={index} className={`alert ${alert.level === 'warn' ? 'warn' : 'info'}`}>
              <Icon name="alert" size={16} />
              <div className="grow">
                <div style={{ fontWeight: 550 }}>{alert.title}</div>
                <div className="dim small">{alert.detail}</div>
              </div>
              {alert.action && (
                <a className="btn btn-ghost btn-sm" href={`#/${alert.action}`}>
                  Open
                </a>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="grid">
        <Card
          title="Software-defined radio"
          subtitle={sdr?.source === 'mock' ? 'Demo IQ source (no device detected)' : sdr?.source === 'rtl_tcp' ? 'RTL2832U via rtl_tcp' : 'Receiver idle'}
          actions={<Badge tone={sdr?.running ? 'good' : ''} dot>{sdr?.running ? 'Live' : 'Stopped'}</Badge>}
        >
          <div className="stack">
            <div className="sdr-readout">
              <span className="sdr-freq" style={{ fontSize: 30 }}>{fmtHz(sdr?.frequency, 4)}</span>
            </div>
            <div className="row tight">
              <Badge>{sdr?.demod?.toUpperCase() || 'NFM'}</Badge>
              <Badge>{sdr?.sampleRate ? `${(sdr.sampleRate / 1e6).toFixed(3)} MS/s` : '—'}</Badge>
              <Badge>{sdr?.gainMode === 'manual' ? `${(sdr.gain / 10).toFixed(1)} dB` : 'Auto gain'}</Badge>
              {sdr?.biasTee && <Badge tone="info">Bias tee</Badge>}
            </div>
            <div className="row">
              <Button
                variant={sdr?.running ? '' : 'primary'}
                icon={sdr?.running ? 'stop' : 'play'}
                busy={busy === 'sdr'}
                onClick={() =>
                  act('sdr', () => api.post(sdr?.running ? '/sdr/stop' : '/sdr/start'), sdr?.running ? 'Receiver stopped' : 'Receiver started')
                }
              >
                {sdr?.running ? 'Stop' : 'Start receiving'}
              </Button>
              <a className="btn" href="#/sdr">
                <Icon name="scan" size={15} /> Open console
              </a>
            </div>
          </div>
        </Card>

        <Card
          title={overview.mesh?.mode === 'meshcore' ? 'MeshCore' : 'Meshtastic'}
          subtitle={
            meshtastic?.running
              ? `Linked to meshtasticd · ${nodes.length} node${nodes.length === 1 ? '' : 's'} known`
              : 'Bridge not connected'
          }
          actions={<Badge tone={meshtastic?.running ? 'good' : 'warn'} dot>{meshtastic?.running ? 'Online' : 'Offline'}</Badge>}
        >
          <div className="stack">
            <div className="row" style={{ gap: 18 }}>
              <Stat label="Nodes" value={nodes.length} />
              <Stat label="Channel" value={meshtastic?.channels?.find((c: any) => c.name)?.name || 'Primary'} size="sm" />
              <Stat label="Last heard" value={lastMessage ? fmtAgo(lastMessage.time * 1000) : '—'} size="sm" />
            </div>
            {lastMessage ? (
              <div className="hint-box">
                <div className="row tight" style={{ marginBottom: 3 }}>
                  <strong className="small">{lastMessage.fromName || lastMessage.from}</strong>
                  <span className="dim tiny">{fmtTime(lastMessage.time * 1000)}</span>
                </div>
                <div className="small">{lastMessage.text}</div>
              </div>
            ) : (
              <div className="dim small">No messages yet. Start the bridge to join the mesh.</div>
            )}
            <div className="row">
              <a className="btn" href="#/meshtastic">
                <Icon name="message" size={15} /> Open messages
              </a>
              <Button
                size="sm"
                busy={busy === 'mesh'}
                onClick={() =>
                  act('mesh', () => api.post(`/mesh/meshtastic/${meshtastic?.running ? 'stop' : 'start'}`), 'Bridge toggled')
                }
              >
                {meshtastic?.running ? 'Disconnect' : 'Connect'}
              </Button>
            </div>
          </div>
        </Card>

        <Card
          title="GNSS"
          subtitle={gps?.source === 'demo' ? 'Simulated fix' : gps?.source === 'gpsd' ? 'via gpsd' : gps?.source === 'serial' ? `Serial ${gps?.device || ''}` : 'Receiver idle'}
          actions={<Badge tone={gps?.fix >= 3 ? 'good' : gps?.fix >= 2 ? 'info' : 'warn'} dot>{gps?.fixLabel || 'No fix'}</Badge>}
        >
          <div className="stack">
            <div className="stat-value sm mono">{fmtCoord(gps?.lat, gps?.lon, 5)}</div>
            <div className="row" style={{ gap: 18 }}>
              <Stat label="Satellites" value={`${gps?.satsUsed || 0}/${gps?.satsVisible || 0}`} hint="used / visible" />
              <Stat label="Altitude" value={gps?.alt != null ? gps.alt.toFixed(0) : '—'} unit="m" />
              <Stat label="HDOP" value={gps?.hdop != null ? gps.hdop.toFixed(1) : '—'} />
            </div>
            <div className="row">
              <a className="btn" href="#/gps">
                <Icon name="gps" size={15} /> Position & sky view
              </a>
            </div>
          </div>
        </Card>

        <Card
          title="System"
          subtitle={`${system?.hostname} · up ${fmtDuration(system?.uptime)}`}
          actions={<Badge tone={system?.temperature > 75 ? 'warn' : 'good'}>{system?.temperature != null ? `${system.temperature.toFixed(0)} °C` : '—'}</Badge>}
        >
          <div className="stack">
            <div>
              <div className="spread small" style={{ marginBottom: 4 }}>
                <span className="dim">CPU</span>
                <span className="mono">{system?.cpu?.percent?.toFixed(0)}% · load {system?.cpu?.load1}</span>
              </div>
              <Meter value={system?.cpu?.percent || 0} tone={system?.cpu?.percent > 85 ? 'warn' : ''} />
            </div>
            <div>
              <div className="spread small" style={{ marginBottom: 4 }}>
                <span className="dim">Memory</span>
                <span className="mono">{fmtBytes(system?.memory?.used)} / {fmtBytes(system?.memory?.total)}</span>
              </div>
              <Meter value={system?.memory?.percent || 0} />
            </div>
            <div>
              <div className="spread small" style={{ marginBottom: 4 }}>
                <span className="dim">Storage</span>
                <span className="mono">{system?.disk ? `${system.disk.percent.toFixed(0)}%` : '—'}</span>
              </div>
              <Meter value={system?.disk?.percent || 0} tone={system?.disk?.percent > 90 ? 'bad' : system?.disk?.percent > 75 ? 'warn' : ''} />
            </div>
            <div className="row tight">
              {system?.network?.map((net: any) => (
                <Badge key={net.name}>{net.name}: {net.address}</Badge>
              ))}
            </div>
          </div>
        </Card>

        <Card title="Clock" subtitle="Hardware RTC, NTP and GNSS time">
          <div className="stack">
            <div className="spread">
              <Stat label="System time" value={fmtTime(now)} hint={clocks?.system?.timezone} size="sm" />
              <Badge tone={ntp?.healthy || clocks?.system?.ntpSynchronized ? 'good' : 'warn'} dot>
                {ntp?.daemon || 'NTP'} {ntp?.healthy || clocks?.system?.ntpSynchronized ? 'synced' : 'unsynced'}
              </Badge>
            </div>
            <div className="divider" />
            <div className="kv">
              <dt>RTC chip</dt>
              <dd>{rtc?.name || 'none detected'}</dd>
              <dt>RTC time</dt>
              <dd>{rtc?.date ? `${rtc.date} ${rtc.time}` : '—'}</dd>
              <dt>Drift</dt>
              <dd className={rtc?.driftSeconds != null && Math.abs(rtc.driftSeconds) > 5 ? 'mono' : ''}>
                {rtc?.driftSeconds != null ? `${rtc.driftSeconds > 0 ? '+' : ''}${rtc.driftSeconds}s` : '—'}
              </dd>
              <dt>GNSS offset</dt>
              <dd>{gps?.offsetMs != null ? `${gps.offsetMs} ms` : '—'}</dd>
            </div>
            <a className="btn btn-sm" href="#/time">
              <Icon name="clock" size={14} /> Sync clocks
            </a>
          </div>
        </Card>

        <Card title="Services" subtitle="Radio and network daemons">
          <div className="list" style={{ margin: '-13px -15px -15px' }}>
            {services.map((service: any) => (
              <div className="list-item" key={service.unit}>
                <span className="pulse" style={{ background: service.active ? 'var(--green)' : 'var(--red)', animation: 'none' }} />
                <div className="grow">
                  <div className="small">{service.unit}</div>
                  <div className="dim tiny truncate">{service.description || service.state}</div>
                </div>
                <Badge tone={service.active ? 'good' : 'bad'}>{service.state}</Badge>
              </div>
            ))}
            {!services.length && <Empty title="No services reported" hint="service control is only available on Linux" />}
          </div>
        </Card>

        <Card title="Radio link" subtitle="LoRa radio and mesh identity">
          <div className="kv">
            <dt>Mode</dt>
            <dd>{mesh?.mode || 'meshtastic'}</dd>
            <dt>Region</dt>
            <dd>{mesh?.radio?.region ?? '—'}</dd>
            <dt>Preset</dt>
            <dd>{mesh?.radio?.preset ?? '—'}</dd>
            <dt>TX power</dt>
            <dd>{mesh?.radio?.txPower ? `${mesh.radio.txPower} dBm` : '—'}</dd>
            <dt>SPI device</dt>
            <dd>{mesh?.radio?.spidev || '—'}</dd>
            <dt>IRQ / BUSY / RST</dt>
            <dd>
              {mesh?.radio?.irq} / {mesh?.radio?.busy} / {mesh?.radio?.reset}
            </dd>
          </div>
          <div className="divider" />
          <div className="row tight">
            <Badge tone={meshtastic?.myInfo ? 'good' : ''} dot>{meshtastic?.myInfo?.longName || 'No node info'}</Badge>
            <a className="btn btn-ghost btn-sm" href="#/settings">Configure</a>
          </div>
        </Card>
      </div>

      <Card title="Hardware detected" subtitle={hardware?.model}>
        <div className="grid three tight">
          <div className="hint-box">
            <div className="tiny dim">RTL-SDR</div>
            <div className="small row tight" style={{ marginTop: 4 }}>
              <span className="pulse" style={{ animation: 'none', background: hardware?.rtl?.available ? 'var(--green)' : 'var(--red)' }} />
              {hardware?.rtl?.available ? `${hardware.rtl.count} device(s)` : 'Not detected'}
            </div>
            <div className="dim tiny" style={{ marginTop: 4 }}>{hardware?.rtl?.devices?.[0]?.label || 'USB receiver'}</div>
          </div>
          <div className="hint-box">
            <div className="tiny dim">LoRa (SX1262)</div>
            <div className="small" style={{ marginTop: 4 }}>{hardware?.spidev?.length ? hardware.spidev.join(', ') : 'No spidev node'}</div>
            <div className="dim tiny" style={{ marginTop: 4 }}>IRQ {hardware?.required ? '' : ''}GPIO 26 · BUSY 24 · RST 25</div>
          </div>
          <div className="hint-box">
            <div className="tiny dim">RTC (PCF85063A)</div>
            <div className="small" style={{ marginTop: 4 }}>{hardware?.rtc?.length ? hardware.rtc.map((r: any) => r.device).join(', ') : 'No RTC detected'}</div>
            <div className="dim tiny" style={{ marginTop: 4 }}>{hardware?.rtc?.[0]?.name || 'i2c clock'}</div>
          </div>
          <div className="hint-box">
            <div className="tiny dim">GNSS</div>
            <div className="small" style={{ marginTop: 4 }}>{gps?.device || hardware?.serialDevices?.[0] || '/dev/ttyS0'}</div>
            <div className="dim tiny" style={{ marginTop: 4 }}>9600 baud NMEA</div>
          </div>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          {hardware?.required?.map((item: any) => (
            <Badge key={item.key} tone={item.present ? 'good' : 'warn'} dot>
              {item.label}
            </Badge>
          ))}
          <a className="btn btn-ghost btn-sm" href="#/system">Setup checks</a>
          <a className="btn btn-ghost btn-sm" href="#/settings">Settings</a>
        </div>
      </Card>
    </div>
  );
}
