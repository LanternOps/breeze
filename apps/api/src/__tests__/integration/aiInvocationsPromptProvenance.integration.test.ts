/**
 * AI model registry W11 (#7609): ai_invocations.prompt_profile / prompt_variant.
 * The CHECK ties a variant to its row's surface and profile; the columns are
 * as immutable as every other ledger column (append-only trigger + no UPDATE
 * grant); recordInvocation writes both.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { createOrganization, createPartner } from './db-utils';
import { closeRegistryFixtures, fixtureSql as adminSql, orgContext } from './aiModelRegistryFixtures';
import { recordInvocation } from '../../services/aiModels/invocationLedgerWrite';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

async function org() {
  const partner = await createPartner();
  const o = await createOrganization({ partnerId: partner.id });
  return { partnerId: partner.id, orgId: o.id };
}

async function insertRow(orgId: string, extra: Record<string, unknown>): Promise<string> {
  const [row] = await adminSql`
    INSERT INTO ai_invocations ${adminSql({
      org_id: orgId, surface: 'chat', funding_source: 'platform',
      requested_model: 'claude-opus-5-5', served_model: 'claude-opus-5-5', ...extra,
    })} RETURNING id`;
  return String(row!.id);
}

const sqlstate = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code ?? 'unknown');

describe.skipIf(!RUN)('ai_invocations prompt provenance (#7609 W11)', () => {
  it('accepts NULL/NULL (every pre-W11 row), a profile alone, and a matching variant', async () => {
    const { orgId } = await org();
    await expect(insertRow(orgId, {})).resolves.toBeTruthy();
    await expect(insertRow(orgId, { prompt_profile: 'claude-small', surface: 'script_reviewer' })).resolves.toBeTruthy();
    await expect(insertRow(orgId, { prompt_profile: 'claude-frontier', prompt_variant: 'chat/claude-frontier@1' })).resolves.toBeTruthy();
    await expect(insertRow(orgId, { surface: 'ai_agents', prompt_profile: 'claude-small', prompt_variant: 'ai_agents/claude-small@12' })).resolves.toBeTruthy();
  });

  it('the CHECK rejects a variant from another surface (23514)', async () => {
    const { orgId } = await org();
    expect(await sqlstate(insertRow(orgId, { surface: 'helper', prompt_profile: 'claude-frontier', prompt_variant: 'chat/claude-frontier@1' }))).toBe('23514');
  });

  it.each([
    ['another profile', { prompt_profile: 'claude-small', prompt_variant: 'chat/claude-frontier@1' }],
    ['no profile', { prompt_variant: 'chat/claude-frontier@1' }],
    ['the generic profile', { prompt_profile: 'generic', prompt_variant: 'chat/generic@1' }],
    ['an unknown profile', { prompt_profile: 'claude-huge' }],
    ['a malformed id', { prompt_profile: 'claude-frontier', prompt_variant: 'chat/claude-frontier@0' }],
    ['a free-text id', { prompt_profile: 'claude-frontier', prompt_variant: 'be nicer' }],
  ])('the CHECK rejects %s (23514)', async (_name, extra) => {
    const { orgId } = await org();
    expect(await sqlstate(insertRow(orgId, extra))).toBe('23514');
  });

  it('breeze_app cannot UPDATE either column (column privilege), even in system scope', async () => {
    const { orgId } = await org();
    const id = await insertRow(orgId, { prompt_profile: 'claude-frontier', prompt_variant: 'chat/claude-frontier@1' });
    const [p] = (await db.execute(sql`
      SELECT has_column_privilege('breeze_app', 'ai_invocations', 'prompt_profile', 'UPDATE') AS profile,
             has_column_privilege('breeze_app', 'ai_invocations', 'prompt_variant', 'UPDATE') AS variant`)) as unknown as Array<Record<string, boolean>>;
    expect(p).toEqual({ profile: false, variant: false });
    expect(await sqlstate(withSystemDbAccessContext(() => db.execute(sql`
      UPDATE ai_invocations SET prompt_variant = NULL WHERE id = ${id}::uuid`)))).toBe('42501');
  });

  it('the append-only trigger rejects a change to the new columns even for a privileged role', async () => {
    const { orgId } = await org();
    const id = await insertRow(orgId, { prompt_profile: 'claude-frontier', prompt_variant: 'chat/claude-frontier@1' });
    // The fixture role owns the table; only the trigger stands between it and the edit.
    expect(await sqlstate(adminSql`UPDATE ai_invocations SET prompt_profile = 'claude-small', prompt_variant = NULL WHERE id = ${id}`))
      .not.toBe('ok');
  });

  it('recordInvocation writes the three columns (and NULL when absent); occurred_at survives a JSON round trip', async () => {
    const { partnerId, orgId } = await org();
    const base = {
      orgId, surface: 'chat' as const, fundingSource: 'platform' as const,
      requestedModel: 'claude-opus-5-5', servedModel: 'claude-opus-5-5',
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, rateSnapshot: null, costCents: null,
      ledgerMode: 'shadow' as const,
    };
    const [withIt, without] = await withDbAccessContext(orgContext(orgId, partnerId), async () => [
      // A deferred settlement persists NewInvocation[] as JSON: occurredAt comes back as a string.
      await recordInvocation({ ...base, promptProfile: 'claude-frontier', promptVariant: 'chat/claude-frontier@1', occurredAt: '2026-09-15T11:59:00.000Z' }),
      await recordInvocation(base),
    ]);
    const rows = await adminSql`SELECT id, prompt_profile, prompt_variant, occurred_at FROM ai_invocations WHERE id IN (${withIt}, ${without})`;
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    expect(byId.get(withIt)).toMatchObject({ prompt_profile: 'claude-frontier', prompt_variant: 'chat/claude-frontier@1' });
    expect(new Date(byId.get(withIt)!.occurred_at as string).toISOString()).toBe('2026-09-15T11:59:00.000Z');
    expect(byId.get(without)).toMatchObject({ prompt_profile: null, prompt_variant: null, occurred_at: null });
  });
});
