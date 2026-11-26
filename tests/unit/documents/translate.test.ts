import { describe, expect, it } from 'vitest';
import {
  checkTranslation,
  coverTexts,
  resumeTexts,
  withCoverTexts,
  withResumeTexts,
} from '../../../src/shared/documents';
import { goodCover } from '../../fixtures/cover';
import { fullContent } from '../../fixtures/resume';

const pair = (source: string, target: string) => checkTranslation([{ key: 'k', source, target }]);
const kinds = (source: string, target: string) => pair(source, target).map((v) => `${v.kind}:${v.text}`);

describe('resumeTexts / withResumeTexts', () => {
  it('lists the summary and every bullet by key, and puts translations back without touching ids', () => {
    const items = resumeTexts(fullContent);
    expect(items[0]).toEqual({ key: 'summary', text: fullContent.summary });
    expect(items.map((i) => i.key)).toContain('experience[1].bullets[1]');
    const de = withResumeTexts(fullContent, new Map(items.map((i) => [i.key, `DE ${i.text}`])));
    expect(de.summary).toBe(`DE ${fullContent.summary ?? ''}`);
    expect(de.experience.map((e) => e.entry_id)).toEqual(fullContent.experience.map((e) => e.entry_id));
    expect(de.experience[1]?.bullets[0]?.source_ids).toEqual(
      fullContent.experience[1]?.bullets[0]?.source_ids,
    );
    expect(de.skills).toEqual(fullContent.skills);
    expect(fullContent.summary?.startsWith('DE ')).toBe(false); // the source is not changed
  });

  it('a key the model left out keeps the English text', () => {
    expect(withResumeTexts(fullContent, new Map()).experience).toEqual(fullContent.experience);
  });
});

describe('coverTexts / withCoverTexts', () => {
  it('round-trips paragraphs and keeps a null salutation null', () => {
    const items = coverTexts(goodCover);
    expect(items.map((i) => i.key)).toEqual([
      'paragraphs[0]',
      'paragraphs[1]',
      'paragraphs[2]',
      'paragraphs[3]',
    ]);
    const de = withCoverTexts(goodCover, new Map([['paragraphs[1]', 'Bei Globex …']]));
    expect(de.salutation).toBeNull();
    expect(de.paragraphs[1]).toEqual({ text: 'Bei Globex …', source_ids: ['exp-globex'] });
  });
});

describe('checkTranslation', () => {
  it('accepts the same numbers in German notation', () => {
    expect(
      pair('Cut runtime from 2 h to 10 min for 6 teams.', 'Laufzeit von 2 h auf 10 min für 6 Teams gesenkt.'),
    ).toEqual([]);
    expect(pair('A CGPA of 8.01 over 1,200 records.', 'Note 8,01 über 1.200 Datensätze.')).toEqual([]);
    expect(pair('Ran 4G/5G simulators.', 'Betrieb von 4G/5G-Simulatoren.')).toEqual([]);
  });

  it('flags a number the English text does not have', () => {
    expect(kinds('Cut runtime for six teams.', 'Laufzeit für 7 Teams gesenkt.')).toEqual([
      'number_not_in_source:7',
    ]);
  });

  it('flags an acronym or CamelCase term the English text does not have', () => {
    expect(kinds('Built AI agents in Go.', 'KI-Agenten in Go entwickelt.')).toEqual([
      'term_not_in_source:KI',
    ]);
    expect(kinds('Built pipelines.', 'Pipelines mit PostgreSQL gebaut.')).toEqual([
      'term_not_in_source:PostgreSQL',
    ]);
  });

  it('ordinary German nouns and compounds of English terms are fine', () => {
    expect(
      pair(
        'Ran Docker containers and CI/CD pipelines on Kubernetes.',
        'Docker-Container und CI/CD-Pipelines auf Kubernetes betrieben.',
      ),
    ).toEqual([]);
    expect(pair('Wrote the e-mail service.', 'E-Mail-Dienst geschrieben.')).toEqual([]);
  });
});

describe('texToText decodes the letter commands escapeLatex writes', () => {
  it('round-trips German and Central European names', async () => {
    const { escapeLatex } = await import('../../../src/shared/latex/template');
    const { texToText } = await import('../../../src/shared/documents');
    const s = 'Mit freundlichen Grüßen, Dvořák, Łódź, Kőbánya, Ðorđe, ÿ, Œuvre';
    expect(texToText(escapeLatex(s))).toBe(s);
  });
});

describe('checkTranslation: organisations (review finding)', () => {
  it('flags a company the English text does not name, after "bei" or before a legal suffix', () => {
    expect(kinds('Built dashboards.', 'Dashboards bei Siemens gebaut.')).toEqual([
      'unknown_organisation:Siemens',
    ]);
    expect(kinds('Built dashboards.', 'Dashboards für die Bosch GmbH gebaut.')).toEqual([
      'unknown_organisation:Bosch',
      'term_not_in_source:GmbH',
    ]);
    expect(pair('Built dashboards at Globex.', 'Bei Globex Dashboards gebaut.')).toEqual([]);
    expect(
      pair('Built dashboards for the team.', 'Dashboards für das Team gebaut, bei der Planung geholfen.'),
    ).toEqual([]);
  });
});
