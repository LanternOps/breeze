import './setup';

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { trustPageAccessRequests, trustPageAccessTokens, trustPageDocuments } from '../../db/schema';
import { ensureTrustPage, publishTrustPage } from '../../services/trustPage/publication';

// Capture the raw tokens the service mails (fragment links); nothing is sent.
const mailed = vi.hoisted(() => ({ verify: [] as string[], download: [] as string[] }));
vi.mock('../../services/trustPage/access/emails', () => ({
  sendAccessVerificationEmail: vi.fn(async (_a: unknown, p: { verifyUrl: string }) => { mailed.verify.push(p.verifyUrl.split('#')[1]!); return true; }),
  sendAccessGrantedEmail: vi.fn(async (_a: unknown, p: { downloadUrl: string }) => { mailed.download.push(p.downloadUrl.split('#')[1]!); return true; }),
  sendAccessDeniedEmail: vi.fn(async () => true),
  sendStaffAccessRequestEmail: vi.fn(async () => true),
}));
// Staff fan-out needs seeded roles; the unit test covers it. Here: nobody to notify.
vi.mock('../../services/usersWithPermission', () => ({ resolveUsersWithPermissionForOrg: vi.fn(async () => []) }));

import {
  approveAccessRequest, createAccessRequest, openGrantedDocument, readGrant, revokeAccessGrant, verifyAccessRequest,
} from '../../services/trustPage/access/requests';
import { resolvePublishedTrustPage } from '../../services/trustPage/resolve';
import { pruneTrustAccessData } from '../../services/trustPage/access/retention';
import { normalizeTrustPagePayload } from '@breeze/shared';

const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

interface Seeded { partnerId: string; orgId: string; userId: string; partnerSlug: string; orgSlug: string; pageId: string; docId: string }

async function seedPublishedPageWithGatedDocument(): Promise<Seeded> {
  const t = getTestDb();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const partnerSlug = `gate-int-${suffix}`; const orgSlug = `acme-gate-${suffix}`;
  const [partner] = (await t.execute(sql`INSERT INTO partners (name, slug, status, trust_state, created_at, updated_at)
    VALUES ('Northwind IT', ${partnerSlug}, 'active', 'trusted', now(), now()) RETURNING id`)) as unknown as Array<{ id: string }>;
  const [user] = (await t.execute(sql`INSERT INTO users (partner_id, email, name, status, created_at, updated_at)
    VALUES (${partner!.id}, ${`gate-${suffix}@example.com`}, 'Gate Admin', 'active', now(), now()) RETURNING id`)) as unknown as Array<{ id: string }>;
  const [org] = (await t.execute(sql`INSERT INTO organizations (partner_id, name, slug, status, currency_code, created_at, updated_at)
    VALUES (${partner!.id}, 'Acme Dental', ${orgSlug}, 'active', 'USD', now(), now()) RETURNING id`)) as unknown as Array<{ id: string }>;
  const [doc] = (await t.execute(sql`INSERT INTO org_documents (org_id, title, category, storage_backend, data, content_type, byte_size, sha256, original_filename)
    VALUES (${org!.id}, 'SOC 2 Type II', 'report', 'db', '\\x01'::bytea, 'application/pdf', 1, ${'a'.repeat(64)}, 'soc2.pdf') RETURNING id`)) as unknown as Array<{ id: string }>;
  const page = await sys(() => ensureTrustPage(org!.id, user!.id));
  await sys(() => db.insert(trustPageDocuments).values({
    trustPageId: page.id, documentId: doc!.id, orgId: org!.id, visibility: 'gated', sortOrder: 0,
    disclosureConfirmedAt: new Date(), disclosureConfirmedByUserId: user!.id,
  }));
  await sys(() => publishTrustPage({
    orgId: org!.id, expectedRevision: 0, actorUserId: user!.id, authorization: { authorizedBy: 'Jane Doe, COO' },
    partnerTrustState: 'trusted', partnerSlug, orgSlug,
  }));
  return { partnerId: partner!.id, orgId: org!.id, userId: user!.id, partnerSlug, orgSlug, pageId: page.id, docId: doc!.id };
}

async function requestAndVerify(s: Seeded, email: string): Promise<string> {
  const resolved = await sys(() => resolvePublishedTrustPage(s.partnerSlug, s.orgSlug));
  const payload = normalizeTrustPagePayload(resolved!.payload!);
  expect(payload.documents.map((d) => d.visibility)).toEqual(['gated']);
  expect(payload.access).toEqual({ ndaText: null });
  await createAccessRequest({ partnerSlug: s.partnerSlug, orgSlug: s.orgSlug, email, name: 'Ins Urer', company: 'Example Insurance', purpose: 'Underwriting review.', ndaAccepted: false },
    { pageId: resolved!.pageId, orgId: resolved!.orgId, partnerId: resolved!.partnerId }, payload, new Date());
  const raw = mailed.verify.at(-1)!;
  await expect(verifyAccessRequest(raw, new Date())).resolves.toEqual({ orgName: 'Acme Dental' });
  const [row] = await sys(() => db.select().from(trustPageAccessRequests).where(and(eq(trustPageAccessRequests.trustPageId, s.pageId), eq(trustPageAccessRequests.requesterEmail, email))));
  return row!.id;
}

const liveDownloadTokens = (requestId: string) => sys(() => db.select().from(trustPageAccessTokens)
  .where(and(eq(trustPageAccessTokens.requestId, requestId), eq(trustPageAccessTokens.purpose, 'download'), isNull(trustPageAccessTokens.revokedAt))));
const statusOf = async (requestId: string) =>
  (await sys(() => db.select({ status: trustPageAccessRequests.status }).from(trustPageAccessRequests).where(eq(trustPageAccessRequests.id, requestId))))[0]!.status;

describe('trust access requests (real DB)', () => {
  let s: Seeded;
  beforeEach(async () => { mailed.verify = []; mailed.download = []; s = await seedPublishedPageWithGatedDocument(); });

  it('verify is one-shot: the second POST of the same token is null and the request stays pending_approval', async () => {
    const id = await requestAndVerify(s, `one-shot-${Date.now()}@example.test`);
    await expect(verifyAccessRequest(mailed.verify.at(-1)!, new Date())).resolves.toBeNull();
    expect(await statusOf(id)).toBe('pending_approval');
  });

  it('approve → readGrant + openGrantedDocument work; after revoke the same link is dead', async () => {
    const id = await requestAndVerify(s, `grant-${Date.now()}@example.test`);
    const out = await sys(() => approveAccessRequest({ requestId: id, orgId: s.orgId, actorUserId: s.userId, note: null, now: new Date() }));
    expect(out.grantedDocumentIds).toEqual([s.docId]);
    const raw = mailed.download.at(-1)!;
    await expect(readGrant(raw, new Date())).resolves.toMatchObject({ orgName: 'Acme Dental', documents: [{ id: s.docId, title: 'SOC 2 Type II' }] });
    await expect(openGrantedDocument(raw, s.docId, new Date())).resolves.toMatchObject({ originalFilename: 'soc2.pdf', contentType: 'application/pdf' });
    const [counted] = await sys(() => db.select().from(trustPageAccessRequests).where(eq(trustPageAccessRequests.id, id)));
    expect(counted!.downloadCount).toBe(1);

    await sys(() => revokeAccessGrant({ requestId: id, orgId: s.orgId, actorUserId: s.userId, now: new Date() }));
    await expect(readGrant(raw, new Date())).resolves.toBeNull();
    await expect(openGrantedDocument(raw, s.docId, new Date())).resolves.toBeNull();
  });

  it('a live link switched back to public stops the gated download at once', async () => {
    const id = await requestAndVerify(s, `flip-${Date.now()}@example.test`);
    await sys(() => approveAccessRequest({ requestId: id, orgId: s.orgId, actorUserId: s.userId, note: null, now: new Date() }));
    await sys(() => db.update(trustPageDocuments).set({ visibility: 'public' }).where(eq(trustPageDocuments.trustPageId, s.pageId)));
    await expect(openGrantedDocument(mailed.download.at(-1)!, s.docId, new Date())).resolves.toBeNull();
  });

  it('approve racing revoke ends in exactly one terminal state, with tokens consistent with it', async () => {
    const id = await requestAndVerify(s, `race-${Date.now()}@example.test`);
    const now = new Date();
    const results = await Promise.allSettled([
      sys(() => approveAccessRequest({ requestId: id, orgId: s.orgId, actorUserId: s.userId, note: null, now })),
      sys(() => revokeAccessGrant({ requestId: id, orgId: s.orgId, actorUserId: s.userId, now })),
    ]);
    expect(results[0]!.status).toBe('fulfilled');
    const status = await statusOf(id);
    expect(['approved', 'revoked']).toContain(status);
    const live = await liveDownloadTokens(id);
    if (status === 'approved') {
      expect(results[1]).toMatchObject({ status: 'rejected', reason: { status: 409, code: 'INVALID_STATE' } });
      expect(live).toHaveLength(1);
    } else {
      expect(results[1]!.status).toBe('fulfilled');
      expect(live).toHaveLength(0);
    }
  });

  it('retention: a 366-day-old denied request is deleted with its tokens; a live approved grant is kept whatever its age', async () => {
    const denied = await requestAndVerify(s, `old-denied-${Date.now()}@example.test`);
    const granted = await requestAndVerify(s, `old-granted-${Date.now()}@example.test`);
    await sys(() => approveAccessRequest({ requestId: granted, orgId: s.orgId, actorUserId: s.userId, note: null, now: new Date() }));
    await getTestDb().execute(sql`UPDATE trust_page_access_requests SET status = 'denied', updated_at = now() - interval '366 days' WHERE id = ${denied}`);
    await getTestDb().execute(sql`UPDATE trust_page_access_requests SET updated_at = now() - interval '400 days' WHERE id = ${granted}`);
    const before = await sys(() => db.select().from(trustPageAccessTokens).where(eq(trustPageAccessTokens.requestId, denied)));
    expect(before.length).toBeGreaterThan(0);

    const out = await pruneTrustAccessData(new Date());
    expect(out.requests).toBeGreaterThanOrEqual(1);
    const left = await sys(() => db.select({ id: trustPageAccessRequests.id }).from(trustPageAccessRequests).where(eq(trustPageAccessRequests.trustPageId, s.pageId)));
    expect(left.map((r) => r.id)).toEqual([granted]);
    expect(await sys(() => db.select().from(trustPageAccessTokens).where(eq(trustPageAccessTokens.requestId, denied)))).toHaveLength(0);
    expect(await liveDownloadTokens(granted)).toHaveLength(1);
  });

  it('retention: tokens 30+ days past expiry are deleted, recent ones kept', async () => {
    const id = await requestAndVerify(s, `old-token-${Date.now()}@example.test`);
    await getTestDb().execute(sql`UPDATE trust_page_access_tokens SET expires_at = now() - interval '31 days' WHERE request_id = ${id}`);
    const out = await pruneTrustAccessData(new Date());
    expect(out.tokens).toBeGreaterThanOrEqual(1);
    expect(await sys(() => db.select().from(trustPageAccessTokens).where(eq(trustPageAccessTokens.requestId, id)))).toHaveLength(0);
    expect(await statusOf(id)).toBe('pending_approval');
  });

  it('two concurrent approvals: one wins, the other 409s, and exactly one download token exists', async () => {
    const id = await requestAndVerify(s, `double-${Date.now()}@example.test`);
    const now = new Date();
    const results = await Promise.allSettled([
      sys(() => approveAccessRequest({ requestId: id, orgId: s.orgId, actorUserId: s.userId, note: null, now })),
      sys(() => approveAccessRequest({ requestId: id, orgId: s.orgId, actorUserId: s.userId, note: null, now })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { status: 409, code: 'INVALID_STATE' } });
    const all = await sys(() => db.select().from(trustPageAccessTokens).where(and(eq(trustPageAccessTokens.requestId, id), eq(trustPageAccessTokens.purpose, 'download'))));
    expect(all).toHaveLength(1);
  });
});
