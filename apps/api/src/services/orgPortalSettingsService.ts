/**
 * The org's customer-portal settings (portal_branding): the one read and the
 * one write both doors call — `GET/PATCH /organizations/:id/portal-settings`
 * (routes/orgPortalSettings.ts) and the `manage_org_portal_settings` AI tool
 * (full-control W18 PR B, #6789). Moved from the route verbatim (W07-D2), so
 * the projection, the defaults and the upsert cannot drift between them.
 *
 * The tool adds one rule REST does not need (W18 plan, Fact 1): portal data
 * behind a sensitive flag is shown only while that flag's PARENT gate is on
 * too (`PORTAL_SENSITIVE_PARENTS`), so enabling a parent can expose data whose
 * own flag was switched on long ago and has been dormant since. A supervised
 * `update` may not do that; `refuseSensitiveActivation` makes the check and the
 * write one transaction under the row lock, so a concurrent edit cannot slip a
 * child on between them. REST calls without the option and keeps its single
 * plain upsert: a person on the Branding tab sees every flag they set.
 */
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import { db } from '../db';
import { organizations, partners, portalBranding } from '../db/schema';
import { PORTAL_CHROME_ACCENT_KEYS, updatePortalSettingsSchema } from '@breeze/shared';
import { partnerDocumentBrand } from './partnerDocumentBrand';
import { PORTAL_VISIBILITY_FLAG_KEYS, onPortalFlagsChanged, type PortalVisibilityFlags } from './portal/portalFlags';
import { PORTAL_SENSITIVE_PARENTS } from './portal/portalSensitiveParents';

// chromeAccent is extended in HERE rather than added to
// packages/shared's updatePortalSettingsSchema, so the enum key list
// (PORTAL_CHROME_ACCENT_KEYS) stays the single source of truth without a
// second copy drifting in the shared validator. `.extend()` on a `.strict()`
// zod object preserves both the unknown-key rejection and per-field
// validation (verified: unrecognized keys still 400, and an invalid enum
// value still 400).
export const patchPortalSettingsSchema = updatePortalSettingsSchema.extend({
  chromeAccent: z.enum(PORTAL_CHROME_ACCENT_KEYS).nullable().optional()
});

export type PortalSettingsPatch = z.infer<typeof patchPortalSettingsSchema>;

export {
  PORTAL_SENSITIVE_PARENTS,
  PORTAL_TOOL_SENSITIVE_KEYS,
  type PortalToolSensitiveKey,
} from './portal/portalSensitiveParents';

export const PORTAL_SETTINGS_DEFAULTS = {
  enableTickets: true,
  enableAssetCheckout: false, // parked — see schema/portal.ts
  enableDevices: false,
  enableSelfService: true,
  enablePasswordReset: true,
  enableDashboard: false,
  enableSecurity: false,
  enableBackups: false,
  enableReports: false,
  enableSupportUsage: false,
  enableService: false,
  enableDocuments: false,
  enableLifecycle: false,
  enableHardwareHealth: false,
  enableHardwareInventory: false,
  enablePerformanceMetrics: false,
  enableSoftwareInventory: false,
  enableNetworkVisibility: false,
  enableEdrVisibility: false, // EDR framework W02: strict, fail-closed, inside "Enable all"
  enableNetworkAlerts: false,
  enableHourBlock: false, // block hours (W04): fail-closed, never in "Enable all"
  enablePatchDetail: false, // visibility W05: sensitive, fail-closed, never in "Enable all"
  enableVulnerabilityDetail: false, // visibility W06: sensitive, fail-closed, never in "Enable all"
  enablePhysicalPlacement: false, // environment visibility W1: sensitive, fail-closed, never in "Enable all"
  enableTrustPageEditing: false, // Trust Center W3d: permission flag, fail-closed, never in "Enable all"
  chromeAccent: null,
  supportEmail: null,
  supportPhone: null,
  welcomeMessage: null,
  footerText: null,
  logoUrl: null,
  primaryColor: null,
  secondaryColor: null,
  customCss: null
} as const;

export type PortalSettingsRow = {
  enableTickets: boolean;
  enableAssetCheckout: boolean;
  enableDevices: boolean;
  enableSelfService: boolean;
  enablePasswordReset: boolean;
  enableDashboard: boolean;
  enableSecurity: boolean;
  enableBackups: boolean;
  enableReports: boolean;
  enableSupportUsage: boolean;
  enableService: boolean;
  enableDocuments: boolean;
  enableLifecycle: boolean;
  enableHardwareHealth: boolean;
  enableHardwareInventory: boolean;
  enablePerformanceMetrics: boolean;
  enableSoftwareInventory: boolean;
  enableNetworkVisibility: boolean;
  enableEdrVisibility: boolean;
  enableNetworkAlerts: boolean;
  enableHourBlock: boolean;
  enablePatchDetail: boolean;
  enableVulnerabilityDetail: boolean;
  enablePhysicalPlacement: boolean;
  enableTrustPageEditing: boolean;
  chromeAccent: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  welcomeMessage: string | null;
  footerText: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  customCss: string | null;
};

// Single projection used by BOTH the GET select and the PATCH .returning():
// every column not listed here (faviconUrl, accentColor, customDomain,
// domainVerified) never reaches the app layer on either path, so a toResponse
// refactor can't accidentally leak them. customCss (#5952), primaryColor (#9962),
// logoUrl and secondaryColor (#9673) WERE in that excluded set; all are now managed.
// A function, not a module-scope const: other route tests (orgs.test.ts etc.)
// mock ../db/schema without portalBranding, and an import-time column deref
// would crash their whole file at collection.
export const portalSettingsColumns = () => ({
  enableTickets: portalBranding.enableTickets,
  enableAssetCheckout: portalBranding.enableAssetCheckout,
  enableDevices: portalBranding.enableDevices,
  enableSelfService: portalBranding.enableSelfService,
  enablePasswordReset: portalBranding.enablePasswordReset,
  enableDashboard: portalBranding.enableDashboard,
  enableSecurity: portalBranding.enableSecurity,
  enableBackups: portalBranding.enableBackups,
  enableReports: portalBranding.enableReports,
  enableSupportUsage: portalBranding.enableSupportUsage,
  enableService: portalBranding.enableService,
  enableDocuments: portalBranding.enableDocuments,
  enableLifecycle: portalBranding.enableLifecycle,
  enableHardwareHealth: portalBranding.enableHardwareHealth,
  enableHardwareInventory: portalBranding.enableHardwareInventory,
  enablePerformanceMetrics: portalBranding.enablePerformanceMetrics,
  enableSoftwareInventory: portalBranding.enableSoftwareInventory,
  enableNetworkVisibility: portalBranding.enableNetworkVisibility,
  enableEdrVisibility: portalBranding.enableEdrVisibility,
  enableNetworkAlerts: portalBranding.enableNetworkAlerts,
  enableHourBlock: portalBranding.enableHourBlock,
  enablePatchDetail: portalBranding.enablePatchDetail,
  enableVulnerabilityDetail: portalBranding.enableVulnerabilityDetail,
  enablePhysicalPlacement: portalBranding.enablePhysicalPlacement,
  enableTrustPageEditing: portalBranding.enableTrustPageEditing,
  chromeAccent: portalBranding.chromeAccent,
  supportEmail: portalBranding.supportEmail,
  supportPhone: portalBranding.supportPhone,
  welcomeMessage: portalBranding.welcomeMessage,
  footerText: portalBranding.footerText,
  logoUrl: portalBranding.logoUrl,
  primaryColor: portalBranding.primaryColor,
  secondaryColor: portalBranding.secondaryColor,
  customCss: portalBranding.customCss
});

export function toPortalSettingsResponse(orgId: string, row?: PortalSettingsRow) {
  if (!row) return { orgId, ...PORTAL_SETTINGS_DEFAULTS };
  return {
    orgId,
    enableTickets: row.enableTickets,
    enableAssetCheckout: row.enableAssetCheckout,
    enableDevices: row.enableDevices,
    enableSelfService: row.enableSelfService,
    enablePasswordReset: row.enablePasswordReset,
    enableDashboard: row.enableDashboard,
    enableSecurity: row.enableSecurity,
    enableBackups: row.enableBackups,
    enableReports: row.enableReports,
    enableSupportUsage: row.enableSupportUsage,
    enableService: row.enableService,
    enableDocuments: row.enableDocuments,
    enableLifecycle: row.enableLifecycle,
    enableHardwareHealth: row.enableHardwareHealth,
    enableHardwareInventory: row.enableHardwareInventory,
    enablePerformanceMetrics: row.enablePerformanceMetrics,
    enableSoftwareInventory: row.enableSoftwareInventory,
    enableNetworkVisibility: row.enableNetworkVisibility,
    enableEdrVisibility: row.enableEdrVisibility,
    enableNetworkAlerts: row.enableNetworkAlerts,
    enableHourBlock: row.enableHourBlock,
    enablePatchDetail: row.enablePatchDetail,
    enableVulnerabilityDetail: row.enableVulnerabilityDetail,
    enablePhysicalPlacement: row.enablePhysicalPlacement,
    enableTrustPageEditing: row.enableTrustPageEditing,
    chromeAccent: row.chromeAccent,
    supportEmail: row.supportEmail,
    supportPhone: row.supportPhone,
    welcomeMessage: row.welcomeMessage,
    footerText: row.footerText,
    logoUrl: row.logoUrl,
    primaryColor: row.primaryColor,
    secondaryColor: row.secondaryColor,
    customCss: row.customCss
  };
}

export type PortalSettingsResponse = ReturnType<typeof toPortalSettingsResponse>;

/** The org's portal_branding row through the shared projection, or undefined before the first write. */
export async function readPortalSettingsRow(orgId: string): Promise<PortalSettingsRow | undefined> {
  const rows = await db
    .select(portalSettingsColumns())
    .from(portalBranding)
    .where(eq(portalBranding.orgId, orgId))
    .limit(1);
  return rows[0];
}

/**
 * The org a portal-settings caller may act on: the route's `resolveAccessibleOrg`
 * without a Hono context. A partner caller needs the org in its access list; a
 * missing, deleted and inaccessible org are the same null.
 */
export async function findPortalSettingsOrg(
  auth: Pick<AuthContext, 'scope' | 'canAccessOrg'>,
  orgId: string,
): Promise<{ id: string; partnerId: string } | null> {
  if (auth.scope !== 'partner' && auth.scope !== 'system') return null;
  if (auth.scope === 'partner' && !auth.canAccessOrg(orgId)) return null;
  const [org] = await db
    .select({ id: organizations.id, partnerId: organizations.partnerId })
    .from(organizations)
    .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
    .limit(1);
  return org ? { id: org.id, partnerId: org.partnerId } : null;
}

/** The GET body: the org's settings plus the partner values its blank fields inherit. */
export async function getOrgPortalSettings(org: { id: string; partnerId: string }) {
  const row = await readPortalSettingsRow(org.id);
  // #7510 (settings rule 4): `footerText` is the org override of the
  // partner's document footer (resolveDocumentFooter, documentFooter.ts),
  // so report the inherited partner value for the editor to show beside a
  // blank field. Read-only: not in the PATCH schema, never written here.
  // Read in the AMBIENT request context, like GET /organizations/:id's
  // partnerDefaultTaxRate — the route and the tool require `partner` or
  // `system` scope, and `partners` RLS grants a partner-scoped actor its own row.
  //
  // #9962 (settings rules 4 + 5): `primaryColor` is likewise the org
  // override of the partner's Branding colour on quotes, invoices and the
  // other customer documents (resolveDocumentBrand). The inherited value is
  // resolved by the same partnerDocumentBrand the renderers use, so a
  // partner colour the documents would ignore is reported as none. #9673:
  // the logo and secondary colour follow the same chain.
  const [partnerRow] = await db
    .select({ invoiceFooter: partners.invoiceFooter, settings: partners.settings })
    .from(partners)
    .where(eq(partners.id, org.partnerId))
    .limit(1);
  const partnerBrand = partnerDocumentBrand(partnerRow?.settings);
  // No auto-insert on read: defaults are reported until the first PATCH.
  return {
    ...toPortalSettingsResponse(org.id, row),
    partnerInvoiceFooter: partnerRow?.invoiceFooter ?? null,
    partnerLogoUrl: partnerBrand.logoUrl,
    partnerPrimaryColor: partnerBrand.primaryColor,
    partnerSecondaryColor: partnerBrand.secondaryColor
  };
}

/**
 * The sensitive children a write would ACTIVATE: a parent turned on (it was off)
 * while a child of it is on in the row and the same write does not name that
 * child. A child named in the write is the writer's own explicit choice (the
 * four-eyes card lists it), and a missing row is the defaults (every child off).
 */
export function portalSensitiveActivations(
  body: Partial<Record<string, unknown>>,
  row: Partial<PortalSettingsRow> | undefined,
): string[] {
  const current = { ...PORTAL_SETTINGS_DEFAULTS, ...(row ?? {}) } as Record<string, unknown>;
  const activated: string[] = [];
  for (const [parent, children] of Object.entries(PORTAL_SENSITIVE_PARENTS)) {
    if (body[parent] !== true || current[parent] === true) continue;
    for (const child of children) {
      if (current[child] === true && body[child] === undefined) activated.push(child);
    }
  }
  return activated;
}

export type ApplyPortalSettingsResult =
  | { ok: true; row: PortalSettingsRow; settings: PortalSettingsResponse }
  | { ok: false; code: 'SENSITIVE_ACTIVATION'; children: string[] }
  | { ok: false; code: 'PERSIST_FAILED' };

/**
 * Upsert the org's portal settings, then run the report-provisioning hook for
 * any visibility flag in the body. With `refuseSensitiveActivation`, the write
 * is refused (nothing written) when it would activate a dormant sensitive child
 * (`portalSensitiveActivations`), checked under `SELECT … FOR UPDATE` on the row
 * inside the same transaction as the upsert. A default row is inserted first
 * when none exists, so there is always a row to lock; a refusal can only come
 * from a row that already existed, so that insert never outlives a refusal.
 *
 * `onPersisted` runs once the row is written and BEFORE the provisioning hook,
 * so the caller's audit row lands in the same order the route always wrote it
 * (upsert, audit, hook): a hook failure can never leave a live change unaudited.
 */
export async function applyOrgPortalSettings(
  orgId: string,
  body: PortalSettingsPatch,
  actorUserId: string,
  opts: { refuseSensitiveActivation?: boolean; onPersisted?: (row: PortalSettingsRow) => void } = {},
): Promise<ApplyPortalSettingsResult> {
  let row: PortalSettingsRow | undefined;
  if (opts.refuseSensitiveActivation) {
    const outcome = await db.transaction(async (tx) => {
      await tx.insert(portalBranding).values({ orgId }).onConflictDoNothing();
      const [locked] = await tx
        .select(portalSettingsColumns())
        .from(portalBranding)
        .where(eq(portalBranding.orgId, orgId))
        .limit(1)
        .for('update');
      const children = portalSensitiveActivations(body, locked);
      if (children.length > 0) return { kind: 'refused' as const, children };
      const [written] = await tx
        .insert(portalBranding)
        .values({ orgId, ...body })
        .onConflictDoUpdate({ target: portalBranding.orgId, set: { ...body, updatedAt: new Date() } })
        .returning(portalSettingsColumns());
      return { kind: 'written' as const, written };
    });
    if (outcome.kind === 'refused') return { ok: false, code: 'SENSITIVE_ACTIVATION', children: outcome.children };
    row = outcome.written;
  } else {
    // portal_branding has UNIQUE(org_id) — upsert keeps first-write and
    // subsequent edits on one code path.
    [row] = await db
      .insert(portalBranding)
      .values({ orgId, ...body })
      .onConflictDoUpdate({
        target: portalBranding.orgId,
        set: { ...body, updatedAt: new Date() }
      })
      .returning(portalSettingsColumns());
  }

  if (!row) return { ok: false, code: 'PERSIST_FAILED' };
  opts.onPersisted?.(row);

  const requested = Object.fromEntries(
    PORTAL_VISIBILITY_FLAG_KEYS
      .filter((key) => (body as Record<string, unknown>)[key] !== undefined)
      .map((key) => [key, (body as Record<string, unknown>)[key]])
  ) as Partial<PortalVisibilityFlags>;

  if (Object.keys(requested).length > 0) {
    await onPortalFlagsChanged({
      orgId,
      createdBy: actorUserId,
      requested,
      current: {
        enableDashboard: row.enableDashboard,
        enableSecurity: row.enableSecurity,
        enableBackups: row.enableBackups,
        enableReports: row.enableReports,
        enableSupportUsage: row.enableSupportUsage,
        enableService: row.enableService,
        enableDocuments: row.enableDocuments,
        enableLifecycle: row.enableLifecycle,
        enableHardwareHealth: row.enableHardwareHealth,
        enableHardwareInventory: row.enableHardwareInventory,
        enablePerformanceMetrics: row.enablePerformanceMetrics,
        enableSoftwareInventory: row.enableSoftwareInventory,
        enableNetworkVisibility: row.enableNetworkVisibility,
        enableEdrVisibility: row.enableEdrVisibility
      }
    });
  }

  return { ok: true, row, settings: toPortalSettingsResponse(orgId, row) };
}
