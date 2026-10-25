import { z } from 'zod';

/**
 * The Zammad module's options (#8313 W5; spec 2026-10-19 §6.3, §6.5, §9
 * decisions 10 and 15), stored on the source and copied onto each run. They
 * hold no org or category id: those are the source's map tables (§5.5).
 * W4b adds the created-contacts option.
 */
export const ZAMMAD_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

export const zammadOptionsSchema = z.object({
  /**
   * Source priority id -> Breeze priority (§6.3). A priority missing here
   * maps by its seeded name (`1 low`, `2 normal`, `3 high`), anything else
   * to normal: Zammad priorities have no level (Z13).
   */
  priorityMap: z.record(z.string().regex(/^\d{1,12}$/), z.enum(ZAMMAD_PRIORITIES)).default({}),
  /**
   * System articles (triggers, schedulers, delivery notes; Z14): skipped and
   * counted by default (#8313 answer 5), or kept as internal notes by
   * "Zammad (system)".
   */
  systemArticles: z.enum(['skip', 'internal_note']).default('skip'),
  /**
   * The ticket's accounted time as ONE internal note (decision 15), never a
   * time entry: entries belong to a human and feed invoicing (F19).
   */
  timeAccountingNote: z.boolean().default(true),
  /** The note's unit label: which unit an instance's `time_unit` counts is unverified (§11). */
  timeUnitLabel: z.string().trim().min(1).max(32).regex(/^[^\u0000-\u001F\u007F]+$/u).default('minutes'),
}).strict();

export type ZammadOptions = z.infer<typeof zammadOptionsSchema>;
