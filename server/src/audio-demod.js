// Server-side audio demodulator: browsers (Safari especially) should not be
// the ones doing 1 MS/s quadrature math. Demodulate here, stream tiny PCM
// frames, and every browser becomes Chrome-good.

const OUT_SAMPLES = 972; // ~20 ms at 48 kHz

export class AudioDemod {
  constructor(sampleRate, demod, emit) {
    this.emit = emit;
    this.configure(sampleRate, demod, true);
    this.prevRe = 1;
    this.prevIm = 0;
    this.reset();
  }

  configure(sampleRate, demod, keepAudio = false) {
    this.rate = sampleRate;
    this.demod = demod;
    this.decim = Math.max(8, Math.min(48, Math.round(sampleRate / 48000)));
    this.outRate = Math.round(sampleRate / this.decim);
    // FM: phase-difference deviator; full deviation normalizes to ~0.9.
    this.fmScale = demod === 'nfm'
      ? 0.9 / (2 * Math.PI * 5000 / sampleRate)
      : 0.9 / (2 * Math.PI * 75000 / sampleRate);
    if (!keepAudio) this.reset();
  }

  reset() {
    this.lp = new Float32Array(this.decim);
    this.lpIndex = 0;
    this.lpSum = 0;
    this.dcAvg = 0;
    this.out = new Int16Array(OUT_SAMPLES);
    this.outCount = 0;
    this.count = 0;
  }

  /** iqBuffer: interleaved unsigned 8-bit I/Q pairs (post-framing). */
  push(iqBuffer) {
    const devMode = this.demod !== 'am';
    const n = iqBuffer.length >> 1;
    for (let k = 0; k < n; k += 1) {
      const re = iqBuffer[2 * k] - 127.5;
      const im = iqBuffer[2 * k + 1] - 127.5;
      let sample;
      if (devMode) {
        const diffRe = re * this.prevRe + im * this.prevIm;
        const diffIm = im * this.prevRe - re * this.prevIm;
        sample = Math.atan2(diffIm, diffRe) * this.fmScale;
      } else {
        sample = (Math.hypot(re, im) / 127.5) * 0.9;
        this.dcAvg += (sample - this.dcAvg) * 0.0005;
        sample -= this.dcAvg;
      }
      this.prevRe = re;
      this.prevIm = im;

      const old = this.lp[this.lpIndex];
      this.lp[this.lpIndex] = sample;
      this.lpSum += sample - old;
      this.lpIndex = (this.lpIndex + 1) % this.decim;
      this.count += 1;
      if (this.count === this.decim) {
        this.count = 0;
        const value = Math.max(-1, Math.min(1, this.lpSum / this.decim));
        this.out[this.outCount++] = Math.round(value * 32767);
        if (this.outCount === OUT_SAMPLES) {
          this.flush();
        }
      }
    }
  }

  flush() {
    if (this.outCount) {
      const pcm = this.out.slice(0, this.outCount);
      this.outCount = 0;
      this.emit(pcm, this.outRate);
    }
  }

  /** Discard partial audio (retune): stale frequencies must not drain. */
  drop() {
    this.outCount = 0;
  }
}
