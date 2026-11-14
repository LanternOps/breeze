import { beforeEach, describe, expect, it, vi } from 'vitest';

const insert = vi.hoisted(() => vi.fn());
vi.mock('../db', () => ({ db: { insert } }));

import { createDraftDeployment } from './deploymentWrites';
import { SiteCeilingWriteDeniedError } from './siteCeilingAccess';

const VALUES = {
  orgId: '00000000-0000-4000-8000-000000000001',
  name: 'Rollout',
  type: 'agent_update',
  payload: {},
  targetType: 'all',
  targetConfig: { type: 'all' },
  rolloutConfig: {},
  createdBy: '00000000-0000-4000-8000-000000000002',
};

beforeEach(() => { insert.mockReset(); });

describe('createDraftDeployment', () => {
  it.each([
    [{ scope: 'organization' as const, allowedSiteIds: ['site-1'] }],
    [{ scope: 'organization' as const, allowedSiteIds: [] }],
    [{ scope: 'organization' as const, allowedSiteIds: undefined, allowedDeviceIds: ['dev-1'] }],
  ])('refuses a restricted caller %j without inserting', async (auth) => {
    await expect(createDraftDeployment(auth, VALUES)).rejects.toBeInstanceOf(SiteCeilingWriteDeniedError);
    expect(insert).not.toHaveBeenCalled();
  });

  it('inserts a draft for an unrestricted caller', async () => {
    const values = vi.fn(() => ({ returning: () => Promise.resolve([{ id: 'dep-1' }]) }));
    insert.mockReturnValue({ values });
    await expect(createDraftDeployment({ scope: 'organization', allowedSiteIds: undefined }, VALUES)).resolves.toEqual({ id: 'dep-1' });
    expect(values).toHaveBeenCalledWith({ ...VALUES, status: 'draft' });
  });
});
