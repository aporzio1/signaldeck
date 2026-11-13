import { WebSocketServer } from 'ws';
import { authenticate } from './auth.js';
import { logger } from './log.js';

const log = logger('ws');

export class Hub {
  constructor() {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
    this.clients = new Set();
    // 4 MB is ~2 s of IQ; once the socket backs up that deep, every dropped
    // frame is a half-second audible hole before sends resume. 256 KB keeps the
    // backpressure window (~128 ms of audio) below the listener's perception.
    this.maxBuffered = 256 * 1024;
  }

  attach(server) {
    server.on('upgrade', (req, socket, head) => {
      let pathname = '/';
      try {
        pathname = new URL(req.url, 'http://localhost').pathname;
      } catch {
        /* ignore */
      }
      if (pathname !== '/ws') {
        socket.destroy();
        return;
      }
      if (!authenticate(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws) => {
      ws.isAlive = true;
      ws.channels = new Set(['status']);
      this.clients.add(ws);
      ws.on('pong', () => {
        ws.isAlive = true;
      });
      ws.on('message', (raw) => {
        let message;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (message.op === 'subscribe' && Array.isArray(message.channels)) {
          ws.channels = new Set(message.channels.slice(0, 12));
          ws.send(JSON.stringify({ type: 'subscribed', channels: [...ws.channels] }));
        } else if (message.op === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        }
      });
      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
      ws.send(JSON.stringify({ type: 'hello', ts: Date.now() }));
    });

    this.ping = setInterval(() => {
      for (const ws of this.clients) {
        if (!ws.isAlive) {
          ws.terminate();
          this.clients.delete(ws);
          continue;
        }
        ws.isAlive = false;
        try {
          ws.ping();
        } catch {
          /* ignore */
        }
      }
    }, 30000);
    this.ping.unref?.();
  }

  /** Publish a JSON payload to sockets subscribed to `channel`. */
  publish(channel, payload) {
    if (!this.clients.size) return;
    const text = JSON.stringify({ type: channel, data: payload, ts: Date.now() });
    for (const ws of this.clients) {
      if (ws.readyState !== 1 || !ws.channels.has(channel)) continue;
      if (ws.bufferedAmount > this.maxBuffered) continue;
      ws.send(text);
    }
  }

  /** Publish raw IQ as a binary frame: interleaved 8-bit I/Q pairs, nothing else. */
  publishIq(buffer) {
    let sent = 0;
    for (const ws of this.clients) {
      if (ws.readyState !== 1 || !ws.channels.has('sdr-iq')) continue;
      if (ws.bufferedAmount > this.maxBuffered) continue;
      // A 0x01 marker used to be prepended here; the browser demodulator treats
      // every binary byte as IQ, so the marker shifted the whole stream by one
      // byte. Send the pairs verbatim (sdr.js guarantees even lengths).
      ws.send(buffer, { binary: true });
      sent += 1;
    }
    if (sent && !this.iqLogged) {
      this.iqLogged = true;
      log.info(`streaming IQ to ${sent} client(s)`);
    }
  }

  get count() {
    return this.clients.size;
  }
}
