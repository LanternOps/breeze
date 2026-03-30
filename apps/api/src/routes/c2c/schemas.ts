import { z } from 'zod';

// ── Connection schemas ──────────────────────────────────────────────────────

export const c2cProviders = ['microsoft_365', 'google_workspace'] as const;

export const c2cAuthMethods = ['platform_app', 'manual'] as const;

export const createConnectionSchema = z
  .object({
    provider: z.enum(c2cProviders),
    displayName: z.string().min(1).max(200),
    tenantId: z.string().max(100).optional(),
    clientId: z.string().min(1).max(200).optional(),
    clientSecret: z.string().min(1).optional(),
    scopes: z.string().optional(),
    authMethod: z.enum(c2cAuthMethods).optional().default('manual'),
  })
  .refine(
    (data) => {
      if (data.authMethod === 'manual') {
        return !!data.clientId && !!data.clientSecret;
      }
      return true;
    },
    { message: 'clientId and clientSecret are required for manual connections' }
  );

export const idParamSchema = z.object({ id: z.string().uuid() });

// ── Config schemas ──────────────────────────────────────────────────────────

export const c2cBackupScopes = [
  'mail',
  'calendar',
  'contacts',
  'onedrive',
  'sharepoint',
  'teams',
  'gmail',
  'gdrive',
  'gcalendar',
  'gcontacts',
] as const;

export const createC2cConfigSchema = z.object({
  connectionId: z.string().uuid(),
  name: z.string().min(1).max(200),
  backupScope: z.enum(c2cBackupScopes),
  targetUsers: z.array(z.string().email()).optional(),
  storageConfigId: z.string().uuid().optional(),
  schedule: z
    .object({
      frequency: z.enum(['hourly', 'daily', 'weekly']),
      time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      dayOfWeek: z.number().int().min(0).max(6).optional(),
    })
    .optional(),
  retention: z
    .object({
      keepDays: z.number().int().min(1).max(3650).optional(),
      keepVersions: z.number().int().min(1).max(1000).optional(),
    })
    .optional(),
});

export const updateC2cConfigSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  backupScope: z.enum(c2cBackupScopes).optional(),
  targetUsers: z.array(z.string().email()).optional(),
  storageConfigId: z.string().uuid().nullable().optional(),
  schedule: z
    .object({
      frequency: z.enum(['hourly', 'daily', 'weekly']),
      time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      dayOfWeek: z.number().int().min(0).max(6).optional(),
    })
    .optional(),
  retention: z
    .object({
      keepDays: z.number().int().min(1).max(3650).optional(),
      keepVersions: z.number().int().min(1).max(1000).optional(),
    })
    .optional(),
  isActive: z.boolean().optional(),
});

// ── Job list schema ─────────────────────────────────────────────────────────

export const c2cJobListSchema = z.object({
  configId: z.string().uuid().optional(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

// ── Item search schema ──────────────────────────────────────────────────────

export const c2cItemSearchSchema = z.object({
  configId: z.string().uuid().optional(),
  userEmail: z.string().optional(),
  itemType: z.string().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// ── Restore schema ──────────────────────────────────────────────────────────

export const c2cRestoreSchema = z.object({
  itemIds: z.array(z.string().uuid()).min(1).max(1000),
  targetConnectionId: z.string().uuid().optional(),
});
