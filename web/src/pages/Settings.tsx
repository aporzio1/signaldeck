import { useEffect, useState } from 'react';
import { api, authApi } from '../api';
import { fmtHz, PRESETS, REGIONS } from '../format';
import { Badge, Button, Card, Field, Select, toast, Toggle } from '../ui';
import { useApp } from '../state';

export function SettingsPage() {
  const { overview, refresh } = useApp();
  const [settings, setSettings] = useState<any>(null);
  const [radio, setRadio] = useState<any>({});
  const [busy, setBusy] = useState('');
  const [tokens, setTokens] = useState<any[]>([]);
  const [tokenName, setTokenName] = useState('');
  const [newToken, setNewToken] = useState('');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');

  const load = () =>
    api.get('/settings').then((payload) => {
      setSettings(payload);
      setRadio(payload.lora.radio);
    }).catch((error) => toast(error.message, 'bad'));

  useEffect(() => {
    load();
    authApi.tokens().then((payload) => setTokens(payload.tokens)).catch(() => {});
  }, []);

  const saveSettings = async (patch: any, message = 'Saved') => {
    setBusy('settings');
    try {
      const payload = await api.put('/settings', patch);
      setSettings(payload);
      setRadio(payload.lora.radio);
      toast(message, 'good');
      refresh();
    } catch (error: any) {
      toast(error.message, 'bad');
    } finally {
      setBusy('');
    }
  };

  if (!settings) return null;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-desc">Station identity, radio wiring, access control and API tokens.</p>
        </div>
        <Badge tone="info">v{overview?.version || '0.1.0'}</Badge>
      </div>

      <div className="grid two">
        <Card title="Station" subtitle="Shown in the console header and exported logs">
          <div className="stack">
            <Field label="Name">
              <input
                className="input"
                defaultValue={settings.stationName}
                onBlur={(event) => saveSettings({ stationName: event.target.value }, 'Station name updated')}
              />
            </Field>
            <Field label="Units">
              <Select
                value={settings.units}
                onChange={(value) => saveSettings({ units: value })}
                options={[{ value: 'metric', label: 'Metric (m, km, °C)' }, { value: 'imperial', label: 'Imperial (ft, mi, °F)' }]}
              />
            </Field>
            <div className="hint-box small">
              Hardware: {overview?.hardware?.model || 'unknown'} · {overview?.hardware?.os?.name || ''}
              <br />
              Boot config: <span className="code">{overview?.hardware?.bootConfigPath || 'not found'}</span>
            </div>
          </div>
        </Card>

        <Card title="Mesh stack" subtitle="The SX1262 can only be driven by one stack at a time">
          <div className="stack">
            <Field label="Active stack" hint="MeshCore can also run against a separate companion radio.">
              <Select
                value={settings.lora.mode}
                onChange={(value) => saveSettings({ lora: { mode: value } }, 'Mesh stack switched')}
                options={[
                  { value: 'meshtastic', label: 'Meshtastic (meshtasticd)' },
                  { value: 'meshcore', label: 'MeshCore (companion)' },
                ]}
              />
            </Field>
            <div className="row tight">
              <Badge tone={overview?.mesh?.meshtastic?.running ? 'good' : 'warn'} dot>Meshtastic {overview?.mesh?.meshtastic?.status}</Badge>
              <Badge tone={overview?.mesh?.meshcore?.running ? 'good' : 'warn'} dot>MeshCore {overview?.mesh?.meshcore?.status}</Badge>
            </div>
            <div className="hint-box small">
              Meshtastic uses meshtasticd on TCP 4403. MeshCore attaches to a companion over TCP or USB serial. Only one
              process may own the SPI radio; stop the other stack first.
            </div>
          </div>
        </Card>
      </div>

      <Card title="Radio wiring" subtitle="Pin mapping published for the HackerGadgets HAT (SX1262 + TCXO)">
        <div className="stack">
          <div className="form-row">
            <Field label="SPI device" hint="e.g. spidev0.0">
              <input className="input mono" value={radio.spidev || ''} onChange={(event) => setRadio({ ...radio, spidev: event.target.value })} />
            </Field>
            <Field label="CS GPIO" hint="Leave empty to use the spidev chip select">
              <input className="input mono" value={radio.cs || ''} onChange={(event) => setRadio({ ...radio, cs: event.target.value })} />
            </Field>
            <Field label="IRQ / DIO1">
              <input className="input mono" type="number" value={radio.irq ?? 26} onChange={(event) => setRadio({ ...radio, irq: Number(event.target.value) })} />
            </Field>
            <Field label="BUSY">
              <input className="input mono" type="number" value={radio.busy ?? 24} onChange={(event) => setRadio({ ...radio, busy: Number(event.target.value) })} />
            </Field>
            <Field label="RESET">
              <input className="input mono" type="number" value={radio.reset ?? 25} onChange={(event) => setRadio({ ...radio, reset: Number(event.target.value) })} />
            </Field>
          </div>
          <div className="grid two tight">
            <Toggle
              label="DIO3 powers the TCXO"
              hint="Required on this HAT; keeps the radio on frequency."
              checked={Boolean(radio.dio3Tcxo)}
              onChange={(checked) => setRadio({ ...radio, dio3Tcxo: checked })}
            />
            <Toggle
              label="DIO2 drives the RF switch"
              hint="TX/RX antenna switch control."
              checked={Boolean(radio.dio2RfSwitch)}
              onChange={(checked) => setRadio({ ...radio, dio2RfSwitch: checked })}
            />
          </div>
          <div className="form-row">
            <Field label="Region">
              <Select
                value={String(radio.region ?? 1)}
                onChange={(value) => setRadio({ ...radio, region: Number(value) })}
                options={REGIONS.map((region) => ({ value: String(region.value), label: region.label }))}
              />
            </Field>
            <Field label="Default preset">
              <Select
                value={String(radio.preset ?? 5)}
                onChange={(value) => setRadio({ ...radio, preset: Number(value) })}
                options={PRESETS.map((preset) => ({ value: String(preset.value), label: preset.label }))}
              />
            </Field>
            <Field label="TX power (dBm)">
              <input className="input mono" type="number" min={0} max={22} value={radio.txPower ?? 20} onChange={(event) => setRadio({ ...radio, txPower: Number(event.target.value) })} />
            </Field>
            <Field label="Hop limit">
              <input className="input mono" type="number" min={1} max={7} value={radio.hopLimit ?? 3} onChange={(event) => setRadio({ ...radio, hopLimit: Number(event.target.value) })} />
            </Field>
          </div>
          <div className="row">
            <Button
              variant="primary"
              busy={busy === 'settings'}
              onClick={() => saveSettings({ lora: { radio, mode: settings.lora.mode } }, 'Radio wiring saved')}
            >
              Save wiring
            </Button>
            <a className="btn" href="#/system">Write meshtasticd config</a>
            <span className="dim tiny">
              SPI1 CE0 · IRQ 26 · BUSY 24 · RESET 25 · GPS /dev/ttyS0 @ 9600 · RTC PCF85063A on I2C
            </span>
          </div>
        </div>
      </Card>

      <div className="grid two">
        <Card title="Account" subtitle="Password protects the console">
          <div className="stack">
            <Field label="Current password">
              <input className="input" type="password" value={current} onChange={(event) => setCurrent(event.target.value)} autoComplete="current-password" />
            </Field>
            <Field label="New password" hint="At least 8 characters.">
              <input className="input" type="password" value={next} onChange={(event) => setNext(event.target.value)} autoComplete="new-password" />
            </Field>
            <Button
              busy={busy === 'password'}
              onClick={async () => {
                setBusy('password');
                try {
                  await authApi.changePassword(current, next);
                  setCurrent('');
                  setNext('');
                  toast('Password updated', 'good');
                } catch (error: any) {
                  toast(error.message, 'bad');
                } finally {
                  setBusy('');
                }
              }}
            >
              Update password
            </Button>
          </div>
        </Card>

        <Card title="API tokens" subtitle="For the future mobile app and scripts">
          <div className="stack">
            <div className="row">
              <input className="input" placeholder="Token name (e.g. iPhone)" value={tokenName} onChange={(event) => setTokenName(event.target.value)} />
              <Button
                busy={busy === 'token'}
                onClick={async () => {
                  setBusy('token');
                  try {
                    const created = await authApi.createToken(tokenName || 'API token');
                    setNewToken(created.token);
                    setTokenName('');
                    const payload = await authApi.tokens();
                    setTokens(payload.tokens);
                    toast('Token created — copy it now', 'good');
                  } catch (error: any) {
                    toast(error.message, 'bad');
                  } finally {
                    setBusy('');
                  }
                }}
              >
                Create
              </Button>
            </div>
            {newToken && (
              <div className="hint-box">
                <div className="tiny dim">New token (shown once)</div>
                <div className="mono small" style={{ wordBreak: 'break-all', margin: '4px 0' }}>{newToken}</div>
                <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard?.writeText(newToken); toast('Copied'); }}>
                  Copy
                </Button>
              </div>
            )}
            <div className="list">
              {tokens.map((token) => (
                <div className="list-item" key={token.id} style={{ padding: '8px 0' }}>
                  <div className="grow">
                    <div className="small">{token.name}</div>
                    <div className="dim tiny">created {new Date(token.created).toLocaleDateString()} · last used {token.lastUsed ? new Date(token.lastUsed).toLocaleString() : 'never'}</div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      await authApi.revokeToken(token.id);
                      setTokens((prev) => prev.filter((item) => item.id !== token.id));
                      toast('Token revoked');
                    }}
                  >
                    Revoke
                  </Button>
                </div>
              ))}
              {!tokens.length && <div className="dim small">No tokens yet.</div>}
            </div>
          </div>
        </Card>
      </div>

      <Card title="About" subtitle="SignalDeck — browser console for the RTL-SDR / LoRa / GPS / RTC HAT">
        <div className="grid two">
          <div className="kv">
            <dt>Version</dt>
            <dd>{overview?.version}</dd>
            <dt>API</dt>
            <dd>/api/v1</dd>
            <dt>Stream</dt>
            <dd>ws://…/ws</dd>
            <dt>Data</dt>
            <dd>{overview?.system?.dataDir}</dd>
            <dt>Node</dt>
            <dd>{overview?.system?.node}</dd>
          </div>
          <div className="stack small muted">
            <p>
              The HTTP API is versioned and documented in the repository README so a native mobile app can reuse it
              without changes.
            </p>
            <div className="row tight">
              <Badge>SDR {overview?.sdr?.source}</Badge>
              <Badge>{overview?.hardware?.rtl?.available ? 'RTL-SDR detected' : 'No RTL-SDR'}</Badge>
              <Badge>{settings.lora.mode}</Badge>
              <Badge>{fmtHz(overview?.sdr?.frequency, 3)}</Badge>
            </div>
            <a className="btn btn-sm btn-ghost" href="/api" target="_blank" rel="noreferrer">API index</a>
          </div>
        </div>
      </Card>
    </div>
  );
}
