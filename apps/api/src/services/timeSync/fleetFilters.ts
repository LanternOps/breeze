import { z } from 'zod';
import {
  TIME_SYNC_DOMAIN_ROLES,
  TIME_SYNC_FINDING_CODES,
  TIME_SYNC_HEALTH,
} from '@breeze/shared';
// Pure zod schema, kept apart from fleet.ts so AI-tool schema modules do not
// pull the DB schema in at import time.
export const fleetTimeFiltersSchema = z
  .object({
    health: z.enum(TIME_SYNC_HEALTH).optional(),
    finding: z.enum(TIME_SYNC_FINDING_CODES).optional(),
    role: z.enum(TIME_SYNC_DOMAIN_ROLES).optional(),
    orgId: z.string().uuid().optional(),
    siteId: z.string().uuid().optional(),
    deviceId: z.string().uuid().optional(),
    domain: z.string().min(1).max(255).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type FleetTimeFilters = z.input<typeof fleetTimeFiltersSchema>;
