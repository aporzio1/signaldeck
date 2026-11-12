/// <reference lib="webworker" />

const OUT_RATE = 48000;
const FFT_SIZE = 2048;

let sampleRate = 1024000;
let demod = 'nfm';
let squelchDb = -70;
let volume = 0.8;

let fftRe = new Float32Array(FFT_SIZE);
let fftIm = new Float32Array(FFT_SIZE);
let windowFn = new Float32Array(FFT_SIZE);
let specFill = 0;

let prevI = 0;
let prevQ = 0;
let dcI = 0;
let dcQ = 0;
let hpPrev = 0;
let hpOut = 0;
let deemph = 0;
let power = 0;
let squelchOpen = false;
let ssbPhase = 0;
let ssbI = 0;
let ssbQ = 0;

let decimAcc = 0;
let decimCount = 0;
let audioChunk: Float32Array = new Float32Array(4096);
let audioFill = 0;
let blocks = 0;
let lastMeter = 0;

for (let i = 0; i < FFT_SIZE; i++) {
  const x = i / (FFT_SIZE - 1);
  windowFn[i] = 0.42 - 0.5 * Math.cos(2 * Math.PI * x) + 0.08 * Math.cos(4 * Math.PI * x);
}

function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let j = 0; j < half; j++) {
        const aRe = re[i + j];
        const aIm = im[i + j];
        const bRe = re[i + j + half] * curRe - im[i + j + half] * curIm;
        const bIm = re[i + j + half] * curIm + im[i + j + half] * curRe;
        re[i + j] = aRe + bRe;
        im[i + j] = aIm + bIm;
        re[i + j + half] = aRe - bRe;
        im[i + j + half] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

function publishSpectrum() {
  const re = fftRe;
  const im = fftIm;
  // Hann/Blackman window already applied while filling.
  fft(re, im);
  const bins = new Float32Array(FFT_SIZE);
  const norm = 2 / FFT_SIZE;
  for (let i = 0; i < FFT_SIZE; i++) {
    const shifted = (i + FFT_SIZE / 2) % FFT_SIZE;
    const mag = Math.hypot(re[shifted], im[shifted]) * norm;
    bins[i] = 20 * Math.log10(mag + 1e-9);
  }
  (self as any).postMessage({ type: 'spectrum', bins, sampleRate }, [bins.buffer]);
  re.fill(0);
  im.fill(0);
}

function pushAudio(value: number) {
  audioChunk[audioFill++] = value;
  if (audioFill >= audioChunk.length) {
    const out = audioChunk.slice(0, audioFill);
    (self as any).postMessage({ type: 'audio', samples: out }, [out.buffer]);
    audioFill = 0;
  }
}

self.onmessage = (event: MessageEvent) => {
  const message = event.data;
  if (message.type === 'config') {
    if (message.sampleRate) sampleRate = message.sampleRate;
    if (message.demod) demod = message.demod;
    if (typeof message.squelch === 'number') squelchDb = message.squelch;
    if (typeof message.volume === 'number') volume = message.volume;
    return;
  }
  if (message.type !== 'iq') return;

  const bytes = new Uint8Array(message.buffer);
  const samples = bytes.length >> 1;
  const ratio = sampleRate / OUT_RATE;
  const envAlpha = 1 - Math.exp((-2 * Math.PI * 3000) / OUT_RATE);
  const deemphAlpha = 1 - Math.exp((-2 * Math.PI * 2122) / OUT_RATE);
  const ssbStep = (2 * Math.PI * 1500) / sampleRate;
  const fmScale = demod === 'wfm' ? 0.35 : 1.4;

  for (let i = 0; i < samples; i++) {
    const iRaw = (bytes[i * 2] - 127.5) / 127.5;
    const qRaw = (bytes[i * 2 + 1] - 127.5) / 127.5;

    // spectrum ring
    fftRe[specFill] = iRaw * windowFn[specFill];
    fftIm[specFill] = qRaw * windowFn[specFill];
    specFill += 1;
    if (specFill >= FFT_SIZE) {
      specFill = 0;
      publishSpectrum();
    }

    const instPower = iRaw * iRaw + qRaw * qRaw;
    power = power * 0.999 + instPower * 0.001;

    let value = 0;
    if (demod === 'am') {
      const env = Math.sqrt(instPower);
      hpOut = 0.995 * (hpOut + env - hpPrev);
      hpPrev = env;
      value = hpOut;
    } else if (demod === 'usb' || demod === 'lsb') {
      ssbPhase += demod === 'usb' ? ssbStep : -ssbStep;
      if (ssbPhase > Math.PI) ssbPhase -= 2 * Math.PI;
      const c = Math.cos(ssbPhase);
      const s = Math.sin(ssbPhase);
      const mixedI = iRaw * c + qRaw * s;
      const mixedQ = -iRaw * s + qRaw * c;
      ssbI += (mixedI - ssbI) * envAlpha;
      ssbQ += (mixedQ - ssbQ) * envAlpha;
      value = ssbI;
    } else {
      // quadrature FM discriminator
      const dot = iRaw * prevI + qRaw * prevQ;
      const cross = qRaw * prevI - iRaw * prevQ;
      value = Math.atan2(cross, dot) * fmScale;
      if (demod === 'wfm') {
        deemph += (value - deemph) * deemphAlpha;
        value = deemph;
      }
    }
    prevI = iRaw;
    prevQ = qRaw;

    // squelch with hysteresis
    const db = 10 * Math.log10(power + 1e-12);
    if (!squelchOpen && db > squelchDb + 3) squelchOpen = true;
    else if (squelchOpen && db < squelchDb - 3) squelchOpen = false;

    const outValue = squelchOpen ? value * volume : 0;

    decimAcc += outValue;
    decimCount += 1;
    while (decimCount >= ratio) {
      pushAudio(decimAcc / decimCount);
      decimAcc = 0;
      decimCount -= ratio;
    }
  }

  blocks += 1;
  const now = performance.now();
  if (now - lastMeter > 120) {
    lastMeter = now;
    (self as any).postMessage({
      type: 'meter',
      db: 10 * Math.log10(power + 1e-12),
      open: squelchOpen,
      blocks,
    });
  }
};
