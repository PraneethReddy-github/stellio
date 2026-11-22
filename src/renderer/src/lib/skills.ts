import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { IpcInput, IpcOutput } from '@shared/ipc/contract';
import { useState } from 'react';
import { call } from './ipc';
import { cancelTask } from './jobs';
import { refreshDocs } from './resume';

export type AuditResult = IpcOutput<'skills:audit'>;
export type Decided = IpcOutput<'skills:decide'>;
export type DecideInput = Omit<IpcInput<'skills:decide'>, 'jobId'>;
export type LearningUpdate = IpcInput<'learning:update'>;

const auditKey = (jobId: string, version: number) => ['skillAudit', jobId, version] as const;

/** The audit of one resume version. AI wording is cached in main per version, so one fetch per version. */
export function useSkillAudit(jobId: string, version: number) {
  return useQuery({
    queryKey: auditKey(jobId, version),
    queryFn: () => call('skills:audit', { jobId, version, requestId: crypto.randomUUID() }),
    staleTime: Infinity,
  });
}

/** K / R / L / A. A keep or remove makes a new resume version; its audit is seeded so the panel opens at once. */
export function useDecideSkill(jobId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DecideInput) => call('skills:decide', { jobId, ...input }),
    onSuccess: (r, input) => {
      qc.setQueryData<AuditResult>(auditKey(jobId, r.newVersion ?? input.version), {
        rows: r.audit,
        aiWarning: null,
      });
      void qc.invalidateQueries({ queryKey: ['skills'] });
      if (r.newVersion !== undefined) void refreshDocs(qc, 'resume', jobId);
    },
  });
}

/** After the profile holds the skill: it is allowed on this job's resume. */
export function useRecordApproval(jobId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (skill: string) => call('skills:recordApproval', { jobId, skill }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['skills'] });
      void qc.invalidateQueries({ queryKey: ['skillAudit', jobId] });
    },
  });
}

export const useLedger = () =>
  useQuery({ queryKey: ['skills', 'ledger'], queryFn: () => call('skills:ledger', undefined) });
export const useGaps = () =>
  useQuery({ queryKey: ['skills', 'gaps'], queryFn: () => call('skills:gaps', {}) });
export const useLearning = () =>
  useQuery({ queryKey: ['skills', 'learning'], queryFn: () => call('learning:list', undefined) });

export function useUpdateLearning() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LearningUpdate) => call('learning:update', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['skills'] }),
  });
}

export function useAddLearning() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (skill: string) => call('learning:add', { skill }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['skills'] }),
  });
}

export type RoadmapData = IpcOutput<'learning:roadmap'>;
export type RoadmapRow = RoadmapData['items'][number];
export type WhatIfData = IpcOutput<'learning:whatIf'>;

/** The learning list ranked by priority, with "unlocks N jobs". Code only. */
export const useRoadmap = () =>
  useQuery({
    queryKey: ['skills', 'roadmap'],
    queryFn: () => call('learning:roadmap', undefined),
    refetchOnMount: 'always', // jobs and the profile change elsewhere
  });

/** What-if for 1-3 skills. Code only, so it runs on every selection. */
export const useWhatIf = (skills: readonly string[]) =>
  useQuery({
    queryKey: ['skills', 'whatIf', ...skills],
    queryFn: () => call('learning:whatIf', { skills: [...skills] }),
    enabled: skills.length > 0,
  });

/** Suggested resources for one item: asked for only when the button is pressed. */
export function useSuggestResources() {
  const qc = useQueryClient();
  const [requestId, setRequestId] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (id: string) => {
      const rid = crypto.randomUUID();
      setRequestId(rid);
      return call('learning:resources', { id, requestId: rid });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['skills'] }),
    onSettled: () => {
      setRequestId(null);
      void qc.invalidateQueries({ queryKey: ['ai', 'runs'] });
    },
  });
  return { ...m, cancel: () => (requestId ? cancelTask(requestId) : Promise.resolve()) };
}
