import { describe, expect, it } from 'vitest';
import { SKILL_CATEGORIES } from '../../../src/shared/profile';
import { SKILL_DICTIONARY, findSkills, lookupSkill } from '../../../src/shared/skills';

const names = (text: string): string[] => findSkills(text).map((h) => h.skill.name);

describe('skill dictionary', () => {
  it('has 800–1500 entries, valid categories and no term in two entries', () => {
    expect(SKILL_DICTIONARY.length).toBeGreaterThanOrEqual(800);
    expect(SKILL_DICTIONARY.length).toBeLessThanOrEqual(1500);
    const seen = new Map<string, string>();
    for (const s of SKILL_DICTIONARY) {
      expect(SKILL_CATEGORIES).toContain(s.category);
      for (const t of s.terms) {
        const k = t.toLowerCase();
        expect(seen.get(k), `${t} in ${s.name} and ${String(seen.get(k))}`).toBeUndefined();
        seen.set(k, s.name);
      }
      for (const a of s.ambiguous) expect(s.terms).toContain(a);
    }
  });

  it('looks up names and aliases case-insensitively', () => {
    expect(lookupSkill('postgres')?.name).toBe('PostgreSQL');
    expect(lookupSkill('K8S')?.name).toBe('Kubernetes');
    expect(lookupSkill('Nimbus')).toBeUndefined();
  });
});

describe('findSkills', () => {
  it('finds names and aliases on word boundaries, longest first', () => {
    expect(names('Rewrote SQL pipelines in Rust on Snowflake with Kafka.')).toEqual([
      'SQL',
      'Rust',
      'Snowflake',
      'Apache Kafka',
    ]);
    expect(names('Ran Spring Boot services on k8s and AWS Lambda')).toEqual([
      'Spring Boot',
      'Kubernetes',
      'AWS Lambda',
    ]);
    expect(names('Wrote JavaScript, not Java; C++ and C# but no C here')).toEqual([
      'JavaScript',
      'Java',
      'C++',
      'C#',
      'C',
    ]);
    expect(names('Built an Objective-C app')).toEqual(['Objective-C']);
  });

  it('ambiguous terms need casing, no glue and (for one letter or sentence start) context', () => {
    expect(names('Helped the team go to market faster')).toEqual([]);
    expect(names('Led the Go-to-market launch and R&D budget for the C-suite')).toEqual([]);
    expect(names('Built backend services in Go and Rust')).toEqual(['Go', 'Rust']);
    expect(names('Fitted statistical models in R')).toEqual(['R']);
    expect(names('Met with Plan R stakeholders')).toEqual([]);
    expect(names('Sparked interest; rust removal; swift delivery')).toEqual([]);
    expect(names('Spark the change.')).toEqual([]);
    expect(names('Spark jobs on Databricks.')).toEqual(['Apache Spark', 'Databricks']);
    expect(names('Tuned Spark jobs')).toEqual(['Apache Spark']);
    expect(names('React quickly to incidents')).toEqual([]);
    expect(names('Wrote React components')).toEqual(['React']);
  });
});
