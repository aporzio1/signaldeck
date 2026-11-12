import { rtcDevices } from './hardware.js';
import { isLinux, run } from './util.js';

async function timedatectl() {
  if (!isLinux) return null;
  const res = await run('timedatectl', ['show', '--no-pager'], { timeout: 5000 });
  if (!res.ok) return null;
  const data = {};
  for (const line of res.stdout.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) data[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return data;
}

async function ntpStatus() {
  if (!isLinux) return null;
  const chrony = await run('chronyc', ['tracking'], { timeout: 5000 });
  if (chrony.ok) {
    const pick = (key) => {
      const match = new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm').exec(chrony.stdout);
      return match ? match[1].trim() : null;
    };
    return {
      daemon: 'chrony',
      reference: pick('Reference ID'),
      stratum: pick('Stratum'),
      offset: pick('System time'),
      frequency: pick('Frequency'),
      healthy: /Leap status\s*:\s*Normal/i.test(chrony.stdout),
      raw: chrony.stdout.split('\n').slice(0, 12).join('\n'),
    };
  }
  const timed = await timedatectl();
  if (timed) {
    return {
      daemon: 'systemd-timesyncd',
      reference: timed.ServerName || null,
      stratum: null,
      offset: timed.Offset || null,
      frequency: null,
      healthy: timed.NTPSynchronized === 'yes',
      raw: '',
    };
  }
  return null;
}

export async function timeState(gpsService) {
  const [devices, timed, ntp] = await Promise.all([rtcDevices(), timedatectl(), ntpStatus()]);
  const now = Date.now();
  const gpsState = gpsService?.getState?.() || null;
  return {
    system: {
      now: new Date(now).toISOString(),
      epoch: Math.floor(now / 1000),
      timezone: timed?.Timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      ntpSynchronized: timed ? timed.NTPSynchronized === 'yes' : false,
      ntpServiceActive: timed ? timed.NTP === 'yes' : false,
    },
    ntp,
    rtc: devices.map((device) => {
      const drift = device.epoch != null ? device.epoch - Math.floor(now / 1000) : null;
      return { ...device, driftSeconds: drift };
    }),
    gps: gpsState
      ? {
          time: gpsState.time,
          offsetMs: gpsState.offsetMs,
          fix: gpsState.fix,
          fixLabel: gpsState.fixLabel,
          source: gpsState.source,
        }
      : null,
  };
}

export async function syncTime(direction, device) {
  if (!isLinux) throw Object.assign(new Error('Clock synchronisation requires Linux.'), { status: 400 });
  if (!device || !/^\/dev\/rtc\d+$/.test(device)) throw Object.assign(new Error('Invalid RTC device.'), { status: 400 });
  let args;
  if (direction === 'to-rtc') args = ['-n', 'hwclock', `--rtc=${device}`, '-w'];
  else if (direction === 'from-rtc') args = ['-n', 'hwclock', `--rtc=${device}`, '-s', '-u'];
  else if (direction === 'to-system') args = ['-n', 'hwclock', '-s', '-u'];
  else throw Object.assign(new Error('Unknown sync direction.'), { status: 400 });

  const res = await run('sudo', args, { timeout: 15000 });
  if (!res.ok) {
    throw Object.assign(
      new Error(res.stderr || 'hwclock failed. The sudoers rule installed by install.sh may be missing.'),
      { status: 500 },
    );
  }
  const timed = await run('sudo', ['-n', 'timedatectl', 'set-ntp', 'true'], { timeout: 8000 });
  return { ok: true, direction, device, output: res.stdout.trim(), ntpRestarted: timed.ok };
}
