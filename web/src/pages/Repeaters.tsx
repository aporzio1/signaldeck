import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { fmtMHz } from '../format';
import { Badge, Button, Empty, Field, toast } from '../ui';

type Repeater = {
  id: string;
  name: string;
  city?: string;
  frequency: number;
  offset?: number | null;
  tone?: number | null;
  mode?: string;
  lat?: number | null;
  lon?: number | null;
  distanceMi?: number;
  bearingDeg?: number;
  source: string;
};

const compass = (deg?: number) =>
  deg == null ? '—' : ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];

export function RepeatersPage() {
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState('');
  const [editingSource, setEditingSource] = useState(false);
  const [locationDraft, setLocationDraft] = useState('');
  const [form, setForm] = useState({ name: '', frequency: '', offset: '', tone: '', mode: 'FM', city: '' });
  const [showForm, setShowForm] = useState(false);

  const load = () => {
    api.get('/repeaters').then((payload) => {
      setData(payload);
      setSource(payload?.source || '');
    }).catch((error: any) => toast(error.message, 'bad'));
  };
  useEffect(load, []);

  const qth = data?.qth;
  const repeaters: Repeater[] = data?.repeaters || [];

  const tune = async (entry: Repeater) => {
    try {
      await api.post('/sdr/tune', { frequency: entry.frequency, demod: 'nfm' });
      toast(`Tuned to ${fmtMHz(entry.frequency, 3)}`, 'good');
    } catch (error: any) {
      toast(error.message, 'bad');
    }
  };

  const useGps = async () => {
    try {
      const { state } = await api.get('/gps');
      const fix = state?.fix;
      if (!fix?.latitude || !fix?.longitude) return toast('No GPS fix yet', 'bad');
      await api.put('/repeaters/location', { lat: fix.latitude, lon: fix.longitude, label: 'GPS', source: 'gps' });
      load();
    } catch (error: any) {
      toast(error.message, 'bad');
    }
  };

  const setLocation = async () => {
    const m = locationDraft.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!m) return toast('Enter "latitude, longitude" (e.g. 26.12, -80.14)', 'bad');
    await api.put('/repeaters/location', { lat: Number(m[1]), lon: Number(m[2]), source: 'manual' })
      .then(load).catch((error: any) => toast(error.message, 'bad'));
  };

  const save = async () => {
    const freq = Number(form.frequency.replace(/[^\d.]/g, ''));
    if (!freq) return toast('Frequency in MHz required', 'bad');
    setBusy(true);
    try {
      await api.post('/repeaters', {
        name: form.name || fmtMHz(freq * 1e6, 3),
        frequency: freq,
        offset: form.offset || 0,
        tone: form.tone || null,
        mode: form.mode,
        city: form.city,
      });
      setShowForm(false);
      setForm({ name: '', frequency: '', offset: '', tone: '', mode: 'FM', city: '' });
      load();
    } catch (error: any) {
      toast(error.message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const remove = (id: string) => api.del(`/repeaters/${id}`).then(load).catch((e: any) => toast(e.message, 'bad'));

  const saveSource = async () => {
    await api.put('/repeaters/source', { url: source.trim() }).then(load)
      .catch((error: any) => toast(error.message, 'bad'));
    setEditingSource(false);
  };

  const saved = useMemo(() => repeaters.filter((r) => r.source === 'saved'), [repeaters]);
  const catalog = useMemo(() => repeaters.filter((r) => r.source !== 'saved'), [repeaters]);

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>Repeater book</h1>
          <p className="dim">Tune saved and nearby repeaters. Add entries manually or point at a JSON directory.</p>
        </div>
        <Button variant="primary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Close' : 'Add repeater'}
        </Button>
      </header>

      <div className="panel">
        <div className="panel-body loc-row">
          <span className="dim">Location</span>
          <strong>
            {qth ? `${qth.lat.toFixed(4)}, ${qth.lon.toFixed(4)} ${qth.label ? `(${qth.label})` : ''}` : 'not set'}
          </strong>
          <Button variant="ghost" onClick={useGps}>Use GPS</Button>
          <input className="input"
            value={locationDraft}
            placeholder="lat, lon"
            onChange={(event) => setLocationDraft(event.target.value)}
            style={{ width: 180 }}
          />
          <Button onClick={setLocation} disabled={!locationDraft.trim()}>Set</Button>
          <input className="input"
            type="number"
            defaultValue={data?.radiusMi ?? 50}
            min={1}
            max={200}
            style={{ width: 90 }}
            onChange={(event) => {
              const radius = Number(event.target.value);
              if (!Number.isFinite(radius) || radius < 1) return;
              api.get(`/repeaters?radius=${Math.min(200, radius)}`).then(setData).catch(() => undefined);
            }}
          />
          <span className="dim">mi radius</span>
        </div>
        <div className="panel-body loc-row">
          <span className="dim">Directory</span>
          {editingSource ? (
            <>
              <input className="input" value={source} onChange={(event) => setSource(event.target.value)} placeholder="https://example.com/repeaters.json" style={{ flex: 1 }} />
              <Button variant="primary" onClick={saveSource}>Save</Button>
            </>
          ) : (
            <>
              <code className="dim src-url">{source || 'none configured — entries below are manual'}</code>
              <Button onClick={() => setEditingSource(true)}>Edit</Button>
            </>
          )}
          {data?.sourceError && <Badge >{data.sourceError}</Badge>}
        </div>
      </div>

      {showForm && (
        <div className="panel">
          <div className="panel-body form-grid">
            <Field label="Name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="WR4AGC-3" /></Field>
            <Field label="Output MHz"><input className="input" value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })} placeholder="146.940" /></Field>
            <Field label="Offset MHz"><input className="input" value={form.offset} onChange={(e) => setForm({ ...form, offset: e.target.value })} placeholder="-0.6" /></Field>
            <Field label="Tone"><input className="input" value={form.tone} onChange={(e) => setForm({ ...form, tone: e.target.value })} placeholder="100.0" /></Field>
            <Field label="Mode">
              <select className="input" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
                {['FM', 'DSTAR', 'DMR', 'YSF', 'P25', 'NXDN', 'linear'].map((m) => <option key={m}>{m}</option>)}
              </select>
            </Field>
            <Field label="City"><input className="input" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} placeholder="West Palm Beach" /></Field>
            <Button variant="primary" onClick={save} disabled={busy}>Save entry</Button>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <h2>Book <span className="dim">({saved.length})</span></h2>
        </div>
        <div className="panel-body list">
          {saved.length === 0 && catalog.length === 0 && (
            <Empty title="Add a repeater or configure a directory to see entries here." />
          )}
          {repeaters.map((entry) => (
            <div key={entry.id} className="list-row">
              <button type="button" className="rep-main" onClick={() => tune(entry)} title="Tune the SDR">
                <span className="rep-freq">{fmtMHz(entry.frequency, 3)}</span>
                {entry.offset ? <span className="dim">{entry.offset > 0 ? '+' : '−'}{Math.abs((entry.offset ?? 0) / 1e6).toFixed(3)}</span> : null}
                {entry.tone ? <span className="dim">{entry.tone} Hz</span> : null}
                <span className="rep-name">{entry.name}</span>
                {entry.distanceMi != null && (
                  <span className="dim">{compass(entry.bearingDeg)} {entry.distanceMi.toFixed(1)} mi</span>
                )}
              </button>
              <span className={`badge ${entry.source === 'saved' ? 'ok' : 'info'}`}>{entry.source === 'saved' ? 'saved' : 'catalog'}</span>
              {entry.source === 'saved' && (
                <button type="button" className="row-del" onClick={() => remove(entry.id)} aria-label={`Remove ${entry.name}`}>
                  <Icon name="x" size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
