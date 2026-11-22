// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { diffLines, parseUnifiedDiff, toRows } from '../../../src/renderer/src/ui/diff';
import { DiffView } from '../../../src/renderer/src/ui/DiffView';

afterEach(cleanup);

const GIT = `diff --git a/profile.md b/profile.md
index 1111111..2222222 100644
--- a/profile.md
+++ b/profile.md
@@ -1,4 +1,5 @@
 # Sample Person
-Headline: Data Analyst
+Headline: Data Engineer
+Location: Berlin
 ## Summary
 Builds pipelines.
\\ No newline at end of file
@@ -20,2 +21,2 @@ ## Skills
 SQL
-- dbt
+dbt
`;

describe('parseUnifiedDiff', () => {
  it('skips file headers and numbers lines per side', () => {
    const hunks = parseUnifiedDiff(GIT);
    expect(hunks.map((h) => h.header)).toEqual(['@@ -1,4 +1,5 @@', '@@ -20,2 +21,2 @@ ## Skills']);
    expect(hunks[0]?.lines).toEqual([
      { kind: 'ctx', text: '# Sample Person', oldNo: 1, newNo: 1 },
      { kind: 'del', text: 'Headline: Data Analyst', oldNo: 2 },
      { kind: 'add', text: 'Headline: Data Engineer', newNo: 2 },
      { kind: 'add', text: 'Location: Berlin', newNo: 3 },
      { kind: 'ctx', text: '## Summary', oldNo: 3, newNo: 4 },
      { kind: 'ctx', text: 'Builds pipelines.', oldNo: 4, newNo: 5 },
    ]);
  });

  it('keeps a removed line that starts with dashes as content, not a header', () => {
    const del = parseUnifiedDiff(GIT)[1]?.lines[1];
    expect(del).toEqual({ kind: 'del', text: '- dbt', oldNo: 21 });
  });

  it('returns nothing for text with no hunks', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('diff --git a/x b/x\nBinary files differ\n')).toEqual([]);
  });
});

describe('toRows', () => {
  it('pairs removed with added lines side by side', () => {
    const rows = toRows(parseUnifiedDiff(GIT)[0] ?? { header: '', lines: [] });
    expect(rows).toHaveLength(5);
    expect(rows[1]?.left?.text).toBe('Headline: Data Analyst');
    expect(rows[1]?.right?.text).toBe('Headline: Data Engineer');
    expect(rows[2]?.left).toBeUndefined();
    expect(rows[2]?.right?.text).toBe('Location: Berlin');
  });
});

describe('diffLines', () => {
  it('is empty for equal text', () => {
    expect(diffLines('a\nb', 'a\nb')).toEqual([]);
  });

  it('finds inserted, removed and changed lines with context and hunk header', () => {
    const hunks = diffLines('a\nb\nc\nd', 'a\nB\nc\nd\ne');
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.header).toBe('@@ -1,4 +1,5 @@');
    expect(hunks[0]?.lines.map((l) => `${l.kind}:${l.text}`)).toEqual([
      'ctx:a',
      'del:b',
      'add:B',
      'ctx:c',
      'ctx:d',
      'add:e',
    ]);
    expect(hunks[0]?.lines[5]).toMatchObject({ newNo: 5 });
  });

  it('splits distant changes into separate hunks', () => {
    const a = Array.from({ length: 20 }, (_, i) => `l${String(i)}`);
    const b = a.slice();
    b[1] = 'X';
    b[18] = 'Y';
    expect(diffLines(a.join('\n'), b.join('\n'))).toHaveLength(2);
  });

  it('handles empty sides', () => {
    expect(diffLines('', 'x\ny')[0]?.lines.map((l) => l.kind)).toEqual(['add', 'add']);
    expect(diffLines('x', '')[0]?.lines.map((l) => l.kind)).toEqual(['del']);
  });
});

describe('DiffView', () => {
  it('renders git text with hunk labels and screen-reader markers', () => {
    render(<DiffView diff={GIT} />);
    expect(screen.getByRole('table', { name: 'Changes' })).toBeTruthy();
    expect(screen.getByText('@@ -1,4 +1,5 @@')).toBeTruthy();
    expect(screen.getByText('Headline: Data Engineer').textContent).toContain('added:');
  });

  it('labels the two columns when asked', () => {
    render(<DiffView diff={GIT} leftLabel="Before" rightLabel="After" />);
    expect(screen.getByRole('columnheader', { name: 'Before' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'After' })).toBeTruthy();
  });

  it('says so when there is nothing to show', () => {
    render(<DiffView diff={diffLines('a', 'a')} />);
    expect(screen.getByText('No changes.')).toBeTruthy();
  });
});
