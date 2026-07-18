/**
 * AI Microsoft 365 (typed Graph read) Tool Input Schemas
 *
 * Zod schemas for validating the 6 m365_query_* tool inputs before execution.
 * These validate the loose AI-tool-facing shape; the handlers (aiToolsM365.ts)
 * additionally map that shape onto a strict M365ReadAction and re-validate via
 * `m365ReadActionSchema` (the shared discriminated-union contract) before
 * calling the control-plane service — this file is defense-in-depth, not the
 * source of truth for the Graph action shape.
 *
 * Extracted to its own file (rather than inlined in aiToolSchemas.ts) to
 * follow the aiToolSchemasBackup.ts domain-module convention.
 */

import { z } from 'zod';

// Reusable validators (duplicated locally to avoid circular imports, same
// convention as aiToolSchemasBackup.ts).
const orgId = z.string().guid().optional();
const limit = z.number().int().min(1).max(100).optional();

export const m365ToolSchemas: Record<string, z.ZodType> = {
  m365_query_users: z.object({
    mode: z.enum(['list', 'get']),
    search: z.string().max(120).optional(),
    userIdOrUpn: z.string().min(1).max(320).optional(),
    accountEnabled: z.boolean().optional(),
    department: z.string().max(120).optional(),
    limit,
    orgId,
  }),

  m365_query_signins: z.object({
    userPrincipalName: z.string().min(1).max(320).optional(),
    sinceHours: z.number().int().min(1).max(168).optional(),
    limit,
    orgId,
  }),

  m365_query_intune_devices: z.object({
    mode: z.enum(['list', 'get']),
    // Named intuneDeviceId, not deviceId — see the matching comment in
    // aiToolsM365.ts (deviceArgsCoverage contract test avoidance).
    intuneDeviceId: z.string().min(1).max(300).optional(),
    complianceState: z.enum(['compliant', 'noncompliant', 'inGracePeriod', 'unknown']).optional(),
    operatingSystem: z.enum(['Windows', 'macOS', 'iOS', 'Android', 'Linux']).optional(),
    limit,
    orgId,
  }),

  m365_query_groups: z.object({
    mode: z.enum(['list', 'get', 'members']),
    groupId: z.string().min(1).max(300).optional(),
    search: z.string().max(120).optional(),
    limit,
    orgId,
  }),

  m365_query_org: z.object({
    include: z.enum(['profile', 'licenses']),
    orgId,
  }),

  m365_query_sites: z.object({
    mode: z.enum(['list', 'get']),
    search: z.string().max(120).optional(),
    siteId: z.string().min(1).max(300).optional(),
    orgId,
  }),
};
