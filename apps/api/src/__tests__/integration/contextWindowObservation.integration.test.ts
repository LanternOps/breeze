/**
 * The persisted context-window observation (#11396 W02 T6) against real
 * Postgres: the compare on offering id, partner id and the connection's
 * CURRENT config_version is a real predicate (a stale one matches zero rows),
 * the write runs under forced RLS in the system context, and it never touches
 * the row's updated_at. Seeds use the superuser fixture client.
 */
import './setup';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { withSystemDbAccessContext } from '../../db';
import {
  __resetContextWindowObservationsForTests,
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
