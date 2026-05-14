import { z } from 'zod';

export const listCatalogQuerySchema = z.object({
  vendor: z.string().optional(),
  breezeTested: z.enum(['true', 'false']).optional(),
  search: z.string().min(1).max(255).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
