import type { Jd } from '../jobs/schemas';
import { canonicalSkillKey, matchesSkill, type Profile } from '../profile';
import type { ResumeRules } from '../rules';
import { sectionOf } from './lint';
import type { AtsReport, KeywordHit } from './schemas';
import { hasTerm } from './text';
import { readResume } from './texread';

export const MAX_PDF_BYTES = 1024 * 1024;

const DATE_RE: Record<ResumeRules['date_format'], RegExp> = {
  'MMM YYYY': /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}$/,
  'MMMM YYYY':
    /^(January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$/,
  'MM/YYYY': /^(0[1-9]|1[0-2])\/\d{4}$/,
  'YYYY-MM': /^\d{4}-(0[1-9]|1[0-2])$/,
};

export interface AtsInput {
  tex: string;
  jd: Jd | null;
  profile: Profile;
  rules: Pick<ResumeRules, 'date_format'>;
  /** Text layer of the compiled PDF; when given it is matched instead of the text read from the tex. */
  pdfText?: string;
  pdfBytes?: number;
}

/**
 * ATS check (docs/06 §5): alias-aware coverage of the JD's required and preferred skills over the resume text
 * (the PDF text layer when compiled), score = weighted coverage with required ×2, plus format checks. Pure.
 */
export function checkAts(input: AtsInput): AtsReport {
  const doc = readResume(input.tex);
  const text = (input.pdfText ?? doc.text).normalize('NFKC');

  const terms = new Map<string, { term: string; required: boolean }>();
  for (const r of input.jd?.requirements ?? [])
    for (const term of r.skills) {
      const key = canonicalSkillKey(term);
      if (key === '') continue;
      const prev = terms.get(key);
      terms.set(key, {
        term: prev?.term ?? term.trim(),
        required: (prev?.required ?? false) || r.kind === 'required',
      });
    }
  const hit = (term: string): KeywordHit => {
    const row = input.profile.skills.find((s) => matchesSkill(s, term));
    const names = row ? [term, row.skill, ...row.aliases] : [term];
    return { term, found: names.some((n) => hasTerm(text, n)), youHave: row?.status === 'have' };
  };
  const all = [...terms.values()];
  const required = all.filter((t) => t.required).map((t) => hit(t.term));
  const preferred = all.filter((t) => !t.required).map((t) => hit(t.term));
  const weight = 2 * required.length + preferred.length;
  const got = 2 * required.filter((h) => h.found).length + preferred.filter((h) => h.found).length;
  const score = weight === 0 ? 100 : Math.round((100 * got) / weight);

  const body = doc.body;
  const format: AtsReport['format'] = [];
  const check = (name: string, ok: boolean, good: string, bad: string): void => {
    format.push({ check: name, ok, detail: ok ? good : bad });
  };
  check(
    'single_column',
    !/\\begin\{(multicols|minipage|paracol)\}|\\twocolumn/.test(body),
    'Single column',
    'Uses multiple columns or minipages; many ATS parsers read them out of order',
  );
  const odd = doc.sections.map((s) => s.heading).filter((h) => h !== '' && !sectionOf(h));
  check(
    'standard_headings',
    odd.length === 0,
    'Standard section headings',
    `Non-standard headings: ${odd.join(', ')}`,
  );
  check(
    'no_images',
    !/\\includegraphics|\\begin\{(tikzpicture|picture)\}/.test(body),
    'No images',
    'Contains images or drawings',
  );
  check(
    'no_layout_tables',
    !/\\begin\{(tabular|tabularx|table|longtable)\}/.test(body),
    'No tables in the body',
    'Uses tables for layout in the body',
  );
  check(
    'no_header_footer',
    !/\\fancyhead|\\fancyfoot|\\pagestyle\{fancy\}/.test(input.tex),
    'No text in page headers or footers',
    'Puts text in page headers or footers',
  );
  check(
    'unicode_text_layer',
    /\\pdfgentounicode\s*=\s*1/.test(doc.preamble),
    'Sets \\pdfgentounicode=1 for pdfLaTeX',
    'Missing \\pdfgentounicode=1: pdfLaTeX text may not extract cleanly',
  );
  check(
    'no_icons',
    !/fontawesome|\\fa[A-Z]/.test(input.tex),
    'No icon fonts',
    'Uses icon fonts; icons are not readable text',
  );
  const dates = doc.sections
    .flatMap((s) => s.entries.map((e) => e.dates))
    .flatMap((d) => d.split(/\s*[–—]\s*|\s+-\s+/))
    .map((d) => d.trim())
    .filter((d) => d !== '');
  const badDates = dates.filter(
    (d) => !DATE_RE[input.rules.date_format].test(d) && d !== 'Present' && !/^\d{4}$/.test(d),
  );
  check(
    'date_format',
    badDates.length === 0,
    `Dates use ${input.rules.date_format}`,
    `Dates not in ${input.rules.date_format}: ${badDates.slice(0, 5).join(', ')}`,
  );
  if (input.pdfText !== undefined)
    check(
      'selectable_text',
      input.pdfText.trim().length > 0,
      'PDF text is selectable',
      'The PDF has no text layer',
    );
  if (input.pdfBytes !== undefined)
    check(
      'file_size',
      input.pdfBytes < MAX_PDF_BYTES,
      'PDF is under 1 MB',
      `PDF is ${(input.pdfBytes / 1024 / 1024).toFixed(1)} MB; keep it under 1 MB`,
    );

  return { score, required, preferred, format };
}
