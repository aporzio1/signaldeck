import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import { getSettings } from './config.js';
import { logger } from './log.js';
import { addTrackPoint } from './store.js';
import { isLinux, sleep } from './util.js';

const log = logger('gps');

const emptyState = () => ({
  source: 'none',
  connected: false,
  fix: 0,
  fixLabel: 'No fix',
  lat: null,
  lon: null,
  alt: null,
  speed: null,
  track: null,
  hdop: null,
  vdop: null,
  pdop: null,
  satsVisible: 0,
  satsUsed: 0,
  satellites: [],
  time: null,
  error: null,
  lastUpdate: null,
  offsetMs: null,
  device: null,
});

function nmeaToDegrees(value, hemisphere) {
  if (!value || !hemisphere) return null;
  const raw = Number(value);
  if (!Number.isFinite(raw)) return null;
  const degrees = Math.floor(raw / 100);
  const minutes = raw - degrees * 100;
  let result = degrees + minutes / 60;
  if (hemisphere === 'S' || hemisphere === 'W') result = -result;
  return result;
}

function parseNmeaTime(field) {
  if (!field || field.length < 6) return null;
  const hh = Number(field.slice(0, 2));
  const mm = Number(field.slice(2, 4));
  const ss = Number(field.slice(4, 6));
  return { hh, mm, ss };
}

export class GpsService extends EventEmitter {
  constructor() {
    super();
    this.state = emptyState();
    this.socket = null;
    this.stream = null;
    this.timer = null;
    this.stopped = true;
    this.retry = null;
    this.buffer = '';
  }

  getState() {
    return { ...this.state, satellites: this.state.satellites };
  }

  async start() {
    if (!this.stopped) return this.getState();
    this.stopped = false;
    const settings = getSettings();
    this.state.source = settings.gps.source;
    if (settings.demo) return this.startDemo();
    if (settings.gps.source === 'serial') return this.startSerial(settings.gps);
    if (settings.gps.source === 'gpsd') return this.startGpsd(settings.gps);
    // auto: prefer gpsd, fall back to NMEA on the configured serial port
    const gpsdOk = await this.tryGpsd(settings.gps);
    if (!gpsdOk) this.startSerial(settings.gps);
    return this.getState();
  }

  async tryGpsd(config) {
    return new Promise((resolve) => {
      const host = config.gpsdHost || '127.0.0.1';
      const port = Number(config.gpsdPort) || 2947;
      const socket = net.connect({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 2500);
      socket.once('connect', () => {
        clearTimeout(timer);
        this.attachGpsd(socket);
        resolve(true);
      });
      socket.once('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  attachGpsd(socket) {
    this.socket = socket;
    this.state.source = 'gpsd';
    this.state.connected = true;
    this.state.error = null;
    this.buffer = '';
    log.info('connected to gpsd');
    socket.setEncoding('utf8');
    socket.write('?WATCH={"enable":true,"json":true};\n');
    socket.on('data', (chunk) => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line.startsWith('{')) continue;
        try {
          this.handleGpsd(JSON.parse(line));
        } catch {
          /* ignore malformed line */
        }
      }
    });
    socket.on('close', () => {
      this.state.connected = false;
      this.socket = null;
      if (!this.stopped) this.scheduleRetry();
    });
    socket.on('error', (err) => {
      this.state.error = err.message;
      this.state.connected = false;
    });
  }

  handleGpsd(message) {
    const state = this.state;
    if (message.class === 'TPV') {
      state.fix = message.mode ?? state.fix;
      state.fixLabel = ['No fix', 'No fix', '2D fix', '3D fix'][state.fix] || 'No fix';
      if (message.lat != null && message.lon != null) {
        state.lat = message.lat;
        state.lon = message.lon;
      }
      if (message.alt != null) state.alt = message.alt;
      if (message.speed != null) state.speed = message.speed;
      if (message.track != null) state.track = message.track;
      for (const key of ['hdop', 'vdop', 'pdop']) if (message[key] != null) state[key] = message[key];
      if (message.time) state.time = message.time;
      state.offsetMs = message.time ? Date.parse(message.time) - Date.now() : null;
      state.lastUpdate = Date.now();
      if (this.shouldLog()) {
        addTrackPoint({ ts: Date.now(), lat: state.lat, lon: state.lon, alt: state.alt, speed: state.speed, track: state.track, fix: state.fix });
      }
      this.emit('state', this.getState());
    } else if (message.class === 'SKY') {
      const sats = (message.satellites || []).map((sat) => ({
        prn: sat.PRN,
        az: sat.az,
        el: sat.el,
        snr: sat.ss,
        used: Boolean(sat.used),
        system: sat.gnssid ? ['GPS', 'SBAS', 'Galileo', 'BeiDou', 'IMES', 'QZSS', 'GLONASS'][sat.gnssid - 1] || `GNSS${sat.gnssid}` : 'GPS',
      }));
      state.satellites = sats;
      state.satsVisible = sats.length;
      state.satsUsed = sats.filter((s) => s.used).length;
      if (message.hdop != null) state.hdop = message.hdop;
      if (message.vdop != null) state.vdop = message.vdop;
      if (message.pdop != null) state.pdop = message.pdop;
      this.emit('state', this.getState());
    } else if (message.class === 'GST') {
      state.error = { x: message.epx, y: message.epy, v: message.epv, major: message.epc, minor: message.eps, orientation: message.epd };
      this.emit('state', this.getState());
    }
  }

  shouldLog() {
    const { gps } = getSettings();
    return gps.logTrack && this.state.fix >= 2 && this.state.lat != null;
  }

  async startSerial(config) {
    const device = config.serialPath || '/dev/ttyS0';
    this.state.device = device;
    this.state.source = 'serial';
    if (!isLinux) {
      this.state.error = `Serial GNSS is not available on ${process.platform}.`;
      this.emit('state', this.getState());
      return;
    }
    const baud = Number(config.baud) || 9600;
    const { run } = await import('./util.js');
    await run('stty', ['-F', device, String(baud), 'raw', '-echo', '-crtscts', 'clocal'], { timeout: 5000 });
    try {
      this.stream = fs.createReadStream(device, { encoding: 'latin1', highWaterMark: 512 });
    } catch (err) {
      this.state.error = err.message;
      this.emit('state', this.getState());
      this.scheduleRetry();
      return;
    }
    this.state.connected = true;
    this.state.error = null;
    log.info(`reading NMEA from ${device} @ ${baud}`);
    this.buffer = '';
    this.stream.on('data', (chunk) => this.consumeNmea(chunk));
    this.stream.on('error', (err) => {
      this.state.error = err.message;
      this.state.connected = false;
      this.scheduleRetry();
    });
    this.stream.on('close', () => {
      this.state.connected = false;
      if (!this.stopped) this.scheduleRetry();
    });
  }

  consumeNmea(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line.startsWith('$')) this.parseSentence(line);
    }
    if (this.buffer.length > 8192) this.buffer = '';
  }

  parseSentence(line) {
    const parts = line.split('*')[0].split(',');
    const type = parts[0].slice(3);
    const state = this.state;
    const emit = () => this.emit('state', this.getState());
    if (type === 'GGA') {
      const fixQuality = Number(parts[6] || 0);
      state.fix = fixQuality > 0 ? 3 : 0;
      state.fixLabel = fixQuality > 0 ? '3D fix' : 'No fix';
      state.lat = nmeaToDegrees(parts[2], parts[3]) ?? state.lat;
      state.lon = nmeaToDegrees(parts[4], parts[5]) ?? state.lon;
      state.satsUsed = Number(parts[7] || 0);
      state.hdop = parts[8] ? Number(parts[8]) : null;
      state.alt = parts[9] ? Number(parts[9]) : null;
      const t = parseNmeaTime(parts[1]);
      if (t) {
        const now = new Date();
        const utc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), t.hh, t.mm, Math.floor(t.ss));
        state.time = new Date(utc).toISOString();
        state.offsetMs = utc - Date.now();
      }
      state.lastUpdate = Date.now();
      if (this.shouldLog()) addTrackPoint({ ts: Date.now(), lat: state.lat, lon: state.lon, alt: state.alt, speed: state.speed, track: state.track, fix: state.fix });
      emit();
    } else if (type === 'RMC') {
      state.lat = nmeaToDegrees(parts[3], parts[4]) ?? state.lat;
      state.lon = nmeaToDegrees(parts[5], parts[6]) ?? state.lon;
      if (parts[7]) state.speed = Number(parts[7]) * 0.514444;
      if (parts[8]) state.track = Number(parts[8]);
      if (parts[2] === 'A') {
        state.fix = Math.max(state.fix, 2);
        state.fixLabel = state.fix >= 3 ? '3D fix' : '2D fix';
      }
      emit();
    } else if (type === 'GSA') {
      const fix = Number(parts[2] || 0);
      if (fix) {
        state.fix = fix === 3 ? 3 : 2;
        state.fixLabel = fix === 3 ? '3D fix' : '2D fix';
      }
      state.pdop = parts[15] ? Number(parts[15]) : state.pdop;
      state.hdop = parts[16] ? Number(parts[16]) : state.hdop;
      state.vdop = parts[17] ? Number(parts[17]) : state.vdop;
      emit();
    } else if (type === 'GSV') {
      const visible = Number(parts[3] || 0);
      const satellites = [];
      for (let i = 4; i + 3 < parts.length; i += 4) {
        const prn = Number(parts[i]);
        if (!prn) continue;
        satellites.push({
          prn,
          el: Number(parts[i + 1]) || 0,
          az: Number(parts[i + 2]) || 0,
          snr: Number(parts[i + 3]) || 0,
          used: false,
          system: parts[0].includes('BD') ? 'BeiDou' : parts[0].includes('GL') ? 'GLONASS' : 'GPS',
        });
      }
      if (satellites.length) {
        const usedPrns = new Set(state.satellites.filter((s) => s.used).map((s) => s.prn));
        state.satellites = satellites.map((s) => ({ ...s, used: usedPrns.has(s.prn) }));
        state.satsVisible = Math.max(visible, satellites.length);
      }
      emit();
    }
  }

  startDemo() {
    this.state.source = 'demo';
    this.state.connected = true;
    this.state.fix = 3;
    this.state.fixLabel = '3D fix';
    this.state.lat = 37.7749;
    this.state.lon = -122.4194;
    this.state.alt = 16.2;
    this.state.speed = 0;
    this.state.track = 0;
    this.state.hdop = 0.8;
    this.state.vdop = 1.1;
    this.state.pdop = 1.4;
    this.state.satsVisible = 11;
    this.state.satsUsed = 9;
    this.state.time = new Date().toISOString();
    this.state.lastUpdate = Date.now();
    this.state.error = null;
    this.state.satellites = Array.from({ length: 11 }, (_, i) => ({
      prn: i + 2,
      az: (i * 33) % 360,
      el: 15 + ((i * 17) % 70),
      snr: 22 + ((i * 7) % 24),
      used: i < 9,
      system: i > 8 ? 'Galileo' : 'GPS',
    }));
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.stopped) return;
      const t = Date.now() / 1000;
      this.state.lat += Math.sin(t / 40) * 0.000006;
      this.state.lon += Math.cos(t / 55) * 0.000006;
      this.state.time = new Date().toISOString();
      this.state.offsetMs = Math.round(Math.sin(t / 9) * 4);
      this.state.lastUpdate = Date.now();
      this.state.satellites = this.state.satellites.map((s, i) => ({ ...s, snr: Math.max(15, Math.min(48, s.snr + Math.sin(t / 3 + i) * 2)) }));
      if (this.shouldLog()) addTrackPoint({ ts: Date.now(), lat: this.state.lat, lon: this.state.lon, alt: this.state.alt, speed: this.state.speed, track: this.state.track, fix: 3 });
      this.emit('state', this.getState());
    }, 1000);
    this.emit('state', this.getState());
  }

  scheduleRetry() {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(async () => {
      this.retry = null;
      if (this.stopped) return;
      const settings = getSettings();
      log.warn('GPS link lost, reconnecting in 10s');
      await sleep(10);
      if (settings.demo) return this.startDemo();
      if (settings.gps.source === 'gpsd') this.startGpsd(settings.gps);
      else if (settings.gps.source === 'serial') this.startSerial(settings.gps);
      else {
        const ok = await this.tryGpsd(settings.gps);
        if (!ok) this.startSerial(settings.gps);
      }
    }, 10000);
    this.retry.unref?.();
  }

  async startGpsd(config) {
    this.stopLink();
    this.stopped = false;
    const ok = await this.tryGpsd(config);
    if (!ok) {
      this.state.connected = false;
      this.state.error = `Cannot reach gpsd at ${config.gpsdHost}:${config.gpsdPort}. Is gpsd running?`;
      this.emit('state', this.getState());
      this.scheduleRetry();
    }
  }

  stopLink() {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    if (this.stream) {
      this.stream.removeAllListeners();
      this.stream.destroy();
      this.stream = null;
    }
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.retry);
    this.retry = null;
    this.stopLink();
    this.state = emptyState();
    this.emit('state', this.getState());
  }

  async restart() {
    await this.stop();
    this.stopped = true;
    return this.start();
  }
}
