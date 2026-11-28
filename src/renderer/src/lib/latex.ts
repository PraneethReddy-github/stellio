import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { TemplateFile } from '@shared/rules';
import type { IpcEvents, IpcOutput } from '@shared/ipc/contract';
import { call } from './ipc';

export type LatexStatus = IpcOutput<'latex:status'>;
export type CompileResult = IpcOutput<'latex:compileTemplate'>;
export type InstallProgress = IpcEvents['latex:installProgress'];

const STATUS = ['latex', 'status'] as const;

export function useLatexStatus() {
  return useQuery({
    queryKey: STATUS,
    queryFn: () => call('latex:status', undefined),
    refetchOnMount: 'always',
  });
}

/** Progress of the Tectonic download, or null while idle. */
export function useInstallLatex() {
  const qc = useQueryClient();
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const m = useMutation({
    mutationFn: () => call('latex:install', undefined),
    onSuccess: (st) => qc.setQueryData(STATUS, st),
    onSettled: () => setProgress(null),
  });
  useEffect(() => window.stellio.on('latex:installProgress', setProgress), []);
  return { ...m, progress };
}

export function useWarmUp() {
  const qc = useQueryClient();
  return useMutation({
    // `tex`: also fetch what this (edited) template needs, beyond the seed templates
    mutationFn: (tex?: string) => call('latex:warmUp', tex === undefined ? undefined : { tex }),
    onSuccess: (st) => qc.setQueryData(STATUS, st),
  });
}

export function useCompileTemplate() {
  return useMutation({
    mutationFn: (input: { path: TemplateFile; content: string }) => call('latex:compileTemplate', input),
  });
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** "3.2 of 10 MB" / "3.2 MB" for the install progress line. */
export function formatProgress(p: InstallProgress): string {
  const mb = (n: number): string => (n / 1e6).toFixed(1);
  if (p.phase === 'verify') return 'verifying checksum';
  if (p.phase === 'extract') return 'extracting';
  if (p.phase === 'done') return 'done';
  return p.total ? `downloading ${mb(p.received)} of ${mb(p.total)} MB` : `downloading ${mb(p.received)} MB`;
}

/** 0-1 for the download phase when the size is known; otherwise indeterminate. */
export const progressValue = (p: InstallProgress): number | undefined =>
  p.phase === 'download' && p.total ? Math.min(1, p.received / p.total) : undefined;
