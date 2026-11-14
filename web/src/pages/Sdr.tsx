import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { DEMODS, SAMPLE_RATES, fmtHz, fmtHzLong, fmtMHz } from '../format';
import { Icon } from '../icons';
import { getEngine } from '../sdr/shared';
import { live } from '../ws';
import { Badge, Button, Card, Empty, Field, Modal, Select, Slider, Tabs, Toggle, toast } from '../ui';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function levelColor(db: number): [number, number, number] {
  const stops: Array<[number, [number, number, number]]> = [
    [-105, [2, 4, 10]],
    [-85, [12, 28, 70]],
    [-70, [10, 90, 130]],
    [-55, [20, 190, 170]],
    [-42, [150, 225, 90]],
    [-30, [250, 220, 110]],
    [-18, [255, 255, 235]],
  ];
  if (db <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (db <= stops[i][0]) {
      const [d0, c0] = stops[i - 1];
      const [d1, c1] = stops[i];
      const t = (db - d0) / (d1 - d0);
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
    }
  }
  return stops[stops.length - 1][1];
}

export function SdrPage() {
  const [data, setData] = useState<any>(null);
  const [state, setState] = useState<any>(null);
  const stateRef = useRef<any>(null);
  const [meter, setMeter] = useState({ db: -110, open: false });
  const meterRef = useRef({ db: -110, open: false });
  const [listening, setListening] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [scanning, setScanning] = useState(false);
  const [scanResults, setScanResults] = useState<any[]>([]);
  const [presetModal, setPresetModal] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [freqInput, setFreqInput] = useState('');
  const [busy, setBusy] = useState('');
  const [tab, setTab] = useState<'receiver' | 'scanner' | 'advanced'>('receiver');
  const [deviceInfo, setDeviceInfo] = useState<any>(null);
  const [autoGain, setAutoGain] = useState(true);

  const engineRef = useRef<ReturnType<typeof getEngine> | null>(null);
  const [recorderError, setRecorderError] = useState('');
  const spectrumRef = useRef<{ bins: Float32Array; sampleRate: number; at: number } | null>(null);
  const specCanvasRef = useRef<HTMLCanvasElement>(null);
  const waterfallRef = useRef<HTMLCanvasElement>(null);
  const binsRef = useRef<Float32Array | null>(null);
  const maxHoldRef = useRef<Float32Array | null>(null);
  const zoomRef = useRef(1);
  const lastLocalRef = useRef(0);
  const scanStopRef = useRef(false);
  const rafRef = useRef(0);
  const lastRowRef = useRef(0);

  zoomRef.current = zoom;
  stateRef.current = state;
  meterRef.current = meter;

  useEffect(() => {
    api.get('/sdr').then((payload) => {
      setData(payload);
      setState(payload.state);
      setAutoGain(payload.state.gainMode !== 'manual');
    }).catch((error) => toast(error.message, 'bad'));
  }, []);

  useEffect(() => {
    const unsubscribe = live.subscribe(['sdr'], (next) => {
      if (Date.now() - lastLocalRef.current < 1200) return;
      setState((prev: any) => ({ ...prev, ...next }));
      setAutoGain(next.gainMode !== 'manual');
    });
    return unsubscribe;
  }, []);

  // engine lifecycle: shared across pages so audio survives navigation
  useEffect(() => {
    const engine = getEngine();
    engineRef.current = engine;
    engine.onSpectrum = (bins, sampleRate) => {
      binsRef.current = bins;
      spectrumRef.current = { bins, sampleRate, at: performance.now() };
      const hold = maxHoldRef.current;
      if (!hold || hold.length !== bins.length) maxHoldRef.current = Float32Array.from(bins);
      else for (let i = 0; i < bins.length; i++) hold[i] = Math.max(hold[i] - 0.12, bins[i]);
    };
    engine.onMeter = (next) => {
      setMeter({ db: next.db, open: next.open });
    };
    engine.start();
    return () => {
      engine.onSpectrum = null;
      engine.onMeter = null;
      engineRef.current = null;
    };
  }, []);

  // keep the demodulator and audio in sync with server state
  useEffect(() => {
    if (!state) return;
    engineRef.current?.configure({
      sampleRate: state.sampleRate,
      demod: state.demod,
      squelch: state.squelch ?? -70,
      volume: state.volume ?? 0.8,
    });
  }, [state?.sampleRate, state?.demod, state?.squelch, state?.volume]);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => {
      setRecordSeconds(engineRef.current?.recordedSeconds || 0);
    }, 250);
    return () => clearInterval(timer);
  }, [recording]);

  // spectrum + waterfall rendering
  useEffect(() => {
    const draw = () => {
      rafRef.current = requestAnimationFrame(draw);
      const canvas = specCanvasRef.current;
      const frame = spectrumRef.current;
      if (!canvas || !frame) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#05070a';
      ctx.fillRect(0, 0, width, height);

      const bins = frame.bins;
      const zoomFactor = zoomRef.current;
      const visible = Math.floor(bins.length / zoomFactor);
      const start = Math.floor((bins.length - visible) / 2);
      const dbTop = -5;
      const dbBottom = -105;
      const toY = (db: number) => height - ((Math.max(dbBottom, Math.min(dbTop, db)) - dbBottom) / (dbTop - dbBottom)) * height;

      // grid
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.fillStyle = 'rgba(150,170,190,0.75)';
      ctx.font = '10px ui-monospace, monospace';
      ctx.lineWidth = 1;
      const current = stateRef.current;
      const span = (current?.sampleRate || frame.sampleRate) / zoomFactor;
      const center = current?.frequency || 0;
      for (let i = 0; i <= 8; i++) {
        const x = (i / 8) * width;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
        if (i % 2 === 0) {
          const freq = center - span / 2 + (i / 8) * span;
          const label = Math.abs(freq) >= 1e6 ? `${(freq / 1e6).toFixed(3)}` : `${(freq / 1e3).toFixed(0)}k`;
          ctx.fillText(label, Math.min(width - 42, Math.max(2, x + 3)), height - 4);
        }
      }
      for (let db = -20; db >= -100; db -= 20) {
        const y = toY(db);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
        ctx.fillText(`${db}`, 3, y - 2);
      }

      // passband
      const bandwidth = current?.demod === 'wfm' ? 180000 : current?.demod === 'am' ? 12000 : 12500;
      const pbWidth = Math.min(width, (bandwidth / span) * width);
      ctx.fillStyle = 'rgba(45,212,191,0.06)';
      ctx.fillRect(width / 2 - pbWidth / 2, 0, pbWidth, height);
      ctx.strokeStyle = 'rgba(45,212,191,0.35)';
      ctx.beginPath();
      ctx.moveTo(width / 2, 0);
      ctx.lineTo(width / 2, height);
      ctx.stroke();

      // spectrum trace
      const gradient = ctx.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, 'rgba(45,212,191,0.34)');
      gradient.addColorStop(1, 'rgba(45,212,191,0.02)');
      ctx.beginPath();
      for (let x = 0; x < width; x++) {
        const bin = start + Math.floor((x / width) * visible);
        const db = bins[Math.min(bins.length - 1, Math.max(0, bin))] ?? dbBottom;
        const y = toY(db);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = '#5eead4';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.lineTo(width, height);
      ctx.lineTo(0, height);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();

      const hold = maxHoldRef.current;
      if (hold) {
        ctx.beginPath();
        for (let x = 0; x < width; x++) {
          const bin = start + Math.floor((x / width) * visible);
          const y = toY(hold[Math.min(hold.length - 1, Math.max(0, bin))] ?? dbBottom);
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = 'rgba(96,165,250,0.32)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // waterfall
      const wf = waterfallRef.current;
      if (wf && performance.now() - lastRowRef.current > 55) {
        lastRowRef.current = performance.now();
        const wfWidth = wf.clientWidth;
        if (wf.width !== wfWidth || wf.height < 10) {
          wf.width = Math.max(1, wfWidth);
          wf.height = Math.max(10, wf.clientHeight);
        }
        const wfCtx = wf.getContext('2d');
        if (wfCtx) {
          wfCtx.drawImage(wf, 0, 1);
          const row = wfCtx.createImageData(wf.width, 1);
          for (let x = 0; x < wf.width; x++) {
            const bin = start + Math.floor((x / wf.width) * visible);
            const db = bins[Math.min(bins.length - 1, Math.max(0, bin))] ?? dbBottom;
            const [r, g, b] = levelColor(db);
            row.data[x * 4] = r;
            row.data[x * 4 + 1] = g;
            row.data[x * 4 + 2] = b;
            row.data[x * 4 + 3] = 255;
          }
          wfCtx.putImageData(row, 0, 0);
        }
      }
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  const apply = async (patch: any, immediate = false) => {
    lastLocalRef.current = Date.now();
    setState((prev: any) => ({ ...prev, ...patch }));
    if (immediate) clearTimeout((apply as any).timer);
    const fire = async () => {
      try {
        const next = await api.post('/sdr/tune', patch);
        setState((prev: any) => ({ ...prev, ...next }));
        if (patch.gainMode) setAutoGain(patch.gainMode !== 'manual');
      } catch (error: any) {
        toast(error.message, 'bad');
      }
    };
    if (immediate) return fire();
    clearTimeout((apply as any).timer);
    (apply as any).timer = setTimeout(fire, 70);
  };

  const tunedFrequency = freqInput || (state ? fmtMHz(state.frequency, 6) : '');
  useEffect(() => {
    if (state?.frequency) setFreqInput(fmtMHz(state.frequency, 6));
  }, [state?.frequency]);

  const tuneTo = (frequency: number, extra: any = {}) => {
    const rounded = Math.max(24000, Math.min(1766000000, Math.round(frequency)));
    apply({ frequency: rounded, ...extra }, true);
  };

  const nudge = (delta: number) => {
    if (!state) return;
    tuneTo(state.frequency + delta);
  };

  const commitFreq = () => {
    const mhz = Number(freqInput);
    if (!Number.isFinite(mhz)) {
      toast('Enter a frequency in MHz', 'bad');
      return;
    }
    tuneTo(mhz * 1e6);
  };

  const pointerTune = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const fraction = (event.clientX - rect.left) / rect.width;
    const span = (state?.sampleRate || 1024000) / zoom;
    tuneTo((state?.frequency || 0) + (fraction - 0.5) * span);
  };

  const startStop = async () => {
    setBusy('power');
    try {
      if (state?.running) {
        await api.post('/sdr/stop');
        setState((prev: any) => ({ ...prev, running: false, source: 'idle' }));
        toast('Receiver stopped');
      } else {
        const next = await api.post('/sdr/start', {
          frequency: state?.frequency,
          sampleRate: state?.sampleRate,
          demod: state?.demod,
          biasTee: state?.biasTee,
          directSampling: state?.directSampling,
        });
        setState((prev: any) => ({ ...prev, ...next }));
        toast(`Receiver started (${next.source === 'mock' ? 'demo source' : 'RTL-SDR'})`, 'good');
      }
    } catch (error: any) {
      toast(error.message, 'bad');
    } finally {
      setBusy('');
    }
  };

  const toggleListen = async () => {
    const engine = engineRef.current;
    if (!engine) return;
    if (listening) {
      await engine.disableAudio();
      setListening(false);
    } else {
      await engine.enableAudio();
      engine.configure({ volume: state?.volume ?? 0.8, squelch: state?.squelch ?? -70, demod: state?.demod });
      setListening(true);
    }
  };

  const toggleRecord = () => {
    const engine = engineRef.current;
    if (!engine) return;
    if (!recording) {
      engine.startRecording();
      setRecorderError('');
      setRecording(true);
      setRecordSeconds(0);
      toast('Recording audio');
    } else {
      const blob = engine.stopRecording();
      setRecording(false);
      if (blob) {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `signaldeck-${fmtMHz(state?.frequency, 3)}MHz-${Date.now()}.wav`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        toast('Recording downloaded', 'good');
      }
    }
  };

  const runScan = async () => {
    if (scanning) {
      scanStopRef.current = true;
      setScanning(false);
      return;
    }
    const channels = data?.scanChannels || [];
    if (!channels.length) {
      toast('Add scanner channels first', 'bad');
      return;
    }
    setScanResults([]);
    scanStopRef.current = false;
    setScanning(true);
    for (const channel of channels) {
      if (scanStopRef.current) break;
      lastLocalRef.current = Date.now();
      await api.post('/sdr/tune', { frequency: channel.frequency, demod: channel.demod }).catch(() => {});
      setState((prev: any) => ({ ...prev, frequency: channel.frequency, demod: channel.demod }));
      await sleep(1100);
      const reading = { ...meterRef.current };
      setScanResults((prev) => [
        { ...channel, db: reading.db, hit: reading.db > (state?.squelch ?? -70), at: Date.now() },
        ...prev,
      ].slice(0, 40));
    }
    setScanning(false);
  };

  const savePreset = async () => {
    if (!presetName.trim() || !state) return;
    try {
      await api.post('/sdr/presets', {
        name: presetName,
        frequency: state.frequency,
        demod: state.demod,
        sampleRate: state.sampleRate,
      });
      setPresetModal(false);
      setPresetName('');
      const payload = await api.get('/sdr');
      setData(payload);
      toast('Preset saved', 'good');
    } catch (error: any) {
      toast(error.message, 'bad');
    }
  };

  const removePreset = async (id: string) => {
    await api.del(`/sdr/presets/${id}`);
    setData((prev: any) => ({ ...prev, presets: prev.presets.filter((p: any) => p.id !== id) }));
  };

  const addChannel = async () => {
    if (!state) return;
    const channels = [
      ...(data.scanChannels || []),
      { name: fmtMHz(state.frequency, 3), frequency: state.frequency, demod: state.demod },
    ];
    try {
      const next = await api.put('/sdr/scan-channels', { channels });
      setData((prev: any) => ({ ...prev, scanChannels: next }));
      toast('Channel added to scanner', 'good');
    } catch (error: any) {
      toast(error.message, 'bad');
    }
  };

  const removeChannel = async (id: string) => {
    const channels = (data.scanChannels || []).filter((channel: any) => channel.id !== id);
    const next = await api.put('/sdr/scan-channels', { channels });
    setData((prev: any) => ({ ...prev, scanChannels: next }));
  };

  const signalBars = useMemo(() => {
    const normalized = Math.max(0, Math.min(1, (meter.db + 105) / 95));
    return Math.round(normalized * 12);
  }, [meter.db]);

  if (!state) return <Empty title="Loading SDR state…" />;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Spectrum console</h1>
          <p className="page-desc">
            Live IQ from the RTL2832U + R860. Tap the spectrum to tune, drag to explore, scroll to zoom.
          </p>
        </div>
        <div className="row">
          <Badge tone={state.running ? 'good' : ''} dot>
            {state.running ? (state.source === 'mock' ? 'Demo IQ' : 'RTL-SDR live') : 'Receiver offline'}
          </Badge>
          <Button icon={state.running ? 'stop' : 'play'} variant={state.running ? '' : 'primary'} busy={busy === 'power'} onClick={startStop}>
            {state.running ? 'Stop' : 'Start'}
          </Button>
        </div>
      </div>

      <Card>
        <div className="stack">
          <div className="spread" style={{ alignItems: 'flex-end' }}>
            <div>
              <div className="sdr-readout">
                <input
                  className="input mono"
                  style={{ fontSize: 26, fontWeight: 600, maxWidth: 230, minHeight: 46, letterSpacing: '-0.02em' }}
                  value={tunedFrequency}
                  onChange={(event) => setFreqInput(event.target.value)}
                  onBlur={commitFreq}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
                  }}
                  inputMode="decimal"
                  aria-label="Frequency in MHz"
                />
                <span className="muted" style={{ fontSize: 15 }}>MHz</span>
              </div>
              <div className="dim mono tiny" style={{ marginTop: 4 }}>
                {fmtHzLong(state.frequency)} Hz · {fmtHz(state.frequency, 6)}
              </div>
            </div>
            <div className="row tight">
              <Button size="sm" onClick={() => nudge(-(state.step || 25000))}>−</Button>
              <Select
                value={String(state.step || 25000)}
                onChange={(value) => {
                  const step = Number(value);
                  apply({ step });
                  api.put('/settings', { sdr: { step } }).catch(() => {});
                }}
                options={[1000, 5000, 12500, 25000, 100000, 1000000].map((step) => ({
                  value: String(step),
                  label: step >= 1e6 ? '1 MHz' : step >= 1000 ? `${step / 1000} kHz` : `${step} Hz`,
                }))}
              />
              <Button size="sm" onClick={() => nudge(state.step || 25000)}>+</Button>
              <Button size="sm" variant={listening ? 'primary' : ''} icon={listening ? 'volume' : 'volume'} onClick={toggleListen}>
                {listening ? 'Listening' : 'Listen'}
              </Button>
              <Button size="sm" variant={recording ? 'danger' : ''} icon={recording ? 'stop' : 'record'} onClick={toggleRecord}>
                {recording ? `${recordSeconds.toFixed(0)}s` : 'Record'}
              </Button>
            </div>
          </div>

          <div className="band-chips">
            {(data.bands || []).map((band: any) => {
              const mid = (band.start + band.end) / 2;
              const active = state.frequency >= band.start && state.frequency <= band.end;
              return (
                <button
                  key={band.id}
                  className={`chip ${active ? 'active' : ''}`}
                  onClick={() => tuneTo(mid)}
                  title={`${fmtHz(band.start, 0)} – ${fmtHz(band.end, 0)} · ${band.hint}`}
                >
                  {band.name}
                </button>
              );
            })}
            <button className="chip" onClick={() => setPresetModal(true)}>
              + Save preset
            </button>
          </div>

          <div className="sdr-stage">
            <canvas
              ref={specCanvasRef}
              className="sdr-spectrum"
              onPointerDown={(event) => {
                (event.target as HTMLElement).setPointerCapture(event.pointerId);
                pointerTune(event);
              }}
              onPointerMove={(event) => {
                if (event.buttons === 1) pointerTune(event);
              }}
              onWheel={(event) => {
                event.preventDefault();
                setZoom((prev) => Math.max(1, Math.min(8, prev * (event.deltaY > 0 ? 1.25 : 0.8))));
                maxHoldRef.current = null;
              }}
            />
            <canvas ref={waterfallRef} className="sdr-waterfall" />
            <div className="sdr-overlay">
              <span>
                span {(state.sampleRate / zoom / 1000).toFixed(0)} kHz · {(state.sampleRate / 1e6).toFixed(3)} MS/s · zoom {zoom.toFixed(1)}×
              </span>
              <span>{state.demod?.toUpperCase()}</span>
            </div>
          </div>

          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="signal-meter">
              <div className="signal-bars">
                {Array.from({ length: 12 }, (_, index) => (
                  <i key={index} className={index < signalBars ? 'on' : ''} style={{ height: 6 + index * 1.35 }} />
                ))}
              </div>
              <span className="mono small">{meter.db.toFixed(0)} dB</span>
              <Badge tone={meter.open ? 'accent' : ''}>{meter.open ? 'squelch open' : 'muted'}</Badge>
            </div>
            <div className="row tight">
              <Button size="sm" variant="ghost" icon="refresh" onClick={() => { maxHoldRef.current = null; }}>Clear hold</Button>
              <Button size="sm" variant="ghost" icon="scan" onClick={() => api.get('/sdr/devices').then(setDeviceInfo)}>
                Detect device
              </Button>
            </div>
          </div>

          {(data.presets || []).length > 0 && (
            <div className="band-chips">
              {(data.presets || []).map((preset: any) => (
                <span key={preset.id} className="chip" style={{ display: 'inline-flex', gap: 7, alignItems: 'center' }}>
                  <button
                    style={{ background: 'none', border: 0, color: 'inherit', padding: 0, cursor: 'pointer', font: 'inherit' }}
                    onClick={() => { tuneTo(preset.frequency, { demod: preset.demod, sampleRate: preset.sampleRate }); }}
                  >
                    {preset.name}
                  </button>
                  <button
                    style={{ background: 'none', border: 0, color: 'var(--dim)', cursor: 'pointer', padding: 0 }}
                    onClick={() => removePreset(preset.id)}
                    aria-label={`Remove ${preset.name}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </Card>

      <Tabs
        value={tab}
        onChange={(next) => setTab(next as any)}
        tabs={[
          { id: 'receiver', label: 'Receiver' },
          { id: 'scanner', label: `Scanner${scanning ? ' · running' : ''}` },
          { id: 'advanced', label: 'Advanced' },
        ]}
      />

      {tab === 'receiver' && (
        <div className="grid two">
          <Card title="Demodulation" subtitle="Audio is decoded in your browser from raw IQ">
            <div className="stack">
              <div className="band-chips">
                {DEMODS.map((mode) => (
                  <button
                    key={mode.id}
                    className={`chip ${state.demod === mode.id ? 'active' : ''}`}
                    onClick={() => apply({ demod: mode.id }, true)}
                    title={mode.hint}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
              <Slider
                label="Squelch"
                value={state.squelch ?? -70}
                min={-105}
                max={-20}
                step={1}
                onChange={(value) => apply({ squelch: value })}
                format={(value) => `${value} dB`}
                hint="Signals below this level are muted. Lower it to hear weaker stations."
              />
              <Slider
                label="Volume"
                value={state.volume ?? 0.8}
                min={0}
                max={1}
                step={0.02}
                onChange={(value) => apply({ volume: value })}
                format={(value) => `${Math.round(value * 100)}%`}
              />
              {recorderError && <div className="alert warn small">{recorderError}</div>}
              <div className="row">
                <Button size="sm" variant={listening ? 'primary' : ''} icon="volume" onClick={toggleListen}>
                  {listening ? 'Audio on' : 'Enable audio'}
                </Button>
                <span className="dim tiny">Audio starts from this gesture (browser autoplay rules).</span>
              </div>
            </div>
          </Card>

          <Card title="Front end" subtitle="Gain, correction and HAT options">
            <div className="stack">
              <Toggle
                label="Automatic gain"
                hint="Let the R860 AGC pick gain. Disable for weak-signal work."
                checked={autoGain}
                onChange={(checked) => {
                  setAutoGain(checked);
                  apply({ gainMode: checked ? 'auto' : 'manual' }, true);
                }}
              />
              <Slider
                label="Manual gain"
                value={state.gain ?? 280}
                min={0}
                max={500}
                step={10}
                disabled={autoGain}
                onChange={(value) => apply({ gain: value })}
                format={(value) => `${(value / 10).toFixed(1)} dB`}
              />
              <Slider
                label="Frequency correction"
                value={state.ppm ?? 0}
                min={-100}
                max={100}
                step={1}
                onChange={(value) => apply({ ppm: value })}
                format={(value) => `${value > 0 ? '+' : ''}${value} ppm`}
                hint="Trim the TCXO. 1 ppm ≈ 100 Hz at 100 MHz."
              />
              <div className="form-row">
                <Field label="Sample rate">
                  <Select
                    value={String(state.sampleRate)}
                    onChange={(value) => apply({ sampleRate: Number(value) }, true)}
                    options={SAMPLE_RATES.map((rate) => ({
                      value: String(rate),
                      label: `${(rate / 1e6).toFixed(3)} MS/s · ${((rate * 2) / 1e6).toFixed(1)} MB/s`,
                    }))}
                  />
                </Field>
                <Field label="Direct sampling" hint="HF 0.1–28.8 MHz">
                  <Select
                    value={String(state.directSampling || 0)}
                    onChange={(value) => apply({ directSampling: Number(value) }, true)}
                    options={[
                      { value: '0', label: 'Off (normal)' },
                      { value: '1', label: 'I branch' },
                      { value: '2', label: 'Q branch (usual)' },
                    ]}
                  />
                </Field>
              </div>
              <Toggle
                label="5 V bias tee"
                hint="Powers an inline LNA or active antenna through the coax. Never enable with a DC-shorted antenna."
                checked={Boolean(state.biasTee)}
                onChange={(checked) => apply({ biasTee: checked }, true)}
              />
              <div className="row tight">
                <Toggle label="RTL AGC" checked={Boolean(state.agc)} onChange={(checked) => apply({ agc: checked }, true)} />
                <Toggle label="Offset tuning" checked={Boolean(state.offsetTuning)} onChange={(checked) => apply({ offsetTuning: checked }, true)} />
              </div>
            </div>
          </Card>
        </div>
      )}

      {tab === 'scanner' && (
        <Card
          title="Channel scanner"
          subtitle="Steps through your list, measuring signal strength at each stop"
          actions={
            <div className="row tight">
              <Button size="sm" icon="plus" onClick={addChannel}>Add current</Button>
              <Button size="sm" variant={scanning ? 'danger' : 'primary'} icon={scanning ? 'stop' : 'scan'} onClick={runScan}>
                {scanning ? 'Stop scan' : 'Start scan'}
              </Button>
            </div>
          }
          flush
        >
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>Frequency</th>
                  <th>Mode</th>
                  <th>Last reading</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(data.scanChannels || []).map((channel: any) => (
                  <tr key={channel.id}>
                    <td>{channel.name}</td>
                    <td className="mono">{fmtHz(channel.frequency, 4)}</td>
                    <td>{channel.demod?.toUpperCase()}</td>
                    <td>
                      {scanResults.find((result) => result.id === channel.id) ? (
                        <span className={scanResults.find((result) => result.id === channel.id)?.hit ? '' : 'dim'}>
                          {scanResults.find((result) => result.id === channel.id)?.db.toFixed(0)} dB
                        </span>
                      ) : (
                        <span className="dim">—</span>
                      )}
                    </td>
                    <td className="right">
                      <Button size="sm" variant="ghost" icon="trash" onClick={() => removeChannel(channel.id)} aria-label="Remove" />
                    </td>
                  </tr>
                ))}
                {!data.scanChannels?.length && (
                  <tr>
                    <td colSpan={5}><Empty title="No scanner channels" hint="Tune somewhere interesting and press Add current." /></td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {scanResults.length > 0 && (
            <div style={{ padding: '10px 14px', borderTop: '1px solid var(--line)' }}>
              <div className="tiny dim" style={{ marginBottom: 6 }}>HITS</div>
              <div className="row tight">
                {scanResults.slice(0, 12).map((result, index) => (
                  <Badge key={index} tone={result.hit ? 'good' : ''}>
                    {result.name} · {result.db.toFixed(0)} dB
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      {tab === 'advanced' && (
        <div className="grid two">
          <Card title="Receiver internals" subtitle="rtl_tcp transport and bandwidth">
            <div className="kv">
              <dt>Source</dt>
              <dd>{state.source}</dd>
              <dt>Device index</dt>
              <dd>{state.deviceIndex}</dd>
              <dt>IQ rate</dt>
              <dd>{state.running ? `${(state.bytesPerSecond / 1024 / 1024).toFixed(2)} MB/s` : '—'}</dd>
              <dt>Tune offset</dt>
              <dd>{state.offsetTuning ? 'on' : 'off'}</dd>
              <dt>Direct sampling</dt>
              <dd>{state.directSampling || 'off'}</dd>
              <dt>Last error</dt>
              <dd>{state.lastError || 'none'}</dd>
            </div>
            <div className="divider" />
            <div className="row">
              <Button size="sm" onClick={() => api.get('/sdr/devices').then(setDeviceInfo)}>Probe USB device</Button>
              <a className="btn btn-sm" href="#/system">Service logs</a>
            </div>
            {deviceInfo && <pre className="log" style={{ marginTop: 10 }}>{deviceInfo.raw || 'No devices found.'}</pre>}
          </Card>
          <Card title="HAT notes" subtitle="HackerGadgets RTL-SDR + R860">
            <div className="stack small">
              <p className="muted">
                The R860 tuner covers 24 MHz – 1.766 GHz. Enable <span className="code">Direct sampling: Q branch</span> for
                HF (100 kHz – 28.8 MHz) and connect the antenna to the SMA labelled <strong>SDR</strong>.
              </p>
              <p className="muted">
                The onboard TCXO is stable enough for most work; use the PPM slider if you notice a constant offset on known
                carriers.
              </p>
              <p className="muted">
                IQ is streamed to this browser and demodulated locally, so the Pi only runs <span className="code">rtl_tcp</span>.
                Lower the sample rate on slow links: 1.024 MS/s ≈ 2 MB/s.
              </p>
              <div className="hint-box">
                Audio and waterfall stop when the tab is hidden by the browser; tuning continues on the device.
              </div>
            </div>
          </Card>
        </div>
      )}

      <Modal open={presetModal} title="Save preset" onClose={() => setPresetModal(false)}>
        <div className="stack">
          <Field label="Name">
            <input className="input" value={presetName} onChange={(event) => setPresetName(event.target.value)} placeholder="e.g. Local repeater" />
          </Field>
          <div className="dim small mono">{fmtHz(state.frequency, 6)} · {state.demod?.toUpperCase()}</div>
          <Button variant="primary" onClick={savePreset}>Save preset</Button>
        </div>
      </Modal>
    </div>
  );
}
