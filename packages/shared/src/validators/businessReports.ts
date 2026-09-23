import { z } from 'zod';
import type { ReportPeriodInput } from '../types/businessReports';

/** The single definition of a report period input. Consumed by the three API
 *  config schemas (`apps/api/src/services/businessReports/period.ts` re-exports
 *  it) and by W03's `ReportPeriodField`. `z.ZodType<ReportPeriodInput>` pins the
 *  schema and the type together — they cannot drift apart silently. */
export const periodSchema: z.ZodType<ReportPeriodInput> = z.object({
  kind: z.enum(['last_full_month', 'last_30_days', 'last_quarter', 'custom']),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
