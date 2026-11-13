import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, ROOT, VERSION } from './config.js';
import { isLinux, isMac, readText, run, which } from './util.js';

let lastCpu = null;

function cpuSnapshot() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.irq + t.idle;
  }
  return { idle, total, count: cpus.length, model: cpus[0]?.model?.trim() || 'unknown' };
}

function cpuPercent(snapshot) {
  if (!lastCpu) {
    lastCpu = snapshot;
    return 0;
  }
  const idleDelta = snapshot.idle - lastCpu.idle;
  const totalDelta = snapshot.total - lastCpu.total;
  lastCpu = snapshot;
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
}

export async function cpuTemperature() {
  if (isLinux) {
    const raw = await readText('/sys/class/thermal/thermal_zone0/temp', 64);
    if (raw) {
      const value = Number(raw.trim());
      if (Number.isFinite(value)) return value > 1000 ? value / 1000 : value;
    }
  }
  if (isMac) {
    const res = await run('sh', ['-c', "sysctl -n machdep.xcpus.max 2>/dev/null; true"]);
    if (!res.ok) return null;
  }
  return null;
}

function memInfo() {
  const total = os.totalmem();
  const free = os.freemem();
  return { total, free, used: total - free, percent: ((total - free) / total) * 100 };
}

async function diskInfo() {
  try {
    const stats = await fs.promises.statfs(DATA_DIR);
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    return { total, free, used: total - free, percent: ((total - free) / total) * 100 };
  } catch {
    return null;
  }
}

function networkInfo() {
  const interfaces = os.networkInterfaces();
  const out = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      out.push({ name, address: address.address, mac: address.mac });
    }
  }
  return out;
}

async function throttleInfo() {
  if (!isLinux) return null;
  const raw = await readText('/sys/class/power_supply/raspberrypi/temp', 64);
  if (raw) return { underVoltage: raw.trim() === '1' };
  return null;
}

export async function systemStats() {
  const snapshot = cpuSnapshot();
  const load = os.loadavg();
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    uptime: os.uptime(),
    cpu: {
      model: snapshot.model,
      cores: snapshot.count,
      percent: Number(cpuPercent(snapshot).toFixed(1)),
      load1: Number((load[0] || 0).toFixed(2)),
      load5: Number((load[1] || 0).toFixed(2)),
      load15: Number((load[2] || 0).toFixed(2)),
    },
    memory: memInfo(),
    disk: await diskInfo(),
    temperature: await cpuTemperature(),
    network: networkInfo(),
    power: await throttleInfo(),
    node: process.version,
    pid: process.pid,
    dataDir: DATA_DIR,
    root: ROOT,
    version: VERSION,
  };
}

const ALLOWED_SERVICES = ['gpsd', 'meshtasticd', 'openhop-repeater', 'signaldeck', 'chrony', 'chronyd', 'ssh', 'tailscaled', 'avahi-daemon'];

export async function serviceStatus(unit) {
  if (!isLinux) return { unit, active: false, state: 'unsupported', enabled: false, description: 'Not available on this platform' };
  const res = await run('systemctl', ['show', unit, '-p', 'ActiveState', '-p', 'SubState', '-p', 'UnitFileState', '-p', 'Description', '--no-pager'], {
    timeout: 5000,
  });
  const data = {};
  for (const line of res.stdout.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) data[line.slice(0, idx)] = line.slice(idx + 1).trim();
  }
  return {
    unit,
    active: data.ActiveState === 'active',
    state: data.ActiveState || 'unknown',
    subState: data.SubState || '',
    enabled: data.UnitFileState === 'enabled',
    description: data.Description || '',
    available: Boolean(data.ActiveState),
  };
}

export async function allServices() {
  return Promise.all(ALLOWED_SERVICES.map((unit) => serviceStatus(unit)));
}

export async function controlService(unit, action) {
  if (!ALLOWED_SERVICES.includes(unit)) throw Object.assign(new Error(`Service ${unit} is not managed by SignalDeck.`), { status: 400 });
  if (!['start', 'stop', 'restart'].includes(action)) throw Object.assign(new Error('Unsupported action.'), { status: 400 });
  // The service runs as an unprivileged user, so unit changes go through the
  // narrow sudoers rules written by install.sh.
  const command = process.getuid?.() === 0 ? 'systemctl' : 'sudo';
  const args = process.getuid?.() === 0 ? [action, unit] : ['-n', 'systemctl', action, unit];
  const res = await run(command, args, { timeout: 20000 });
  const status = await serviceStatus(unit);
  return { ok: res.ok, output: res.stderr || res.stdout, status };
}

export async function journal(unit, lines = 200) {
  if (!isLinux) return '';
  const args = ['-n', String(Math.min(Math.max(Number(lines) || 200, 10), 1000)), '--no-pager', '-o', 'short-iso'];
  if (unit && ALLOWED_SERVICES.includes(unit)) args.push('-u', unit);
  args.push('-b');
  const res = await run('journalctl', args, { timeout: 12000, maxBuffer: 2 * 1024 * 1024 });
  return res.ok ? res.stdout : res.stderr || 'journalctl is not available.';
}

export async function powerAction(action) {
  if (!['reboot', 'shutdown'].includes(action)) throw Object.assign(new Error('Unsupported action.'), { status: 400 });
  if (!isLinux) throw Object.assign(new Error('Power actions are only available on the Raspberry Pi.'), { status: 400 });
  const verb = action === 'shutdown' ? 'poweroff' : 'reboot';
  const res = await run('sudo', ['-n', 'systemctl', verb], { timeout: 8000 });
  if (!res.ok) throw Object.assign(new Error(res.stderr || 'sudo was refused. Check the sudoers rule installed by install.sh.'), { status: 500 });
  return { ok: true, message: `${action} scheduled` };
}

export async function pythonInfo() {
  const pythonCandidates = [path.join(ROOT, 'venv', 'bin', 'python'), 'python3'];
  for (const bin of pythonCandidates) {
    if (bin.startsWith('/') && !fs.existsSync(bin)) continue;
    const res = await run(bin, ['-c', 'import sys;print(sys.version.split()[0])'], { timeout: 5000 });
    if (res.ok) {
      const version = res.stdout.trim();
      const mesh = await run(bin, ['-c', "import meshtastic;print(meshtastic.__version__)"], { timeout: 15000 });
      const core = await run(bin, ['-c', 'import meshcore;print("ok")'], { timeout: 15000 });
      return {
        binary: bin,
        version,
        meshtastic: mesh.ok ? mesh.stdout.trim() : null,
        meshcore: core.ok,
        venv: bin.startsWith('/'),
      };
    }
  }
  return { binary: null, version: null, meshtastic: null, meshcore: false, venv: false };
}

export async function toolAvailability() {
  const tools = ['rtl_tcp', 'rtl_test', 'rtl_fm', 'gpsd', 'pinctrl', 'i2cdetect', 'hwclock', 'chronyc', 'systemctl'];
  const entries = await Promise.all(tools.map(async (tool) => [tool, await which(tool)]));
  return Object.fromEntries(entries);
}
