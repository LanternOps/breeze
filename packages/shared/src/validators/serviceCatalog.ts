import { z } from 'zod';

/**
 * Service catalog management validators (#8325, wave A1).
 *
 * Ownership is deliberately absent: there is no partnerId / orgId / catalogId /
 * ownerScope on any input. The catalog is the caller's own partner's single
 * catalog; the server derives the partner from the auth context. All schemas
 * are .strict() so a client-supplied ownership field is a 400, not ignored.
 *
 * Defaults live ONLY on the create schema (never the shared base) so that the
 * update schema, built with .partial(), stays truly partial.
 */

const label = (max: number) => z.string().trim().min(1).max(max);

const serviceCatalogItemBaseSchema = z.object({
  name: label(255),
  description: z.string().max(2000).nullable().optional(),
  // Descriptive grouping (pillar -> service line); null clears.
  pillar: label(120).nullable().optional(),
  serviceLine: label(120).nullable().optional(),
  isActive: z.boolean(),
  // Exposed for the future customer-portal catalog (wave D). No consumer reads
  // it yet; it only records the partner's publish intent.
  showInPortal: z.boolean(),
  sortOrder: z.number().int().min(-100_000).max(100_000),
});

/** A service line only exists inside a pillar (mirrors service_catalog_items_grouping_chk). */
export function serviceLineRequiresPillar(v: { pillar?: string | null; serviceLine?: string | null }): boolean {
  return !(v.serviceLine != null && v.pillar == null);
}

export const SERVICE_LINE_REQUIRES_PILLAR_MESSAGE = 'serviceLine requires a pillar';

export const createServiceCatalogItemSchema = serviceCatalogItemBaseSchema
  .extend({
    isActive: z.boolean().default(true),
    showInPortal: z.boolean().default(false),
    sortOrder: z.number().int().min(-100_000).max(100_000).default(0),
  })
  .strict()
  .refine(serviceLineRequiresPillar, { message: SERVICE_LINE_REQUIRES_PILLAR_MESSAGE, path: ['serviceLine'] });

// A partial payload cannot be checked in isolation (PATCH {pillar:null} is only
// valid when the stored row has no service line); the API validates the
// RESULTING state. Only the unambiguous in-payload case is refined here.
export const updateServiceCatalogItemSchema = serviceCatalogItemBaseSchema
  .partial()
  .strict()
  .refine(
    (v) => !(v.serviceLine != null && v.pillar === null),
    { message: SERVICE_LINE_REQUIRES_PILLAR_MESSAGE, path: ['serviceLine'] },
  );

export const updateServiceCatalogSchema = z
  .object({
    name: label(255).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const listServiceCatalogItemsQuerySchema = z.object({
  includeArchived: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  pillar: z.string().trim().min(1).max(120).optional(),
  q: z.string().trim().min(1).max(255).optional(),
});

export type CreateServiceCatalogItemInput = z.infer<typeof createServiceCatalogItemSchema>;
export type UpdateServiceCatalogItemInput = z.infer<typeof updateServiceCatalogItemSchema>;
export type UpdateServiceCatalogInput = z.infer<typeof updateServiceCatalogSchema>;
