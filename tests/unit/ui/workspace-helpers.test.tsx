// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useElapsedSeconds } from '../../../src/renderer/src/lib/hooks';
import {
  FIT_THRESHOLDS,
  REMOTE_LABEL,
  VERDICT_TONE,
  formatLocation,
  formatSalary,
  humanize,
  isWebUrl,
  isoDay,
  removedCitationsNote,
} from '../../../src/renderer/src/features/workspace/helpers';
import {
  RUN_TONE,
  formatDuration,
  formatTime,
  isFailure,
} from '../../../src/renderer/src/features/activity/helpers';

describe('formatSalary', () => {
  it('formats ranges, one-sided ranges and periods', () => {
    expect(formatSalary(65000, 80000, 'EUR', 'year')).toBe('EUR 65,000–80,000 / year');
    expect(formatSalary(65000, 65000, 'EUR', null)).toBe('EUR 65,000');
    expect(formatSalary(50, null, 'USD', 'hour')).toBe('USD from 50 / hour');
    expect(formatSalary(null, 90000, null, 'year')).toBe('up to 90,000 / year');
  });
  it('is null when nothing is known', () => {
    expect(formatSalary(null, null, 'EUR', 'year')).toBeNull();
  });
});

describe('location, remote, dates, links', () => {
  it('prefers the location text, then the country', () => {
    expect(formatLocation({ locationText: 'Berlin, Germany', country: 'Germany' })).toBe('Berlin, Germany');
    expect(formatLocation({ locationText: ' ', country: 'Germany' })).toBe('Germany');
    expect(formatLocation({ locationText: null, country: null })).toBeNull();
  });
  it('labels remote kinds and hides unknown', () => {
    expect(REMOTE_LABEL.hybrid).toBe('Hybrid');
    expect(REMOTE_LABEL.onsite).toBe('On-site');
    expect(REMOTE_LABEL.unknown).toBeNull();
  });
  it('cuts timestamps to a day and humanizes enums', () => {
    expect(isoDay('2026-11-19T10:00:00.000Z')).toBe('2026-11-19');
    expect(humanize('full_time')).toBe('Full time');
  });
  it('renders only http(s) links', () => {
    expect(isWebUrl('https://example.com/job')).toBe(true);
    expect(isWebUrl('javascript:alert(1)')).toBe(false);
    expect(isWebUrl('file:///etc/passwd')).toBe(false);
    expect(isWebUrl(null)).toBe(false);
  });
});

describe('verdict and run status mapping', () => {
  it('maps verdicts to tones and keeps thresholds ordered', () => {
    expect(VERDICT_TONE).toEqual({ apply: 'ok', stretch: 'warn', skip: 'bad' });
    expect(FIT_THRESHOLDS.ok).toBeGreaterThan(FIT_THRESHOLDS.warn);
  });
  it('treats only real failures as failures', () => {
    expect(isFailure({ status: 'ok' })).toBe(false);
    expect(isFailure({ status: 'running' })).toBe(false);
    expect(isFailure({ status: 'cancelled' })).toBe(false);
    for (const status of ['error', 'timeout', 'invalid_output', 'auth', 'usage_limit', 'bad_model'] as const)
      expect(isFailure({ status })).toBe(true);
    expect(RUN_TONE.usage_limit).toBe('warn');
    expect(RUN_TONE.error).toBe('bad');
  });
  it('formats durations and times', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(4200)).toBe('4.2 s');
    expect(formatDuration(65_000)).toBe('1 m 05 s');
    // local time: build the input from local parts so the test holds in any time zone
    expect(formatTime(new Date(2026, 10, 19, 21, 57, 3).toISOString())).toBe('2026-11-19 21:57:03');
    expect(formatTime('not a date')).toBe('not a date');
  });
});

describe('removedCitationsNote', () => {
  const dropped = (id: string): string => `"Python": dropped unknown evidence id "${id}"`;
  it('counts only dropped citations and pluralizes', () => {
    expect(removedCitationsNote([])).toBeNull();
    expect(removedCitationsNote(['verdict "apply" does not match score 50 (expected "stretch")'])).toBeNull();
    expect(removedCitationsNote([dropped('a')])).toBe(
      '1 cited item was not in your profile and was removed.',
    );
    expect(removedCitationsNote([dropped('a'), dropped('b'), 'other'])).toBe(
      '2 cited items were not in your profile and were removed.',
    );
  });
});

describe('useElapsedSeconds', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('counts whole seconds while running and resets to 0 when stopped', () => {
    const { result, rerender } = renderHook(({ on }) => useElapsedSeconds(on), {
      initialProps: { on: true },
    });
    expect(result.current).toBe(0);
    act(() => void vi.advanceTimersByTime(3200));
    expect(result.current).toBe(3);
    rerender({ on: false });
    expect(result.current).toBe(0);
  });
});
