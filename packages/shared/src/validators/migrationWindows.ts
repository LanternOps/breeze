import { z } from 'zod';

/**
 * Ticket migration windows, the parts both sides need (#8313; windows spec
 * 2026-10-10 §3.3). The step-up resource for `migration_window_open` is the
 * exact shape the grant binds: the API's mint route validates it and the
 * import wizard builds it, so a drift between the two shows in a test
 * instead of as a refused grant.
 */

/** The most organizations one window may name. */
export const MIGRATION_WINDOW_MAX_ORGS = 500;

export const migrationWindowOpenStepUpResourceSchema = z.object({
  partnerId: z.string().guid(),
  principalId: z.string().guid(),
  orgIds: z.array(z.string().guid()).min(1).max(MIGRATION_WINDOW_MAX_ORGS),
  endsAt: z.string().datetime(),
  writesPerHour: z.number().int().optional(),
});
export type MigrationWindowOpenStepUpResource = z.infer<typeof migrationWindowOpenStepUpResourceSchema>;
