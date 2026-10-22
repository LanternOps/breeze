import type { MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { portalBranding } from '../../db/schema';
import type { PortalVisibilityFlag } from '../../services/portal/portalFlags';
import {
  decidePortalTrustPageEditor,
  type PortalTrustEditorUser,
} from '../../services/portal/trustPageEditor';

// Network Visibility is deliberately excluded from the generic strict
// 403 gate. Its approved shared contract represents disabled availability
// as dataStatus: 'not_enabled' with null metrics.
//
// Widened (visibility W05, #7735) with the sensitive flags that DO use the 403
// gate: enablePatchDetail and enableVulnerabilityDetail (W06, #7736).
// enableNetworkAlerts stays out like enableNetworkVisibility: it omits fields
// when off instead of answering 403.
export type StrictPortalVisibilityFlag =
  | Exclude<PortalVisibilityFlag, 'enableNetworkVisibility'>
  | 'enablePatchDetail'
  | 'enableVulnerabilityDetail';

// Fail-closed gates that are NOT part of the "Enable all" visibility set
// (PORTAL_VISIBILITY_FLAG_KEYS). Each is independent and billing-sensitive:
// enableHourBlock exposes a prepaid-hours balance (block hours W04).
export type StrictPortalGateFlag = StrictPortalVisibilityFlag | 'enableHourBlock';

type PortalBooleanSetting = 'enableAssetCheckout' | 'enableSelfService';

type PortalFeatureGateOptions = {
  setting: PortalBooleanSetting;
  error: string;
  code: string;
};

/**
 * Build an org-scoped portal feature gate. A missing settings row preserves the
 * schema default behavior (enabled); only an explicit false disables access.
 */
export function createPortalFeatureGate({ setting, error, code }: PortalFeatureGateOptions): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get('portalAuth');
    if (!auth) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const [row] = await db
      .select({ [setting]: portalBranding[setting] })
      .from(portalBranding)
      .where(eq(portalBranding.orgId, auth.user.orgId))
      .limit(1);

    if (row?.[setting] === false) {
      return c.json({ error, code }, 403);
    }

    return next();
  };
}

export const portalAssetCheckoutEnabledMiddleware = createPortalFeatureGate({
  setting: 'enableAssetCheckout',
  error: 'Asset checkout is not enabled for this portal',
  code: 'PORTAL_ASSET_CHECKOUT_DISABLED',
});

// Devices visibility is independent of self-service. Keep the legacy default
// (missing settings = self-service enabled) for existing portals.
export const portalDevicesEnabledMiddleware: MiddlewareHandler = async (c, next) => {
  const auth = c.get('portalAuth');
  if (!auth) return c.json({ error: 'Authentication required' }, 401);

  const [row] = await db
    .select({
      enableDevices: portalBranding.enableDevices,
      enableSelfService: portalBranding.enableSelfService,
    })
    .from(portalBranding)
    .where(eq(portalBranding.orgId, auth.user.orgId))
    .limit(1);

  if (row?.enableDevices !== true && row?.enableSelfService === false) {
    return c.json({
      error: 'Device visibility is not enabled for this portal',
      code: 'PORTAL_SELF_SERVICE_DISABLED',
    }, 403);
  }
  return next();
};

// Strict W03 visibility gates (Task 3.3): unlike createPortalFeatureGate above
// (missing row/default = enabled), these fail CLOSED — a missing
// portal_branding row or an explicit false both return 403. Every existing
// org defaults to false on all five columns (Task 3.1), so this is the
// correct default-deny posture for newly introduced portal sections.
const STRICT_PORTAL_FEATURES: Record<StrictPortalGateFlag,{ error: string; code: string }> = {
  enableDashboard: {
    error: 'Dashboard is not enabled for this portal',
    code: 'PORTAL_DASHBOARD_DISABLED',
  },
  enableSecurity: {
    error: 'Security visibility is not enabled for this portal',
    code: 'PORTAL_SECURITY_DISABLED',
  },
  enableBackups: {
    error: 'Backup visibility is not enabled for this portal',
    code: 'PORTAL_BACKUPS_DISABLED',
  },
  enableReports: {
    error: 'Reports are not enabled for this portal',
    code: 'PORTAL_REPORTS_DISABLED',
  },
  enableSupportUsage: {
    error: 'Support usage is not enabled for this portal',
    code: 'PORTAL_SUPPORT_USAGE_DISABLED',
  },
  enableService: {
    error: 'Service delivery is not enabled for this portal',
    code: 'PORTAL_SERVICE_DISABLED',
  },
  enableDocuments: {
    error: 'Documents are not enabled for this portal',
    code: 'PORTAL_DOCUMENTS_DISABLED',
  },
  enableLifecycle: {
    error: 'Hardware lifecycle is not enabled for this portal',
    code: 'PORTAL_LIFECYCLE_DISABLED',
  },
  enableHardwareHealth: {
    error: 'Hardware health is not enabled for this portal',
    code: 'PORTAL_HARDWARE_HEALTH_DISABLED',
  },
  enableHardwareInventory: {
    error: 'Hardware inventory is not enabled for this portal',
    code: 'PORTAL_HARDWARE_INVENTORY_DISABLED',
  },
  enablePerformanceMetrics: {
    error: 'Performance metrics are not enabled for this portal',
    code: 'PORTAL_PERFORMANCE_METRICS_DISABLED',
  },
  enableSoftwareInventory: {
    error: 'Software inventory is not enabled for this portal',
    code: 'PORTAL_SOFTWARE_INVENTORY_DISABLED',
  },
  enablePatchDetail: {
    error: 'Patch detail is not enabled for this portal',
    code: 'PORTAL_PATCH_DETAIL_DISABLED',
  },
  enableVulnerabilityDetail: {
    error: 'Vulnerability detail is not enabled for this portal',
    code: 'PORTAL_VULNERABILITY_DETAIL_DISABLED',
  },
  // EDR provider framework W02 (#8166). No portal route is mounted behind this
  // gate: it controls whether EDR state feeds the security read model. The
  // entry exists so the flag is a registered strict portal feature and the
  // portal knows the code (visibilityGate.ts parity).
  enableEdrVisibility: {
    error: 'Managed endpoint protection is not enabled for this portal',
    code: 'PORTAL_EDR_VISIBILITY_DISABLED',
  },
  enableHourBlock: {
    error: 'Support hours are not enabled for this portal',
    code: 'PORTAL_HOUR_BLOCK_DISABLED',
  },
};

export function createPortalFeatureGateStrict(flag: StrictPortalGateFlag): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get('portalAuth');
    if (!auth) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const [row] = await db
      .select({ [flag]: portalBranding[flag] })
      .from(portalBranding)
      .where(eq(portalBranding.orgId, auth.user.orgId))
      .limit(1);

    if (row?.[flag] !== true) {
      return c.json(STRICT_PORTAL_FEATURES[flag], 403);
    }

    return next();
  };
}

/**
 * Passes when ANY of `flags` is true on the org's portal_branding row. Still
 * fail-closed: a missing row or all-false refuses, answering with the FIRST
 * flag's message so the customer is told about the surface they asked for.
 *
 * The one legitimate use is the document CONTENT route: spec §8 publishes a
 * portal-visible document as delivery evidence under enable_service even when
 * enable_documents (the library page) is off, so the bytes must stay reachable
 * under either flag while the library listing stays gated on its own.
 */
export function createPortalFeatureGateAny(
  ...flags: readonly [StrictPortalVisibilityFlag, ...StrictPortalVisibilityFlag[]]
): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get('portalAuth');
    if (!auth) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const [row] = await db
      .select(Object.fromEntries(flags.map((f) => [f, portalBranding[f]])))
      .from(portalBranding)
      .where(eq(portalBranding.orgId, auth.user.orgId))
      .limit(1);

    if (flags.some((f) => (row as Record<string, unknown> | undefined)?.[f] === true)) {
      return next();
    }

    return c.json(STRICT_PORTAL_FEATURES[flags[0]], 403);
  };
}

/**
 * THE gate table (#9350): the single source of truth mapping a portal section
 * to the strict visibility flag(s) that gate it. `routes/portal/index.ts`
 * mounts every route gate from this list, and the staff "Customer view"
 * preview (`services/portal/portalPreview.ts`) reads the same rows to decide
 * which sections are enabled — so the portal and the preview cannot disagree.
 * `portalSectionGates.contract.test.ts` fails if a section router has no row.
 *
 * `flags` are ALL required (fail-closed), checked in order. `customMount` rows
 * are still gated through `portalSectionGate(key)` but are mounted by hand in
 * index.ts because their position relative to other middleware matters.
 */
export type PortalSectionGateRow = {
  key: string;
  /** Path prefix under /api/v1/portal, no trailing slash or wildcard. */
  pathPrefix: string;
  flags: readonly [StrictPortalGateFlag, ...StrictPortalGateFlag[]];
  /** The router file that serves this prefix (relative to routes/portal). */
  routeFile: string;
  /** Mount `pathPrefix` itself, not `pathPrefix/*`. */
  exact?: boolean;
  /** Skip portalAuthMiddleware: an ancestor row already applies it. */
  inheritsAuth?: boolean;
  /** index.ts mounts this row by hand (see portalSectionGate). */
  customMount?: boolean;
};

export const PORTAL_SECTION_GATES = [
  { key: 'dashboard', pathPrefix: '/dashboard', flags: ['enableDashboard'], routeFile: 'dashboard.ts' },
  { key: 'security', pathPrefix: '/security', flags: ['enableSecurity'], routeFile: 'security.ts' },
  { key: 'backups', pathPrefix: '/backups', flags: ['enableBackups'], routeFile: 'backups.ts' },
  { key: 'reports', pathPrefix: '/reports', flags: ['enableReports'], routeFile: 'reports.ts' },
  // Narrower second gate: /reports/lifecycle/* needs enableReports (above,
  // registered first) AND enableLifecycle.
  { key: 'lifecycleReports', pathPrefix: '/reports/lifecycle', flags: ['enableLifecycle'], routeFile: 'reports.ts', inheritsAuth: true },
  { key: 'service', pathPrefix: '/service', flags: ['enableService'], routeFile: 'service.ts' },
  { key: 'hardwareHealth', pathPrefix: '/hardware-health', flags: ['enableHardwareHealth'], routeFile: 'hardwareHealth.ts' },
  { key: 'hardwareInventory', pathPrefix: '/hardware-inventory', flags: ['enableHardwareInventory'], routeFile: 'hardwareInventory.ts' },
  { key: 'performance', pathPrefix: '/performance', flags: ['enablePerformanceMetrics'], routeFile: 'performance.ts' },
  { key: 'software', pathPrefix: '/software', flags: ['enableSoftwareInventory'], routeFile: 'software.ts' },
  { key: 'patches', pathPrefix: '/patches', flags: ['enablePatchDetail'], routeFile: 'patches.ts' },
  { key: 'vulnerabilities', pathPrefix: '/vulnerabilities', flags: ['enableVulnerabilityDetail'], routeFile: 'vulnerabilities.ts' },
  // Block hours W04: the "Support hours" card lives inside Support usage, so
  // its endpoint needs BOTH fail-closed flags. A separate prefix on purpose:
  // nesting under /tickets/* would inherit the enable_tickets gate.
  { key: 'supportUsage', pathPrefix: '/support-usage', flags: ['enableSupportUsage', 'enableHourBlock'], routeFile: 'hourBlock.ts' },
  // Library listing only; the CONTENT path also opens under enableService
  // (documentBytesGate in index.ts). Mounted by hand next to that wrapper.
  { key: 'documents', pathPrefix: '/documents', flags: ['enableDocuments'], routeFile: 'documents.ts', customMount: true },
  // Exact-path wrapper that must run before the generic /tickets/* middleware.
  { key: 'ticketUsage', pathPrefix: '/tickets/usage', flags: ['enableSupportUsage'], routeFile: 'tickets.ts', exact: true, customMount: true },
] as const satisfies readonly PortalSectionGateRow[];

export type PortalSectionKey = typeof PORTAL_SECTION_GATES[number]['key'];

/** The gate middleware (all of the row's flags, in order) for one table row. */
export function portalSectionGate(key: PortalSectionKey): MiddlewareHandler {
  const row = (PORTAL_SECTION_GATES as readonly PortalSectionGateRow[]).find((g) => g.key === key);
  if (!row) throw new Error(`Unknown portal section gate: ${key}`);
  const gates = row.flags.map((flag) => createPortalFeatureGateStrict(flag));
  return async (c, next) => {
    const run = async (i: number): Promise<Response | void> => {
      const gate = gates[i];
      if (!gate) return next();
      // A gate that refuses returns its 403; propagate it as the response
      // (what Hono's own compose does) instead of swallowing it in `next`.
      return gate(c, async () => {
        const downstream = await run(i + 1);
        if (downstream instanceof Response) c.res = downstream;
      });
    };
    return run(0);
  };
}

// Trust Center W3d (#8771): a PERMISSION gate, not a visibility gate. Passes
// only when the org's enable_trust_page_editing flag is on AND the portal user
// is an active org-scoped admin contact (services/portal/trustPageEditor.ts).
// Re-checked on every request, never cached in the session. The two refusals
// carry distinct codes so the portal page can tell "your provider has not
// turned this on" from "you are not an admin contact".
const PORTAL_TRUST_EDITOR_ERRORS = {
  PORTAL_TRUST_EDITING_DISABLED: 'Trust page editing is not enabled for this portal',
  PORTAL_TRUST_EDITOR_REQUIRED: "Only your organization's admin contacts can edit the trust page",
} as const;

export const requirePortalTrustPageEditor: MiddlewareHandler = async (c, next) => {
  const auth = c.get('portalAuth');
  if (!auth) {
    return c.json({ error: 'Authentication required' }, 401);
  }
  // Draft state and revision numbers are per-viewer and change under the user.
  c.header('Cache-Control', 'no-store');
  const decision = await decidePortalTrustPageEditor({ id: auth.user.id, orgId: auth.user.orgId });
  if (!decision.allowed) {
    return c.json({ error: PORTAL_TRUST_EDITOR_ERRORS[decision.code], code: decision.code }, 403);
  }
  return next();
};

/**
 * Per-user portal capabilities (as opposed to the org-level flags on the
 * branding row). `canEditTrustPage` decides whether the portal shows the
 * "Trust page" nav entry; the routes re-check it on every request.
 */
export async function resolvePortalCapabilities(user: PortalTrustEditorUser): Promise<{ canEditTrustPage: boolean }> {
  const decision = await decidePortalTrustPageEditor(user);
  return { canEditTrustPage: decision.allowed };
}
