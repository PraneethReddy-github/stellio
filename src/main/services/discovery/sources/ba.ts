import { z } from 'zod';
import { wantsGermany } from '@shared/discovery/filters';
import { NormalizedJobSchema, type NormalizedJob } from '@shared/discovery/schemas';
import { httpUrlOrNull } from '../../jobs/net';
import { baseUrl, blankJob, SourceError, toIso, type SourceAdapter } from './http';

/**
 * Bundesagentur für Arbeit Jobsuche. Public client id in the `X-API-Key` header (documented by bund.dev:
 * https://github.com/bundesAPI/jobsuche-api). The list (`/pc/v6/jobs`) has no description, so each new posting
 * costs one detail request (`/pc/v4/jobdetails/<base64 refnr>`), capped by the scan's detail budget.
 */
const CLIENT_ID = { 'X-API-Key': 'jobboerse-jobsuche' };
const BASE = 'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service';

const Place = z.looseObject({
  adresse: z.looseObject({ ort: z.string().nullish(), land: z.string().nullish() }).nullish(),
});
const BaItem = z.looseObject({
  stellenangebotsTitel: z.string(),
  firma: z.string().nullish(),
  referenznummer: z.string().min(1),
  stellenlokationen: z.array(Place).nullish(),
  datumErsteVeroeffentlichung: z.string().nullish(),
  aenderungsdatum: z.string().nullish(),
  externeURL: z.string().nullish(),
  hauptberuf: z.string().nullish(),
  alleBerufe: z.array(z.string()).nullish(),
  homeofficemoeglich: z.boolean().nullish(),
  stellenangebotsBeschreibung: z.string().nullish(),
});
const BaList = z.looseObject({ ergebnisliste: z.array(z.unknown()).nullish(), maxErgebnisse: z.unknown() });

const days = (since: Date): number =>
  Math.min(100, Math.max(1, Math.ceil((Date.now() - since.getTime()) / 86_400_000) + 1));

export const ba: SourceAdapter = {
  id: 'ba',
  label: 'Bundesagentur für Arbeit',
  needsKey: false,
  rateLimit: { rps: 3, burst: 5 },
  perProfile: true,
  queryless: false,
  applies: wantsGermany,
  async *search(ctx) {
    const base = baseUrl('ba', BASE);
    const roles = ctx.profile.roles.length > 0 ? ctx.profile.roles.slice(0, 3) : [''];
    const places = ctx.profile.locations.filter((l) => !/^(germany|deutschland|de)$/i.test(l));
    const wo = (places.length > 0 ? places : ['']).slice(0, 2);
    let yielded = 0;
    for (const was of roles) {
      for (const where of wo) {
        const q = new URLSearchParams({
          size: String(Math.min(50, ctx.limit)),
          page: '1',
          angebotsart: '1',
          veroeffentlichtseit: String(days(ctx.since)),
        });
        if (ctx.profile.kind === 'side') q.set('arbeitszeit', 'tz;mj'); // Teilzeit and Minijob only
        if (was) q.set('was', was);
        if (where) {
          q.set('wo', where);
          q.set('umkreis', '25');
        }
        const list = BaList.safeParse(await ctx.getJson(`${base}/pc/v6/jobs?${q.toString()}`, CLIENT_ID));
        if (!list.success) throw new SourceError('unexpected Bundesagentur response');
        for (const item of list.data.ergebnisliste ?? []) {
          if (yielded >= ctx.limit) return;
          const ref = (item as { referenznummer?: unknown }).referenznummer;
          if (typeof ref !== 'string') {
            yield item; // normalize reports it
            continue;
          }
          if (ctx.isKnown(ref)) {
            yielded++;
            yield item;
            continue;
          }
          if (ctx.detailBudget.left <= 0) continue; // seen on a later scan
          ctx.detailBudget.left--;
          const detail = await ctx.getJson(
            `${base}/pc/v4/jobdetails/${Buffer.from(ref).toString('base64')}`,
            CLIENT_ID,
          );
          yielded++;
          yield { ...(item as object), ...(typeof detail === 'object' && detail !== null ? detail : {}) };
        }
      }
    }
  },
  normalize(raw): NormalizedJob {
    const j = BaItem.parse(raw);
    const place = j.stellenlokationen?.[0]?.adresse;
    const ort = place?.ort ?? null;
    const url = `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(j.referenznummer)}`;
    return NormalizedJobSchema.parse({
      ...blankJob('ba'),
      externalId: j.referenznummer,
      url,
      applyUrl: httpUrlOrNull(j.externeURL) ?? url,
      title: j.stellenangebotsTitel,
      company: j.firma || 'Unknown company',
      locationText: ort ? `${ort}, Germany` : 'Germany',
      city: ort,
      country: 'Germany',
      remote: 'unknown',
      postedAt: toIso(j.datumErsteVeroeffentlichung ?? j.aenderungsdatum),
      descriptionMd: (j.stellenangebotsBeschreibung ?? '').replace(/\r\n?/g, '\n').trim(),
      tags: [j.hauptberuf ?? '', ...(j.alleBerufe ?? [])].filter(Boolean),
    });
  },
};
