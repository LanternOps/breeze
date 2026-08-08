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

    // Persist the link row for ANY acknowledged non-link match carrying an
    // externalId, in BOTH modes: every surviving name-match or soft-deleted
    // match passed checkExpectation's explicit acknowledgement, and the
    // acknowledgement is the durable fact ("this external id IS this org") —
    // without the link row every subsequent import re-derives the match and
    // re-prompts for the same confirmation.
    let createdLink = false;
    let linkWarning: string | undefined;
    if (group.externalId && group.annotation !== 'link-match') {
      const attach = await attachExternalLink(group, partnerId, actor, orgId);
      if (attach.status === 'conflict') {
        // A concurrent import linked this external id to a DIFFERENT org after
        // our snapshot. Reporting confirmation while the durable link points
        // elsewhere would silently drop the acknowledgement — refuse instead.
        for (const r of rows) {
          summary.errors.push({
            index: r.index,
            organization: r.organization,
            error: `External id "${group.externalId}" (${group.system}) is already linked to a different organization`
              + `${attach.linkedOrgId ? ` (${attach.linkedOrgId})` : ''} — expected ${orgId}; re-run preview`,
          });
        }
        return;
      }
      if (attach.status === 'failed') {
        // Update mode is doing writes for this group anyway — fail it loudly
        // (pre-existing behavior). Skip mode's link write is an optional extra
        // on an otherwise write-free path: keep the rows reported as skipped
        // and surface a warning instead of reclassifying the group as errors.
        if (mode === 'update') throw attach.error;
        linkWarning = 'Match confirmed, but persisting the external link failed: '
          + `${attach.error instanceof Error ? attach.error.message : String(attach.error)} — the next import will ask again`;
      }
      createdLink = attach.status === 'created';
    }

    if (mode === 'skip' && !reactivated) {
      for (const r of rows) {
        summary.skipped.push({
          index: r.index,
          organization: r.organization,
          organizationId: orgId,
          reason: group.annotation === 'link-match' ? 'already_linked' : 'name_match_confirmed',
          createdLink: createdLink && r === rows[0],
          ...(linkWarning && r === rows[0] ? { warning: linkWarning } : {}),
        });
      }
      return;
    }

    await updateGroup(group, rows, mode, orgId, reactivated, { createdLink, warning: linkWarning }, summary);
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

type AttachLinkOutcome =
  | { status: 'created' }
  /** The identical link (same org) already exists — idempotent re-acknowledgement. */
  | { status: 'already-linked' }
  /** The external id is linked to a DIFFERENT org (concurrent import won the race). */
  | { status: 'conflict'; linkedOrgId: string | null }
  /** The insert (or the post-conflict re-read) failed for a non-unique reason. */
  | { status: 'failed'; error: unknown };

/**
 * Insert the organization_external_links row for a matched group. Never
 * throws — every outcome is reported so the caller decides the policy
 * (skip-mode keeps its rows skipped with a warning; update-mode fails loud).
 * A unique violation is not blindly "already linked": the row is re-read and
 * compared, because the winner of the race may be a different org and
 * reporting confirmation then would silently drop the acknowledgement.
 */
async function attachExternalLink(
  group: RowGroup,
  partnerId: string,
  actor: OrgImportActor,
  orgId: string,
): Promise<AttachLinkOutcome> {
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
    return { status: 'created' };
  } catch (err) {
    if (!isConcurrentLinkViolation(err)) return { status: 'failed', error: err };
    try {
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
      const winner = existing[0]?.orgId ?? null;
      if (winner === orgId) return { status: 'already-linked' };
      return { status: 'conflict', linkedOrgId: winner };
    } catch (reReadErr) {
      return { status: 'failed', error: reReadErr };
    }
  }
}

// The two idempotency guards for external-id linkage: the link table's unique
// index and the legacy accounting-columns partial unique index. Only a
// violation of one of THESE means "another import won the race for this
// external id" — any other unique violation (e.g. a sites index) is an
// ordinary failure and must not be reported as created_concurrently.
const LINK_UNIQUE_CONSTRAINTS = [
  'organization_external_links_uniq',
  'organizations_accounting_external_uniq',
] as const;

function isConcurrentLinkViolation(err: unknown): boolean {
  return LINK_UNIQUE_CONSTRAINTS.some((constraint) => isPgUniqueViolation(err, constraint));
}

async function createGroup(
  group: RowGroup,
  rows: NormalizedRow[],
  partnerId: string,
  actor: OrgImportActor,
  summary: OrgImportSummary,
): Promise<void> {
  const firstContact = rows.find((r) => r.row.contact)?.row.contact;

  // Sites: one per row that names a site; a group with none gets a default
  // site named after the org (matching the QuickBooks importer).
  const siteRows = rows.filter((r) => r.site);
  const effective = siteRows.length > 0 ? siteRows : [rows[0]!];

  let orgId: string;
  let createdLink = false;
  let siteIdByIndex: Map<number, { id: string; name: string }>;
  try {
    // All-or-nothing for the whole group: withSystemDbAccessContext runs its
    // callback inside ONE transaction (its RLS GUCs are SET LOCAL, so the
    // helper holds an open transaction for the duration — db/index.ts). The
    // org, its link row, and every site therefore commit or roll back
    // together; a failing site insert cannot strand a freshly created org
    // with no default site, it fails the group as one per-group error.
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
      // One site per distinct (case-insensitive) name; rows whose site name
      // duplicates an earlier row's map to the already-created site.
      const siteByName = new Map<string, { id: string; name: string }>();
      const siteMap = new Map<number, { id: string; name: string }>();
      for (const r of effective) {
        const siteName = r.site ?? group.organization;
        const nameKey = siteName.toLowerCase();
        const existing = siteByName.get(nameKey);
        if (existing) {
          siteMap.set(r.index, existing);
          continue;
        }
        const [site] = await db.insert(sites).values({
          orgId: org!.id,
          name: clamp(siteName, 255)!,
          timezone: r.row.timezone ?? 'UTC',
          ...(r.row.address !== undefined ? { address: r.row.address } : {}),
          ...(r.row.contact ? { contact: r.row.contact } : {}),
        }).returning();
        const entry = { id: site!.id as string, name: siteName };
        siteByName.set(nameKey, entry);
        siteMap.set(r.index, entry);
      }
      return { orgId: org!.id as string, linked, siteMap };
    }));
    orgId = created.orgId;
    createdLink = created.linked;
    siteIdByIndex = created.siteMap;
  } catch (err) {
    // Unique violation on the LINK unique index (or its legacy accounting
    // twin): a concurrent import linked this external id after our snapshot —
    // honor the skip contract instead of reporting a raw constraint error.
    // Re-read the winning org id. Constraint-checked so a site (or slug)
    // unique violation inside the transaction is NOT misreported as
    // created_concurrently — it propagates as an ordinary per-group error
    // whose message carries the violated constraint.
    if (group.externalId && isConcurrentLinkViolation(err)) {
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
          createdLink: false,
        });
      }
      return;
    }
    throw err;
  }

  for (const r of rows) {
    const site = siteIdByIndex.get(r.index) ?? null;
    summary.imported.push({
      index: r.index,
      organization: r.organization,
      organizationId: orgId,
      siteId: site?.id ?? null,
      siteName: site?.name ?? null,
      createdOrganization: r === rows[0],
      createdLink: createdLink && r === rows[0],
      slug: r === rows[0] ? group.slug : null,
    });
  }
}

async function updateGroup(
  group: RowGroup,
  rows: NormalizedRow[],
  mode: OrgImportMode,
  orgId: string,
  reactivated: boolean,
  // Link persistence already happened in commitGroup (both modes) — this is
  // its outcome, reported on the group's first summary row.
  link: { createdLink: boolean; warning?: string },
  summary: OrgImportSummary,
): Promise<void> {
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
      createdLink: link.createdLink && r === rows[0],
      reactivated,
      ...(link.warning && r === rows[0] ? { warning: link.warning } : {}),
    });
  }
}
