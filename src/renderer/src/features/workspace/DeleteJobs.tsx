import { SelectControls, useToast, type SelectMode } from '../../ui';
import { useDeleteJobs } from '../../lib/jobs';
import { jobCount } from './helpers';

/** Select and delete for a list of jobs or applications. `jobIds` = the selected rows that are still listed. */
export function DeleteJobs({
  mode,
  jobIds,
  empty,
}: {
  mode: SelectMode;
  jobIds: string[];
  empty: boolean;
}): React.JSX.Element {
  const del = useDeleteJobs();
  const { toast } = useToast();
  return (
    <SelectControls
      mode={mode}
      count={jobIds.length}
      disabled={empty}
      busy={del.isPending}
      confirmTitle={`Delete ${jobCount(jobIds.length)}?`}
      confirmText="The jobs, their analyses, and their applications with notes and interviews are removed. This cannot be undone. Files of applications you sent stay on disk."
      onDelete={() =>
        del.mutate(jobIds, {
          onSuccess: (r) => {
            mode.stop();
            toast({ title: `Deleted ${jobCount(r.deleted)}` });
          },
          onError: (e) => toast({ title: 'Nothing was deleted', description: e.message, tone: 'bad' }),
        })
      }
    />
  );
}
