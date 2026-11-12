const MAX = 400;
const ring = [];

function serialize(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function log(scope, message, level = 'info') {
  const entry = { ts: Date.now(), scope, level, message: serialize(message) };
  ring.push(entry);
  if (ring.length > MAX) ring.shift();
  const line = `[${new Date(entry.ts).toISOString()}] ${level.toUpperCase()} ${scope}: ${entry.message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  return entry;
}

export const logger = (scope) => ({
  info: (m) => log(scope, m, 'info'),
  warn: (m) => log(scope, m, 'warn'),
  error: (m) => log(scope, m, 'error'),
});

export function recentLogs(limit = 200) {
  return ring.slice(-limit);
}
