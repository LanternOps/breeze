/** Bind one parity fixture to the legacy mocks (#7600 W02; W03 Task 1 imports it). */
import { organizations, partnerLlmConfigs } from '../../../db/schema';
import { columnAad, encryptedColumnRegistry } from '../../encryptedColumnRegistry';
import { encryptSecret } from '../../secretCrypto';
import type { ParityFixture } from './harness';
import { legacyFixtureState } from './legacyFixtureMocks';

export function bindLegacyFixture(fixture: ParityFixture): void {
  const legacySpec = encryptedColumnRegistry.find((s) => s.table === 'partner_llm_configs' && s.column === 'api_key_encrypted')!;
  const config = fixture.snapshot.config;
  legacyFixtureState.rows = new Map<unknown, unknown[]>([
    [organizations, [{ partnerId: fixture.snapshot.partnerId }]],
    [partnerLlmConfigs, config ? [{
      id: config.id, partnerId: fixture.snapshot.partnerId,
      apiKeyEncrypted: encryptSecret(fixture.legacyApiKey!, { aad: columnAad(legacySpec, config.id) }),
      defaultModel: config.defaultModel, catalogEntryId: config.catalogEntryId,
      status: config.status, configVersion: 1,
    }] : []],
  ]);
  legacyFixtureState.catalogProvider = fixture.catalogProvider;
}
