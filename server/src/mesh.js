import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { ROOT, SIDECAR_DIR, getSettings } from './config.js';
import { logger } from './log.js';
import { run } from './util.js';

const log = logger('mesh');

async function pythonBinary() {
  const candidates = [path.join(ROOT, 'venv', 'bin', 'python'), 'python3'];
  for (const bin of candidates) {
    if (bin.startsWith('/') && !fs.existsSync(bin)) continue;
    const res = await run(bin, ['-c', 'import sys;print(sys.version_info[0])'], { timeout: 4000 });
    if (res.ok && res.stdout.trim() === '3') return bin;
  }
  return null;
}

export class MeshSidecar extends EventEmitter {
  /**
   * @param {string} kind 'meshtastic' | 'meshcore'
   * @param {string} script sidecar filename
   */
  constructor(kind, script) {
    super();
    this.kind = kind;
    this.script = path.join(SIDECAR_DIR, script);
    this.child = null;
    this.status = 'stopped';
    this.lastError = null;
    this.logs = [];
    this.pending = new Map();
    this.seq = 0;
    this.lines = null;
    this.starting = null;
  }

  getState() {
    return {
      kind: this.kind,
      status: this.status,
      running: this.status === 'running',
      lastError: this.lastError,
      logs: this.logs.slice(-80),
    };
  }

  pushLog(line, level = 'info') {
    this.logs.push({ ts: Date.now(), level, line: String(line).slice(0, 500) });
    if (this.logs.length > 300) this.logs.shift();
  }

  endpointArgs() {
    const settings = getSettings();
    if (this.kind === 'meshtastic') {
      const { host, port } = settings.lora.meshtastic;
      return ['--host', String(host || '127.0.0.1'), '--port', String(port || 4403)];
    }
    const mc = settings.lora.meshcore;
    if (mc.transport === 'serial') {
      return ['--serial', String(mc.serialPath || '/dev/ttyACM0'), '--baud', String(mc.baud || 115200)];
    }
    if (mc.transport === 'native') {
      const native = mc.native || {};
      return ['--host', String(native.bindAddress || '127.0.0.1'), '--port', String(native.tcpPort || mc.port || 5000)];
    }
    return ['--host', String(mc.host || '127.0.0.1'), '--port', String(mc.port || 5000)];
  }

  async start() {
    if (this.child) return this.getState();
    if (this.starting) return this.starting;
    this.starting = this._start();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async _start() {
    if (!fs.existsSync(this.script)) {
      this.lastError = `Sidecar ${this.script} is missing.`;
      this.status = 'error';
      return this.getState();
    }
    const python = await pythonBinary();
    if (!python) {
      this.lastError = 'Python 3 is not installed. Run install.sh again.';
      this.status = 'error';
      return this.getState();
    }
    const args = [this.script, ...this.endpointArgs()];
    this.status = 'starting';
    this.lastError = null;
    this.emit('state', this.getState());
    log.info(`starting ${this.kind} bridge: ${python} ${args.join(' ')}`);
    this.child = spawn(python, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } });

    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.pushLog(line);
        return;
      }
      this.handleMessage(message);
    });

    readline.createInterface({ input: this.child.stderr }).on('line', (line) => {
      this.pushLog(line, 'warn');
    });

    this.child.on('exit', (code, signal) => {
      const wasRunning = this.status === 'running';
      this.child = null;
      this.status = 'stopped';
      this.pushLog(`bridge exited (${signal || code})`, 'warn');
      for (const [, entry] of this.pending) entry.reject(new Error('Bridge stopped.'));
      this.pending.clear();
      if (wasRunning && code !== 0) this.lastError = `Bridge exited with code ${code}.`;
      this.emit('state', this.getState());
    });

    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 12000);
      this.once('_ready', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (this.child && this.status === 'starting') {
      this.status = 'running';
      this.emit('state', this.getState());
    }
    return this.getState();
  }

  handleMessage(message) {
    if (message.type === 'ready') {
      this.status = 'running';
      this.lastError = null;
      this.emit('ready', message);
      this.emit('_ready');
      this.emit('event', message);
      this.emit('state', this.getState());
      return;
    }
    if (message.type === 'error') {
      this.lastError = message.message;
      this.pushLog(message.message, 'error');
      this.emit('event', message);
      this.emit('state', this.getState());
      return;
    }
    if (message.type === 'response' && message.id && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.data);
      else entry.reject(new Error(message.error || 'Bridge command failed.'));
      return;
    }
    this.emit('event', message);
  }

  request(cmd, payload = {}, timeout = 20000) {
    if (!this.child) return Promise.reject(Object.assign(new Error(`${this.kind} bridge is not running.`), { status: 409 }));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`${this.kind} bridge timed out on ${cmd}.`), { status: 504 }));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, cmd, ...payload })}\n`);
    });
  }

  async stop() {
    if (!this.child) {
      this.status = 'stopped';
      return this.getState();
    }
    try {
      this.child.stdin.write(`${JSON.stringify({ cmd: 'shutdown' })}\n`);
    } catch {
      /* ignore */
    }
    const child = this.child;
    setTimeout(() => {
      if (child && !child.killed) child.kill('SIGTERM');
    }, 1200);
    this.child = null;
    this.status = 'stopped';
    this.emit('state', this.getState());
    return this.getState();
  }
}

export class MeshtasticBridge extends MeshSidecar {
  constructor() {
    super('meshtastic', 'meshtastic_bridge.py');
    this.nodes = [];
    this.myInfo = null;
    this.messages = [];
    this.channels = [];
  }

  async start() {
    const state = await super.start();
    return state;
  }

  getState() {
    return {
      ...super.getState(),
      myInfo: this.myInfo,
      nodes: this.nodes,
      channels: this.channels,
      messageCount: this.messages.length,
      lastMessage: this.messages[this.messages.length - 1] || null,
    };
  }
}

export class MeshCoreBridge extends MeshSidecar {
  constructor() {
    super('meshcore', 'meshcore_bridge.py');
    this.contacts = [];
    this.channels = [];
    this.self = null;
    this.messages = [];
  }

  getState() {
    return {
      ...super.getState(),
      self: this.self,
      contacts: this.contacts,
      channels: this.channels,
      messageCount: this.messages.length,
      lastMessage: this.messages[this.messages.length - 1] || null,
    };
  }
}
