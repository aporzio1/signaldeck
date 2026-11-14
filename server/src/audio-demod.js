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
    // Squelch lives here, on the audio every listener shares: the phone only
    // plays what the Pi already decided, so every listener hears the same
    // silence. 0 = auto (chase the noise floor); above that is a manual
    // threshold on the 0..1 level scale.
    this.squelch = 0;
    this.gateClosed = false;
    this.gateLevel = 0;
    this.noiseFloor = 0.05;
    this.framePeak = 0;
    this.gateAt = 0;
    this.onGate = null;
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

  setSquelch(value) {
    const next = Number(value);
    this.squelch = Number.isFinite(next) && next > 0 ? Math.min(next, 0.9) : 0;
    this.gateClosed = false; // re-open honestly on the frames that follow
    this.publishGate(true);
    return this.gate();
  }

  gateThreshold() {
    if (this.squelch > 0) return this.squelch;
    return Math.min(0.35, this.noiseFloor * 2.2 + 0.015);
  }

  gate() {
    return {
      closed: this.gateClosed,
      threshold: Number(this.gateThreshold().toFixed(3)),
      level: Number(this.gateLevel.toFixed(3)),
      auto: this.squelch === 0,
      floor: Number(this.noiseFloor.toFixed(3)),
    };
  }

  publishGate(force = false) {
    if (!this.onGate) return;
    const now = Date.now();
    if (!force && now - this.gateAt < 400) return;
    this.gateAt = now;
    this.onGate(this.gate());
  }

  reset() {
    this.lp = new Float32Array(this.decim);
    this.lpIndex = 0;
    this.lpSum = 0;
    this.dcAvg = 0;
    this.out = new Int16Array(OUT_SAMPLES);
    this.outCount = 0;
    this.count = 0;
    this.framePeak = 0;
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
      const magnitude = sample < 0 ? -sample : sample;
      if (magnitude > this.framePeak) this.framePeak = magnitude;
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
      // One gate decision per 20 ms frame, on the decimated level. Auto mode
      // rides the noise floor with hysteresis so it holds open through speech
      // and shuts on hiss; a manual threshold just wins.
      const peak = this.framePeak;
      this.framePeak = 0;
      this.gateLevel = 0.2 * peak + 0.8 * this.gateLevel;
      if (this.gateLevel < this.noiseFloor) this.noiseFloor = 0.95 * this.noiseFloor + 0.05 * this.gateLevel;
      else this.noiseFloor += (this.gateLevel - this.noiseFloor) * 0.02;
      const threshold = this.gateThreshold();
      if (this.gateLevel > threshold * 1.3) this.gateClosed = false;
      else if (this.gateLevel < threshold) this.gateClosed = true;
      this.publishGate();
      const pcm = this.gateClosed ? new Int16Array(this.outCount) : this.out.slice(0, this.outCount);
      this.outCount = 0;
      this.emit(pcm, this.outRate);
    }
  }

  /** Discard partial audio (retune): stale frequencies must not drain. */
  drop() {
    this.outCount = 0;
    this.framePeak = 0;
  }
}
