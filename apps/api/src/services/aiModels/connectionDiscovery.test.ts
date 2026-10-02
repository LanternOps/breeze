import { describe, expect, it } from 'vitest';
import { GATEWAY_CONNECTION_KINDS } from '@breeze/shared';
import { CONNECTION_MODEL_DISCOVERERS, discoveryGrantRecord } from './connectionDiscovery';

const config = { source: 'gateway', kind: 'openai_compatible', partnerId: 'p', connectionId: 'c', configVersion: 3, baseUrl: 'https://llm.example.com/v1' } as const;

describe('CONNECTION_MODEL_DISCOVERERS', () => {
  it('has entries only for gateway kinds; openai_compatible lists /models', () => {
    for (const kind of Object.keys(CONNECTION_MODEL_DISCOVERERS)) {
      expect(GATEWAY_CONNECTION_KINDS as readonly string[]).toContain(kind);
    }
    expect(CONNECTION_MODEL_DISCOVERERS.openai_compatible).toBeTypeOf('function');
  });
});

describe('discoveryGrantRecord', () => {
  it('is an org-less, session-less discovery record that binds no wire model and expires soon', () => {
    const before = Date.now();
    const rec = discoveryGrantRecord(config, { secret: 'sk-abcdefgh12345' });
    expect(rec).toMatchObject({ orgId: null, aiSessionId: null, purpose: 'discovery', config });
    expect([...rec.wireModels]).toEqual([]);
    expect(rec.expiresAt).toBeGreaterThan(before);
    expect(rec.expiresAt).toBeLessThanOrEqual(before + 5 * 60_000);
    expect(rec.inFlight.size).toBe(0);
  });

  it('holds its own copy of the config and credential (no aliasing of the caller objects)', () => {
    const credential = { secret: 'sk-abcdefgh12345' as string | null };
    const rec = discoveryGrantRecord(config, credential);
    credential.secret = null;
    expect(rec.credential.secret).toBe('sk-abcdefgh12345');
    expect(rec.config).not.toBe(config);
  });

  it('carries no token: the record cannot be presented to the loopback gateway', () => {
    const rec = discoveryGrantRecord(config, { secret: null }) as unknown as Record<string, unknown>;
    expect('token' in rec).toBe(false);
  });
});
