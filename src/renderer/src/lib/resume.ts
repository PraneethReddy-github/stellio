import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { IpcEvents, IpcOutput } from '@shared/ipc/contract';
import { call } from './ipc';

/** The resume and the cover letter share one flow; `kind` picks the `resume:*` or `cover:*` channels. */
export type DocKind = 'resume' | 'cover';
export type ResumeView = IpcOutput<'resume:get'>;
export type CoverView = IpcOutput<'cover:get'>;
export type DocView = ResumeView | CoverView;
export type ResumeSummary = IpcOutput<'resume:list'>[number];
export type DocSummary = ResumeSummary | IpcOutput<'cover:list'>[number];
export type ResumeProgress = IpcEvents['resume:progress'];

const keys = {
  all: (kind: DocKind, jobId: string) => [kind, jobId] as const,
  list: (kind: DocKind, jobId: string) => [kind, jobId, 'list'] as const,
  get: (kind: DocKind, jobId: string, version: number) => [kind, jobId, 'get', version] as const,
  diff: (kind: DocKind, jobId: string, a: number, b: number) => [kind, jobId, 'diff', a, b] as const,
};

/** Version list, oldest first. Refetched when profile, rules or templates change on disk: it carries `stale`. */
export function useDocVersions(kind: DocKind, jobId: string) {
  const qc = useQueryClient();
  useEffect(
    () =>
      window.stellio.on('datafolder:changed', () => {
        void qc.invalidateQueries({ queryKey: keys.list(kind, jobId) });
      }),
    [qc, kind, jobId],
  );
  return useQuery({
    queryKey: keys.list(kind, jobId),
    queryFn: (): Promise<DocSummary[]> =>
      kind === 'cover' ? call('cover:list', { jobId }) : call('resume:list', { jobId }),
    refetchOnMount: 'always',
  });
}

export function useDocVersion(kind: DocKind, jobId: string, version: number | null) {
  return useQuery({
    queryKey: keys.get(kind, jobId, version ?? 0),
    queryFn: (): Promise<DocView> =>
      kind === 'cover'
        ? call('cover:get', { jobId, version: version ?? 1 })
        : call('resume:get', { jobId, version: version ?? 1 }),
    enabled: version !== null,
    staleTime: Infinity, // a stored version only changes through its own mutations, which invalidate it
  });
}

/** tex of two versions, to diff in the renderer. */
export function useDocDiff(kind: DocKind, jobId: string, a: number | null, b: number) {
  return useQuery({
    queryKey: keys.diff(kind, jobId, a ?? 0, b),
    queryFn: () =>
      kind === 'cover'
        ? call('cover:diff', { jobId, a: a ?? 1, b })
        : call('resume:diff', { jobId, a: a ?? 1, b }),
    enabled: a !== null,
    staleTime: Infinity,
  });
}

/** A new or changed version: the list, and every cached version, may differ now. */
export const refreshDocs = (qc: QueryClient, kind: DocKind, jobId: string): Promise<void> => {
  // a first version starts the application (preparing) and a final one is what the Apply tab freezes
  void qc.invalidateQueries({ queryKey: ['tracker'] });
  return qc.invalidateQueries({ queryKey: keys.all(kind, jobId) });
};

const settle = (qc: QueryClient) => () => qc.invalidateQueries({ queryKey: ['ai', 'runs'] });

/** The compile stopped on a file the offline cache lacks: fetch what this version needs, then compile it again. */
export function useFetchMissingFiles(kind: DocKind, jobId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (doc: { version: number; tex: string }) => {
      await call('latex:warmUp', { tex: doc.tex });
      return kind === 'cover'
        ? call('cover:compile', { jobId, version: doc.version })
        : call('resume:compile', { jobId, version: doc.version });
    },
    onSuccess: () =>
      Promise.all([refreshDocs(qc, kind, jobId), qc.invalidateQueries({ queryKey: ['latex'] })]),
  });
}

export function useGenerateDoc(kind: DocKind, jobId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { requestId: string; instruction?: string }): Promise<DocView> =>
      kind === 'cover'
        ? call('cover:generate', { jobId, ...input })
        : call('resume:generate', { jobId, ...input }),
    onSuccess: () => refreshDocs(qc, kind, jobId),
    onSettled: settle(qc),
  });
}

export function useReviseDoc(kind: DocKind, jobId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { requestId: string; fromVersion: number; instruction: string }): Promise<DocView> =>
      kind === 'cover'
        ? call('cover:revise', { jobId, ...input })
        : call('resume:revise', { jobId, ...input }),
    onSuccess: () => refreshDocs(qc, kind, jobId),
    onSettled: settle(qc),
  });
}

/** German version of a drafted English version (resume:translate / cover:translate). */
export function useTranslateDoc(kind: DocKind, jobId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { requestId: string; fromVersion: number }): Promise<DocView> =>
      kind === 'cover'
        ? call('cover:translate', { jobId, ...input })
        : call('resume:translate', { jobId, ...input }),
    onSuccess: () => refreshDocs(qc, kind, jobId),
    onSettled: settle(qc),
  });
}

export function useSaveManualDoc(kind: DocKind, jobId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { fromVersion: number; tex: string }): Promise<DocView> =>
      kind === 'cover'
        ? call('cover:saveManual', { jobId, ...input })
        : call('resume:saveManual', { jobId, ...input }),
    onSuccess: () => refreshDocs(qc, kind, jobId),
  });
}

export function useMarkFinal(kind: DocKind, jobId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (version: number): Promise<DocSummary[]> =>
      kind === 'cover'
        ? call('cover:markFinal', { jobId, version })
        : call('resume:markFinal', { jobId, version }),
    onSuccess: () => refreshDocs(qc, kind, jobId),
  });
}

export const exportDoc = (kind: DocKind, jobId: string, version: number, format: 'tex' | 'pdf') =>
  kind === 'cover'
    ? call('cover:export', { jobId, version, format })
    : call('resume:export', { jobId, version, format });

export const openInOverleaf = (kind: DocKind, jobId: string, version: number) =>
  kind === 'cover'
    ? call('cover:openOverleaf', { jobId, version })
    : call('resume:openOverleaf', { jobId, version });

/** Latest stage of the run started with `requestId`, or null before its first event. */
export function useDocProgress(kind: DocKind, requestId: string | null): ResumeProgress | null {
  const [last, setLast] = useState<ResumeProgress | null>(null);
  useEffect(() => {
    const on = (p: ResumeProgress): void => {
      if (p.requestId === requestId) setLast(p);
    };
    return kind === 'cover'
      ? window.stellio.on('cover:progress', on)
      : window.stellio.on('resume:progress', on);
  }, [kind, requestId]);
  return last?.requestId === requestId ? last : null;
}
