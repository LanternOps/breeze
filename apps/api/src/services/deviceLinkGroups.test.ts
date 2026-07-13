/**
 * Unit tests for the link-group service helpers (#2138 multiboot, #2308
 * vm_host). The route suites mock this module entirely, so the kind-aware
 * dissolve rules — the load-bearing #2308 behavior — are proven here against a
 * fake DbExecutor. Real-DB coverage of the composite-FK ordering lives in
 * deviceLinkGroupsRls.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { captureException } from './sentry';

import {
  dissolveLinkGroupIfBelowMinimum,
  unlinkDevices,
  type DbExecutor,
} from './deviceLinkGroups';

interface ExecCalls {
  updateSets: Record<string, unknown>[];
  deletes: number;
  selects: number;
}

/**
 * Fake DbExecutor. Select #1 is the members query (awaited bare, projection
 * {id, role}); select #2 is the group-kind lookup (.limit(1)). Updates record
 * their .set() payloads; deletes are counted.
 */
function makeExec(
  members: Array<{ id: string; role: string | null }>,
  group: { kind: string } | undefined,
): { exec: DbExecutor; calls: ExecCalls } {
  const calls: ExecCalls = { updateSets: [], deletes: 0, selects: 0 };
  const exec = {
    select: () => {
      calls.selects += 1;
      const rows = calls.selects === 1 ? members : group ? [group] : [];
      const chain = {
        from: () => chain,
        where: () => chain,
        limit: () => Promise.resolve(rows),
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve(rows).then(res, rej),
      };
      return chain;
    },
    update: () => ({
      set: (s: Record<string, unknown>) => {
        calls.updateSets.push(s);
        return { where: () => Promise.resolve(undefined) };
      },
    }),
    delete: () => {
      calls.deletes += 1;
      return { where: () => Promise.resolve(undefined) };
    },
  } as unknown as DbExecutor;
  return { exec, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('unlinkDevices', () => {
  it('clears link_group_role together with link_group_id (#2308)', async () => {
    const { exec, calls } = makeExec([], undefined);
    await unlinkDevices(exec, ['dev-1', 'dev-2']);
    expect(calls.updateSets).toHaveLength(2);
    for (const set of calls.updateSets) {
      expect(set).toMatchObject({ linkGroupId: null, linkGroupRole: null });
    }
  });

  it('no-ops on an empty id list', async () => {
    const { exec, calls } = makeExec([], undefined);
    await unlinkDevices(exec, []);
    expect(calls.updateSets).toHaveLength(0);
  });
});

describe('dissolveLinkGroupIfBelowMinimum', () => {
  it('leaves a multiboot group at the minimum untouched (no group lookup needed beyond kind)', async () => {
    const { exec, calls } = makeExec(
      [
        { id: 'dev-1', role: null },
        { id: 'dev-2', role: null },
      ],
      { kind: 'multiboot' },
    );
    const dissolved = await dissolveLinkGroupIfBelowMinimum(exec, 'grp-1');
    expect(dissolved).toBe(false);
    expect(calls.updateSets).toHaveLength(0);
    expect(calls.deletes).toBe(0);
  });

  it('dissolves ANY kind that falls below the two-member minimum', async () => {
    const { exec, calls } = makeExec([{ id: 'dev-1', role: 'guest' }], { kind: 'vm_host' });
    const dissolved = await dissolveLinkGroupIfBelowMinimum(exec, 'grp-1');
    expect(dissolved).toBe(true);
    // The lone survivor is unlinked (role cleared too) before the group row
    // is deleted — the composite FK forbids the reverse order.
    expect(calls.updateSets).toHaveLength(1);
    expect(calls.updateSets[0]).toMatchObject({ linkGroupId: null, linkGroupRole: null });
    expect(calls.deletes).toBe(1);
  });

  it('keeps a vm_host group whose host is still a member (#2308)', async () => {
    const { exec, calls } = makeExec(
      [
        { id: 'dev-host', role: 'host' },
        { id: 'dev-vm1', role: 'guest' },
        { id: 'dev-vm2', role: 'guest' },
      ],
      { kind: 'vm_host' },
    );
    const dissolved = await dissolveLinkGroupIfBelowMinimum(exec, 'grp-vm');
    expect(dissolved).toBe(false);
    expect(calls.deletes).toBe(0);
  });

  it('dissolves a HEADLESS vm_host group — guests remain but the host is gone (#2308)', async () => {
    const { exec, calls } = makeExec(
      [
        { id: 'dev-vm1', role: 'guest' },
        { id: 'dev-vm2', role: 'guest' },
      ],
      { kind: 'vm_host' },
    );
    const dissolved = await dissolveLinkGroupIfBelowMinimum(exec, 'grp-vm');
    expect(dissolved).toBe(true);
    // Both guests unlinked, then the group row deleted.
    expect(calls.updateSets).toHaveLength(2);
    for (const set of calls.updateSets) {
      expect(set).toMatchObject({ linkGroupId: null, linkGroupRole: null });
    }
    expect(calls.deletes).toBe(1);
  });

  it('does NOT apply the headless rule to multiboot groups (peers never have a host)', async () => {
    const { exec, calls } = makeExec(
      [
        { id: 'dev-1', role: null },
        { id: 'dev-2', role: null },
        { id: 'dev-3', role: null },
      ],
      { kind: 'multiboot' },
    );
    const dissolved = await dissolveLinkGroupIfBelowMinimum(exec, 'grp-1');
    expect(dissolved).toBe(false);
    expect(calls.deletes).toBe(0);
  });

  it('reports a missing group row LOUDLY and does not invent a dissolve', async () => {
    // 2+ devices reference the group but its row is invisible. The composite
    // FK makes "deleted while referenced" unreachable, so this is corruption
    // or an RLS policy filtering the group row — surface it (console.error +
    // Sentry), return false, touch nothing.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { exec, calls } = makeExec(
      [
        { id: 'dev-1', role: null },
        { id: 'dev-2', role: null },
      ],
      undefined,
    );
    const dissolved = await dissolveLinkGroupIfBelowMinimum(exec, 'grp-1');
    expect(dissolved).toBe(false);
    expect(calls.deletes).toBe(0);
    expect(calls.updateSets).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('grp-1'));
    expect(vi.mocked(captureException)).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});
