import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveMock, whereMock } = vi.hoisted(() => ({
  resolveMock: vi.fn(async (_deviceId: string) => [] as string[]),
  whereMock: vi.fn(async (_condition: unknown) => [] as Array<{ rules: unknown }>),
}));
vi.mock('./featureConfigResolver', () => ({ resolveSoftwarePoliciesForDevice: resolveMock }));
vi.mock('../db', () => ({ db: { select: () => ({ from: () => ({ where: whereMock }) }) } }));

import { getSoftwareBlocklistRulesForDevice } from './softwarePolicyConflicts';
import { PgDialect } from 'drizzle-orm/pg-core';

describe('software blocklist conflict scope', () => {
  beforeEach(() => vi.clearAllMocks());

  it('has no veto when no software policy reaches the device', async () => {
    expect(await getSoftwareBlocklistRulesForDevice('device-1')).toEqual([]);
    expect(whereMock).not.toHaveBeenCalled();
  });

  it('reads only active blocklists in the resolved additive policy set', async () => {
    resolveMock.mockResolvedValueOnce(['partner-allowlist', 'org-default-blocklist']);
    whereMock.mockResolvedValueOnce([{ rules: { software: [{ name: 'Prohibited*' }] } }]);
    expect(await getSoftwareBlocklistRulesForDevice('device-1')).toEqual([{ name: 'Prohibited*' }]);
    expect(resolveMock).toHaveBeenCalledWith('device-1');
    const query = new PgDialect().sqlToQuery(whereMock.mock.calls[0]![0] as Parameters<PgDialect['sqlToQuery']>[0]);
    expect(query.params).toEqual(['partner-allowlist', 'org-default-blocklist', true, 'blocklist']);
  });
});
