import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

const partnerLookupMock = vi.fn();
const setPaymentMock = vi.fn();
const cascadeDeletePartnerMock = vi.fn();

vi.mock('../../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => ({ limit: () => partnerLookupMock() }),
          }),
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: () => setPaymentMock() }) }),
  },
  withSystemDbAccessContext: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../../services/tenantCascade', () => ({
  cascadeDeletePartner: (...a: unknown[]) => cascadeDeletePartnerMock(...a),
}));
vi.mock('../../services/clientIp', () => ({ getTrustedClientIpOrUndefined: () => '10.0.0.9' }));

const CANARY = [{ id: 'p1', adminEmail: 'signup-canary+abc@2breeze.app' }];
const REAL = [{ id: 'p1', adminEmail: 'owner@acme.com' }];

async function load() {
  vi.resetModules();
  const { internalSyntheticRoutes } = await import('./synthetic');
  return internalSyntheticRoutes;
}

function req(path: string, headers: Record<string, string> = {}, body: unknown = { partnerId: 'p1' }) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const AUTH = { Authorization: 'Bearer s3cret-token' };

describe('internal synthetic router gate', () => {
  beforeAll(async () => {
    // Warm the module graph once so the first real test isn't charged the
    // cold-import cost (transitive db/schema/service imports are heavy).
    vi.stubEnv('SYNTHETIC_TEST_TOKEN', 'warmup');
    await import('./synthetic');
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    partnerLookupMock.mockReset();
    setPaymentMock.mockReset().mockResolvedValue(undefined);
    cascadeDeletePartnerMock.mockReset().mockResolvedValue({ orgsDeleted: 1, tablesSwept: 3 });
    vi.unstubAllEnvs();
  });

  for (const path of ['/simulate-payment', '/purge-partner']) {
    it(`${path}: 503 when SYNTHETIC_TEST_TOKEN unset`, async () => {
      const app = await load();
      const res = await app.request(req(path, AUTH));
      expect(res.status).toBe(503);
    });

    it(`${path}: 401 on wrong bearer`, async () => {
      vi.stubEnv('SYNTHETIC_TEST_TOKEN', 's3cret-token');
      const app = await load();
      const res = await app.request(req(path, { Authorization: 'Bearer nope' }));
      expect(res.status).toBe(401);
    });

    it(`${path}: 403 when IP not in allowlist`, async () => {
      vi.stubEnv('SYNTHETIC_TEST_TOKEN', 's3cret-token');
      vi.stubEnv('SYNTHETIC_TEST_IP_ALLOWLIST', '1.2.3.4');
      const app = await load();
      const res = await app.request(req(path, AUTH));
      expect(res.status).toBe(403);
    });

    it(`${path}: 422 when target is NOT a canary account (the latch)`, async () => {
      vi.stubEnv('SYNTHETIC_TEST_TOKEN', 's3cret-token');
      partnerLookupMock.mockResolvedValue(REAL);
      const app = await load();
      const res = await app.request(req(path, AUTH));
      expect(res.status).toBe(422);
    });
  }

  it('simulate-payment: writes payment_method_attached_at for a canary, does NOT flip status', async () => {
    vi.stubEnv('SYNTHETIC_TEST_TOKEN', 's3cret-token');
    partnerLookupMock.mockResolvedValue(CANARY);
    const app = await load();
    const res = await app.request(req('/simulate-payment', AUTH));
    expect(res.status).toBe(200);
    expect(setPaymentMock).toHaveBeenCalledTimes(1);
    expect(cascadeDeletePartnerMock).not.toHaveBeenCalled();
  });

  it('purge-partner: cascades a canary partner', async () => {
    vi.stubEnv('SYNTHETIC_TEST_TOKEN', 's3cret-token');
    partnerLookupMock.mockResolvedValue(CANARY);
    const app = await load();
    const res = await app.request(req('/purge-partner', AUTH));
    expect(res.status).toBe(200);
    expect(cascadeDeletePartnerMock).toHaveBeenCalledWith('p1', expect.any(String));
  });
});
