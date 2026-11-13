import { getSettings, saveSettings, updateSettings } from './config.js';
import { logger } from './log.js';
import { renderMeshtasticConfig, writeMeshtasticdConfig } from './hardware.js';
import { configExists, nativeState, renderNativeConfig, restartNative, stopNative, waitForTcp, writeNativeConfig, nativeSettings } from './openhop.js';
import { serviceStatus } from './system.js';
import { isLinux, run } from './util.js';

const log = logger('radio');

/**
 * Single owner of the SX1262.
 *
 * meshtasticd and openHop Repeater both drive the same SPI radio, so starting
 * one while the other runs leaves a daemon that appears healthy but cannot
 * transmit. Every handover in SignalDeck goes through this class: it stops the
 * previous owner, configures the next one, waits until its endpoint is actually
 * listening, and only then attaches the JSON bridge.
 */
export class RadioManager {
  constructor({ mesh, hub, gps }) {
    this.mesh = mesh;
    this.hub = hub;
    this.gps = gps;
    this.lock = null;
    this.steps = [];
  }

  progress(label) {
    this.steps.push({ at: Date.now(), label });
    if (this.steps.length > 40) this.steps.shift();
    this.hub?.publish('radio', { switching: Boolean(this.lock), steps: this.steps, mode: getSettings().lora.mode });
  }

  async status() {
    const settings = getSettings();
    const mode = settings.lora.mode;
    const transport = settings.lora.meshcore.transport || 'tcp';
    const [meshtasticd, native] = await Promise.all([serviceStatus('meshtasticd'), nativeState(settings)]);
    const bridges = {
      meshtastic: this.mesh.meshtastic.getState(),
      meshcore: this.mesh.meshcore.getState(),
    };

    let owner = 'none';
    if (mode === 'meshtastic') {
      owner = meshtasticd.active || bridges.meshtastic.running ? 'meshtastic' : 'none';
    } else if (transport === 'native') {
      owner = native.active ? 'meshcore' : 'none';
    } else {
      owner = 'external';
    }

    const conflict = Boolean(meshtasticd.active && native.active);
    const warnings = [];
    if (conflict) {
      warnings.push('meshtasticd and openHop are both running. Both cannot own the SX1262 — switch the stack to resolve it.');
    }
    if (mode === 'meshcore' && transport === 'native' && !native.installed) {
      warnings.push('The native MeshCore stack (openHop Repeater) is not installed. Run install.sh or provision it from the MeshCore page.');
    }
    if (mode === 'meshcore' && transport === 'native' && native.installed && !native.active) {
      warnings.push('openHop Repeater is installed but not running, so the HAT radio is idle.');
    }
    if (mode === 'meshtastic' && !meshtasticd.active) {
      warnings.push('meshtasticd is not running, so the HAT radio is idle.');
    }

    return {
      mode,
      transport,
      owner,
      ownerLabel: owner === 'meshtastic' ? 'Meshtastic (meshtasticd)' : owner === 'meshcore' ? 'MeshCore (openHop, native)' : owner === 'external' ? 'External MeshCore companion' : 'Idle — no process owns the radio',
      conflict,
      switching: Boolean(this.lock),
      steps: this.steps,
      warnings,
      meshtasticd: {
        unit: 'meshtasticd',
        active: meshtasticd.active,
        state: meshtasticd.state,
        enabled: meshtasticd.enabled,
      },
      native,
      bridges,
      nativeLocked: transport === 'native' && mode === 'meshcore',
    };
  }

  /** Reject bridge starts that would fight the current radio owner. */
  async guard(kind) {
    const status = await this.status();
    if (kind === 'meshtastic' && status.mode !== 'meshtastic') {
      throw Object.assign(
        new Error('The HAT radio is assigned to MeshCore. Switch to Meshtastic under Settings → Mesh stack first.'),
        { status: 409 },
      );
    }
    if (kind === 'meshcore' && status.mode !== 'meshcore') {
      throw Object.assign(
        new Error('The HAT radio is assigned to Meshtastic. Switch to MeshCore under Settings → Mesh stack first.'),
        { status: 409 },
      );
    }
    if (kind === 'meshcore' && status.transport === 'native' && status.native.installed && !status.native.active) {
      throw Object.assign(
        new Error('openHop Repeater is not running. Start the native MeshCore stack from the MeshCore page first.'),
        { status: 409 },
      );
    }
    return status;
  }

  async switchTo(mode, transport) {
    if (!['meshtastic', 'meshcore'].includes(mode)) {
      throw Object.assign(new Error('Mode must be meshtastic or meshcore.'), { status: 400 });
    }
    if (this.lock) throw Object.assign(new Error('A radio handover is already in progress.'), { status: 409 });
    this.lock = this._handover(mode, transport);
    this.steps = [];
    this.hub?.publish('radio', { switching: true, steps: this.steps, mode: getSettings().lora.mode });
    try {
      return await this.lock;
    } finally {
      this.lock = null;
      this.hub?.publish('radio', { switching: false, steps: this.steps, mode: getSettings().lora.mode });
    }
  }

  async _handover(mode, transport) {
    const settings = getSettings();
    const warnings = [];
    let nextTransport = settings.lora.meshcore.transport || 'tcp';
    if (mode === 'meshcore' && ['native', 'tcp', 'serial'].includes(transport)) nextTransport = transport;

    updateSettings({ lora: { mode, ...(mode === 'meshcore' ? { meshcore: { transport: nextTransport } } : {}) } });
    await saveSettings();
    this.progress(`Selected ${mode === 'meshcore' ? `MeshCore (${nextTransport})` : 'Meshtastic'}`);

    if (mode === 'meshtastic') {
      await this.stopBridge('meshcore');
      this.progress('Detached the MeshCore bridge');

      if (isLinux) {
        try {
          await writeMeshtasticdConfig(renderMeshtasticConfig(getSettings().lora.radio), false);
          this.progress('Wrote meshtasticd radio configuration');
        } catch (err) {
          warnings.push(`meshtasticd config: ${err.message}`);
        }
        if ((await this.nativeActive()).active) {
          await stopNative();
          this.progress('Stopped openHop Repeater');
        }
        const started = await run('sudo', ['-n', 'systemctl', 'restart', 'meshtasticd'], { timeout: 30000 });
        if (!started.ok) warnings.push(started.stderr || 'Could not start meshtasticd (check the sudoers rules).');
        else this.progress('Started meshtasticd');

        const ready = await waitForTcp(getSettings().lora.meshtastic.host || '127.0.0.1', Number(getSettings().lora.meshtastic.port) || 4403, 25000);
        this.progress(ready ? 'meshtasticd is accepting connections on 4403' : 'meshtasticd did not open port 4403 in time');
        if (!ready) warnings.push('meshtasticd did not open TCP 4403 within 25 s. Check its log from the System page.');
      } else {
        this.progress('Service control skipped (not Linux)');
      }

      this.progress('Starting the Meshtastic bridge');
      try {
        await this.mesh.meshtastic.start();
      } catch (err) {
        warnings.push(`Meshtastic bridge: ${err.message}`);
      }
    } else {
      await this.stopBridge('meshtastic');
      this.progress('Detached the Meshtastic bridge');

      if (isLinux) {
        const stopped = await run('sudo', ['-n', 'systemctl', 'stop', 'meshtasticd'], { timeout: 25000 });
        this.progress(stopped.ok ? 'Stopped meshtasticd (radio released)' : 'meshtasticd stop was refused');

        if (nextTransport === 'native') {
          try {
            if (!configExists()) {
              await this.prepareNativeConfig();
              this.progress('Wrote the openHop configuration');
            }
            await restartNative();
            this.progress('Started openHop Repeater');
          } catch (err) {
            warnings.push(`openHop: ${err.message}`);
          }
          const native = nativeSettings(getSettings());
          const ready = await waitForTcp(native.bindAddress, native.tcpPort, 30000);
          this.progress(ready ? `Companion endpoint ready on ${native.tcpPort}` : 'Companion endpoint did not open in time');
          if (!ready) warnings.push(`openHop did not open companion TCP ${native.tcpPort} within 30 s. Check its journal.`);
        } else {
          await stopNative();
          this.progress('Stopped openHop Repeater (external companion selected)');
        }
      }

      this.progress('Starting the MeshCore bridge');
      try {
        await this.mesh.meshcore.start();
      } catch (err) {
        warnings.push(`MeshCore bridge: ${err.message}`);
      }
    }

    this.progress('Handover complete');
    return { ok: true, mode, transport: nextTransport, warnings, steps: this.steps };
  }

  async nativeActive() {
    return nativeState(getSettings());
  }

  /** Render and install the openHop config without starting it. */
  async prepareNativeConfig() {
    const settings = getSettings();
    if (!nativeSettings(settings).adminPassword) {
      const { randomBytes } = await import('node:crypto');
      updateSettings({ lora: { meshcore: { native: { adminPassword: randomBytes(12).toString('base64url') } } } });
      await saveSettings();
    }
    const position = this.gps?.getState?.() || null;
    return writeNativeConfig(renderNativeConfig(getSettings(), position?.lat != null ? { lat: position.lat, lon: position.lon } : null), false);
  }

  async stopBridge(kind) {
    try {
      await this.mesh[kind]?.stop();
    } catch {
      /* best effort */
    }
  }

  /**
   * Apply the saved mode on boot. Startup runs after systemd may have started
   * both daemons, so the loser is stopped before anything touches the radio.
   */
  async enforce() {
    const settings = getSettings();
    const mode = settings.lora.mode;
    const transport = settings.lora.meshcore.transport || 'tcp';
    log.info(`enforcing radio ownership: ${mode}${mode === 'meshcore' ? ` (${transport})` : ''}`);
    this.progress(`Boot: applying saved stack ${mode}`);

    if (!isLinux) {
      if (mode === 'meshtastic' && settings.lora.meshtastic.autoStart) {
        await this.mesh.meshtastic.start().catch((err) => log.warn(`Meshtastic bridge: ${err.message}`));
      }
      return;
    }

    try {
      if (mode === 'meshtastic') {
        const native = await nativeState(settings);
        if (native.active) {
          await stopNative();
          this.progress('Boot: stopped openHop Repeater');
        }
        const res = await run('sudo', ['-n', 'systemctl', 'start', 'meshtasticd'], { timeout: 25000 });
        if (!res.ok) log.warn(`could not start meshtasticd: ${res.stderr.trim()}`);
        const ready = await waitForTcp(settings.lora.meshtastic.host || '127.0.0.1', Number(settings.lora.meshtastic.port) || 4403, 20000);
        if (!ready) log.warn('meshtasticd did not open 4403 during boot enforcement');
        if (settings.lora.meshtastic.autoStart) {
          await this.mesh.meshtastic.start().catch((err) => log.warn(`Meshtastic bridge: ${err.message}`));
        }
      } else {
        await run('sudo', ['-n', 'systemctl', 'stop', 'meshtasticd'], { timeout: 25000 });
        this.progress('Boot: released meshtasticd');
        if (transport === 'native') {
          if (!configExists()) await this.prepareNativeConfig();
          await restartNative();
          const native = nativeSettings(getSettings());
          const ready = await waitForTcp(native.bindAddress, native.tcpPort, 25000);
          if (!ready) log.warn('openHop companion endpoint did not open during boot enforcement');
        } else {
          await stopNative();
        }
        await this.mesh.meshcore.start().catch((err) => log.warn(`MeshCore bridge: ${err.message}`));
      }
    } catch (err) {
      log.error(`radio enforcement failed: ${err.message}`);
    }
  }
}
