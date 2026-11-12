type Props = { name: string; size?: number; className?: string; strokeWidth?: number };

const paths: Record<string, JSX.Element> = {
  home: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5.5 9.5V21h13V9.5" /></>,
  radio: <><circle cx="12" cy="12" r="2.2" /><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 16.2a6 6 0 0 0 0-8.4" /><path d="M4.9 4.9a10 10 0 0 0 0 14.2M19.1 19.1a10 10 0 0 0 0-14.2" /></>,
  mesh: <><circle cx="12" cy="5" r="2.2" /><circle cx="5" cy="18" r="2.2" /><circle cx="19" cy="18" r="2.2" /><path d="M10.5 7 6.5 16M13.5 7l4 9M7.2 18h9.6" /></>,
  gps: <><path d="M12 21s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11Z" /><circle cx="12" cy="10" r="2.6" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  cpu: <><rect x="6" y="6" width="12" height="12" rx="2" /><rect x="9.5" y="9.5" width="5" height="5" rx="1" /><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 8.7a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>,
  play: <path d="M7 4.5v15l13-7.5-13-7.5Z" />,
  pause: <><rect x="6" y="4.5" width="4" height="15" rx="1" /><rect x="14" y="4.5" width="4" height="15" rx="1" /></>,
  stop: <rect x="5.5" y="5.5" width="13" height="13" rx="2" />,
  volume: <><path d="M4 9.5v5h3.5L13 19V5L7.5 9.5H4Z" /><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" /></>,
  power: <><path d="M12 3v9" /><path d="M6.5 6.5a8 8 0 1 0 11 0" /></>,
  refresh: <><path d="M20 11a8 8 0 1 0-2.3 6.1" /><path d="M20 4.5V11h-6.2" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  trash: <><path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13" /><path d="M10 11v6M14 11v6" /></>,
  download: <><path d="M12 3.5v11" /><path d="m7.5 10.5 4.5 4.5 4.5-4.5" /><path d="M4.5 19.5h15" /></>,
  alert: <><path d="M12 3.5 21.5 20H2.5L12 3.5Z" /><path d="M12 9v5M12 17h.01" /></>,
  check: <path d="m4.5 12.5 5 5 10-11" />,
  activity: <path d="M2.5 12h4l2.5-7 4 14 2.5-7h6" />,
  signal: <><path d="M4 20v-3M9 20v-6M14 20v-9M19 20V7" /></>,
  satellite: <><path d="m7 12 5-5 5 5-5 5-5-5Z" /><path d="M4.5 9.5 2.5 7.5M19.5 9.5l2-2M9.5 19.5l-2 2M14.5 19.5l2 2" /><circle cx="12" cy="12" r="1" /></>,
  terminal: <><rect x="3" y="4.5" width="18" height="15" rx="2" /><path d="m7 9 3 3-3 3M12.5 15H17" /></>,
  message: <path d="M4 5h16v11H9l-5 4V5Z" />,
  send: <path d="M4 12 20.5 4l-6 16.5-3.5-6.5L4 12Z" />,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="3" /></>,
  wifi: <><path d="M2.5 9a15 15 0 0 1 19 0M6 12.5a10 10 0 0 1 12 0M9.5 16a5 5 0 0 1 5 0" /><circle cx="12" cy="19" r="1" /></>,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  arrowUp: <path d="M12 19V5M6 11l6-6 6 6" />,
  arrowDown: <path d="M12 5v14M6 13l6 6 6-6" />,
  scan: <><path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" /><path d="M4 12h16" /></>,
  record: <circle cx="12" cy="12" r="5" />,
  layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3.5 12.5 8.5 4.7 8.5-4.7M3.5 17l8.5 4.7 8.5-4.7" /></>,
  book: <><path d="M4 4.5h6a2 2 0 0 1 2 2V20a2 2 0 0 0-2-2H4V4.5Z" /><path d="M20 4.5h-6a2 2 0 0 0-2 2V20a2 2 0 0 1 2-2h6V4.5Z" /></>,
};

export function Icon({ name, size = 18, className = '', strokeWidth = 1.7 }: Props) {
  const filled = ['play', 'pause', 'stop', 'record', 'send'].includes(name);
  return (
    <svg
      className={`icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.activity}
    </svg>
  );
}
