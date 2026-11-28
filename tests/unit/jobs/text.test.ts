import { describe, expect, it } from 'vitest';
import { looksCutOff } from '../../../src/shared/jobs/text';

describe('looksCutOff', () => {
  const long = 'Build data pipelines in Python and SQL. '.repeat(20).trim();
  it('flags a trailing ellipsis or a very short text', () => {
    expect(looksCutOff(`${long} and more…`)).toBe(true);
    expect(looksCutOff(`${long} and more...`)).toBe(true);
    expect(looksCutOff(`${long}…  \n`)).toBe(true);
    expect(looksCutOff('Data Engineer, Berlin. Python, SQL.')).toBe(true);
  });
  it('leaves a full posting alone, also one with an ellipsis inside', () => {
    expect(looksCutOff(long)).toBe(false);
    expect(looksCutOff(`Tools… Python, dbt. ${long}`)).toBe(false);
  });
});
