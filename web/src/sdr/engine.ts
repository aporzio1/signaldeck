import { live } from '../ws';
import ProcessorWorker from './processor.worker?worker';

export type SdrConfig = {
  sampleRate: number;
  demod: string;
  squelch: number;
  volume: number;
};

function encodeWav(chunks: Float32Array[], sampleRate = 48000): Blob {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + total * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, total * 2, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      const sample = Math.max(-1, Math.min(1, chunk[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export class SdrEngine {
  private worker: Worker | null = null;
  private unsubscribe: (() => void) | null = null;
  private unsubAudio: (() => void) | null = null;
  private audioRate = 48000;
  private lastServerAudio = 0;
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private nextTime = 0;
  private config: SdrConfig = { sampleRate: 1024000, demod: 'nfm', squelch: -70, volume: 0.8 };
  private recording = false;
  private chunks: Float32Array[] = [];
  private recordedSamples = 0;
  audioEnabled = false;

  onSpectrum: ((bins: Float32Array, sampleRate: number) => void) | null = null;
  onMeter: ((meter: { db: number; open: boolean }) => void) | null = null;

  start() {
    if (this.worker) return;
    this.worker = new ProcessorWorker();
    this.worker.onmessage = (event) => {
      const message = event.data;
      if (message.type === 'spectrum') this.onSpectrum?.(message.bins, message.sampleRate);
      else if (message.type === 'audio' && Date.now() - this.lastServerAudio > 2000) this.handleAudio(message.samples);
      else if (message.type === 'meter') this.onMeter?.(message);
    };
    this.worker.postMessage({ type: 'config', ...this.config });
    this.unsubscribe = live.subscribeBinary((buffer) => {
      if (!this.worker) return;
      const copy = buffer.slice(0);
      this.worker.postMessage({ type: 'iq', buffer: copy }, [copy]);
    });
    // The Pi demodulates; the browser plays. Only fall back to the local
    // worker when no server audio is arriving (mock/demo sources).
    this.unsubAudio = live.subscribe(['audio'], (data: any) => {
      if (data?.config) {
        this.audioRate = Number(data.config.rate) || 48000;
        return;
      }
      if (!data?.pcm) return;
      this.lastServerAudio = Date.now();
      if (data.rate) this.audioRate = Number(data.rate) || this.audioRate;
      const bin = atob(data.pcm as string);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) u8[i] = bin.charCodeAt(i);
      const pcm = new Int16Array(u8.buffer);
      const out = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i += 1) out[i] = pcm[i] / 32768;
      this.handleAudio(out, this.audioRate);
    });
  }

  configure(config: Partial<SdrConfig>) {
    this.config = { ...this.config, ...config };
    this.worker?.postMessage({ type: 'config', ...this.config });
    if (this.ctx && 'volume' in config) this.setVolume(this.config.volume);
  }

  async enableAudio() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.config.volume;
      this.gain.connect(this.ctx.destination);
    }
    await this.ctx.resume();
    this.audioEnabled = true;
    this.nextTime = 0;
  }

  async disableAudio() {
    this.audioEnabled = false;
    this.chunks = [];
    await this.ctx?.suspend().catch(() => {});
  }

  setVolume(value: number) {
    this.config.volume = value;
    this.worker?.postMessage({ type: 'config', volume: value });
    if (this.gain) this.gain.gain.value = value;
  }

  private handleAudio(samples: Float32Array, rate = 48000) {
    if (this.recording) {
      this.chunks.push(new Float32Array(samples));
      this.recordedSamples += samples.length;
      if (this.recordedSamples > 48000 * 600) this.stopRecording();
    }
    if (!this.audioEnabled || !this.ctx || !this.gain) return;

    const buffer = this.ctx.createBuffer(1, samples.length, rate);
    buffer.getChannelData(0).set(samples);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);

    const now = this.ctx.currentTime;
    // rtl_tcp delivers IQ in ~130ms USB buffer waves even on wired LAN; an
    // 80ms reservoir starves between waves and the scheduler re-seeds, which
    // is an audible metronome. 400ms of buffer rides the waves out.
    if (this.nextTime < now + 0.02 || this.nextTime > now + 1.2) this.nextTime = now + 0.4;
    source.start(this.nextTime);
    this.nextTime += buffer.duration;
  }

  startRecording() {
    this.chunks = [];
    this.recordedSamples = 0;
    this.recording = true;
  }

  stopRecording(): Blob | null {
    this.recording = false;
    if (!this.chunks.length) return null;
    return encodeWav(this.chunks);
  }

  get recordingActive() {
    return this.recording;
  }

  get recordedSeconds() {
    return this.recordedSamples / 48000;
  }

  destroy() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubAudio?.();
    this.unsubAudio = null;
    this.worker?.terminate();
    this.worker = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.audioEnabled = false;
  }
}
