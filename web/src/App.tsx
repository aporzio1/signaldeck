import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api, authApi } from './api';
import { Icon } from './icons';
import { Dashboard } from './pages/Dashboard';
import { GpsPage } from './pages/Gps';
import { MeshCorePage } from './pages/MeshCore';
import { MeshtasticPage } from './pages/Meshtastic';
import { SdrPage } from './pages/Sdr';
import { SettingsPage } from './pages/Settings';
import { SystemPage } from './pages/System';
import { TimePage } from './pages/Time';
import { AppCtx } from './state';
import { Badge, Button, Toaster, toast } from './ui';

export const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: 'home', group: 'Operate' },
  { id: 'sdr', label: 'SDR', icon: 'radio', group: 'Operate' },
  { id: 'meshtastic', label: 'Meshtastic', icon: 'mesh', group: 'Operate' },
  { id: 'meshcore', label: 'MeshCore', icon: 'layers', group: 'Operate' },
  { id: 'gps', label: 'GPS', icon: 'gps', group: 'Operate' },
  { id: 'time', label: 'Time & RTC', icon: 'clock', group: 'Device' },
  { id: 'system', label: 'System', icon: 'cpu', group: 'Device' },
  { id: 'settings', label: 'Settings', icon: 'settings', group: 'Device' },
];

function useRoute() {
  const read = () => (location.hash.replace(/^#\/?/, '') || 'dashboard').split('?')[0];
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => {
      setRoute(read());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onChange);
    if (!location.hash) location.replace('#/dashboard');
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

function Brand({ compact }: { compact?: boolean }) {
  return (
    <div className="brand" style={compact ? { padding: 0 } : undefined}>
      <div className="brand-mark">
        <Icon name="radio" size={19} />
      </div>
      <div>
        <div className="brand-name">SignalDeck</div>
        {!compact && <div className="brand-sub">HAT console</div>}
      </div>
    </div>
  );
}

function AuthScreen({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    if (setup && password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    if (password.length < 8) {
      setError('Use at least 8 characters.');
      return;
    }
    setBusy(true);
    try {
      if (setup) await authApi.setup(password);
      else await authApi.login(password);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the device.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <div className="brand-mark" style={{ width: 38, height: 38 }}>
            <Icon name="radio" size={21} />
          </div>
          <div>
            <div className="auth-title">SignalDeck</div>
            <div className="auth-sub">RTL-SDR · LoRa · GPS · RTC</div>
          </div>
        </div>
        <h2 style={{ fontSize: 16, marginBottom: 4 }}>{setup ? 'Create your console password' : 'Sign in'}</h2>
        <p className="dim small" style={{ marginBottom: 16 }}>
          {setup
            ? 'This password protects the radio, mesh and device controls from anyone on your network.'
            : 'Enter the password configured on this device.'}
        </p>
        <div className="stack">
          <label className="field">
            <span className="field-label">Password</span>
            <input
              className="input"
              type="password"
              autoFocus
              autoComplete={setup ? 'new-password' : 'current-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
            />
          </label>
          {setup && (
            <label className="field">
              <span className="field-label">Confirm password</span>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                placeholder="••••••••"
              />
            </label>
          )}
          {error && <div className="alert warn small">{error}</div>}
          <Button type="submit" variant="primary" size="lg" busy={busy} className="btn-block">
            {setup ? 'Finish setup' : 'Unlock console'}
          </Button>
        </div>
        <div className="auth-foot">
          Running locally on your Raspberry Pi.
          <br />
          Use Tailscale or a VPN for access away from home.
        </div>
      </form>
    </div>
  );
}

export function App() {
  const route = useRoute();
  const [auth, setAuth] = useState<'loading' | 'setup' | 'login' | 'ready'>('loading');
  const [overview, setOverview] = useState<any>(null);
  const [connected, setConnected] = useState(true);

  const checkAuth = useCallback(async () => {
    try {
      const status = await authApi.status();
      setAuth(status.setupRequired ? 'setup' : status.authenticated ? 'ready' : 'login');
    } catch {
      setAuth('login');
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const refresh = useCallback(async () => {
    try {
      const data = await api.get('/overview');
      setOverview(data);
      setConnected(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setAuth('login');
      else setConnected(false);
    }
  }, []);

  useEffect(() => {
    if (auth !== 'ready') return;
    refresh();
    const timer = setInterval(refresh, 6000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [auth, refresh]);

  const logout = useCallback(async () => {
    await authApi.logout().catch(() => {});
    setOverview(null);
    setAuth('login');
  }, []);

  const ctx = useMemo(
    () => ({ overview, refresh, refreshSlow: refresh, authed: auth === 'ready', logout }),
    [overview, refresh, auth, logout],
  );

  if (auth === 'loading') {
    return (
      <div className="auth-wrap">
        <span className="spinner" style={{ width: 26, height: 26 }} />
      </div>
    );
  }
  if (auth !== 'ready') {
    return <AuthScreen setup={auth === 'setup'} onDone={() => { checkAuth().then(() => refresh()); }} />;
  }

  const nav = NAV.find((item) => item.id === route) || NAV[0];
  const hardware = overview?.hardware;
  const demo = overview?.demo;

  const page = (() => {
    switch (route) {
      case 'sdr':
        return <SdrPage />;
      case 'meshtastic':
        return <MeshtasticPage />;
      case 'meshcore':
        return <MeshCorePage />;
      case 'gps':
        return <GpsPage />;
      case 'time':
        return <TimePage />;
      case 'system':
        return <SystemPage />;
      case 'settings':
        return <SettingsPage />;
      default:
        return <Dashboard />;
    }
  })();

  const gps = overview?.gps;
  const meshState = overview?.mesh;

  return (
    <AppCtx.Provider value={ctx}>
      <div className="shell">
        <aside className="sidebar">
          <a href="#/dashboard" style={{ color: 'inherit' }}>
            <Brand />
          </a>
          <nav className="nav">
            {NAV.map((item, index) => (
              <div key={item.id}>
                {(index === 0 || NAV[index - 1].group !== item.group) && <div className="nav-label">{item.group}</div>}
                <a className={`nav-item ${route === item.id ? 'active' : ''}`} href={`#/${item.id}`}>
                  <Icon name={item.icon} size={17} />
                  {item.label}
                </a>
              </div>
            ))}
          </nav>
          <div className="sidebar-foot">
            <div className="spread">
              <strong>{hardware?.model && hardware.isPi ? 'Raspberry Pi' : 'Device'}</strong>
              <span>{overview?.version ? `v${overview.version}` : ''}</span>
            </div>
            <div className="truncate" title={hardware?.model}>{hardware?.model || 'Detecting hardware…'}</div>
            <div className="row tight" style={{ marginTop: 4 }}>
              <span className={`pulse`} style={{ background: connected ? 'var(--green)' : 'var(--red)' }} />
              <span>{connected ? 'Connected' : 'Reconnecting…'}</span>
            </div>
          </div>
        </aside>

        <div className="main">
          <header className="topbar">
            <div>
              <div className="topbar-title">{nav.label}</div>
              <div className="topbar-sub">
                {overview?.stationName || 'SignalDeck'} · {hardware?.model || 'Raspberry Pi HAT'}
              </div>
            </div>
            <div className="topbar-spacer" />
            <div className="chip-row">
              {demo && <Badge tone="violet" dot>Demo mode</Badge>}
              {gps && (
                <Badge tone={gps.fix >= 3 ? 'good' : gps.fix >= 2 ? 'info' : 'warn'} dot>
                  {gps.fix >= 2 ? `${gps.satsUsed || 0} sats` : 'No fix'}
                </Badge>
              )}
              {meshState && (
                <Badge tone={meshState[meshState.mode]?.running ? 'good' : ''} dot>
                  {meshState.mode === 'meshtastic' ? 'Meshtastic' : 'MeshCore'}
                </Badge>
              )}
              {overview?.system?.temperature != null && (
                <Badge tone={overview.system.temperature > 75 ? 'warn' : ''}>{overview.system.temperature.toFixed(0)} °C</Badge>
              )}
            </div>
          </header>

          <main className="content">{page}</main>
        </div>

        <nav className="mobile-nav">
          {NAV.map((item) => (
            <a key={item.id} href={`#/${item.id}`} className={route === item.id ? 'active' : ''}>
              <Icon name={item.icon} size={19} />
              <span>{item.label}</span>
            </a>
          ))}
        </nav>
      </div>
      <Toaster />
    </AppCtx.Provider>
  );
}
