import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { parseJson } from './util.js';

const FILE = path.join(DATA_DIR, 'state.json');
const MAX_MESSAGES = 1500;
const MAX_TRACK = 20000;

const defaults = () => ({
  presets: [
    { id: 'fm', name: 'FM broadcast', frequency: 100100000, demod: 'wfm', sampleRate: 1200000 },
    { id: 'air', name: 'Airband AM', frequency: 121500000, demod: 'am', sampleRate: 1024000 },
    { id: 'adsb', name: 'ADS-B 1090', frequency: 1090000000, demod: 'am', sampleRate: 2048000 },
    { id: 'noaa', name: 'NOAA APT', frequency: 137100000, demod: 'wfm', sampleRate: 1200000 },
    { id: '2m', name: '2m calling', frequency: 146520000, demod: 'nfm', sampleRate: 1024000 },
    { id: '70cm', name: '70cm calling', frequency: 446000000, demod: 'nfm', sampleRate: 1024000 },
    { id: 'ism', name: 'LoRa 915 ISM', frequency: 915000000, demod: 'nfm', sampleRate: 1024000 },
  ],
  scanChannels: [
    { id: 's1', name: 'NOAA 1', frequency: 137620000, demod: 'wfm' },
    { id: 's2', name: 'NOAA 2', frequency: 137912500, demod: 'wfm' },
    { id: 's3', name: 'Airband guard', frequency: 121500000, demod: 'am' },
    { id: 's4', name: '2m simplex', frequency: 146520000, demod: 'nfm' },
  ],
  track: [],
  meshtastic: { messages: [], nodes: [], channels: [], myInfo: null, lastError: null, lastSeen: 0 },
  meshcore: { messages: [], contacts: [], channels: [], self: null, lastError: null, lastSeen: 0 },
  notes: '',
});

let state = null;
let saveTimer = null;

export function loadState() {
  if (state) return state;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const saved = parseJson(fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : '', null) || {};
  state = { ...defaults(), ...saved };
  state.track = Array.isArray(state.track) ? state.track.slice(-MAX_TRACK) : [];
  return state;
}

export function getState() {
  return loadState();
}

export function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const tmp = `${FILE}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(state));
      await fsp.rename(tmp, FILE);
    } catch {
      /* persistence is best effort */
    }
  }, 1500);
  if (saveTimer.unref) saveTimer.unref();
}

export function addMessage(kind, message) {
  const s = loadState();
  const bucket = s[kind] || (s[kind] = { messages: [] });
  bucket.messages = [...(bucket.messages || []), message].slice(-MAX_MESSAGES);
  scheduleSave();
  return message;
}

export function addTrackPoint(point) {
  const s = loadState();
  const last = s.track[s.track.length - 1];
  if (last && point.ts - last.ts < 2000) return;
  s.track.push(point);
  if (s.track.length > MAX_TRACK) s.track = s.track.slice(-MAX_TRACK);
  scheduleSave();
}

export function clearTrack() {
  const s = loadState();
  s.track = [];
  scheduleSave();
}

export function addPreset(preset) {
  const s = loadState();
  const entry = {
    id: `p_${Math.random().toString(36).slice(2, 9)}`,
    name: String(preset.name || 'Preset').slice(0, 40),
    frequency: Number(preset.frequency) || 100000000,
    demod: preset.demod || 'nfm',
    sampleRate: Number(preset.sampleRate) || 1024000,
  };
  s.presets.push(entry);
  scheduleSave();
  return entry;
}

export function removePreset(id) {
  const s = loadState();
  s.presets = s.presets.filter((p) => p.id !== id);
  scheduleSave();
}

export function setScanChannels(channels) {
  const s = loadState();
  s.scanChannels = (channels || []).slice(0, 200).map((c, i) => ({
    id: c.id || `s_${i}_${Math.random().toString(36).slice(2, 6)}`,
    name: String(c.name || 'Channel').slice(0, 40),
    frequency: Number(c.frequency) || 100000000,
    demod: c.demod || 'nfm',
  }));
  scheduleSave();
  return s.scanChannels;
}

export function gpxExport() {
  const { track } = loadState();
  const points = track
    .map(
      (p) =>
        `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">` +
        `<ele>${(p.alt ?? 0).toFixed(1)}</ele>` +
        `<time>${new Date(p.ts).toISOString()}</time>` +
        (p.speed != null ? `<extensions><speed>${p.speed.toFixed(2)}</speed></extensions>` : '') +
        `</trkpt>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="SignalDeck" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>SignalDeck track</name>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>`;
}
