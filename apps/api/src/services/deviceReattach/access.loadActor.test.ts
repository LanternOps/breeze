/**
 * #11702 — `loadReattachActor` reads the member's role grants INCLUDING
 * inherited ones (services/roleInheritance.ts), through the caller's executor.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../roleInheritance', () => ({
  getRolePermissionGrants: vi.fn(async () => []),
}));

import { canActorReattach, loadReattachActor } from './access';
import { getRolePermissionGrants } from '../roleInheritance';

const PARTNER = '00000000-0000-4000-8000-0000000000a9';
const ORG_A = '00000000-0000-4000-8000-0000000000a1';
const ORG_B = '00000000-0000-4000-8000-0000000000a2';
const ROLE = '00000000-0000-4000-8000-0000000000c1';

function makeExec(...queued: unknown[][]) {
  const rows = [...queued];
  const exec: any = {
    select: vi.fn(() => {
      const result: any = Promise.resolve(rows.shift() ?? []);
      for (const m of ['from', 'where', 'limit', 'innerJoin']) result[m] = vi.fn(() => result);
      return result;
    }),
  };
  return exec;
}

const queueActor = () => makeExec(
  [{ id: 'user-1', status: 'active', partnerId: PARTNER }],
  [{ roleId: ROLE, orgAccess: 'all', orgIds: null }],
  [{ id: ORG_A }, { id: ORG_B }],
);

describe('loadReattachActor role grants (#11702)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the role grants through the resolver with the passed executor, honouring inherited grants', async () => {
    const exec = queueActor();
    vi.mocked(getRolePermissionGrants).mockResolvedValueOnce([
      { resource: 'devices', action: 'write' },
      { resource: 'devices', action: 'delete' },
    ]);

    const actor = await loadReattachActor(exec, 'user-1', PARTNER);

    expect(getRolePermissionGrants).toHaveBeenCalledWith(ROLE, exec);
    expect(actor?.membership?.grants).toEqual([
      { resource: 'devices', action: 'write' },
      { resource: 'devices', action: 'delete' },
    ]);
    expect(canActorReattach(actor!, {
      partnerId: PARTNER, sourceOrgId: ORG_A, sourceParked: false, targetOrgId: ORG_B,
    })).toEqual({ allowed: true, fullAdmin: true });
  });

  it('still refuses when the resolved grants lack devices:delete', async () => {
    const exec = queueActor();
    vi.mocked(getRolePermissionGrants).mockResolvedValueOnce([{ resource: 'devices', action: 'write' }]);

    const actor = await loadReattachActor(exec, 'user-1', PARTNER);

    expect(canActorReattach(actor!, {
      partnerId: PARTNER, sourceOrgId: ORG_A, sourceParked: false, targetOrgId: ORG_B,
    }).allowed).toBe(false);
  });
});
