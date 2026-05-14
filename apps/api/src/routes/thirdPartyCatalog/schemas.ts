import { z } from 'zod';

export const listCatalogQuerySchema = z.object({
  vendor: z.string().optional(),
  breezeTested: z.enum(['true', 'false']).optional(),
  search: z.string().min(1).max(255).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const upsertCatalogSchema = z.object({
  source: z.enum(['third_party', 'custom']).default('third_party'),
  packageId: z.string().min(1).max(256),
  vendor: z.string().min(1).max(255),
  friendlyName: z.string().min(1).max(255),
  category: z.string().max(64).optional(),
  defaultSeverity: z.enum(['critical', 'important', 'moderate', 'low', 'unknown']).optional(),
  breezeTested: z.boolean().optional(),
  notes: z.string().max(2000).nullable().optional(),
  homepageUrl: z.string().url().nullable().optional(),
});
