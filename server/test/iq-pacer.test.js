import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IqPacer } from '../src/iq-pacer.js';
import { SdrService } from '../src/sdr.js';

test('pacer preserves IQ bytes, even framing, rate changes and stop', () => {
  const emitted = [];
  const pacer = new IqPacer(1000, (b) => emitted.push(b));
  const input = Buffer.from(Array.from({length: 800}, (_, i) => i % 256));
  pacer.push(input.subarray(0, 321));
  pacer.push(input.subarray(321));
  pacer.tick();
  for (let i = 0; i < 10; i++) { pacer.last -= 10; pacer.tick(); }
  assert.ok(emitted.length);
  assert.ok(emitted.every((b) => b.length % 2 === 0));
  const result = Buffer.concat(emitted);
  assert.deepEqual(result, input.subarray(0, result.length));
  pacer.setRate(2000);
  assert.equal(pacer.bytes, 0);
  assert.equal(pacer.started, false);
  pacer.stop();
});

test('tune autostarts and propagates startup failure', async () => {
  const sdr = new SdrService();
  let starts = 0;
  sdr.start = async () => { starts++; sdr.state.running = true; };
  await sdr.tune({frequency: 96600000});
  assert.equal(starts, 1);
  assert.equal(sdr.state.frequency, 96600000);
  const failed = new SdrService();
  failed.start = async () => { throw new Error('device busy'); };
  await assert.rejects(failed.tune({frequency: 96600000}), /device busy/);
});
