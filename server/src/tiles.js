import fs from 'node:fs';
import path from 'node:path';
import { logger } from './log.js';

const log = logger('tiles');

const UPSTREAM = 'https://tile.openstreetmap.org';
// OSM serves a 403 "Blocked tiles" placeholder when requests look like a
// bare scripted fetch: a real browser User-Agent and an OSM Referer are
// required. See https://wiki.openstreetmap.org/wiki/Blocked_tiles
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  Referer: 'https://www.openstreetmap.org/',
  Accept: 'image/png,image/*;q=0.8',
};

const MAX_ZOOM = 19;
const CACHE_BYTES = 64 * 1024 * 1024;

/**
 * Disk-cached raster tile proxy. The browser asks the Pi, the Pi asks OSM with
 * headers OSM will answer, and repeat views never leave the LAN.
 */
export function createTileCache(dir) {
  fs.mkdirSync(dir, { recursive: true });

  const pending = new Map();

  const keyFor = (z, x, y) => {
    if (!Number.isInteger(z) || z < 0 || z > MAX_ZOOM) return null;
    const max = 1 << z;
    if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
    if (x < 0 || x >= max || y < 0 || y >= max) return null;
    return { file: path.join(dir, `${z}-${x}-${y}.png`), z, x, y };
  };

  async function fetchTile(z, x, y) {
    const res = await fetch(`${UPSTREAM}/${z}/${x}/${y}.png`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('empty tile');
    return buf;
  }

  async function get(z, x, y) {
    const key = keyFor(z, x, y);
    if (!key) return { status: 404 };
    const cached = await fs.promises.readFile(key.file).catch(() => null);
    if (cached?.length) return { status: 200, body: cached, cached: true };
    if (pending.has(key.file)) return { status: 202 };
    pending.set(key.file, true);
    try {
      const body = await fetchTile(key.z, key.x, key.y);
      await fs.promises.writeFile(key.file, body).catch(() => {});
      return { status: 200, body };
    } catch (error) {
      log.warn(`${key.z}/${key.x}/${key.y}: ${error.message}`);
      return { status: 502 };
    } finally {
      pending.delete(key.file);
    }
  }

  let pruning = false;
  async function prune() {
    if (pruning) return;
    pruning = true;
    try {
      const names = await fs.promises.readdir(dir);
      const stats = await Promise.all(
        names.map(async (name) => {
          const full = path.join(dir, name);
          const st = await fs.promises.stat(full).catch(() => null);
          return st ? { full, size: st.size, atimeMs: st.atimeMs } : null;
        }),
      );
      const files = stats.filter(Boolean);
      let total = files.reduce((sum, f) => sum + f.size, 0);
      if (total <= CACHE_BYTES) return;
      files.sort((a, b) => a.atimeMs - b.atimeMs);
      for (const file of files) {
        if (total <= CACHE_BYTES * 0.8) break;
        await fs.promises.rm(file.full, { force: true }).catch(() => {});
        total -= file.size;
      }
    } finally {
      pruning = false;
    }
  }

  const handler = async (req, res) => {
    const m = /^\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(req.path);
    if (!m) return res.status(404).end();
    const out = await get(Number(m[1]), Number(m[2]), Number(m[3]));
    if (out.status !== 200) return res.status(out.status === 202 ? 204 : out.status).end();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('X-Tile-Cache', out.cached ? 'hit' : 'miss');
    res.end(out.body);
    if (!out.cached) prune();
  };

  return { handler, dir };
}
