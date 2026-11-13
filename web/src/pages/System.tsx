import { useEffect, useState } from 'react';
import { api } from '../api';
import { fmtBytes, fmtDuration } from '../format';
import { Badge, Button, Card, Empty, Field, Modal, Select, Stat, Toggle, toast } from '../ui';

const UNITS = ['gpsd', 'meshtasticd', 'openhop-repeater', 'signaldeck', 'chrony', 'ssh', 'tailscaled'];

export function SystemPage() {
  const [data, setData] = useState<any>(null);
  const [logs, setLogs] = useState('');
  const [logUnit, setLogUnit] = useState('signaldeck');
  const [busy, setBusy] = useState('');
  const [confirmApply, setConfirmApply] = useState(false);
  const [confirmPower, setConfirmPower] = useState<'reboot' | 'shutdown' | null>(null);
  const [msd, setMsd] = useState<any>(null);
  const [msdText, setMsdText] = useState('');
  const [rails, setRails] = useState(true);
  const [logLines, setLogLines] = useState('200');
  const [radio, setRadio] = useState<any>(null);

  const load = () => {
    api.get('/radio').then(setRadio).catch(() => {});
    return api.get('/system').then((payload) => {
      setData(payload);
      if (!msd) {
        api.get('/system/meshtasticd').then((config) => {
          setMsd(config);
          setMsdText(config.rendered);
        }).catch(() => {});
      }
    }).catch((error) => toast(error.message, 'bad'));
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, 12000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    api.get(`/system/logs?unit=${encodeURIComponent(logUnit)}&lines=${logLines}`)
      .then((payload) => setLogs(payload.text))
      .catch(() => {});
  }, [logUnit, logLines]);

  const serviceAction = async (unit: string, action: string) => {
    setBusy(`${unit}-${action}`);
    try {
      await api.post(`/system/services/${unit}/${action}`);
      toast(`${unit} ${action}ed`, 'good');
      await load();
    } catch (error: any) {
      toast(error.message, 'bad');
    } finally {
      setBusy('');
    }
  };

  const handover = async (mode: string, transport?: string) => {
    setBusy(`radio-${mode}`);
    try {
      const result = await api.post('/mesh/mode', { mode, transport });
      toast(
        result.warnings?.length ? `Switched with ${result.warnings.length} warning(s)` : `Radio handed to ${mode}`,
        result.warnings?.length ? 'bad' : 'good',
      );
      await load();
    } catch (error: any) {
      toast(error.message, 'bad');
    } finally {
      setBusy('');
    }
  };

  const hardware = data?.hardware;
  const stats = data?.stats;
  const missing = (hardware?.required || []).filter((item: any) => !item.present);

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">System</h1>
          <p className="page-desc">Services, boot overlays and the radios behind them. Changes here touch the host OS.</p>
        </div>
        <div className="row">
          <Badge tone={hardware?.allConfigured ? 'good' : 'warn'} dot>{hardware?.allConfigured ? 'HAT configured' : `${missing.length} item(s) missing`}</Badge>
          <Button size="sm" icon="refresh" onClick={load}>Refresh</Button>
        </div>
      </div>

      <div className="grid three">
        <Card><Stat label="Model" value={hardware?.isPi ? 'Raspberry Pi' : 'Host'} hint={hardware?.model} size="sm" /></Card>
        <Card><Stat label="Uptime" value={fmtDuration(stats?.uptime)} hint={hardware?.os?.name} size="sm" /></Card>
        <Card><Stat label="Kernel" value={stats?.platform?.replace(/^Linux\s*/, 'Linux ')} size="sm" hint={`${stats?.cpu?.cores} cores · ${fmtBytes(stats?.memory?.total)}`} /></Card>
      </div>

      <Card
        title="Radio ownership"
        subtitle="One process at a time drives the HAT's SX1262"
        actions={<Badge tone={radio?.conflict ? 'bad' : radio?.owner === 'none' ? 'warn' : 'good'} dot>{radio?.ownerLabel || 'Unknown'}</Badge>}
      >
        <div className="stack">
          <div className="grid three tight">
            <div className="hint-box">
              <div className="tiny dim">meshtasticd</div>
              <div className="small">{radio?.meshtasticd?.active ? 'running' : 'stopped'}</div>
            </div>
            <div className="hint-box">
              <div className="tiny dim">openHop Repeater</div>
              <div className="small">
                {radio?.native?.installed ? (radio.native.active ? 'running' : 'installed, stopped') : 'not installed'}
              </div>
            </div>
            <div className="hint-box">
              <div className="tiny dim">MeshCore bridge</div>
              <div className="small">{radio?.bridges?.meshcore?.status || 'stopped'}</div>
            </div>
          </div>
          <div className="row">
            <Button
              size="sm"
              variant={radio?.mode === 'meshtastic' ? 'primary' : ''}
              busy={busy === 'radio-meshtastic'}
              onClick={() => handover('meshtastic')}
            >
              Use Meshtastic
            </Button>
            <Button
              size="sm"
              variant={radio?.mode === 'meshcore' && radio?.transport === 'native' ? 'primary' : ''}
              busy={busy === 'radio-meshcore'}
              onClick={() => handover('meshcore', 'native')}
            >
              Use MeshCore on the HAT radio
            </Button>
            <a className="btn btn-sm btn-ghost" href="#/meshcore">MeshCore setup</a>
          </div>
          {radio?.warnings?.length > 0 && (
            <div className="hint-box small">
              {radio.warnings.map((warning: string, index: number) => (
                <div key={index} className="dim tiny">• {warning}</div>
              ))}
            </div>
          )}
          <div className="dim tiny">
            A switch stops the owning daemon, applies its radio configuration, restarts the new owner and waits for its
            endpoint before reattaching the bridge. The saved choice is re-applied on boot.
          </div>
        </div>
      </Card>

      <Card
        title="Radio services"
        subtitle="Start, stop or restart the daemons SignalDeck depends on"
        flush
      >
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Unit</th><th>State</th><th>Boot</th><th>Description</th><th className="right"></th></tr></thead>
            <tbody>
              {(data?.services || []).map((service: any) => (
                <tr key={service.unit}>
                  <td className="mono">{service.unit}</td>
                  <td><Badge tone={service.active ? 'good' : 'bad'} dot>{service.subState || service.state}</Badge></td>
                  <td>{service.enabled ? <Badge tone="info">enabled</Badge> : <span className="dim">—</span>}</td>
                  <td className="dim small truncate" style={{ maxWidth: 320 }}>{service.description || '—'}</td>
                  <td>
                    <div className="row tight" style={{ justifyContent: 'flex-end' }}>
                      <Button size="sm" busy={busy === `${service.unit}-restart`} onClick={() => serviceAction(service.unit, 'restart')} disabled={!service.available}>Restart</Button>
                      <Button size="sm" variant="ghost" busy={busy === `${service.unit}-stop`} onClick={() => serviceAction(service.unit, 'stop')} disabled={!service.active}>Stop</Button>
                    </div>
                  </td>
                </tr>
              ))}
              {!data?.services?.length && <tr><td colSpan={5}><Empty title="No systemd services" hint="Service control requires Linux with systemd." /></td></tr>}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid two">
        <Card title="HAT interfaces" subtitle={hardware?.bootConfigPath || 'No boot config found'}>
          <div className="stack">
            {(hardware?.required || []).map((item: any) => (
              <div key={item.key} className="spread">
                <div>
                  <div className="small">{item.label}</div>
                  <div className="dim tiny">{item.why} · <span className="code">{item.line}</span></div>
                </div>
                <Badge tone={item.present ? 'good' : 'warn'} dot>{item.present ? 'enabled' : 'missing'}</Badge>
              </div>
            ))}
            <div className="row">
              <Button size="sm" variant="primary" disabled={!missing.length} onClick={() => setConfirmApply(true)}>
                Add missing lines
              </Button>
              <span className="dim tiny">A timestamped backup is written first. Reboot to apply.</span>
            </div>
            <div className="hint-box small">
              <div className="row tight" style={{ marginBottom: 6 }}>
                <Badge>{hardware?.spidev?.length ? hardware.spidev.join(' ') : 'no spidev'}</Badge>
                <Badge>{hardware?.rtc?.length ? hardware.rtc.map((r: any) => r.device).join(' ') : 'no RTC'}</Badge>
                <Badge>{hardware?.serialDevices?.slice(0, 3).join(' ') || 'no serial'}</Badge>
              </div>
              <div className="dim tiny">I2C: {hardware?.i2cNames?.map((item: any) => `${item.device}=${item.name}`).join(', ') || 'none'}</div>
            </div>
            <details>
              <summary className="dim small" style={{ cursor: 'pointer' }}>Show boot config tail</summary>
              <pre className="log" style={{ marginTop: 8 }}>{hardware?.bootConfigTail || 'unavailable'}</pre>
            </details>
          </div>
        </Card>

        <Card title="meshtasticd radio config" subtitle="Generated from the pinout in Settings">
          <div className="stack">
            <Field label="config.yaml" hint="Written with sudo; the daemon restarts to pick it up.">
              <textarea className="textarea" rows={12} value={msdText} onChange={(event) => setMsdText(event.target.value)} spellCheck={false} />
            </Field>
            <div className="row">
              <Button
                size="sm"
                variant="primary"
                onClick={async () => {
                  setBusy('msd');
                  try {
                    await api.post('/system/meshtasticd/write', { text: msdText, restart: true });
                    toast('meshtasticd configuration written', 'good');
                    await load();
                  } catch (error: any) {
                    toast(error.message, 'bad');
                  } finally {
                    setBusy('');
                  }
                }}
                busy={busy === 'msd'}
              >
                Write & restart
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMsdText(msd?.rendered || '')}>Reset to generated</Button>
              <a className="btn btn-sm btn-ghost" href="#/settings">Pinout</a>
            </div>
            {msd?.text && (
              <details>
                <summary className="dim small" style={{ cursor: 'pointer' }}>Show current file</summary>
                <pre className="log" style={{ marginTop: 8 }}>{msd.text}</pre>
              </details>
            )}
          </div>
        </Card>
      </div>

      <Card title="Logs" subtitle="journalctl for the selected unit" actions={
        <div className="row tight">
          <Select value={logUnit} onChange={setLogUnit} options={UNITS.map((unit) => ({ value: unit, label: unit }))} />
          <Select value={logLines} onChange={setLogLines} options={[{ value: '100', label: '100' }, { value: '200', label: '200' }, { value: '500', label: '500' }]} />
          <Button size="sm" icon="refresh" onClick={() => api.get(`/system/logs?unit=${logUnit}&lines=${logLines}`).then((payload) => setLogs(payload.text))}>
            Refresh
          </Button>
        </div>
      }>
        <pre className="log" style={{ maxHeight: 420 }}>{logs || 'No log output. journalctl may be unavailable.'}</pre>
      </Card>

      <div className="grid two">
        <Card title="Power rails" subtitle="uConsole AIO V2 GPIO-controlled power">
          <div className="stack">
            <Toggle
              label="Show rail controls"
              hint="Only enable this if you use the AIO V2 board. Pins 27/16/7/23 are switched."
              checked={rails}
              onChange={setRails}
            />
            {rails && (
              <div className="grid three tight">
                {(hardware?.rails || []).map((rail: any) => (
                  <div key={rail.key} className="hint-box">
                    <div className="small">{rail.name}</div>
                    <div className="dim tiny">GPIO {rail.pin} · {rail.note}</div>
                    <div className="row tight" style={{ marginTop: 8 }}>
                      <Button
                        size="sm"
                        onClick={async () => {
                          try {
                            await api.post('/system/rails', { pin: rail.pin, on: true });
                            toast(`${rail.name} on`, 'good');
                          } catch (error: any) {
                            toast(error.message, 'bad');
                          }
                        }}
                      >
                        On
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          try {
                            await api.post('/system/rails', { pin: rail.pin, on: false });
                            toast(`${rail.name} off`);
                          } catch (error: any) {
                            toast(error.message, 'bad');
                          }
                        }}
                      >
                        Off
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="dim tiny">The Pi HAT has no GPIO rails; radios are powered whenever the Pi is on.</div>
          </div>
        </Card>

        <Card title="Host power" subtitle="Requires the installer's sudoers rule">
          <div className="stack">
            <div className="row">
              <Button icon="refresh" onClick={() => setConfirmPower('reboot')}>Reboot</Button>
              <Button variant="danger" icon="power" onClick={() => setConfirmPower('shutdown')}>Shut down</Button>
            </div>
            <div className="kv">
              <dt>Network</dt>
              <dd>{stats?.network?.map((net: any) => `${net.name} ${net.address}`).join(', ') || '—'}</dd>
              <dt>Data directory</dt>
              <dd className="mono small">{stats?.dataDir}</dd>
              <dt>Node</dt>
              <dd>{stats?.node}</dd>
              <dt>Version</dt>
              <dd>{stats?.version}</dd>
            </div>
            <div className="hint-box small">
              Everything about the HAT is exposed over this web app; for remote use, prefer Tailscale or WireGuard over
              exposing the port to the internet.
            </div>
          </div>
        </Card>
      </div>

      <Modal open={confirmApply} title="Enable HAT interfaces" onClose={() => setConfirmApply(false)}>
        <div className="stack">
          <p className="small muted">These lines will be appended to <span className="code">{hardware?.bootConfigPath}</span>:</p>
          <pre className="log">{missing.map((item: any) => `${item.line}  # ${item.why}`).join('\n')}</pre>
          <div className="alert warn small">The file is backed up first, but review the change. A reboot is required.</div>
          <div className="row">
            <Button
              variant="primary"
              busy={busy === 'apply'}
              onClick={async () => {
                setBusy('apply');
                try {
                  const result = await api.post('/system/hardware/apply', { keys: missing.map((item: any) => item.key) });
                  toast(result.changed ? 'Boot config updated — reboot to apply' : 'Nothing to change', 'good');
                  setConfirmApply(false);
                  await load();
                } catch (error: any) {
                  toast(error.message, 'bad');
                } finally {
                  setBusy('');
                }
              }}
            >
              Write changes
            </Button>
            <Button variant="ghost" onClick={() => setConfirmApply(false)}>Cancel</Button>
          </div>
        </div>
      </Modal>

      <Modal open={Boolean(confirmPower)} title={confirmPower === 'shutdown' ? 'Shut down the Pi?' : 'Reboot the Pi?'} onClose={() => setConfirmPower(null)}>
        <div className="stack">
          <p className="small muted">
            {confirmPower === 'shutdown'
              ? 'The device will power off. You will lose remote access until it is powered back on.'
              : 'The device will restart. The web console reconnects automatically.'}
          </p>
          <div className="row">
            <Button
              variant="danger"
              busy={busy === 'power'}
              onClick={async () => {
                setBusy('power');
                try {
                  await api.post('/system/power', { action: confirmPower });
                  toast('Command accepted');
                  setConfirmPower(null);
                } catch (error: any) {
                  toast(error.message, 'bad');
                } finally {
                  setBusy('');
                }
              }}
            >
              Yes, {confirmPower}
            </Button>
            <Button variant="ghost" onClick={() => setConfirmPower(null)}>Cancel</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
