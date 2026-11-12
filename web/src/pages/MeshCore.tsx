import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { fmtAgo, fmtTime } from '../format';
import { Badge, Button, Card, Empty, Field, Select, Stat, Tabs, toast } from '../ui';
import { live } from '../ws';

export function MeshCorePage() {
  const [data, setData] = useState<any>(null);
  const [tab, setTab] = useState<'messages' | 'contacts' | 'settings'>('messages');
  const [target, setTarget] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState<any>({});
  const chatRef = useRef<HTMLDivElement>(null);

  const refresh = () =>
    api.get('/mesh').then((payload) => {
      setData(payload);
      setForm((prev: any) => (Object.keys(prev).length ? prev : payload.meshcore?.endpoint || {}));
    }).catch((error) => toast(error.message, 'bad'));

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    const unsubscribe = live.subscribe(['mesh'], (payload) => {
      if (payload.kind !== 'meshcore') return;
      if (payload.event?.type === 'message') {
        setData((prev: any) =>
          prev ? { ...prev, meshcore: { ...prev.meshcore, messages: [...prev.meshcore.messages, payload.event].slice(-500) } } : prev,
        );
      } else if (payload.event?.type === 'contacts' || payload.event?.type === 'ready') {
        refresh();
      } else if (payload.state) {
        setData((prev: any) => (prev ? { ...prev, meshcore: { ...prev.meshcore, ...payload.state } } : prev));
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (tab === 'messages') chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
  }, [data?.meshcore?.messages?.length, tab, target]);

  const meshcore = data?.meshcore;
  const running = meshcore?.running;
  const self = meshcore?.self;
  const contacts = meshcore?.contacts || [];
  const channels = meshcore?.channels || [];

  const threads = useMemo(() => {
    const options = [{ value: '', label: 'All traffic' }];
    for (const channel of channels) options.push({ value: `c:${channel.index}`, label: `# ${channel.name || channel.index}` });
    for (const contact of contacts) options.push({ value: `d:${contact.id}`, label: contact.name || contact.id?.slice(0, 10) });
    return options;
  }, [channels, contacts]);

  const messages = useMemo(() => {
    const list = meshcore?.messages || [];
    if (!target) return list;
    const [kind, value] = target.split(':');
    if (kind === 'c') return list.filter((message: any) => String(message.channel) === value || message.kind === 'channel');
    return list.filter((message: any) => message.from === value || message.to === value);
  }, [meshcore?.messages, target]);

  const send = async () => {
    if (!draft.trim()) return;
    setBusy('send');
    try {
      const [kind, value] = target.split(':');
      await api.post('/mesh/meshcore/send', {
        text: draft.trim(),
        channel: kind === 'c' ? Number(value) : 0,
        to: kind === 'd' ? value : null,
      });
      setDraft('');
      toast('Message sent', 'good');
    } catch (error: any) {
      toast(error.message, 'bad');
    } finally {
      setBusy('');
    }
  };

  const start = async (action: 'start' | 'stop') => {
    setBusy(action);
    try {
      await api.post(`/mesh/meshcore/${action}`);
      await refresh();
      toast(action === 'start' ? 'Connecting to MeshCore' : 'Bridge stopped');
    } catch (error: any) {
      toast(error.message, 'bad');
    } finally {
      setBusy('');
    }
  };

  const command = async (cmd: string, message: string) => {
    setBusy(cmd);
    try {
      await api.post('/mesh/meshcore/command', { cmd });
      toast(message, 'good');
      await refresh();
    } catch (error: any) {
      toast(error.message, 'bad');
    } finally {
      setBusy('');
    }
  };

  if (!data) return <Empty title="Loading MeshCore state…" />;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">MeshCore</h1>
          <p className="page-desc">
            Companion, room-server and repeater messaging. SignalDeck attaches to a MeshCore companion over TCP or serial.
          </p>
        </div>
        <div className="row">
          <Badge tone={running ? 'good' : 'warn'} dot>{running ? 'Connected' : 'Offline'}</Badge>
          {running ? (
            <Button size="sm" icon="stop" busy={busy === 'stop'} onClick={() => start('stop')}>Disconnect</Button>
          ) : (
            <Button size="sm" variant="primary" icon="play" busy={busy === 'start'} onClick={() => start('start')}>Connect</Button>
          )}
        </div>
      </div>

      {meshcore?.lastError && <div className="alert warn small">{meshcore.lastError}</div>}

      <div className="grid three">
        <Card><Stat label="Identity" value={self?.name || self?.adv_name || '—'} hint={self?.public_key ? String(self.public_key).slice(0, 18) + '…' : ''} size="sm" /></Card>
        <Card><Stat label="Contacts" value={contacts.length} hint={`${channels.length} channels`} /></Card>
        <Card><Stat label="Last packet" value={meshcore?.lastMessage ? fmtAgo((meshcore.lastMessage.time || 0) * 1000) : '—'} size="sm" /></Card>
      </div>

      {!running && (
        <Card title="Companion endpoint" subtitle="MeshCore is not connected">
          <div className="stack small">
            <p className="muted">
              Point SignalDeck at a USB-serial companion, a Wi-Fi companion on TCP, or a local
              <span className="code"> meshcore-pi</span> instance bound to the HAT radio.
            </p>
            <div className="row tight">
              <Badge tone={data.python?.meshcore ? 'good' : 'bad'} dot>
                meshcore python {data.python?.meshcore ? 'installed' : 'missing'}
              </Badge>
              <a className="btn btn-sm btn-ghost" href="#/settings">Radio mode</a>
            </div>
          </div>
        </Card>
      )}

      <Tabs
        value={tab}
        onChange={(next) => setTab(next as any)}
        tabs={[
          { id: 'messages', label: 'Messages' },
          { id: 'contacts', label: `Contacts · ${contacts.length}` },
          { id: 'settings', label: 'Connection' },
        ]}
      />

      {tab === 'messages' && (
        <Card
          title={target ? threads.find((thread) => thread.value === target)?.label : 'All traffic'}
          subtitle="Direct messages and channel chatter"
          flush
          actions={<Select value={target} onChange={setTarget} options={threads} />}
        >
          <div className="chat" ref={chatRef}>
            {messages.map((message: any, index: number) => (
              <div key={index} className="bubble">
                <div className="bubble-head">
                  <strong style={{ color: 'var(--muted)' }}>
                    {message.fromName || message.from || (message.kind === 'channel' ? `channel ${message.channel}` : 'unknown')}
                  </strong>
                  <span>{fmtTime((message.time || 0) * 1000)}</span>
                  {message.kind === 'channel' && <span>ch {message.channel}</span>}
                </div>
                <div className="bubble-text">{message.text || JSON.stringify(message.payload || {})}</div>
              </div>
            ))}
            {!messages.length && <Empty title="No messages yet" hint="MeshCore packets appear here once the bridge is connected." />}
          </div>
          <div className="composer">
            <input
              className="input"
              placeholder="Message MeshCore…"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') send();
              }}
            />
            <Button variant="primary" icon="send" busy={busy === 'send'} onClick={send} disabled={!running}>Send</Button>
          </div>
        </Card>
      )}

      {tab === 'contacts' && (
        <Card
          title="Contacts"
          subtitle="Adverts heard on the mesh"
          flush
          actions={<Button size="sm" icon="refresh" busy={busy === 'contacts'} onClick={() => command('contacts', 'Contacts refreshed')}>Refresh</Button>}
        >
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Name</th><th>Type</th><th>Key</th><th>Last advert</th><th>Path</th><th></th></tr></thead>
              <tbody>
                {contacts.map((contact: any) => (
                  <tr key={contact.id}>
                    <td>{contact.name || '—'}</td>
                    <td><Badge>{contact.type ?? 'node'}</Badge></td>
                    <td className="mono dim">{contact.id ? String(contact.id).slice(0, 12) : '—'}</td>
                    <td className="dim">{contact.lastAdvert ? new Date(contact.lastAdvert * 1000).toLocaleString() : '—'}</td>
                    <td className="mono dim">{contact.outPath ?? '—'}</td>
                    <td className="right">
                      <Button size="sm" variant="ghost" icon="message" onClick={() => { setTarget(`d:${contact.id}`); setTab('messages'); }}>
                        Message
                      </Button>
                    </td>
                  </tr>
                ))}
                {!contacts.length && <tr><td colSpan={6}><Empty title="No contacts" hint="Send an advert or wait for nearby nodes." /></td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {tab === 'settings' && (
        <div className="grid two">
          <Card title="Transport" subtitle="How SignalDeck reaches the companion">
            <div className="stack">
              <Field label="Connection type">
                <Select
                  value={data.meshcore?.transport || 'tcp'}
                  onChange={(value) => setData((prev: any) => ({ ...prev, meshcore: { ...prev.meshcore, transport: value } }))}
                  options={[
                    { value: 'tcp', label: 'TCP (Wi-Fi companion)' },
                    { value: 'serial', label: 'USB serial' },
                  ]}
                />
              </Field>
              <div className="form-row">
                <Field label="Host">
                  <input className="input mono" defaultValue="127.0.0.1" onChange={(event) => setForm({ ...form, host: event.target.value })} />
                </Field>
                <Field label="Port">
                  <input className="input mono" defaultValue="5000" onChange={(event) => setForm({ ...form, port: Number(event.target.value) })} />
                </Field>
              </div>
              <div className="form-row">
                <Field label="Serial device" hint="Used when transport is serial">
                  <input className="input mono" defaultValue="/dev/ttyACM0" onChange={(event) => setForm({ ...form, serialPath: event.target.value })} />
                </Field>
                <Field label="Baud">
                  <input className="input mono" defaultValue="115200" onChange={(event) => setForm({ ...form, baud: Number(event.target.value) })} />
                </Field>
              </div>
              <div className="row">
                <Button
                  variant="primary"
                  onClick={async () => {
                    try {
                      await api.put('/mesh/meshcore/config', { ...form, transport: data.meshcore?.transport });
                      await api.post('/mesh/meshcore/stop');
                      await api.post('/mesh/meshcore/start');
                      await refresh();
                      toast('Endpoint updated', 'good');
                    } catch (error: any) {
                      toast(error.message, 'bad');
                    }
                  }}
                >
                  Save & reconnect
                </Button>
                <Button size="sm" busy={busy === 'advert'} onClick={() => command('advert', 'Advert sent')} disabled={!running}>
                  Send advert
                </Button>
                <Button size="sm" busy={busy === 'battery'} onClick={() => command('battery', 'Battery status refreshed')} disabled={!running}>
                  Battery
                </Button>
              </div>
              <div className="hint-box small">
                The SX1262 can only be driven by one stack at a time. Choose <strong>Meshtastic</strong> or
                <strong> MeshCore</strong> under Settings, or run MeshCore through a separate companion radio.
              </div>
            </div>
          </Card>

          <Card title="Bridge diagnostics" subtitle={meshcore?.status || 'stopped'}>
            <pre className="log">
              {(meshcore?.logs || []).slice(-16).map((entry: any) => `${new Date(entry.ts).toLocaleTimeString()} ${entry.level}: ${entry.line}`).join('\n') || 'No bridge output yet.'}
            </pre>
          </Card>
        </div>
      )}
    </div>
  );
}
