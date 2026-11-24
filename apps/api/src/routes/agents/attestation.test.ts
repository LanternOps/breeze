import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * #8318 T1: the attestation routes are off unless TPM_ATTESTATION_ENABLED is
 * 'true'; the route builds the baseline audit row the service writes in its
 * own transaction, and audits a wrong answer to the agent's own challenge as
 * a failed activation. The service itself is covered against real Postgres
 * and Redis in tpmAttestation.integration.test.ts.
 */
const mocks = vi.hoisted(() => ({
  issue: vi.fn(),
  complete: vi.fn(),
  rateLimiter: vi.fn(),
  writeAuditEvent: vi.fn(),
}));

vi.mock('../../services/tpmAttestation', async () => {
  const actual = await vi.importActual<typeof import('../../services/tpmAttestation')>('../../services/tpmAttestation');
  return { ...actual, issueAttestationChallenge: mocks.issue, completeAttestation: mocks.complete };
});
vi.mock('../../services/rate-limit', () => ({ rateLimiter: mocks.rateLimiter }));
vi.mock('../../services/redis', () => ({ getRedis: () => ({}) }));
vi.mock('../../services/auditEvents', async () => {
  const actual = await vi.importActual<typeof import('../../services/auditEvents')>('../../services/auditEvents');
  return { ...actual, writeAuditEvent: mocks.writeAuditEvent };
});

import { attestationRoutes } from './attestation';
import { TpmAttestationError } from '../../services/tpmAttestation';

const DEVICE = '30000000-0000-4000-8000-000000000001';
const ORG = '40000000-0000-4000-8000-000000000001';
const CHALLENGE = '10000000-0000-4000-8000-000000000009';

function buildApp(): Hono {
  const app = new Hono();
  app.use('/agents/*', async (c, next) => {
    c.set('agent', {
      deviceId: DEVICE,
      orgId: ORG,
      partnerId: '70000000-0000-4000-8000-000000000001',
      siteId: '50000000-0000-4000-8000-000000000001',
      agentId: 'agent-primary',
      installIncarnation: 1,
      role: 'agent',
    });
    await next();
  });
  app.route('/agents', attestationRoutes);
  return app;
}

const post = (app: Hono, action: 'challenge' | 'complete', body: unknown) => app.request(`/agents/agent-primary/attestation/${action}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const challengeBody = { ekPublic: 'AAEC', akPublic: 'AAEC' };
const completeBody = { challengeId: CHALLENGE, secret: 'c2VjcmV0' };

describe('agent TPM attestation routes (#8318 T1)', () => {
  const original = process.env.TPM_ATTESTATION_ENABLED;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rateLimiter.mockResolvedValue({ allowed: true });
    mocks.issue.mockResolvedValue({ challengeId: CHALLENGE, credentialBlob: 'AA==', encryptedSecret: 'AA==', expiresInSeconds: 300 });
  });
  afterEach(() => {
    if (original === undefined) delete process.env.TPM_ATTESTATION_ENABLED;
    else process.env.TPM_ATTESTATION_ENABLED = original;
  });

  it.each([undefined, 'false', 'TRUE'])('refuses both routes before any work while the switch is %s', async (value) => {
    if (value === undefined) delete process.env.TPM_ATTESTATION_ENABLED;
    else process.env.TPM_ATTESTATION_ENABLED = value;
    const app = buildApp();
    for (const [action, body] of [['challenge', challengeBody], ['complete', completeBody]] as const) {
      const res = await post(app, action, body);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'TPM_ATTESTATION_DISABLED' });
    }
    expect(mocks.rateLimiter).not.toHaveBeenCalled();
    expect(mocks.issue).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('issues a challenge when the switch is on', async () => {
    process.env.TPM_ATTESTATION_ENABLED = 'true';
    const res = await post(buildApp(), 'challenge', challengeBody);
    expect(res.status).toBe(200);
    expect(mocks.issue).toHaveBeenCalledWith(expect.objectContaining({ deviceId: DEVICE, agentId: 'agent-primary' }), challengeBody);
  });

  it.each([
    ['recorded', 'device.tpm_baseline.recorded'],
    ['mismatch', 'device.tpm_baseline.mismatch'],
  ] as const)('hands the service the %s audit row to write with the baseline', async (outcome, action) => {
    process.env.TPM_ATTESTATION_ENABLED = 'true';
    mocks.complete.mockImplementation(async (_agent, _input, audit) => {
      expect(audit(action, ORG)).toMatchObject({ action, orgId: ORG, resourceType: 'device', resourceId: DEVICE, actorType: 'agent', result: 'success' });
      return { outcome, orgId: ORG };
    });
    const res = await post(buildApp(), 'complete', completeBody);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ attested: true, baseline: outcome });
    expect(mocks.complete).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: DEVICE, agentId: 'agent-primary', orgId: ORG }),
      completeBody,
      expect.any(Function),
    );
    // Written by the service in its transaction, not after the fact.
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
  });

  it('audits a wrong answer to its own challenge as a failed activation, and answers like any invalid challenge', async () => {
    process.env.TPM_ATTESTATION_ENABLED = 'true';
    mocks.complete.mockRejectedValue(new TpmAttestationError('TPM_CHALLENGE_INVALID', 403, 'The attestation challenge is invalid or expired', 'wrong_secret'));
    const res = await post(buildApp(), 'complete', completeBody);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'TPM_CHALLENGE_INVALID' });
    expect(body).not.toHaveProperty('reason');
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'device.tpm_attestation.failed',
      resourceId: DEVICE,
      orgId: ORG,
      result: 'failure',
    }));
  });

  it('does not audit an unknown or expired challenge', async () => {
    process.env.TPM_ATTESTATION_ENABLED = 'true';
    mocks.complete.mockRejectedValue(new TpmAttestationError('TPM_CHALLENGE_INVALID', 403, 'The attestation challenge is invalid or expired'));
    const res = await post(buildApp(), 'complete', completeBody);
    expect(res.status).toBe(403);
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
  });

  it('answers 401 when the row changed hands, and 404 when it is gone', async () => {
    process.env.TPM_ATTESTATION_ENABLED = 'true';
    mocks.complete.mockResolvedValueOnce('stale');
    expect((await post(buildApp(), 'complete', completeBody)).status).toBe(401);
    mocks.complete.mockResolvedValueOnce('not_found');
    expect((await post(buildApp(), 'complete', completeBody)).status).toBe(404);
  });
});
