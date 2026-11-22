import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const contexts: unknown[] = [];

vi.mock('../../db', () => ({
  db: {},
  // Record the context and stop before any SQL: only the scope is under test.
  withDbAccessContext: vi.fn(async (ctx: unknown) => {
    contexts.push(ctx);
    return 'not_found';
  }),
}));

const secret = Buffer.from('the activated secret');
vi.mock('../redis', () => ({
  getRedis: () => ({
    getdel: async () => JSON.stringify({
      deviceId: 'device-1',
      agentId: 'agent-1',
      secretSha256: createHash('sha256').update(secret).digest('hex'),
      ekSha256: 'ek',
    }),
  }),
}));

import { completeAttestation } from './index';

const audit = () => { throw new Error('no audit expected'); };
const input = { challengeId: 'challenge-1', secret: secret.toString('base64') };
const agent = { deviceId: 'device-1', agentId: 'agent-1', orgId: 'org-1', partnerId: 'partner-1' };

describe('completeAttestation DB scope', () => {
  beforeEach(() => { contexts.length = 0; });

  it('scopes to the device org and its partner', async () => {
    expect(await completeAttestation(agent, input, audit)).toBe('not_found');
    expect(contexts).toEqual([{
      scope: 'organization',
      orgId: 'org-1',
      accessibleOrgIds: ['org-1'],
      accessiblePartnerIds: [],
      currentPartnerId: 'partner-1',
    }]);
  });

  it('gives a parked device no partner scope, like the agentAuth request wrap', async () => {
    expect(await completeAttestation({ ...agent, isPreAssignment: true }, input, audit)).toBe('not_found');
    expect(contexts).toEqual([expect.objectContaining({ orgId: 'org-1', currentPartnerId: null })]);
  });
});
