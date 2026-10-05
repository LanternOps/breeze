/**
 * W05 (#7603, D8): ai_sessions.continued_from_session_id is a same-org link,
 * enforced by a composite self-FK (quorum #1), and safe under every path that
 * moves or deletes ai_sessions rows: org erasure (one DELETE … WHERE org_id),
 * device move (the cascade trigger's one UPDATE … WHERE device_id), org merge
 * (SET CONSTRAINTS ALL DEFERRED, separate statements) and source deletion
 * (ON DELETE SET NULL on the link column only).
 *
 * Forgery runs through the breeze_app pool (`db`, FORCE RLS applies); seeds
 * go through the superuser fixture client.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  insertContinuationSession, loadContinuationSummary,
} from '../../services/aiModels/continuation';
import type { SessionModelChoice } from '../../services/aiModels/sessionModel';
import { closeRegistryFixtures, fixtureSql, orgContext } from './aiModelRegistryFixtures';
import { seedRegistryPartner } from './helpers/aiModelRegistrySeed';
import { createOrganization, createSite } from './db-utils';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

async function continuation(orgId: string, userId: string, fromId: string | null, deviceId: string | null = null) {
  const [row] = await fixtureSql`
    INSERT INTO ai_sessions (org_id, user_id, type, model, continued_from_session_id, device_id)
    VALUES (${orgId}, ${userId}, 'general', 'w05-test', ${fromId}, ${deviceId}) RETURNING id`;
  return String(row!.id);
}

async function seedDevice(orgId: string): Promise<{ deviceId: string; siteId: string }> {
  const site = await createSite({ orgId });
  const [device] = await fixtureSql`
    INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version, status)
    VALUES (${orgId}, ${site!.id}, ${`w05-cont-${randomUUID()}`}, 'w05-cont-host', 'linux', '22.04', 'x86_64', '0.0.0-test', 'offline')
    RETURNING id`;
  return { deviceId: String(device!.id), siteId: String(site!.id) };
}

function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.cause?.code ?? e?.code;
}

describe.skipIf(!RUN)('ai_sessions.continued_from_session_id (W05)', () => {
  it('links two sessions of the same org', async () => {
    const s = await seedRegistryPartner('platform');
    const id = await continuation(s.orgId, s.userId, s.chatSessionId);
    expect((await fixtureSql`SELECT continued_from_session_id FROM ai_sessions WHERE id = ${id}`)[0]!.continued_from_session_id).toBe(s.chatSessionId);
  });

  it('a forged cross-org continued_from_session_id fails 23503 as breeze_app', async () => {
    const s = await seedRegistryPartner('platform');
    const other = await createOrganization({ partnerId: s.partnerId });
    // The breeze_app pool, in the OTHER org's context (W02 forgery-suite pattern):
    // RLS admits the row (it is the caller's own org); only the FK refuses it.
    const err = await withDbAccessContext(orgContext(other.id, s.partnerId), () => db.execute(sql`
      INSERT INTO ai_sessions (org_id, user_id, type, model, continued_from_session_id)
      VALUES (${other.id}::uuid, ${s.userId}::uuid, 'general', 'w05-test', ${s.chatSessionId}::uuid)`))
      .catch((e: unknown) => e);
    expect(pgCode(err)).toBe('23503');
    const [{ n }] = await fixtureSql`SELECT count(*)::int AS n FROM ai_sessions WHERE org_id = ${other.id}` as unknown as [{ n: number }];
    expect(n).toBe(0);
  });

  it('re-pointing an existing session at another org\'s session fails 23503 as breeze_app', async () => {
    const s = await seedRegistryPartner('platform');
    const other = await createOrganization({ partnerId: s.partnerId });
    const mine = await continuation(other.id, s.userId, null);
    const err = await withDbAccessContext(orgContext(other.id, s.partnerId), () => db.execute(sql`
      UPDATE ai_sessions SET continued_from_session_id = ${s.chatSessionId}::uuid WHERE id = ${mine}::uuid`))
      .catch((e: unknown) => e);
    expect(pgCode(err)).toBe('23503');
  });

  it('a session cannot continue itself', async () => {
    const s = await seedRegistryPartner('platform');
    await expect(fixtureSql`UPDATE ai_sessions SET continued_from_session_id = id WHERE id = ${s.chatSessionId}`)
      .rejects.toMatchObject({ code: '23514' });
  });

  it('deleting the source nulls the link, never the continuation (and leaves its org_id alone)', async () => {
    const s = await seedRegistryPartner('platform');
    const id = await continuation(s.orgId, s.userId, s.chatSessionId);
    await fixtureSql`DELETE FROM ai_budget_reservations WHERE session_id = ${s.chatSessionId}`;
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM ai_sessions WHERE id = ${s.chatSessionId}::uuid`));
    const [row] = await fixtureSql`SELECT org_id, continued_from_session_id FROM ai_sessions WHERE id = ${id}`;
    expect(row!.continued_from_session_id).toBeNull();
    expect(String(row!.org_id)).toBe(s.orgId);
  });

  it('org erasure\'s single DELETE … WHERE org_id removes a continuation chain without an FK error', async () => {
    const s = await seedRegistryPartner('platform');
    const b = await continuation(s.orgId, s.userId, s.chatSessionId);
    await continuation(s.orgId, s.userId, b);
    await fixtureSql`DELETE FROM ai_budget_reservations WHERE org_id = ${s.orgId}`;
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM ai_sessions WHERE org_id = ${s.orgId}::uuid`));
    const [{ n }] = await fixtureSql`SELECT count(*)::int AS n FROM ai_sessions WHERE org_id = ${s.orgId}` as unknown as [{ n: number }];
    expect(n).toBe(0);
  });

  it('device move re-stamps a continuation pair without 23503 (the real cascade trigger)', async () => {
    const s = await seedRegistryPartner('platform');
    const { deviceId } = await seedDevice(s.orgId);
    await fixtureSql`UPDATE ai_sessions SET device_id = ${deviceId} WHERE id = ${s.chatSessionId}`;
    // A continuation copies the source's device_id (insertContinuationSession).
    const id = await continuation(s.orgId, s.userId, s.chatSessionId, deviceId);
    const target = await createOrganization({ partnerId: s.partnerId });
    const targetSite = await createSite({ orgId: target.id });
    await withSystemDbAccessContext(() => db.execute(sql`
      UPDATE devices SET org_id = ${target.id}::uuid, site_id = ${targetSite!.id}::uuid WHERE id = ${deviceId}::uuid`));
    const rows = await fixtureSql`
      SELECT id, org_id, continued_from_session_id FROM ai_sessions WHERE id IN (${s.chatSessionId}, ${id})`;
    expect(rows.map((r) => String(r.org_id)).sort()).toEqual([target.id, target.id]);
    expect(String(rows.find((r) => String(r.id) === id)!.continued_from_session_id)).toBe(s.chatSessionId);
  });

  it('the device-move statement shape (one UPDATE … WHERE device_id) re-stamps a pair directly too', async () => {
    const s = await seedRegistryPartner('platform');
    const { deviceId } = await seedDevice(s.orgId);
    await fixtureSql`UPDATE ai_sessions SET device_id = ${deviceId} WHERE id = ${s.chatSessionId}`;
    const id = await continuation(s.orgId, s.userId, s.chatSessionId, deviceId);
    const target = await createOrganization({ partnerId: s.partnerId });
    await withSystemDbAccessContext(() => db.execute(sql`
      UPDATE ai_sessions SET org_id = ${target.id}::uuid WHERE device_id = ${deviceId}::uuid`));
    const rows = await fixtureSql`SELECT org_id FROM ai_sessions WHERE id IN (${s.chatSessionId}, ${id})`;
    expect(rows.map((r) => String(r.org_id))).toEqual([target.id, target.id]);
  });

  it('org merge: re-pointing the pair in SEPARATE statements commits under SET CONSTRAINTS ALL DEFERRED (deferrable FK)', async () => {
    const s = await seedRegistryPartner('platform');
    const id = await continuation(s.orgId, s.userId, s.chatSessionId);
    const survivor = await createOrganization({ partnerId: s.partnerId });
    // Control: without deferral the first separate statement breaks the link.
    await expect(fixtureSql.begin(async (tx) => {
      await tx`UPDATE ai_sessions SET org_id = ${survivor.id} WHERE id = ${id}`;
    })).rejects.toMatchObject({ code: '23503' });
    await fixtureSql.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`UPDATE ai_sessions SET org_id = ${survivor.id} WHERE id = ${id}`;
      await tx`UPDATE ai_sessions SET org_id = ${survivor.id} WHERE id = ${s.chatSessionId}`;
    });
    const rows = await fixtureSql`SELECT org_id FROM ai_sessions WHERE id IN (${s.chatSessionId}, ${id})`;
    expect(rows.map((r) => String(r.org_id))).toEqual([survivor.id, survivor.id]);
  });

  it('the constraint is DEFERRABLE INITIALLY IMMEDIATE with ON DELETE SET NULL (continued_from_session_id)', async () => {
    const [c] = await fixtureSql`
      SELECT condeferrable, condeferred, pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE conname = 'ai_sessions_continued_from_fk' AND conrelid = 'public.ai_sessions'::regclass`;
    expect(c).toMatchObject({ condeferrable: true, condeferred: false });
    expect(String(c!.def)).toMatch(/FOREIGN KEY \(continued_from_session_id, org_id\) REFERENCES ai_sessions\(id, org_id\) ON DELETE SET NULL \(continued_from_session_id\)/);
  });

  it('insertContinuationSession (as breeze_app, the owner\'s org context) links, copies the source, and stores the summary', async () => {
    const s = await seedRegistryPartner('platform');
    const { deviceId } = await seedDevice(s.orgId);
    await fixtureSql`
      UPDATE ai_sessions SET device_id = ${deviceId}, title = 'Slow SRV01', system_prompt = 'sp-src',
             context_snapshot = ${fixtureSql.json({ page: 'device' })}
      WHERE id = ${s.chatSessionId}`;
    const [source] = await fixtureSql`SELECT * FROM ai_sessions WHERE id = ${s.chatSessionId}`;
    const sourceRow = {
      id: String(source!.id), orgId: String(source!.org_id), userId: String(source!.user_id), deviceId,
      title: 'Slow SRV01', systemPrompt: 'sp-src', contextSnapshot: { page: 'device' }, delegantM365ConnectionId: null,
    } as never;
    const choice = {
      offeringId: s.offeringId, offeringPartnerId: s.partnerId, options: null, model: s.modelId, billingSource: 'platform',
    } as unknown as SessionModelChoice;
    const created = await withDbAccessContext({ ...orgContext(s.orgId, s.partnerId), userId: s.userId }, () => insertContinuationSession({
      source: sourceRow, userId: s.userId, choice, maxTurns: 40, summary: 'The summary.', omittedMessages: 3,
    }));
    const [row] = await fixtureSql`SELECT * FROM ai_sessions WHERE id = ${created.sessionId}`;
    expect(row).toMatchObject({
      org_id: s.orgId, user_id: s.userId, type: 'general', device_id: deviceId, continued_from_session_id: s.chatSessionId,
      offering_id: s.offeringId, offering_partner_id: s.partnerId, model: s.modelId, max_turns: 40,
      system_prompt: 'sp-src', title: 'Slow SRV01 (continued)', sdk_session_id: null,
    });
    const summary = await withDbAccessContext({ ...orgContext(s.orgId, s.partnerId), userId: s.userId },
      () => loadContinuationSummary(created.sessionId));
    expect(summary).toBe('The summary.');
    const [msg] = await fixtureSql`SELECT role, content FROM ai_messages WHERE id = ${created.summaryMessageId}`;
    expect(msg).toMatchObject({ role: 'assistant', content: 'The summary.' });
    // An ordinary session has no summary.
    expect(await withDbAccessContext({ ...orgContext(s.orgId, s.partnerId), userId: s.userId },
      () => loadContinuationSummary(s.chatSessionId))).toBeNull();
  });
});
