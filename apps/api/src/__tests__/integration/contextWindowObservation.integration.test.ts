/**
 * The persisted context-window observation (#11396 W02 T6) against real
 * Postgres: the compare on offering id, partner id and the connection's
 * CURRENT config_version is a real predicate (a stale one matches zero rows),
 * the write runs under forced RLS in the system context, and it never touches
 * the row's updated_at. Seeds use the superuser fixture client.
 *
 * #11393: an observation is a floor until a larger window is seen. The clear
 * on a served prompt is the same kind of compare: it matches only the
 * disproven value under the current config_version and the owning partner.
 */
import './setup';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { withSystemDbAccessContext } from '../../db';
import { resolveEffectiveContextWindow } from '../../services/aiModels/contextWindowFacts';
import {
  __resetContextWindowObservationsForTests,
  clearDisprovenContextWindow,
  clearObservedContextWindow,
  recordObservedContextWindow,
  settledContextWindowObservations,
  writeObservedContextWindow,
} from '../../services/aiModels/contextWindowObservation';
import { createPartner } from './db-utils';
import { closeRegistryFixtures, fixtureSql as adminSql, seedByokConnection, seedOffering } from './aiModelRegistryFixtures';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);
afterEach(() => __resetContextWindowObservationsForTests());

async function seed(configVersion = 4) {
  const partner = await createPartner();
  const connectionId = await seedByokConnection(partner.id);
  await adminSql`UPDATE partner_ai_connections SET config_version = ${configVersion} WHERE id = ${connectionId}`;
  const offeringId = await seedOffering({ partnerId: partner.id, connectionId, modelId: 'qwen-8k', source: 'discovered' });
  const [row] = await adminSql`SELECT updated_at FROM partner_ai_models WHERE id = ${offeringId}`;
  return { partnerId: partner.id, connectionId, offeringId, updatedAt: row!.updated_at as Date };
}

const observedOf = async (id: string) => {
  const [row] = await adminSql`
    SELECT context_window_observed, context_window_observed_at, context_window_observed_config_version, updated_at
      FROM partner_ai_models WHERE id = ${id}`;
  return row!;
};

describe.skipIf(!RUN)('context window observation write (#11396)', () => {
  it('a current config_version writes observed, observed_at and observed_config_version; updated_at is untouched', async () => {
    const s = await seed(4);
    const at = new Date('2026-11-11T12:00:00Z');
    const wrote = await withSystemDbAccessContext(() => writeObservedContextWindow(
      { offeringId: s.offeringId, partnerId: s.partnerId, configVersion: 4, contextWindow: 8192 }, at));
    expect(wrote).toBe(true);
    const row = await observedOf(s.offeringId);
    expect(row.context_window_observed).toBe(8192);
    expect(new Date(row.context_window_observed_at as Date).toISOString()).toBe(at.toISOString());
    expect(row.context_window_observed_config_version).toBe(4);
    expect(new Date(row.updated_at as Date).toISOString()).toBe(new Date(s.updatedAt).toISOString());
  });

  it('an UPDATE with a stale config_version matches zero rows (the predicate is real)', async () => {
    const s = await seed(4);
    const wrote = await withSystemDbAccessContext(() => writeObservedContextWindow(
      { offeringId: s.offeringId, partnerId: s.partnerId, configVersion: 3, contextWindow: 8192 }));
    expect(wrote).toBe(false);
    expect((await observedOf(s.offeringId)).context_window_observed).toBeNull();
  });

  it('another partner\'s id matches zero rows', async () => {
    const s = await seed(4);
    const other = await createPartner();
    const wrote = await withSystemDbAccessContext(() => writeObservedContextWindow(
      { offeringId: s.offeringId, partnerId: other.id, configVersion: 4, contextWindow: 8192 }));
    expect(wrote).toBe(false);
    expect((await observedOf(s.offeringId)).context_window_observed).toBeNull();
  });

  it('recordObservedContextWindow (fire-and-forget, system context outside any request) lands the write', async () => {
    const s = await seed(2);
    recordObservedContextWindow({ offeringId: s.offeringId, partnerId: s.partnerId, configVersion: 2, contextWindow: 16_384 });
    await settledContextWindowObservations();
    const row = await observedOf(s.offeringId);
    expect(row.context_window_observed).toBe(16_384);
    expect(row.context_window_observed_config_version).toBe(2);
  });
});

describe.skipIf(!RUN)('a persisted observation is a floor until disproved (#11393)', () => {
  // The observed_at a disproof carries by default: the grant read the row written at AT.
  const AT = new Date(Date.now() - 5 * 60_000);
  const observe = (s: { offeringId: string; partnerId: string }, configVersion: number, contextWindow: number, at = AT) =>
    withSystemDbAccessContext(() => writeObservedContextWindow({ offeringId: s.offeringId, partnerId: s.partnerId, configVersion, contextWindow }, at));
  const disproof = (s: { offeringId: string; partnerId: string }, over: Partial<{ partnerId: string; configVersion: number; disprovenWindow: number; observedAt: number; servedPromptTokens: number }> = {}) => ({
    offeringId: s.offeringId, partnerId: s.partnerId, configVersion: 4, disprovenWindow: 8192, observedAt: AT.getTime(), servedPromptTokens: 9000, ...over,
  });
  const fields = (row: Record<string, unknown>) => ({
    contextWindowObserved: row.context_window_observed as number | null,
    contextWindowObservedAt: row.context_window_observed_at ? new Date(row.context_window_observed_at as Date) : null,
    contextWindowObservedConfigVersion: row.context_window_observed_config_version as number | null,
  });

  it('read back after more than an hour idle, the row still constrains when nothing is listed', async () => {
    const s = await seed(4);
    await observe(s, 4, 8192, new Date(Date.now() - 3 * 3_600_000));
    const w = resolveEffectiveContextWindow(fields(await observedOf(s.offeringId)), 4);
    expect(w).toMatchObject({ value: 8192, source: 'observed', observedFresh: false, observedApplies: true });
  });

  it('a larger stated window replaces the stored one', async () => {
    const s = await seed(4);
    await observe(s, 4, 8192);
    expect(await observe(s, 4, 32_768)).toBe(true);
    expect((await observedOf(s.offeringId)).context_window_observed).toBe(32_768);
  });

  it('a later rejection stating a SMALLER window also replaces a stale one (any later statement wins)', async () => {
    const s = await seed(4);
    await observe(s, 4, 32_768, new Date(Date.now() - 3 * 3_600_000));
    expect(await observe(s, 4, 8192)).toBe(true);
    const w = resolveEffectiveContextWindow(fields(await observedOf(s.offeringId)), 4);
    expect(w).toMatchObject({ value: 8192, source: 'observed', observedFresh: true });
  });

  it('a config change clears it: the stored row no longer constrains under the new version', async () => {
    const s = await seed(4);
    await observe(s, 4, 8192, new Date(Date.now() - 3 * 3_600_000));
    await adminSql`UPDATE partner_ai_connections SET config_version = 5 WHERE id = ${s.connectionId}`;
    const w = resolveEffectiveContextWindow(fields(await observedOf(s.offeringId)), 5);
    expect(w).toMatchObject({ value: null, source: 'unknown', observedApplies: false });
  });

  it('a served prompt larger than the stored window clears it; updated_at is untouched', async () => {
    const s = await seed(4);
    await observe(s, 4, 8192);
    expect(await withSystemDbAccessContext(() => clearObservedContextWindow(disproof(s)))).toBe(true);
    const row = await observedOf(s.offeringId);
    expect(row.context_window_observed).toBeNull();
    expect(row.context_window_observed_at).toBeNull();
    expect(row.context_window_observed_config_version).toBeNull();
    expect(new Date(row.updated_at as Date).toISOString()).toBe(new Date(s.updatedAt).toISOString());
  });

  it('the clear with another partner\'s id matches zero rows', async () => {
    const s = await seed(4);
    await observe(s, 4, 8192);
    const other = await createPartner();
    expect(await withSystemDbAccessContext(() => clearObservedContextWindow(disproof(s, { partnerId: other.id })))).toBe(false);
    expect((await observedOf(s.offeringId)).context_window_observed).toBe(8192);
  });

  it('the clear with a stale config_version matches zero rows', async () => {
    const s = await seed(4);
    await observe(s, 4, 8192);
    expect(await withSystemDbAccessContext(() => clearObservedContextWindow(disproof(s, { configVersion: 3 })))).toBe(false);
    expect((await observedOf(s.offeringId)).context_window_observed).toBe(8192);
  });

  it('the clear never erases a newer observation written meanwhile (it matches only the disproven value)', async () => {
    const s = await seed(4);
    await observe(s, 4, 4096);
    expect(await withSystemDbAccessContext(() => clearObservedContextWindow(disproof(s)))).toBe(false);
    expect((await observedOf(s.offeringId)).context_window_observed).toBe(4096);
  });

  it('a late clear never erases a NEWER row holding the same value (it compares observed_at)', async () => {
    const s = await seed(4);
    const newer = new Date(AT.getTime() + 60_000);
    await observe(s, 4, 8192, newer);
    expect(await withSystemDbAccessContext(() => clearObservedContextWindow(disproof(s)))).toBe(false);
    const row = await observedOf(s.offeringId);
    expect(row.context_window_observed).toBe(8192);
    expect(new Date(row.context_window_observed_at as Date).toISOString()).toBe(newer.toISOString());
  });

  it('a served prompt that does not exceed the stored window matches zero rows', async () => {
    const s = await seed(4);
    await observe(s, 4, 8192);
    expect(await withSystemDbAccessContext(() => clearObservedContextWindow(disproof(s, { servedPromptTokens: 8192 })))).toBe(false);
    expect((await observedOf(s.offeringId)).context_window_observed).toBe(8192);
  });

  it('clearDisprovenContextWindow (fire-and-forget, system context outside any request) lands the clear', async () => {
    const s = await seed(4);
    await observe(s, 4, 8192);
    clearDisprovenContextWindow(disproof(s));
    await settledContextWindowObservations();
    expect((await observedOf(s.offeringId)).context_window_observed).toBeNull();
  });
});
