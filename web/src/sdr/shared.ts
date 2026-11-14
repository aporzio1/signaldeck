import { SdrEngine } from './engine';

/**
 * One engine for the whole app lifecycle: the SDR page and the footer player
 * share it, so navigating away from the SDR page keeps audio playing. Pages
 * attach and detach; the engine (and its audio) survives.
 */
let engine: SdrEngine | null = null;

export function getEngine(): SdrEngine {
  if (!engine) {
    engine = new SdrEngine();
    engine.start();
  }
  return engine;
}
