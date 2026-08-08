/**
 * Shared org import pipeline: preview → commit (issue #3242, epic #3249).
 *
 * Resolution order per row group: `(partner_id, system, external_id)` against
 * organization_external_links (unioned with the legacy `accounting_*` columns
 * until those are dropped), else normalised name within the partner. Name
 * matches are advisory — commit refuses them without an explicit client
 * acknowledgement — and matches against soft-deleted orgs are refused unless
 * the caller explicitly opts to reactivate.
 *
 * All tenant-creation writes run inside
 * `runOutsideDbContext(() => withSystemDbAccessContext(...))` — the new org's
 * id cannot be in the caller's accessible_org_ids yet (same escape as
 * routes/orgs.ts POST /organizations and the QuickBooks importer). The
 * caller's partner/system authority is enforced at the route.
 *
 * Design: docs/superpowers/specs/onboarding-signup/2026-08-08-bulk-org-site-import-design.md
 */

import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizations, organizationExternalLinks, sites } from '../../db/schema';
import { isPgUniqueViolation } from '../../utils/pgErrors';
import { restoreOrganizationTenantAccess } from '../tenantLifecycle';
import { generateUniqueSlug, slugify } from './slug';
import type {
  AnnotatedRow,
  CommitRowInput,
  ImportRow,
  OrgImportActor,
  OrgImportMode,
  OrgImportSummary,
  RowAnnotation,
} from './types';

export { generateUniqueSlug, slugify } from './slug';
export type * from './types';

export const DEFAULT_IMPORT_SYSTEM = 'csv';
export const MAX_IMPORT_ROWS = 1000;

/** Whitespace-insensitive, case-insensitive name key for the fallback match. */
export function normalizeOrgName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

// Column-width clamp, same rationale as the QuickBooks importer: an over-long
// value throws and rolls back the whole insert, dropping an otherwise-valid row.
function clamp(value: string | undefined | null, max: number): string | null {
  if (value == null) return null;
  return value.length > max ? value.slice(0, max) : value;
}

interface ExistingOrg {
  id: string;
  name: string;
  slug: string;
  type: string;
  deletedAt: Date | null;
}

interface PartnerState {
  orgs: ExistingOrg[];
  orgById: Map<string, ExistingOrg>;
  /** `${system}\u0000${externalId}` → orgId (link table ∪ legacy accounting columns). */
  linkByKey: Map<string, string>;
  /** normalised name → matching non-quick_support orgs. */
  orgsByName: Map<string, ExistingOrg[]>;
  /** Every slug under the partner (incl. soft-deleted), for collision avoidance. */
  slugs: Set<string>;
}

// NUL-escape separator: it cannot occur in either part (Postgres text forbids
// NUL), so ('a b', 'c') and ('a', 'b c') can never collide.
function linkKey(system: string, externalId: string): string {
  return `${system}\u0000${externalId}`;
}

async function loadPartnerState(partnerId: string): Promise<PartnerState> {
  const { orgs, links } = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const orgRows = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        type: organizations.type,
        deletedAt: organizations.deletedAt,
        accountingProvider: organizations.accountingProvider,
        accountingExternalId: organizations.accountingExternalId,
      })
      .from(organizations)
      .where(eq(organizations.partnerId, partnerId));
    const linkRows = await db
      .select({
        orgId: organizationExternalLinks.orgId,
        system: organizationExternalLinks.system,
        externalId: organizationExternalLinks.externalId,
      })
      .from(organizationExternalLinks)
      .where(eq(organizationExternalLinks.partnerId, partnerId));
    return { orgs: orgRows, links: linkRows };
  }));

  const orgById = new Map<string, ExistingOrg>();
  const orgsByName = new Map<string, ExistingOrg[]>();
  const linkByKey = new Map<string, string>();
  const slugs = new Set<string>();

  for (const org of orgs) {
    orgById.set(org.id, org);
    slugs.add(org.slug);
    if (org.type !== 'quick_support') {
      const key = normalizeOrgName(org.name);
      const list = orgsByName.get(key) ?? [];
      list.push(org);
      orgsByName.set(key, list);
    }
    // Legacy single-valued linkage — unioned so orgs linked by either
    // mechanism match (the migration backfills, the QB importer dual-writes,
    // but a link row can still be missing on a not-yet-migrated database).
    if (org.accountingProvider && org.accountingExternalId) {
      const key = linkKey(org.accountingProvider, org.accountingExternalId);
      if (!linkByKey.has(key)) linkByKey.set(key, org.id);
    }
  }
  // The link table wins over the legacy columns on conflict.
  for (const link of links) {
    linkByKey.set(linkKey(link.system, link.externalId), link.orgId);
  }

  return { orgs, orgById, linkByKey, orgsByName, slugs };
}

interface NormalizedRow {
  index: number;
  row: ImportRow;
  organization: string;
  normalizedName: string;
  site: string | null;
  system: string;
  externalId: string | null;
  /** Set when the row is malformed or ambiguous within the batch. */
  conflictReason?: string;
}

interface RowGroup {
  /** Rows sharing one target organization. */
  rows: NormalizedRow[];
  organization: string;
  normalizedName: string;
  system: string;
  externalId: string | null;
  annotation: RowAnnotation;
  organizationId: string | null;
  matchedOrganizationName?: string;
  conflictReason?: string;
  slug: string | null;
}

function normalizeRows(rows: ImportRow[]): NormalizedRow[] {
  return rows.map((row, index) => {
    const organization = (row.organization ?? '').trim();
    const site = row.site?.trim() || null;
    const system = row.externalSystem?.trim() || DEFAULT_IMPORT_SYSTEM;
    const externalId = row.externalId?.trim() || null;
    return {
      index,
      row,
      organization,
      normalizedName: normalizeOrgName(organization),
      site,
      system,
      externalId,
      ...(organization ? {} : { conflictReason: 'Missing organization name' }),
    };
  });
}

/**
 * Group rows targeting the same organization. Grouping key is
 * `(system, externalId)` when present, else the normalised name; rows without
 * an externalId join a same-named externalId group when exactly one exists.
 */
function groupRows(normalized: NormalizedRow[]): { groups: RowGroup[]; rowGroup: Map<number, RowGroup> } {
  const groups: RowGroup[] = [];
  const byExternal = new Map<string, RowGroup>();
  const byName = new Map<string, RowGroup[]>();
  const rowGroup = new Map<number, RowGroup>();

  const newGroup = (r: NormalizedRow, externalId: string | null): RowGroup => {
    const group: RowGroup = {
      rows: [],
      organization: r.organization,
      normalizedName: r.normalizedName,
      system: r.system,
      externalId,
      annotation: 'create',
      organizationId: null,
      slug: null,
    };
    groups.push(group);
    const list = byName.get(r.normalizedName) ?? [];
    list.push(group);
    byName.set(r.normalizedName, list);
    return group;
  };

  // Pass 1: externalId-keyed groups.
  for (const r of normalized) {
    if (r.conflictReason || !r.externalId) continue;
    const key = linkKey(r.system, r.externalId);
    let group = byExternal.get(key);
    if (!group) {
      group = newGroup(r, r.externalId);
      byExternal.set(key, group);
    } else if (group.normalizedName !== r.normalizedName) {
      group.conflictReason = `External id "${r.externalId}" is used with different organization names in this batch`;
      r.conflictReason = group.conflictReason;
    }
    group.rows.push(r);
    rowGroup.set(r.index, group);
  }

  // Pass 2: name-keyed rows join an unambiguous same-named group, else form one.
  for (const r of normalized) {
    if (r.conflictReason || r.externalId) continue;
    const candidates = byName.get(r.normalizedName) ?? [];
    if (candidates.length > 1) {
      r.conflictReason = `Organization name "${r.organization}" is ambiguous across multiple external ids in this batch`;
      continue;
    }
    const group = candidates[0] ?? newGroup(r, null);
    group.rows.push(r);
    rowGroup.set(r.index, group);
  }

  return { groups, rowGroup };
}

function deriveGroupAnnotation(group: RowGroup, state: PartnerState): void {
  if (group.conflictReason) {
    group.annotation = 'conflict';
    return;
  }

  if (group.externalId) {
    const linked = state.linkByKey.get(linkKey(group.system, group.externalId));
    if (linked) {
      const org = state.orgById.get(linked);
      // A link row pointing at a missing org cannot happen (FK), but guard anyway.
      if (org) {
        group.organizationId = org.id;
        group.matchedOrganizationName = org.name;
        group.annotation = org.deletedAt ? 'matched-soft-deleted' : 'link-match';
        return;
      }
    }
  }

  const candidates = state.orgsByName.get(group.normalizedName) ?? [];
  const active = candidates.filter((o) => !o.deletedAt);
  const deleted = candidates.filter((o) => o.deletedAt);

  if (active.length > 1) {
    group.annotation = 'conflict';
    group.conflictReason = `Multiple existing organizations are named "${group.organization}"`;
    return;
  }
  if (active.length === 1) {
    group.organizationId = active[0]!.id;
    group.matchedOrganizationName = active[0]!.name;
    group.annotation = 'name-match';
    return;
  }
  if (deleted.length > 1) {
    group.annotation = 'conflict';
    group.conflictReason = `Multiple soft-deleted organizations are named "${group.organization}"`;
    return;
  }
  if (deleted.length === 1) {
    group.organizationId = deleted[0]!.id;
    group.matchedOrganizationName = deleted[0]!.name;
    group.annotation = 'matched-soft-deleted';
    return;
  }
  group.annotation = 'create';
}

function annotateGroups(rows: ImportRow[], state: PartnerState): { normalized: NormalizedRow[]; groups: RowGroup[]; rowGroup: Map<number, RowGroup> } {
  const normalized = normalizeRows(rows);
  const { groups, rowGroup } = groupRows(normalized);
  // Reserve slugs deterministically in group order so preview and commit agree.
  const taken = new Set(state.slugs);
  for (const group of groups) {
    deriveGroupAnnotation(group, state);
    if (group.annotation === 'create') {
      group.slug = generateUniqueSlug(slugify(group.organization), taken);
      taken.add(group.slug);
    }
  }
  return { normalized, groups, rowGroup };
}

export async function previewOrgImport(rows: ImportRow[], partnerId: string): Promise<AnnotatedRow[]> {
  const state = await loadPartnerState(partnerId);
  const { normalized, rowGroup } = annotateGroups(rows, state);

  return normalized.map((r) => {
    const group = rowGroup.get(r.index);
    const annotation: RowAnnotation = r.conflictReason ? 'conflict' : group?.annotation ?? 'conflict';
    return {
      ...r.row,
      index: r.index,
      annotation,
      slug: annotation === 'create' ? group?.slug ?? null : null,
      organizationId: group?.organizationId ?? null,
      ...(group?.matchedOrganizationName ? { matchedOrganizationName: group.matchedOrganizationName } : {}),
      ...(r.conflictReason || group?.conflictReason
        ? { conflictReason: r.conflictReason ?? group?.conflictReason }
        : {}),
    };
  });
}

/**
 * Validate a commit row's derived annotation against the client's
 * acknowledgement. Returns an error message when the row must be refused.
 */
function checkExpectation(
  row: CommitRowInput,
  derived: RowAnnotation,
  matchedName: string | undefined,
  matchedOrgId: string | null,
): string | null {
  if (derived === 'conflict') return null; // handled by the caller with the conflict reason
  if (row.expectedAnnotation && row.expectedAnnotation !== derived) {
    return `Annotation changed since preview: expected "${row.expectedAnnotation}", now "${derived}" — re-run preview`;
  }
  // Identity pinning: an acknowledgement made against org X must not be
  // transferred to a different org that took over the name/link since preview.
  if (row.expectedOrganizationId && matchedOrgId && matchedOrgId !== row.expectedOrganizationId) {
    return `Match changed since preview: the row now resolves to a different organization — re-run preview`;
  }
  if (row.expectedOrganizationId && !matchedOrgId) {
    return `Match changed since preview: the previously matched organization no longer matches — re-run preview`;
  }
  if (derived === 'name-match' && row.expectedAnnotation !== 'name-match') {
    return `Name matches existing organization "${matchedName ?? row.organization}" — confirm the match by committing with expectedAnnotation "name-match"`;
  }
  if (derived === 'matched-soft-deleted' && (row.expectedAnnotation !== 'matched-soft-deleted' || !row.reactivate)) {
    return `Matches soft-deleted organization "${matchedName ?? row.organization}" — refusing to touch it without an explicit reactivate opt-in`;
  }
  return null;
}

export async function commitOrgImport(
  rows: CommitRowInput[],
  partnerId: string,
  actor: OrgImportActor,
  mode: OrgImportMode = 'skip',
): Promise<OrgImportSummary> {
  const state = await loadPartnerState(partnerId);
  const { normalized, rowGroup } = annotateGroups(rows, state);

  const summary: OrgImportSummary = { imported: [], updated: [], skipped: [], errors: [] };

  // Group → rows, preserving submission order within each group.
  const seenGroups = new Set<RowGroup>();
  for (const r of normalized) {
    const group = rowGroup.get(r.index);

    if (r.conflictReason || !group || group.annotation === 'conflict') {
      summary.errors.push({
        index: r.index,
        organization: r.organization || undefined,
        error: r.conflictReason ?? group?.conflictReason ?? 'Row is in conflict',
      });
      continue;
    }
    if (!seenGroups.has(group)) {
      seenGroups.add(group);
      await commitGroup(group, partnerId, actor, mode, state, summary);
    }
  }

  return summary;
}

async function commitGroup(
  group: RowGroup,
  partnerId: string,
  actor: OrgImportActor,
  mode: OrgImportMode,
  state: PartnerState,
  summary: OrgImportSummary,
): Promise<void> {
  // Expectation check applies per row (each carries its own acknowledgement).
  const rejected = new Set<number>();
  for (const r of group.rows) {
    const commitRow = r.row as CommitRowInput;
    const problem = checkExpectation(commitRow, group.annotation, group.matchedOrganizationName, group.organizationId);
    if (problem) {
      summary.errors.push({ index: r.index, organization: r.organization, error: problem });
      rejected.add(r.index);
    }
  }
  const rows = group.rows.filter((r) => !rejected.has(r.index));
  if (rows.length === 0) return;

  try {
    if (group.annotation === 'create') {
      await createGroup(group, rows, partnerId, actor, summary);
      return;
    }

    // Matched (link-match, acknowledged name-match, or reactivate-opted
    // soft-deleted match).
    const orgId = group.organizationId!;
    let reactivated = false;

    if (group.annotation === 'matched-soft-deleted') {
      // Every surviving row carried reactivate: true (checkExpectation).
      await runOutsideDbContext(() => withSystemDbAccessContext(() =>
        db.update(organizations)
          .set({ deletedAt: null, status: 'active', updatedAt: new Date() })
          .where(eq(organizations.id, orgId))
      ));
      await restoreOrganizationTenantAccess(orgId);
      reactivated = true;
    }

    if (mode === 'skip' && !reactivated) {
      for (const r of rows) {
        summary.skipped.push({
          index: r.index,
          organization: r.organization,
          organizationId: orgId,
          reason: group.annotation === 'link-match' ? 'already_linked' : 'name_match_confirmed',
        });
      }
      return;
    }

    await updateGroup(group, rows, partnerId, actor, mode, orgId, reactivated, summary);
  } catch (err) {
    console.error('[org-import] group failed', {
      partnerId,
      organization: group.organization,
      error: err instanceof Error ? err.message : String(err),
    });
    for (const r of rows) {
      summary.errors.push({
        index: r.index,
        organization: r.organization,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function createGroup(
  group: RowGroup,
  rows: NormalizedRow[],
  partnerId: string,
  actor: OrgImportActor,
  summary: OrgImportSummary,
): Promise<void> {
  const firstContact = rows.find((r) => r.row.contact)?.row.contact;

  let orgId: string;
  let createdLink = false;
  try {
    const created = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      const [org] = await db.insert(organizations).values({
        partnerId,
        name: clamp(group.organization, 255)!,
        // annotateGroups always resolves a slug for 'create' groups.
        slug: group.slug!,
        type: 'customer' as const,
        ...(firstContact ? { billingContact: firstContact } : {}),
      }).returning();
      let linked = false;
      if (group.externalId) {
        await db.insert(organizationExternalLinks).values({
          orgId: org!.id,
          partnerId,
          system: group.system,
          externalId: group.externalId,
          createdBy: actor.userId,
        });
        linked = true;
      }
      return { orgId: org!.id as string, linked };
    }));
    orgId = created.orgId;
    createdLink = created.linked;
  } catch (err) {
    // Unique violation on the link row: a concurrent import linked this
    // external id after our snapshot — honor the skip contract instead of
    // reporting a raw constraint error. Re-read the winning org id.
    if (isPgUniqueViolation(err) && group.externalId) {
      const existing = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
        db.select({ orgId: organizationExternalLinks.orgId })
          .from(organizationExternalLinks)
          .where(and(
            eq(organizationExternalLinks.partnerId, partnerId),
            eq(organizationExternalLinks.system, group.system),
            eq(organizationExternalLinks.externalId, group.externalId!),
          ))
          .limit(1)
      )) as Array<{ orgId: string }>;
      for (const r of rows) {
        summary.skipped.push({
          index: r.index,
          organization: r.organization,
          organizationId: existing[0]?.orgId ?? null,
          reason: 'created_concurrently',
        });
      }
      return;
    }
    throw err;
  }

  // Sites: one per row that names a site; a group with none gets a default
  // site named after the org (matching the QuickBooks importer).
  const siteRows = rows.filter((r) => r.site);
  const effective = siteRows.length > 0 ? siteRows : [rows[0]!];
  const createdSiteNames = new Set<string>();
  const siteIdByIndex = new Map<number, { id: string; name: string }>();

  for (const r of effective) {
    const siteName = r.site ?? group.organization;
    if (createdSiteNames.has(siteName.toLowerCase())) continue;
    try {
      const [site] = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
        db.insert(sites).values({
          orgId,
          name: clamp(siteName, 255)!,
          timezone: r.row.timezone ?? 'UTC',
          ...(r.row.address !== undefined ? { address: r.row.address } : {}),
          ...(r.row.contact ? { contact: r.row.contact } : {}),
        }).returning()
      ));
      createdSiteNames.add(siteName.toLowerCase());
      siteIdByIndex.set(r.index, { id: site!.id as string, name: siteName });
    } catch (err) {
      summary.errors.push({
        index: r.index,
        organization: r.organization,
        error: `Organization created but site "${siteName}" failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  let first = true;
  for (const r of rows) {
    if (summary.errors.some((e) => e.index === r.index)) continue;
    const site = siteIdByIndex.get(r.index) ?? null;
    summary.imported.push({
      index: r.index,
      organization: r.organization,
      organizationId: orgId,
      siteId: site?.id ?? null,
      siteName: site?.name ?? null,
      createdOrganization: first,
      createdLink: first && createdLink,
      slug: first ? group.slug : null,
    });
    first = false;
  }
}

async function updateGroup(
  group: RowGroup,
  rows: NormalizedRow[],
  partnerId: string,
  actor: OrgImportActor,
  mode: OrgImportMode,
  orgId: string,
  reactivated: boolean,
  summary: OrgImportSummary,
): Promise<void> {
  let createdLink = false;

  if (mode === 'update') {
    // Patch the org name only when it actually changed (case/spacing edits).
    if (group.matchedOrganizationName !== group.organization) {
      await runOutsideDbContext(() => withSystemDbAccessContext(() =>
        db.update(organizations)
          .set({ name: clamp(group.organization, 255)!, updatedAt: new Date() })
          .where(eq(organizations.id, orgId))
      ));
    }
  }

  // Attach the link row for an acknowledged name-match carrying an externalId
  // (in update mode only — 'skip' leaves matches untouched), so the NEXT
  // import matches by id instead of name.
  if (mode === 'update' && group.externalId && group.annotation !== 'link-match') {
    try {
      await runOutsideDbContext(() => withSystemDbAccessContext(() =>
        db.insert(organizationExternalLinks).values({
          orgId,
          partnerId,
          system: group.system,
          externalId: group.externalId!,
          createdBy: actor.userId,
        })
      ));
      createdLink = true;
    } catch (err) {
      if (!isPgUniqueViolation(err)) throw err;
    }
  }

  const existingSites = mode === 'update'
    ? (await runOutsideDbContext(() => withSystemDbAccessContext(() =>
        db.select({ id: sites.id, name: sites.name }).from(sites).where(eq(sites.orgId, orgId))
      ))) as Array<{ id: string; name: string }>
    : [];
  const siteByName = new Map(existingSites.map((s) => [s.name.toLowerCase(), s]));

  for (const r of rows) {
    let siteId: string | null = null;
    let siteName: string | null = null;
    let createdSite = false;

    if (mode === 'update' && r.site) {
      const existing = siteByName.get(r.site.toLowerCase());
      try {
        if (existing) {
          const patch: Record<string, unknown> = {};
          if (r.row.timezone !== undefined) patch.timezone = r.row.timezone;
          if (r.row.address !== undefined) patch.address = r.row.address;
          if (r.row.contact !== undefined) patch.contact = r.row.contact;
          if (Object.keys(patch).length > 0) {
            patch.updatedAt = new Date();
            await runOutsideDbContext(() => withSystemDbAccessContext(() =>
              db.update(sites).set(patch).where(eq(sites.id, existing.id))
            ));
          }
          siteId = existing.id;
          siteName = existing.name;
        } else {
          const [site] = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
            db.insert(sites).values({
              orgId,
              name: clamp(r.site!, 255)!,
              timezone: r.row.timezone ?? 'UTC',
              ...(r.row.address !== undefined ? { address: r.row.address } : {}),
              ...(r.row.contact ? { contact: r.row.contact } : {}),
            }).returning()
          ));
          siteId = site!.id as string;
          siteName = r.site;
          createdSite = true;
          siteByName.set(r.site.toLowerCase(), { id: siteId, name: r.site });
        }
      } catch (err) {
        summary.errors.push({
          index: r.index,
          organization: r.organization,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    }

    summary.updated.push({
      index: r.index,
      organization: r.organization,
      organizationId: orgId,
      siteId,
      siteName,
      createdSite,
      createdLink: createdLink && r === rows[0],
      reactivated,
    });
  }
}
