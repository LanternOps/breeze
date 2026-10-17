import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

// ---- a scripted db: each select() resolves to the next queued result; writes are logged.
const script = vi.hoisted(() => ({
  selects: [] as unknown[][],
  writes: [] as Array<{ op: 'insert' | 'update'; values: Record<string, unknown> }>,
  insertReturning: [] as unknown[][],
}));
function chain(result: unknown): unknown {
  const proxy: unknown = new Proxy(function () { /* target */ }, {
    get(_t, prop) {
      if (prop === 'then') return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
      return () => proxy;
    },
  });
  return proxy;
}
const fakeDb = vi.hoisted(() => ({} as Record<string, unknown>));
vi.mock('../../../db', () => {
  Object.assign(fakeDb, {
    select: () => chain(script.selects.shift() ?? []),
    insert: () => ({ values: (v: Record<string, unknown>) => { script.writes.push({ op: 'insert', values: v }); return chain(script.insertReturning.shift() ?? [{ id: 'new-req' }]); } }),
    update: () => ({ set: (v: Record<string, unknown>) => { script.writes.push({ op: 'update', values: v }); return chain([{ id: 'x' }]); } }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeDb),
  });
  return { db: fakeDb, runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn() };
});

const emails = vi.hoisted(() => ({
  sendAccessVerificationEmail: vi.fn(async () => true), sendAccessGrantedEmail: vi.fn(async () => true),
  sendAccessDeniedEmail: vi.fn(async () => true), sendStaffAccessRequestEmail: vi.fn(async () => true),
}));
vi.mock('./emails', () => emails);
const createNotification = vi.hoisted(() => vi.fn(async () => 'n1'));
vi.mock('../../userNotifications', () => ({ createNotification }));
const resolveUsersWithPermissionForOrg = vi.hoisted(() => vi.fn(async () => ['staff-1']));
vi.mock('../../usersWithPermission', () => ({ resolveUsersWithPermissionForOrg }));
const createTicket = vi.hoisted(() => vi.fn(async () => ({ id: 'ticket-1' })));
vi.mock('../../ticketService', () => ({ createTicket }));
const audit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../auditService', () => ({ createAuditLogAsync: audit }));
vi.mock('../../portalUrl', () => ({ portalBase: () => 'https://portal.example.test/portal' }));

import {
  approveAccessRequest, createAccessRequest, denyAccessRequest, openGrantedDocument, readGrant, resendAccessGrant,
  revokeAccessGrant, verifyAccessRequest,
} from './requests';
import { hashAccessToken } from './tokens';
import type { TrustPagePublicPayload } from '@breeze/shared';

const NOW = new Date('2026-10-17T12:00:00.000Z');
const RAW = 'Q'.repeat(48);
const DOC = '0b9a4f4e-3b8e-4f2a-9c51-7d1f2c0e9a11';
const DOC2 = '1c9a4f4e-3b8e-4f2a-9c51-7d1f2c0e9a22';
const NDA = 'You agree not to share these documents.';
const resolved = { pageId: 'page-1', orgId: 'org-1', partnerId: 'partner-1' };

function payload(over: Partial<TrustPagePublicPayload> = {}): TrustPagePublicPayload {
  return {
    schemaVersion: 2,
    snapshotId: '2a9a4f4e-3b8e-4f2a-9c51-7d1f2c0e9a33',
    documents: [
      { id: DOC, title: 'SOC 2 report', category: 'report', contentType: 'application/pdf', byteSize: 10, updatedAt: NOW.toISOString(), visibility: 'gated' },
    ],
    access: { ndaText: NDA },
    ...over,
  } as TrustPagePublicPayload;
}
const input = (over: Record<string, unknown> = {}) => ({
  partnerSlug: 'acme', orgSlug: 'contoso', email: 'jane@example.test', name: 'Jane Doe', company: 'Example Insurance',
  purpose: 'Underwriting review for renewal.', ndaAccepted: true, ...over,
});
const inserted = () => script.writes.filter((w) => w.op === 'insert');
const updated = () => script.writes.filter((w) => w.op === 'update');

beforeEach(() => {
  script.selects = []; script.writes = []; script.insertReturning = [];
  vi.clearAllMocks();
});

describe('createAccessRequest', () => {
  it('stores the NDA text from the payload (server-side), with its sha256 and the snapshot id, and mails a fragment link', async () => {
    script.selects.push([{ orgName: 'Contoso', partnerName: 'Acme MSP' }], []);   // names; no pending request to reuse
    await createAccessRequest(input() as never, resolved, payload(), NOW);
    const req = inserted()[0]!.values;
    expect(req).toMatchObject({
      trustPageId: 'page-1', orgId: 'org-1', requesterEmail: 'jane@example.test', status: 'pending_verification',
      ndaTextAccepted: NDA, ndaTextSha256: createHash('sha256').update(NDA, 'utf8').digest('hex'), ndaAcceptedAt: NOW,
      snapshotId: payload().snapshotId,
    });
    const token = inserted()[1]!.values;
    expect(token).toMatchObject({ purpose: 'verify_email', requestId: 'new-req' });
    expect((token.expiresAt as Date).getTime()).toBe(NOW.getTime() + 24 * 3600_000);
    const [lane, mail] = emails.sendAccessVerificationEmail.mock.calls[0] as unknown as [Record<string, unknown>, { verifyUrl: string }];
    expect(lane).toEqual({ to: 'jane@example.test', partnerId: 'partner-1', partnerName: 'Acme MSP' });
    expect(mail.verifyUrl).toMatch(/^https:\/\/portal\.example\.test\/portal\/trust\/access\/verify#[A-Za-z0-9_-]{48}$/);
    expect(hashAccessToken(mail.verifyUrl.split('#')[1]!)).toBe(token.tokenHash);
  });

  it('no NDA on the page → no NDA columns, even if the client ticked the box', async () => {
    script.selects.push([{ orgName: 'Contoso', partnerName: 'Acme MSP' }], []);
    await createAccessRequest(input() as never, resolved, payload({ access: { ndaText: null } }), NOW);
    expect(inserted()[0]!.values).toMatchObject({ ndaTextAccepted: null, ndaTextSha256: null, ndaAcceptedAt: null });
  });

  it('NDA on the page but not accepted → no-op (no row, no mail)', async () => {
    await createAccessRequest(input({ ndaAccepted: false }) as never, resolved, payload(), NOW);
    expect(script.writes).toHaveLength(0);
    expect(emails.sendAccessVerificationEmail).not.toHaveBeenCalled();
  });

  it('no access block (no frozen-gated document) → no-op', async () => {
    await createAccessRequest(input() as never, resolved, payload({ access: null }), NOW);
    expect(script.writes).toHaveLength(0);
  });

  it('a repeat request from the same address reuses the unconfirmed row and re-mints its link', async () => {
    script.selects.push([{ orgName: 'Contoso', partnerName: 'Acme MSP' }], [{ id: 'old-req' }]);
    await createAccessRequest(input({ purpose: 'Second attempt, more detail.' }) as never, resolved, payload(), NOW);
    expect(inserted()).toHaveLength(1);   // only the token insert
    expect(inserted()[0]!.values).toMatchObject({ requestId: 'old-req', purpose: 'verify_email' });
    expect(updated()[0]!.values).toMatchObject({ purpose: 'Second attempt, more detail.', updatedAt: NOW });
  });
});

describe('verifyAccessRequest', () => {
  const tokenRow = { id: 't1', requestId: 'req-1', orgId: 'org-1' };
  const reqRow = { id: 'req-1', trustPageId: 'page-1', orgId: 'org-1', requesterEmail: 'jane@example.test', requesterName: 'Jane', requesterCompany: 'Ex', purpose: 'Underwriting' };
  const pageCtx = { orgName: 'Contoso', partnerId: 'partner-1', createsTicket: false };

  it('consumes the token, moves the request to pending_approval and notifies MSP staff once (in-app + email)', async () => {
    script.selects.push([tokenRow], [reqRow], [pageCtx], [{ id: 'staff-1', email: 'tech@msp.test' }]);
    await expect(verifyAccessRequest(RAW, NOW)).resolves.toEqual({ orgName: 'Contoso' });
    expect(updated().map((w) => w.values)).toEqual([
      { consumedAt: NOW },
      { status: 'pending_approval', emailVerifiedAt: NOW, updatedAt: NOW },
    ]);
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'staff-1', orgId: 'org-1', type: 'approval', dedupeKey: 'trust-access:req-1', link: '/organizations/org-1#trust',
    }));
    expect(emails.sendStaffAccessRequestEmail).toHaveBeenCalledWith(['tech@msp.test'], expect.objectContaining({ orgName: 'Contoso' }));
    expect(createTicket).not.toHaveBeenCalled();
  });

  it('a second verify of the same token (consumed → no row) is null and notifies nobody', async () => {
    script.selects.push([]);
    await expect(verifyAccessRequest(RAW, NOW)).resolves.toBeNull();
    expect(script.writes).toHaveLength(0);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('a malformed token is null without touching the db', async () => {
    await expect(verifyAccessRequest('nope', NOW)).resolves.toBeNull();
    expect(script.selects).toHaveLength(0);
  });

  it('the request is no longer pending_verification → null, token left unconsumed', async () => {
    script.selects.push([tokenRow], []);
    await expect(verifyAccessRequest(RAW, NOW)).resolves.toBeNull();
    expect(script.writes).toHaveLength(0);
  });

  it('creates a ticket when the page asks for one; a ticket failure does not fail the verify', async () => {
    script.selects.push([tokenRow], [reqRow], [{ ...pageCtx, createsTicket: true }], []);
    createTicket.mockRejectedValueOnce(new Error('service management off'));
    await expect(verifyAccessRequest(RAW, NOW)).resolves.toEqual({ orgName: 'Contoso' });
    expect(createTicket).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-1', source: 'api' }), expect.objectContaining({ kind: 'system' }));
  });
});

describe('approveAccessRequest', () => {
  const pending = { id: 'req-1', trustPageId: 'page-1', orgId: 'org-1', status: 'pending_approval', requesterEmail: 'jane@example.test', emailVerifiedAt: NOW };
  const page = { publishedAt: NOW, payload: payload(), orgName: 'Contoso', partnerId: 'partner-1', partnerName: 'Acme MSP' };

  it('freezes the grant to the current snapshot\'s gated documents ∩ live gated links, 7 days, and mails a fragment link', async () => {
    const twoDocs = payload({ documents: [...payload().documents, { ...payload().documents[0]!, id: DOC2, visibility: 'public' }] });
    script.selects.push([pending], [{ ...page, payload: twoDocs }], [{ id: DOC, title: 'SOC 2 report' }]);
    const out = await approveAccessRequest({ requestId: 'req-1', orgId: 'org-1', actorUserId: 'u1', note: 'ok', now: NOW });
    expect(out.grantedDocumentIds).toEqual([DOC]);
    const grantExpiresAt = new Date(NOW.getTime() + 7 * 86_400_000);
    expect(updated()[0]!.values).toMatchObject({ status: 'approved', decidedAt: NOW, decidedByUserId: 'u1', decisionNote: 'ok', grantExpiresAt, grantedDocumentIds: [DOC] });
    const token = inserted()[0]!.values;
    expect(token).toMatchObject({ purpose: 'download', requestId: 'req-1' });
    expect(token.expiresAt).toEqual(grantExpiresAt);
    const [, mail] = emails.sendAccessGrantedEmail.mock.calls[0] as unknown as [unknown, { downloadUrl: string; documentTitles: string[] }];
    expect(mail.downloadUrl).toMatch(/\/trust\/access\/download#[A-Za-z0-9_-]{48}$/);
    expect(mail.documentTitles).toEqual(['SOC 2 report']);
  });

  it('pending_verification → 409 INVALID_STATE', async () => {
    script.selects.push([{ ...pending, status: 'pending_verification', emailVerifiedAt: null }]);
    await expect(approveAccessRequest({ requestId: 'req-1', orgId: 'org-1', actorUserId: 'u1', note: null, now: NOW }))
      .rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
  });

  it('no gated document left (live link gone) → 422 NO_GATED_DOCUMENTS, nothing written', async () => {
    script.selects.push([pending], [page], []);
    await expect(approveAccessRequest({ requestId: 'req-1', orgId: 'org-1', actorUserId: 'u1', note: null, now: NOW }))
      .rejects.toMatchObject({ status: 422, code: 'NO_GATED_DOCUMENTS' });
    expect(script.writes).toHaveLength(0);
  });

  it('an unpublished page → 422 PAGE_NOT_PUBLISHED', async () => {
    script.selects.push([pending], [{ ...page, publishedAt: null }]);
    await expect(approveAccessRequest({ requestId: 'req-1', orgId: 'org-1', actorUserId: 'u1', note: null, now: NOW }))
      .rejects.toMatchObject({ status: 422, code: 'PAGE_NOT_PUBLISHED' });
  });

  it('another org\'s request id → 404', async () => {
    script.selects.push([]);
    await expect(approveAccessRequest({ requestId: 'req-x', orgId: 'org-1', actorUserId: 'u1', note: null, now: NOW }))
      .rejects.toMatchObject({ status: 404 });
  });
});

describe('deny / revoke / resend', () => {
  const base = { id: 'req-1', trustPageId: 'page-1', orgId: 'org-1', requesterEmail: 'jane@example.test', emailVerifiedAt: NOW };
  const names = { orgName: 'Contoso', partnerId: 'partner-1', partnerName: 'Acme MSP' };

  it('deny a verified request: denied + tokens revoked + mail with the note', async () => {
    script.selects.push([{ ...base, status: 'pending_approval' }], [names]);
    await denyAccessRequest({ requestId: 'req-1', orgId: 'org-1', actorUserId: 'u1', note: 'Need an NDA', now: NOW });
    expect(updated().map((w) => w.values)).toEqual([
      expect.objectContaining({ status: 'denied', decidedAt: NOW, decidedByUserId: 'u1', decisionNote: 'Need an NDA' }),
      { revokedAt: NOW },
    ]);
    expect(emails.sendAccessDeniedEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'jane@example.test' }), expect.objectContaining({ note: 'Need an NDA' }));
  });

  it('deny an unverified request mails nobody (the address was never proven)', async () => {
    script.selects.push([{ ...base, status: 'pending_verification', emailVerifiedAt: null }], [names]);
    await denyAccessRequest({ requestId: 'req-1', orgId: 'org-1', actorUserId: 'u1', note: null, now: NOW });
    expect(emails.sendAccessDeniedEmail).not.toHaveBeenCalled();
  });

  it('deny an approved request → 409 (use revoke)', async () => {
    script.selects.push([{ ...base, status: 'approved' }]);
    await expect(denyAccessRequest({ requestId: 'req-1', orgId: 'org-1', actorUserId: 'u1', note: null, now: NOW })).rejects.toMatchObject({ status: 409 });
  });

  it('revoke an approved grant: revoked + every token revoked', async () => {
    script.selects.push([{ ...base, status: 'approved' }]);
    await revokeAccessGrant({ requestId: 'req-1', orgId: 'org-1', actorUserId: 'u1', now: NOW });
    expect(updated().map((w) => w.values)).toEqual([
      expect.objectContaining({ status: 'revoked', revokedAt: NOW, revokedByUserId: 'u1' }), { revokedAt: NOW },
    ]);
  });

  it('revoke a request that is not approved → 409', async () => {
    script.selects.push([{ ...base, status: 'pending_approval' }]);
    await expect(revokeAccessGrant({ requestId: 'req-1', orgId: 'org-1', actorUserId: 'u1', now: NOW })).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
  });

  it('resend keeps grant_expires_at and mints a token that expires with it', async () => {
    const grantExpiresAt = new Date(NOW.getTime() + 3 * 86_400_000);
    script.selects.push([{ ...base, status: 'approved', grantExpiresAt, grantedDocumentIds: [DOC] }], [names], [{ id: DOC, title: 'SOC 2 report' }]);
    await resendAccessGrant({ requestId: 'req-1', orgId: 'org-1', actorUserId: 'u1', now: NOW });
    expect(updated()[0]!.values).toEqual({ revokedAt: NOW });   // the old download token
    expect(inserted()[0]!.values).toMatchObject({ purpose: 'download', expiresAt: grantExpiresAt });
    expect(updated().some((w) => 'grantExpiresAt' in w.values)).toBe(false);
    expect(emails.sendAccessGrantedEmail).toHaveBeenCalledTimes(1);
  });

  it('resend an expired grant → 409 GRANT_EXPIRED', async () => {
    script.selects.push([{ ...base, status: 'approved', grantExpiresAt: NOW, grantedDocumentIds: [DOC] }]);
    await expect(resendAccessGrant({ requestId: 'req-1', orgId: 'org-1', actorUserId: 'u1', now: NOW })).rejects.toMatchObject({ status: 409, code: 'GRANT_EXPIRED' });
  });
});

describe('readGrant / openGrantedDocument — every condition is necessary', () => {
  const grantExpiresAt = new Date(NOW.getTime() + 86_400_000);
  const token = () => ({ id: 't1', requestId: 'req-1', orgId: 'org-1', purpose: 'download', tokenHash: hashAccessToken(RAW), expiresAt: grantExpiresAt, consumedAt: null, revokedAt: null });
  const request = () => ({ id: 'req-1', trustPageId: 'page-1', orgId: 'org-1', status: 'approved', emailVerifiedAt: NOW, grantExpiresAt, grantedDocumentIds: [DOC], requesterEmail: 'jane@example.test', downloadCount: 0 });
  const page = () => ({ orgName: 'Contoso', payload: payload() });
  const link = () => ({ id: DOC, title: 'SOC 2 report', category: 'report', contentType: 'application/pdf', byteSize: 10, storageBackend: 'db', storageKey: null, data: Buffer.from([1]), originalFilename: 'soc2.pdf' });
  type Over = { token?: unknown[]; request?: unknown[]; page?: unknown[]; links?: unknown[] };
  const queue = (o: Over = {}) => {
    script.selects.push(o.token ?? [token()], o.request ?? [request()], o.page ?? [page()], o.links ?? [link()]);
  };

  it('all conditions hold → opens, increments the count and audits with the requester as actor', async () => {
    queue();
    const opened = await openGrantedDocument(RAW, DOC, NOW);
    expect(opened).toMatchObject({ contentType: 'application/pdf', originalFilename: 'soc2.pdf' });
    expect(updated()[0]!.values).toMatchObject({ lastDownloadedAt: NOW });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'trust_page.access.download', actorEmail: 'jane@example.test', orgId: 'org-1' }));
  });
  it('readGrant lists the granted documents and the expiry', async () => {
    queue();
    await expect(readGrant(RAW, NOW)).resolves.toEqual({
      orgName: 'Contoso', expiresAt: grantExpiresAt.toISOString(),
      documents: [{ id: DOC, title: 'SOC 2 report', category: 'report', contentType: 'application/pdf', byteSize: 10 }],
    });
  });

  const cases: Array<[string, Over, string?]> = [
    ['token purpose is verify_email', { token: [{ ...token(), purpose: 'verify_email' }] }],
    ['token revoked', { token: [{ ...token(), revokedAt: NOW }] }],
    ['token expired', { token: [{ ...token(), expiresAt: NOW }] }],
    ['request not approved (revoked)', { request: [{ ...request(), status: 'revoked' }] }],
    ['email never verified', { request: [{ ...request(), emailVerifiedAt: null }] }],
    ['grant expires exactly now', { request: [{ ...request(), grantExpiresAt: NOW }] }],
    ['document not in the grant', {}, DOC2],
    ['page unpublished / not live / partner untrusted (predicate excludes it)', { page: [] }],
    ['current payload lists the document as public, not gated', { page: [{ ...page(), payload: payload({ documents: [{ ...payload().documents[0]!, visibility: 'public' }] }) }] }],
    ['no live gated link (unlinked, deleted, superseded or unconfirmed)', { links: [] }],
  ];
  for (const [name, over, docId] of cases) {
    it(`null when ${name}`, async () => {
      queue(over);
      await expect(openGrantedDocument(RAW, docId ?? DOC, NOW)).resolves.toBeNull();
      expect(updated()).toHaveLength(0);
      expect(audit).not.toHaveBeenCalled();
    });
  }
});
