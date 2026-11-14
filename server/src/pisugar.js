import net from 'node:net';
import { isLinux } from './util.js';

// PiSugar UPS boards ship pisugar-server, which speaks a small CLI over TCP
// (default 8423). We only read; every command is one line in, one line out.
const HOST = process.env.PISUGAR_HOST || '127.0.0.1';
const PORT = Number(process.env.PISUGAR_PORT || 8423);
const TTL_MS = 10_000;

let cache = { at: 0, value: null };

function ask(command, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: HOST, port: PORT });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => socket.write(`${command}\n`));
    socket.on('data', (chunk) => done(chunk.toString('utf8')));
    socket.on('timeout', () => done(null));
    socket.on('error', () => done(null));
  });
}

function numberFrom(text) {
  if (!text) return null;
  const match = text.match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

export async function pisugarStatus() {
  if (!isLinux) return null;
  if (Date.now() - cache.at < TTL_MS) return cache.value;
  const [percent, volts, amps, plugged, model] = await Promise.all([
    ask('get battery'),
    ask('get battery_v'),
    ask('get battery_i'),
    ask('get battery_power_plugged'),
    ask('get model'),
  ]);
  if (percent === null && model === null) {
    cache = { at: Date.now(), value: null };
    return null;
  }
  const value = {
    present: true,
    model: (model || '').replace(/^[a-z_]+:\s*/i, '').trim() || 'PiSugar',
    percent: numberFrom(percent),
    volts: numberFrom(volts),
    amps: numberFrom(amps),
    plugged: /true|1\b/.test((plugged || '').toLowerCase()),
  };
  cache = { at: Date.now(), value };
  return value;
}
