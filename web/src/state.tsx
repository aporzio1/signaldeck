import { createContext, useContext, useEffect, useState } from 'react';

export const AppCtx = createContext<{
  overview: any;
  refresh: () => Promise<void>;
  refreshSlow: () => Promise<void>;
  authed: boolean;
  logout: () => Promise<void>;
}>({
  overview: null,
  refresh: async () => {},
  refreshSlow: async () => {},
  authed: false,
  logout: async () => {},
});

export const useApp = () => useContext(AppCtx);

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function useTick(intervalMs: number, fn: () => void, deps: any[] = []) {
  useEffect(() => {
    fn();
    const timer = setInterval(fn, intervalMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
