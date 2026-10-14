import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_TRUST_EVALUATION_POLICY, TRUST_CONTROL_CATALOG, TRUST_CONTROL_CATALOG_VERSION, TRUST_DOCUMENTS_MAX, TRUST_SLUG_RE,
  evaluateTrustControls, trustPublishedConfigSchema, type TrustPagePublicPayload, type TrustPublishedConfig,
} from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  orgDocuments, organizations, partners, portalBranding, trustPageDocuments, trustPages, trustPageSnapshots, ORG_DOCUMENT_META_COLUMNS,
} from '../../db/schema';
import type { PartnerTrustState } from '../../db/schema/orgs';
import type { TrustPageRow } from '../../db/schema/trustPages';
import { partnerTrustMode } from '../../config/partnerTrustMode';
import { loadPostureEvidence, TRUST_PAGE_EVIDENCE_POLICY } from '../postureEvidence';
import type { OrgDocumentView } from '../orgDocumentService';
import { isEdrVisibilityEnabled } from '../portal/edrVisibility';
import { buildTrustPagePayload, payloadSha256 } from './payloadBuilder';
import { addServing, cacheSnapshotPayload, removeServing, trustServingMember } from './servingSet';
import { TRUST_RESERVED_PARTNER_SLUGS } from './resolve';

export class TrustPageError extends Error {
  constructor(message: string, public readonly status: 400 | 403 | 404 | 409 | 422, public readonly code: string) {
    super(message);
    this.name = 'TrustPageError';
  }
}

export function validatePublishSlugs(partnerSlug: string, orgSlug: string): void {
  if (!TRUST_SLUG_RE.test(partnerSlug)) {
    throw new TrustPageError(`The partner slug "${partnerSlug}" is not URL-safe (lowercase letters, digits and hyphens, max 63). Fix it in partner settings before publishing.`, 422, 'SLUG_INVALID');
  }
  if (TRUST_RESERVED_PARTNER_SLUGS.has(partnerSlug)) {
    throw new TrustPageError(`The partner slug "${partnerSlug}" is reserved for trust page URLs. Change it in partner settings before publishing.`, 422, 'SLUG_INVALID');
  }
  if (!TRUST_SLUG_RE.test(orgSlug)) {
    throw new TrustPageError(`The organization slug "${orgSlug}" is not URL-safe (lowercase letters, digits and hyphens, max 63). Fix it in the organization settings before publishing.`, 422, 'SLUG_INVALID');
  }
}

/** Get-or-create the org's draft page (partner_id from the organization row). Caller's db context. */
export async function ensureTrustPage(orgId: string, actorUserId: string | null): Promise<TrustPageRow> {
  const [existing] = await db.select().from(trustPages).where(eq(trustPages.orgId, orgId)).limit(1);
  if (existing) return existing;
  const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations)
    .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt))).limit(1);
  if (!org) throw new TrustPageError('Not found', 404, 'NOT_FOUND');
  const [created] = await db.insert(trustPages)
    .values({ orgId, partnerId: org.partnerId, createdByUserId: actorUserId, updatedByUserId: actorUserId })
    .onConflictDoNothing({ target: trustPages.orgId })
    .returning();
  if (created) return created;
  const [raced] = await db.select().from(trustPages).where(eq(trustPages.orgId, orgId)).limit(1);
  if (!raced) throw new TrustPageError('Not found', 404, 'NOT_FOUND');
  return raced;
}

/** Linked + public + disclosure-confirmed + live + not superseded, in sort order (spec §12). */
export async function loadPublicDocumentsForPage(page: TrustPageRow): Promise<OrgDocumentView[]> {
  const successor = alias(orgDocuments, 'successor');
  const rows = await db.select({ ...ORG_DOCUMENT_META_COLUMNS, supersededByDocumentId: successor.id, sortOrder: trustPageDocuments.sortOrder })
    .from(trustPageDocuments)
    .innerJoin(orgDocuments, and(eq(orgDocuments.id, trustPageDocuments.documentId), eq(orgDocuments.orgId, trustPageDocuments.orgId)))
    .leftJoin(successor, and(eq(successor.supersedesDocumentId, orgDocuments.id), eq(successor.orgId, orgDocuments.orgId)))
    .where(and(
      eq(trustPageDocuments.trustPageId, page.id),
      eq(trustPageDocuments.visibility, 'public'),
      sql`${trustPageDocuments.disclosureConfirmedAt} IS NOT NULL`,
      isNull(orgDocuments.deletedAt),
      isNull(successor.id),
    ))
    .orderBy(asc(trustPageDocuments.sortOrder), asc(orgDocuments.createdAt));
  return rows.map(({ supersededByDocumentId: _s, sortOrder: _o, createdAt, ...r }) => ({
    ...r, supersededByDocumentId: null, createdAt: createdAt.toISOString(),
  }));
}

export interface LinkedDocumentForEditor {
  documentId: string; visibility: 'public' | 'gated'; disclosureConfirmedAt: string | null; sortOrder: number;
  title: string | null; category: string | null; contentType: string | null; byteSize: number | null;
  supersededByDocumentId: string | null; deleted: boolean;
}

/** Every linked document with its current state (editor view): soft-deleted/missing and superseded rows are kept, flagged. */
export async function loadLinkedDocumentsForEditor(page: TrustPageRow): Promise<LinkedDocumentForEditor[]> {
  const successor = alias(orgDocuments, 'successor');
  const rows = await db.select({
    documentId: trustPageDocuments.documentId, visibility: trustPageDocuments.visibility,
    disclosureConfirmedAt: trustPageDocuments.disclosureConfirmedAt, sortOrder: trustPageDocuments.sortOrder,
    docId: orgDocuments.id, deletedAt: orgDocuments.deletedAt, title: orgDocuments.title, category: orgDocuments.category,
    contentType: orgDocuments.contentType, byteSize: orgDocuments.byteSize, supersededByDocumentId: successor.id,
  })
    .from(trustPageDocuments)
    .leftJoin(orgDocuments, and(eq(orgDocuments.id, trustPageDocuments.documentId), eq(orgDocuments.orgId, trustPageDocuments.orgId)))
    .leftJoin(successor, and(eq(successor.supersedesDocumentId, orgDocuments.id), eq(successor.orgId, orgDocuments.orgId)))
    .where(eq(trustPageDocuments.trustPageId, page.id))
    .orderBy(asc(trustPageDocuments.sortOrder), asc(trustPageDocuments.createdAt));
  return rows.map((r) => ({
    documentId: r.documentId, visibility: r.visibility, disclosureConfirmedAt: r.disclosureConfirmedAt?.toISOString() ?? null,
    sortOrder: r.sortOrder, title: r.title ?? null, category: r.category ?? null, contentType: r.contentType ?? null,
    byteSize: r.byteSize ?? null, supersededByDocumentId: r.supersededByDocumentId ?? null,
    deleted: r.docId == null || r.deletedAt != null,
  }));
}

export interface SnapshotBuild {
  snapshotId: string; payload: TrustPagePublicPayload; sha256: string; deviceCount: number; generatedAt: Date;
  /** The publication config the payload was built from (publish freezes exactly this). */
  config: TrustPublishedConfig;
}

/**
 * Where the publication settings come from (Ruling 20):
 *  - 'draft'  — the trust_pages draft columns + every live public link (publish, preview);
 *  - a frozen TrustPublishedConfig — published_config (the hourly refresh): evidence and live links are
 *    re-read, but documents are the frozen ids ∩ live public/confirmed/not-superseded links, in frozen order.
 */
export type SnapshotConfigSource = 'draft' | TrustPublishedConfig;

function draftSettings(page: TrustPageRow): Omit<TrustPublishedConfig, 'documentIds'> {
  return {
    hiddenControlIds: [...page.hiddenControlIds] as TrustPublishedConfig['hiddenControlIds'],
    showPercentages: page.showPercentages, showDeviceCount: page.showDeviceCount, showManagedBy: page.showManagedBy,
    searchIndexable: page.searchIndexable, introHtml: page.introHtml ?? null, websiteUrl: page.websiteUrl ?? null,
    securityContactEmail: page.securityContactEmail ?? null,
  };
}

/**
 * loader → evaluator → documents → builder. Runs in the CALLER's db context (route: user RLS; worker: system).
 * A ZodError from the builder's final schema parse is a builder bug and propagates.
 */
export async function buildSnapshotForPage(
  page: TrustPageRow,
  opts: { publishedAt?: Date; config: SnapshotConfigSource },
): Promise<SnapshotBuild> {
  const generatedAt = new Date();
  const [ctx] = await db.select({
    orgName: organizations.name, partnerName: partners.name, partnerSettings: partners.settings,
    billingWebsite: partners.billingWebsite, trustPageUnbranded: partners.trustPageUnbranded,
  }).from(organizations).innerJoin(partners, eq(partners.id, organizations.partnerId)).where(eq(organizations.id, page.orgId)).limit(1);
  if (!ctx) throw new TrustPageError('Not found', 404, 'NOT_FOUND');
  const [brand] = await db.select({ logoUrl: portalBranding.logoUrl, primaryColor: portalBranding.primaryColor })
    .from(portalBranding).where(eq(portalBranding.orgId, page.orgId)).limit(1);
  // Public is at least as strict as the portal: EDR evidence only when the org enabled EDR visibility.
  const evidence = await loadPostureEvidence(
    { version: 1, kind: 'unrestricted', orgId: page.orgId },
    TRUST_PAGE_EVIDENCE_POLICY,
    generatedAt,
    { edrEvidenceAllowed: () => isEdrVisibilityEnabled(page.orgId) },
  );
  const assessments = evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence.controls, DEFAULT_TRUST_EVALUATION_POLICY, generatedAt);
  const liveDocuments = await loadPublicDocumentsForPage(page);
  let config: TrustPublishedConfig;
  let documents: OrgDocumentView[];
  if (opts.config === 'draft') {
    documents = liveDocuments.slice(0, TRUST_DOCUMENTS_MAX);
    config = { ...draftSettings(page), documentIds: documents.map((d) => d.id) };
  } else {
    config = opts.config;
    const live = new Map(liveDocuments.map((d) => [d.id, d]));
    documents = config.documentIds.map((id) => live.get(id)).filter((d): d is OrgDocumentView => Boolean(d));
  }
  const snapshotId = randomUUID();
  const payload = buildTrustPagePayload({
    snapshotId, generatedAt, publishedAt: opts.publishedAt ?? page.publishedAt ?? generatedAt,
    // The builder reads the publication settings off the page; overlay the chosen config.
    page: { ...page, ...config, hiddenControlIds: [...config.hiddenControlIds] },
    org: { name: ctx.orgName },
    partner: { name: ctx.partnerName, settings: ctx.partnerSettings, billingWebsite: ctx.billingWebsite, trustPageUnbranded: ctx.trustPageUnbranded },
    orgBrand: brand ?? null, assessments, deviceCount: evidence.deviceCount, documents,
    policy: {
      evidenceMaxAgeDays: TRUST_PAGE_EVIDENCE_POLICY.maxSecurityStatusAgeDays,
      definitionsMaxAgeDays: TRUST_PAGE_EVIDENCE_POLICY.maxAvDefinitionsAgeDays,
      coverageFloorPct: DEFAULT_TRUST_EVALUATION_POLICY.coverageFloorPct,
      thresholds: DEFAULT_TRUST_EVALUATION_POLICY.thresholds,
    },
  });
  return { snapshotId, payload, sha256: payloadSha256(payload), deviceCount: evidence.deviceCount, generatedAt, config };
}

/**
 * The publish trust rule, pure (Ruling 24). Shadow mode counts as enforce for this surface (matches the public
 * predicate). GET /trust-page reports `canPublish` from THIS, so the button is never enabled into a 403.
 * Reasons reuse the partnerTrust reason codes the editor already translates.
 */
export function trustPublishDecision(state: PartnerTrustState): { allowed: true; reason: null } | { allowed: false; reason: 'restricted' | 'probation_default_deny' } {
  if (partnerTrustMode() === 'off' || state === 'trusted') return { allowed: true, reason: null };
  return { allowed: false, reason: state === 'restricted' ? 'restricted' : 'probation_default_deny' };
}

function trustDenial(state: PartnerTrustState): TrustPageError | null {
  const d = trustPublishDecision(state);
  if (d.allowed) return null;
  return d.reason === 'restricted'
    ? new TrustPageError('Publishing is unavailable for this account.', 403, 'TRUST_RESTRICTED')
    : new TrustPageError('Publishing opens once your account is trusted.', 403, 'TRUST_PROBATION');
}

export const PARTNER_HOME_INTERNAL_ONLY_MESSAGE = 'Only your own (internal) organization can be the partner home page.';

/**
 * One transaction: lock the page row, demote the previous current snapshot, insert the new current one, stamp
 * published_at and bump the revision — only if the revision still matches (409 otherwise). Serving-set and cache
 * writes happen after the transaction resolves, never inside it.
 */
export async function publishTrustPage(args: {
  orgId: string; expectedRevision: number; actorUserId: string; authorization?: { authorizedBy: string } | null;
  partnerTrustState: PartnerTrustState; partnerSlug: string; orgSlug: string;
}): Promise<{ page: TrustPageRow; snapshotId: string }> {
  const denied = trustDenial(args.partnerTrustState);
  if (denied) throw denied;
  validatePublishSlugs(args.partnerSlug, args.orgSlug);
  const [page] = await db.select().from(trustPages).where(eq(trustPages.orgId, args.orgId)).limit(1);
  if (!page) throw new TrustPageError('Not found', 404, 'NOT_FOUND');
  if (page.isPartnerHome) {
    // Ruling 25: the attestation exemption is for the MSP's own page only — re-checked here because the
    // org's type can change after the flag was set.
    const [org] = await db.select({ type: organizations.type }).from(organizations).where(eq(organizations.id, page.orgId)).limit(1);
    if (org?.type !== 'internal') throw new TrustPageError(PARTNER_HOME_INTERNAL_ONLY_MESSAGE, 422, 'PARTNER_HOME_INTERNAL_ONLY');
  }
  const suppliedAuthorizedBy = args.authorization?.authorizedBy?.trim() || null;
  const authorizedBy = suppliedAuthorizedBy ?? page.publicationAuthorizedBy;
  if (!page.isPartnerHome && !authorizedBy) {
    throw new TrustPageError('Record who at the customer authorized publication before publishing.', 422, 'AUTHORIZATION_REQUIRED');
  }
  const publishedAt = page.publishedAt ?? new Date();
  // Built from the DRAFT; the same config is frozen below (a PUT racing this bumps the revision → 409).
  const built = await buildSnapshotForPage({ ...page, publishedAt }, { publishedAt, config: 'draft' });
  const nextRevision = args.expectedRevision + 1;

  const result = await db.transaction(async (tx) => {
    const [locked] = await tx.select({ rev: trustPages.publicationRevision }).from(trustPages)
      .where(eq(trustPages.id, page.id)).for('update');
    if (!locked || locked.rev !== args.expectedRevision) return null;
    await tx.update(trustPageSnapshots).set({ isCurrent: false })
      .where(and(eq(trustPageSnapshots.trustPageId, page.id), eq(trustPageSnapshots.isCurrent, true)));
    await tx.insert(trustPageSnapshots).values({
      id: built.snapshotId, trustPageId: page.id, orgId: page.orgId, payload: built.payload, payloadSha256: built.sha256,
      catalogVersion: TRUST_CONTROL_CATALOG_VERSION, publicationRevision: nextRevision, isCurrent: true, generatedAt: built.generatedAt,
    });
    const now = new Date();
    const [updated] = await tx.update(trustPages).set({
      publishedAt, publicationRevision: nextRevision, lastEvaluatedAt: built.generatedAt,
      publishedConfig: built.config,
      updatedAt: now, updatedByUserId: args.actorUserId,
      ...(suppliedAuthorizedBy
        ? { publicationAuthorizedBy: suppliedAuthorizedBy, publicationAuthorizedAt: now, publicationAuthorizedByUserId: args.actorUserId }
        : {}),
    }).where(eq(trustPages.id, page.id)).returning();
    return updated ?? null;
  });
  if (!result) throw new TrustPageError('This page changed since you loaded it. Reload and publish again.', 409, 'REVISION_MISMATCH');

  await cacheSnapshotPayload(built.snapshotId, built.payload);
  const members = [trustServingMember(args.partnerSlug, args.orgSlug)];
  if (result.isPartnerHome) members.push(trustServingMember(args.partnerSlug));
  await addServing(members);
  return { page: result, snapshotId: built.snapshotId };
}

/** Clears published_at and bumps the revision (so an in-flight publish 409s); removes the serving member after. */
export async function unpublishTrustPage(args: {
  orgId: string; actorUserId: string; partnerSlug: string; orgSlug: string; isPartnerHome: boolean;
}): Promise<TrustPageRow> {
  const [updated] = await db.update(trustPages).set({
    publishedAt: null, publicationRevision: sql`${trustPages.publicationRevision} + 1`, updatedAt: new Date(), updatedByUserId: args.actorUserId,
  }).where(eq(trustPages.orgId, args.orgId)).returning();
  if (!updated) throw new TrustPageError('Not found', 404, 'NOT_FOUND');
  await removeServing([
    trustServingMember(args.partnerSlug, args.orgSlug),
    ...(args.isPartnerHome ? [trustServingMember(args.partnerSlug)] : []),
  ]);
  return updated;
}

/**
 * Worker path (system context). Builds from the FROZEN published_config (Ruling 20) — draft edits never reach
 * the public page without a publish. Inserts a new current snapshot only when the content hash changed and the
 * revision is unchanged (a racing publish wins); always stamps last_evaluated_at when it still owns the revision.
 * A published page without a valid published_config (only possible for a page published before the column
 * existed, which never shipped) is left untouched rather than rebuilt from the draft.
 */
export async function refreshPublishedPage(pageId: string): Promise<{ rebuilt: boolean; snapshotId: string | null }> {
  const { outcome, built } = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [page] = await db.select().from(trustPages)
      .where(and(eq(trustPages.id, pageId), sql`${trustPages.publishedAt} IS NOT NULL`)).limit(1);
    if (!page) return { outcome: { rebuilt: false, snapshotId: null }, built: null };
    const frozen = trustPublishedConfigSchema.safeParse(page.publishedConfig);
    if (!frozen.success) {
      console.warn('[trustPage] published page has no valid published_config; refresh skipped (republish to repair)', { pageId: page.id });
      return { outcome: { rebuilt: false, snapshotId: null }, built: null };
    }
    const [current] = await db.select({ id: trustPageSnapshots.id, sha: trustPageSnapshots.payloadSha256 }).from(trustPageSnapshots)
      .where(and(eq(trustPageSnapshots.trustPageId, page.id), eq(trustPageSnapshots.isCurrent, true))).limit(1);
    const snapshot = await buildSnapshotForPage(page, { config: frozen.data });
    const rev = page.publicationRevision;
    const txOutcome = await db.transaction(async (tx) => {
      const [locked] = await tx.select({ rev: trustPages.publicationRevision, publishedAt: trustPages.publishedAt }).from(trustPages)
        .where(eq(trustPages.id, page.id)).for('update');
      if (!locked || locked.rev !== rev || !locked.publishedAt) return { rebuilt: false, snapshotId: current?.id ?? null };
      if (current && current.sha === snapshot.sha256) {
        await tx.update(trustPages).set({ lastEvaluatedAt: snapshot.generatedAt }).where(eq(trustPages.id, page.id));
        return { rebuilt: false, snapshotId: current.id };
      }
      await tx.update(trustPageSnapshots).set({ isCurrent: false })
        .where(and(eq(trustPageSnapshots.trustPageId, page.id), eq(trustPageSnapshots.isCurrent, true)));
      await tx.insert(trustPageSnapshots).values({
        id: snapshot.snapshotId, trustPageId: page.id, orgId: page.orgId, payload: snapshot.payload, payloadSha256: snapshot.sha256,
        catalogVersion: TRUST_CONTROL_CATALOG_VERSION, publicationRevision: rev, isCurrent: true, generatedAt: snapshot.generatedAt,
      });
      await tx.update(trustPages).set({ lastEvaluatedAt: snapshot.generatedAt }).where(eq(trustPages.id, page.id));
      return { rebuilt: true, snapshotId: snapshot.snapshotId };
    });
    return { outcome: txOutcome, built: snapshot };
  }, 'trustPage.refreshPublishedPage'));
  // Redis after the DB context closes (#1105 discipline).
  if (outcome.rebuilt && built) await cacheSnapshotPayload(built.snapshotId, built.payload);
  return outcome;
}
