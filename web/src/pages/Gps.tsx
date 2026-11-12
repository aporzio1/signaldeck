import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { MapView, type MapPoint } from '../components/MapView';
import { fmtCoord, fmtDateTime, fmtDistance, fmtHz, fmtTime } from '../format';
import { Badge, Button, Card, Empty, Field, Select, Slider, Stat, Toggle, toast } from '../ui';
import { live } from '../ws';

function SkyPlot({ satellites }: { satellites: any[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = canvas.clientWidth;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const cx = size / 2;
    const cy = size / 2;
    const radius = size / 2 - 18;

    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.fillStyle = 'rgba(148,163,184,0.75)';
    ctx.font = '10px ui-monospace, monospace';
    for (const el of [0, 30, 60]) {
      const r = radius * (1 - el / 90);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx, cy - radius);
    ctx.lineTo(cx, cy + radius);
    ctx.moveTo(cx - radius, cy);
    ctx.lineTo(cx + radius, cy);
    ctx.stroke();
    ctx.fillText('N', cx - 3, cy - radius - 6);
    ctx.fillText('S', cx - 3, cy + radius + 12);
    ctx.fillText('E', cx + radius + 5, cy + 3);
    ctx.fillText('W', cx - radius - 13, cy + 3);

    for (const sat of satellites) {
      const elevation = Math.max(0, Math.min(90, sat.el || 0));
      const azimuth = ((sat.az || 0) * Math.PI) / 180;
      const r = radius * (1 - elevation / 90);
      const x = cx + r * Math.sin(azimuth);
      const y = cy - r * Math.cos(azimuth);
      const snr = sat.snr || 0;
      const color = sat.used ? (snr > 35 ? '#4ade80' : snr > 22 ? '#fbbf24' : '#f87171') : '#475569';
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.22;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.font = '9px ui-monospace, monospace';
      ctx.fillText(String(sat.prn), x - 5, y + 3);
    }
  }, [satellites]);

  return <canvas ref={ref} className="skyplot" />;
}

export function GpsPage() {
  const [state, setState] = useState<any>(null);
  const [settings, setSettings] = useState<any>(null);
  const [track, setTrack] = useState<any[]>([]);
  const [busy, setBusy] = useState('');
  const [imperial, setImperial] = useState(false);

  useEffect(() => {
    api.get('/gps').then((payload) => {
      setState(payload.state);
      setSettings(payload.settings);
    });
    api.get('/gps/track').then((payload) => setTrack(payload.points || []));
  }, []);

  useEffect(() => {
    const unsubscribe = live.subscribe(['gps'], (next) => setState(next));
    return unsubscribe;
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      api.get('/gps/track').then((payload) => setTrack(payload.points || [])).catch(() => {});
    }, 20000);
    return () => clearInterval(timer);
  }, []);

  const save = async (patch: any) => {
    setBusy('config');
    try {
      await api.post('/gps/config', patch);
      const payload = await api.get('/gps');
      setState(payload.state);
      setSettings(payload.settings);
      toast('GNSS settings applied', 'good');
    } catch (error: any) {
      toast(error.message, 'bad');
    } finally {
      setBusy('');
    }
  };

  if (!state) return <Empty title="Reading GNSS receiver…" />;

  const points: MapPoint[] = [];
  if (state.lat != null) {
    points.push({
      id: 'self',
      lat: state.lat,
      lon: state.lon,
      label: 'This station',
      detail: `${state.fixLabel} · ${state.satsUsed} satellites`,
      tone: 'self',
    });
  }

  const fixTone = state.fix >= 3 ? 'good' : state.fix >= 2 ? 'info' : 'warn';

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">GNSS positioning</h1>
          <p className="page-desc">
            Multi-constellation GPS / BeiDou / Galileo from the HAT, with sky view, track log and time source.
          </p>
        </div>
        <div className="row">
          <Badge tone={fixTone} dot>{state.fixLabel}</Badge>
          <Badge>{state.source === 'demo' ? 'Simulated' : state.source === 'gpsd' ? 'gpsd' : state.source === 'serial' ? 'Serial NMEA' : 'idle'}</Badge>
          <Button size="sm" icon="refresh" busy={busy === 'restart'} onClick={() => save({})}>Restart</Button>
        </div>
      </div>

      {state.error && <div className="alert warn small">{state.error}</div>}

      <div className="grid three">
        <Card><Stat label="Latitude" value={state.lat != null ? Math.abs(state.lat).toFixed(6) : '—'} unit={state.lat != null ? (state.lat >= 0 ? '° N' : '° S') : ''} /></Card>
        <Card><Stat label="Longitude" value={state.lon != null ? Math.abs(state.lon).toFixed(6) : '—'} unit={state.lon != null ? (state.lon >= 0 ? '° E' : '° W') : ''} /></Card>
        <Card><Stat label="Altitude" value={state.alt != null ? state.alt.toFixed(0) : '—'} unit="m" hint="MSL" /></Card>
        <Card><Stat label="Speed" value={state.speed != null ? (imperial ? (state.speed * 2.23694).toFixed(1) : (state.speed * 3.6).toFixed(1)) : '—'} unit={imperial ? 'mph' : 'km/h'} /></Card>
        <Card><Stat label="Satellites" value={`${state.satsUsed || 0}/${state.satsVisible || 0}`} hint={imperial ? 'used / visible' : 'used / visible'} /></Card>
        <Card><Stat label="HDOP" value={state.hdop != null ? state.hdop.toFixed(2) : '—'} hint={state.pdop != null ? `PDOP ${state.pdop.toFixed(2)}` : ''} /></Card>
      </div>

      <div className="grid two">
        <Card
          title="Position"
          subtitle={fmtCoord(state.lat, state.lon, 6)}
          actions={
            <a className="btn btn-ghost btn-sm" href="/api/v1/gps/track.gpx" download>
              GPX
            </a>
          }
          flush
        >
          <div style={{ padding: 10 }}>
            <MapView points={points} track={track} follow height={340} />
            <div className="row spread" style={{ marginTop: 8 }}>
              <span className="dim tiny">Map tiles need internet; the track is stored locally on the Pi.</span>
              <Toggle label="Imperial" checked={imperial} onChange={setImperial} />
            </div>
          </div>
        </Card>

        <Card title="Sky view" subtitle={`${state.satsVisible || 0} satellites in view`}>
          <div className="row" style={{ alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
            <SkyPlot satellites={state.satellites || []} />
            <div className="stack grow" style={{ minWidth: 150 }}>
              <Stat label="Last update" value={state.lastUpdate ? fmtTime(state.lastUpdate) : '—'} size="sm" />
              <Stat label="GNSS time" value={state.time ? fmtTime(state.time) : '—'} size="sm" hint={state.offsetMs != null ? `${state.offsetMs} ms vs system` : ''} />
              <div className="row tight">
                <Badge tone="good" dot>used</Badge>
                <Badge tone="warn" dot>weak</Badge>
                <Badge dot>idle</Badge>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <div className="grid two">
        <Card title="Constellations" subtitle="Signal to noise per satellite" flush>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>PRN</th>
                  <th>System</th>
                  <th>Az / El</th>
                  <th>SNR</th>
                  <th>Used</th>
                </tr>
              </thead>
              <tbody>
                {(state.satellites || []).slice().sort((a: any, b: any) => (b.snr || 0) - (a.snr || 0)).map((sat: any) => (
                  <tr key={`${sat.system}-${sat.prn}`}>
                    <td className="mono">{sat.prn}</td>
                    <td>{sat.system}</td>
                    <td className="mono dim">{sat.az}° / {sat.el}°</td>
                    <td>
                      <div className="row tight">
                        <div className="meter" style={{ width: 54 }}>
                          <span style={{ width: `${Math.min(100, (sat.snr / 50) * 100)}%`, background: sat.snr > 32 ? 'var(--green)' : sat.snr > 20 ? 'var(--amber)' : 'var(--red)' }} />
                        </div>
                        <span className="mono tiny">{sat.snr}</span>
                      </div>
                    </td>
                    <td>{sat.used ? <Badge tone="good">yes</Badge> : <span className="dim">—</span>}</td>
                  </tr>
                ))}
                {!state.satellites?.length && (
                  <tr><td colSpan={5}><Empty title="No satellites yet" hint="Antenna needs a clear view of the sky." /></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Receiver settings" subtitle="Where SignalDeck reads NMEA from">
          <div className="stack">
            <Field label="Source" hint="Auto tries gpsd first, then reads the serial port directly.">
              <Select
                value={settings?.source || 'auto'}
                onChange={(value) => save({ source: value })}
                options={[
                  { value: 'auto', label: 'Auto (gpsd → serial)' },
                  { value: 'gpsd', label: 'gpsd only' },
                  { value: 'serial', label: 'Serial NMEA only' },
                ]}
              />
            </Field>
            <div className="form-row">
              <Field label="Serial device">
                <input
                  className="input mono"
                  defaultValue={settings?.serialPath}
                  onBlur={(event) => save({ serialPath: event.target.value })}
                  placeholder="/dev/ttyS0"
                />
              </Field>
              <Field label="Baud">
                <Select
                  value={String(settings?.baud || 9600)}
                  onChange={(value) => save({ baud: Number(value) })}
                  options={[4800, 9600, 38400, 57600, 115200].map((baud) => ({ value: String(baud), label: String(baud) }))}
                />
              </Field>
            </div>
            <div className="form-row">
              <Field label="gpsd host">
                <input className="input mono" defaultValue={settings?.gpsdHost} onBlur={(event) => save({ gpsdHost: event.target.value })} />
              </Field>
              <Field label="gpsd port">
                <input className="input mono" defaultValue={settings?.gpsdPort} onBlur={(event) => save({ gpsdPort: Number(event.target.value) })} />
              </Field>
            </div>
            <Toggle
              label="Log track to disk"
              hint="Every fix is appended to a local GPX-exportable track."
              checked={Boolean(settings?.logTrack)}
              onChange={(checked) => save({ logTrack: checked })}
            />
            <div className="row">
              <Button
                size="sm"
                variant="danger"
                icon="trash"
                onClick={async () => {
                  if (!confirm('Delete the stored track log?')) return;
                  await api.del('/gps/track');
                  setTrack([]);
                  toast('Track cleared');
                }}
              >
                Clear track
              </Button>
              <span className="dim tiny">{track.length} points stored</span>
            </div>
            <div className="hint-box small">
              On the HAT the GNSS module is wired to the Pi UART at <span className="code">9600 8N1</span> and needs
              <span className="code">enable_uart=1</span> (Pi 4) or <span className="code">dtparam=uart0</span> (Pi 5).
              Keep the serial console disabled.
            </div>
          </div>
        </Card>
      </div>

      <Card title="Recent fixes" subtitle="Latest track points" flush>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Time</th><th>Position</th><th>Altitude</th><th>Speed</th><th>Fix</th></tr>
            </thead>
            <tbody>
              {track.slice(-8).reverse().map((point: any, index: number) => (
                <tr key={index}>
                  <td className="mono dim">{fmtDateTime(point.ts)}</td>
                  <td className="mono">{fmtCoord(point.lat, point.lon, 5)}</td>
                  <td className="mono">{point.alt != null ? `${point.alt.toFixed(0)} m` : '—'}</td>
                  <td className="mono">{point.speed != null ? fmtDistance(point.speed, imperial) : '—'}</td>
                  <td>{point.fix === 3 ? '3D' : point.fix === 2 ? '2D' : '—'}</td>
                </tr>
              ))}
              {!track.length && <tr><td colSpan={5}><Empty title="No track yet" hint="A 2D or 3D fix is required." /></td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
