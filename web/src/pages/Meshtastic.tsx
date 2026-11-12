import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { fmtAgo, fmtDistance, fmtTime, PRESETS, REGIONS, ROLES } from '../format';
import { Icon } from '../icons';
import { useApp } from '../state';
import { Badge, Button, Card, Empty, Field, Select, Stat, Tabs, toast } from '../ui';
import { live } from '../ws';

export function MeshtasticPage() {
  const { overview } = useApp();
  const [data, setData] = useState<any>(null);
  const [tab, setTab] = useState<'messages' | 'nodes' | 'config'>('messages');
  const [channel, setChannel] = useState(0);
  const [dm, setDm] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState<any>({});
  const chatRef = useRef<HTMLDivElement>(null);

  const refresh = () =>
    api.get('/mesh').then((payload) => {
      setData(payload);
      setForm((prev: any) => (Object.keys(prev).length ? prev : payload.radio));
    }).catch((error) => toast(error.message, 'bad'));

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    const unsubscribe = live.subscribe(['mesh'], (payload) => {
      if (payload.kind !== 'meshtastic') return;
      const event = payload.event;
      if (event?.type === 'message') {
        setData((prev: any) =>
          prev ? { ...prev, meshtastic: { ...prev.meshtastic, messages: [...prev.meshtastic.messages, event].slice(-500) } } : prev,
        );
      } else if (event?.type === 'ready' || event?.type === 'nodes' || event?.type === 'channels') {
        refresh();
      } else if (payload.state) {
        setData((prev: any) => (prev ? { ...prev, meshtastic: { ...prev.meshtastic, ...payload.state } } : prev));
      }
    });
    const timer = setInterval(refresh, 15000);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (tab === 'messages') chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
  }, [data?.meshtastic?.messages?.length, tab, channel]);

  const meshtastic = data?.meshtastic;
  const gps = overview?.gps;

  const nodes = useMemo(() => {
    const list = [...(meshtastic?.nodes || [])];
    return list.sort((a, b) => (b.lastHeard || 0) - (a.lastHeard || 0));
  }, [meshtastic?.nodes]);

  const messages = useMemo(() => {
    const list = meshtastic?.messages || [];
    return list.filter((message: any) => (dm ? message.from === dm || message.to === dm : (message.channel ?? 0) === channel));
  }, [meshtastic?.messages, channel, dm]);

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setBusy('send');
    try {
      await api.post('/mesh/meshtastic/send', { text, channel, to: dm || null });
      setDraft('');
      toast('Message queued for the mesh', 'good');
    } catch (error: any) {
      toast(error.message, 'bad');
    } finally {
      setBusy('');
    }
  };

  const command = async (cmd: string, payload: any = {}, message = 'Command sent') => {
    setBusy(cmd);
    try {
      await api.post('/mesh/meshtastic/command', { cmd, ...payload });
      toast(message, 'good');
      await refresh();
    } catch (error: any) {
      toast(error.message, 'bad');
    } finally {
      setBusy('');
    }
  };

  const startBridge = async () => {
    setBusy('start');
    try {
      await api.post('/mesh/meshtastic/start');
      await refresh();
      toast('Connecting to meshtasticd');
    } catch (error: any) {
      toast(error.message, 'bad');
    } finally {
      setBusy('');
    }
  };

  if (!data) return <Empty title="Loading mesh state…" />;

  const running = meshtastic?.running;
  const myInfo = meshtastic?.myInfo;
  const channels = meshtastic?.channels?.length ? meshtastic.channels : [{ index: 0, name: 'Primary' }];
  const pythonReady = Boolean(data.python?.meshtastic);

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Meshtastic</h1>
          <p className="page-desc">
            Long-range LoRa mesh through meshtasticd on the HAT's SX1262. Messages are relayed by every node in range.
          </p>
        </div>
        <div className="row">
          <Badge tone={running ? 'good' : 'warn'} dot>{running ? 'Bridge connected' : 'Disconnected'}</Badge>
          {running ? (
            <Button size="sm" icon="stop" busy={busy === 'stop'} onClick={() => api.post('/mesh/meshtastic/stop').then(refresh)}>
              Disconnect
            </Button>
          ) : (
            <Button size="sm" variant="primary" icon="play" busy={busy === 'start'} onClick={startBridge}>
              Connect
            </Button>
          )}
        </div>
      </div>

      {meshtastic?.lastError && <div className="alert warn small">{meshtastic.lastError}</div>}

      {!running && (
        <Card title="Bridge is offline" subtitle="SignalDeck talks to meshtasticd over TCP 4403">
          <div className="stack small">
            <p className="muted">
              Start the daemon and make sure the radio is configured for the HAT. SignalDeck can generate the
              configuration from your pin settings.
            </p>
            <div className="row">
              <Button size="sm" variant="primary" icon="play" busy={busy === 'start'} onClick={startBridge}>
                Connect now
              </Button>
              <a className="btn btn-sm" href="#/system">Configure meshtasticd</a>
              <a className="btn btn-sm btn-ghost" href="#/settings">Radio pinout</a>
            </div>
            <div className="row tight">
              <Badge tone={pythonReady ? 'good' : 'bad'} dot>
                Python library {data.python?.meshtastic || 'not installed'}
              </Badge>
              <Badge tone={data.python?.venv ? 'good' : 'warn'} dot>{data.python?.venv ? 'virtualenv' : 'system python'}</Badge>
            </div>
            {!pythonReady && (
              <div className="hint-box">
                Install the bridge dependencies with <span className="code">sudo /opt/signaldeck/install.sh</span> or
                <span className="code"> /opt/signaldeck/venv/bin/pip install meshtastic</span>.
              </div>
            )}
          </div>
        </Card>
      )}

      <div className="grid three">
        <Card>
          <Stat label="This node" value={myInfo?.longName || '—'} hint={myInfo?.nodeId || myInfo?.deviceId || 'no identity yet'} size="sm" />
        </Card>
        <Card>
          <Stat label="Firmware" value={myInfo?.firmware || '—'} hint={myInfo?.hwModel || ''} size="sm" />
        </Card>
        <Card>
          <Stat label="Known nodes" value={nodes.length} hint={`${channels.length} channels configured`} />
        </Card>
      </div>

      <Tabs
        value={tab}
        onChange={(next) => setTab(next as any)}
        tabs={[
          { id: 'messages', label: `Messages${messages.length ? ` · ${messages.length}` : ''}` },
          { id: 'nodes', label: `Nodes · ${nodes.length}` },
          { id: 'config', label: 'Radio & channels' },
        ]}
      />

      {tab === 'messages' && (
        <Card
          title={dm ? `Direct · ${nodes.find((node: any) => node.id === dm)?.longName || dm}` : `Channel · ${channels.find((c: any) => c.index === channel)?.name || 'Primary'}`}
          subtitle="Text messages are encrypted with the channel key"
          flush
          actions={
            dm ? (
              <Button size="sm" variant="ghost" icon="x" onClick={() => setDm('')}>Exit direct</Button>
            ) : (
              <Select
                value={String(channel)}
                onChange={(value) => setChannel(Number(value))}
                options={channels.map((c: any) => ({ value: String(c.index), label: c.name || `Channel ${c.index}` }))}
              />
            )
          }
        >
          <div className="chat" ref={chatRef}>
            {messages.map((message: any, index: number) => {
              const mine = (message.from || '').startsWith('!') && message.from === myInfo?.nodeId;
              return (
                <div key={`${message.id || index}-${index}`} className={`bubble ${mine ? 'mine' : ''}`}>
                  <div className="bubble-head">
                    <strong style={{ color: mine ? '#99f6e4' : 'var(--muted)' }}>{mine ? 'You' : message.fromName || message.from}</strong>
                    <span>{fmtTime((message.time || 0) * 1000)}</span>
                    {message.snr != null && <span>{Number(message.snr).toFixed(1)} dB</span>}
                    {message.channel ? <span>ch {message.channel}</span> : null}
                  </div>
                  <div className="bubble-text">{message.text}</div>
                </div>
              );
            })}
            {!messages.length && (
              <Empty title="No messages on this channel" hint="Messages arrive here as soon as the mesh hears them." />
            )}
          </div>
          <div className="composer">
            <input
              className="input"
              placeholder={dm ? 'Direct message…' : `Message ${channels.find((c: any) => c.index === channel)?.name || 'Primary'}…`}
              value={draft}
              maxLength={220}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            <Button variant="primary" icon="send" busy={busy === 'send'} onClick={send} disabled={!running}>
              Send
            </Button>
          </div>
        </Card>
      )}

      {tab === 'nodes' && (
        <Card title="Mesh nodes" subtitle="Heard directly or relayed" flush actions={<Button size="sm" icon="refresh" busy={busy === 'nodes'} onClick={() => command('nodes', {}, 'Node list refreshed')}>Refresh</Button>}>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Node</th><th>ID</th><th>SNR</th><th>Hops</th><th>Battery</th><th>Last heard</th><th>Distance</th><th></th></tr>
              </thead>
              <tbody>
                {nodes.map((node: any) => {
                  const distance =
                    gps?.lat != null && node.latitude != null
                      ? (() => {
                          const R = 6371000;
                          const dLat = ((node.latitude - gps.lat) * Math.PI) / 180;
                          const dLon = ((node.longitude - gps.lon) * Math.PI) / 180;
                          const a =
                            Math.sin(dLat / 2) ** 2 +
                            Math.cos((gps.lat * Math.PI) / 180) * Math.cos((node.latitude * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
                          return 2 * R * Math.asin(Math.sqrt(a));
                        })()
                      : null;
                  return (
                    <tr key={node.id || node.num}>
                      <td>
                        <div className="row tight">
                          <strong>{node.longName || node.id}</strong>
                          <span className="dim tiny">{node.shortName}</span>
                        </div>
                      </td>
                      <td className="mono dim">{node.id}</td>
                      <td className="mono">{node.snr != null ? `${Number(node.snr).toFixed(1)}` : '—'}</td>
                      <td className="mono">{node.hopsAway ?? '—'}</td>
                      <td>
                        {node.battery != null ? (
                          <span className="mono">{node.battery > 100 ? (node.battery / 1000).toFixed(2) + ' V' : node.battery + '%'}</span>
                        ) : (
                          <span className="dim">—</span>
                        )}
                      </td>
                      <td className="dim">{fmtAgo(node.lastHeard ? node.lastHeard * 1000 : null)}</td>
                      <td className="mono">{fmtDistance(distance)}</td>
                      <td className="right">
                        <button className="btn btn-ghost btn-sm" onClick={() => { setDm(node.id); setTab('messages'); }}>
                          <Icon name="message" size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {!nodes.length && (
                  <tr><td colSpan={8}><Empty title="No nodes yet" hint="Nodes appear as their broadcasts are heard." /></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {tab === 'config' && (
        <div className="grid two">
          <Card title="Radio profile" subtitle="Written to meshtasticd through the admin API">
            <div className="stack">
              <div className="form-row">
                <Field label="Region">
                  <Select value={String(form.region ?? 1)} onChange={(value) => setForm({ ...form, region: Number(value) })} options={REGIONS.map((r) => ({ value: String(r.value), label: r.label }))} />
                </Field>
                <Field label="Modem preset">
                  <Select value={String(form.preset ?? 5)} onChange={(value) => setForm({ ...form, preset: Number(value) })} options={PRESETS.map((p) => ({ value: String(p.value), label: p.label }))} />
                </Field>
              </div>
              <div className="form-row">
                <Field label="TX power (dBm)">
                  <input className="input mono" type="number" min={0} max={30} value={form.txPower ?? 20} onChange={(event) => setForm({ ...form, txPower: Number(event.target.value) })} />
                </Field>
                <Field label="Hop limit">
                  <input className="input mono" type="number" min={1} max={7} value={form.hopLimit ?? 3} onChange={(event) => setForm({ ...form, hopLimit: Number(event.target.value) })} />
                </Field>
              </div>
              <Field label="Device role" hint="Routers relay more; clients sleep-friendly.">
                <Select value={String(form.role ?? 0)} onChange={(value) => setForm({ ...form, role: Number(value) })} options={ROLES.map((r) => ({ value: String(r.value), label: r.label }))} />
              </Field>
              <div className="row">
                <Button
                  variant="primary"
                  busy={busy === 'apply'}
                  disabled={!running}
                  onClick={async () => {
                    setBusy('apply');
                    try {
                      await api.put('/mesh/meshtastic/config', form);
                      for (const key of ['region', 'txPower', 'hopLimit']) {
                        await api.post('/mesh/meshtastic/command', { cmd: 'setConfig', section: 'lora', key, value: form[key] });
                      }
                      await api.post('/mesh/meshtastic/command', { cmd: 'setConfig', section: 'lora', key: 'preset', value: form.preset });
                      await api.post('/mesh/meshtastic/command', { cmd: 'setConfig', section: 'device', key: 'role', value: form.role });
                      toast('Radio configuration applied', 'good');
                      await refresh();
                    } catch (error: any) {
                      toast(error.message, 'bad');
                    } finally {
                      setBusy('');
                    }
                  }}
                >
                  Apply to radio
                </Button>
                <span className="dim tiny">The node may reboot to apply changes.</span>
              </div>
            </div>
          </Card>

          <Card title="Channels" subtitle="Shared keys per channel">
            <div className="stack">
              {channels.map((item: any) => (
                <div key={item.index} className="hint-box">
                  <div className="spread">
                    <strong className="small">{item.name || `Channel ${item.index}`}</strong>
                    <Badge tone={item.psk ? 'good' : 'warn'}>{item.psk ? 'encrypted' : 'open key'}</Badge>
                  </div>
                  <div className="dim tiny mono" style={{ marginTop: 4 }}>
                    index {item.index} · {item.psk ? `${item.psk.slice(0, 12)}…` : 'default public key'}
                  </div>
                </div>
              ))}
              <div className="hint-box small">
                Channel keys are managed by meshtasticd. Configure them in the Meshtastic app or with
                <span className="code"> meshtastic --seturl …</span>.
              </div>
            </div>
          </Card>

          <Card title="Node actions">
            <div className="stack">
              <Button size="sm" icon="refresh" busy={busy === 'nodes'} onClick={() => command('nodes', {}, 'Node database refreshed')} disabled={!running}>
                Refresh node database
              </Button>
              <Button size="sm" icon="gps" busy={busy === 'position'} onClick={() => command('requestPosition', { to: myInfo?.nodeId }, 'Position request sent')} disabled={!running}>
                Send my position now
              </Button>
              <Button size="sm" icon="activity" busy={busy === 'trace'} onClick={() => command('traceroute', { to: dm || undefined, hopLimit: 3 }, 'Traceroute requested')} disabled={!running || !dm}>
                Traceroute {dm ? 'to direct target' : '(pick a node first)'}
              </Button>
              <Button
                size="sm"
                variant="danger"
                icon="power"
                busy={busy === 'reboot'}
                disabled={!running}
                onClick={() => {
                  if (confirm('Reboot the LoRa node?')) command('reboot', {}, 'Node rebooting');
                }}
              >
                Reboot radio
              </Button>
            </div>
          </Card>

          <Card title="Bridge diagnostics" subtitle={`${meshtastic?.status || 'stopped'} · ${data.python?.binary || 'python missing'}`}>
            <pre className="log">
              {(meshtastic?.logs || []).slice(-14).map((entry: any) => `${new Date(entry.ts).toLocaleTimeString()} ${entry.level}: ${entry.line}`).join('\n') || 'No bridge output yet.'}
            </pre>
          </Card>
        </div>
      )}
    </div>
  );
}
