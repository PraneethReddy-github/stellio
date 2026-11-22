import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

/**
 * Recorded-shape payloads of the job-source APIs (fictional companies), served by a local HTTP server. Shapes were
 * checked against the live APIs on 2026-11-21 (docs/05 §6). No test talks to the real network.
 */
const ats = (name: string): unknown => JSON.parse(readFileSync(resolve('tests/fixtures/ats', name), 'utf8'));
const secondsAgo = (days: number): number => Math.floor(Date.now() / 1000) - days * 86_400;
const isoAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

/** ~60 words, unique per topic: long enough for a SimHash, different enough not to match another topic. */
export const prose = (topic: string): string =>
  `${topic}. You will design, build and operate production systems for ${topic.toLowerCase()} in a small cross functional team. ` +
  `We care about clean interfaces, careful testing and honest communication. Day to day you review code, pair with colleagues, ` +
  `own incidents from alert to retrospective and improve the tooling that ${topic.toLowerCase()} depends on. ` +
  `You bring several years of hands on experience, enjoy explaining trade offs, and want to grow with a company that values ` +
  `learning over heroics. We offer flexible hours, a learning budget and a fair salary for ${topic.toLowerCase()}.`;

export const NIMBUS_DESC = prose('Data pipelines with Python and SQL at Nimbus Analytics');
export const escaped = (html: string): string => html.replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const arbeitnow = (): unknown => ({
  data: [
    {
      slug: 'data-engineer-nimbus-berlin-1',
      company_name: 'Nimbus Analytics GmbH',
      title: 'Data Engineer (m/w/d)',
      description: escaped(`<p>${NIMBUS_DESC}</p>`),
      remote: false,
      url: 'https://www.arbeitnow.com/jobs/companies/nimbus/data-engineer-nimbus-berlin-1',
      tags: ['Data'],
      job_types: ['Full Time'],
      location: 'Berlin',
      created_at: secondsAgo(1),
    },
    {
      slug: 'marketing-manager-berlin-2',
      company_name: 'Bright Media GmbH',
      title: 'Marketing Manager',
      description: escaped(`<p>${prose('Brand campaigns and events')}</p>`),
      remote: false,
      url: 'https://www.arbeitnow.com/jobs/companies/bright/marketing-manager-berlin-2',
      tags: ['Marketing'],
      job_types: [],
      location: 'Berlin',
      created_at: secondsAgo(2),
    },
    {
      slug: 'python-developer-frankfurt-3',
      company_name: 'Rhein Software AG',
      title: 'Senior Python Developer',
      description: escaped(`<p>${prose('Backend services in Python for payments')}</p>`),
      remote: false,
      url: 'https://www.arbeitnow.com/jobs/companies/rhein/python-developer-frankfurt-3',
      tags: ['Engineering'],
      job_types: ['Full Time'],
      location: 'Frankfurt am Main',
      created_at: secondsAgo(3),
    },
    {
      slug: 'old-data-engineer-hamburg-4',
      company_name: 'Elbe Data',
      title: 'Data Engineer',
      description: escaped(`<p>${prose('Warehouse modelling with dbt in Hamburg')}</p>`),
      remote: false,
      url: 'https://www.arbeitnow.com/jobs/companies/elbe/old-data-engineer-hamburg-4',
      tags: ['Data'],
      job_types: [],
      location: 'Hamburg',
      created_at: secondsAgo(90),
    },
  ],
  links: { first: 'x', last: null, prev: null, next: null },
  meta: { current_page: 1 },
});

export const remotive = (): unknown => ({
  '00-warning': 'moved',
  'job-count': 3,
  jobs: [
    {
      id: 7001,
      url: 'https://remotive.com/remote-jobs/software-dev/senior-data-engineer-7001',
      title: 'Senior Data Engineer',
      company_name: 'Orbit Labs',
      category: 'Software Development',
      tags: ['python', 'airflow'],
      job_type: 'full_time',
      publication_date: isoAgo(1).slice(0, 19),
      candidate_required_location: 'Worldwide',
      salary: '$90k - $120k',
      description: `<p>${prose('Streaming ingestion with Kafka for Orbit Labs')}</p>`,
    },
    {
      id: 7002,
      url: 'https://remotive.com/remote-jobs/software-dev/data-engineer-7002',
      title: 'Data Engineer',
      company_name: 'Stateside Inc',
      category: 'Software Development',
      tags: ['sql'],
      job_type: 'full_time',
      publication_date: isoAgo(1).slice(0, 19),
      candidate_required_location: 'USA',
      salary: '',
      description: `<p>${prose('Reporting pipelines for US healthcare clients')}</p>`,
    },
    {
      // the Nimbus posting again, with a different title spelling: found only by the SimHash check
      id: 7003,
      url: 'https://remotive.com/remote-jobs/software-dev/data-engineer-nimbus-7003',
      title: 'Data Engineer',
      company_name: 'Nimbus Analytics',
      category: 'Data',
      tags: [],
      job_type: 'full_time',
      publication_date: isoAgo(1).slice(0, 19),
      candidate_required_location: 'Germany',
      salary: '',
      description: `<p>${NIMBUS_DESC} Apply now.</p>`,
    },
  ],
});

export const remoteok = (): unknown => [
  { last_updated: 1, legal: 'API Terms of Service: link back to Remote OK.' },
  {
    slug: 'remote-data-platform-engineer-lumen-9001',
    id: '9001',
    date: isoAgo(2),
    company: 'Lumen Cloud',
    position: 'Data Platform Engineer',
    tags: ['python', 'aws'],
    description: `<p>${prose('A self service data platform at Lumen Cloud')}</p>`,
    location: 'Worldwide',
    apply_url: 'https://remoteOK.com/remote-jobs/remote-data-platform-engineer-lumen-9001',
    salary_min: 100000,
    salary_max: 140000,
    url: 'https://remoteOK.com/remote-jobs/remote-data-platform-engineer-lumen-9001',
  },
  {
    slug: 'remote-recruiter-9002',
    id: '9002',
    date: isoAgo(2),
    company: 'Talent Hub',
    position: 'Technical Recruiter',
    tags: ['hr'],
    description: `<p>${prose('Sourcing engineers for fast growing startups')}</p>`,
    location: '',
    apply_url: 'https://remoteOK.com/remote-jobs/remote-recruiter-9002',
    salary_min: 0,
    salary_max: 0,
    url: 'https://remoteOK.com/remote-jobs/remote-recruiter-9002',
  },
];

export const himalayas = (): unknown => ({
  updatedAt: 1,
  offset: 0,
  limit: 20,
  totalCount: 2,
  jobs: [
    {
      title: 'Analytics Engineer',
      excerpt: 'Short',
      companyName: 'Fjord Metrics',
      companySlug: 'fjord-metrics',
      employmentType: 'Full Time',
      minSalary: 70000,
      maxSalary: 90000,
      salaryPeriod: 'annual',
      currency: 'EUR',
      seniority: ['Mid'],
      locationRestrictions: ['Germany', 'Netherlands'],
      categories: ['Data-Analyst'],
      description: `<p>${prose('Metrics modelling with dbt for Fjord Metrics')}</p>`,
      pubDate: secondsAgo(1),
      applicationLink: 'https://himalayas.app/companies/fjord-metrics/jobs/analytics-engineer',
      guid: 'https://himalayas.app/companies/fjord-metrics/jobs/analytics-engineer',
    },
    {
      title: 'Data Engineer',
      excerpt: 'Short',
      companyName: 'Pacific Data',
      companySlug: 'pacific-data',
      employmentType: 'Contractor',
      minSalary: null,
      maxSalary: null,
      salaryPeriod: 'annual',
      currency: 'USD',
      seniority: ['Senior'],
      locationRestrictions: ['Australia'],
      categories: ['Data-Engineer'],
      description: `<p>${prose('Batch jobs on Spark for Pacific Data')}</p>`,
      pubDate: secondsAgo(1),
      applicationLink: 'https://himalayas.app/companies/pacific-data/jobs/data-engineer',
      guid: 'https://himalayas.app/companies/pacific-data/jobs/data-engineer',
    },
  ],
});

export const BA_REFS = ['10001-DE1-S', '10002-DE2-S'];
export const baList = (): unknown => ({
  maxErgebnisse: 2,
  page: 1,
  size: 50,
  ergebnisliste: [
    {
      stellenangebotsTitel: 'Data Engineer (m/w/d)',
      firma: 'Spree Daten GmbH',
      referenznummer: BA_REFS[0],
      stellenlokationen: [{ adresse: { ort: 'Berlin', land: 'DEUTSCHLAND' } }],
      datumErsteVeroeffentlichung: isoAgo(1).slice(0, 10),
      externeURL: 'https://jobs.spree-daten.example/data-engineer',
      hauptberuf: 'Datenbankentwickler/in',
    },
    {
      stellenangebotsTitel: 'Datenanalyst (m/w/d)',
      firma: 'Havel Analytik AG',
      referenznummer: BA_REFS[1],
      stellenlokationen: [{ adresse: { ort: 'Potsdam', land: 'DEUTSCHLAND' } }],
      datumErsteVeroeffentlichung: isoAgo(2).slice(0, 10),
      hauptberuf: 'Datenanalyst/in',
    },
  ],
});
export const baDetail = (ref: string): unknown => ({
  stellenangebotsTitel: 'Data Engineer (m/w/d)',
  referenznummer: ref,
  stellenangebotsBeschreibung: prose(`Datenplattform und Pipelines bei ${ref}`),
});

export const adzuna = (): unknown => ({
  count: 2,
  results: [
    {
      id: '5550001',
      title: 'Data Engineer',
      description: prose('Cloud data warehouse at Kite Systems'),
      created: isoAgo(1),
      redirect_url: 'https://www.adzuna.de/land/ad/5550001?se=x',
      company: { display_name: 'Kite Systems' },
      location: { display_name: 'Munich, Bavaria', area: ['Germany', 'Bavaria', 'Munich'] },
      salary_min: 60000,
      salary_max: 75000,
      salary_is_predicted: '0',
      contract_time: 'full_time',
      category: { label: 'IT Jobs' },
    },
    {
      id: '5550002',
      title: 'Data Engineer',
      description: prose('Event pipelines at Kite Systems Cologne'),
      created: isoAgo(1),
      redirect_url: 'https://www.adzuna.de/land/ad/5550002?se=x',
      company: { display_name: 'Kite Systems' },
      location: { display_name: 'Cologne', area: ['Germany', 'NRW', 'Cologne'] },
      salary_min: 50000,
      salary_max: 50000,
      salary_is_predicted: '1',
      category: { label: 'IT Jobs' },
    },
  ],
});

export const greenhouseList = (): unknown => ({
  jobs: [{ ...(ats('greenhouse.json') as object), first_published: isoAgo(2) }],
});
export const leverList = (): unknown => [ats('lever.json')];
export const ashbyList = (): unknown => ats('ashby.json');
export const workableList = (): unknown => ats('workable.json');
export const smartList = (): unknown => ({ content: [{ id: '743999912345678', name: 'Platform Engineer' }] });
export const smartDetail = (): unknown => ats('smartrecruiters.json');

export interface Route {
  status?: number;
  body?: unknown;
  /** Raw text instead of JSON. */
  text?: string;
  /** Called per request (headers, url). */
  onRequest?: (req: http.IncomingMessage) => void;
}
export type Routes = Record<string, Route | ((url: URL) => Route)>;

export interface FixtureServer {
  base: string;
  hits: string[];
  headers: http.IncomingHttpHeaders[];
  close(): Promise<void>;
}

/** Local server for source fixtures; the key is the URL path (query ignored). Unknown paths answer 404. */
export async function startFixtureServer(routes: Routes): Promise<FixtureServer> {
  const hits: string[] = [];
  const headers: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    hits.push(url.pathname + url.search);
    headers.push(req.headers);
    const found = routes[url.pathname];
    const route = typeof found === 'function' ? found(url) : found;
    if (!route) return void res.writeHead(404).end('not found');
    route.onRequest?.(req);
    res
      .writeHead(route.status ?? 200, {
        'Content-Type': route.text !== undefined ? 'text/html' : 'application/json',
      })
      .end(route.text ?? JSON.stringify(route.body ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    hits,
    headers,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** Routes for every source plus the watchlist boards, all on one server. */
export function allSourceRoutes(): Routes {
  return {
    '/api/job-board-api': { body: arbeitnow() },
    '/api/remote-jobs': { body: remotive() },
    '/api': { body: remoteok() },
    '/jobs/api/search': { body: himalayas() },
    '/jobs/api': { body: himalayas() },
    '/pc/v6/jobs': { body: baList() },
    ...Object.fromEntries(
      BA_REFS.map((ref) => [
        `/pc/v4/jobdetails/${Buffer.from(ref).toString('base64')}`,
        { body: baDetail(ref) },
      ]),
    ),
    '/v1/api/jobs/de/search/1': { body: adzuna() },
    '/v1/boards/acme/jobs': { body: greenhouseList() },
    '/v0/postings/acme': { body: leverList() },
    '/posting-api/job-board/acme': { body: ashbyList() },
    '/api/v1/widget/accounts/acme': { body: workableList() },
    '/v1/companies/acme/postings': { body: smartList() },
    '/v1/companies/acme/postings/743999912345678': { body: smartDetail() },
  };
}

/** `STELLIO_SOURCE_URLS` pointing every source at one fixture server. */
export const sourceUrlsEnv = (base: string): Record<string, string> => ({
  STELLIO_ALLOW_LOOPBACK_FETCH: '1',
  STELLIO_SOURCE_URLS: JSON.stringify(
    Object.fromEntries(
      [
        'adzuna',
        'arbeitnow',
        'ba',
        'remotive',
        'remoteok',
        'himalayas',
        ...['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable'],
      ].map((id) => [id, base]),
    ),
  ),
});
