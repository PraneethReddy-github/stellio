import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ATS_API_HOSTS,
  AtsNotFoundError,
  detectAts,
  parseAtsResponse,
  unescapeEntities,
} from '../../../src/main/services/jobs/ats';
import { fragmentToMarkdown } from '../../../src/main/services/jobs/html';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve('tests/fixtures/ats', `${name}.json`), 'utf8')) as unknown;

describe('detectAts', () => {
  it.each([
    [
      'https://boards.greenhouse.io/larkspur/jobs/4400012',
      'greenhouse',
      'larkspur',
      '4400012',
      'boards-api.greenhouse.io',
    ],
    [
      'https://job-boards.greenhouse.io/larkspur/jobs/4400012?gh_src=x',
      'greenhouse',
      'larkspur',
      '4400012',
      'boards-api.greenhouse.io',
    ],
    [
      'https://jobs.lever.co/marigold/5f3e0f6a-1b2c-4d3e-8f90-123456789abc',
      'lever',
      'marigold',
      '5f3e0f6a-1b2c-4d3e-8f90-123456789abc',
      'api.lever.co',
    ],
    [
      'https://jobs.eu.lever.co/marigold/5f3e0f6a-1b2c-4d3e-8f90-123456789abc/apply',
      'lever',
      'marigold',
      '5f3e0f6a-1b2c-4d3e-8f90-123456789abc',
      'api.eu.lever.co',
    ],
    [
      'https://jobs.ashbyhq.com/heron/11111111-2222-4333-8444-555555555555',
      'ashby',
      'heron',
      '11111111-2222-4333-8444-555555555555',
      'api.ashbyhq.com',
    ],
    [
      'https://jobs.smartrecruiters.com/TannenWerke/743999912345678-process-engineer',
      'smartrecruiters',
      'TannenWerke',
      '743999912345678',
      'api.smartrecruiters.com',
    ],
    [
      'https://apply.workable.com/wavecrest/j/ABC123DEF4/',
      'workable',
      'wavecrest',
      'ABC123DEF4',
      'apply.workable.com',
    ],
  ])('%s', (url, kind, company, id, apiHost) => {
    const ref = detectAts(url);
    expect(ref).toMatchObject({ kind, company, id, apiHost });
    expect(new URL(ref?.apiUrl ?? '').hostname).toBe(apiHost);
    expect(ATS_API_HOSTS).toContain(apiHost);
  });

  it('builds the documented API URLs', () => {
    expect(detectAts('https://boards.greenhouse.io/larkspur/jobs/4400012')?.apiUrl).toBe(
      'https://boards-api.greenhouse.io/v1/boards/larkspur/jobs/4400012?pay_transparency=true',
    );
    expect(detectAts('https://jobs.lever.co/marigold/5f3e0f6a-1b2c-4d3e-8f90-123456789abc')?.apiUrl).toBe(
      'https://api.lever.co/v0/postings/marigold/5f3e0f6a-1b2c-4d3e-8f90-123456789abc',
    );
    expect(detectAts('https://jobs.ashbyhq.com/heron/11111111-2222-4333-8444-555555555555')?.apiUrl).toBe(
      'https://api.ashbyhq.com/posting-api/job-board/heron?includeCompensation=true',
    );
    expect(detectAts('https://jobs.smartrecruiters.com/TannenWerke/743999912345678-x')?.apiUrl).toBe(
      'https://api.smartrecruiters.com/v1/companies/TannenWerke/postings/743999912345678',
    );
    expect(detectAts('https://apply.workable.com/wavecrest/j/ABC123DEF4/')?.apiUrl).toBe(
      'https://apply.workable.com/api/v1/widget/accounts/wavecrest?details=true',
    );
  });

  it.each([
    'https://example.com/jobs/4400012',
    'https://boards.greenhouse.io/larkspur', // board, not a posting
    'https://boards.greenhouse.io/larkspur/jobs/notanumber',
    'https://boards.greenhouse.io/lar%2fkspur/jobs/1',
    'https://jobs.lever.co/marigold/not-a-uuid',
    'https://evil.example/boards.greenhouse.io/larkspur/jobs/1',
    'https://boards.greenhouse.io.evil.example/larkspur/jobs/1',
    'https://jobs.smartrecruiters.com/TannenWerke/short',
    'ftp://boards.greenhouse.io/larkspur/jobs/4400012',
    'not a url',
  ])('rejects %s', (url) => {
    expect(detectAts(url)).toBeNull();
  });
});

describe('adapters', () => {
  const ref = (url: string) => {
    const r = detectAts(url);
    if (!r) throw new Error(`not detected: ${url}`);
    return r;
  };

  it('greenhouse: decodes escaped HTML, pay and dates', () => {
    const j = parseAtsResponse(
      ref('https://boards.greenhouse.io/larkspur/jobs/4400012'),
      fixture('greenhouse'),
    );
    expect(j).toMatchObject({
      title: 'Data Platform Engineer',
      company: 'Larkspur Freight',
      location: 'Berlin, Germany',
      salaryText: '65000-80000 EUR',
      postedAt: '2026-10-20T09:00:00.000Z',
      deadline: '2026-12-15',
    });
    expect(j.descriptionHtml).toContain('<h3>What you will do</h3>');
    expect(fragmentToMarkdown(j.descriptionHtml)).toContain('equal opportunity employer & value diversity');
  });

  it('lever: joins description, lists and additional; maps workplace and salary', () => {
    const j = parseAtsResponse(
      ref('https://jobs.lever.co/marigold/5f3e0f6a-1b2c-4d3e-8f90-123456789abc'),
      fixture('lever'),
    );
    expect(j).toMatchObject({
      title: 'Backend Engineer, Payments',
      company: null,
      remote: 'hybrid',
      location: 'Amsterdam; Remote - Netherlands',
      salaryText: '70000-90000 EUR per year',
      applyUrl: expect.stringContaining('/apply') as string,
    });
    const md = fragmentToMarkdown(j.descriptionHtml);
    expect(md).toContain('What you will do');
    expect(md).toContain('Design and operate Go services');
    expect(md).toContain('28 days of vacation');
    expect(j.postedAt).toBe(new Date(1760000000000).toISOString());
  });

  it('ashby: picks the posting by id and reads compensation', () => {
    const j = parseAtsResponse(
      ref('https://jobs.ashbyhq.com/heron/11111111-2222-4333-8444-555555555555'),
      fixture('ashby'),
    );
    expect(j).toMatchObject({
      title: 'Staff Software Engineer',
      remote: 'remote',
      salaryText: 'EUR 120K - 150K per year',
    });
    expect(j.descriptionHtml).toContain('Rust or C++');
    expect(() =>
      parseAtsResponse(
        ref('https://jobs.ashbyhq.com/heron/00000000-2222-4333-8444-555555555555'),
        fixture('ashby'),
      ),
    ).toThrow(AtsNotFoundError);
  });

  it('smartrecruiters: concatenates sections', () => {
    const j = parseAtsResponse(
      ref('https://jobs.smartrecruiters.com/TannenWerke/743999912345678-process-engineer'),
      fixture('smartrecruiters'),
    );
    expect(j).toMatchObject({
      title: 'Process Engineer',
      company: 'Tannenwerke GmbH',
      remote: 'hybrid',
      location: 'Stuttgart, Baden-Württemberg, DE',
    });
    const md = fragmentToMarkdown(j.descriptionHtml);
    expect(md).toContain('Company Description');
    expect(md).toContain('Degree in mechanical engineering');
  });

  it('workable: picks the posting by shortcode', () => {
    const j = parseAtsResponse(
      ref('https://apply.workable.com/wavecrest/j/ABC123DEF4/'),
      fixture('workable'),
    );
    expect(j).toMatchObject({
      title: 'Customer Success Manager',
      company: 'Wavecrest Software',
      remote: 'remote',
      location: 'Bristol, England, United Kingdom',
    });
    expect(j.descriptionHtml).toContain('Requirements');
    expect(() =>
      parseAtsResponse(ref('https://apply.workable.com/wavecrest/j/MISSING99/'), fixture('workable')),
    ).toThrow(AtsNotFoundError);
  });

  it('rejects responses of the wrong shape', () => {
    expect(() =>
      parseAtsResponse(ref('https://boards.greenhouse.io/larkspur/jobs/1'), { nope: true }),
    ).toThrow();
    expect(() =>
      parseAtsResponse(ref('https://jobs.ashbyhq.com/heron/11111111-2222-4333-8444-555555555555'), {
        jobs: 'x',
      }),
    ).toThrow();
  });
});

describe('unescapeEntities', () => {
  it('only decodes when the text holds no real tags', () => {
    expect(unescapeEntities('&lt;p&gt;a &amp;amp; b&lt;/p&gt;')).toBe('<p>a &amp; b</p>');
    expect(unescapeEntities('<p>a &lt; b</p>')).toBe('<p>a &lt; b</p>');
  });
});
