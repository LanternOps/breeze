/**
 * Private Software Download Origin Policy (Wave 6 Task 4, security remediation)
 *
 * Reads/writes the org- and site-scoped `softwareDownloadPolicy` key inside
 * the existing `organizations.settings` / `sites.settings` JSONB columns — no
 * new tenant table, matching the brief. A site's EFFECTIVE policy is the
 * union of its own approved origins plus its organization's (Partner-Wide-
 * First is not in play here: this is a plain org/site union, not a
 * partner-wide dual-ownership table).
 *
 * Task 5 (not this task) sends the effective allowlist with every managed-
 * software command and gates dispatch on the agent's outbound-network-policy
 * capability version.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { organizations, sites } from '../db/schema';
import { encryptColumnValueForWrite } from './encryptedColumnRegistry';
import {
  softwareDownloadPolicySchema,
  type SoftwareDownloadPolicy,
} from '@breeze/shared/validators';

const SETTINGS_KEY = 'softwareDownloadPolicy';

const EMPTY_POLICY: SoftwareDownloadPolicy = { version: 1, approvedPrivateOrigins: [] };

function asSettingsObject(settings: unknown): Record<string, unknown> {
  return settings && typeof settings === 'object' && !Array.isArray(settings)
    ? (settings as Record<string, unknown>)
    : {};
}

/**
 * Extracts and validates the policy embedded at `settings.softwareDownloadPolicy`.
 * A row holding a value that no longer parses (e.g. hand-edited, or written by
 * a future schema version) falls back to the safe empty policy rather than
 * throwing — a read must never 500 because of a stored value it doesn't own
 * exclusively (the settings blob is a general-purpose JSONB column).
 */
function extractPolicy(settings: unknown): SoftwareDownloadPolicy {
  const raw = asSettingsObject(settings)[SETTINGS_KEY];
  if (raw === undefined) return EMPTY_POLICY;
  const parsed = softwareDownloadPolicySchema.safeParse(raw);
  return parsed.success ? parsed.data : EMPTY_POLICY;
}

function dedupeOrigins(a: readonly string[], b: readonly string[]): string[] {
  return Array.from(new Set([...a, ...b])).slice(0, 32);
}

export async function getOrganizationSoftwareDownloadPolicy(
  orgId: string,
): Promise<SoftwareDownloadPolicy> {
  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return extractPolicy(org?.settings);
}

export type SiteSoftwareDownloadPolicyResult =
  | { ok: true; policy: SoftwareDownloadPolicy }
  | { ok: false; error: 'site_not_found' };

/**
 * Reads the site's OWN policy (not the effective union). `orgId` is part of
 * the lookup condition — a site belonging to a different org is treated as
 * not found, the same posture as every other org+site row lookup in this
 * codebase (see routes/software.ts's device/site guards).
 */
export async function getSiteSoftwareDownloadPolicy(
  orgId: string,
  siteId: string,
): Promise<SiteSoftwareDownloadPolicyResult> {
  const [site] = await db
    .select({ settings: sites.settings })
    .from(sites)
    .where(and(eq(sites.id, siteId), eq(sites.orgId, orgId)));
  if (!site) return { ok: false, error: 'site_not_found' };
  return { ok: true, policy: extractPolicy(site.settings) };
}

/**
 * The effective policy for a device-download decision: the org's approved
 * origins, plus (when a site is given) that site's own — deduped, capped at
 * 32 to match the schema's own bound so an org+site sum near the cap can
 * never exceed it downstream.
 */
export async function getEffectiveSoftwareDownloadPolicy(
  orgId: string,
  siteId?: string,
): Promise<SoftwareDownloadPolicy> {
  const orgPolicy = await getOrganizationSoftwareDownloadPolicy(orgId);
  if (!siteId) return orgPolicy;

  const siteResult = await getSiteSoftwareDownloadPolicy(orgId, siteId);
  if (!siteResult.ok) return orgPolicy;

  return {
    version: 1,
    approvedPrivateOrigins: dedupeOrigins(
      orgPolicy.approvedPrivateOrigins,
      siteResult.policy.approvedPrivateOrigins,
    ),
  };
}

export type SetOrganizationSoftwareDownloadPolicyResult =
  | { ok: true; policy: SoftwareDownloadPolicy }
  | { ok: false; error: 'organization_not_found' };

/**
 * Merges `policy` into the organization's settings JSONB at the
 * `softwareDownloadPolicy` key WITHOUT touching any other key — read current
 * settings, spread, overwrite just this one key, write back.
 *
 * Two existence checks, mirroring routes/orgs.ts's PATCH /sites/:id
 * precedent: the initial SELECT missing a row is the ordinary "no such org"
 * case, and a 0-row UPDATE (despite the SELECT having just found one) means
 * the RLS UPDATE policy rejected the write anyway — an RLS/app mismatch or a
 * race, not a normal not-found. Either way, a caller must never see success
 * (and this must never write an audit row) for a write that did not
 * actually persist.
 */
export async function setOrganizationSoftwareDownloadPolicy(
  orgId: string,
  policy: SoftwareDownloadPolicy,
): Promise<SetOrganizationSoftwareDownloadPolicyResult> {
  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  if (!org) return { ok: false, error: 'organization_not_found' };

  const mergedSettings = { ...asSettingsObject(org.settings), [SETTINGS_KEY]: policy };

  // Encrypt secret-bearing fields BEFORE writing — organizations.settings is
  // a registered encrypted-JSON column (encryptedColumnRegistry.ts). Without
  // this, this write would silently re-write the column as plaintext,
  // undoing the at-rest guarantee for any secret already stored under an
  // unrelated settings key (e.g. logForwarding.elasticsearchApiKey).
  const [updated] = await db
    .update(organizations)
    .set({
      settings: encryptColumnValueForWrite('organizations', 'settings', mergedSettings),
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, orgId))
    .returning({ id: organizations.id });
  if (!updated) return { ok: false, error: 'organization_not_found' };

  return { ok: true, policy };
}

export type SetSiteSoftwareDownloadPolicyResult =
  | { ok: true; policy: SoftwareDownloadPolicy; effective: SoftwareDownloadPolicy }
  | { ok: false; error: 'site_not_found' };

/**
 * Merges `policy` into the site's settings JSONB (same unrelated-key-
 * preserving merge as the org writer above), scoped to org+site so a site
 * belonging to a different org is rejected rather than silently written.
 * Returns both the site's own policy and the effective org∪site union — the
 * union is what Task 5's dispatch path will actually use.
 */
export async function setSiteSoftwareDownloadPolicy(
  orgId: string,
  siteId: string,
  policy: SoftwareDownloadPolicy,
): Promise<SetSiteSoftwareDownloadPolicyResult> {
  const [site] = await db
    .select({ settings: sites.settings })
    .from(sites)
    .where(and(eq(sites.id, siteId), eq(sites.orgId, orgId)));
  if (!site) return { ok: false, error: 'site_not_found' };

  const mergedSettings = { ...asSettingsObject(site.settings), [SETTINGS_KEY]: policy };

  // Encrypt secret-bearing fields BEFORE writing — sites.settings is a
  // registered encrypted-JSON column (encryptedColumnRegistry.ts). Same
  // rationale as the organization writer above.
  await db
    .update(sites)
    .set({
      settings: encryptColumnValueForWrite('sites', 'settings', mergedSettings),
      updatedAt: new Date(),
    })
    .where(and(eq(sites.id, siteId), eq(sites.orgId, orgId)));

  const orgPolicy = await getOrganizationSoftwareDownloadPolicy(orgId);
  const effective: SoftwareDownloadPolicy = {
    version: 1,
    approvedPrivateOrigins: dedupeOrigins(orgPolicy.approvedPrivateOrigins, policy.approvedPrivateOrigins),
  };

  return { ok: true, policy, effective };
}
