import { StatusDot, type Column } from '../../ui';
import type { ReferralItem } from '../../lib/referrals';
import { STATUS_LABEL, STATUS_TONE } from './helpers';
import s from './referrals.module.css';

const dash = (v: string): React.ReactNode => (v ? v : <span className={s.dim}>–</span>);

export const nameColumn: Column<ReferralItem> = {
  id: 'name',
  header: 'Name',
  width: 'minmax(0, 1.2fr)',
  cell: (r) => <span className={s.strong}>{r.person.fullName}</span>,
};
export const titleColumn: Column<ReferralItem> = {
  id: 'title',
  header: 'Title',
  width: 'minmax(0, 1.4fr)',
  cell: (r) => dash(r.person.title),
};
export const locationColumn: Column<ReferralItem> = {
  id: 'location',
  header: 'Location',
  width: 'minmax(0, 1fr)',
  cell: (r) => dash(r.person.locationText),
};
export const statusColumn: Column<ReferralItem> = {
  id: 'status',
  header: 'Status',
  width: '140px',
  cell: (r) => <StatusDot tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</StatusDot>,
};

/** The job tab: who they are, why them, how much you share. */
export const jobColumns: Column<ReferralItem>[] = [
  nameColumn,
  titleColumn,
  locationColumn,
  { id: 'why', header: 'Why', width: 'minmax(0, 2fr)', cell: (r) => dash(r.why) },
  {
    id: 'shared',
    header: 'Shared',
    width: '72px',
    align: 'right',
    mono: true,
    cell: (r) => String(r.person.sharedGround.length),
  },
  statusColumn,
];
