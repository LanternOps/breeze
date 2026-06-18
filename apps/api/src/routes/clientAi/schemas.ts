import { z } from 'zod';
import { dlpConfigSchema, DEFAULT_DLP_CONFIG } from '@breeze/shared/validators';
import type { ClientAiOrgPolicy } from '../../services/clientAiPolicy';
import { CLIENT_HOSTS } from '../../services/clientAiHosts';

/**
 * Mirrors `DLP_MAX_TOTAL_CHARS` in services/clientAiDlp.ts — the engine's
 * fail-closed total-char limit. Inlined (not imported) so this schema module
 * never depends on the DLP service, which route tests routinely `vi.mock`
 * (an imported value would resolve to `undefined` under the mock and break
 * schema construction at import time).
 */
const WB_TEXT_MAX_CHARS = 2_000_000;

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
    selectedUserIds: z.array(z.string().guid()).max(1000).optional(),
    allowedProviders: z.array(z.string().min(1).max(50)).min(1).max(10).optional(),
    allowedModels: z.array(z.string().min(1).max(100)).max(50).optional(),
    writeMode: z.enum(['readwrite', 'readonly']).optional(),
    /** Org gate for pane auto-apply (spec §7). 'ask' is the default-deny value. */
    writeApproval: z.enum(['ask', 'allow_auto']).optional(),
    /** Validated + normalized (defaults filled) — see packages/shared/src/validators/clientAiDlp.ts. */
    dlpConfig: dlpConfigSchema.optional(),
    dailyBudgetCents: z.number().int().min(0).nullable().optional(),
    monthlyBudgetCents: z.number().int().min(0).nullable().optional(),
    perUserMessagesPerMinute: z.number().int().min(1).max(600).optional(),
    orgMessagesPerHour: z.number().int().min(1).max(100000).optional(),
    retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
    branding: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

// ============================================
// DLP config (spec §6) — THE cross-plan contract shape.
// Plan 3 already shipped the canonical schema in @breeze/shared/validators
// (dlpConfigSchema, DEFAULT_DLP_CONFIG). We re-export aliases so Plan-4
// route tasks/tests have stable client-ai-namespaced names without
// duplicating (and diverging from) the shared definition. putPolicySchema
// above already consumes dlpConfigSchema directly.
// ============================================

export const clientAiDlpConfigSchema = dlpConfigSchema;
export type ClientAiDlpConfig = z.infer<typeof clientAiDlpConfigSchema>;

/** Spec §6 defaults: redact for financial/credential types; email/phone off. */
export const CLIENT_AI_DLP_DEFAULT_BUILTINS = DEFAULT_DLP_CONFIG.builtins;

// ============================================
// Plan-4 admin query/body schemas
// ============================================

export const USAGE_MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

export const adminUsageQuerySchema = z
  .object({
    from: z.string().regex(USAGE_MONTH_REGEX, 'must be YYYY-MM'),
    to: z.string().regex(USAGE_MONTH_REGEX, 'must be YYYY-MM'),
    orgId: z.string().guid().optional(),
  })
  .refine((q) => q.from <= q.to, { message: 'from must be <= to' });

const parsableDate = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'must be a parsable date');

export const adminSessionListQuerySchema = z.object({
  orgId: z.string().guid().optional(),
  clientUserId: z.string().guid().optional(),
  from: parsableDate.optional(),
  to: parsableDate.optional(),
  flagged: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const flagSessionSchema = z
  .object({ reason: z.string().max(1000).optional() })
  .optional();

export const templateBodySchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).nullable().optional(),
    promptBody: z.string().min(1).max(20000),
    category: z.string().max(100).nullable().optional(),
    /**
     * Host targeting. null/absent or every host ⇒ shown in ALL hosts (the
     * server canonicalizes via normalizeTemplateHosts). A subset ⇒ only those.
     */
    hosts: z.array(z.enum(CLIENT_HOSTS)).nullable().optional(),
    /** null/absent ⇒ partner-wide row (org_id NULL, partner_id set). */
    orgId: z.string().guid().nullable().optional(),
  })
  .strict();

export const templateUpdateSchema = templateBodySchema
  .omit({ orgId: true })
  .partial()
  .strict();

export const templateListQuerySchema = z.object({
  orgId: z.string().guid().optional(),
  scope: z.enum(['partner', 'org']).optional(),
});

/** Client-facing GET /templates query — the add-in's host narrows the list. */
export const clientTemplateListQuerySchema = z.object({
  host: z.enum(CLIENT_HOSTS).optional(),
});

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
  /** Linear-text context for grid-less hosts (Word/PowerPoint/Outlook). Excel
   *  never sets it — its chip is grid-shaped (`cells`). Capped at the DLP
   *  engine's total-char fail-closed limit so it's always scannable. Without
   *  this field the client's `WorkbookContext.text` was silently dropped at
   *  `.parse()`, so ingress never interpolated or DLP-scanned it. */
  text: z.string().max(WB_TEXT_MAX_CHARS).optional(),
});

export const sendClientMessageSchema = z.object({
  content: z.string().min(1).max(20000),
  workbookContext: workbookContextSchema.optional(),
});

/**
 * Body of POST /sessions (create). The add-in tags the new session with the
 * open workbook's name so it surfaces in the per-user history list. Optional
 * — a missing/blank name persists as NULL (older clients send `{}`).
 */
export const createClientSessionSchema = z
  .object({
    workbookName: z.string().trim().min(1).max(500).optional(),
    host: z.enum(CLIENT_HOSTS).optional().default('excel'),
  })
  .strict();

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
  partnerAiForOfficeEnabled: boolean;
};

declare module 'hono' {
  interface ContextVariableMap {
    clientAiAuth: ClientAiAuthContext;
    clientAiPolicy: ClientAiOrgPolicy;
  }
}
