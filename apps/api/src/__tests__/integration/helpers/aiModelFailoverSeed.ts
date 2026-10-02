/**
 * W09 integration seed (#7607): ONE partner with three routes at three prices.
 * Not a test file.
 *   P  platform offering   200/1000/20/250 (seedRegistryPartner's)
 *   P2 platform offering   400/2000/40/500
 *   K  BYOK offering       100/500/10/125 (its own price)
 * Every surface's partner assignment defaults to P (seedRegistryPartner).
 */
import { randomUUID } from 'node:crypto';
import { withSystemDbAccessContext } from '../../../db';
import { createConnection } from '../../../services/aiModels/connections';
import { fixtureSql, seedOffering } from '../aiModelRegistryFixtures';
import { seedPricedPlatformModel, seedRegistryPartner, type SeededRegistryPartner } from './aiModelRegistrySeed';

export interface SeededFailoverPartner extends SeededRegistryPartner {
  platformOfferingId: string;
  platformOffering2Id: string;
  byokOfferingId: string;
  byokConnectionId: string;
}

export async function seedFailoverPartner(): Promise<SeededFailoverPartner> {
  const s = await seedRegistryPartner('platform');
  const p2Model = await seedPricedPlatformModel();
  await fixtureSql`
    UPDATE ai_platform_models
       SET input_cents_per_m = 400, output_cents_per_m = 2000, cache_read_cents_per_m = 40, cache_write_cents_per_m = 500
     WHERE id = ${p2Model}`;
  const platformOffering2Id = await seedOffering({ partnerId: s.partnerId, platformModelId: p2Model, enabled: true });

  const conn = await withSystemDbAccessContext(() => createConnection({
    partnerId: s.partnerId, kind: 'anthropic_byok', name: 'W09 BYOK', apiKey: `sk-w09-${randomUUID()}`,
    catalogEntryId: null, connectedBy: s.userId, verifiedAt: new Date(),
  }));
  const byokOfferingId = await seedOffering({
    partnerId: s.partnerId, connectionId: conn.id, platformModelId: s.platformModelId, modelId: s.modelId,
    source: 'discovered', enabled: true,
  });
  await fixtureSql`
    UPDATE partner_ai_models
       SET price_input_cents_per_m = 100, price_output_cents_per_m = 500,
           price_cache_read_cents_per_m = 10, price_cache_write_cents_per_m = 125
     WHERE id = ${byokOfferingId}`;

  return { ...s, platformOfferingId: s.offeringId, platformOffering2Id, byokOfferingId, byokConnectionId: conn.id };
}

/** Sets a partner assignment's fallback list (and cross-funding flag) for (surface, role). */
export async function setPartnerFallbacks(
  s: SeededFailoverPartner, surface: string, ids: string[], crossFunding: boolean | null, role = 'default',
): Promise<void> {
  await fixtureSql`
    UPDATE ai_model_assignments
       SET fallback_offering_ids = ${ids}::uuid[], fallback_may_cross_funding = ${crossFunding}
     WHERE partner_id = ${s.partnerId} AND org_id IS NULL AND surface = ${surface} AND role = ${role}`;
}

/** Points a partner assignment's default at an offering. */
export async function setPartnerDefault(s: SeededFailoverPartner, surface: string, offeringId: string, role = 'default'): Promise<void> {
  await fixtureSql`
    UPDATE ai_model_assignments SET default_offering_id = ${offeringId}
     WHERE partner_id = ${s.partnerId} AND org_id IS NULL AND surface = ${surface} AND role = ${role}`;
}
