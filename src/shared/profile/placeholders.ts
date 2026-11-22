import { ENTRY_SECTIONS, type Profile } from './types';

/** Titles the seed profile ships with; an entry still carrying one was never filled in. */
const SEED_TITLES = new Set(['Job Title — Company', 'Project Name', 'Degree, Field — University']);

export interface ProfilePlaceholder {
  kind: 'entry' | 'email' | 'name';
  /** One sentence, ready to show: names what to replace. */
  message: string;
}

/** Example content that must never reach a resume, cover letter or message. Pure. */
export function profilePlaceholders(model: Profile): ProfilePlaceholder[] {
  const out: ProfilePlaceholder[] = [];
  for (const section of ENTRY_SECTIONS) {
    for (const e of model[section]) {
      if (e.id.endsWith('-example') || SEED_TITLES.has(e.title.trim())) {
        out.push({
          kind: 'entry',
          message: `Your profile still has the example entry "${e.title}". Replace it in Profile first.`,
        });
      }
    }
  }
  if (model.frontMatter.name.trim() === '')
    out.push({ kind: 'name', message: 'Your profile has no name. Add it in Profile first.' });
  if (model.frontMatter.email.trim() === '')
    out.push({ kind: 'email', message: 'Your profile has no email. Add it in Profile first.' });
  return out;
}
