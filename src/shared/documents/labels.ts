import type { DocLanguage } from './schemas';

/** Words the renderers print themselves (headings, table heads, letter lines), per document language. */
export const RESUME_LABELS: Record<DocLanguage, Record<string, string>> = {
  en: {
    summary: 'Summary',
    education: 'Education',
    experience: 'Experience',
    projects: 'Projects',
    publications: 'Publications',
    patents: 'Patents',
    skills: 'Technical Skills',
    skillsV1: 'Skills',
    certifications: 'Certifications',
    misc: 'Miscellaneous',
    degree: 'Degree',
    institute: 'Institute',
    grade: 'CGPA/Percentage',
    year: 'Year',
    patentNumber: 'Application No.',
    published: 'Published',
    languages: 'Languages',
    updated: 'Last updated',
  },
  de: {
    summary: 'Kurzprofil',
    education: 'Ausbildung',
    experience: 'Berufserfahrung',
    projects: 'Projekte',
    publications: 'Publikationen',
    patents: 'Patente',
    skills: 'Technische Kenntnisse',
    skillsV1: 'Kenntnisse',
    certifications: 'Zertifikate',
    misc: 'Sonstiges',
    degree: 'Abschluss',
    institute: 'Institution',
    grade: 'Note',
    year: 'Jahr',
    patentNumber: 'Anmeldenr.',
    published: 'Veröffentlicht',
    languages: 'Sprachen',
    updated: 'Stand',
  },
};

/** German display names of the fixed skill-line labels (schemas.ts BASE_CATEGORY_LABELS). */
export const CATEGORY_LABELS_DE: Record<string, string> = {
  Languages: 'Programmiersprachen',
  Frameworks: 'Frameworks',
  Libraries: 'Bibliotheken',
  Databases: 'Datenbanken',
  Data: 'Daten',
  Analytics: 'Analytik',
  'Machine Learning': 'Maschinelles Lernen',
  Cloud: 'Cloud',
  DevOps: 'DevOps',
  Platforms: 'Plattformen',
  Tools: 'Werkzeuge',
  Testing: 'Testen',
  Practices: 'Methoden',
  Domain: 'Fachgebiet',
};

/** A skill-line label in the document language: "Cloud & Tools" → "Cloud & Werkzeuge". */
export const categoryLabel = (label: string, lang: DocLanguage): string =>
  lang === 'en'
    ? label
    : label
        .split(' & ')
        .map((p) => CATEGORY_LABELS_DE[p] ?? p)
        .join(' & ');

/** Every heading either language prints, for reading a document back (lint, ATS). */
export const ALL_HEADINGS: Record<string, string> = Object.fromEntries(
  Object.values(RESUME_LABELS).flatMap((l) =>
    ['summary', 'education', 'experience', 'projects', 'publications', 'patents', 'certifications', 'misc']
      .map((k) => [l[k] ?? '', k] as [string, string])
      .concat([
        [l.skills ?? '', 'skills'],
        [l.skillsV1 ?? '', 'skills'],
      ]),
  ),
);
