import test from 'node:test';
import assert from 'node:assert/strict';
import { addRepeater, listRepeaters, removeRepeater, setLocation } from '../src/repeaters.js';

// The store writes through to DATA_DIR like any other state; this exercises
// the geometry and merging that the repeater book page depends on.

test('saved repeaters sort by distance from the active QTH', async () => {
  setLocation({ lat: 26.12, lon: -80.14, label: 'WPB', source: 'manual' });
  const near = addRepeater({ name: 'Near', frequency: 146940000, lat: 26.13, lon: -80.15, mode: 'FM' });
  const far = addRepeater({ name: 'Far', frequency: 145170000, lat: 27.95, lon: -82.46, mode: 'FM' });
  try {
    const out = await listRepeaters({ lat: 26.12, lon: -80.14, radiusMi: 200 });
    const names = out.repeaters.map((r) => r.name);
    assert.ok(names.indexOf('Near') < names.indexOf('Far'), 'distance ordering');
    const nearEntry = out.repeaters.find((r) => r.name === 'Near');
    assert.ok(nearEntry.distanceMi < 10, `near entry distance ${nearEntry.distanceMi}`);
    assert.equal(typeof nearEntry.bearingDeg, 'number');
    assert.equal(out.qth.lat, 26.12);
  } finally {
    removeRepeater(near.id);
    removeRepeater(far.id);
  }
});

test('entries outside the radius are filtered, MHz input is normalised to Hz', async () => {
  const entry = addRepeater({ name: 'Tiny', frequency: 223.5, lat: 25.76, lon: -80.19 });
  try {
    assert.equal(entry.frequency, 223500000, 'MHz values become Hz');
    const out = await listRepeaters({ lat: 26.12, lon: -80.14, radiusMi: 10 });
    assert.ok(!out.repeaters.some((r) => r.name === 'Tiny'), 'filtered by radius');
  } finally {
    removeRepeater(entry.id);
  }
});

test('catalog entries without a QTH are still listed unsorted', async () => {
  const entry = addRepeater({ name: 'Orphan', frequency: 443500000, lat: null, lon: null });
  try {
    const out = await listRepeaters({ lat: undefined, lon: undefined });
    assert.ok(out.repeaters.some((r) => r.name === 'Orphan' && r.distanceMi === undefined));
  } finally {
    removeRepeater(entry.id);
  }
});
