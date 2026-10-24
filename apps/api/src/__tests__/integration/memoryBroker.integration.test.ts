/**
 * Wisp W03 memory broker (#9906): the agent-side path to ai_memory_blocks.
 * Real Postgres; the broker runs under the system DB context and isolates by
 * the GrantCeiling, so every case here is about what the ceiling lets through.
 * Ceilings are plain objects (no resolveGrantCeiling) and nothing in the DB
 * layer is mocked.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { aiMemoryBlocks } from '../../db/schema';
import { CeilingViolationError, GrantInactiveError, type GrantCeiling } from '../../services/wisp/grantAuthority';
import {
  MEMORY_CONTENT_MAX_BYTES,
  MemoryValidationError,
  recallForGrant,
  rememberForGrant,
  type RememberInput,
} from '../../services/wisp/memoryBroker';
import {
  SYSTEM_CTX, blockValues, cleanupMemoryBlocks, insertAiSession, insertBlock, seedMemoryFixture,
  type MemoryFixture,
} from './aiMemoryBlocksFixtures';

afterEach(cleanupMemoryBlocks);

const ceiling = (f: MemoryFixture, over: Partial<GrantCeiling> = {}): GrantCeiling => ({
  grantId: randomUUID(),
  revisionId: randomUUID(),
  partnerId: f.partnerA,
  grantorUserId: f.uA1,
  scopeOrgId: null,
  partnerWide: false,
  orgIds: new Set([f.orgA1]),
  siteIds: null,
  permissionKeys: new Set(),
  toolAllowlist: null,
  deniedTools: new Set(),
  orgTerms: new Map(),
  status: 'active',
  ...over,
});

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();

async function rowsWithSubject(subjectKey: string) {
  return withDbAccessContext(SYSTEM_CTX, () =>
    db.select().from(aiMemoryBlocks).where(eq(aiMemoryBlocks.subjectKey, subjectKey)));
}

async function rowById(id: string) {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
    db.select().from(aiMemoryBlocks).where(eq(aiMemoryBlocks.id, id)));
  return row;
}

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try { await fn(); } catch (err) { return err; }
  throw new Error('expected the call to throw');
}

const remember = (over: Partial<RememberInput> & Pick<RememberInput, 'owner'>): RememberInput => ({
  blockType: 'fact',
  subjectKey: `subject:${randomUUID()}`,
  content: { text: 'remembered' },
  confidence: 'medium',
  ...over,
});

describe('memoryBroker (system context, ceiling-filtered)', () => {
  it('recallForGrant returns the grantor’s user blocks, in-ceiling org blocks and the partner’s blocks — nothing else', async () => {
    const f = await seedMemoryFixture();
    const own = await insertBlock(f.partnerA, { kind: 'user', userId: f.uA1 });
    await insertBlock(f.partnerA, { kind: 'user', userId: f.uA2 });
    const orgIn = await insertBlock(f.partnerA, { kind: 'org', orgId: f.orgA1 });
    await insertBlock(f.partnerA, { kind: 'org', orgId: f.orgA2 });
    const partner = await insertBlock(f.partnerA, { kind: 'partner' });
    await insertBlock(f.partnerB, { kind: 'partner' });
    await insertBlock(f.partnerB, { kind: 'org', orgId: f.orgB1 });
    await insertBlock(f.partnerB, { kind: 'user', userId: f.uB1 });

    const got = await recallForGrant(ceiling(f, { partnerWide: true }), {});
    expect(ids(got)).toEqual([own.id, orgIn.id, partner.id].sort());
    expect(got.every((b) => b.tenantPartnerId === f.partnerA)).toBe(true);

    // q.orgId narrows the org branch to that one org (still inside the ceiling).
    const wide = ceiling(f, { orgIds: new Set([f.orgA1, f.orgA2]) });
    expect((await recallForGrant(wide, { owners: ['org'] })).length).toBe(2);
    expect(ids(await recallForGrant(wide, { owners: ['org'], orgId: f.orgA1 }))).toEqual([orgIn.id]);

    // An empty org set yields no org rows (and no SQL error).
    const noOrgs = ceiling(f, { partnerWide: true, orgIds: new Set() });
    expect(ids(await recallForGrant(noOrgs, {}))).toEqual([own.id, partner.id].sort());
    expect(await recallForGrant(noOrgs, { owners: ['org'] })).toEqual([]);
  });

  it('narrowed grant recalls zero partner blocks', async () => {
    // Partner memory is context for EVERY org of the partner; a grant narrowed
    // to some orgs (org-scoped, or a grantor on org_access 'selected') must not
    // read it, exactly as it may not write it.
    const f = await seedMemoryFixture();
    const own = await insertBlock(f.partnerA, { kind: 'user', userId: f.uA1 });
    const orgIn = await insertBlock(f.partnerA, { kind: 'org', orgId: f.orgA1 });
    const partner = await insertBlock(f.partnerA, { kind: 'partner' });

    const narrowed = [
      ceiling(f, { scopeOrgId: f.orgA1, partnerWide: false }), // org-scoped grant
      ceiling(f, { scopeOrgId: null, partnerWide: false }), // partner grant, grantor narrowed to 'selected'
    ];
    for (const c of narrowed) {
      expect(await recallForGrant(c, { owners: ['partner'] })).toEqual([]);
      const all = await recallForGrant(c, {});
      expect(all.filter((b) => b.owner.kind === 'partner')).toEqual([]);
      expect(ids(all)).toEqual([own.id, orgIn.id].sort());
    }

    // control: a partner-wide grant with full reach reads it
    const wide = ceiling(f, { scopeOrgId: null, partnerWide: true });
    expect(ids(await recallForGrant(wide, {}))).toEqual([own.id, orgIn.id, partner.id].sort());
  });

  it('never returns retracted or superseded blocks', async () => {
    const f = await seedMemoryFixture();
    const live = await insertBlock(f.partnerA, { kind: 'partner' });
    await insertBlock(f.partnerA, { kind: 'partner' }, { status: 'retracted' });
    await insertBlock(f.partnerA, { kind: 'user', userId: f.uA1 }, { status: 'retracted' });
    await insertBlock(f.partnerA, { kind: 'org', orgId: f.orgA1 }, { supersededById: live.id });

    expect(ids(await recallForGrant(ceiling(f, { partnerWide: true }), {}))).toEqual([live.id]);
  });

  it('throws GrantInactiveError when the ceiling is paused', async () => {
    const f = await seedMemoryFixture();
    await insertBlock(f.partnerA, { kind: 'partner' });
    const paused = ceiling(f, { status: 'paused' });

    const err = await caught(() => recallForGrant(paused, {}));
    expect(err).toBeInstanceOf(GrantInactiveError);
    expect((err as GrantInactiveError).grantId).toBe(paused.grantId);
    expect((err as GrantInactiveError).status).toBe('paused');

    const subjectKey = `paused:${randomUUID()}`;
    await expect(rememberForGrant(paused, remember({ owner: { kind: 'partner' }, subjectKey })))
      .rejects.toBeInstanceOf(GrantInactiveError);
    expect(await rowsWithSubject(subjectKey)).toEqual([]);
  });

  it('q.orgId outside the ceiling throws CeilingViolationError code org', async () => {
    const f = await seedMemoryFixture();
    await insertBlock(f.partnerA, { kind: 'org', orgId: f.orgA2 });
    for (const orgId of [f.orgA2, f.orgB1]) {
      const err = await caught(() => recallForGrant(ceiling(f), { orgId }));
      expect(err).toBeInstanceOf(CeilingViolationError);
      expect((err as CeilingViolationError).code).toBe('org');
    }
  });

  it('grantor outside the anchor partner yields zero user blocks', async () => {
    const f = await seedMemoryFixture();
    // uB1 (partner B) has blocks in partner B; a ceiling anchored on partner A
    // naming uB1 as grantor (forged, or stale after a partner move) must not
    // surface them — nor any partner-A user's blocks.
    await insertBlock(f.partnerB, { kind: 'user', userId: f.uB1 });
    await insertBlock(f.partnerA, { kind: 'user', userId: f.uA1 });
    const partnerA = await insertBlock(f.partnerA, { kind: 'partner' });
    const forged = ceiling(f, { grantorUserId: f.uB1, partnerWide: true });

    expect(await recallForGrant(forged, { owners: ['user'] })).toEqual([]);
    const all = await recallForGrant(forged, {});
    expect(all.filter((b) => b.owner.kind === 'user')).toEqual([]);
    expect(ids(all)).toEqual([partnerA.id]);

    // And it cannot write one either: the composite FK keeps a partner-B user
    // out of a partner-A anchored row, so nothing lands.
    const subjectKey = `forged:${randomUUID()}`;
    await expect(rememberForGrant(forged, remember({ owner: { kind: 'user', userId: f.uB1 }, subjectKey })))
      .rejects.toThrow();
    expect(await rowsWithSubject(subjectKey)).toEqual([]);
  });

  it('rememberForGrant writes status unconfirmed with grant + revision stamped and tenant_partner_id = ceiling.partnerId', async () => {
    const f = await seedMemoryFixture();
    const c = ceiling(f);
    const block = await rememberForGrant(c, remember({
      owner: { kind: 'org', orgId: f.orgA1 }, blockType: 'preference', subjectKey: 'ticket.notify',
      content: { channel: 'sms' }, confidence: 'high',
    }));

    expect(block).toMatchObject({
      tenantPartnerId: f.partnerA,
      owner: { kind: 'org', orgId: f.orgA1 },
      blockType: 'preference',
      subjectKey: 'ticket.notify',
      content: { channel: 'sms' },
      confidence: 'high',
      status: 'unconfirmed',
      authoredByGrantId: c.grantId,
      authoredByGrantRevisionId: c.revisionId,
      supersededById: null,
      sourceSessionId: null,
    });
    const row = await rowById(block.id);
    expect(row).toMatchObject({
      tenantPartnerId: f.partnerA, ownerKind: 'org', ownerOrgId: f.orgA1, ownerUserId: null,
      status: 'unconfirmed', authoredByGrantId: c.grantId, authoredByGrantRevisionId: c.revisionId,
    });

    // The grantor's own user block also writes.
    const mine = await rememberForGrant(c, remember({ owner: { kind: 'user', userId: f.uA1 } }));
    expect((await rowById(mine.id))).toMatchObject({ ownerKind: 'user', ownerUserId: f.uA1, tenantPartnerId: f.partnerA });
  });

  it('rememberForGrant stamps source_session_id when sourceSessionId is given and leaves it NULL when omitted; a work_summary block round-trips through recallForGrant with sourceSessionId set', async () => {
    const f = await seedMemoryFixture();
    const sessionId = await insertAiSession(f.orgA1, f.uA1);
    const c = ceiling(f);

    const omitted = await rememberForGrant(c, remember({ owner: { kind: 'org', orgId: f.orgA1 } }));
    expect((await rowById(omitted.id))!.sourceSessionId).toBeNull();

    const summary = await rememberForGrant(c, remember({
      owner: { kind: 'org', orgId: f.orgA1 }, blockType: 'work_summary', subjectKey: 'session.summary',
      content: { evidence: [{ kind: 'ticket', id: randomUUID() }] }, sourceSessionId: sessionId,
    }));
    expect(summary.sourceSessionId).toBe(sessionId);
    expect((await rowById(summary.id))!.sourceSessionId).toBe(sessionId);

    const [recalled] = await recallForGrant(c, { blockTypes: ['work_summary'] });
    expect(recalled).toMatchObject({ id: summary.id, blockType: 'work_summary', sourceSessionId: sessionId });
  });

  it('rememberForGrant refuses an org owner outside the ceiling before writing (CeilingViolationError, no row)', async () => {
    const f = await seedMemoryFixture();
    // orgA2 is live, in the anchor partner, but outside the ceiling.
    for (const orgId of [f.orgA2, f.orgB1]) {
      const subjectKey = `outside:${randomUUID()}`;
      const err = await caught(() => rememberForGrant(ceiling(f), remember({ owner: { kind: 'org', orgId }, subjectKey })));
      expect(err).toBeInstanceOf(CeilingViolationError);
      expect((err as CeilingViolationError).code).toBe('org');
      expect(await rowsWithSubject(subjectKey)).toEqual([]);
    }
  });

  it('rememberForGrant refuses a user owner who is not the grantor (CeilingViolationError code permission, no row)', async () => {
    const f = await seedMemoryFixture();
    for (const userId of [f.uA2, f.uB1]) {
      const subjectKey = `colleague:${randomUUID()}`;
      const err = await caught(() => rememberForGrant(ceiling(f), remember({ owner: { kind: 'user', userId }, subjectKey })));
      expect(err).toBeInstanceOf(CeilingViolationError);
      expect((err as CeilingViolationError).code).toBe('permission');
      expect(await rowsWithSubject(subjectKey)).toEqual([]);
    }
  });

  it('rememberForGrant needs a partner-wide grant with full reach for a partner-owned block (CeilingViolationError code org, no row)', async () => {
    const f = await seedMemoryFixture();
    const narrowed = [
      ceiling(f, { scopeOrgId: f.orgA1, partnerWide: false }), // org-scoped grant
      ceiling(f, { scopeOrgId: null, partnerWide: false }), // partner grant, grantor narrowed to 'selected'
    ];
    for (const c of narrowed) {
      const subjectKey = `partner:${randomUUID()}`;
      const err = await caught(() => rememberForGrant(c, remember({ owner: { kind: 'partner' }, subjectKey })));
      expect(err).toBeInstanceOf(CeilingViolationError);
      expect((err as CeilingViolationError).code).toBe('org');
      expect(await rowsWithSubject(subjectKey)).toEqual([]);
    }

    // control: a partner-wide grant with full reach writes it
    const wide = ceiling(f, { scopeOrgId: null, partnerWide: true });
    const ok = await rememberForGrant(wide, remember({ owner: { kind: 'partner' } }));
    expect((await rowById(ok.id))).toMatchObject({ ownerKind: 'partner', tenantPartnerId: f.partnerA, ownerOrgId: null, ownerUserId: null });
  });

  it('rememberForGrant supersedes the previous non-retracted block with the same owner, blockType and subjectKey', async () => {
    const f = await seedMemoryFixture();
    const c = ceiling(f);
    const owner = { kind: 'org', orgId: f.orgA1 } as const;
    const first = await rememberForGrant(c, remember({ owner, blockType: 'preference', subjectKey: 'ticket.notify', content: { v: 1 } }));
    // Neighbours that must NOT be superseded: other block type, other owner, other subject, a retracted twin.
    const otherType = await rememberForGrant(c, remember({ owner, blockType: 'fact', subjectKey: 'ticket.notify' }));
    const otherOwner = await rememberForGrant(c, remember({ owner: { kind: 'user', userId: f.uA1 }, blockType: 'preference', subjectKey: 'ticket.notify' }));
    const otherSubject = await rememberForGrant(c, remember({ owner, blockType: 'preference', subjectKey: 'ticket.notify2' }));
    const retractedTwin = await insertBlock(f.partnerA, owner, { blockType: 'preference', subjectKey: 'ticket.notify', status: 'retracted' });

    const second = await rememberForGrant(c, remember({ owner, blockType: 'preference', subjectKey: 'ticket.notify', content: { v: 2 } }));

    expect((await rowById(first.id))!.supersededById).toBe(second.id);
    expect((await rowById(second.id))!.supersededById).toBeNull();
    for (const untouched of [otherType, otherOwner, otherSubject, retractedTwin]) {
      expect((await rowById(untouched.id))!.supersededById).toBeNull();
    }

    const recalled = await recallForGrant(c, { blockTypes: ['preference'], subjectKeyPrefix: 'ticket.notify' });
    expect(ids(recalled)).toEqual([second.id, otherOwner.id, otherSubject.id].sort());
    expect(recalled.find((b) => b.subjectKey === 'ticket.notify' && b.owner.kind === 'org')!.content).toEqual({ v: 2 });

    // A third write supersedes the second, not the already-superseded first.
    const third = await rememberForGrant(c, remember({ owner, blockType: 'preference', subjectKey: 'ticket.notify', content: { v: 3 } }));
    expect((await rowById(second.id))!.supersededById).toBe(third.id);
    expect((await rowById(first.id))!.supersededById).toBe(second.id);
  });

  it('an agent write never supersedes a human-confirmed block: both stay live and the confirmed one recalls first', async () => {
    const f = await seedMemoryFixture();
    const c = ceiling(f);
    const owner = { kind: 'user', userId: f.uA1 } as const;
    const human = await insertBlock(f.partnerA, owner, { blockType: 'preference', subjectKey: 'ticket.notify', status: 'confirmed', content: { channel: 'sms' } });
    const proposal = await rememberForGrant(c, remember({ owner, blockType: 'preference', subjectKey: 'ticket.notify', content: { channel: 'email' } }));

    expect((await rowById(human.id))!.supersededById).toBeNull();
    expect((await rowById(human.id))!.status).toBe('confirmed');
    const recalled = await recallForGrant(c, { subjectKeyPrefix: 'ticket.notify' });
    expect(recalled.map((b) => b.id)).toEqual([human.id, proposal.id]);

    // A second agent write replaces the earlier unconfirmed proposal only.
    const proposal2 = await rememberForGrant(c, remember({ owner, blockType: 'preference', subjectKey: 'ticket.notify', content: { channel: 'push' } }));
    expect((await rowById(proposal.id))!.supersededById).toBe(proposal2.id);
    expect((await rowById(human.id))!.supersededById).toBeNull();
  });

  it('rememberForGrant rejects content over MEMORY_CONTENT_MAX_BYTES and a subjectKey over 280 chars', async () => {
    const f = await seedMemoryFixture();
    const c = ceiling(f);
    const owner = { kind: 'org', orgId: f.orgA1 } as const;
    const tooBig = { blob: 'x'.repeat(MEMORY_CONTENT_MAX_BYTES) };
    const bad: RememberInput[] = [
      remember({ owner, subjectKey: 'big', content: tooBig }),
      remember({ owner, subjectKey: 'k'.repeat(281) }),
      remember({ owner, subjectKey: '' }),
      remember({ owner, subjectKey: '   ' }),
      remember({ owner, subjectKey: 'nul\u0000key' }),
      remember({ owner, subjectKey: 'nulcontent', content: { note: 'a\u0000b' } }),
      remember({ owner, subjectKey: 'arr', content: ['not', 'an', 'object'] as unknown as Record<string, unknown> }),
      remember({ owner, subjectKey: 'null', content: null as unknown as Record<string, unknown> }),
      remember({ owner, subjectKey: 'type', blockType: 'rumor' as never }),
      remember({ owner, subjectKey: 'conf', confidence: 'certain' as never }),
    ];
    for (const input of bad) {
      const err = await caught(() => rememberForGrant(c, input));
      expect(err).toBeInstanceOf(MemoryValidationError);
      expect((err as MemoryValidationError).code).toBe('invalid_memory');
    }
    expect(await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(aiMemoryBlocks).where(eq(aiMemoryBlocks.tenantPartnerId, f.partnerA)))).toEqual([]);

    // Boundaries: exactly 280 chars and exactly MEMORY_CONTENT_MAX_BYTES are accepted.
    const atLimit = { b: 'y'.repeat(MEMORY_CONTENT_MAX_BYTES - JSON.stringify({ b: '' }).length) };
    expect(JSON.stringify(atLimit).length).toBe(MEMORY_CONTENT_MAX_BYTES);
    await expect(rememberForGrant(c, remember({ owner, subjectKey: 'k'.repeat(280), content: atLimit }))).resolves.toMatchObject({ status: 'unconfirmed' });
  });

  it('honours limit (default 50, max 200) and subjectKeyPrefix / blockTypes / owners filters', async () => {
    const f = await seedMemoryFixture();
    const c = ceiling(f, { partnerWide: true });
    // 205 partner blocks in one insert, staggered updated_at.
    const base = Date.UTC(2026, 0, 1);
    const bulk = Array.from({ length: 205 }, (_, i) => blockValues(f.partnerA, { kind: 'partner' }, {
      subjectKey: `bulk.${String(i).padStart(3, '0')}`, updatedAt: new Date(base + i * 1000),
    }));
    const inserted = await withDbAccessContext(SYSTEM_CTX, () => db.insert(aiMemoryBlocks).values(bulk).returning({ id: aiMemoryBlocks.id }));

    try {
      expect((await recallForGrant(c, {})).length).toBe(50);
      expect((await recallForGrant(c, { limit: 500 })).length).toBe(200);
      expect((await recallForGrant(c, { limit: 0 })).length).toBe(1);
      expect((await recallForGrant(c, { limit: -5 })).length).toBe(1);
      expect((await recallForGrant(c, { limit: 7 })).length).toBe(7);
      // updated_at desc
      expect((await recallForGrant(c, { limit: 2 })).map((b) => b.subjectKey)).toEqual(['bulk.204', 'bulk.203']);
    } finally {
      await withDbAccessContext(SYSTEM_CTX, () => db.delete(aiMemoryBlocks).where(inArray(aiMemoryBlocks.id, inserted.map((r) => r.id))));
    }

    // Prefix filter escapes LIKE metacharacters: 'ticket_' matches only a literal underscore.
    const under = await insertBlock(f.partnerA, { kind: 'partner' }, { subjectKey: 'ticket_b' });
    await insertBlock(f.partnerA, { kind: 'partner' }, { subjectKey: 'ticketXb' });
    const pct = await insertBlock(f.partnerA, { kind: 'partner' }, { subjectKey: '50%off' });
    await insertBlock(f.partnerA, { kind: 'partner' }, { subjectKey: '50 off' });
    const slash = await insertBlock(f.partnerA, { kind: 'partner' }, { subjectKey: 'a\\b' });
    await insertBlock(f.partnerA, { kind: 'partner' }, { subjectKey: 'ab' });
    expect(ids(await recallForGrant(c, { subjectKeyPrefix: 'ticket_' }))).toEqual([under.id]);
    expect(ids(await recallForGrant(c, { subjectKeyPrefix: '50%' }))).toEqual([pct.id]);
    expect(ids(await recallForGrant(c, { subjectKeyPrefix: 'a\\' }))).toEqual([slash.id]);

    // blockTypes and owners
    const decision = await insertBlock(f.partnerA, { kind: 'org', orgId: f.orgA1 }, { blockType: 'decision' });
    const userFact = await insertBlock(f.partnerA, { kind: 'user', userId: f.uA1 }, { blockType: 'fact' });
    expect(ids(await recallForGrant(c, { blockTypes: ['decision'] }))).toEqual([decision.id]);
    expect(ids(await recallForGrant(c, { owners: ['user'] }))).toEqual([userFact.id]);
    expect(ids(await recallForGrant(c, { owners: ['user', 'org'] }))).toEqual([decision.id, userFact.id].sort());
    expect(await recallForGrant(c, { owners: [] })).toEqual([]);
    expect(await recallForGrant(c, { blockTypes: [] })).toEqual([]);

    // Ordering: confirmed first, then updated_at desc.
    const older = await insertBlock(f.partnerA, { kind: 'partner' }, { subjectKey: 'ord.confirmed', status: 'confirmed', updatedAt: new Date(base) });
    const newer = await insertBlock(f.partnerA, { kind: 'partner' }, { subjectKey: 'ord.unconfirmed', updatedAt: new Date(base + 10_000_000_000) });
    expect((await recallForGrant(c, { subjectKeyPrefix: 'ord.' })).map((b) => b.id)).toEqual([older.id, newer.id]);
  });
});
