import { IqPacer } from '../src/iq-pacer.js';

// rtl_tcp default zero-copy delivery: 256KB wave every ~128 ms.
// Scenario: client listens 2.5 s, leaves for 3 s, comes back. The pacer must
// hold the reservoir while nobody listens so the returning client never sees
// raw wave cadence (the t+65s regression this class exists to kill).
const rate = 1024000;
let consumers = 0;
const pacer = new IqPacer(rate, () => {}, () => consumers);
const emits = [];
const gaps = [];
pacer.emit = (buf) => {
  const t = performance.now();
  if (emits.length) gaps.push([t - emits[emits.length - 1], emits.length]);
  emits.push(t);
  if (buf.length % 2) throw new Error('odd IQ frame');
};

const wave = Buffer.alloc(256 * 1024, 7);
const feed = setInterval(() => pacer.push(wave), 128);

setTimeout(() => { consumers = 1; }, 800);      // client 1 arrives
setTimeout(() => { consumers = 0; }, 3300);     // leaves (hold window)
setTimeout(() => { consumers = 1; }, 6300);     // returns — must be smooth now
setTimeout(() => {
  clearInterval(feed);
  setTimeout(() => {
    pacer.stop();
    const returnEmissions = gaps.filter(([, i]) => (emits[i - 1] - emits[0]) / 1000 > 6.3);
    const vals = returnEmissions.map((g) => g[0]).sort((a, b) => a - b);
    if (vals.length < 10) {
      console.log(`session2 emissions too sparse: ${vals.length + 1}`);
      process.exit(1);
    }
    const med = vals[Math.floor(vals.length / 2)];
    const max = vals.at(-1);
    console.log(`session2 emits=${vals.length + 1} med=${med.toFixed(1)}ms max=${max.toFixed(1)}ms`);
    const ok = max < 50;
    console.log(ok ? 'PASS' : 'FAIL');
    process.exit(ok ? 0 : 1);
  }, 300);
}, 8800);
