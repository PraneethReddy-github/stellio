import { z } from 'zod';

export const BACKUP_KINDS = ['database', 'profile', 'rules'] as const;

export const BackupEntrySchema = z.object({
  /** File name inside `.stellio/backups`; never a path. */
  name: z.string(),
  kind: z.enum(BACKUP_KINDS),
  createdAt: z.string(),
  sizeBytes: z.number().int(),
  /** Only database snapshots can be restored. */
  restorable: z.boolean(),
});
export type BackupEntry = z.infer<typeof BackupEntrySchema>;

/** Database snapshot names: `stellio-YYYY-MM-DD[-HHMMSS-label].db`. */
export const DB_BACKUP_NAME = /^stellio-\d{4}-\d{2}-\d{2}(-[\w-]+)?\.db$/;
