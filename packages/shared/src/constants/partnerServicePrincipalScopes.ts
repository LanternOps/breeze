// Partner service principal scope registry — the single source of truth shared
// by the API (validation, MCP gating, SQL-parity test) and the web create/edit
// dialog (checkbox grid, presets), so a scope cannot reach the API without
// also reaching the UI (#8173). Leaf module, no imports.

export const PARTNER_SERVICE_PRINCIPAL_READ_SCOPES = Object.freeze([
  'organizations:read',
  'sites:read',
  'devices:read',
  'inventory:read',
  'configuration:read',
  'scripts:read',
  'backup-configuration:read',
  'custom-fields:read',
] as const);

// Provisioning write scopes (#3243). Create/update only by design — deletion
// of tenancy stays a human + MFA action on the main API and must never grow a
// scope here. These are opt-in at principal creation and are deliberately NOT
// part of any default scope set.
export const PARTNER_SERVICE_PRINCIPAL_WRITE_SCOPES = Object.freeze([
  'organizations:write',
  'sites:write',
  'enrollment-keys:write',
  // Contract header + line mutations on the Partner API. Opt-in; never part of
  // the Weavestream default. Does not grant lifecycle (activate/pause/cancel)
  // or the human JWT `/api/v1/contracts` surface.
  'contracts:write',
  // Partner API tickets surface: create / update / status / assign / comment.
  // Opt-in; never part of the Weavestream default. No delete, restore,
  // move-org, bulk, attachments, time entries or mailbox — those stay human,
  // MFA-gated actions on the main API. A principal acts as ITSELF here (no
  // human owner is credited — see 2026-12-04-101100-ticket-comments-
  // service-principal-origin.sql); it is not site-restricted.
  'tickets:write',
] as const);

// Opt-in read scopes: grantable, but deliberately NOT in any default scope set.
// alerts:read exposes operational alert titles/messages across every org the
// principal can reach, so it must be requested explicitly.
// device-status:read (#7577) exposes live heartbeat state (online/offline,
// last-seen time, agent version). It is a separate grant, NOT implied by
// devices:read: the material-change export never carries liveness.
export const PARTNER_SERVICE_PRINCIPAL_OPT_IN_READ_SCOPES = Object.freeze([
  'alerts:read',
  // tickets:read exposes ticket subjects, descriptions and comments —
  // customer-authored data — across every org the principal can reach.
  'tickets:read',
  'device-status:read',
] as const);

// Opt-in MCP scopes: admit the principal to the MCP endpoint (/api/v1/mcp)
// with PARTNER scope — every org of the partner its owner can reach. They are
// the same ai:* transport gates an org API key carries and grant NOTHING on
// /api/v1/partner-api. Never part of any default scope set. Per-tool RBAC,
// the Tier 3 approval gate (MCP_UNATTENDED_TIER3_PRINCIPALS `partner_sp:<id>`),
// rate limits, the execution ledger and the audit log still apply over MCP;
// see middleware/partnerServicePrincipalMcpAuth.ts.
export const PARTNER_SERVICE_PRINCIPAL_MCP_SCOPES = Object.freeze([
  'ai:read',
  'ai:write',
  'ai:execute',
  'ai:execute_admin',
] as const);

export const PARTNER_SERVICE_PRINCIPAL_SCOPES = Object.freeze([
  ...PARTNER_SERVICE_PRINCIPAL_READ_SCOPES,
  ...PARTNER_SERVICE_PRINCIPAL_OPT_IN_READ_SCOPES,
  ...PARTNER_SERVICE_PRINCIPAL_WRITE_SCOPES,
  ...PARTNER_SERVICE_PRINCIPAL_MCP_SCOPES,
] as const);

export type PartnerServicePrincipalScope =
  (typeof PARTNER_SERVICE_PRINCIPAL_SCOPES)[number];

export type PartnerServicePrincipalScopePresetId =
  | 'docs-sync'
  | 'provisioning'
  | 'alert-feed'
  | 'ticketing'
  | 'ai-mcp'
  | 'custom';

export type PartnerServicePrincipalScopePreset = {
  readonly id: PartnerServicePrincipalScopePresetId;
  readonly scopes: readonly PartnerServicePrincipalScope[];
};

/**
 * Task-named scope presets for the create dialog (#8173). A preset only fills
 * the checkboxes with scopes that already exist in the registry above; the
 * stored principal keeps no record of which preset was used, and the backend
 * is unchanged. Labels/descriptions live in the web i18n catalog keyed by id.
 *
 * Deliberately generic: no third-party product names (listing one in the app
 * reads as an endorsement). Never pre-select ai:write, ai:execute,
 * ai:execute_admin or contracts:write — those stay a deliberate tick.
 */
export const PARTNER_SERVICE_PRINCIPAL_SCOPE_PRESETS: readonly PartnerServicePrincipalScopePreset[] =
  Object.freeze([
    { id: 'docs-sync', scopes: [...PARTNER_SERVICE_PRINCIPAL_READ_SCOPES] },
    {
      id: 'provisioning',
      scopes: [
        ...PARTNER_SERVICE_PRINCIPAL_READ_SCOPES,
        'organizations:write',
        'sites:write',
        'enrollment-keys:write',
      ],
    },
    { id: 'alert-feed', scopes: ['organizations:read', 'alerts:read'] },
    { id: 'ticketing', scopes: ['organizations:read', 'tickets:read', 'tickets:write'] },
    { id: 'ai-mcp', scopes: ['ai:read'] },
    { id: 'custom', scopes: [] },
  ] satisfies PartnerServicePrincipalScopePreset[]);

/**
 * i18n leaf key for a scope's description. `:` is i18next's namespace
 * separator, so `alerts:read` is stored under `alerts_read`.
 */
export function partnerServicePrincipalScopeI18nKey(scope: string): string {
  return scope.replace(/:/gu, '_');
}
