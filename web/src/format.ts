export function fmtHz(hz: number | null | undefined, digits = 4): string {
  if (hz == null || !Number.isFinite(hz)) return '—';
  const value = Number(hz);
  if (Math.abs(value) >= 1e9) return `${(value / 1e9).toFixed(digits)} GHz`;
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(digits)} MHz`;
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(2)} kHz`;
  return `${value.toFixed(0)} Hz`;
}

export function fmtHzLong(hz: number | null | undefined): string {
  if (hz == null || !Number.isFinite(hz)) return '000.000.000';
  return Math.round(hz).toString().padStart(9, '0').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

export function fmtMHz(hz: number | null | undefined, digits = 3): string {
  if (hz == null || !Number.isFinite(hz)) return '—';
  return (hz / 1e6).toFixed(digits);
}

export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
}

export function fmtTime(ts: number | string | null | undefined): string {
  if (!ts) return '—';
  const date = typeof ts === 'string' ? new Date(ts) : new Date(ts);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtDateTime(ts: number | string | null | undefined): string {
  if (!ts) return '—';
  const date = typeof ts === 'string' ? new Date(ts) : new Date(ts);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtAgo(ts: number | null | undefined): string {
  if (!ts) return 'never';
  const seconds = Math.max(0, Math.floor((Date.now() - Number(ts)) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.abs(bytes);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

export function fmtCoord(lat: number | null | undefined, lon: number | null | undefined, digits = 6): string {
  if (lat == null || lon == null) return '—';
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(digits)}° ${ns}, ${Math.abs(lon).toFixed(digits)}° ${ew}`;
}

export function fmtDistance(meters: number | null | undefined, imperial = false): string {
  if (meters == null || !Number.isFinite(meters)) return '—';
  if (imperial) {
    const miles = meters / 1609.344;
    if (miles < 0.1) return `${Math.round(meters * 3.28084)} ft`;
    return `${miles.toFixed(1)} mi`;
  }
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

export function haversine(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const lat1 = (aLat * Math.PI) / 180;
  const lat2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const DEMODS = [
  { id: 'nfm', label: 'NFM', hint: 'Narrowband FM — voice, LoRa band, walkie-talkies' },
  { id: 'wfm', label: 'WFM', hint: 'Broadcast FM (mono)' },
  { id: 'am', label: 'AM', hint: 'Airband and shortwave AM' },
  { id: 'usb', label: 'USB', hint: 'Upper sideband' },
  { id: 'lsb', label: 'LSB', hint: 'Lower sideband' },
];

export const DEMOD_LABEL: Record<string, string> = Object.fromEntries(DEMODS.map((d) => [d.id, d.label]));

export const SAMPLE_RATES = [240000, 480000, 1024000, 1200000, 1536000, 2048000, 2400000];

export const REGIONS = [
  { value: 1, label: 'US / Canada (902–928 MHz)' },
  { value: 2, label: 'EU 433 (433 MHz)' },
  { value: 3, label: 'EU 868 (863–870 MHz)' },
  { value: 4, label: 'China' },
  { value: 5, label: 'Japan' },
  { value: 6, label: 'Australia / NZ' },
  { value: 7, label: 'Korea' },
  { value: 8, label: 'Taiwan' },
  { value: 9, label: 'Russia' },
  { value: 10, label: 'India' },
  { value: 11, label: 'NZ 865' },
  { value: 12, label: 'Thailand' },
  { value: 13, label: '2.4 GHz' },
  { value: 14, label: 'Ukraine 433' },
  { value: 15, label: 'Ukraine 868' },
  { value: 17, label: 'Malaysia 919' },
  { value: 18, label: 'Singapore 923' },
];

export const PRESETS = [
  { value: 1, label: 'Long Fast' },
  { value: 2, label: 'Long Slow' },
  { value: 3, label: 'Very Long Slow' },
  { value: 4, label: 'Medium Slow' },
  { value: 5, label: 'Medium Fast' },
  { value: 6, label: 'Short Slow' },
  { value: 7, label: 'Short Fast' },
  { value: 8, label: 'Long Moderate' },
  { value: 9, label: 'Short Turbo' },
];

export const ROLES = [
  { value: 0, label: 'Client' },
  { value: 1, label: 'Client (mute)' },
  { value: 2, label: 'Router' },
  { value: 3, label: 'Router + client' },
  { value: 4, label: 'Repeater' },
  { value: 5, label: 'Tracker' },
  { value: 6, label: 'Sensor' },
  { value: 7, label: 'TAK' },
  { value: 8, label: 'Client (hidden)' },
  { value: 11, label: 'Router (late)' },
  { value: 12, label: 'Client (base)' },
];

export function toneForLevel(level: number): string {
  if (level >= 0.85) return 'bad';
  if (level >= 0.65) return 'warn';
  return '';
}
