// Portal visibility flags: the five feature-gate columns on portal_branding
// (Task 3.1) that control which sections of the customer portal an org's
// portal users can reach. This module is the single source of truth for the
// flag key list/type, and hosts the W09 report-provisioning extension seam
// so Task 3.3 (route/nav gating) and the MSP settings route (this task) can
// both import it without owning the provisioning implementation.

import { captureException } from '../sentry';
import { provisionPortalReportDefinitions } from './reportsSelfService';

export const PORTAL_VISIBILITY_FLAG_KEYS = [
  'enableDashboard',
  'enableSecurity',
  'enableBackups',
  'enableReports',
  'enableSupportUsage'
] as const;

export type PortalVisibilityFlag = typeof PORTAL_VISIBILITY_FLAG_KEYS[number];

export type PortalVisibilityFlags = Record<PortalVisibilityFlag, boolean>;

// Called by the org portal-settings PATCH route whenever a visibility flag
// was part of the request body, after the upsert has been persisted. It
// provisions report definitions idempotently whenever
// `requested.enableReports === true`
// (including retries where `current.enableReports` was already true — do
// not skip on that condition, provisioning itself must be idempotent).
export async function onPortalFlagsChanged(args: {
  orgId: string;
  createdBy: string;
  requested: Partial<PortalVisibilityFlags>;
  current: PortalVisibilityFlags;
}): Promise<void> {
  if (args.requested.enableReports !== true) return;

  try {
    await provisionPortalReportDefinitions({
      orgId: args.orgId,
      createdBy: args.createdBy,
    });
  } catch (error) {
    console.error(
      '[portalFlags] Failed to provision portal report definitions',
      { orgId: args.orgId, error },
    );
    captureException(error, undefined, { org_id: args.orgId });
  }
}
