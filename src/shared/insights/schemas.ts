import { z } from 'zod';

export const INSIGHT_WINDOWS = ['90d', 'all'] as const;
export type InsightWindow = (typeof INSIGHT_WINDOWS)[number];

/** Segments with fewer applications than this are shown greyed and carry no rates (docs/08 §5). */
export const MIN_SAMPLE = 5;

export const SegmentSchema = z.object({
  label: z.string(),
  applications: z.number().int(),
  responses: z.number().int(),
  interviews: z.number().int(),
  /** 0-1; null when the segment is `insufficient`. */
  responseRate: z.number().nullable(),
  interviewRate: z.number().nullable(),
  insufficient: z.boolean(),
});
export type Segment = z.infer<typeof SegmentSchema>;

export const DIMENSION_KEYS = [
  'source',
  'roleFamily',
  'seniority',
  'fitBand',
  'remote',
  'coverLetter',
  'daysSincePosting',
  'skills',
] as const;
export type DimensionKey = (typeof DIMENSION_KEYS)[number];

export const DimensionSchema = z.object({
  key: z.enum(DIMENSION_KEYS),
  title: z.string(),
  segments: z.array(SegmentSchema),
});
export type Dimension = z.infer<typeof DimensionSchema>;

export const InsightsSummarySchema = z.object({
  window: z.enum(INSIGHT_WINDOWS),
  generatedAt: z.string(),
  minSample: z.number().int(),
  totals: SegmentSchema,
  /** Median days from applying to the first sign from the company; null when nobody answered. */
  timeToResponse: z.object({ medianDays: z.number().nullable(), responses: z.number().int() }),
  /** Ghosted = no answer after 30 days (or marked ghosted), among applications at least 30 days old. */
  ghosting: z.object({
    eligible: z.number().int(),
    ghosted: z.number().int(),
    rate: z.number().nullable(),
    insufficient: z.boolean(),
  }),
  dimensions: z.array(DimensionSchema),
});
export type InsightsSummary = z.infer<typeof InsightsSummarySchema>;

/** Output of the `insights.ask` task. */
export const InsightsAskOutputSchema = z.object({
  answer: z.string(),
  numbers_used: z.array(z.object({ label: z.string(), value: z.string() })),
});
export type InsightsAskOutput = z.infer<typeof InsightsAskOutputSchema>;

export const InsightsAnswerSchema = z.object({
  answer: z.string(),
  numbersUsed: z.array(z.object({ label: z.string(), value: z.string() })),
  /** The numbers check failed twice: the answer is shown with this warning. Null when it passed. */
  warning: z.string().nullable(),
});
export type InsightsAnswer = z.infer<typeof InsightsAnswerSchema>;
