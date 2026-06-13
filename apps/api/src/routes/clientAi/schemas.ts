import { z } from 'zod';
import type { ClientAiOrgPolicy } from '../../services/clientAiPolicy';

// ============================================
// Constants (mirrors routes/portal/schemas.ts)
// ============================================

/** Add-in sessions are 24h Redis-backed bearer tokens, org-bound (spec §3). */
export const CLIENT_AI_SESSION_TTL_MS = 1000 * 60 * 60 * 24;
export const CLIENT_AI_SESSION_TTL_SECONDS = Math.floor(CLIENT_AI_SESSION_TTL_MS / 1000);

export const CLIENT_AI_REDIS_KEYS = {
  session: (token: string) => `clientai:session:${token}`,
  userSessions: (portalUserId: string) => `clientai:user-sessions:${portalUserId}`,
};

/** Per-IP exchange rate limit (rateLimiter sliding window). */
export const EXCHANGE_RATE_LIMIT = { limit: 20, windowSeconds: 300 } as const;

/** Same shape as services/c2cM365.ts M365_TENANT_ID_REGEX / the SQL CHECK. */
export const ENTRA_TENANT_GUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================
// Zod schemas
// ============================================

export const exchangeSchema = z.object({
  /** Entra ID access token from Office SSO / NAA. */
  accessToken: z.string().min(1).max(8192),
});

export const putTenantMappingSchema = z.object({
  entraTenantId: z
    .string()
    .regex(ENTRA_TENANT_GUID_REGEX, 'must be an Entra tenant GUID (Directory ID)'),
});

export const putPolicySchema = z
  .object({
    enabled: z.boolean().optional(),
    userAccess: z.enum(['all', 'selected']).optional(),
    selectedUserIds: z.array(z.string().uuid()).max(1000).optional(),
    allowedProviders: z.array(z.string().min(1).max(50)).min(1).max(10).optional(),
    allowedModels: z.array(z.string().min(1).max(100)).max(50).optional(),
    writeMode: z.enum(['readwrite', 'readonly']).optional(),
    dlpConfig: z.record(z.unknown()).optional(),
    dailyBudgetCents: z.number().int().min(0).nullable().optional(),
    monthlyBudgetCents: z.number().int().min(0).nullable().optional(),
    perUserMessagesPerMinute: z.number().int().min(1).max(600).optional(),
    orgMessagesPerHour: z.number().int().min(1).max(100000).optional(),
    retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
    branding: z.record(z.unknown()).optional(),
  })
  .strict();

// ============================================
// Types
// ============================================

export type ClientAiSessionPayload = {
  portalUserId: string;
  orgId: string;
  createdAt: string;
};

export type ClientAiAuthContext = {
  clientUserId: string;
  orgId: string;
  email: string;
  name: string | null;
  token: string;
};

declare module 'hono' {
  interface ContextVariableMap {
    clientAiAuth: ClientAiAuthContext;
    clientAiPolicy: ClientAiOrgPolicy;
  }
}
