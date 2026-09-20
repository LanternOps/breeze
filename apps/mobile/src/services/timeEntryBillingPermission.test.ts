import { describe, expect, it, vi } from 'vitest';
vi.mock('./api', () => ({ coreRequest: vi.fn() }));
import { coreRequest } from './api';
import { getTimeEntryBillingPermission } from './timeEntryBillingPermission';

describe('mobile billing permission lookup', () => {
  it('allows a human platform administrator without explicit role grants', async () => {
    vi.mocked(coreRequest).mockResolvedValue({ isPlatformAdmin: true, permissions: [] });
    await expect(getTimeEntryBillingPermission()).resolves.toBe(true);
  });

  it.each([
    [undefined, false],
    [[], false],
    [[{ resource: 'time_entries', action: 'write' }], false],
    [[{ resource: 'tickets', action: 'manage_billing' }], false],
    [[{ resource: 'time_entries', action: 'manage_billing' }], true],
    [[{ resource: 'time_entries', action: '*' }], true],
    [[{ resource: '*', action: '*' }], true],
  ])('checks effective grants %j => %s', async (permissions, expected) => {
    vi.mocked(coreRequest).mockResolvedValue({ permissions });
    await expect(getTimeEntryBillingPermission()).resolves.toBe(expected);
    expect(coreRequest).toHaveBeenCalledWith('/users/me');
  });
});
