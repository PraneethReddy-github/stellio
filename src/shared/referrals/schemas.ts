import { z } from 'zod';

/** docs/14 §2: not_contacted → contacted → replied → referred | declined | no_response. */
export const REFERRAL_STATUSES = [
  'not_contacted',
  'contacted',
  'replied',
  'referred',
  'declined',
  'no_response',
] as const;
export const ReferralStatusSchema = z.enum(REFERRAL_STATUSES);
export type ReferralStatus = z.infer<typeof ReferralStatusSchema>;

export const MAX_CANDIDATES = 25;
export const DEFAULT_RETENTION_DAYS = 90;
/** Days after "contacted" before the follow-up reminder (docs/14 §2). */
export const FOLLOW_UP_DAYS = 7;

export const PROFILE_URL_KINDS = ['linkedin', 'github', 'company', 'personal', 'other'] as const;
export const ProfileUrlSchema = z.object({ url: z.string(), kind: z.enum(PROFILE_URL_KINDS) });
export type ProfileUrl = z.infer<typeof ProfileUrlSchema>;

export const PublicContactSchema = z.object({
  kind: z.enum(['email', 'contact_form', 'other']),
  value: z.string(),
  source_url: z.string(),
});
export type PublicContact = z.infer<typeof PublicContactSchema>;

export const PersonSourceSchema = z.object({
  url: z.string(),
  seen_at: z.string(),
  facts: z.array(z.string()),
});
export type PersonSource = z.infer<typeof PersonSourceSchema>;

/**
 * What the `referrals.search` model returns (docs/14 §4). Deliberately lenient (plain strings): one odd item must
 * not fail the whole run; code validates every field afterwards (`validateCandidates`).
 */
export const SearchOutputSchema = z.object({
  candidates: z.array(
    z.object({
      full_name: z.string(),
      title: z.string(),
      company: z.string(),
      location: z.string(),
      profile_urls: z.array(z.string()),
      public_contact: z.array(z.object({ kind: z.string(), value: z.string(), source_url: z.string() })),
      facts: z.array(z.object({ text: z.string(), source_url: z.string() })),
      why: z.string(),
    }),
  ),
});
export type SearchOutput = z.infer<typeof SearchOutputSchema>;
export type RawCandidate = SearchOutput['candidates'][number];

/** What `referrals.message` returns. */
export const MessageOutputSchema = z.object({
  connection_note: z.string(),
  subject: z.string(),
  body: z.string(),
  language: z.string(),
});
export type MessageOutput = z.infer<typeof MessageOutputSchema>;

/** A candidate that passed validation, ready to store. */
export interface ValidPerson {
  fullName: string;
  title: string;
  company: string;
  locationText: string;
  country: string | null;
  profileUrls: ProfileUrl[];
  publicContact: PublicContact[];
  sources: PersonSource[];
  /** The model's one-liner (may be empty: ranking then writes one from the signals). */
  why: string;
}

export const DropReasonSchema = z.enum([
  'no_name',
  'wrong_company',
  'company_not_in_facts',
  'no_profile_url',
  'no_sourced_fact',
  'duplicate',
  'over_limit',
]);
export type DropReason = z.infer<typeof DropReasonSchema>;

// ---- stored records / IPC ---------------------------------------------------------------------------------

export const PersonSchema = z.object({
  id: z.string(),
  fullName: z.string(),
  title: z.string(),
  company: z.string(),
  companyId: z.string().nullable(),
  locationText: z.string(),
  country: z.string().nullable(),
  profileUrls: z.array(ProfileUrlSchema),
  publicContact: z.array(PublicContactSchema),
  sources: z.array(PersonSourceSchema),
  sharedGround: z.array(z.string()),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  purgeAfter: z.string().nullable(),
});
export type Person = z.infer<typeof PersonSchema>;

export const MessageChecksSchema = z.object({
  ok: z.boolean(),
  lint: z.array(z.object({ rule: z.string(), message: z.string() })),
  truth: z.array(z.object({ kind: z.string(), text: z.string(), detail: z.string() })),
  warnings: z.array(z.string()),
});
export type MessageChecks = z.infer<typeof MessageChecksSchema>;

export const ReferralRequestSchema = z.object({
  id: z.string(),
  personId: z.string(),
  jobId: z.string().nullable(),
  applicationId: z.string().nullable(),
  status: ReferralStatusSchema,
  why: z.string(),
  score: z.number(),
  noteText: z.string().nullable(),
  messageSubject: z.string().nullable(),
  messageBody: z.string().nullable(),
  language: z.string().nullable(),
  checks: MessageChecksSchema.nullable(),
  rulesHash: z.string().nullable(),
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  contactedAt: z.string().nullable(),
  nextActionAt: z.string().nullable(),
  notesMd: z.string().nullable(),
  createdAt: z.string(),
});
export type ReferralRequest = z.infer<typeof ReferralRequestSchema>;

export const ReferralItemSchema = ReferralRequestSchema.extend({ person: PersonSchema });
export type ReferralItem = z.infer<typeof ReferralItemSchema>;

export const SearchHintsSchema = z.object({
  team: z.string().trim().max(120).optional(),
  seniority: z.string().trim().max(60).optional(),
  /** Institutions or employers from the profile to favour ("alumni of ..."). */
  alumni: z.array(z.string().trim().min(1).max(120)).max(5).optional(),
  languages: z.array(z.string().trim().min(1).max(40)).max(5).optional(),
});
export type SearchHints = z.infer<typeof SearchHintsSchema>;

/** People already found for this company and role; "search more" asks for different ones. */
export const SearchExcludeSchema = z.object({
  names: z.array(z.string().max(200)).max(200),
  profileUrls: z.array(z.string().max(500)).max(600),
});
export type SearchExclude = z.infer<typeof SearchExcludeSchema>;

export const SearchOutcomeSchema = z.object({
  /** Candidates the model returned. */
  returned: z.number().int(),
  kept: z.number().int(),
  dropped: z.array(z.object({ reason: DropReasonSchema, count: z.number().int() })),
  items: z.array(ReferralItemSchema),
});
export type SearchOutcome = z.infer<typeof SearchOutcomeSchema>;

export const ReferralSettingsSchema = z.object({
  retentionDays: z.number().int().min(1).max(3650),
});
export type ReferralSettings = z.infer<typeof ReferralSettingsSchema>;
