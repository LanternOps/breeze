/**
 * Wire schemas for org-import rows, shared by every import route (#3246).
 *
 * `POST /orgs/import` (CSV) and `POST /psa/connections/:id/import` accept the
 * IDENTICAL row contract — acknowledgements, identity pinning, reactivate,
 * forceCreate — so the web preview table can drive either one. Defining them
 * once makes that a structural guarantee instead of a comment two files apart.
 *
 * Deliberately NOT exported here: the array wrapper with `.max(MAX_IMPORT_ROWS)`.
 * Each route applies its own so this module never imports the pipeline barrel
 * (which route test suites mock wholesale).
 */

import { z } from 'zod';
import { isValidIanaTimezone } from '@breeze/shared';

export const importRowContactSchema = z
  .object({
    name: z.string().max(255).optional(),
    email: z.union([z.string().email(), z.literal('')]).optional(),
    phone: z.string().max(64).optional(),
  })
  .passthrough();

/**
 * NOTE: `billingAddress` is intentionally absent — it is reachable in-process
 * only (the QuickBooks importer sets it); no HTTP client may supply it.
 */
export const importRowSchema = z.object({
  organization: z.string().min(1).max(255),
  site: z.string().max(255).optional(),
  externalId: z.string().min(1).max(255).optional(),
  externalSystem: z.string().min(1).max(64).optional(),
  timezone: z.string().refine(isValidIanaTimezone, 'Invalid IANA timezone').optional(),
  address: z.any().optional(),
  contact: importRowContactSchema.optional(),
});

/**
 * A row as submitted to a COMMIT: the preview annotation the client saw, the
 * organization it saw it matched, and the explicit opt-ins that let the seam
 * accept an otherwise-refused match.
 */
export const commitImportRowSchema = importRowSchema.extend({
  expectedAnnotation: z.enum(['create', 'link-match', 'name-match', 'matched-soft-deleted']).optional(),
  expectedOrganizationId: z.string().guid().optional(),
  reactivate: z.boolean().optional(),
  forceCreate: z.boolean().optional(),
});
