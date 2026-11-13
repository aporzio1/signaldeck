import fs from 'node:fs';
import path from 'node:path';
import { getSettings } from './config.js';
import { isLinux, listDir, readText, run, which } from './util.js';

const CONFIG_CANDIDATES = ['/boot/firmware/config.txt', '/boot/config.txt'];

export async function configPath() {
  for (const candidate of CONFIG_CANDIDATES) {
    try {
      await fs.promises.access(candidate);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export async function readBootConfig() {
  const file = await configPath();
  if (!file) return { path: null, text: '' };
  return { path: file, text: (await readText(file, 256 * 1024)) || '' };
}

const hasLine = (text, needle) =>
  text.split('\n').some((raw) => {
    // Ignore inline comments so lines this tool itself wrote
    // (`dtparam=spi=on  # SX1262 LoRa radio`) count as present instead of
    // being appended again on every apply.
    const line = raw.split('#')[0].trim();
    return line === needle || line.startsWith(`${needle},`);
  });

export const REQUIRED_LINES = [
  { key: 'spi', line: 'dtparam=spi=on', label: 'SPI bus', why: 'SX1262 LoRa radio' },
  { key: 'i2c', line: 'dtparam=i2c_arm=on', label: 'I2C bus', why: 'PCF85063A real-time clock' },
  { key: 'rtc', line: 'dtoverlay=i2c-rtc,pcf85063a', label: 'RTC overlay', why: 'Exposes the HAT clock as /dev/rtc*' },
  { key: 'uart', line: 'enable_uart=1', label: 'UART', why: 'GNSS receiver at 9600 baud' },
];

export async function hardwareOverview() {
  const settings = getSettings();
  const [{ path: bootPath, text: bootConfig }, rtcList, spidev, serialDevices, i2cDevices, model, osRelease, tools, i2cNames] =
    await Promise.all([
      readBootConfig(),
      rtcDevices(),
      listDir('/dev').then((names) => names.filter((n) => n.startsWith('spidev'))),
      listDir('/dev').then((names) => names.filter((n) => /^(ttyAMA|ttyS|serial|ttyUSB|ttyACM)/.test(n))),
      listDir('/dev').then((names) => names.filter((n) => n.startsWith('i2c-'))),
      readText('/proc/device-tree/model', 256),
      readText('/etc/os-release', 4096),
      import('./system.js').then((m) => m.toolAvailability()),
      listI2cNames(),
    ]);

  const required = REQUIRED_LINES.map((item) => ({
    ...item,
    present: hasLine(bootConfig, item.line),
    recommended: item.key === 'uart' ? true : true,
  }));

  const rtl = await detectRtl();

  return {
    platform: process.platform,
    isPi: /raspberry pi/i.test(model || ''),
    model: model ? model.replace(/\0/g, '').trim() : 'Unknown device',
    os: parseOsRelease(osRelease),
    bootConfigPath: bootPath,
    bootConfigTail: bootConfig ? bootConfig.split('\n').slice(-40).join('\n') : '',
    required,
    allConfigured: required.every((r) => r.present),
    rtc: rtcList,
    rtcPreferred: settings.time.rtcDevice || rtcList.find((r) => /pcf85063|rtc/i.test(r.name))?.device || rtcList[0]?.device || '',
    spidev,
    serialDevices,
    i2cDevices,
    i2cNames,
    tools,
    rtl,
    gpio: await gpioState(settings),
    rails: [
      { key: 'gps', name: 'GPS rail', pin: 27, note: 'uConsole AIO V2 only' },
      { key: 'lora', name: 'LoRa rail', pin: 16, note: 'uConsole AIO V2 only' },
      { key: 'sdr', name: 'SDR rail', pin: 7, note: 'uConsole AIO V2 only' },
      { key: 'usb', name: 'Internal USB rail', pin: 23, note: 'uConsole AIO V2 only' },
    ],
  };
}

function parseOsRelease(text) {
  if (!text) return { name: 'Unknown', version: '' };
  const map = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) map[line.slice(0, idx)] = line.slice(idx + 1).replace(/^"|"$/g, '');
  }
  return { name: map.PRETTY_NAME || map.NAME || 'Unknown', version: map.VERSION_ID || '', id: map.ID || '' };
}

async function listI2cNames() {
  const names = [];
  const dirs = await listDir('/sys/bus/i2c/devices');
  for (const dir of dirs) {
    const name = await readText(path.join('/sys/bus/i2c/devices', dir, 'name'), 128);
    if (name) names.push({ device: dir, name: name.trim() });
  }
  return names;
}

export async function rtcDevices() {
  const dirs = await listDir('/sys/class/rtc');
  const out = [];
  for (const dir of dirs.sort()) {
    const base = path.join('/sys/class/rtc', dir);
    const [name, date, time, epoch, hctosys] = await Promise.all([
      readText(path.join(base, 'name'), 128),
      readText(path.join(base, 'date'), 64),
      readText(path.join(base, 'time'), 64),
      readText(path.join(base, 'since_epoch'), 64),
      readText(path.join(base, 'hctosys'), 8),
    ]);
    out.push({
      device: `/dev/${dir}`,
      name: name?.trim() || dir,
      date: date?.trim() || '',
      time: time?.trim() || '',
      epoch: epoch ? Number(epoch.trim()) : null,
      systemClock: hctosys?.trim() === '1',
    });
  }
  return out;
}

export async function detectRtl() {
  if (!isLinux) return { devices: [], raw: 'SDR hardware detection is only available on Linux.', available: false };
  const bin = (await which('rtl_test')) || 'rtl_test';
  const res = await run(bin, ['-t'], { timeout: 12000 });
  const raw = `${res.stdout}\n${res.stderr}`.trim();
  const serials = [...raw.matchAll(/SN:\s*([0-9A-Za-z]+)/g)].map((m) => m[1]);
  const found = /Found\s+(\d+)\s+device/i.exec(raw);
  const count = found ? Number(found[1]) : serials.length;
  return {
    available: res.ok && count > 0,
    count,
    devices: serials.map((serial, index) => ({ index, serial, label: `RTL-SDR #${index} (${serial})` })),
    raw: raw.split('\n').slice(0, 20).join('\n'),
  };
}

export async function gpioState(settings) {
  if (!isLinux) return { available: false, pins: [] };
  const pinctrl = await which('pinctrl');
  if (!pinctrl) return { available: false, pins: [] };
  const pins = [27, 16, 7, 23];
  const out = [];
  for (const pin of pins) {
    const res = await run(pinctrl, ['get', String(pin)], { timeout: 4000 });
    out.push({ pin, state: res.ok ? res.stdout.trim() : 'unknown' });
  }
  return { available: true, pins: out };
}

export async function setRail(pin, on) {
  if (!isLinux) throw Object.assign(new Error('GPIO control requires Linux.'), { status: 400 });
  const allowed = [27, 16, 7, 23];
  if (!allowed.includes(Number(pin))) throw Object.assign(new Error('Pin not allowed.'), { status: 400 });
  const pinctrl = await which('pinctrl');
  if (!pinctrl) throw Object.assign(new Error('pinctrl not found (requires Raspberry Pi OS).'), { status: 400 });
  await run(pinctrl, [String(pin), 'op'], { timeout: 4000 });
  const res = await run(pinctrl, [String(pin), on ? 'dh' : 'dl'], { timeout: 4000 });
  if (!res.ok) throw Object.assign(new Error(res.stderr || 'pinctrl failed'), { status: 500 });
  return { pin: Number(pin), on: Boolean(on) };
}

/**
 * Append missing overlays to config.txt. A timestamped backup is always created
 * and the file is only written when something actually changes.
 */
export async function applyBootConfig(keys) {
  const file = await configPath();
  if (!file) throw Object.assign(new Error('No /boot/firmware/config.txt found.'), { status: 400 });
  // A read failure or an oversized file previously degraded to '' and the
  // generated lines replaced the user's entire boot config below. Fail closed.
  const text = await readText(file, 256 * 1024);
  if (text === null) {
    throw Object.assign(new Error(`Could not read ${file}; refusing to overwrite it.`), { status: 500 });
  }
  const wanted = REQUIRED_LINES.filter((item) => !keys?.length || keys.includes(item.key));
  const missing = wanted.filter((item) => !hasLine(text, item.line));
  if (!missing.length) return { changed: false, path: file, added: [] };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${file}.signaldeck-${stamp}.bak`;
  const backedUp = await run('sudo', ['-n', 'cp', file, backup], { timeout: 8000 });
  if (!backedUp.ok) {
    throw Object.assign(new Error(backedUp.stderr || 'Backup of the boot config failed; refusing to write without one.'), { status: 500 });
  }
  const addition = `\n# SignalDeck: HackerGadgets RTL-SDR/LoRa/GPS/RTC HAT\n${missing.map((m) => `${m.line}  # ${m.why}`).join('\n')}\n`;

  const tmp = `/tmp/signaldeck-config-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
  await fs.promises.writeFile(tmp, text.replace(/\s*$/, '\n') + addition);
  const res = await run('sudo', ['-n', 'cp', tmp, file], { timeout: 8000 });
  await fs.promises.unlink(tmp).catch(() => {});
  if (!res.ok) {
    throw Object.assign(new Error(res.stderr || 'Could not write boot config (check the sudoers rule from install.sh).'), { status: 500 });
  }
  return { changed: true, path: file, added: missing.map((m) => m.line), backup, rebootRequired: true };
}

export async function readMeshtasticdConfig() {
  const file = '/etc/meshtasticd/config.yaml';
  return readText(file, 128 * 1024);
}

export async function writeMeshtasticdConfig(text, restart = false) {
  if (!isLinux) throw Object.assign(new Error('Writing meshtasticd config requires Linux.'), { status: 400 });
  if (typeof text !== 'string' || text.length > 64 * 1024) {
    throw Object.assign(new Error('Configuration text is missing or too large.'), { status: 400 });
  }
  if (!/^Lora:/m.test(text)) throw Object.assign(new Error('The config must contain a Lora: section.'), { status: 400 });

  const dir = '/etc/meshtasticd';
  const file = `${dir}/config.yaml`;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await run('sudo', ['-n', 'mkdir', '-p', dir], { timeout: 6000 });
  const existing = await run('sudo', ['-n', 'test', '-f', file], { timeout: 5000 });
  if (existing.ok) {
    const backup = `${file}.signaldeck-${stamp}.bak`;
    const backedUp = await run('sudo', ['-n', 'cp', file, backup], { timeout: 8000 });
    if (!backedUp.ok) {
      throw Object.assign(new Error('Backup of the existing meshtasticd config failed; refusing to overwrite it.'), { status: 500 });
    }
  }

  const tmp = `/tmp/signaldeck-meshtasticd-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.yaml`;
  await fs.promises.writeFile(tmp, text, { mode: 0o644 });
  const copied = await run('sudo', ['-n', 'cp', tmp, file], { timeout: 8000 });
  await fs.promises.unlink(tmp).catch(() => {});
  if (!copied.ok) {
    throw Object.assign(new Error(copied.stderr || 'Could not write /etc/meshtasticd/config.yaml (check sudoers).'), { status: 500 });
  }

  let restarted = false;
  if (restart) {
    const res = await run('sudo', ['-n', 'systemctl', 'restart', 'meshtasticd'], { timeout: 20000 });
    restarted = res.ok;
  }
  return { ok: true, path: file, backup: existing.ok ? `${file}.signaldeck-${stamp}.bak` : null, restarted };
}

export function renderMeshtasticConfig(radio) {
  const lines = [
    '### SignalDeck generated radio configuration',
    '### HackerGadgets RTL-SDR/LoRa/GPS/RTC HAT (SX1262 + TCXO)',
    'Lora:',
    '  Module: sx1262',
    `  DIO2_AS_RF_SWITCH: ${radio.dio2RfSwitch ? 'true' : 'false'}`,
    `  DIO3_TCXO_VOLTAGE: ${radio.dio3Tcxo ? 'true' : 'false'}`,
  ];
  if (radio.cs) lines.push(`  CS: ${radio.cs}`);
  else lines.push(`  spidev: ${radio.spidev}`);
  lines.push(`  IRQ: ${radio.irq}`, `  Busy: ${radio.busy}`, `  Reset: ${radio.reset}`);
  lines.push('', 'GPS:', '  SerialPath: /dev/ttyS0', '', 'Webserver:', '  Port: 443', '  RootPath: /usr/share/meshtasticd/web');
  return `${lines.join('\n')}\n`;
}
