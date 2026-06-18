import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

const partnerLookupMock = vi.fn();
const staleCandidatesMock = vi.fn();
const setPaymentMock = vi.fn();
const cascadeDeletePartnerMock = vi.fn();

vi.mock('../../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => partnerLookupMock(),
          }),
        }),
      }),
    }),
    selectDistinct: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => staleCandidatesMock(),
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

const CANARY = [{ email: 'signup-canary+abc@2breeze.app' }];
const REAL = [{ email: 'owner@acme.com' }];
const MIXED = [{ email: 'signup-canary+x@2breeze.app' }, { email: 'real@acme.com' }];

// partnerId is now uuid-validated; the latch (not the shape) is the real gate.
const PID = '11111111-1111-1111-1111-111111111111';

async function load() {
  vi.resetModules();
  const { internalSyntheticRoutes } = await import('./synthetic');
  return internalSyntheticRoutes;
}

function req(path: string, headers: Record<string, string> = {}, body: unknown = { partnerId: PID }) {
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
    staleCandidatesMock.mockReset().mockResolvedValue([]);
    setPaymentMock.mockReset().mockResolvedValue(undefined);
    cascadeDeletePartnerMock.mockReset().mockResolvedValue({ orgsDeleted: 1, tablesSwept: 3, totalRowsDeleted: 4, tablesDeleted: {} });
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

  for (const path of ['/simulate-payment', '/purge-partner']) {
    it(`${path}: 422 when partner has mixed canary+real members (hardening)`, async () => {
      vi.stubEnv('SYNTHETIC_TEST_TOKEN', 's3cret-token');
      partnerLookupMock.mockResolvedValue(MIXED);
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
    expect(cascadeDeletePartnerMock).toHaveBeenCalledWith(PID, expect.any(String));
  });

  // Gate ordering: bearer is checked BEFORE the IP allowlist so an
  // unauthenticated caller always sees 401 regardless of source IP — probing
  // the allowlist must require a valid token.
  for (const path of ['/simulate-payment', '/purge-partner', '/purge-stale-canaries']) {
    it(`${path}: 401 (not 403) on bad bearer even when IP is off the allowlist`, async () => {
      vi.stubEnv('SYNTHETIC_TEST_TOKEN', 's3cret-token');
      vi.stubEnv('SYNTHETIC_TEST_IP_ALLOWLIST', '1.2.3.4'); // mock IP 10.0.0.9 is off-list
      const app = await load();
      const res = await app.request(req(path, { Authorization: 'Bearer nope' }));
      expect(res.status).toBe(401);
    });
  }

  for (const path of ['/simulate-payment', '/purge-partner']) {
    it(`${path}: 400 on a non-uuid partnerId (clean reject, not a 500)`, async () => {
      vi.stubEnv('SYNTHETIC_TEST_TOKEN', 's3cret-token');
      const app = await load();
      const res = await app.request(req(path, AUTH, { partnerId: 'not-a-uuid' }));
      expect(res.status).toBe(400);
    });
  }

  describe('purge-stale-canaries (sweep-by-pattern fallback)', () => {
    it('purges only candidates that pass the canary latch, skips the rest', async () => {
      vi.stubEnv('SYNTHETIC_TEST_TOKEN', 's3cret-token');
      const canaryId = '22222222-2222-2222-2222-222222222222';
      const impostorId = '33333333-3333-3333-3333-333333333333';
      staleCandidatesMock.mockResolvedValue([{ id: canaryId }, { id: impostorId }]);
      // isCanary re-validation: first candidate is a real canary, second is not.
      partnerLookupMock.mockResolvedValueOnce(CANARY).mockResolvedValueOnce(MIXED);

      const app = await load();
      const res = await app.request(req('/purge-stale-canaries', AUTH, { olderThanMinutes: 30 }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { purged: string[]; skipped: string[] };
      expect(body.purged).toEqual([canaryId]);
      expect(body.skipped).toEqual([impostorId]);
      expect(cascadeDeletePartnerMock).toHaveBeenCalledTimes(1);
      expect(cascadeDeletePartnerMock).toHaveBeenCalledWith(canaryId, expect.any(String));
    });

    it('400 on a non-integer olderThanMinutes', async () => {
      vi.stubEnv('SYNTHETIC_TEST_TOKEN', 's3cret-token');
      const app = await load();
      const res = await app.request(req('/purge-stale-canaries', AUTH, { olderThanMinutes: 'soon' }));
      expect(res.status).toBe(400);
    });

    it('defaults the cutoff and returns empty when there are no candidates', async () => {
      vi.stubEnv('SYNTHETIC_TEST_TOKEN', 's3cret-token');
      staleCandidatesMock.mockResolvedValue([]);
      const app = await load();
      const res = await app.request(req('/purge-stale-canaries', AUTH, {}));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { purged: string[]; olderThanMinutes: number };
      expect(body.purged).toEqual([]);
      expect(body.olderThanMinutes).toBe(60);
      expect(cascadeDeletePartnerMock).not.toHaveBeenCalled();
    });
  });
});
