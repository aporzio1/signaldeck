import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * Run a binary with an argument array. Never uses a shell, so user input can
 * never be interpreted as shell syntax.
 * @returns {Promise<{ok:boolean, code:number|null, stdout:string, stderr:string, error?:string}>}
 */
export function run(bin, args = [], opts = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(
      bin,
      args,
      {
        timeout: opts.timeout ?? 15000,
        maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
        env: { ...process.env, ...(opts.env || {}) },
        cwd: opts.cwd,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
        resolve({
          ok: !error,
          code,
          stdout: stdout?.toString() ?? '',
          stderr: stderr?.toString() ?? '',
          error: error ? String(error.message || error) : undefined,
          ms: Date.now() - started,
        });
      },
    );
  });
}

export async function which(bin) {
  if (!/^[\w./+-]+$/.test(String(bin))) return null;
  const res = await run('sh', ['-c', `command -v ${JSON.stringify(bin)}`], { timeout: 4000 });
  return res.ok ? res.stdout.trim() : null;
}

export async function readText(file, max = 512 * 1024) {
  try {
    const stat = await fs.stat(file);
    if (stat.size > max) return null;
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

export async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function listDir(dir) {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

export function httpError(status, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  err.extra = extra;
  return err;
}

export function parseJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** Merge plain objects recursively; arrays and scalars from `patch` win. */
export function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch ?? base;
  const out = Array.isArray(base) ? [...base] : { ...(base || {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base?.[key] && typeof base[key] === 'object') {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Pick only allow-listed keys from an object. */
export function pick(obj, keys) {
  const out = {};
  for (const key of keys) if (obj && key in obj) out[key] = obj[key];
  return out;
}

export function safeFilename(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'file';
}

export function tokenize(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean);
}

export const isMac = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';

export function pathJoin(...parts) {
  return path.join(...parts);
}
