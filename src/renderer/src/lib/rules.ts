import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import {
  isRuleFile,
  isTemplateFile,
  lintRules,
  RULE_KIND,
  TEMPLATE_KIND,
  type RulesFile,
} from '@shared/rules';
import { parseTemplate } from '@shared/latex/template';
import type { Diagnostic } from '@shared/profile';
import type { IpcOutput } from '@shared/ipc/contract';
import { call } from './ipc';

export type RulesSnapshot = IpcOutput<'rules:get'>;
export type RulesInfo = IpcOutput<'rules:list'>[number];
/** Unsaved text plus the hash of the disk version it was started from (what a save is checked against). */
export type Draft = { text: string; baseHash: string };

const keys = {
  list: ['rules', 'list'] as const,
  file: (p: RulesFile) => ['rules', 'file', p] as const,
  history: (p: RulesFile) => ['rules', 'history', p] as const,
  changes: (p: RulesFile, h: string) => ['rules', 'changes', p, h] as const,
  preview: (p: RulesFile) => ['rules', 'preview', p] as const,
};

/** Lints exactly as the main process does on save, so the live list and the saved list agree. */
export function diagnose(path: RulesFile, content: string): Diagnostic[] {
  if (isRuleFile(path)) return lintRules(RULE_KIND[path], content).diagnostics;
  if (isTemplateFile(path)) return parseTemplate(content, TEMPLATE_KIND[path]).diagnostics;
  return [];
}

export function useRulesList() {
  return useQuery({
    queryKey: keys.list,
    queryFn: () => call('rules:list', undefined),
    refetchOnMount: 'always',
  });
}

export function useRulesFile(path: RulesFile) {
  return useQuery({
    queryKey: keys.file(path),
    queryFn: () => call('rules:get', { path }),
    refetchOnMount: 'always', // the file may have changed while this screen was closed
  });
}

export function useRulesHistory(path: RulesFile) {
  return useQuery({
    queryKey: keys.history(path),
    queryFn: () => call('rules:history', { path, limit: 100 }),
  });
}

export function useRulesChanges(path: RulesFile, hash: string | null) {
  return useQuery({
    queryKey: keys.changes(path, hash ?? ''),
    queryFn: () => call('rules:changes', { path, hash: hash ?? '' }),
    enabled: hash !== null,
    staleTime: Infinity, // a commit's diff never changes
  });
}

export function useResetPreview(path: RulesFile) {
  return useQuery({
    queryKey: keys.preview(path),
    queryFn: () => call('rules:resetPreview', { path }),
    refetchOnMount: 'always',
    gcTime: 0,
  });
}

/** After any write: the file, its history and the list are new. */
function useApplySnapshot() {
  const qc = useQueryClient();
  return (snap: RulesSnapshot): void => {
    qc.setQueryData(keys.file(snap.path), snap);
    void qc.invalidateQueries({ queryKey: keys.history(snap.path) });
    void qc.invalidateQueries({ queryKey: keys.list });
    void qc.invalidateQueries({ queryKey: keys.preview(snap.path) });
  };
}

export function useSaveRules(path: RulesFile) {
  const apply = useApplySnapshot();
  return useMutation({
    // `expectedHash` is the hash the draft started from. `overwrite` (explicitly confirmed) trusts whatever is on
    // disk now instead; the main process keeps that version in history first.
    mutationFn: async ({
      overwrite,
      ...input
    }: {
      content: string;
      message?: string;
      expectedHash: string;
      overwrite?: boolean;
    }) =>
      call('rules:save', {
        path,
        ...input,
        expectedHash: overwrite ? (await call('rules:get', { path })).hash : input.expectedHash,
      }),
    onSuccess: apply,
  });
}

export function useRevertRules(path: RulesFile) {
  const apply = useApplySnapshot();
  return useMutation({
    mutationFn: (hash: string) => call('rules:revert', { path, hash }),
    onSuccess: apply,
  });
}

export function useResetRules(path: RulesFile) {
  const qc = useQueryClient();
  const apply = useApplySnapshot();
  return useMutation({
    mutationFn: () =>
      call('rules:reset', {
        path,
        expectedHash: qc.getQueryData<RulesSnapshot>(keys.file(path))?.hash ?? null,
      }),
    onSuccess: apply,
  });
}

/** Calls `onChange` for every rules/templates file edited outside the app. */
export function useRulesFileWatch(onChange: (path: RulesFile) => void): void {
  const qc = useQueryClient();
  useEffect(
    () =>
      window.stellio.on('datafolder:changed', ({ relPath }) => {
        if (!isRuleFile(relPath) && !isTemplateFile(relPath)) return;
        void qc.invalidateQueries({ queryKey: keys.list });
        onChange(relPath);
      }),
    [onChange, qc],
  );
}

/** Re-reads one file from disk into the cache. */
export function useReloadRules(): (path: RulesFile) => Promise<unknown> {
  const qc = useQueryClient();
  return (path) => qc.refetchQueries({ queryKey: keys.file(path) });
}
