import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDnsProvider } from './index';
import { requestJson } from './http';

// Provider transport is mocked — we only assert that the factory threads the
// on-prem `allowPrivateNetwork` opt-in into the right providers based on
// IS_HOSTED, and leaves cloud providers strict.
vi.mock('./http', () => ({
  requestJson: vi.fn(async () => ({}))
}));

const requestJsonMock = vi.mocked(requestJson);

function lastInit(): { allowPrivateNetwork?: boolean } {
  const call = requestJsonMock.mock.calls.at(-1);
  if (!call) throw new Error('requestJson was not called');
  return (call[1] ?? {}) as { allowPrivateNetwork?: boolean };
}

describe('createDnsProvider — on-prem allowPrivateNetwork gating', () => {
  const originalIsHosted = process.env.IS_HOSTED;

  beforeEach(() => {
    requestJsonMock.mockClear();
    requestJsonMock.mockImplementation(async () => ({}) as never);
  });

  afterEach(() => {
    if (originalIsHosted === undefined) delete process.env.IS_HOSTED;
    else process.env.IS_HOSTED = originalIsHosted;
  });

  describe('IS_HOSTED unset → STRICT (fail closed)', () => {
    // An unmapped/unset IS_HOSTED must never silently weaken security
    // (the #570 hardening lesson). On-prem providers stay strict unless
    // self-host is affirmatively declared.
    beforeEach(() => {
      delete process.env.IS_HOSTED;
    });

    it('pihole stays strict (allowPrivateNetwork false)', async () => {
      const provider = createDnsProvider({
        provider: 'pihole',
        apiKey: 'key',
        apiSecret: null,
        config: { apiEndpoint: 'https://pi.hole.local' } as never
      });
      await provider.addBlocklistDomain('bad.example');
      expect(lastInit().allowPrivateNetwork).toBe(false);
    });

    it('adguard_home stays strict (allowPrivateNetwork false)', async () => {
      const provider = createDnsProvider({
        provider: 'adguard_home',
        apiKey: 'admin',
        apiSecret: 'pw',
        config: { apiEndpoint: 'https://adguard.local' } as never
      });
      requestJsonMock.mockImplementation(async () => ({ data: [] }) as never);
      await provider.syncEvents(new Date(0), new Date());
      expect(lastInit().allowPrivateNetwork).toBe(false);
    });

    it('IS_HOSTED empty string stays strict (allowPrivateNetwork false)', async () => {
      process.env.IS_HOSTED = '';
      const provider = createDnsProvider({
        provider: 'pihole',
        apiKey: 'key',
        apiSecret: null,
        config: { apiEndpoint: 'https://pi.hole.local' } as never
      });
      await provider.addBlocklistDomain('bad.example');
      expect(lastInit().allowPrivateNetwork).toBe(false);
    });

    it('IS_HOSTED garbage value stays strict (allowPrivateNetwork false)', async () => {
      process.env.IS_HOSTED = 'garbage';
      const provider = createDnsProvider({
        provider: 'pihole',
        apiKey: 'key',
        apiSecret: null,
        config: { apiEndpoint: 'https://pi.hole.local' } as never
      });
      await provider.addBlocklistDomain('bad.example');
      expect(lastInit().allowPrivateNetwork).toBe(false);
    });
  });

  describe('self-hosted (IS_HOSTED explicitly non-truthy)', () => {
    beforeEach(() => {
      process.env.IS_HOSTED = 'false';
    });

    it('pihole opts INTO private networking', async () => {
      const provider = createDnsProvider({
        provider: 'pihole',
        apiKey: 'key',
        apiSecret: null,
        config: { apiEndpoint: 'https://pi.hole.local' } as never
      });
      await provider.addBlocklistDomain('bad.example');
      expect(lastInit().allowPrivateNetwork).toBe(true);
    });

    it('adguard_home opts INTO private networking', async () => {
      const provider = createDnsProvider({
        provider: 'adguard_home',
        apiKey: 'admin',
        apiSecret: 'pw',
        config: { apiEndpoint: 'https://adguard.local' } as never
      });
      requestJsonMock.mockImplementation(async () => ({ data: [] }) as never);
      await provider.syncEvents(new Date(0), new Date());
      expect(lastInit().allowPrivateNetwork).toBe(true);
    });
  });

  describe('hosted SaaS (IS_HOSTED=true)', () => {
    beforeEach(() => {
      process.env.IS_HOSTED = 'true';
    });

    it('pihole stays strict (allowPrivateNetwork false)', async () => {
      const provider = createDnsProvider({
        provider: 'pihole',
        apiKey: 'key',
        apiSecret: null,
        config: { apiEndpoint: 'https://pi.hole.local' } as never
      });
      await provider.addBlocklistDomain('bad.example');
      expect(lastInit().allowPrivateNetwork).toBe(false);
    });

    it('adguard_home stays strict (allowPrivateNetwork false)', async () => {
      const provider = createDnsProvider({
        provider: 'adguard_home',
        apiKey: 'admin',
        apiSecret: 'pw',
        config: { apiEndpoint: 'https://adguard.local' } as never
      });
      requestJsonMock.mockImplementation(async () => ({ data: [] }) as never);
      await provider.syncEvents(new Date(0), new Date());
      expect(lastInit().allowPrivateNetwork).toBe(false);
    });
  });

  describe('cloud providers never set allowPrivateNetwork (strict regardless of IS_HOSTED)', () => {
    beforeEach(() => {
      process.env.IS_HOSTED = 'false'; // even self-hosted, cloud providers stay strict
    });

    it('cloudflare leaves allowPrivateNetwork unset', async () => {
      const provider = createDnsProvider({
        provider: 'cloudflare',
        apiKey: 'token',
        apiSecret: null,
        config: { accountId: 'acct', blocklistId: 'bl' } as never
      });
      requestJsonMock.mockImplementation(async () => ({ success: true, result: {} }) as never);
      await provider.addBlocklistDomain('bad.example');
      expect(lastInit().allowPrivateNetwork).toBeUndefined();
    });
  });
});
