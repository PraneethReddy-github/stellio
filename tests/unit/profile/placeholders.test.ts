import { describe, expect, it } from 'vitest';
import { parseProfile, profilePlaceholders, validateProfile } from '../../../src/shared/profile';
import { fixture, modelOf, seedTemplate } from './helpers';

describe('profilePlaceholders', () => {
  it('is empty for a real profile', () => {
    expect(profilePlaceholders(modelOf(fixture('full')))).toEqual([]);
  });

  it('flags every example entry of the seed and the empty email, naming the entry', () => {
    const p = profilePlaceholders(modelOf(seedTemplate()));
    expect(p.map((x) => x.message)).toEqual([
      'Your profile still has the example entry "Job Title — Company". Replace it in Profile first.',
      'Your profile still has the example entry "Project Name". Replace it in Profile first.',
      'Your profile still has the example entry "Degree, Field — University". Replace it in Profile first.',
      'Your profile has no email. Add it in Profile first.',
    ]);
  });

  it('catches an -example id or a seed title on its own', () => {
    const md = fixture('full').replace('## Awards', '### Anything {#cert-example}\n- x\n\n## Awards');
    expect(profilePlaceholders(modelOf(md)).map((x) => x.kind)).toEqual(['entry']);
    const t = fixture('full').replace('## Awards', '### Project Name {#p1}\n- x\n\n## Awards');
    expect(profilePlaceholders(modelOf(t)).map((x) => x.kind)).toEqual(['entry']);
  });

  it('diagnostics report placeholders as errors with their own code', () => {
    const d = validateProfile(parseProfile(seedTemplate()).model);
    const ph = d.filter((x) => x.code === 'profile_placeholder');
    expect(ph).toHaveLength(3);
    expect(ph.every((x) => x.severity === 'error')).toBe(true);
  });
});
