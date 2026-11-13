import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { getSettings, saveSettings } from './config.js';
import { logger } from './log.js';
import { clamp, isLinux, sleep, which } from './util.js';

const log = logger('sdr');

export const CMD = {
  SET_FREQ: 0x01,
  SET_SAMPLE_RATE: 0x02,
  SET_GAIN_MODE: 0x03,
  SET_GAIN: 0x04,
  SET_PPM: 0x05,
  SET_IF_GAIN: 0x06,
  SET_TEST_MODE: 0x07,
  SET_AGC: 0x08,
  SET_DIRECT_SAMPLING: 0x09,
  SET_OFFSET_TUNING: 0x0a,
  SET_RTL_XTAL: 0x0b,
  SET_TUNER_XTAL: 0x0c,
  SET_GAIN_BY_INDEX: 0x0d,
  SET_BIAS_TEE: 0x0e,
};

const MOCK_RATE_CAP = 1200000;

export class SdrService extends EventEmitter {
  constructor() {
    super();
    this.state = {
      running: false,
      source: 'idle',
      frequency: 0,
      sampleRate: 0,
      demod: 'nfm',
      gainMode: 'auto',
      gain: 280,
      ppm: 0,
      biasTee: false,
      directSampling: 0,
      agc: false,
      offsetTuning: false,
      deviceIndex: 0,
      clients: 0,
      lastError: null,
      startedAt: null,
      bytesPerSecond: 0,
    };
    this.socket = null;
    this.child = null;
    this.mockTimer = null;
    this.mockPhase = 0;
    this.mockIndex = 0;
    this.watchdog = null;
    this.lastBytes = 0;
    this.lastBytesAt = Date.now();
  }

  getState() {
    return { ...this.state };
  }

  async resolveSource() {
    const settings = getSettings();
    if (settings.demo) return 'mock';
    if (!isLinux) return 'mock';
    const bin = await which(settings.sdr.rtlTcpPath || 'rtl_tcp');
    if (bin) return 'rtl_tcp';
    return 'mock';
  }

  async start(options = {}) {
    if (this.state.running) return this.getState();
    // start/stop were unserialized: two API calls in flight could each spawn
    // rtl_tcp, fighting over the dongle. Route concurrent starts through one
    // in-flight start promise.
    if (this.startPromise) return this.startPromise;
    this.startPromise = this._start(options).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async _start(options) {
    const settings = getSettings();
    const sdr = { ...settings.sdr, ...options };
    const source = options.source || (await this.resolveSource());
    this.state.startedAt = Date.now();
    this.state.lastError = null;
    if (source === 'mock') {
      this.startMock(sdr);
    } else {
      await this.startRtlTcp(sdr);
    }
    this.state.frequency = Number(sdr.frequency);
    this.state.sampleRate = Number(sdr.sampleRate);
    this.state.demod = sdr.demod;
    this.state.gainMode = sdr.gainMode;
    this.state.gain = Number(sdr.gain);
    this.state.ppm = Number(sdr.ppm);
    this.state.biasTee = Boolean(sdr.biasTee);
    this.state.directSampling = Number(sdr.directSampling) || 0;
    this.state.agc = Boolean(sdr.agc);
    this.state.offsetTuning = Boolean(sdr.offsetTuning);
    this.state.deviceIndex = Number(sdr.deviceIndex) || 0;
    this.state.running = true;
    this.state.source = source;
    this.emit('state', this.getState());
    log.info(`started (${source}) at ${(this.state.frequency / 1e6).toFixed(4)} MHz, ${this.state.sampleRate} S/s`);
    return this.getState();
  }

  startMock(sdr) {
    const fs = clamp(Number(sdr.sampleRate) || 1024000, 24000, MOCK_RATE_CAP);
    this.state.sampleRate = fs;
    const chunkMs = 60;
    const chunkSize = Math.round((fs * chunkMs) / 1000);
    this.mockIndex = 0;
    this.mockTimer = setInterval(() => {
      if (!this.state.running) return;
      this.emitIq(this.generateMockIq(chunkSize, fs));
    }, chunkMs);
  }

  /**
   * Synthetic IQ with a few carriers so the waterfall, tuner and demodulator can
   * be exercised without hardware: an AM station, an FM station and a beacon.
   */
  generateMockIq(count, fs) {
    const buffer = Buffer.allocUnsafe(count * 2);
    const rate = Math.min(fs, MOCK_RATE_CAP);
    const carriers = [
      { offset: -150000, amp: 0.42, tone: 700, kind: 'am' },
      { offset: 150000, amp: 0.5, tone: 1000, kind: 'fm' },
      { offset: 330000, amp: 0.3, tone: 0, kind: 'cw' },
      { offset: -380000, amp: 0.16, tone: 300, kind: 'am' },
    ];
    for (let i = 0; i < count; i++) {
      const n = this.mockIndex + i;
      const t = n / rate;
      let iValue = (Math.random() - 0.5) * 0.06;
      let qValue = (Math.random() - 0.5) * 0.06;
      for (const c of carriers) {
        const phase = 2 * Math.PI * c.offset * t;
        if (c.kind === 'am') {
          const envelope = c.amp * (0.55 + 0.45 * Math.sin(2 * Math.PI * c.tone * t));
          iValue += envelope * Math.cos(phase);
          qValue += envelope * Math.sin(phase);
        } else if (c.kind === 'fm') {
          const modulation = 3.2 * Math.sin(2 * Math.PI * c.tone * t);
          iValue += c.amp * Math.cos(phase + modulation);
          qValue += c.amp * Math.sin(phase + modulation);
        } else {
          iValue += c.amp * Math.cos(phase);
          qValue += c.amp * Math.sin(phase);
        }
      }
      buffer[i * 2] = Math.max(0, Math.min(255, Math.round(iValue * 127 + 127.5)));
      buffer[i * 2 + 1] = Math.max(0, Math.min(255, Math.round(qValue * 127 + 127.5)));
    }
    this.mockIndex += count;
    return buffer;
  }

  async startRtlTcp(sdr) {
    const settings = getSettings();
    const host = sdr.host || '127.0.0.1';
    const port = Number(sdr.port) || 1234;
    const bin = settings.sdr.rtlTcpPath || 'rtl_tcp';
    const args = ['-a', host, '-p', String(port)];
    if (sdr.deviceIndex) args.push('-d', String(sdr.deviceIndex));
    log.info(`${bin} ${args.join(' ')}`);
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.on('data', (d) => log.info(`rtl_tcp: ${d.toString().trim()}`));
    const onErr = (d) => {
      const text = d.toString().trim();
      if (text) {
        log.warn(`rtl_tcp: ${text}`);
        this.state.lastError = text;
      }
    };
    child.stderr.on('data', onErr);
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.state.running) {
        this.state.running = false;
        this.state.lastError = `rtl_tcp exited (${signal || code})`;
        this.emit('state', this.getState());
        log.error(this.state.lastError);
      }
    });

    // The stream opens with a 12-byte rtl_tcp response header (magic + IQ byte
    // count) and TCP chunks land on arbitrary boundaries: the old code fed all
    // of it to the browser as IQ bytes. Consume the header, carry an odd
    // trailing byte into the next chunk, emit only whole I/Q pairs.
    let headerLeft = 12;
    let remainder = null;
    try {
      this.socket = await this.connectWithRetry(host, port);
    } catch (err) {
      child.kill('SIGTERM');
      if (this.child === child) this.child = null;
      throw err;
    }
    const socket = this.socket;
    socket.setNoDelay(true);
    socket.on('data', (data) => {
      let buf = data;
      if (headerLeft > 0) {
        const take = Math.min(headerLeft, buf.length);
        headerLeft -= take;
        buf = buf.subarray(take);
        if (!buf.length) return;
      }
      if (remainder) {
        buf = Buffer.concat([remainder, buf]);
        remainder = null;
      }
      if (buf.length % 2) {
        remainder = Buffer.from(buf.subarray(buf.length - 1));
        buf = buf.subarray(0, buf.length - 1);
      }
      if (buf.length) this.emitIq(buf);
    });
    socket.on('close', () => {
      if (this.state.running) {
        this.state.running = false;
        this.state.lastError = 'rtl_tcp connection closed';
        this.emit('state', this.getState());
      }
    });
    socket.on('error', (err) => {
      this.state.lastError = err.message;
      log.error(`socket: ${err.message}`);
    });

    this.send(CMD.SET_SAMPLE_RATE, Number(sdr.sampleRate));
    await sleep(80);
    this.send(CMD.SET_FREQ, Number(sdr.frequency));
    this.send(CMD.SET_GAIN_MODE, sdr.gainMode === 'manual' ? 1 : 0);
    if (sdr.gainMode === 'manual') this.send(CMD.SET_GAIN, Math.round(Number(sdr.gain) || 280));
    this.send(CMD.SET_PPM, Math.round(Number(sdr.ppm) || 0));
    this.send(CMD.SET_AGC, sdr.agc ? 1 : 0);
    this.send(CMD.SET_OFFSET_TUNING, sdr.offsetTuning ? 1 : 0);
    this.send(CMD.SET_DIRECT_SAMPLING, Number(sdr.directSampling) || 0);
    await sleep(60);
    this.send(CMD.SET_BIAS_TEE, sdr.biasTee ? 1 : 0);
  }

  connectWithRetry(host, port, attempts = 25) {
    return new Promise((resolve, reject) => {
      let attempt = 0;
      const tryOnce = () => {
        attempt += 1;
        const socket = net.connect({ host, port });
        socket.once('connect', () => resolve(socket));
        socket.once('error', (err) => {
          socket.destroy();
          if (attempt >= attempts) return reject(err);
          setTimeout(tryOnce, 200);
        });
      };
      tryOnce();
    });
  }

  send(cmd, param) {
    if (!this.socket || this.socket.destroyed) return;
    const buffer = Buffer.alloc(5);
    buffer.writeUInt8(cmd, 0);
    buffer.writeInt32BE(param | 0, 1);
    this.socket.write(buffer);
  }

  emitIq(buffer) {
    if (!buffer?.length) return;
    const now = Date.now();
    this.lastBytes += buffer.length;
    const elapsed = now - this.lastBytesAt;
    if (elapsed > 1000) {
      this.state.bytesPerSecond = Math.round((this.lastBytes * 1000) / elapsed);
      this.lastBytes = 0;
      this.lastBytesAt = now;
    }
    this.emit('iq', buffer);
  }

  async tune({ frequency, sampleRate, gainMode, gain, ppm, biasTee, directSampling, agc, offsetTuning, demod }) {
    const settings = getSettings();
    if (!this.state.running) throw Object.assign(new Error('SDR is not running.'), { status: 409 });
    if (frequency != null) {
      const freq = Math.round(Number(frequency));
      if (!Number.isFinite(freq) || freq < 24000 || freq > 1766000000) {
        throw Object.assign(new Error('Frequency must be between 24 kHz and 1.766 GHz.'), { status: 400 });
      }
      this.state.frequency = freq;
      settings.sdr.frequency = freq;
      this.send(CMD.SET_FREQ, freq);
    }
    if (sampleRate != null && Number(sampleRate) !== this.state.sampleRate) {
      const rate = Math.round(Number(sampleRate));
      if (this.state.source === 'mock') {
        clearInterval(this.mockTimer);
        this.mockTimer = null;
        this.startMock({ ...settings.sdr, sampleRate: rate });
      } else {
        this.send(CMD.SET_SAMPLE_RATE, rate);
      }
      this.state.sampleRate = Math.min(rate, this.state.source === 'mock' ? MOCK_RATE_CAP : rate);
      settings.sdr.sampleRate = rate;
    }
    if (gainMode != null) {
      this.state.gainMode = gainMode === 'manual' ? 'manual' : 'auto';
      this.send(CMD.SET_GAIN_MODE, gainMode === 'manual' ? 1 : 0);
      settings.sdr.gainMode = this.state.gainMode;
    }
    if (gain != null) {
      this.state.gain = clamp(Number(gain), 0, 600);
      this.send(CMD.SET_GAIN, Math.round(this.state.gain));
      settings.sdr.gain = this.state.gain;
    }
    if (ppm != null) {
      this.state.ppm = clamp(Number(ppm), -200, 200);
      this.send(CMD.SET_PPM, Math.round(this.state.ppm));
      settings.sdr.ppm = this.state.ppm;
    }
    if (biasTee != null) {
      this.state.biasTee = Boolean(biasTee);
      this.send(CMD.SET_BIAS_TEE, this.state.biasTee ? 1 : 0);
      settings.sdr.biasTee = this.state.biasTee;
    }
    if (directSampling != null) {
      this.state.directSampling = clamp(Number(directSampling) || 0, 0, 2);
      this.send(CMD.SET_DIRECT_SAMPLING, this.state.directSampling);
      settings.sdr.directSampling = this.state.directSampling;
    }
    if (agc != null) {
      this.state.agc = Boolean(agc);
      this.send(CMD.SET_AGC, this.state.agc ? 1 : 0);
      settings.sdr.agc = this.state.agc;
    }
    if (offsetTuning != null) {
      this.state.offsetTuning = Boolean(offsetTuning);
      this.send(CMD.SET_OFFSET_TUNING, this.state.offsetTuning ? 1 : 0);
      settings.sdr.offsetTuning = this.state.offsetTuning;
    }
    if (demod != null) {
      this.state.demod = String(demod);
      settings.sdr.demod = this.state.demod;
    }
    saveSettings().catch(() => {});
    this.emit('state', this.getState());
    return this.getState();
  }

  async stop() {
    // Serialize against an in-flight start so stop never races spawn.
    if (this.startPromise) await this.startPromise.catch(() => {});
    this.state.running = false;
    if (this.mockTimer) clearInterval(this.mockTimer);
    this.mockTimer = null;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    const child = this.child;
    this.child = null;
    if (child) {
      child.kill('SIGTERM');
      // The SIGKILL escalation must reference the captured child; reading
      // this.child after it was nulled meant stale children were never killed.
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 1500).unref?.();
    }
    this.state.source = 'idle';
    this.state.bytesPerSecond = 0;
    this.emit('state', this.getState());
    log.info('stopped');
    return this.getState();
  }
}
