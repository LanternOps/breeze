/**
 * #10428 W06 Task 2: the standing-instruction matcher against real Postgres.
 * Which blocks a grant's enforcement lookup sees: the grantor's own user
 * blocks, org blocks of the target devices' orgs, and partner blocks only for
 * a partner-wide ceiling — never retracted, superseded or another user's.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import type { GrantCeiling } from '../../services/wisp/grantAuthority';
import { findStandingInstructionMatches, standingInstructionDecision } from '../../services/wisp/memoryBroker';
import { SYSTEM_CTX, cleanupMemoryBlocks, insertBlock, seedMemoryFixture, type MemoryFixture, type MemoryOwnerSpec } from './aiMemoryBlocksFixtures';

afterEach(cleanupMemoryBlocks);

const PC01 = randomUUID();
const PC02 = randomUUID();

const ceiling = (f: MemoryFixture, over: Partial<GrantCeiling> = {}): GrantCeiling => ({
  grantId: randomUUID(),
  revisionId: randomUUID(),
  partnerId: f.partnerA,
  grantorUserId: f.uA1,
  scopeOrgId: null,
  partnerWide: false,
  orgIds: new Set([f.orgA1, f.orgA2]),
  siteIds: null,
  permissionKeys: new Set(),
  toolAllowlist: null,
  deniedTools: new Set(),
  orgTerms: new Map(),
  status: 'active',
  ...over,
});

function standing(f: MemoryFixture, owner: MemoryOwnerSpec, over: { deviceId?: string; status?: 'confirmed' | 'unconfirmed' | 'retracted'; supersededById?: string; until?: string | null; condition?: string | null; partner?: string } = {}) {
  const deviceId = over.deviceId ?? PC01;
  return insertBlock(over.partner ?? f.partnerA, owner, {
    blockType: 'standing_instruction',
    subjectKey: `device:${deviceId}:reboot:${randomUUID().slice(0, 16)}`,
    status: over.status ?? 'confirmed',
    ...(over.supersededById ? { supersededById: over.supersededById } : {}),
    content: {
      instructionId: randomUUID(), effect: 'deny', verb: 'reboot', deviceId,
      condition: over.condition ?? null, until: over.until ?? null,
      text: "don't reboot PC-01", targetLabels: ['PC-01'], sourceMessageId: null, captureId: null,
    },
  });
}

const lookup = (_f: MemoryFixture, c: GrantCeiling, deviceId = PC01) =>
  findStandingInstructionMatches({ ceiling: c, deviceIds: [deviceId], exact: ['reboot', 'any_change'], possible: [] });

describe('findStandingInstructionMatches (real Postgres)', () => {
  it('sees the grantor’s own confirmed block and refuses on it; another device is unaffected', async () => {
    const f = await seedMemoryFixture();
    const own = await standing(f, { kind: 'user', userId: f.uA1 });
    const matches = await lookup(f, ceiling(f));
    expect(matches.map((m) => m.blockId)).toEqual([own.id]);
    expect(standingInstructionDecision(matches).action).toBe('refuse');
    expect(await lookup(f, ceiling(f), PC02)).toEqual([]);
  });

  it('ignores another user’s block', async () => {
    const f = await seedMemoryFixture();
    await standing(f, { kind: 'user', userId: f.uA2 });
    expect(await lookup(f, ceiling(f))).toEqual([]);
  });

  it('sees an org block of an org inside the ceiling, ignores one for an org outside it', async () => {
    const f = await seedMemoryFixture();
    const orgBlock = await standing(f, { kind: 'org', orgId: f.orgA1 });
    await standing(f, { kind: 'org', orgId: f.orgA2 });
    const narrowed = ceiling(f, { orgIds: new Set([f.orgA1]) });
    expect((await lookup(f, narrowed)).map((m) => m.blockId)).toEqual([orgBlock.id]);
    expect(await lookup(f, ceiling(f, { orgIds: new Set() }))).toEqual([]);
  });

  it('ignores retracted, superseded and expired blocks', async () => {
    const f = await seedMemoryFixture();
    const live = await standing(f, { kind: 'user', userId: f.uA1 }, { status: 'unconfirmed' });
    await standing(f, { kind: 'user', userId: f.uA1 }, { status: 'retracted' });
    await standing(f, { kind: 'user', userId: f.uA1 }, { supersededById: live.id });
    await standing(f, { kind: 'user', userId: f.uA1 }, { until: '2020-01-01T00:00:00Z' });
    expect((await lookup(f, ceiling(f))).map((m) => m.blockId)).toEqual([live.id]);
  });

  it('a partner block counts only under a partner-wide ceiling', async () => {
    const f = await seedMemoryFixture();
    const partner = await standing(f, { kind: 'partner' });
    expect(await lookup(f, ceiling(f, { partnerWide: false }))).toEqual([]);
    expect(await lookup(f, ceiling(f, { partnerWide: true, scopeOrgId: f.orgA1 }))).toEqual([]);
    expect((await lookup(f, ceiling(f, { partnerWide: true }))).map((m) => m.blockId)).toEqual([partner.id]);
  });

  it('never crosses partners', async () => {
    const f = await seedMemoryFixture();
    await standing(f, { kind: 'partner' }, { partner: f.partnerB });
    await standing(f, { kind: 'org', orgId: f.orgB1 }, { partner: f.partnerB });
    expect(await lookup(f, ceiling(f, { partnerWide: true, orgIds: new Set([f.orgA1, f.orgA2, f.orgB1]) }))).toEqual([]);
  });

  it('unconfirmed and conditional blocks warn, never refuse', async () => {
    const f = await seedMemoryFixture();
    await standing(f, { kind: 'user', userId: f.uA1 }, { status: 'unconfirmed' });
    await standing(f, { kind: 'user', userId: f.uA1 }, { condition: 'during business hours' });
    const matches = await lookup(f, ceiling(f));
    expect(matches).toHaveLength(2);
    expect(standingInstructionDecision(matches).action).toBe('warn');
  });

  it('the device lookup can use ai_memory_blocks_standing_device_idx', async () => {
    const f = await seedMemoryFixture();
    await standing(f, { kind: 'user', userId: f.uA1 });
    const plan = await withDbAccessContext(SYSTEM_CTX, async () => {
      await db.execute(sql`SET LOCAL enable_seqscan = off`);
      return db.execute(sql`EXPLAIN SELECT id FROM ai_memory_blocks
        WHERE tenant_partner_id = ${f.partnerA} AND block_type = 'standing_instruction'
          AND (content->>'deviceId') IN (${PC01}, ${PC02})
          AND status <> 'retracted' AND superseded_by_id IS NULL`);
    });
    const text = (plan as unknown as Array<Record<string, string>>).map((r) => Object.values(r)[0]).join('\n');
    console.log(`[standingMatch EXPLAIN]\n${text}`);
    expect(text).toContain('ai_memory_blocks_standing_device_idx');
  });
});
