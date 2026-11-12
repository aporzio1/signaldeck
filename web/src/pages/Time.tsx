import { useEffect, useState } from 'react';
import { api } from '../api';
import { fmtAgo, fmtDateTime } from '../format';
import { Badge, Button, Card, Empty, Stat, toast } from '../ui';
import { useNow } from '../state';

export function TimePage() {
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState('');
  const now = useNow(1000);

  const load = () => api.get('/time').then(setData).catch((error) => toast(error.message, 'bad'));

  useEffect(() => {
    load();
    const timer = setInterval(load, 10000);
    return () => clearInterval(timer);
  }, []);

  const sync = async (direction: string, device: string) => {
    setBusy(`${direction}-${device}`);
    try {
      await api.post('/time/sync', { direction, device });
      toast(
        direction === 'to-rtc' ? 'System time written to the RTC' : 'System clock set from the RTC',
        'good',
      );
      await load();
    } catch (error: any) {
      toast(error.message, 'bad');
    } finally {
      setBusy('');
    }
  };

  if (!data) return <Empty title="Reading clock sources…" />;

  const offset = data.gps?.offsetMs;
  const ntp = data.ntp;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Time & RTC</h1>
          <p className="page-desc">
            The PCF85063A keeps time across power losses. Compare it with the system clock, NTP and the GNSS time source.
          </p>
        </div>
        <div className="row">
          <Badge tone={data.system.ntpSynchronized ? 'good' : 'warn'} dot>
            {data.system.ntpSynchronized ? 'NTP synchronised' : 'NTP not synchronised'}
          </Badge>
          <Button size="sm" icon="refresh" onClick={load}>Refresh</Button>
        </div>
      </div>

      <div className="grid three">
        <Card>
          <Stat label="System clock" value={new Date(now).toLocaleTimeString()} hint={new Date(now).toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} size="sm" />
        </Card>
        <Card>
          <Stat label="Timezone" value={data.system.timezone} hint="Set with raspi-config or timedatectl" size="sm" />
        </Card>
        <Card>
          <Stat
            label="GNSS time offset"
            value={offset != null ? `${offset > 0 ? '+' : ''}${offset} ms` : '—'}
            hint={data.gps?.time ? `UTC ${new Date(data.gps.time).toISOString().slice(11, 19)}` : 'No GNSS time'}
            size="sm"
          />
        </Card>
      </div>

      <Card title="Hardware real-time clock" subtitle={`${data.rtc.length} RTC device(s) detected`} flush>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Device</th><th>Chip</th><th>Date / time</th><th>Drift</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {data.rtc.map((rtc: any) => (
                <tr key={rtc.device}>
                  <td className="mono">{rtc.device}</td>
                  <td>
                    {rtc.name}
                    {rtc.systemClock && <Badge tone="info" >system</Badge>}
                  </td>
                  <td className="mono">{rtc.date} {rtc.time}</td>
                  <td>
                    {rtc.driftSeconds == null ? (
                      <span className="dim">—</span>
                    ) : (
                      <Badge tone={Math.abs(rtc.driftSeconds) < 2 ? 'good' : Math.abs(rtc.driftSeconds) < 10 ? 'warn' : 'bad'}>
                        {rtc.driftSeconds > 0 ? '+' : ''}{rtc.driftSeconds}s
                      </Badge>
                    )}
                  </td>
                  <td>
                    <div className="row tight">
                      <Button size="sm" busy={busy === `to-rtc-${rtc.device}`} onClick={() => sync('to-rtc', rtc.device)}>
                        System → RTC
                      </Button>
                      <Button size="sm" busy={busy === `from-rtc-${rtc.device}`} onClick={() => sync('from-rtc', rtc.device)}>
                        RTC → System
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
              {!data.rtc.length && (
                <tr>
                  <td colSpan={5}>
                    <Empty
                      title="No RTC detected"
                      hint="Enable the overlay dtoverlay=i2c-rtc,pcf85063a and check the CR1220 cell."
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid two">
        <Card title="NTP" subtitle={ntp?.daemon || 'No time daemon detected'}>
          <div className="kv">
            <dt>Reference</dt>
            <dd>{ntp?.reference || '—'}</dd>
            <dt>Stratum</dt>
            <dd>{ntp?.stratum || '—'}</dd>
            <dt>Offset</dt>
            <dd>{ntp?.offset || '—'}</dd>
            <dt>Frequency</dt>
            <dd>{ntp?.frequency || '—'}</dd>
            <dt>Healthy</dt>
            <dd>{ntp?.healthy ? 'yes' : 'no'}</dd>
          </div>
          {ntp?.raw && <pre className="log" style={{ marginTop: 10 }}>{ntp.raw}</pre>}
        </Card>

        <Card title="How the clocks fit together" subtitle="Suggested operating order">
          <div className="stack small muted">
            <p><strong style={{ color: 'var(--text)' }}>1. GNSS</strong> provides UTC to the millisecond once it has a 3D fix.</p>
            <p><strong style={{ color: 'var(--text)' }}>2. NTP</strong> disciplines the system clock whenever the network is up.</p>
            <p><strong style={{ color: 'var(--text)' }}>3. RTC</strong> keeps time when the Pi is powered down; write to it after a good NTP or GNSS sync.</p>
            <div className="hint-box">
              Sync actions use <span className="code">hwclock</span> through the sudoers rule installed by
              <span className="code"> install.sh</span>. If they fail, re-run the installer or check
              <span className="code"> /etc/sudoers.d/signaldeck</span>.
            </div>
            <div className="row">
              <Badge tone={data.gps?.fix >= 2 ? 'good' : ''} dot>GNSS {data.gps?.fixLabel || 'no fix'}</Badge>
              <Badge tone={data.system.ntpSynchronized ? 'good' : 'warn'} dot>NTP</Badge>
              <Badge tone={data.rtc.length ? 'good' : 'bad'} dot>RTC</Badge>
            </div>
          </div>
        </Card>
      </div>

      <Card title="Last known values" subtitle="Snapshot for comparison">
        <div className="grid three">
          {data.rtc.map((rtc: any) => (
            <div key={rtc.device} className="hint-box">
              <div className="tiny dim">{rtc.device} · {rtc.name}</div>
              <div className="mono small" style={{ marginTop: 4 }}>{rtc.date} {rtc.time}</div>
              <div className="dim tiny" style={{ marginTop: 2 }}>read {fmtAgo(Date.now())}</div>
            </div>
          ))}
          <div className="hint-box">
            <div className="tiny dim">system</div>
            <div className="mono small" style={{ marginTop: 4 }}>{fmtDateTime(now)}</div>
            <div className="dim tiny" style={{ marginTop: 2 }}>{Intl.DateTimeFormat().resolvedOptions().timeZone}</div>
          </div>
        </div>
      </Card>
    </div>
  );
}
