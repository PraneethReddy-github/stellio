// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RULES_AND_TEMPLATE_FILES } from '@shared/rules';
import { CompilePanel, type CompileState } from '@renderer/features/rules/CompilePanel';
import { Diagnostics } from '@renderer/features/rules/Diagnostics';
import {
  durationLabel,
  effectNote,
  fileName,
  languageOf,
  pagesLabel,
  saveMessage,
  sortByLine,
} from '@renderer/features/rules/helpers';
import { base64ToBytes, formatProgress, progressValue } from '@renderer/lib/latex';
import { diagnose } from '@renderer/lib/rules';

afterEach(cleanup);

describe('rules helpers', () => {
  it('names files and commit messages', () => {
    expect(fileName('rules/resume.md')).toBe('resume.md');
    expect(saveMessage('templates/cover-letter.tex')).toBe('rules: edit cover-letter.tex');
    expect(languageOf('templates/resume.tex')).toBe('latex');
    expect(languageOf('rules/skills-policy.md')).toBe('markdown');
  });

  it('has a one-line effect note for every file', () => {
    for (const f of RULES_AND_TEMPLATE_FILES) expect(effectNote(f)).toMatch(/^Stellio .+\.$/);
    expect(effectNote('rules/resume.md')).toBe('Stellio reads this file every time it drafts a resume.');
  });

  it('sorts errors first, then by line, unlocated last', () => {
    const d = (severity: 'error' | 'warning', line: number | null) => ({
      severity,
      code: 'x',
      message: 'm',
      line,
    });
    expect(
      sortByLine([d('warning', 1), d('error', null), d('error', 9), d('error', 2)]).map((x) => [
        x.severity,
        x.line,
      ]),
    ).toEqual([
      ['error', 2],
      ['error', 9],
      ['error', null],
      ['warning', 1],
    ]);
  });

  it('formats pages and durations', () => {
    expect(pagesLabel(1)).toBe('1 page');
    expect(pagesLabel(2)).toBe('2 pages');
    expect(pagesLabel(null)).toBe('–');
    expect(durationLabel(1234)).toBe('1.2 s');
  });

  it('diagnoses rules front matter and template slots like the main process', () => {
    expect(diagnose('rules/resume.md', '---\npage_limit: 9\n---\n').some((d) => d.severity === 'error')).toBe(
      true,
    );
    const tpl = diagnose('templates/resume.tex', '%% STELLIO:END stray\n');
    expect(tpl.map((d) => d.code)).toContain('slot_end_without_start');
  });
});

describe('latex helpers', () => {
  it('decodes base64 to bytes', () => {
    expect(Array.from(base64ToBytes(btoa('%PDF-')))).toEqual([37, 80, 68, 70, 45]);
  });
  it('describes install progress', () => {
    expect(formatProgress({ phase: 'download', received: 3_200_000, total: 10_000_000 })).toBe(
      'downloading 3.2 of 10.0 MB',
    );
    expect(formatProgress({ phase: 'download', received: 1_000_000, total: null })).toBe(
      'downloading 1.0 MB',
    );
    expect(formatProgress({ phase: 'verify', received: 1, total: 1 })).toBe('verifying checksum');
    expect(progressValue({ phase: 'download', received: 5, total: 10 })).toBe(0.5);
    expect(progressValue({ phase: 'download', received: 5, total: null })).toBeUndefined();
    expect(progressValue({ phase: 'extract', received: 10, total: 10 })).toBeUndefined();
  });
});

describe('Diagnostics', () => {
  it('lists problems and jumps to a line', () => {
    const onJump = vi.fn();
    render(
      <Diagnostics
        onJump={onJump}
        diagnostics={[
          { severity: 'error', code: 'a', message: 'Bad value', line: 4 },
          { severity: 'warning', code: 'b', message: 'Unknown key', line: null },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Bad value/ }));
    expect(onJump).toHaveBeenCalledWith(4);
    expect(screen.getByText('Unknown key').closest('button')).toBeNull(); // no line, no button
  });
  it('says so when there is nothing to report', () => {
    render(<Diagnostics onJump={() => undefined} diagnostics={[]} />);
    expect(screen.getByText('No problems found.')).toBeTruthy();
  });
});

describe('CompilePanel', () => {
  const idle: CompileState = { result: null, text: '', pending: false, error: null };
  const result = (over: Partial<NonNullable<CompileState['result']>> = {}): CompileState => ({
    ...idle,
    text: 'a',
    result: {
      ok: false,
      pages: null,
      errors: [{ line: 20, message: 'Undefined control sequence' }, { message: 'Emergency stop' }],
      warnings: [{ kind: 'overfull', message: 'Overfull \\hbox (3pt too wide)' }],
      cacheMissing: false,
      durationMs: 900,
      ...over,
    },
  });
  const props = {
    status: {
      engine: { kind: 'tectonic' as const, path: '/t', version: '0.17.0' },
      cacheWarm: true,
      installSupported: true,
    },
    current: 'a',
    warming: false,
    onWarm: () => undefined,
    onJump: () => undefined,
  };

  it('lists line-numbered errors that jump, and warnings', () => {
    const onJump = vi.fn();
    render(<CompilePanel {...props} onJump={onJump} state={result()} />);
    expect(screen.getByText('Failed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Undefined control sequence/ }));
    expect(onJump).toHaveBeenCalledWith(20);
    expect(screen.getByText('Emergency stop').closest('button')).toBeNull();
    expect(screen.getByText(/too wide/)).toBeTruthy();
    expect(screen.getByText('0.9 s')).toBeTruthy();
  });

  it('says when the draft moved on since the compile', () => {
    render(<CompilePanel {...props} current="b" state={result()} />);
    expect(screen.getByText(/Edited since this compile/)).toBeTruthy();
  });

  it('offers the package download when the cache is missing', () => {
    const onWarm = vi.fn();
    render(<CompilePanel {...props} onWarm={onWarm} state={result({ cacheMissing: true, errors: [] })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download LaTeX packages' }));
    expect(onWarm).toHaveBeenCalled();
  });

  it('explains idle and pending states', () => {
    const { rerender } = render(<CompilePanel {...props} state={idle} />);
    expect(screen.getByText(/Nothing is saved/)).toBeTruthy();
    rerender(<CompilePanel {...props} state={{ ...idle, pending: true }} />);
    expect(screen.getByText(/Compiling the template/)).toBeTruthy();
  });
});
