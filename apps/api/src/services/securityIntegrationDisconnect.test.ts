/**
 * The disconnect service gates its own writes (#12691). The routes already
 * refuse a caller without full partner org access, but the integration rows
 * are partner-wide state, so the service refuses too: a future route that
 * forgot its gate still cannot clear a partner's credentials.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateMock } = vi.hoisted(() => ({ updateMock: vi.fn() }));

vi.mock('../db', () => ({
  db: { update: updateMock, select: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbTransactionIfHeld: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

import {
  clearS1SiteRegistrationTokens,
  disconnectHuntressIntegration,
  disconnectS1Integration,
} from './securityIntegrationDisconnect';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE, PartnerWideWriteDeniedError } from './partnerWideAccess';

const PARTNER = '11111111-1111-4111-8111-111111111111';
const INTEGRATION = '22222222-2222-4222-8222-222222222222';

function updateChain(rows: unknown[]) {
  const chain = {
    set: vi.fn(() => chain),
    where: vi.fn(() => chain),
    returning: vi.fn(async () => rows),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
  };
  return chain;
}

const selectedPartnerMember = { scope: 'partner', partnerOrgAccess: 'selected' } as const;
const orgUser = { scope: 'organization', partnerOrgAccess: null } as const;
const fullPartnerAdmin = { scope: 'partner', partnerOrgAccess: 'all' } as const;
const system = { scope: 'system', partnerOrgAccess: null } as const;

describe('securityIntegrationDisconnect write gate (#12691)', () => {
  beforeEach(() => {
    updateMock.mockReset();
    updateMock.mockImplementation(() => updateChain([{ id: INTEGRATION, partnerId: PARTNER, name: 'Vendor' }]));
  });

  describe.each([
    ['a partner member with selected-org access', selectedPartnerMember],
    ['an organization-scope user', orgUser],
  ])('refuses %s before any write', (_label, auth) => {
    it('disconnectS1Integration', async () => {
      await expect(disconnectS1Integration(auth, PARTNER)).rejects.toThrow(PartnerWideWriteDeniedError);
      expect(updateMock).not.toHaveBeenCalled();
    });

    it('disconnectHuntressIntegration', async () => {
      await expect(disconnectHuntressIntegration(auth, PARTNER)).rejects.toThrow(PARTNER_WIDE_WRITE_DENIED_MESSAGE);
      expect(updateMock).not.toHaveBeenCalled();
    });

    it('clearS1SiteRegistrationTokens', async () => {
      await expect(clearS1SiteRegistrationTokens(auth, INTEGRATION, PARTNER)).rejects.toThrow(PartnerWideWriteDeniedError);
      expect(updateMock).not.toHaveBeenCalled();
    });
  });

  describe.each([
    ['a full partner admin', fullPartnerAdmin],
    ['system scope', system],
  ])('lets %s write (control)', (_label, auth) => {
    it('disconnectS1Integration clears the integration row and then its site tokens', async () => {
      await expect(disconnectS1Integration(auth, PARTNER)).resolves.toEqual({ id: INTEGRATION, partnerId: PARTNER, name: 'Vendor' });
      expect(updateMock).toHaveBeenCalledTimes(2);
    });

    it('disconnectHuntressIntegration', async () => {
      await expect(disconnectHuntressIntegration(auth, PARTNER)).resolves.toEqual({ id: INTEGRATION, partnerId: PARTNER, name: 'Vendor' });
      expect(updateMock).toHaveBeenCalledTimes(1);
    });

    it('clearS1SiteRegistrationTokens', async () => {
      await expect(clearS1SiteRegistrationTokens(auth, INTEGRATION, PARTNER)).resolves.toBeUndefined();
      expect(updateMock).toHaveBeenCalledTimes(1);
    });
  });
});
