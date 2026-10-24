import { describe, it, expect } from 'vitest';
import fixture from '../fixtures/vpn-providers.json';
import { vpnProviderSchema } from './index';

// Cross-language contract for VPN provider ids (#8763). The Go half is
// agent/internal/collectors/vpn_contract_test.go. Ingest drops an entry whose
// provider this enum lacks, so drift means a provider silently never shows.
describe('vpnProviderSchema contract', () => {
  it('matches the provider ids the agent can emit', () => {
    expect([...vpnProviderSchema.options].sort()).toEqual([...fixture.providers].sort());
  });
});
