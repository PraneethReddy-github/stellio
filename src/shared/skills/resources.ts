// Learning resources (docs/07 §5): the model suggests 2-3 per item on demand; code cleans them. Pure.
import { z } from 'zod';

export const RESOURCE_KINDS = ['official_docs', 'tutorial', 'course', 'book', 'other'] as const;

export const ResourcesOutputSchema = z.object({
  resources: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      kind: z.enum(RESOURCE_KINDS),
      /** One sentence: why this one. */
      why: z.string(),
    }),
  ),
});
export type ResourcesOutput = z.infer<typeof ResourcesOutputSchema>;

export interface Resource {
  title: string;
  url: string;
  kind: (typeof RESOURCE_KINDS)[number];
  why: string;
}
export const MAX_RESOURCES = 3;

const clean = (s: string, max: number): string =>
  s
    .replace(/[\r\n[\]()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/**
 * At most 3 resources: https links only, no duplicates, official documentation first. Suggestions are
 * never fetched or verified, so they are always shown as suggestions.
 */
export function cleanResources(out: ResourcesOutput): Resource[] {
  const seen = new Set<string>();
  const kept: Resource[] = [];
  for (const r of out.resources) {
    let url: URL;
    try {
      url = new URL(r.url.trim());
    } catch {
      continue;
    }
    const title = clean(r.title, 120);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || title === '') continue;
    const href = url.href;
    if (seen.has(href)) continue;
    seen.add(href);
    kept.push({ title, url: href, kind: r.kind, why: clean(r.why, 200) });
  }
  const rank = (r: Resource): number => (r.kind === 'official_docs' ? 0 : 1);
  return kept.sort((a, b) => rank(a) - rank(b)).slice(0, MAX_RESOURCES);
}

/** Stored in `learning_items.resources_md`: one line per resource. */
export const resourcesToMarkdown = (rs: readonly Resource[]): string =>
  rs.map((r) => `- [${r.title}](${r.url}) (${r.kind.replace('_', ' ')}): ${r.why}`).join('\n');

const LINE = /^- \[(.+?)\]\((https:\/\/[^\s)]+)\) \(([a-z ]+)\): (.*)$/;
/** Reads `resourcesToMarkdown` back for display; lines that do not match are ignored. */
export function parseResourcesMd(md: string | null): Resource[] {
  return (md ?? '').split('\n').flatMap((line) => {
    const m = LINE.exec(line.trim());
    if (!m) return [];
    const kind = RESOURCE_KINDS.find((k) => k.replace('_', ' ') === m[3]) ?? 'other';
    return [{ title: m[1] as string, url: m[2] as string, kind, why: m[4] as string }];
  });
}
