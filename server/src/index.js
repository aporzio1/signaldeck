import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { WEB_DIST, VERSION, ensureDataDir, getSettings } from './config.js';
import { apiIndex, createApi, errorHandler } from './api.js';
import { GpsService } from './gps.js';
import { logger } from './log.js';
import { MeshCoreBridge, MeshtasticBridge } from './mesh.js';
import { SdrService } from './sdr.js';
import { addMessage, getState, scheduleSave } from './store.js';
import { allServices, systemStats } from './system.js';
import { Hub } from './ws.js';

const log = logger('server');

ensureDataDir();
const settings = getSettings();
const hub = new Hub();
const sdr = new SdrService();
const gps = new GpsService();
const mesh = { meshtastic: new MeshtasticBridge(), meshcore: new MeshCoreBridge() };

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

app.use('/api/v1', createApi({ sdr, gps, mesh, hub }));
app.get('/api', apiIndex);
app.get('/api/v1', apiIndex);

app.use(
  express.static(WEB_DIST, {
    index: false,
    maxAge: '1h',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
    },
  }),
);

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  const indexFile = path.join(WEB_DIST, 'index.html');
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  res
    .status(503)
    .type('html')
    .send(
      '<!doctype html><body style="font-family:system-ui;background:#0a0e14;color:#e6edf5;padding:40px">' +
        `<h1>SignalDeck ${VERSION}</h1><p>The web UI has not been built yet.</p>` +
        '<pre style="background:#121a24;padding:16px;border-radius:8px">cd web &amp;&amp; npm install &amp;&amp; npm run build</pre>' +
        '<p>The API is already available at <code>/api/v1/overview</code>.</p></body>',
    );
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler);

const tlsEnabled = Boolean(settings.server.tlsCert && settings.server.tlsKey);
let server;
if (tlsEnabled) {
  try {
    server = https.createServer(
      { cert: fs.readFileSync(settings.server.tlsCert), key: fs.readFileSync(settings.server.tlsKey) },
      app,
    );
  } catch (err) {
    log.error(`TLS certificate could not be loaded (${err.message}); falling back to HTTP.`);
    server = http.createServer(app);
  }
} else {
  server = http.createServer(app);
}
hub.attach(server);

function wireSdr() {
  sdr.on('iq', (buffer) => hub.publishIq(buffer));
  sdr.on('state', (state) => hub.publish('sdr', state));
}

function wireGps() {
  gps.on('state', (state) => hub.publish('gps', state));
}

function wireMesh(bridge, kind) {
  bridge.on('state', (state) => hub.publish('mesh', { kind, state }));
  bridge.on('event', (event) => {
    const bucket = getState()[kind];
    if (event.type === 'ready') {
      if (event.myInfo) bucket.myInfo = event.myInfo;
      if (event.self) bucket.self = event.self;
      if (Array.isArray(event.nodes)) bucket.nodes = event.nodes;
      if (Array.isArray(event.contacts)) bucket.contacts = event.contacts;
      if (Array.isArray(event.channels)) bucket.channels = event.channels;
      scheduleSave();
    } else if (event.type === 'nodes') {
      bucket.nodes = event.nodes || [];
      scheduleSave();
    } else if (event.type === 'contacts') {
      bucket.contacts = event.contacts || [];
      scheduleSave();
    } else if (event.type === 'channels') {
      bucket.channels = event.channels || [];
      scheduleSave();
    } else if (event.type === 'message') {
      addMessage(kind, event);
    } else if (event.type === 'error') {
      bucket.lastError = event.message;
      scheduleSave();
    }
    hub.publish('mesh', { kind, event, state: bridge.getState() });
  });
}

wireSdr();
wireGps();
wireMesh(mesh.meshtastic, 'meshtastic');
wireMesh(mesh.meshcore, 'meshcore');

let servicesCache = [];
async function refreshServices() {
  try {
    servicesCache = await allServices();
  } catch {
    /* keep last value */
  }
}

async function broadcastStatus() {
  try {
    const stats = await systemStats();
    hub.publish('status', {
      system: stats,
      sdr: sdr.getState(),
      gps: gps.getState(),
      services: servicesCache,
      mesh: {
        mode: getSettings().lora.mode,
        meshtastic: mesh.meshtastic.getState(),
        meshcore: mesh.meshcore.getState(),
      },
    });
  } catch (err) {
    log.warn(`status broadcast failed: ${err.message}`);
  }
}

const port = Number(settings.server.port) || 8080;
const host = settings.server.host || '0.0.0.0';
server.listen(port, host, async () => {
  const protocol = tlsEnabled ? 'https' : 'http';
  log.info(`SignalDeck ${VERSION} listening on ${protocol}://${host}:${port}`);
  if (!settings.auth.passwordHash) log.warn('No password configured yet: open the web UI to finish setup.');

  await refreshServices();
  gps.start().catch((err) => log.error(`GPS start failed: ${err.message}`));
  if (settings.sdr.enabled) sdr.start().catch((err) => log.error(`SDR start failed: ${err.message}`));
  if (settings.lora.mode === 'meshtastic' && settings.lora.meshtastic.autoStart) {
    mesh.meshtastic.start().catch((err) => log.warn(`Meshtastic bridge: ${err.message}`));
  }
});

const statusTimer = setInterval(broadcastStatus, 3000);
statusTimer.unref?.();
const serviceTimer = setInterval(refreshServices, 15000);
serviceTimer.unref?.();
setTimeout(broadcastStatus, 500).unref?.();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received, shutting down`);
  clearInterval(statusTimer);
  clearInterval(serviceTimer);
  await Promise.allSettled([sdr.stop(), gps.stop(), mesh.meshtastic.stop(), mesh.meshcore.stop()]);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log.error(`unhandled rejection: ${err?.message || err}`));
process.on('uncaughtException', (err) => log.error(`uncaught exception: ${err?.stack || err}`));
