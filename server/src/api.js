import express from 'express';
import fs from 'node:fs';
import { authenticate, createToken, isConfigured, requireAuth, requireSameOrigin, listTokens, revokeToken, setPassword, verifyPassword, createSession, destroySession, rateLimited, clearRateLimit } from './auth.js';
import { VERSION, getSettings, publicSettings, saveSettings, updateSettings } from './config.js';
import {
  applyBootConfig,
  detectRtl,
  hardwareOverview,
  readMeshtasticdConfig,
  renderMeshtasticConfig,
  setRail,
  readBootConfig,
  writeMeshtasticdConfig,
} from './hardware.js';
import { journal, controlService, powerAction, pythonInfo, serviceStatus, systemStats, allServices } from './system.js';
import { timeState, syncTime } from './time.js';
import { addPreset, clearTrack, getState, gpxExport, removePreset, setScanChannels } from './store.js';
import { clamp, httpError } from './util.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const BANDS = [
  { id: 'hf', name: 'HF / shortwave', start: 100000, end: 30000000, hint: 'Needs direct sampling (Q branch)' },
  { id: 'air', name: 'Airband', start: 108000000, end: 137000000, hint: 'AM voice' },
  { id: 'noaa', name: 'Weather satellites', start: 137000000, end: 138000000, hint: 'NOAA APT / Meteor' },
  { id: '2m', name: '2 m amateur', start: 144000000, end: 148000000, hint: 'NFM' },
  { id: '70cm', name: '70 cm amateur', start: 420000000, end: 450000000, hint: 'NFM' },
  { id: 'ism868', name: '868 MHz ISM', start: 863000000, end: 870000000, hint: 'EU LoRa / sensors' },
  { id: 'ism915', name: '915 MHz ISM', start: 902000000, end: 928000000, hint: 'US LoRa / ISM' },
  { id: 'adsb', name: 'ADS-B', start: 1089000000, end: 1091000000, hint: '1090 MHz pulses' },
];

export function createApi({ sdr, gps, mesh, hub }) {
  const router = express.Router();
  let hardwareCache = { at: 0, data: null };

  async function hardwareCached(maxAge = 30000) {
    if (hardwareCache.data && Date.now() - hardwareCache.at < maxAge) return hardwareCache.data;
    const data = await hardwareOverview();
    hardwareCache = { at: Date.now(), data };
    return data;
  }

  router.get('/health', (req, res) => {
    res.json({ ok: true, version: VERSION, setupRequired: !isConfigured(), demo: getSettings().demo });
  });

  router.get('/auth/status', (req, res) => {
    res.json({ setupRequired: !isConfigured(), authenticated: Boolean(authenticate(req)) });
  });

  router.post('/auth/setup', requireSameOrigin, wrap(async (req, res) => {
    if (isConfigured()) throw httpError(409, 'A password is already configured.');
    await setPassword(req.body?.password);
    createSession(res, req.ip, req.secure);
    res.json({ ok: true });
  }));

  router.post('/auth/login', requireSameOrigin, wrap(async (req, res) => {
    if (!isConfigured()) throw httpError(428, 'Setup required.');
    if (rateLimited(req.ip)) throw httpError(429, 'Too many attempts. Wait 15 minutes.');
    if (!verifyPassword(req.body?.password)) throw httpError(401, 'Incorrect password.');
    clearRateLimit(req.ip);
    createSession(res, req.ip, req.secure);
    res.json({ ok: true });
  }));

  router.post('/auth/logout', requireSameOrigin, (req, res) => {
    destroySession(req, res);
    res.json({ ok: true });
  });

  router.use(requireAuth);

  router.post('/auth/password', requireSameOrigin, wrap(async (req, res) => {
    if (!verifyPassword(req.body?.current)) throw httpError(401, 'Current password is incorrect.');
    await setPassword(req.body?.next);
    createSession(res, req.ip, req.secure);
    res.json({ ok: true });
  }));

  router.get('/auth/tokens', (req, res) => res.json({ tokens: listTokens() }));
  router.post('/auth/tokens', requireSameOrigin, (req, res) => {
    res.json(createToken(req.body?.name));
  });
  router.delete('/auth/tokens/:id', requireSameOrigin, (req, res) => {
    revokeToken(req.params.id);
    res.json({ ok: true });
  });

  router.get('/overview', wrap(async (req, res) => {
    const settings = getSettings();
    const [stats, hardware, services, clock] = await Promise.all([
      systemStats(),
      hardwareCached(60000),
      Promise.all(['gpsd', 'meshtasticd', 'signaldeck'].map((unit) => serviceStatus(unit))),
      timeState(gps),
    ]);
    const alerts = [];
    if (!hardware.allConfigured) {
      alerts.push({ level: 'warn', title: 'Boot overlays incomplete', detail: 'Some HAT interfaces are not enabled in config.txt.', action: 'system' });
    }
    if (hardware.rtl && !hardware.rtl.available) {
      alerts.push({ level: 'info', title: 'No RTL-SDR detected', detail: hardware.rtl.raw || 'rtl_test did not find a device.', action: 'sdr' });
    }
    if (!services[0].active) alerts.push({ level: 'warn', title: 'gpsd is not running', detail: 'GNSS falls back to direct serial reading.', action: 'system' });
    if (settings.lora.mode === 'meshtastic' && !services[1].active) {
      alerts.push({ level: 'warn', title: 'meshtasticd is not running', detail: 'Start the LoRa daemon to use the mesh.', action: 'meshtastic' });
    }
    if (gps.getState().fix === 0) alerts.push({ level: 'info', title: 'GNSS has no fix', detail: 'Give the antenna a clear view of the sky.', action: 'gps' });
    if (stats.disk && stats.disk.percent > 90) alerts.push({ level: 'warn', title: 'Disk almost full', detail: `${stats.disk.percent.toFixed(0)}% used.`, action: 'system' });
    if (stats.temperature && stats.temperature > 80) alerts.push({ level: 'warn', title: 'High SoC temperature', detail: `${stats.temperature.toFixed(1)} °C`, action: 'system' });

    res.json({
      version: VERSION,
      stationName: settings.stationName,
      demo: settings.demo,
      system: stats,
      hardware,
      services,
      clocks: clock,
      sdr: sdr.getState(),
      gps: gps.getState(),
      mesh: { mode: settings.lora.mode, meshtastic: mesh.meshtastic.getState(), meshcore: mesh.meshcore.getState() },
      alerts,
      wsClients: hub.count,
    });
  }));

  router.get('/sdr', wrap(async (req, res) => {
    const store = getState();
    res.json({
      state: sdr.getState(),
      presets: store.presets,
      scanChannels: store.scanChannels,
      bands: BANDS,
      python: await pythonInfo(),
    });
  }));

  router.post('/sdr/start', requireSameOrigin, wrap(async (req, res) => {
    res.json(await sdr.start(req.body || {}));
  }));
  router.post('/sdr/stop', requireSameOrigin, wrap(async (req, res) => {
    res.json(await sdr.stop());
  }));
  router.post('/sdr/tune', requireSameOrigin, wrap(async (req, res) => {
    res.json(await sdr.tune(req.body || {}));
  }));
  router.get('/sdr/devices', wrap(async (req, res) => res.json(await detectRtl())));

  router.post('/sdr/presets', requireSameOrigin, (req, res) => res.json(addPreset(req.body || {})));
  router.delete('/sdr/presets/:id', requireSameOrigin, (req, res) => {
    removePreset(req.params.id);
    res.json({ ok: true });
  });
  router.put('/sdr/scan-channels', requireSameOrigin, (req, res) => {
    res.json(setScanChannels(req.body?.channels || []));
  });

  router.get('/gps', (req, res) => res.json({ state: gps.getState(), settings: getSettings().gps }));
  router.post('/gps/config', requireSameOrigin, wrap(async (req, res) => {
    const patch = req.body || {};
    const allowed = {};
    if (patch.source) allowed.source = ['auto', 'gpsd', 'serial'].includes(patch.source) ? patch.source : 'auto';
    if (patch.serialPath) allowed.serialPath = String(patch.serialPath).slice(0, 120);
    if (patch.baud) allowed.baud = clamp(Number(patch.baud), 4800, 921600);
    if (patch.gpsdHost) allowed.gpsdHost = String(patch.gpsdHost).slice(0, 120);
    if (patch.gpsdPort) allowed.gpsdPort = clamp(Number(patch.gpsdPort), 1, 65535);
    if (typeof patch.logTrack === 'boolean') allowed.logTrack = patch.logTrack;
    updateSettings({ gps: allowed });
    await saveSettings();
    await gps.restart();
    res.json({ ok: true, state: gps.getState() });
  }));
  router.post('/gps/restart', requireSameOrigin, wrap(async (req, res) => res.json(await gps.restart())));
  router.get('/gps/track', (req, res) => res.json({ points: getState().track }));
  router.delete('/gps/track', requireSameOrigin, (req, res) => {
    clearTrack();
    res.json({ ok: true });
  });
  router.get('/gps/track.gpx', (req, res) => {
    res.setHeader('Content-Type', 'application/gpx+xml');
    res.setHeader('Content-Disposition', 'attachment; filename="signaldeck-track.gpx"');
    res.send(gpxExport());
  });

  router.get('/mesh', wrap(async (req, res) => {
    const store = getState();
    res.json({
      mode: getSettings().lora.mode,
      radio: getSettings().lora.radio,
      meshtastic: { ...mesh.meshtastic.getState(), messages: store.meshtastic.messages, nodes: store.meshtastic.nodes, channels: store.meshtastic.channels, myInfo: store.meshtastic.myInfo },
      meshcore: {
        ...mesh.meshcore.getState(),
        endpoint: getSettings().lora.meshcore,
        transport: getSettings().lora.meshcore.transport,
        messages: store.meshcore.messages,
        contacts: store.meshcore.contacts,
        channels: store.meshcore.channels,
        self: store.meshcore.self,
      },
      python: await pythonInfo(),
    });
  }));

  const bridgeFor = (kind) => {
    if (kind === 'meshtastic') return mesh.meshtastic;
    if (kind === 'meshcore') return mesh.meshcore;
    throw httpError(404, 'Unknown mesh backend.');
  };

  router.post('/mesh/:kind/start', requireSameOrigin, wrap(async (req, res) => res.json(await bridgeFor(req.params.kind).start())));
  router.post('/mesh/:kind/stop', requireSameOrigin, wrap(async (req, res) => res.json(await bridgeFor(req.params.kind).stop())));

  router.post('/mesh/:kind/send', requireSameOrigin, wrap(async (req, res) => {
    const bridge = bridgeFor(req.params.kind);
    const { text, channel, to } = req.body || {};
    if (!text || typeof text !== 'string' || text.length > 500) throw httpError(400, 'Message text is required (max 500 characters).');
    const data = await bridge.request('send', { text, channel: Number(channel) || 0, to: to || null });
    res.json({ ok: true, data });
  }));

  router.post('/mesh/:kind/command', requireSameOrigin, wrap(async (req, res) => {
    const bridge = bridgeFor(req.params.kind);
    const { cmd, ...payload } = req.body || {};
    if (!cmd) throw httpError(400, 'A command name is required.');
    res.json({ ok: true, data: await bridge.request(String(cmd), payload, 25000) });
  }));

  router.get('/mesh/:kind/messages', (req, res) => {
    const store = getState();
    const bucket = store[req.params.kind] || { messages: [] };
    res.json({ messages: bucket.messages || [] });
  });

  router.put('/mesh/:kind/config', requireSameOrigin, wrap(async (req, res) => {
    const kind = req.params.kind;
    if (kind === 'meshtastic') {
      const { region, preset, txPower, hopLimit, role, host, port, autoStart } = req.body || {};
      const lora = getSettings().lora;
      if (host) lora.meshtastic.host = String(host).slice(0, 120);
      if (port) lora.meshtastic.port = clamp(Number(port), 1, 65535);
      if (typeof autoStart === 'boolean') lora.meshtastic.autoStart = autoStart;
      if (region != null) lora.radio.region = Number(region);
      if (preset != null) lora.radio.preset = Number(preset);
      if (txPower != null) lora.radio.txPower = clamp(Number(txPower), 0, 30);
      if (hopLimit != null) lora.radio.hopLimit = clamp(Number(hopLimit), 0, 7);
      if (role != null) lora.radio.role = Number(role);
      await saveSettings();
      res.json({ ok: true, radio: lora.radio });
    } else {
      const { transport, host, port, serialPath, baud } = req.body || {};
      const mc = getSettings().lora.meshcore;
      if (transport) mc.transport = transport === 'serial' ? 'serial' : 'tcp';
      if (host) mc.host = String(host).slice(0, 120);
      if (port) mc.port = clamp(Number(port), 1, 65535);
      if (serialPath) mc.serialPath = String(serialPath).slice(0, 120);
      if (baud) mc.baud = clamp(Number(baud), 1200, 921600);
      await saveSettings();
      res.json({ ok: true, meshcore: mc });
    }
  }));

  router.get('/time', wrap(async (req, res) => res.json(await timeState(gps))));
  router.post('/time/sync', requireSameOrigin, wrap(async (req, res) => {
    res.json(await syncTime(req.body?.direction, req.body?.device));
  }));

  router.get('/system', wrap(async (req, res) => {
    const [stats, services, hardware] = await Promise.all([systemStats(), allServices(), hardwareCached(15000)]);
    res.json({ stats, services, hardware });
  }));

  router.get('/system/logs', wrap(async (req, res) => {
    res.json({ unit: req.query.unit || null, text: await journal(req.query.unit, req.query.lines) });
  }));

  router.post('/system/services/:unit/:action', requireSameOrigin, wrap(async (req, res) => {
    res.json(await controlService(req.params.unit, req.params.action));
  }));

  router.post('/system/power', requireSameOrigin, wrap(async (req, res) => res.json(await powerAction(req.body?.action))));

  router.get('/system/hardware', wrap(async (req, res) => res.json(await hardwareCached(0))));
  router.post('/system/hardware/apply', requireSameOrigin, wrap(async (req, res) => {
    const result = await applyBootConfig(req.body?.keys);
    hardwareCache = { at: 0, data: null };
    res.json(result);
  }));
  router.get('/system/bootconfig', wrap(async (req, res) => res.json(await readBootConfig())));

  router.get('/system/meshtasticd', wrap(async (req, res) => {
    res.json({ text: await readMeshtasticdConfig(), rendered: renderMeshtasticConfig(getSettings().lora.radio) });
  }));
  router.post('/system/meshtasticd/render', requireSameOrigin, (req, res) => {
    res.json({ text: renderMeshtasticConfig({ ...getSettings().lora.radio, ...(req.body || {}) }) });
  });
  router.post('/system/meshtasticd/write', requireSameOrigin, wrap(async (req, res) => {
    res.json(await writeMeshtasticdConfig(req.body?.text, Boolean(req.body?.restart)));
  }));

  router.post('/system/rails', requireSameOrigin, wrap(async (req, res) => {
    res.json(await setRail(req.body?.pin, Boolean(req.body?.on)));
  }));

  router.get('/settings', (req, res) => res.json(publicSettings()));
  router.put('/settings', requireSameOrigin, wrap(async (req, res) => {
    const body = req.body || {};
    const patch = {};
    if (typeof body.stationName === 'string') patch.stationName = body.stationName.slice(0, 40);
    if (body.units === 'metric' || body.units === 'imperial') patch.units = body.units;
    if (body.sdr && typeof body.sdr === 'object') {
      const allowed = {};
      for (const key of ['frequency', 'sampleRate', 'gainMode', 'gain', 'ppm', 'biasTee', 'directSampling', 'agc', 'offsetTuning', 'demod', 'squelch', 'volume', 'step', 'deviceIndex']) {
        if (key in body.sdr) allowed[key] = body.sdr[key];
      }
      patch.sdr = allowed;
    }
    if (body.lora?.radio) {
      const allowed = {};
      for (const key of ['spidev', 'cs', 'irq', 'busy', 'reset', 'dio3Tcxo', 'dio2RfSwitch', 'region', 'preset', 'txPower', 'hopLimit']) {
        if (key in body.lora.radio) allowed[key] = body.lora.radio[key];
      }
      patch.lora = { radio: allowed };
    }
    if (body.lora?.mode === 'meshtastic' || body.lora?.mode === 'meshcore') {
      patch.lora = { ...(patch.lora || {}), mode: body.lora.mode };
    }
    if (body.time?.rtcDevice) patch.time = { rtcDevice: String(body.time.rtcDevice).slice(0, 40) };
    updateSettings(patch);
    await saveSettings();
    res.json(publicSettings());
  }));

  router.get('/version', (req, res) => res.json({ version: VERSION }));

  return router;
}

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Internal error', ...(err.extra || {}) });
}

export function apiIndex(req, res) {
  res.json({
    name: 'SignalDeck API',
    version: VERSION,
    docs: 'https://github.com/aporzio1/signaldeck/blob/main/README.md#http-api',
    auth: 'Session cookie (web UI) or Authorization: Bearer <token>',
    endpoints: [
      'GET /api/v1/overview',
      'GET|POST /api/v1/sdr, /sdr/start, /sdr/stop, /sdr/tune',
      'GET /api/v1/gps, /gps/track, /gps/track.gpx',
      'GET|POST /api/v1/mesh, /mesh/:kind/{start,stop,send,command}',
      'GET /api/v1/time, POST /time/sync',
      'GET /api/v1/system, /system/hardware, POST /system/services/:unit/:action',
      'GET|PUT /api/v1/settings',
      'WS /ws (channels: status, sdr, sdr-iq, gps, mesh)',
    ],
  });
}
