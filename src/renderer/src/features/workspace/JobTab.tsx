import { useState } from 'react';
import { Button, CodeEditor, KeyValue, SectionHeader, Tag, type KeyValueItem } from '../../ui';
import type { JobGet } from '../../lib/jobs';
import { formatSalary, humanize, isoDay } from './helpers';
import s from './workspace.module.css';

type Job = JobGet['job'];

export function JobTab({ job }: { job: Job }): React.JSX.Element {
  const [raw, setRaw] = useState(false);
  const jd = job.structured;

  const details: KeyValueItem[] = [];
  const salary = formatSalary(job.salaryMin, job.salaryMax, job.salaryCurrency, job.salaryPeriod);
  if (salary) details.push({ key: 'Salary', value: salary, mono: true });
  if (job.deadlineAt) details.push({ key: 'Deadline', value: isoDay(job.deadlineAt), mono: true });
  if (job.employmentType) details.push({ key: 'Employment', value: humanize(job.employmentType) });
  if (job.seniority) details.push({ key: 'Seniority', value: humanize(job.seniority) });
  if (job.language) details.push({ key: 'Language', value: job.language, mono: true });

  const required = jd?.requirements.filter((r) => r.kind === 'required') ?? [];
  const preferred = jd?.requirements.filter((r) => r.kind === 'preferred') ?? [];

  return (
    <div className={s.jobTab}>
      <div className={s.toggleRow}>
        <Button size="sm" variant="ghost" aria-pressed={raw} onClick={() => setRaw(!raw)}>
          {raw ? 'Structured view' : 'Raw text'}
        </Button>
      </div>
      {raw || !jd ? (
        <div className={s.stack}>
          {!jd && (
            <p className={s.note}>This job has no structured data yet. The posting text is shown as saved.</p>
          )}
          <CodeEditor
            language="markdown"
            readOnly
            ariaLabel="Job description text"
            value={job.descriptionMd}
            height={520}
          />
        </div>
      ) : (
        <div className={s.stack}>
          {details.length > 0 && <KeyValue items={details} />}
          <Requirements title="Required" items={required} />
          <Requirements title="Preferred" items={preferred} />
          <List title="Responsibilities" items={jd.responsibilities} />
          {jd.about && (
            <section className={s.block}>
              <SectionHeader title="About" level={3} />
              <p className={s.prose}>{jd.about}</p>
            </section>
          )}
          <List title="Benefits" items={jd.benefits} />
        </div>
      )}
    </div>
  );
}

type Req = NonNullable<Job['structured']>['requirements'];

function Requirements({ title, items }: { title: string; items: Req }): React.JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <section className={s.block} aria-label={`${title} requirements`}>
      <SectionHeader title={`${title} (${String(items.length)})`} level={3} />
      <ul className={s.list}>
        {items.map((r, i) => (
          <li key={`${String(i)}-${r.text}`} className={s.item}>
            <span>{r.text}</span>
            {r.skills.length > 0 && (
              <span className={s.tags}>
                {r.skills.map((k) => (
                  <Tag key={k}>{k}</Tag>
                ))}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function List({ title, items }: { title: string; items: readonly string[] }): React.JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <section className={s.block}>
      <SectionHeader title={title} level={3} />
      <ul className={s.list}>
        {items.map((t, i) => (
          <li key={`${String(i)}-${t}`} className={s.item}>
            {t}
          </li>
        ))}
      </ul>
    </section>
  );
}
