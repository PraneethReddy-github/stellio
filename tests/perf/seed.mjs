// Seeds N synthetic jobs (open inbox state, with sources and a triage score) into an existing Stellio DB.
// The DB must already be migrated (launch the app once on the data folder first). Never run on a real folder.
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

const ID_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 26-char Crockford id, time-ordered like the app's ULIDs. */
let seq = 0;
const id = () => {
  const t = (Date.now() + seq++).toString(32).toUpperCase().padStart(10, '0').slice(-10);
  const r = [...randomBytes(16)].map((b) => ID_CHARS[b % 32]).join('');
  return t + r;
};

const WORDS = [
  'Data',
  'Platform',
  'Backend',
  'Analytics',
  'Cloud',
  'ML',
  'Search',
  'Payments',
  'Mobile',
  'Security',
];
const ROLES = ['Engineer', 'Developer', 'Architect', 'Lead', 'Specialist'];
const CITIES = ['Berlin', 'Munich', 'Hamburg', 'Amsterdam', 'Remote (EU)', 'Vienna', 'Zurich'];
const SOURCES = ['arbeitnow', 'remotive', 'greenhouse', 'lever', 'adzuna'];
const REMOTE = ['onsite', 'hybrid', 'remote', 'unknown'];

export function seedJobs(dbFile, n = 5000) {
  const db = new Database(dbFile);
  db.pragma('foreign_keys = ON');
  const now = new Date();
  const iso = (daysAgo) => new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
  const company = db.prepare('INSERT INTO companies (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)');
  const job = db.prepare(
    `INSERT INTO jobs (id, company_id, title, location_text, remote, salary_min, salary_max, salary_currency,
       salary_period, url, posted_at, description_md, first_seen_at, last_seen_at, dedupe_key, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`,
  );
  const source = db.prepare(
    `INSERT INTO job_sources (id, job_id, source, external_id, url, fetched_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const triage = db.prepare(
    `INSERT INTO analyses (id, job_id, profile_hash, model, prompt_version, fit_score, summary, triage, created_at, updated_at)
     VALUES (?, ?, 'perf', 'claude-haiku-5-5', 'v1', ?, ?, 1, ?, ?)`,
  );
  const body = 'Build and run data pipelines in Python and SQL. '.repeat(20);
  db.transaction(() => {
    const companyIds = Array.from({ length: 300 }, (_, i) => {
      const cid = id();
      company.run(cid, `Company ${String(i)} GmbH`, iso(60), iso(60));
      return cid;
    });
    for (let i = 0; i < n; i++) {
      const jid = id();
      const seen = iso(Math.random() * 25);
      const title = `${WORDS[i % WORDS.length]} ${ROLES[i % ROLES.length]} ${String(i)}`;
      job.run(
        jid,
        companyIds[i % companyIds.length],
        title,
        CITIES[i % CITIES.length],
        REMOTE[i % REMOTE.length],
        60000 + (i % 40) * 1000,
        80000 + (i % 40) * 1000,
        'EUR',
        'year',
        `https://example.invalid/jobs/${String(i)}`,
        seen,
        body,
        seen,
        seen,
        `perf-${String(i)}`,
        seen,
        seen,
      );
      source.run(id(), jid, SOURCES[i % SOURCES.length], `ext-${String(i)}`, null, seen, seen, seen);
      triage.run(id(), jid, 20 + ((i * 37) % 80), 'Synthetic triage reason for the perf seed.', seen, seen);
    }
  })();
  db.close();
}
