/** Bind one parity fixture to the legacy mocks (#7600 W02; W03's registrySnapshotDeps imports it). */
import { organizations, partnerAiConnections, partnerLlmConfigs } from '../../../db/schema';
import { columnAad, encryptedColumnRegistry } from '../../encryptedColumnRegistry';
import { encryptSecret } from '../../secretCrypto';
import type { ParityFixture } from './harness';
import { legacyFixtureState } from './legacyFixtureMocks';

/** Returns the legacy row's key ciphertext (the registry connection is its byte copy), or null with no config. */
export function bindLegacyFixture(fixture: ParityFixture): string | null {
  const legacySpec = encryptedColumnRegistry.find((s) => s.table === 'partner_llm_configs' && s.column === 'api_key_encrypted')!;
  const config = fixture.snapshot.config;
  const sealedFor = fixture.legacyKeyUndecryptable ? '00000000-0000-4000-8000-0000000000ff' : config?.id;
  const apiKeyEncrypted = config ? encryptSecret(fixture.legacyApiKey!, { aad: columnAad(legacySpec, sealedFor!) })! : null;
  const configRows = config ? [{
    id: config.id, partnerId: fixture.snapshot.partnerId,
    apiKeyEncrypted,
    defaultModel: config.defaultModel, catalogEntryId: config.catalogEntryId,
    status: config.status, configVersion: 1,
  }] : [];
  legacyFixtureState.rows = new Map<unknown, unknown[]>([
    [organizations, [{ partnerId: fixture.snapshot.partnerId }]],
    [partnerLlmConfigs, configRows],
    // W03 Task 6B: the legacy resolver reads the same-id compat connection (a
    // byte copy under the same AAD tag), aliasing legacy_default_model as
    // defaultModel — so the same row serves both reads.
    [partnerAiConnections, configRows],
  ]);
  legacyFixtureState.catalogProvider = fixture.catalogProvider;
  return apiKeyEncrypted;
}
