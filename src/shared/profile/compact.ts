import { ENTRY_SECTIONS, type Profile } from './types';

/** Ids of every entry a claim may cite (experience, projects, education, ...). */
export function profileEntryIds(profile: Profile): Set<string> {
  return new Set(ENTRY_SECTIONS.flatMap((s) => profile[s].map((e) => e.id)));
}

/** Compact plain text of the profile for prompts. Leaves out contact details (email, phone, links). */
export function profileForPrompt(profile: Profile): string {
  const f = profile.frontMatter;
  const p = f.preferences;
  const out: string[] = [];
  const line = (k: string, v: string) => {
    if (v) out.push(`${k}: ${v}`);
  };
  line('headline', f.headline);
  line('location', f.location);
  line('work_authorization', f.work_authorization);
  line('notice_period', f.notice_period);
  line('languages_spoken', f.languages_spoken.map((l) => `${l.language} (${l.level})`).join(', '));
  line('target_roles', p.roles.join(', '));
  line('target_seniority', p.seniority.join(', '));
  line('target_locations', p.locations.join(', '));
  line('remote_preference', p.remote);
  if (p.salary_floor !== null) line('salary_floor', `${String(p.salary_floor)} ${p.currency}`.trim());
  line('industries_avoid', p.industries_avoid.join(', '));
  line('companies_avoid', p.companies_avoid.join(', '));
  if (profile.summary.trim()) out.push('', 'SUMMARY', profile.summary.trim());
  if (profile.skills.length > 0) {
    out.push(
      '',
      'SKILLS (skill | category | level 1-5 | years | last_used | status | evidence ids | aliases)',
    );
    for (const s of profile.skills)
      out.push(
        [
          s.skill,
          s.category,
          s.level ?? '',
          s.years ?? '',
          s.last_used,
          s.status,
          s.evidence.join(','),
          s.aliases.join(','),
        ].join(' | '),
      );
  }
  for (const section of ENTRY_SECTIONS) {
    if (profile[section].length === 0) continue;
    out.push('', section.toUpperCase());
    for (const e of profile[section]) {
      const meta = Object.entries(e.meta)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
      out.push(`[${e.id}] ${e.title}${meta ? ` (${meta})` : ''}`);
      for (const b of e.bullets) out.push(`- ${b}`);
    }
  }
  if (profile.notes.trim()) out.push('', 'NOTES (context for you; never quote)', profile.notes.trim());
  return out.join('\n');
}
