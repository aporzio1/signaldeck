import { useEffect, useState } from 'react';
import { live } from '../ws';
import { api } from '../api';
import { getEngine } from '../sdr/shared';
import { fmtMHz } from '../format';

/**
 * Mini player pinned above the page content: the audio keeps playing while
 * the operator browses other pages, and this is what they see and control.
 */
export function PlayerBar() {
  const [state, setState] = useState<any>(null);
  const [volume, setVolume] = useState(() => {
    try {
      return Number(localStorage.getItem('sd.volume') ?? 0.8);
    } catch {
      return 0.8;
    }
  });

  useEffect(() => live.subscribe(['sdr'], (data: any) => setState(data)), []);

  const running = state?.running;
  if (!running) return null;
  const engine = getEngine();

  return (
    <div className="player-bar" role="region" aria-label="SDR player">
      <span className={`player-dot ${state?.source === 'mock' ? 'mock' : ''}`} />
      <a className="player-freq" href="#/sdr" title="Open the SDR page">
        {fmtMHz(state?.frequency ?? 0, 3)}
      </a>
      <span className="player-dim">{String(state?.demod ?? '').toUpperCase()}</span>
      <input
        className="player-volume"
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={volume}
        aria-label="Volume"
        onChange={(event) => {
          const value = Number(event.target.value);
          setVolume(value);
          engine.setVolume(value);
          try {
            localStorage.setItem('sd.volume', String(value));
          } catch {
            /* ignore */
          }
        }}
      />
      <button
        type="button"
        className="player-stop"
        onClick={() => {
          engine.disableAudio();
          api.post('/sdr/stop').catch(() => undefined);
        }}
      >
        Stop
      </button>
    </div>
  );
}
