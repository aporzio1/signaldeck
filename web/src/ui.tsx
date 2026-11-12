import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './icons';

export function Card(props: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  flush?: boolean;
  id?: string;
}) {
  return (
    <section id={props.id} className={`card ${props.flush ? 'flush' : ''} ${props.className || ''}`}>
      {(props.title || props.actions) && (
        <div className="card-head">
          <div className="grow">
            {props.title && <div className="card-title">{props.title}</div>}
            {props.subtitle && <div className="card-sub">{props.subtitle}</div>}
          </div>
          {props.actions && <div className="row tight">{props.actions}</div>}
        </div>
      )}
      <div className="card-body">{props.children}</div>
    </section>
  );
}

export function Badge({ tone = '', children, dot }: { tone?: string; children: ReactNode; dot?: boolean }) {
  return (
    <span className={`badge ${tone}`}>
      {dot && <i className="dot" />}
      {children}
    </span>
  );
}

export function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger' | '';
  size?: 'sm' | 'lg';
  icon?: string;
  busy?: boolean;
}) {
  const { variant = '', size = '', icon, busy, children, className = '', disabled, ...rest } = props;
  return (
    <button
      className={`btn ${variant ? `btn-${variant}` : ''} ${size ? `btn-${size}` : ''} ${className}`}
      disabled={disabled || busy}
      {...rest}
    >
      {busy ? <span className="spinner" /> : icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      {children}
    </button>
  );
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Toggle(props: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="check" style={{ opacity: props.disabled ? 0.5 : 1 }}>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span className="check-text">
        <span className="check-title">{props.label}</span>
        {props.hint && <span className="field-hint">{props.hint}</span>}
      </span>
    </label>
  );
}

export function Slider(props: {
  label: ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  return (
    <div className="field">
      <div className="spread">
        <span className="field-label">{props.label}</span>
        <span className="mono small">{props.format ? props.format(props.value) : props.value}</span>
      </div>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
      {props.hint && <span className="field-hint">{props.hint}</span>}
    </div>
  );
}

export function Select(props: {
  value: string | number;
  onChange: (value: string) => void;
  options: Array<{ value: string | number; label: string }>;
  disabled?: boolean;
}) {
  return (
    <select
      className="select"
      value={props.value}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.target.value)}
    >
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Stat(props: { label: ReactNode; value: ReactNode; unit?: ReactNode; hint?: ReactNode; size?: 'sm' | 'xl' }) {
  return (
    <div className="stat">
      <span className="stat-label">{props.label}</span>
      <span className={`stat-value ${props.size || ''}`}>
        {props.value}
        {props.unit && <span className="stat-unit">{props.unit}</span>}
      </span>
      {props.hint && <span className="stat-hint">{props.hint}</span>}
    </div>
  );
}

export function Meter({ value, tone = '' }: { value: number; tone?: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className={`meter ${tone}`}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Tabs<T extends string>(props: { tabs: Array<{ id: T; label: string }>; value: T; onChange: (id: T) => void }) {
  return (
    <div className="tabs">
      {props.tabs.map((tab) => (
        <button key={tab.id} className={`tab ${props.value === tab.id ? 'active' : ''}`} onClick={() => props.onChange(tab.id)}>
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {hint && <div>{hint}</div>}
      {action}
    </div>
  );
}

export function Modal({ open, title, children, onClose, wide }: { open: boolean; title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(4,7,11,.72)', backdropFilter: 'blur(4px)',
        display: 'grid', placeItems: 'center', zIndex: 60, padding: 16,
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={ref} className="card" style={{ width: '100%', maxWidth: wide ? 720 : 460, maxHeight: '86dvh', overflow: 'auto' }}>
        <div className="card-head">
          <div className="card-title">{title}</div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="card-body">{children}</div>
      </div>
    </div>
  );
}

/* ---------------- toasts ---------------- */
type Toast = { id: number; message: string; tone: 'info' | 'good' | 'bad' };
let toastSeq = 0;
const toastListeners = new Set<(toasts: Toast[]) => void>();
let toasts: Toast[] = [];

function emitToasts() {
  for (const listener of toastListeners) listener([...toasts]);
}

export function toast(message: string, tone: Toast['tone'] = 'info') {
  const entry = { id: ++toastSeq, message, tone };
  toasts = [...toasts, entry].slice(-4);
  emitToasts();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== entry.id);
    emitToasts();
  }, 4200);
}

export function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    toastListeners.add(setItems);
    return () => {
      toastListeners.delete(setItems);
    };
  }, []);
  return (
    <div style={{ position: 'fixed', bottom: 90, right: 16, left: 16, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, zIndex: 70, pointerEvents: 'none' }}>
      {items.map((item) => (
        <div
          key={item.id}
          className={`alert ${item.tone === 'bad' ? 'warn' : item.tone === 'good' ? '' : 'info'}`}
          style={{ background: 'var(--panel-2)', boxShadow: 'var(--shadow)', maxWidth: 380, pointerEvents: 'auto' }}
        >
          <Icon name={item.tone === 'bad' ? 'alert' : item.tone === 'good' ? 'check' : 'activity'} size={15} />
          <span>{item.message}</span>
        </div>
      ))}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="row" style={{ padding: 16 }}>
      <span className="spinner" />
      {label && <span className="muted small">{label}</span>}
    </div>
  );
}

export function Skeleton({ height = 80 }: { height?: number }) {
  return (
    <div
      style={{
        height, borderRadius: 10, border: '1px solid var(--line)',
        background: 'linear-gradient(90deg, #0f151e 25%, #141c26 37%, #0f151e 63%)',
        backgroundSize: '400% 100%', animation: 'shimmer 1.6s linear infinite',
      }}
    />
  );
}
