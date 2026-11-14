import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTileCache } from '../src/tiles.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-tiles-'));

function fakeResponse() {
  return {
    headers: {},
    body: null,
    statusCode: null,
    ended: false,
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(code) {
      this.statusCode = code;
      return { end: () => { this.ended = true; } };
    },
    end(body) {
      this.body = body ?? null;
      this.ended = true;
    },
  };
}

test('serves tiles through a cache instead of a browser-side cross-origin fetch', async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, headers: init.headers });
    return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  };
  try {
    const tiles = createTileCache(dir);
    const req = { path: '/3/4/5.png' }; // express strips the /tiles mount prefix
    const first = fakeResponse();
    await tiles.handler(req, first);
    assert.equal(first.statusCode, null);
    assert.equal(first.headers['Content-Type'], 'image/png');
    assert.equal(first.headers['X-Tile-Cache'], 'miss');
    assert.equal(Buffer.from(first.body).length, 3);

    const second = fakeResponse();
    await tiles.handler(req, second);
    assert.equal(second.headers['X-Tile-Cache'], 'hit');
    assert.equal(seen.length, 1, 'second read must not hit the network');

    // OSM rejects scripted fetches; the proxy must look like a browser.
    assert.match(seen[0].headers['User-Agent'], /^Mozilla\/5\.0/);
    assert.equal(seen[0].headers.Referer, 'https://www.openstreetmap.org/');
    assert.equal(seen[0].url, 'https://tile.openstreetmap.org/3/4/5.png');
  } finally {
    globalThis.fetch = original;
  }
});

test('rejects out-of-range tiles and non-tile paths', async () => {
  const tiles = createTileCache(dir);
  for (const p of ['/20/0/0.png', '/2/8/0.png', '/2/0/-1.png', '/a/b/c.png']) {
    const res = fakeResponse();
    await tiles.handler({ path: p }, res);
    assert.ok(res.statusCode === 404 || res.statusCode === 502, `${p} should not be served`);
  }
});
