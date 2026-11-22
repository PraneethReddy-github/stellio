import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { InsightWindow } from '@shared/insights';
import type { IpcOutput } from '@shared/ipc/contract';
import { call } from './ipc';
import { cancelTask } from './jobs';

export type InsightsData = IpcOutput<'insights:summary'>;
export type InsightsAnswerData = IpcOutput<'insights:ask'>;

export const useInsights = (window: InsightWindow) =>
  useQuery({
    queryKey: ['insights', window],
    queryFn: () => call('insights:summary', { window }),
    refetchOnMount: 'always', // applications change on other screens
  });

/** One question to `insights.ask`; `cancel` stops the run. */
export function useAskInsights() {
  const qc = useQueryClient();
  const [requestId, setRequestId] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (question: string) => {
      const id = crypto.randomUUID();
      setRequestId(id);
      return call('insights:ask', { question, requestId: id });
    },
    onSettled: () => {
      setRequestId(null);
      void qc.invalidateQueries({ queryKey: ['ai', 'runs'] });
    },
  });
  return { ...m, cancel: () => (requestId ? cancelTask(requestId) : Promise.resolve()) };
}
