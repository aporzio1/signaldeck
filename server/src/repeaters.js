import { logger } from './log.js';
import { getState, scheduleSave } from './store.js';

const log = logger('repeaters');

const CACHE_TTL_MS = 60 * 60 * 1000;
const EARTH_MI = 3958.8;
const MAX_RADIUS_MI = 200;

let sourceCache = { url: null, at: 0, entries: [], error: null };

const num = (v) => {
  const n = Number(typeof v === 'string' ? v.replace(/[^\d.\-]/g, '') : v);
  return Number.isFinite(n) ? n : null;
};

/** Accept Hz or MHz transparently: directories disagree on units. */
const hz = (v) => {
  const n = num(v);
  if (n == null) return null;
  return n < 100000 ? Math.round(n * 1e6) : Math.round(n);
};

const first = (obj, keys) => {
  for (const k of keys) {
    const hit = Object.keys(obj).find((key) => key.toLowerCase() === k);
    if (hit != null && obj[hit] !== '' && obj[hit] != null) return obj[hit];
  }
  return null;
};

function mapEntry(raw, index) {
  if (typeof raw !== 'object' || raw == null) return null;
  const frequency = hz(first(raw, ['frequency', 'freq', 'output', 'tx']));
  if (!frequency) return null;
  const lat = num(first(raw, ['lat', 'latitude']));
  const lon = num(first(raw, ['lon', 'long', 'lng', 'longitude']));
  const offset = hz(first(raw, ['offset', 'inputshift', 'input shift']));
  const tone = num(first(raw, ['tone', 'ctcss', 'pl', 'rpttxctcssorpl']));
  return {
    id: `src-${index}-${frequency}`,
    name: String(first(raw, ['name', 'callsign', 'repeater', 'callsignname']) || `Repeater ${index + 1}`),
    city: String(first(raw, ['city', 'county', 'area']) || ''),
    frequency,
    offset: offset == null ? 0 : offset,
    tone,
    mode: String(first(raw, ['mode', 'type', 'duplex']) || 'FM'),
    lat: lat != null && lat !== 0 ? lat : null,
    lon: lon != null && lon !== 0 ? lon : null,
    source: 'catalog',
  };
}

async function fetchSource(url) {
  if (sourceCache.url === url && Date.now() - sourceCache.at < CACHE_TTL_MS) return sourceCache.entries;
  if (sourceCache.url !== url) sourceCache = { url, at: 0, entries: [], error: null };
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'SignalDeck/1.0 (amateur radio console)',
        Accept: 'application/json,text/plain;q=0.5',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const body = await res.json();
    const rows = Array.isArray(body) ? body : Array.isArray(body.Data) ? body.Data : Array.isArray(body.repeaters) ? body.repeaters : [];
    const entries = rows.map(mapEntry).filter(Boolean);
    sourceCache = { url, at: Date.now(), entries, error: null };
    log.info(`${entries.length} repeaters from source`);
    return entries;
  } catch (error) {
    sourceCache = { url, at: Date.now() - CACHE_TTL_MS + 60000, entries: sourceCache.entries, error: error.message };
    log.warn(`source: ${error.message}`);
    return sourceCache.entries;
  }
}

const haversineMi = (a, b) => {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_MI * Math.asin(Math.sqrt(s));
};

const bearingDeg = (a, b) => {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad)
    - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
  return Math.round(((Math.atan2(y, x) / rad) + 360) % 360);
};

function withGeometry(entry, qth) {
  if (!qth || entry.lat == null || entry.lon == null) return entry;
  const distanceMi = Math.round(haversineMi(qth, entry) * 10) / 10;
  return { ...entry, distanceMi, bearingDeg: bearingDeg(qth, entry) };
}

const dedupeKey = (e) => `${Math.round(e.frequency / 1000)}:${e.name.toLowerCase()}`;

export async function listRepeaters({ lat, lon, radiusMi = 50, sourceUrl = '' }) {
  const qth = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  const radius = Math.min(MAX_RADIUS_MI, Math.max(1, Number(radiusMi) || 50));
  const saved = (getState().book || []).map((e) => ({ ...e, source: 'saved' }));
  const catalog = sourceUrl ? await fetchSource(sourceUrl) : [];
  const seen = new Set(saved.map(dedupeKey));
  const merged = [...saved, ...catalog.filter((e) => !seen.has(dedupeKey(e)))].map((e) => withGeometry(e, qth));
  if (qth) merged.sort((a, b) => (a.distanceMi ?? Infinity) - (b.distanceMi ?? Infinity));
  return {
    qth,
    radiusMi: radius,
    sourceError: sourceUrl ? sourceCache.error : null,
    repeaters: qth ? merged.filter((e) => e.distanceMi == null || e.distanceMi <= radius) : merged,
  };
}

export function addRepeater(body = {}) {
  const frequency = hz(body.frequency);
  if (!frequency) throw Object.assign(new Error('Frequency is required.'), { status: 400 });
  const entry = {
    id: `saved-${Date.now().toString(36)}`,
    name: String(body.name || 'Repeater').slice(0, 60),
    city: String(body.city || '').slice(0, 60),
    frequency,
    offset: hz(body.offset) ?? 0,
    tone: num(body.tone),
    mode: String(body.mode || 'FM').slice(0, 12),
    lat: num(body.lat),
    lon: num(body.lon),
    source: 'saved',
  };
  const state = getState();
  state.book = [...(state.book || []), entry];
  scheduleSave();
  return entry;
}

export function removeRepeater(id) {
  const state = getState();
  state.book = (state.book || []).filter((e) => e.id !== id);
  scheduleSave();
  return { removed: String(id) };
}

export function setLocation(body = {}) {
  const lat = num(body.lat);
  const lon = num(body.lon);
  if (lat == null || lon == null) throw Object.assign(new Error('lat and lon are required.'), { status: 400 });
  const state = getState();
  state.qth = {
    lat,
    lon,
    label: String(body.label || '').slice(0, 40),
    source: body.source === 'gps' ? 'gps' : 'manual',
    at: Date.now(),
  };
  scheduleSave();
  return state.qth;
}

export function location() {
  return getState().qth || null;
}
