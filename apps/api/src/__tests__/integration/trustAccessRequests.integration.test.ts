import './setup';

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
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
  approveAccessRequest, createAccessRequest, denyAccessRequest, openGrantedDocument, readGrant, recordGrantedDownload,
  resendAccessGrant, revokeAccessGrant, verifyAccessRequest,
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

/** Create a request (verification mail only, not confirmed). Returns the request id and the raw verify token. */
async function createOnly(s: Seeded, email: string): Promise<{ id: string; verifyRaw: string }> {
  const resolved = await sys(() => resolvePublishedTrustPage(s.partnerSlug, s.orgSlug));
  const payload = normalizeTrustPagePayload(resolved!.payload!);
  const sent = mailed.verify.length;
  await createAccessRequest({ partnerSlug: s.partnerSlug, orgSlug: s.orgSlug, email, name: 'Ins Urer', company: 'Example Insurance', purpose: 'Underwriting review.', ndaAccepted: false },
    { pageId: resolved!.pageId, orgId: resolved!.orgId, partnerId: resolved!.partnerId }, payload, new Date());
  expect(mailed.verify.length).toBe(sent + 1);
  const [row] = await sys(() => db.select().from(trustPageAccessRequests).where(and(eq(trustPageAccessRequests.trustPageId, s.pageId), eq(trustPageAccessRequests.requesterEmail, email))));
  return { id: row!.id, verifyRaw: mailed.verify.at(-1)! };
}

/** Approve and return the raw download token from the (post-commit, possibly async) grant mail. */
async function approveRaw(s: Seeded, requestId: string, now = new Date()): Promise<string> {
  const sent = mailed.download.length;
  await sys(() => approveAccessRequest({ requestId, orgId: s.orgId, actorUserId: s.userId, note: null, now }));
  await vi.waitFor(() => expect(mailed.download.length).toBe(sent + 1));
  return mailed.download.at(-1)!;
}

const tokenHash = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex');
const allTokens = (requestId: string) => sys(() => db.select().from(trustPageAccessTokens).where(eq(trustPageAccessTokens.requestId, requestId)));
const rowOf = async (requestId: string) =>
  (await sys(() => db.select().from(trustPageAccessRequests).where(eq(trustPageAccessRequests.id, requestId))))[0]!;

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
    const sent = mailed.download.length;
    const out = await sys(() => approveAccessRequest({ requestId: id, orgId: s.orgId, actorUserId: s.userId, note: null, now: new Date() }));
    expect(out.grantedDocumentIds).toEqual([s.docId]);
    // The grant email goes out after the system context exits (runAfterDbContextCommit), maybe after approve resolves.
    await vi.waitFor(() => expect(mailed.download.length).toBe(sent + 1));
    const raw = mailed.download.at(-1)!;
    await expect(readGrant(raw, new Date())).resolves.toMatchObject({ orgName: 'Acme Dental', documents: [{ id: s.docId, title: 'SOC 2 Type II' }] });
    const opened = await openGrantedDocument(raw, s.docId, new Date());
    expect(opened).toMatchObject({ originalFilename: 'soc2.pdf', contentType: 'application/pdf' });
    // openGrantedDocument records nothing; the route counts a download only after the blob opened.
    expect((await rowOf(id)).downloadCount).toBe(0);
    await recordGrantedDownload(opened!.grant, new Date());
    const [counted] = await sys(() => db.select().from(trustPageAccessRequests).where(eq(trustPageAccessRequests.id, id)));
    expect(counted!.downloadCount).toBe(1);

    await sys(() => revokeAccessGrant({ requestId: id, orgId: s.orgId, actorUserId: s.userId, now: new Date() }));
    await expect(readGrant(raw, new Date())).resolves.toBeNull();
    await expect(openGrantedDocument(raw, s.docId, new Date())).resolves.toBeNull();
  });

  it('a live link switched back to public stops the gated download at once', async () => {
    const id = await requestAndVerify(s, `flip-${Date.now()}@example.test`);
    const raw = await approveRaw(s, id);
    await expect(openGrantedDocument(raw, s.docId, new Date())).resolves.not.toBeNull();
    await sys(() => db.update(trustPageDocuments).set({ visibility: 'public' }).where(eq(trustPageDocuments.trustPageId, s.pageId)));
    await expect(openGrantedDocument(raw, s.docId, new Date())).resolves.toBeNull();
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

  // ------------------------------------------------------------------------------ SQL-side grant conditions
  describe('every SQL-side grant condition kills the link (readGrant AND openGrantedDocument)', () => {
    const breakers: Array<[string, (x: Seeded) => Promise<void>]> = [
      ['page unpublished', async (x) => { await getTestDb().execute(sql`UPDATE trust_pages SET published_at = NULL WHERE id = ${x.pageId}`); }],
      ['document soft-deleted', async (x) => { await getTestDb().execute(sql`UPDATE org_documents SET deleted_at = now() WHERE id = ${x.docId}`); }],
      ['document superseded by a successor', async (x) => {
        await getTestDb().execute(sql`INSERT INTO org_documents (org_id, title, category, storage_backend, data, content_type, byte_size, sha256, original_filename, supersedes_document_id)
          VALUES (${x.orgId}, 'SOC 2 Type II v2', 'report', 'db', '\\x02'::bytea, 'application/pdf', 1, ${'b'.repeat(64)}, 'soc2v2.pdf', ${x.docId})`);
      }],
      ['trust page document link deleted', async (x) => { await getTestDb().execute(sql`DELETE FROM trust_page_documents WHERE trust_page_id = ${x.pageId}`); }],
    ];

    for (const [name, brk] of breakers) {
      it(name, async () => {
        const id = await requestAndVerify(s, `cond-${Math.random().toString(36).slice(2)}@example.test`);
        const raw = await approveRaw(s, id);
        await expect(readGrant(raw, new Date())).resolves.not.toBeNull();
        await expect(openGrantedDocument(raw, s.docId, new Date())).resolves.not.toBeNull();
        await brk(s);
        await expect(readGrant(raw, new Date())).resolves.toBeNull();
        await expect(openGrantedDocument(raw, s.docId, new Date())).resolves.toBeNull();
      });
    }

    it('partner not trusted (partnerTrustMode only evaluates when hosted: IS_HOSTED=true + enforce for this case)', async () => {
      const prev = { hosted: process.env.IS_HOSTED, mode: process.env.PARTNER_TRUST_MODE };
      process.env.IS_HOSTED = 'true'; process.env.PARTNER_TRUST_MODE = 'enforce';
      try {
        const id = await requestAndVerify(s, `cond-trust-${Date.now()}@example.test`);
        const raw = await approveRaw(s, id);
        await expect(readGrant(raw, new Date())).resolves.not.toBeNull();
        await expect(openGrantedDocument(raw, s.docId, new Date())).resolves.not.toBeNull();
        await getTestDb().execute(sql`UPDATE partners SET trust_state = 'probation' WHERE id = ${s.partnerId}`);
        await expect(readGrant(raw, new Date())).resolves.toBeNull();
        await expect(openGrantedDocument(raw, s.docId, new Date())).resolves.toBeNull();
      } finally {
        if (prev.hosted === undefined) delete process.env.IS_HOSTED; else process.env.IS_HOSTED = prev.hosted;
        if (prev.mode === undefined) delete process.env.PARTNER_TRUST_MODE; else process.env.PARTNER_TRUST_MODE = prev.mode;
      }
    });

    // trust_page_documents_confirmed_chk (CHECK disclosure_confirmed_at IS NOT NULL) makes an unconfirmed link
    // unreachable, so that SQL-side condition cannot be broken from outside; assert the constraint holds instead.
    it('an unconfirmed link cannot exist (CHECK trust_page_documents_confirmed_chk), so that condition is skipped', async () => {
      await expect(getTestDb().execute(sql`UPDATE trust_page_documents SET disclosure_confirmed_at = NULL WHERE trust_page_id = ${s.pageId}`))
        .rejects.toThrow();
      const [link] = await sys(() => db.select().from(trustPageDocuments).where(eq(trustPageDocuments.trustPageId, s.pageId)));
      expect(link!.disclosureConfirmedAt).not.toBeNull();
    });

    it('current snapshot lists the document as public while the live link is gated', async () => {
      const id = await requestAndVerify(s, `cond-snap-${Date.now()}@example.test`);
      const raw = await approveRaw(s, id);
      await expect(openGrantedDocument(raw, s.docId, new Date())).resolves.not.toBeNull();
      // Snapshot payloads are immutable: publish a new current snapshot with the link public, then flip the live link back.
      await getTestDb().execute(sql`UPDATE trust_page_documents SET visibility = 'public' WHERE trust_page_id = ${s.pageId}`);
      const [pg] = (await getTestDb().execute(sql`SELECT publication_revision AS rev FROM trust_pages WHERE id = ${s.pageId}`)) as unknown as Array<{ rev: number }>;
      await sys(() => publishTrustPage({
        orgId: s.orgId, expectedRevision: pg!.rev, actorUserId: s.userId, authorization: { authorizedBy: 'Jane Doe, COO' },
        partnerTrustState: 'trusted', partnerSlug: s.partnerSlug, orgSlug: s.orgSlug,
      }));
      await getTestDb().execute(sql`UPDATE trust_page_documents SET visibility = 'gated' WHERE trust_page_id = ${s.pageId}`);
      const [cur] = (await getTestDb().execute(sql`SELECT payload->'documents' AS docs FROM trust_page_snapshots WHERE trust_page_id = ${s.pageId} AND is_current`)) as unknown as Array<{ docs: Array<{ visibility: string }> }>;
      expect(cur!.docs.map((d) => d.visibility)).toEqual(['public']);
      await expect(readGrant(raw, new Date())).resolves.toBeNull();
      await expect(openGrantedDocument(raw, s.docId, new Date())).resolves.toBeNull();
    });

    it('grant_expires_at reached', async () => {
      const id = await requestAndVerify(s, `cond-grant-${Date.now()}@example.test`);
      const raw = await approveRaw(s, id);
      await expect(readGrant(raw, new Date())).resolves.not.toBeNull();
      await expect(openGrantedDocument(raw, s.docId, new Date())).resolves.not.toBeNull();
      // A minute in the past, not now(): the DB container's clock and the host's can differ by a second or two
      // (the exact-boundary case is the unit test's).
      await getTestDb().execute(sql`UPDATE trust_page_access_requests SET grant_expires_at = now() - interval '1 minute' WHERE id = ${id}`);
      await expect(readGrant(raw, new Date())).resolves.toBeNull();
      await expect(openGrantedDocument(raw, s.docId, new Date())).resolves.toBeNull();
    });

    it('download token expires_at reached', async () => {
      const id = await requestAndVerify(s, `cond-tok-${Date.now()}@example.test`);
      const raw = await approveRaw(s, id);
      await expect(readGrant(raw, new Date())).resolves.not.toBeNull();
      await expect(openGrantedDocument(raw, s.docId, new Date())).resolves.not.toBeNull();
      await getTestDb().execute(sql`UPDATE trust_page_access_tokens SET expires_at = now() - interval '1 minute' WHERE request_id = ${id} AND purpose = 'download'`);
      await expect(readGrant(raw, new Date())).resolves.toBeNull();
      await expect(openGrantedDocument(raw, s.docId, new Date())).resolves.toBeNull();
    });

    it('a verify-purpose token never opens a grant, even when otherwise live', async () => {
      const id = await requestAndVerify(s, `cond-purpose-${Date.now()}@example.test`);
      const verifyRaw = mailed.verify.at(-1)!;
      const downloadRaw = await approveRaw(s, id);
      // Make the verify token fully live (unconsumed, unrevoked, unexpired): only its purpose is wrong.
      await getTestDb().execute(sql`UPDATE trust_page_access_tokens SET consumed_at = NULL, revoked_at = NULL, expires_at = now() + interval '1 day'
        WHERE request_id = ${id} AND purpose = 'verify_email'`);
      const verifyRow = (await allTokens(id)).find((t) => t.purpose === 'verify_email')!;
      expect(verifyRow.consumedAt).toBeNull(); expect(verifyRow.revokedAt).toBeNull();
      expect(verifyRow.tokenHash).toBe(tokenHash(verifyRaw));
      await expect(readGrant(downloadRaw, new Date())).resolves.not.toBeNull();
      await expect(openGrantedDocument(downloadRaw, s.docId, new Date())).resolves.not.toBeNull();
      await expect(readGrant(verifyRaw, new Date())).resolves.toBeNull();
      await expect(openGrantedDocument(verifyRaw, s.docId, new Date())).resolves.toBeNull();
    });
  });

  // ------------------------------------------------------------------------------ cross-org ids
  describe('cross-org request ids', () => {
    type Op = 'approve' | 'deny' | 'revoke' | 'resend';
    const run = (op: Op, orgId: string, requestId: string, userId: string) => {
      const a = { requestId, orgId, actorUserId: userId, now: new Date() };
      return sys<unknown>(() => op === 'approve' ? approveAccessRequest({ ...a, note: null })
        : op === 'deny' ? denyAccessRequest({ ...a, note: null })
          : op === 'revoke' ? revokeAccessGrant(a) : resendAccessGrant(a));
    };
    const expected: Record<Op, string> = { approve: 'approved', deny: 'denied', revoke: 'revoked', resend: 'approved' };
    for (const op of ['approve', 'deny', 'revoke', 'resend'] as const) {
      it(`${op} with another org's id is a 404 that changes nothing; the owner's id succeeds`, async () => {
        const b = await seedPublishedPageWithGatedDocument();
        const bId = await requestAndVerify(b, `xorg-b-${op}-${Date.now()}@example.test`);
        const aId = await requestAndVerify(s, `xorg-a-${op}-${Date.now()}@example.test`);
        const needsApproved = op === 'revoke' || op === 'resend';
        if (needsApproved) await approveRaw(s, aId);
        const startStatus = needsApproved ? 'approved' : 'pending_approval';
        const tokensBefore = (await allTokens(aId)).length;
        expect(await statusOf(aId)).toBe(startStatus);

        await expect(run(op, b.orgId, aId, b.userId)).rejects.toMatchObject({ status: 404 });
        expect(await statusOf(aId)).toBe(startStatus);
        expect((await allTokens(aId)).length).toBe(tokensBefore);
        expect(await statusOf(bId)).toBe('pending_approval');
        expect(await liveDownloadTokens(bId)).toHaveLength(0);

        await run(op, s.orgId, aId, s.userId);
        expect(await statusOf(aId)).toBe(expected[op]);
        if (op === 'resend') expect((await allTokens(aId)).length).toBe(tokensBefore + 1);
      });
    }
  });

  // ------------------------------------------------------------------------------ approve racing deny
  it('approve racing deny ends in one terminal state with tokens consistent with it (5 rounds)', async () => {
    for (let i = 0; i < 5; i++) {
      const id = await requestAndVerify(s, `racedeny-${i}-${Date.now()}@example.test`);
      const mailBefore = mailed.download.length;
      const now = new Date();
      const [ap, dn] = await Promise.allSettled([
        sys(() => approveAccessRequest({ requestId: id, orgId: s.orgId, actorUserId: s.userId, note: null, now })),
        sys(() => denyAccessRequest({ requestId: id, orgId: s.orgId, actorUserId: s.userId, note: null, now })),
      ]);
      const status = await statusOf(id);
      expect(['approved', 'denied']).toContain(status);
      const live = await liveDownloadTokens(id);
      if (status === 'denied') {
        expect(dn!.status).toBe('fulfilled');
        expect(ap).toMatchObject({ status: 'rejected', reason: { status: 409, code: 'INVALID_STATE' } });
        expect(live).toHaveLength(0);
        await new Promise((r) => setImmediate(r));
        expect(mailed.download.length).toBe(mailBefore); // no grant mail, so no usable link was ever issued
        expect((await allTokens(id)).every((t) => t.revokedAt !== null)).toBe(true);
        // Null-safe: a denied request has no raw download link to probe (none was mailed), and every token row is revoked.
        expect(mailed.download.at(-1) === undefined || (await rowOf(id)).status === 'denied').toBe(true);
      } else {
        expect(ap!.status).toBe('fulfilled');
        expect(dn).toMatchObject({ status: 'rejected', reason: { status: 409, code: 'INVALID_STATE' } });
        expect(live).toHaveLength(1);
        await vi.waitFor(() => expect(mailed.download.length).toBe(mailBefore + 1));
        await expect(readGrant(mailed.download.at(-1)!, new Date())).resolves.not.toBeNull();
      }
    }
  });

  // ------------------------------------------------------------------------------ verify-token edge cases
  describe('verify token edge cases', () => {
    it('a download-purpose token posted to verify is null and changes nothing', async () => {
      const okId = await requestAndVerify(s, `vx-a-ok-${Date.now()}@example.test`);
      const downloadRaw = await approveRaw(s, okId);
      const y = await createOnly(s, `vx-a-${Date.now()}@example.test`);
      await expect(verifyAccessRequest(downloadRaw, new Date())).resolves.toBeNull();
      expect(await statusOf(y.id)).toBe('pending_verification');
      expect(await statusOf(okId)).toBe('approved');
      await expect(verifyAccessRequest(y.verifyRaw, new Date())).resolves.toEqual({ orgName: 'Acme Dental' });
    });

    it('an expired verify token is null and changes nothing', async () => {
      const email = `vx-b-${Date.now()}@example.test`;
      const y = await createOnly(s, email);
      await getTestDb().execute(sql`UPDATE trust_page_access_tokens SET expires_at = now() - interval '1 minute' WHERE request_id = ${y.id}`);
      await expect(verifyAccessRequest(y.verifyRaw, new Date())).resolves.toBeNull();
      expect(await statusOf(y.id)).toBe('pending_verification');
      expect((await rowOf(y.id)).emailVerifiedAt).toBeNull();
      // Control: a fresh request for the same address gets a working link.
      const again = await createOnly(s, email);
      await expect(verifyAccessRequest(again.verifyRaw, new Date())).resolves.toEqual({ orgName: 'Acme Dental' });
    });

    it('a repeat request for the same unconfirmed address revokes the first link', async () => {
      const email = `vx-c-${Date.now()}@example.test`;
      const first = await createOnly(s, email);
      const second = await createOnly(s, email);
      expect(second.id).toBe(first.id);
      expect(second.verifyRaw).not.toBe(first.verifyRaw);
      await expect(verifyAccessRequest(first.verifyRaw, new Date())).resolves.toBeNull();
      expect(await statusOf(first.id)).toBe('pending_verification');
      await expect(verifyAccessRequest(second.verifyRaw, new Date())).resolves.toEqual({ orgName: 'Acme Dental' });
      expect(await statusOf(first.id)).toBe('pending_approval');
    });

    it('a verify token of an already denied request is null and the request stays denied', async () => {
      const y = await createOnly(s, `vx-d-${Date.now()}@example.test`);
      const ctl = await createOnly(s, `vx-d-ctl-${Date.now()}@example.test`);
      await sys(() => denyAccessRequest({ requestId: y.id, orgId: s.orgId, actorUserId: s.userId, note: null, now: new Date() }));
      await expect(verifyAccessRequest(y.verifyRaw, new Date())).resolves.toBeNull();
      expect(await statusOf(y.id)).toBe('denied');
      await expect(verifyAccessRequest(ctl.verifyRaw, new Date())).resolves.toEqual({ orgName: 'Acme Dental' });
    });
  });

  // ------------------------------------------------------------------------------ retention boundaries
  describe('pruneTrustAccessData boundaries', () => {
    it('an expired-grant approved request is deleted at 366 days and kept at 364', async () => {
      const old = await requestAndVerify(s, `ret-366-${Date.now()}@example.test`);
      const fresh = await requestAndVerify(s, `ret-364-${Date.now()}@example.test`);
      await approveRaw(s, old); await approveRaw(s, fresh);
      await getTestDb().execute(sql`UPDATE trust_page_access_requests SET grant_expires_at = now() - interval '1 day', updated_at = now() - interval '366 days' WHERE id = ${old}`);
      await getTestDb().execute(sql`UPDATE trust_page_access_requests SET grant_expires_at = now() - interval '1 day', updated_at = now() - interval '364 days' WHERE id = ${fresh}`);
      await pruneTrustAccessData(new Date());
      const left = (await sys(() => db.select({ id: trustPageAccessRequests.id }).from(trustPageAccessRequests).where(eq(trustPageAccessRequests.trustPageId, s.pageId)))).map((r) => r.id);
      expect(left).toContain(fresh);
      expect(left).not.toContain(old);
      expect(await allTokens(old)).toHaveLength(0);
      expect((await allTokens(fresh)).length).toBeGreaterThan(0);
    });

    it('a token 29 days past expiry survives while one 31 days past is deleted in the same run', async () => {
      const id = await requestAndVerify(s, `ret-tok-${Date.now()}@example.test`);
      await approveRaw(s, id);
      const h29 = tokenHash(randomUUID()); const h31 = tokenHash(randomUUID());
      for (const [h, days] of [[h29, 29], [h31, 31]] as const) {
        await getTestDb().execute(sql`INSERT INTO trust_page_access_tokens (request_id, org_id, purpose, token_hash, expires_at, revoked_at)
          VALUES (${id}, ${s.orgId}, 'verify_email', ${h}, now() - (${days} * interval '1 day'), now())`);
      }
      const present = async (h: string) => (await sys(() => db.select({ id: trustPageAccessTokens.id }).from(trustPageAccessTokens).where(eq(trustPageAccessTokens.tokenHash, h)))).length;
      expect(await present(h29)).toBe(1); expect(await present(h31)).toBe(1);
      await pruneTrustAccessData(new Date());
      expect(await present(h29)).toBe(1);
      expect(await present(h31)).toBe(0);
      expect(await statusOf(id)).toBe('approved');
    });
  });
});
