import { z } from 'zod';
import type { ImportedTicket } from '../../importedTicket';

/**
 * The Zammad module's options (#8313 W5; spec 2026-10-19 §6.3, §6.5, §9
 * decisions 10 and 15), stored on the source and copied onto each run. They
 * hold no org or category id: those are the source's map tables (§5.5).
 * W4b added the created-contacts option (§5.13, decision 25).
 */
export const ZAMMAD_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
/** importedTicket's final statuses (a type import keeps this file free of the writer's runtime). */
export const ZAMMAD_TARGET_STATUSES = ['new', 'open', 'pending', 'on_hold', 'resolved', 'closed'] as const satisfies ReadonlyArray<ImportedTicket['finalStatus']>;

export const zammadOptionsSchema = z.object({
  /**
   * Source priority id -> Breeze priority (§6.3). A priority missing here
   * maps by its seeded name (`1 low`, `2 normal`, `3 high`), anything else
   * to normal: Zammad priorities have no level (Z13).
   */
  priorityMap: z.record(z.string().regex(/^\d{1,12}$/), z.enum(ZAMMAD_PRIORITIES)).default({}),
  /**
   * Source state id -> Breeze status, overriding the mapping by state type
   * (§6.3) for one state: a custom state an instance added. `name` is the
   * state's name when it was mapped, for display only. A merged ticket stays
   * closed with its merge note whatever this says.
   */
  stateMap: z.record(
    z.string().regex(/^\d{1,12}$/),
    z.object({
      status: z.enum(ZAMMAD_TARGET_STATUSES),
      name: z.string().max(255).regex(/^[^\u0000-\u001F\u007F]*$/u).optional(),
    }).strict(),
  ).default({}),
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
  /**
   * "Create missing requester contacts" (W4b, spec §5.13, decision 25). Off,
   * an import creates no contact (#8313 answer 3). On, a requester with an
   * email and no single contact match in the target org is sent as
   * `{ createContact }`, and the writer creates it in the ticket's header
   * transaction. Turn it on before the bulk run: the requester is never
   * re-applied on resume (§5.9).
   */
  createRequesterContacts: z.boolean().default(false),
  /**
   * Only with `createRequesterContacts`: create contacts only for tickets
   * updated in the source on or after this UTC date (`YYYY-MM-DD`). Older
   * tickets keep a display-only requester.
   */
  createRequesterContactsUpdatedSince: z.iso.date().optional(),
}).strict();

export type ZammadOptions = z.infer<typeof zammadOptionsSchema>;
