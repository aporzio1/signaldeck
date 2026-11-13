import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepMerge, parseJson } from './util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(process.env.SIGNALDECK_ROOT || path.join(HERE, '..', '..'));
export const DATA_DIR = process.env.SIGNALDECK_DATA_DIR || path.join(ROOT, 'data');
export const WEB_DIST = process.env.SIGNALDECK_WEB_DIST || path.join(ROOT, 'web', 'dist');
export const SIDECAR_DIR = path.join(ROOT, 'server', 'sidecar');
export const VERSION = '0.1.0';

export const DEFAULT_SETTINGS = {
  stationName: 'SignalDeck',
  units: 'metric',
  demo: false,
  sdr: {
    enabled: false,
    deviceIndex: 0,
    rtlTcpPath: 'rtl_tcp',
    rtlTestPath: 'rtl_test',
    host: '127.0.0.1',
    port: 1234,
    frequency: 100100000,
    sampleRate: 1024000,
    gainMode: 'auto',
    gain: 280,
    ppm: 0,
    biasTee: false,
    directSampling: 0,
    agc: false,
    offsetTuning: false,
    demod: 'nfm',
    squelch: -70,
    volume: 0.8,
    step: 25000,
    squelchAuto: false,
  },
  gps: {
    source: 'auto',
    gpsdHost: '127.0.0.1',
    gpsdPort: 2947,
    serialPath: '/dev/ttyS0',
    baud: 9600,
    logTrack: true,
  },
  lora: {
    mode: 'meshtastic',
    meshtastic: { host: '127.0.0.1', port: 4403, autoStart: true },
    meshcore: {
      transport: 'tcp',
      host: '127.0.0.1',
      port: 5000,
      serialPath: '/dev/ttyACM0',
      baud: 115200,
      native: {
        preset: 'us',
        frequency: 910525000,
        bandwidth: 62500,
        spreadingFactor: 7,
        codingRate: 5,
        txPower: 20,
        pathHashMode: 0,
        nodeName: '',
        adminPassword: '',
        bindAddress: '127.0.0.1',
        tcpPort: 5000,
      },
    },
    radio: {
      module: 'sx1262',
      spidev: 'spidev0.0',
      cs: '',
      irq: 26,
      busy: 24,
      reset: 25,
      dio3Tcxo: true,
      dio2RfSwitch: true,
      region: 1,
      preset: 5,
      txPower: 20,
      hopLimit: 3,
    },
  },
  time: {
    rtcDevice: '',
    ntpUnit: '',
  },
  auth: {
    salt: '',
    passwordHash: '',
    tokens: [],
  },
  server: {
    port: Number(process.env.SIGNALDECK_PORT || 8080),
    host: process.env.SIGNALDECK_HOST || '0.0.0.0',
    tlsCert: '',
    tlsKey: '',
  },
};

function settingsFile() {
  return path.join(DATA_DIR, 'settings.json');
}

let cache = null;

export function loadSettings() {
  if (cache) return cache;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    /* best effort */
  }
  const saved = parseJson(fs.existsSync(settingsFile()) ? fs.readFileSync(settingsFile(), 'utf8') : '', {}) || {};
  cache = deepMerge(structuredClone(DEFAULT_SETTINGS), saved);
  cache.server.port = Number(cache.server.port) || DEFAULT_SETTINGS.server.port;
  if (process.env.SIGNALDECK_DEMO === '1') cache.demo = true;
  return cache;
}

export function getSettings() {
  return loadSettings();
}

export async function saveSettings() {
  const s = loadSettings();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${settingsFile()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, settingsFile());
  return s;
}

export function publicSettings() {
  const s = loadSettings();
  return {
    stationName: s.stationName,
    units: s.units,
    demo: s.demo,
    sdr: { ...s.sdr },
    gps: { ...s.gps },
    time: { ...s.time },
    lora: {
      mode: s.lora.mode,
      meshtastic: { ...s.lora.meshtastic },
      meshcore: { ...s.lora.meshcore, native: { ...s.lora.meshcore.native } },
      radio: { ...s.lora.radio },
    },
  };
}

export function updateSettings(patch) {
  const s = loadSettings();
  const next = deepMerge(s, patch);
  // Never let the API replace auth internals or bind addresses.
  next.auth = s.auth;
  next.server = s.server;
  for (const key of Object.keys(next)) cache[key] = next[key];
  return cache;
}

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}
