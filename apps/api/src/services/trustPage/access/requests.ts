// Owner: W02d. The gated-document access-request lifecycle (spec trust-center §12; plan W02d Task 2):
//   anonymous request → verify (POST, one-shot token) → MSP approve (frozen grant, 7 days) | deny
//   → download (POST, reusable token until the grant expires) → revoke | resend.
// Anonymous paths (create, verify, readGrant, openGrantedDocument) own their system db context; MSP paths
// (approve, deny, revoke, resend) run in the caller's request context, scoped by orgId + RLS.
// Delivery is at-most-once (Open Decision 3): mail, in-app notices and the optional ticket go out after the
// state change commits (MSP paths: runAfterDbContextCommit, because the route's request transaction is still open)
// and their failures are logged with the request id and sent to Sentry, never thrown back into a committed flow.
// The MSP can Resend a grant.
import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  PERMISSION_GRANTS, TRUST_ACCESS_GRANT_TTL_DAYS, TRUST_ACCESS_VERIFY_TTL_HOURS, normalizeTrustPagePayload,
  type TrustAccessRequestCreate, type TrustPagePublicPayload, type TrustPagePublicPayloadAny,
} from '@breeze/shared';
import { db, runAfterDbContextCommit, runOutsideDbContext, withSystemDbAccessContext } from '../../../db';
import {
  orgDocuments, organizations, partnerUsers, partners, trustPageAccessRequests, trustPageAccessTokens, trustPageDocuments,
  trustPages, trustPageSnapshots, users,
} from '../../../db/schema';
import type { TrustPageAccessRequestRow } from '../../../db/schema/trustPages';
import { createAuditLogAsync } from '../../auditService';
import { captureException } from '../../sentry';
import { ANONYMOUS_ACTOR_ID } from '../../auditEvents';
import { portalBase } from '../../portalUrl';
import { createNotification } from '../../userNotifications';
import { resolveUsersWithPermissionForOrg } from '../../usersWithPermission';
import { createTicket, type TicketActor } from '../../ticketService';
import { livePublicationPredicate } from '../predicate';
import { TrustPageError } from '../publication';
import { findLiveToken, hashAccessToken, mintAccessToken } from './tokens';
import {
  sendAccessDeniedEmail, sendAccessGrantedEmail, sendAccessVerificationEmail, sendStaffAccessRequestEmail,
} from './emails';

const DAY_MS = 86_400_000;
const VERIFY_TTL_MS = TRUST_ACCESS_VERIFY_TTL_HOURS * 3600_000;
const GRANT_TTL_MS = TRUST_ACCESS_GRANT_TTL_DAYS * DAY_MS;
const RAW_TOKEN_RE = /^[A-Za-z0-9_-]{48}$/;
const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** A Trust Center request has no person behind the ticket write; the ticket service has no trust-center source. */
const TRUST_ACCESS_TICKET_ACTOR: TicketActor = { kind: 'system', source: 'inbound_email', name: 'Trust Center access request' };

export const verifyUrlFor = (raw: string) => `${portalBase()}/trust/access/verify#${raw}`;
export const downloadUrlFor = (raw: string) => `${portalBase()}/trust/access/download#${raw}`;

function dashboardBase(): string {
  return (process.env.DASHBOARD_URL || process.env.PUBLIC_APP_URL || 'http://localhost:4321').replace(/\/+$/, '');
}

function auditAnonymous(a: { orgId: string; pageId: string; action: string; requesterEmail: string; details: Record<string, unknown> }) {
  return createAuditLogAsync({
    orgId: a.orgId, actorType: 'system', actorId: ANONYMOUS_ACTOR_ID, actorEmail: a.requesterEmail,
    action: a.action, resourceType: 'trust_page', resourceId: a.pageId, details: a.details, result: 'success',
  });
}

/** Gated in this payload, in payload order. */
function gatedIdsOf(payload: TrustPagePublicPayload): string[] {
  return payload.documents.filter((d) => d.visibility === 'gated').map((d) => d.id);
}

/**
 * Live gated links of a page among `documentIds`: linked as gated, disclosure confirmed, the document neither
 * deleted nor superseded. `q` is the open transaction when there is one.
 */
type Executor = Pick<typeof db, 'select'>;
function liveGatedLinks(q: Executor, pageId: string, documentIds: string[]) {
  const successor = alias(orgDocuments, 'successor');
  return q.select({
    id: orgDocuments.id, title: orgDocuments.title, category: orgDocuments.category, contentType: orgDocuments.contentType,
    byteSize: orgDocuments.byteSize, storageBackend: orgDocuments.storageBackend, storageKey: orgDocuments.storageKey,
    data: orgDocuments.data, originalFilename: orgDocuments.originalFilename,
  }).from(trustPageDocuments)
    .innerJoin(orgDocuments, and(eq(orgDocuments.id, trustPageDocuments.documentId), eq(orgDocuments.orgId, trustPageDocuments.orgId)))
    .leftJoin(successor, and(eq(successor.supersedesDocumentId, orgDocuments.id), eq(successor.orgId, orgDocuments.orgId)))
    .where(and(
      eq(trustPageDocuments.trustPageId, pageId), inArray(trustPageDocuments.documentId, documentIds),
      eq(trustPageDocuments.visibility, 'gated'), sql`${trustPageDocuments.disclosureConfirmedAt} IS NOT NULL`,
      isNull(orgDocuments.deletedAt), isNull(successor.id),
    ));
}
type LiveLink = Awaited<ReturnType<typeof liveGatedLinks>>[number];

/** In `order`, the ids that have a live link. */
function orderedLinks(order: string[], links: LiveLink[]): LiveLink[] {
  const byId = new Map(links.map((l) => [l.id, l]));
  return order.map((id) => byId.get(id)).filter((l): l is LiveLink => Boolean(l));
}

// ---------------------------------------------------------------------------------------------- anonymous

/**
 * Records a request and mails the verification link. A silent no-op (the route still answers 202) when the
 * snapshot offers no access flow, or the page has NDA text the requester did not accept. The accepted NDA text
 * is the payload's — derived server-side and bound to the snapshot id, never taken from the client.
 * A repeat request from the same address while the first is still unconfirmed reuses that row.
 */
/** Whether this snapshot records a request with this NDA answer (otherwise create is a silent no-op). */
export function acceptsAccessRequest(payload: TrustPagePublicPayload, ndaAccepted: boolean): boolean {
  if (!payload.access || gatedIdsOf(payload).length === 0) return false;
  return !payload.access.ndaText || ndaAccepted;
}

export async function createAccessRequest(
  input: TrustAccessRequestCreate,
  resolved: { pageId: string; orgId: string; partnerId: string },
  payload: TrustPagePublicPayload,
  now: Date,
): Promise<void> {
  if (!payload.access || !acceptsAccessRequest(payload, input.ndaAccepted)) return;
  const ndaText = payload.access.ndaText;
  const nda = ndaText
    ? { ndaTextAccepted: ndaText, ndaTextSha256: sha256(ndaText), ndaAcceptedAt: now }
    : { ndaTextAccepted: null, ndaTextSha256: null, ndaAcceptedAt: null };
  const fields = {
    requesterName: input.name, requesterCompany: input.company, purpose: input.purpose, snapshotId: payload.snapshotId, ...nda,
  };

  const created = await sys(() => db.transaction(async (tx) => {
    const [names] = await tx.select({ orgName: organizations.name, partnerName: partners.name }).from(organizations)
      .innerJoin(partners, eq(partners.id, organizations.partnerId)).where(eq(organizations.id, resolved.orgId)).limit(1);
    if (!names) return null;
    const [existing] = await tx.select({ id: trustPageAccessRequests.id }).from(trustPageAccessRequests)
      .where(and(
        eq(trustPageAccessRequests.trustPageId, resolved.pageId), eq(trustPageAccessRequests.requesterEmail, input.email),
        eq(trustPageAccessRequests.status, 'pending_verification'),
      )).limit(1).for('update');
    let requestId: string;
    if (existing) {
      await tx.update(trustPageAccessRequests).set({ ...fields, updatedAt: now }).where(eq(trustPageAccessRequests.id, existing.id));
      requestId = existing.id;
    } else {
      const [row] = await tx.insert(trustPageAccessRequests).values({
        trustPageId: resolved.pageId, orgId: resolved.orgId, requesterEmail: input.email, status: 'pending_verification',
        ...fields, createdAt: now, updatedAt: now,
      }).returning({ id: trustPageAccessRequests.id });
      if (!row) throw new Error('trust access request insert returned no row');
      requestId = row.id;
    }
    const raw = await mintAccessToken(tx, { requestId, orgId: resolved.orgId, purpose: 'verify_email', ttlMs: VERIFY_TTL_MS, now });
    return { requestId, raw, reused: Boolean(existing), ...names };
  }));
  if (!created) return;

  await sendAccessVerificationEmail(
    { to: input.email, partnerId: resolved.partnerId, partnerName: created.partnerName },
    { orgName: created.orgName, partnerName: created.partnerName, verifyUrl: verifyUrlFor(created.raw) },
    created.requestId,
  );
  await auditAnonymous({
    orgId: resolved.orgId, pageId: resolved.pageId, action: 'trust_page.access.request', requesterEmail: input.email,
    details: { requestId: created.requestId, reused: created.reused, ndaAccepted: Boolean(ndaText), snapshotId: payload.snapshotId },
  });
}

/**
 * Consume-and-transition in ONE transaction: the token row and the request row are locked, the token must be
 * unconsumed/unrevoked/unexpired and the request still pending_verification. A second POST of the same token
 * finds nothing and returns null — exactly what an unknown token returns. MSP staff are notified after commit.
 */
export async function verifyAccessRequest(raw: string, now: Date): Promise<{ orgName: string } | null> {
  if (typeof raw !== 'string' || !RAW_TOKEN_RE.test(raw)) return null;
  const hash = hashAccessToken(raw);
  const live = and(
    eq(trustPageAccessTokens.tokenHash, hash), eq(trustPageAccessTokens.purpose, 'verify_email'),
    isNull(trustPageAccessTokens.consumedAt), isNull(trustPageAccessTokens.revokedAt),
    sql`${trustPageAccessTokens.expiresAt} > ${now.toISOString()}::timestamptz`,
  );
  const done = await sys(() => db.transaction(async (tx) => {
    // Lock order is request → token everywhere (create's re-mint, deny, revoke and mint all lock the request
    // first), so the token is read unlocked here and claimed with a conditional UPDATE after the request lock.
    const [token] = await tx.select({ id: trustPageAccessTokens.id, requestId: trustPageAccessTokens.requestId, orgId: trustPageAccessTokens.orgId })
      .from(trustPageAccessTokens).where(live).limit(1);
    if (!token) return null;
    const [request] = await tx.select().from(trustPageAccessRequests)
      .where(and(
        eq(trustPageAccessRequests.id, token.requestId), eq(trustPageAccessRequests.orgId, token.orgId),
        eq(trustPageAccessRequests.status, 'pending_verification'),
      )).limit(1).for('update');
    if (!request) return null;
    // The claim: exactly one concurrent verify of this token sees a row here.
    const [claimed] = await tx.update(trustPageAccessTokens).set({ consumedAt: now })
      .where(and(eq(trustPageAccessTokens.id, token.id), live)).returning({ id: trustPageAccessTokens.id });
    if (!claimed) return null;
    await tx.update(trustPageAccessRequests).set({ status: 'pending_approval', emailVerifiedAt: now, updatedAt: now })
      .where(eq(trustPageAccessRequests.id, request.id));
    const [ctx] = await tx.select({
      orgName: organizations.name, partnerId: trustPages.partnerId, createsTicket: trustPages.accessRequestCreatesTicket,
    }).from(trustPages).innerJoin(organizations, eq(organizations.id, trustPages.orgId))
      .where(eq(trustPages.id, request.trustPageId)).limit(1);
    if (!ctx) throw new Error('trust access request without its page');
    return { request, ctx };
  }));
  if (!done) return null;
  const { request, ctx } = done;

  await notifyStaff(request, ctx);
  let ticketId: string | null = null;
  if (ctx.createsTicket) ticketId = await createRequestTicket(request, ctx.orgName);
  await auditAnonymous({
    orgId: request.orgId, pageId: request.trustPageId, action: 'trust_page.access.verify', requesterEmail: request.requesterEmail,
    details: { requestId: request.id, ticketId },
  });
  return { orgName: ctx.orgName };
}

/** In-app 'approval' notice (deduped per request) + platform-lane email to the org's MSP staff who can approve. */
async function notifyStaff(request: TrustPageAccessRequestRow, ctx: { orgName: string; partnerId: string }): Promise<void> {
  try {
    const ids = await resolveUsersWithPermissionForOrg(request.orgId, PERMISSION_GRANTS.ORGS_WRITE);
    // Approval happens in the MSP editor (partner scope); org-scoped users cannot act on it.
    const staff = ids.length === 0 ? [] : await sys(() => db.select({ id: users.id, email: users.email }).from(users)
      .innerJoin(partnerUsers, eq(partnerUsers.userId, users.id))
      .where(and(inArray(users.id, ids), eq(partnerUsers.partnerId, ctx.partnerId), eq(users.status, 'active'))));
    if (staff.length === 0) {
      // The request still sits in the inbox, but nobody is told; say so where an operator will look.
      console.warn('[trustAccess] confirmed request has no MSP staff to notify', { requestId: request.id, orgId: request.orgId });
      return;
    }
    const title = 'Trust Center document request';
    const message = `${request.requesterName} (${request.requesterCompany}) asked for ${ctx.orgName}'s gated documents.`.slice(0, 500);
    for (const s of staff) {
      try {
        await sys(() => createNotification({
          userId: s.id, orgId: request.orgId, type: 'approval', priority: 'normal', title, message,
          link: `/organizations/${request.orgId}#trust`, metadata: { trustAccessRequestId: request.id },
          dedupeKey: `trust-access:${request.id}`,
        }));
      } catch (err) {
        console.error('[trustAccess] in-app notification failed', { requestId: request.id, userId: s.id }, err);
        captureException(err);
      }
    }
    await sendStaffAccessRequestEmail(staff.map((s) => s.email), {
      orgName: ctx.orgName, requesterName: request.requesterName, requesterEmail: request.requesterEmail,
      requesterCompany: request.requesterCompany, purpose: request.purpose,
      reviewUrl: `${dashboardBase()}/organizations/${request.orgId}#trust`,
    }, request.id);
  } catch (err) {
    console.error('[trustAccess] staff notification failed', { requestId: request.id }, err);
    captureException(err);
  }
}

/** Optional per-page ticket. Logged on failure, never retried (Open Decision 3); the id goes into the audit. */
async function createRequestTicket(request: TrustPageAccessRequestRow, orgName: string): Promise<string | null> {
  try {
    const ticket = await sys(() => createTicket({
      orgId: request.orgId, source: 'api', priority: 'normal',
      subject: `Trust Center document request from ${request.requesterCompany}`.slice(0, 255),
      description: [
        `${request.requesterName} (${request.requesterEmail}, ${request.requesterCompany}) confirmed a request for ${orgName}'s gated trust page documents.`,
        '', `Purpose: ${request.purpose}`, '', 'Approve or deny it in the organization\'s Trust Center tab.',
      ].join('\n'),
    }, TRUST_ACCESS_TICKET_ACTOR));
    return ticket?.id ?? null;
  } catch (err) {
    // Ticketing switched off for the partner is a configuration state, not a fault.
    if ((err as { code?: unknown } | null)?.code === 'service_management_off') {
      console.warn('[trustAccess] ticket per request is on but service management is off; no ticket', { requestId: request.id });
      return null;
    }
    console.error('[trustAccess] ticket creation failed (not retried)', { requestId: request.id }, err);
    captureException(err);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------- MSP

type Decision = { requestId: string; orgId: string; actorUserId: string; now: Date };

async function lockRequest(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], a: { requestId: string; orgId: string }) {
  const [request] = await tx.select().from(trustPageAccessRequests)
    .where(and(eq(trustPageAccessRequests.id, a.requestId), eq(trustPageAccessRequests.orgId, a.orgId)))
    .limit(1).for('update');
  if (!request) throw new TrustPageError('Not found', 404, 'NOT_FOUND');
  return request;
}
const invalidState = (status: string) =>
  new TrustPageError(`This request is ${status.replace(/_/g, ' ')}; reload the list.`, 409, 'INVALID_STATE');

async function namesFor(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], pageId: string) {
  const [names] = await tx.select({ orgName: organizations.name, partnerId: partners.id, partnerName: partners.name })
    .from(trustPages).innerJoin(organizations, eq(organizations.id, trustPages.orgId)).innerJoin(partners, eq(partners.id, trustPages.partnerId))
    .where(eq(trustPages.id, pageId)).limit(1);
  if (!names) throw new TrustPageError('Not found', 404, 'NOT_FOUND');
  return names;
}

/**
 * The grant is frozen at approval: the gated documents of the page's CURRENT snapshot that still have a live
 * gated link. Approving needs a published page and at least one such document.
 */
export async function approveAccessRequest(a: Decision & { note: string | null }): Promise<{ grantExpiresAt: Date; grantedDocumentIds: string[] }> {
  const out = await db.transaction(async (tx) => {
    const request = await lockRequest(tx, a);
    if (request.status !== 'pending_approval') throw invalidState(request.status);
    const [page] = await tx.select({
      publishedAt: trustPages.publishedAt, payload: trustPageSnapshots.payload,
      orgName: organizations.name, partnerId: partners.id, partnerName: partners.name,
    }).from(trustPages)
      .innerJoin(organizations, eq(organizations.id, trustPages.orgId))
      .innerJoin(partners, eq(partners.id, trustPages.partnerId))
      .leftJoin(trustPageSnapshots, and(eq(trustPageSnapshots.trustPageId, trustPages.id), eq(trustPageSnapshots.isCurrent, true)))
      .where(eq(trustPages.id, request.trustPageId)).limit(1);
    if (!page) throw new TrustPageError('Not found', 404, 'NOT_FOUND');
    if (!page.publishedAt) throw new TrustPageError('Publish the trust page before approving document requests.', 422, 'PAGE_NOT_PUBLISHED');
    const gated = page.payload ? gatedIdsOf(normalizeTrustPagePayload(page.payload as TrustPagePublicPayloadAny)) : [];
    const links = gated.length ? orderedLinks(gated, await liveGatedLinks(tx, request.trustPageId, gated)) : [];
    if (links.length === 0) {
      throw new TrustPageError('The published page has no gated document to share. Link one as "Available on request" and publish.', 422, 'NO_GATED_DOCUMENTS');
    }
    const grantExpiresAt = new Date(a.now.getTime() + GRANT_TTL_MS);
    const grantedDocumentIds = links.map((l) => l.id);
    await tx.update(trustPageAccessRequests).set({
      status: 'approved', decidedAt: a.now, decidedByUserId: a.actorUserId, decisionNote: a.note, grantExpiresAt, grantedDocumentIds, updatedAt: a.now,
    }).where(eq(trustPageAccessRequests.id, request.id));
    const raw = await mintAccessToken(tx, { requestId: request.id, orgId: request.orgId, purpose: 'download', ttlMs: GRANT_TTL_MS, now: a.now });
    return { request, page, raw, grantExpiresAt, grantedDocumentIds, titles: links.map((l) => l.title) };
  });
  // MSP routes run inside the request's transaction (the block above is a savepoint): mail only once it commits.
  runAfterDbContextCommit('trustAccess.approve.email', () => sendAccessGrantedEmail(
    { to: out.request.requesterEmail, partnerId: out.page.partnerId, partnerName: out.page.partnerName },
    { orgName: out.page.orgName, partnerName: out.page.partnerName, downloadUrl: downloadUrlFor(out.raw), expiresAt: out.grantExpiresAt, documentTitles: out.titles },
    out.request.id,
  ));
  return { grantExpiresAt: out.grantExpiresAt, grantedDocumentIds: out.grantedDocumentIds };
}

/** Deny a pending request. The requester is told only when their address was verified. */
export async function denyAccessRequest(a: Decision & { note: string | null }): Promise<void> {
  const out = await db.transaction(async (tx) => {
    const request = await lockRequest(tx, a);
    if (request.status !== 'pending_verification' && request.status !== 'pending_approval') throw invalidState(request.status);
    const names = await namesFor(tx, request.trustPageId);
    await tx.update(trustPageAccessRequests).set({
      status: 'denied', decidedAt: a.now, decidedByUserId: a.actorUserId, decisionNote: a.note, updatedAt: a.now,
    }).where(eq(trustPageAccessRequests.id, request.id));
    await tx.update(trustPageAccessTokens).set({ revokedAt: a.now })
      .where(and(eq(trustPageAccessTokens.requestId, request.id), isNull(trustPageAccessTokens.revokedAt)));
    return { request, names };
  });
  if (out.request.emailVerifiedAt) {
    runAfterDbContextCommit('trustAccess.deny.email', () => sendAccessDeniedEmail(
      { to: out.request.requesterEmail, partnerId: out.names.partnerId, partnerName: out.names.partnerName },
      { orgName: out.names.orgName, partnerName: out.names.partnerName, note: a.note },
      out.request.id,
    ));
  }
}

/** End an approved grant now: the request becomes revoked and every token of it stops working. */
export async function revokeAccessGrant(a: Decision): Promise<void> {
  await db.transaction(async (tx) => {
    const request = await lockRequest(tx, a);
    if (request.status !== 'approved') throw invalidState(request.status);
    await tx.update(trustPageAccessRequests).set({
      status: 'revoked', revokedAt: a.now, revokedByUserId: a.actorUserId, updatedAt: a.now,
    }).where(eq(trustPageAccessRequests.id, request.id));
    await tx.update(trustPageAccessTokens).set({ revokedAt: a.now })
      .where(and(eq(trustPageAccessTokens.requestId, request.id), isNull(trustPageAccessTokens.revokedAt)));
  });
}

/** A new download link for a live grant (the old link stops working); the grant's expiry does not move. */
export async function resendAccessGrant(a: Decision): Promise<void> {
  const out = await db.transaction(async (tx) => {
    const request = await lockRequest(tx, a);
    if (request.status !== 'approved') throw invalidState(request.status);
    if (!request.grantExpiresAt || request.grantExpiresAt.getTime() <= a.now.getTime()) {
      throw new TrustPageError('This grant has expired. Ask the requester to submit a new request.', 409, 'GRANT_EXPIRED');
    }
    const names = await namesFor(tx, request.trustPageId);
    const granted = request.grantedDocumentIds ?? [];
    const links = granted.length ? orderedLinks(granted, await liveGatedLinks(tx, request.trustPageId, granted)) : [];
    const raw = await mintAccessToken(tx, {
      requestId: request.id, orgId: request.orgId, purpose: 'download', ttlMs: request.grantExpiresAt.getTime() - a.now.getTime(), now: a.now,
    });
    return { request, names, raw, titles: links.map((l) => l.title), grantExpiresAt: request.grantExpiresAt };
  });
  runAfterDbContextCommit('trustAccess.resend.email', () => sendAccessGrantedEmail(
    { to: out.request.requesterEmail, partnerId: out.names.partnerId, partnerName: out.names.partnerName },
    { orgName: out.names.orgName, partnerName: out.names.partnerName, downloadUrl: downloadUrlFor(out.raw), expiresAt: out.grantExpiresAt, documentTitles: out.titles },
    out.request.id,
  ));
}

export interface TrustAccessRequestListItem {
  id: string; status: TrustPageAccessRequestRow['status']; requesterEmail: string; requesterName: string; requesterCompany: string;
  purpose: string; ndaAccepted: boolean; createdAt: string; emailVerifiedAt: string | null; decidedAt: string | null;
  decisionNote: string | null; grantExpiresAt: string | null; revokedAt: string | null; downloadCount: number;
  lastDownloadedAt: string | null; grantedDocumentIds: string[];
  /** When the current state lapses on its own: the verify link (pending_verification) or the grant (approved). */
  expiresAt: string | null; expired: boolean;
}

/** MSP inbox, newest first (≤100). Caller's db context. Expiry is computed from timestamps, never stored as a status. */
export async function listAccessRequests(orgId: string, status: TrustPageAccessRequestRow['status'] | undefined, now: Date): Promise<TrustAccessRequestListItem[]> {
  const rows = await db.select().from(trustPageAccessRequests)
    .where(and(eq(trustPageAccessRequests.orgId, orgId), status ? eq(trustPageAccessRequests.status, status) : undefined))
    .orderBy(sql`${trustPageAccessRequests.createdAt} DESC`, asc(trustPageAccessRequests.id)).limit(100);
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  return rows.map((r) => {
    const expiresAt = r.status === 'approved' ? r.grantExpiresAt
      : r.status === 'pending_verification' ? new Date(r.updatedAt.getTime() + VERIFY_TTL_MS) : null;
    return {
      id: r.id, status: r.status, requesterEmail: r.requesterEmail, requesterName: r.requesterName, requesterCompany: r.requesterCompany,
      purpose: r.purpose, ndaAccepted: r.ndaAcceptedAt !== null, createdAt: r.createdAt.toISOString(),
      emailVerifiedAt: iso(r.emailVerifiedAt), decidedAt: iso(r.decidedAt), decisionNote: r.decisionNote, grantExpiresAt: iso(r.grantExpiresAt),
      revokedAt: iso(r.revokedAt), downloadCount: r.downloadCount, lastDownloadedAt: iso(r.lastDownloadedAt),
      grantedDocumentIds: r.grantedDocumentIds ?? [],
      expiresAt: iso(expiresAt), expired: expiresAt !== null && expiresAt.getTime() <= now.getTime(),
    };
  });
}

// ---------------------------------------------------------------------------------------------- grant (anonymous)

export interface GrantView {
  orgName: string; expiresAt: string;
  documents: Array<{ id: string; title: string; category: string; contentType: string; byteSize: number }>;
}
export interface OpenedDocument {
  storageBackend: LiveLink['storageBackend']; storageKey: string | null; data: LiveLink['data'];
  contentType: string; originalFilename: string; byteSize: number;
  /** Who and what to record once the bytes actually start flowing (recordGrantedDownload). */
  grant: { requestId: string; orgId: string; pageId: string; requesterEmail: string; documentId: string };
}

/**
 * Every condition of a usable grant (codex's checklist), re-checked on every call. Caller holds the system ctx.
 * Null unless: a live download token; the request approved, verified and unexpired (grant_expires_at > now);
 * the page published, live and trusted (livePublicationPredicate); and, per document, it is in the grant, the
 * CURRENT snapshot lists it as gated, and a live gated link exists (confirmed, not deleted, not superseded).
 */
async function loadGrant(raw: string, now: Date) {
  const token = await findLiveToken(raw, 'download', now);
  if (!token) return null;
  const [request] = await db.select().from(trustPageAccessRequests)
    .where(and(eq(trustPageAccessRequests.id, token.requestId), eq(trustPageAccessRequests.orgId, token.orgId))).limit(1);
  if (!request || request.status !== 'approved' || !request.emailVerifiedAt) return null;
  if (!request.grantExpiresAt || request.grantExpiresAt.getTime() <= now.getTime()) return null;
  const [page] = await db.select({ orgName: organizations.name, payload: trustPageSnapshots.payload })
    .from(trustPages)
    .innerJoin(partners, eq(partners.id, trustPages.partnerId))
    .innerJoin(organizations, eq(organizations.id, trustPages.orgId))
    .leftJoin(trustPageSnapshots, and(eq(trustPageSnapshots.trustPageId, trustPages.id), eq(trustPageSnapshots.isCurrent, true)))
    .where(and(eq(trustPages.id, request.trustPageId), eq(trustPages.orgId, request.orgId), livePublicationPredicate()))
    .limit(1);
  if (!page?.payload) return null;
  const gated = new Set(gatedIdsOf(normalizeTrustPagePayload(page.payload as TrustPagePublicPayloadAny)));
  const ids = (request.grantedDocumentIds ?? []).filter((id) => gated.has(id));
  if (ids.length === 0) return null;
  const documents = orderedLinks(ids, await liveGatedLinks(db, request.trustPageId, ids));
  if (documents.length === 0) return null;
  return { request, orgName: page.orgName, documents, expiresAt: request.grantExpiresAt };
}

export async function readGrant(raw: string, now: Date): Promise<GrantView | null> {
  return sys(async () => {
    const grant = await loadGrant(raw, now);
    if (!grant) return null;
    return {
      orgName: grant.orgName, expiresAt: grant.expiresAt.toISOString(),
      documents: grant.documents.map((d) => ({ id: d.id, title: d.title, category: d.category, contentType: d.contentType, byteSize: d.byteSize })),
    };
  });
}

/**
 * Every condition re-checked (loadGrant); null when any fails. Records nothing: the route calls
 * recordGrantedDownload only after the blob opened, so a storage outage never counts or audits a download.
 */
export async function openGrantedDocument(raw: string, documentId: string, now: Date): Promise<OpenedDocument | null> {
  return sys(async () => {
    const grant = await loadGrant(raw, now);
    const doc = grant?.documents.find((d) => d.id === documentId);
    if (!grant || !doc) return null;
    return {
      storageBackend: doc.storageBackend, storageKey: doc.storageKey, data: doc.data,
      contentType: doc.contentType, originalFilename: doc.originalFilename, byteSize: doc.byteSize,
      grant: {
        requestId: grant.request.id, orgId: grant.request.orgId, pageId: grant.request.trustPageId,
        requesterEmail: grant.request.requesterEmail, documentId: doc.id,
      },
    };
  });
}

/** download_count + 1, last_downloaded_at, and audit `trust_page.access.download` with the requester as actor. */
export async function recordGrantedDownload(g: OpenedDocument['grant'], now: Date): Promise<void> {
  await sys(() => db.update(trustPageAccessRequests).set({
    downloadCount: sql`${trustPageAccessRequests.downloadCount} + 1`, lastDownloadedAt: now,
  }).where(and(eq(trustPageAccessRequests.id, g.requestId), eq(trustPageAccessRequests.orgId, g.orgId))));
  await auditAnonymous({
    orgId: g.orgId, pageId: g.pageId, action: 'trust_page.access.download', requesterEmail: g.requesterEmail,
    details: { requestId: g.requestId, documentId: g.documentId },
  });
}
