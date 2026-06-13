import { z } from 'zod';
import { dlpConfigSchema } from '@breeze/shared/validators';
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
    /** Validated + normalized (defaults filled) — see packages/shared/src/validators/clientAiDlp.ts. */
    dlpConfig: dlpConfigSchema.optional(),
    dailyBudgetCents: z.number().int().min(0).nullable().optional(),
    monthlyBudgetCents: z.number().int().min(0).nullable().optional(),
    perUserMessagesPerMinute: z.number().int().min(1).max(600).optional(),
    orgMessagesPerHour: z.number().int().min(1).max(100000).optional(),
    retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
    branding: z.record(z.unknown()).optional(),
  })
  .strict();

// ============================================
// Session-loop schemas (Plan 2)
// ============================================

/** Per-message workbook context chip (spec §11): the user controls data egress. */
export const workbookContextSchema = z.object({
  kind: z.enum(['selection', 'sheet', 'none']),
  address: z.string().max(100).optional(),
  sheetName: z.string().max(255).optional(),
  /** Row-major cell values. Caps mirror the DLP engine's fail-closed limits
   *  (Plan 3: 50k cells / 32,767 chars per cell). */
  cells: z
    .array(z.array(z.union([z.string().max(32767), z.number(), z.boolean(), z.null()])).max(500))
    .max(5000)
    .optional(),
});

export const sendClientMessageSchema = z.object({
  content: z.string().min(1).max(20000),
  workbookContext: workbookContextSchema.optional(),
});

/** Body of POST /sessions/:id/tool-results (pinned bridge contract). */
export const clientToolResultSchema = z.object({
  toolUseId: z.string().min(1).max(100),
  status: z.enum(['success', 'error', 'rejected']),
  output: z.unknown().optional(),
});

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
