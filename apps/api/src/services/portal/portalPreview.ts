import { eq, sql, type SQL } from 'drizzle-orm';
import { PERMISSION_GRANTS } from '@breeze/shared';
import { db } from '../../db';
import { portalBranding } from '../../db/schema';
import {
  PORTAL_SECTION_GATES,
  portalSectionEffectiveFlags,
  type StaffGrant,
  type PortalSectionGateRow,
  type PortalSectionKey,
} from '../../routes/portal/featureFlags';
import { portalDashboardTicketScope } from '../../routes/portal/ticketReadAccess';
import { backupOverview } from './backupReadModel';
import { dashboardForOrg } from './dashboard';
import { documentsForOrg } from './documentsReadModel';
import { listPortalRuns } from './reportsSelfService';
import { securityOverview } from './securityReadModel';
import { serviceOverview } from './serviceReadModel';
import { resolveOrgTimezone } from './timezone';

/**
 * Staff "Customer view" (#9350, option a): a READ-ONLY render of what the
 * customer portal would show, built by calling the very same per-section read
 * models the portal routes call, gated by the very same table
 * (PORTAL_SECTION_GATES). It never mints a portal credential and never writes.
 *
 * Runs in the CALLER's request DB context — no system context. The route has
 * already checked org access; RLS on the partner axis is the real fence.
 */

export type PreviewPortalUser = {
  id: string;
  contactId: string | null;
  name: string | null;
  email: string;
};

export type PreviewSection = {
  key: PortalSectionKey;
  enabled: boolean;
  /** False when the gate table has the row but no preview read model is wired
   *  yet: `enabled` still reports the flag, `data` is null. */
  previewAvailable: boolean;
  data: unknown | null;
  note?: string;
  /** Set when the section is on but its read model threw. */
  error?: 'load_failed';
  /** Set when the caller lacks the staff permission(s) that gate this data (never read). */
  reason?: 'permission';
  /** The staff permissions the caller is missing, for the "you need X" message.
   *  With reason:'permission' the whole section is withheld; on the dashboard
   *  it lists the permissions whose TILES were omitted (section still rendered). */
  missingPermissions?: string[];
};

export type ReadinessCode =
  | 'documents_empty'
  | 'reports_empty'
  | 'service_one_time_visible'
  | 'backups_no_data'
  | 'dashboard_security_no_data'
  | 'branding_unset';

export type ReadinessCheck = {
  code: ReadinessCode;
  message: string;
  /** Org record tab where the MSP fixes it (web maps to a link). */
  fixTab: 'documents' | 'reports' | 'service' | 'backups' | 'security' | 'portal';
};

export type PortalPreview = {
  timezone: string;
  portalUser: { id: string; name: string | null; email: string } | null;
  sections: PreviewSection[];
  readiness: ReadinessCheck[];
};

type RunnerCtx = { orgId: string; timezone: string; now: Date; portalUser: PreviewPortalUser | null; can: StaffCan };
type Runner = (ctx: RunnerCtx) => Promise<{ data: unknown; note?: string; missingPermissions?: string[] }>;

// Which dashboard keys depend on WHO is looking (ticket ownership).
const NO_USER_NOTE =
  'Ticket-scoped data (open tickets) is omitted: pick a portal user to see what that person sees.';

/** Does the caller hold a staff permission? (resource, action) -> boolean. */
export type StaffCan = (resource: string, action: string) => boolean;

/**
 * Dashboard tiles sourced from OTHER domains, and the staff permission(s) that
 * gate that domain on the staff side. A tile is dropped (the rest of the
 * dashboard stays) when the caller lacks any. securityScore / devicesProtected /
 * patchesApplied / actionItems are device data, covered by the row's devices:read.
 */
const DASHBOARD_TILE_PERMISSIONS: Record<string, readonly StaffGrant[]> = {
  backup: [PERMISSION_GRANTS.BACKUP_READ],
  support: [PERMISSION_GRANTS.TICKETS_READ],
  service: [PERMISSION_GRANTS.CONTRACTS_READ],
  awaitingYou: [PERMISSION_GRANTS.INVOICES_READ, PERMISSION_GRANTS.QUOTES_READ],
};

/** Keys covered by the dashboard row's devices:read. ALLOWLIST: any dashboard key
 *  not here and not in DASHBOARD_TILE_PERMISSIONS is dropped, so a future tile
 *  added to DashboardDto fails closed instead of leaking to devices:read holders. */
const DASHBOARD_DEVICE_KEYS = ['asOf', 'timezone', 'securityScore', 'devicesProtected', 'patchesApplied', 'actionItems'] as const;

const RUNNERS: Partial<Record<PortalSectionKey, Runner>> = {
  dashboard: async ({ orgId, timezone, now, portalUser, can }) => {
    // Without a user there is no ownership predicate; `false` matches nothing,
    // and the support tile it feeds is dropped rather than shown as a bogus 0.
    // #8972: the portal dashboard's own ticket set (incl. survivors of merged tickets).
    const ownership: SQL = portalUser ? portalDashboardTicketScope(portalUser) : sql`false`;
    const dto = await dashboardForOrg(orgId, { timezone, now }, ownership);
    const full = dto as unknown as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    for (const k of DASHBOARD_DEVICE_KEYS) if (k in full) data[k] = full[k];
    const notes: string[] = [];
    const missing = new Set<string>();
    for (const [tile, perms] of Object.entries(DASHBOARD_TILE_PERMISSIONS)) {
      const lacking = perms.filter((p) => !can(p.resource, p.action));
      if (lacking.length > 0) {
        lacking.forEach((p) => missing.add(`${p.resource}:${p.action}`));
      } else if (tile in full) {
        data[tile] = full[tile];
      }
    }
    if (!portalUser) {
      delete data.support;
      notes.push(NO_USER_NOTE);
    }
    return {
      data,
      ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
      ...(missing.size > 0 ? { missingPermissions: [...missing] } : {}),
    };
  },
  security: async ({ orgId, timezone, now }) => ({
    data: await securityOverview(orgId, { days: 30, timezone, now }),
  }),
  backups: async ({ orgId, timezone, now }) => ({
    data: await backupOverview(orgId, { timezone, now }),
  }),
  reports: async ({ orgId, timezone }) => ({
    data: await listPortalRuns(orgId, timezone, { page: 1, limit: 20 }),
  }),
  service: async ({ orgId, timezone, now }) => ({
    data: await serviceOverview(orgId, { timezone, now }),
  }),
  documents: async ({ orgId, timezone, now }) => ({
    data: await documentsForOrg(orgId, { timezone, now }),
  }),
};

export const PORTAL_PREVIEW_SECTION_KEYS = Object.keys(RUNNERS) as PortalSectionKey[];

const BRANDING_FIELDS = ['logoUrl', 'primaryColor', 'welcomeMessage', 'supportEmail', 'supportPhone'] as const;

function sectionOf(sections: readonly PreviewSection[], key: string) {
  const s = sections.find((x) => x.key === key);
  return s && s.enabled && s.data ? (s.data as Record<string, any>) : null;
}

/** Pure: the "will this look empty to the customer?" checks (issue #9350 §3). */
export function computeReadiness(args: {
  sections: readonly PreviewSection[];
  brandingSet: boolean;
}): ReadinessCheck[] {
  const out: ReadinessCheck[] = [];

  const docs = sectionOf(args.sections, 'documents');
  if (docs) {
    const count = ((docs.groups ?? []) as Array<{ documents?: unknown[] }>)
      .reduce((n, g) => n + (g.documents?.length ?? 0), 0);
    if (count === 0) {
      out.push({
        code: 'documents_empty',
        message: 'Documents is on, but no document is marked Visible in portal, so your customer sees an empty library.',
        fixTab: 'documents',
      });
    }
  }

  const reports = sectionOf(args.sections, 'reports');
  if (reports && (reports.pagination?.total ?? (reports.data ?? []).length) === 0) {
    out.push({
      code: 'reports_empty',
      message: 'Reports is on, but there are no report runs yet, so your customer sees an empty list.',
      fixTab: 'reports',
    });
  }

  const service = sectionOf(args.sections, 'service');
  if (service) {
    const hasOneTime = ((service.groups ?? []) as Array<{ deliverables?: Array<{ cadence?: string }> }>)
      .some((g) => (g.deliverables ?? []).some((d) => d.cadence === 'one_time'));
    if (hasOneTime) {
      out.push({
        code: 'service_one_time_visible',
        message: 'Service is on and one-time items are still visible to your customer. Hide finished one-time items if they should not appear.',
        fixTab: 'service',
      });
    }
  }

  const backups = sectionOf(args.sections, 'backups');
  if (backups && (backups.dataStatus === 'not_configured' || backups.dataStatus === 'no_data')) {
    out.push({
      code: 'backups_no_data',
      message: 'Backups is on, but there is no backup data to show yet (not configured or no results).',
      fixTab: 'backups',
    });
  }

  const dash = sectionOf(args.sections, 'dashboard');
  if (dash && dash.securityScore && dash.securityScore.status !== 'ok') {
    out.push({
      code: 'dashboard_security_no_data',
      message: 'Dashboard is on, but the security score has no data yet, so that tile is blank for your customer.',
      fixTab: 'security',
    });
  }

  if (!args.brandingSet) {
    out.push({
      code: 'branding_unset',
      message: 'Portal branding has never been set (logo, colors, welcome message or support contact).',
      fixTab: 'portal',
    });
  }

  return out;
}

export async function buildPortalPreview(args: {
  orgId: string;
  portalUser: PreviewPortalUser | null;
  /** The staff caller's permission check. Each section is withheld (and its read model never called) unless the caller holds the row's staffPermissions. */
  can: StaffCan;
  now?: Date;
}): Promise<PortalPreview> {
  const now = args.now ?? new Date();

  const flagColumns = Object.fromEntries(
    [...new Set(PORTAL_SECTION_GATES.flatMap((g) => g.flags))].map((f) => [f, portalBranding[f]]),
  );
  const brandingColumns = Object.fromEntries(BRANDING_FIELDS.map((f) => [f, portalBranding[f]]));
  const [row] = (await db
    .select({ ...flagColumns, ...brandingColumns })
    .from(portalBranding)
    .where(eq(portalBranding.orgId, args.orgId))
    .limit(1)) as Array<Record<string, unknown>>;

  const timezone = await resolveOrgTimezone(args.orgId);
  const ctx: RunnerCtx = {
    orgId: args.orgId,
    timezone,
    now,
    portalUser: args.portalUser,
    can: args.can,
  };

  // Same rule as createPortalFeatureGateStrict: every flag must be an explicit
  // true; a missing row is fail-closed.
  const sections: PreviewSection[] = [];
  for (const gate of PORTAL_SECTION_GATES as readonly PortalSectionGateRow[]) {
    const key = gate.key as PortalSectionKey;
    const enabled = portalSectionEffectiveFlags(gate).every((f) => row?.[f] === true);
    const runner = RUNNERS[key];
    // Permission gate BEFORE anything else: organizations:read (the route gate)
    // is not enough to see data the staff routes gate on a stronger permission.
    const missing = gate.staffPermissions.filter((p) => !args.can(p.resource, p.action));
    if (missing.length > 0) {
      sections.push({
        key,
        enabled,
        previewAvailable: false,
        data: null,
        reason: 'permission',
        missingPermissions: missing.map((p) => `${p.resource}:${p.action}`),
      });
      continue;
    }
    if (!enabled) {
      sections.push({ key, enabled: false, previewAvailable: Boolean(runner), data: null });
      continue;
    }
    if (!runner) {
      sections.push({ key, enabled: true, previewAvailable: false, data: null });
      continue;
    }
    try {
      const { data, note, missingPermissions } = await runner(ctx);
      sections.push({
        key, enabled: true, previewAvailable: true, data,
        ...(note ? { note } : {}),
        ...(missingPermissions ? { missingPermissions } : {}),
      });
    } catch (err) {
      // One broken read model must not blank the whole preview, and must not
      // read as "empty": the section reports the failure and feeds no
      // readiness check (data stays null).
      console.error('[portalPreview] section failed', { key, orgId: args.orgId, err });
      sections.push({ key, enabled: true, previewAvailable: true, data: null, error: 'load_failed' });
    }
  }

  const brandingSet = Boolean(row) && BRANDING_FIELDS.some((f) => {
    const v = row![f];
    return typeof v === 'string' && v.length > 0;
  });

  return {
    timezone,
    portalUser: args.portalUser
      ? { id: args.portalUser.id, name: args.portalUser.name, email: args.portalUser.email }
      : null,
    sections,
    readiness: computeReadiness({ sections, brandingSet }),
  };
}
