import fs from 'node:fs';
import { getSettings, saveSettings, updateSettings } from './config.js';
import { logger } from './log.js';
import { renderMeshtasticConfig, writeMeshtasticdConfig } from './hardware.js';
import {
  OPENHOP,
  configExists,
  nativeState,
  preservedConfig,
  readNativeConfig,
  renderNativeConfig,
  restartNative,
  stopNative,
  waitForTcp,
  writeNativeConfig,
  nativeSettings,
} from './openhop.js';
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
    this.steps = [];
    this.lock = this._handover(mode, transport);
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
            await this._applyNative(warnings, { reconnectBridge: false });
          } catch (err) {
            // Never write a config we could not read first: that would rotate
            // the identity. Surface it and leave the existing file untouched.
            warnings.push(err.message);
            this.progress('Skipped openHop config regeneration');
          }
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

  /** Render the config from current settings, carrying the existing identity forward. */
  async renderNative() {
    const existing = await readNativeConfig();
    const persisted = await configExists();
    if (isLinux && persisted && !String(existing).trim()) {
      throw Object.assign(
        new Error(
          `Cannot read ${OPENHOP.configPath}, so the existing MeshCore identity cannot be preserved. ` +
            'Refusing to regenerate the config. Re-run install.sh to refresh the sudoers rule for reading it, then retry.',
        ),
        { status: 500 },
      );
    }
    const preserved = preservedConfig(existing);
    // An openHop install configured through its own wizard may leave the
    // identity at the system default; adopt it rather than rotating the key.
    if (!preserved.identityKey && !preserved.identityFile && isLinux) {
      const systemIdentity = '/etc/openhop_repeater/identity.key';
      let hasSystemIdentity = fs.existsSync(systemIdentity);
      if (!hasSystemIdentity) {
        hasSystemIdentity = (await run('sudo', ['-n', 'test', '-f', systemIdentity], { timeout: 5000 })).ok;
      }
      if (hasSystemIdentity) preserved.identityFile = systemIdentity;
    }
    const position = this.gps?.getState?.() || null;
    const text = renderNativeConfig(
      getSettings(),
      position?.lat != null ? { lat: position.lat, lon: position.lon } : null,
      preserved,
    );
    return { text, preserved, existing };
  }

  async ensureNativePassword() {
    if (nativeSettings(getSettings()).adminPassword) return;
    const { randomBytes } = await import('node:crypto');
    updateSettings({ lora: { meshcore: { native: { adminPassword: randomBytes(12).toString('base64url') } } } });
    await saveSettings();
  }

  /** Write the regenerated config without restarting anything (used before a handover). */
  async prepareNativeConfig() {
    await this.ensureNativePassword();
    const { text } = await this.renderNative();
    return writeNativeConfig(text, false);
  }

  /** Persist native config changes while MeshCore does not own the radio. */
  async saveNativeConfig() {
    await this.ensureNativePassword();
    const { text, preserved } = await this.renderNative();
    const base = {
      applied: false,
      pending: true,
      configPath: OPENHOP.configPath,
      identityFile: preserved.identityFile || OPENHOP.identityFile,
      preservedIdentity: Boolean(preserved.identityKey || preserved.identityFile),
      rendered: text,
    };
    if (!isLinux) {
      return { ...base, ok: false, warnings: ['Native MeshCore configuration is written on Linux only.'] };
    }
    const write = await writeNativeConfig(text, false);
    return { ...base, ok: true, backup: write.backup, warnings: [] };
  }

  /**
   * Regenerate /etc/openhop_repeater/config.yaml from the current pins, preset
   * and node name, restart openHop and reattach the bridge. The identity is
   * read from the existing config first, so applying a preset never rotates the
   * node's MeshCore identity.
   */
  async applyNative() {
    const settings = getSettings();
    if (settings.lora.mode !== 'meshcore' || settings.lora.meshcore.transport !== 'native') {
      throw Object.assign(
        new Error('MeshCore does not own the HAT radio. Switch to Meshtastic or native MeshCore before applying the config.'),
        { status: 409 },
      );
    }
    if (this.lock) throw Object.assign(new Error('A radio operation is already in progress.'), { status: 409 });
    this.steps = [];
    this.lock = this._applyNative([], { reconnectBridge: true });
    this.hub?.publish('radio', { switching: true, steps: this.steps, mode: settings.lora.mode });
    try {
      return await this.lock;
    } finally {
      this.lock = null;
      this.hub?.publish('radio', { switching: false, steps: this.steps, mode: getSettings().lora.mode });
    }
  }

  async _applyNative(warnings, { reconnectBridge = false } = {}) {
    await this.ensureNativePassword();
    this.progress('Regenerating openHop configuration');

    let text = '';
    let preserved = {};
    let existing = '';
    let changed = false;
    let renderError = null;
    try {
      ({ text, preserved, existing } = await this.renderNative());
      changed = text.trim() !== String(existing || '').trim();
    } catch (err) {
      renderError = err;
      warnings.push(err.message);
      this.progress('Config left untouched to protect the existing identity');
    }

    let backup = null;
    let restarted = false;
    let ready = false;
    let wrote = false;
    if (!isLinux) {
      warnings.push('Native MeshCore configuration and service control require Linux.');
      this.progress('Config apply skipped (not Linux)');
    } else if (renderError) {
      // The existing file could not be read, so it was not rewritten. Restart
      // against it to keep the identity and the mesh available.
      restarted = await restartNative();
      this.progress(restarted ? 'Restarted openHop with the existing config' : 'openHop Repeater did not restart');
      if (!restarted) {
        warnings.push('openHop Repeater did not restart. Check its journal from the System page.');
      } else {
        const native = nativeSettings(getSettings());
        ready = await waitForTcp(native.bindAddress, native.tcpPort, 30000);
        this.progress(ready ? `Companion endpoint ready on ${native.tcpPort}` : 'Companion endpoint did not open in time');
        if (!ready) warnings.push(`openHop did not open companion TCP ${native.tcpPort} within 30 s. Check its journal.`);
        if (reconnectBridge) await this.reattachMeshCore(warnings);
      }
    } else if (!changed) {
      wrote = true;
      this.progress('openHop configuration already matches the saved settings');
    } else {
      try {
        const write = await writeNativeConfig(text, false);
        backup = write.backup;
        wrote = true;
        this.progress(`Wrote ${OPENHOP.configPath}${backup ? ' (previous file backed up)' : ''}`);
      } catch (err) {
        warnings.push(`openHop config: ${err.message}`);
        this.progress('Could not write the openHop configuration');
      }

      if (wrote) {
        restarted = await restartNative();
        this.progress(restarted ? 'Restarted openHop Repeater' : 'openHop Repeater did not restart');
        if (!restarted) warnings.push('openHop Repeater did not restart. Check its journal from the System page.');

        const native = nativeSettings(getSettings());
        ready = restarted && (await waitForTcp(native.bindAddress, native.tcpPort, 30000));
        this.progress(ready ? `Companion endpoint ready on ${native.tcpPort}` : 'Companion endpoint did not open in time');
        if (restarted && !ready) {
          warnings.push(`openHop did not open companion TCP ${native.tcpPort} within 30 s. Check its journal.`);
        }

        if (reconnectBridge) await this.reattachMeshCore(warnings);
      }
    }

    return {
      ok: isLinux && !renderError && restarted && ready,
      applied: !renderError && restarted,
      configError: Boolean(renderError),
      pending: false,
      restarted,
      ready,
      backup,
      configPath: OPENHOP.configPath,
      identityFile: preserved.identityFile || OPENHOP.identityFile,
      preservedIdentity: Boolean(preserved.identityKey || preserved.identityFile),
      rendered: text,
      steps: this.steps.slice(),
      warnings,
    };
  }

  async stopBridge(kind) {
    try {
      await this.mesh[kind]?.stop();
    } catch {
      /* best effort */
    }
  }

  async reattachMeshCore(warnings) {
    this.progress('Reattaching the MeshCore bridge');
    await this.stopBridge('meshcore');
    try {
      await this.mesh.meshcore.start();
    } catch (err) {
      warnings.push(`MeshCore bridge: ${err.message}`);
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
          const warnings = [];
          await this._applyNative(warnings, { reconnectBridge: false });
          for (const warning of warnings) log.warn(warning);
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
