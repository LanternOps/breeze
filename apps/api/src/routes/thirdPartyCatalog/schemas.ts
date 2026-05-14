import { z } from 'zod';
import { patchSourceEnum, patchSeverityEnum } from '../../db/schema/patches';

// Catalog only accepts a subset of patch_source — OS-vendor sources are out of scope.
const catalogSourceValues = ['third_party', 'custom'] as const satisfies readonly (typeof patchSourceEnum.enumValues)[number][];

const httpUrl = z
  .string()
  .url()
  .refine((s) => s.startsWith('http://') || s.startsWith('https://'), 'must be http(s)');

export const listCatalogQuerySchema = z.object({
  vendor: z.string().optional(),
  breezeTested: z.enum(['true', 'false']).optional(),
  search: z.string().min(1).max(255).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const upsertCatalogSchema = z.object({
  source: z.enum(catalogSourceValues).default('third_party'),
  packageId: z.string().min(1).max(256),
  vendor: z.string().min(1).max(255),
  friendlyName: z.string().min(1).max(255),
  category: z.string().max(64).optional(),
  defaultSeverity: z.enum(patchSeverityEnum.enumValues).optional(),
  breezeTested: z.boolean().optional(),
  notes: z.string().max(2000).nullable().optional(),
  homepageUrl: httpUrl.nullable().optional(),
});
