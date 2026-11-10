/**
 * #10428 (W05 Task 5) — the chip's group operations on captured standing
 * instructions, under real RLS: a person keeps, shares or forgets ONE
 * instruction (every block sharing its instructionId), only ever their own.
 * The blocks are written by the broker, as the turn-end extractor writes them.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { StandingInstructionContent } from '@breeze/shared';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { aiMemoryBlocks } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import type { GrantCeiling } from '../../services/wisp/grantAuthority';
import { rememberInstructionGroupForGrant } from '../../services/wisp/memoryBroker';
import { MemoryServiceError } from '../../services/wisp/memoryService';
import {
  confirmInstructionGroup,
  listCapturedInstructions,
  promoteInstructionGroupToOrg,
  retractInstructionGroup,
} from '../../services/wisp/instructionCaptures';
import { standingInstructionSubjectKey } from '../../services/wisp/standingInstructions';
import {
  SYSTEM_CTX, cleanupMemoryBlocks, insertAiSession, partnerContext, seedMemoryFixture, type MemoryFixture,
} from './aiMemoryBlocksFixtures';
import { createDevice, createSite } from './db-utils';

afterEach(cleanupMemoryBlocks);

type Session = { auth: AuthContext; ctx: DbAccessContext };

function partnerSession(userId: string, partnerId: string, orgIds: string[]): Session {
  return {
    auth: {
      principal: { kind: 'user_session' },
      user: { id: userId, email: `${userId}@example.com`, name: 'Tech', isPlatformAdmin: false },
      token: null, partnerId, orgId: null, scope: 'partner', accessibleOrgIds: orgIds, partnerOrgAccess: 'all',
      orgCondition: () => undefined, canAccessOrg: (id: string) => orgIds.includes(id),
    } as AuthContext,
    ctx: { ...partnerContext(partnerId, orgIds), userId },
  };
}

const as = <T>(s: Session, fn: (auth: AuthContext) => Promise<T>) => withDbAccessContext(s.ctx, () => fn(s.auth));

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; } catch (err) {
    expect(err).toBeInstanceOf(MemoryServiceError);
    return (err as MemoryServiceError).code;
  }
  return undefined;
}

const ceiling = (f: MemoryFixture, grantorUserId: string): GrantCeiling => ({
  grantId: randomUUID(), revisionId: randomUUID(), partnerId: f.partnerA, grantorUserId, scopeOrgId: null,
  partnerWide: true, orgIds: new Set([f.orgA1, f.orgA2]), siteIds: null, permissionKeys: new Set(),
  toolAllowlist: null, deniedTools: new Set(), orgTerms: new Map(), status: 'active',
});

async function device(orgId: string, hostname: string): Promise<string> {
  const site = await withDbAccessContext(SYSTEM_CTX, () => createSite({ orgId }));
  const created = await withDbAccessContext(SYSTEM_CTX, () => createDevice({ orgId, siteId: site.id, hostname }));
  return created.id;
}

/** Write one captured instruction the way the extractor does: one block per device, one shared instructionId. */
async function capture(
  f: MemoryFixture,
  userId: string,
  sessionId: string,
  deviceIds: Array<string | null>,
  over: Partial<StandingInstructionContent> = {},
): Promise<{ instructionId: string; captureId: string }> {
  const instructionId = randomUUID();
  const captureId = randomUUID();
  const blocks = deviceIds.map((deviceId) => {
    const content: StandingInstructionContent = {
      instructionId, effect: 'deny', verb: 'reboot', deviceId, condition: null, until: null,
      text: "don't reboot these", targetLabels: ['PC-01', 'PC-02'], sourceMessageId: null, captureId, ...over,
    };
    return {
      owner: { kind: 'user' as const, userId },
      blockType: 'standing_instruction' as const,
      subjectKey: standingInstructionSubjectKey(content),
      content,
      confidence: 'medium' as const,
      sourceSessionId: sessionId,
    };
  });
  await rememberInstructionGroupForGrant(ceiling(f, userId), blocks);
  return { instructionId, captureId };
}

async function blocksOf(instructionId: string) {
  return withDbAccessContext(SYSTEM_CTX, () => db.select().from(aiMemoryBlocks)
    .where(eq(aiMemoryBlocks.blockType, 'standing_instruction')))
    .then((rows) => rows.filter((r) => (r.content as { instructionId?: string }).instructionId === instructionId));
}

describe('captured standing instructions: group operations (#10428)', () => {
  it('keep confirms every block of the group and no other group\'s block', async () => {
    const f = await seedMemoryFixture();
    const session = await insertAiSession(f.orgA1, f.uA1);
    const [d1, d2, d3] = [await device(f.orgA1, 'PC-01'), await device(f.orgA1, 'PC-02'), await device(f.orgA1, 'PC-03')];
    const one = await capture(f, f.uA1, session, [d1, d2]);
    const other = await capture(f, f.uA1, session, [d3], { text: 'never shut down PC-03', verb: 'shutdown' });
    const me = partnerSession(f.uA1, f.partnerA, [f.orgA1, f.orgA2]);

    const [dto] = await as(me, (auth) => confirmInstructionGroup(auth, one.instructionId));
    expect(dto).toMatchObject({
      instructionId: one.instructionId, status: 'confirmed', enforceable: true, verb: 'reboot',
      orgId: f.orgA1, unmatched: false, keptForOrg: false,
    });
    expect((await blocksOf(one.instructionId)).map((b) => b.status)).toEqual(['confirmed', 'confirmed']);
    expect((await blocksOf(other.instructionId)).map((b) => b.status)).toEqual(['unconfirmed']);
  });

  it('Review Focus 2: confirming one clause on a device and verb never supersedes a different clause on the same pair', async () => {
    const f = await seedMemoryFixture();
    const session = await insertAiSession(f.orgA1, f.uA1);
    const d1 = await device(f.orgA1, 'PC-01');
    const hours = await capture(f, f.uA1, session, [d1], { condition: 'during business hours', text: 'never reboot PC-01 during business hours' });
    const friday = await capture(f, f.uA1, session, [d1], { until: '2027-02-05T17:00:00+00:00', text: "don't reboot PC-01 until Friday" });
    const me = partnerSession(f.uA1, f.partnerA, [f.orgA1, f.orgA2]);

    await as(me, (auth) => confirmInstructionGroup(auth, hours.instructionId));
    const [hoursRow] = await blocksOf(hours.instructionId);
    const [fridayRow] = await blocksOf(friday.instructionId);
    expect(hoursRow).toMatchObject({ status: 'confirmed', supersededById: null });
    expect(fridayRow).toMatchObject({ status: 'unconfirmed', supersededById: null });

    // And the other way round: confirming the second leaves the first confirmed and live.
    await as(me, (auth) => confirmInstructionGroup(auth, friday.instructionId));
    expect((await blocksOf(hours.instructionId))[0]).toMatchObject({ status: 'confirmed', supersededById: null });
    expect((await blocksOf(friday.instructionId))[0]).toMatchObject({ status: 'confirmed', supersededById: null });
  });

  it('confirming a restated clause replaces the older confirmed copy, and the older group is then gone', async () => {
    const f = await seedMemoryFixture();
    const session = await insertAiSession(f.orgA1, f.uA1);
    const d1 = await device(f.orgA1, 'PC-01');
    const first = await capture(f, f.uA1, session, [d1]);
    const me = partnerSession(f.uA1, f.partnerA, [f.orgA1, f.orgA2]);
    await as(me, (auth) => confirmInstructionGroup(auth, first.instructionId));
    const again = await capture(f, f.uA1, session, [d1]);
    await as(me, (auth) => confirmInstructionGroup(auth, again.instructionId));

    const [old] = await blocksOf(first.instructionId);
    const [fresh] = await blocksOf(again.instructionId);
    expect(old!.supersededById).toBe(fresh!.id);
    expect(fresh).toMatchObject({ status: 'confirmed', supersededById: null });
    expect((await as(me, (auth) => listCapturedInstructions(auth, session))).map((d) => d.instructionId))
      .toEqual([again.instructionId]);
    // A group whose blocks were all replaced cannot be acted on any more.
    expect(await code(as(me, (auth) => retractInstructionGroup(auth, first.instructionId)))).toBe('not_found');
    expect((await blocksOf(first.instructionId))[0]).toMatchObject({ status: 'confirmed', supersededById: fresh!.id });
  });

  it("another user's instructionId is not found on every operation", async () => {
    const f = await seedMemoryFixture();
    const session = await insertAiSession(f.orgA1, f.uA1);
    const d1 = await device(f.orgA1, 'PC-01');
    const mine = await capture(f, f.uA1, session, [d1]);
    const colleague = partnerSession(f.uA2, f.partnerA, [f.orgA1, f.orgA2]);

    expect(await code(as(colleague, (auth) => confirmInstructionGroup(auth, mine.instructionId)))).toBe('not_found');
    expect(await code(as(colleague, (auth) => retractInstructionGroup(auth, mine.instructionId)))).toBe('not_found');
    expect(await code(as(colleague, (auth) => promoteInstructionGroupToOrg(auth, mine.instructionId)))).toBe('not_found');
    expect(await as(colleague, (auth) => listCapturedInstructions(auth, session))).toEqual([]);
    expect((await blocksOf(mine.instructionId)).map((b) => b.status)).toEqual(['unconfirmed']);
  });

  it('keep for everyone across two orgs is refused cross_org, and writes nothing', async () => {
    const f = await seedMemoryFixture();
    const session = await insertAiSession(f.orgA1, f.uA1);
    const group = await capture(f, f.uA1, session, [await device(f.orgA1, 'PC-01'), await device(f.orgA2, 'PC-02')]);
    const me = partnerSession(f.uA1, f.partnerA, [f.orgA1, f.orgA2]);

    const [listed] = await as(me, (auth) => listCapturedInstructions(auth, session));
    expect(listed).toMatchObject({ orgId: null, orgName: null });
    expect(await code(as(me, (auth) => promoteInstructionGroupToOrg(auth, group.instructionId)))).toBe('cross_org');
    const rows = await blocksOf(group.instructionId);
    expect(rows.every((r) => r.ownerKind === 'user' && r.supersededById === null)).toBe(true);
  });

  it('a free-text note (no resolved device) cannot be shared with an org', async () => {
    const f = await seedMemoryFixture();
    const session = await insertAiSession(f.orgA1, f.uA1);
    const note = await capture(f, f.uA1, session, [null]);
    const me = partnerSession(f.uA1, f.partnerA, [f.orgA1, f.orgA2]);
    const [listed] = await as(me, (auth) => listCapturedInstructions(auth, session));
    expect(listed).toMatchObject({ unmatched: true, enforceable: false, orgId: null });
    expect(await code(as(me, (auth) => promoteInstructionGroupToOrg(auth, note.instructionId)))).toBe('cross_org');
  });

  it('keep for everyone writes confirmed org blocks and points the user blocks at them; a reload shows it kept', async () => {
    const f = await seedMemoryFixture();
    const session = await insertAiSession(f.orgA1, f.uA1);
    const group = await capture(f, f.uA1, session, [await device(f.orgA1, 'PC-01'), await device(f.orgA1, 'PC-02')]);
    const me = partnerSession(f.uA1, f.partnerA, [f.orgA1, f.orgA2]);

    const [dto] = await as(me, (auth) => promoteInstructionGroupToOrg(auth, group.instructionId));
    expect(dto).toMatchObject({ status: 'confirmed', keptForOrg: true, orgId: f.orgA1 });

    const rows = await blocksOf(group.instructionId);
    const orgRows = rows.filter((r) => r.ownerKind === 'org');
    const userRows = rows.filter((r) => r.ownerKind === 'user');
    expect(orgRows).toHaveLength(2);
    expect(orgRows.every((r) => r.ownerOrgId === f.orgA1 && r.status === 'confirmed' && r.supersededById === null)).toBe(true);
    expect(new Set(userRows.map((r) => r.supersededById))).toEqual(new Set(orgRows.map((r) => r.id)));

    const reloaded = await as(me, (auth) => listCapturedInstructions(auth, session));
    expect(reloaded).toEqual([expect.objectContaining({ instructionId: group.instructionId, keptForOrg: true, status: 'confirmed' })]);
  });

  it('forget retracts the whole group; a reload shows it forgotten', async () => {
    const f = await seedMemoryFixture();
    const session = await insertAiSession(f.orgA1, f.uA1);
    const group = await capture(f, f.uA1, session, [await device(f.orgA1, 'PC-01'), await device(f.orgA1, 'PC-02')]);
    const me = partnerSession(f.uA1, f.partnerA, [f.orgA1, f.orgA2]);

    const [dto] = await as(me, (auth) => retractInstructionGroup(auth, group.instructionId));
    expect(dto).toMatchObject({ status: 'retracted' });
    expect((await blocksOf(group.instructionId)).map((b) => b.status)).toEqual(['retracted', 'retracted']);
    expect(await as(me, (auth) => listCapturedInstructions(auth, session)))
      .toEqual([expect.objectContaining({ status: 'retracted' })]);
  });

  it('keep for everyone on a forgotten instruction is refused retracted, not cross_org', async () => {
    const f = await seedMemoryFixture();
    const session = await insertAiSession(f.orgA1, f.uA1);
    const group = await capture(f, f.uA1, session, [await device(f.orgA1, 'PC-01')]);
    const me = partnerSession(f.uA1, f.partnerA, [f.orgA1, f.orgA2]);
    await as(me, (auth) => retractInstructionGroup(auth, group.instructionId));
    expect(await code(as(me, (auth) => promoteInstructionGroupToOrg(auth, group.instructionId)))).toBe('retracted');
  });

  it('lists only this session\'s captures, never model-authored remember blocks', async () => {
    const f = await seedMemoryFixture();
    const session = await insertAiSession(f.orgA1, f.uA1);
    const elsewhere = await insertAiSession(f.orgA1, f.uA1);
    const d1 = await device(f.orgA1, 'PC-01');
    const here = await capture(f, f.uA1, session, [d1]);
    await capture(f, f.uA1, elsewhere, [d1], { text: 'other session' });
    // A `remember` the model made itself carries no captureId.
    await rememberInstructionGroupForGrant(ceiling(f, f.uA1), [{
      owner: { kind: 'user', userId: f.uA1 }, blockType: 'standing_instruction', subjectKey: `manual:${randomUUID()}`,
      content: { text: 'model remembered this' }, confidence: 'medium', sourceSessionId: session,
    }]);
    const me = partnerSession(f.uA1, f.partnerA, [f.orgA1, f.orgA2]);
    const listed = await as(me, (auth) => listCapturedInstructions(auth, session));
    expect(listed.map((d) => d.instructionId)).toEqual([here.instructionId]);
    expect(listed[0]).toMatchObject({ targetLabels: ['PC-01', 'PC-02'], until: null });
  });
});
