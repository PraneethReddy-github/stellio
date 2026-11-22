import { useEffect, useState } from 'react';

/** `value`, but only after it has stayed unchanged for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

/** Whole seconds since `running` turned true; 0 while idle. */
export function useElapsedSeconds(running: boolean): number {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!running) return;
    const start = Date.now();
    const id = setInterval(() => setSecs(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => {
      clearInterval(id);
      setSecs(0);
    };
  }, [running]);
  return running ? secs : 0;
}
