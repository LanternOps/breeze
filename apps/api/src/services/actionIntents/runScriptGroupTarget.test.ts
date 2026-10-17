import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

/**
 * #8600 (device-group targets W03) — the AI `run_script { groupId }` argument
 * is resolved to concrete device ids at INTENT CREATION, before the argument
 * digest is computed, so the approved set is the executed set. This file
 * covers the normalizer itself; `intentService.runScriptGroupTarget.test.ts`
 * covers its placement inside `createActionIntent`, and
 * `aiToolsScripts.runScript.groupTarget.test.ts` the handler's frozen release.
 */

const mocks = vi.hoisted(() => ({
  resolveScriptRunTargets: vi.fn(),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn(<T,>(fn: () => T): T => fn()),
  dbAccessContextFromAuth: vi.fn(() => ({ scope: 'organization' })),
}));

vi.mock('../scriptRunTargets', () => ({ resolveScriptRunTargets: mocks.resolveScriptRunTargets }));
vi.mock('../../db', () => ({
  withDbAccessContext: mocks.withDbAccessContext,
  runOutsideDbContext: mocks.runOutsideDbContext,
}));
vi.mock('../../middleware/auth', () => ({ dbAccessContextFromAuth: mocks.dbAccessContextFromAuth }));

import {
  normalizeRunScriptGroupTarget,
  RunScriptGroupTargetError,
  RUN_SCRIPT_AI_MAX_DEVICES,
  groupTargetIdsHash,
} from './runScriptGroupTarget';
import type { AuthContext } from '../../middleware/auth';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const GROUP = '33333333-3333-4333-8333-333333333333';
const SCRIPT = '44444444-4444-4444-8444-444444444444';
const dev = (n: number) => `dddddddd-dddd-4ddd-8ddd-${String(n).padStart(12, '0')}`;

function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    user: { id: 'user-1' },
    orgId: ORG_A,
    accessibleOrgIds: [ORG_A, ORG_B],
    canAccessOrg: (orgId: string) => [ORG_A, ORG_B].includes(orgId),
    ...overrides,
  } as unknown as AuthContext;
}

function okResolution(deviceIds: string[], orgId = ORG_A, warnings: string[] = []) {
  return {
    ok: true,
    deviceIds,
    warnings,
    resolvedGroups: [{ id: GROUP, orgId, memberCount: deviceIds.length, refused: false }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('normalizeRunScriptGroupTarget', () => {
  it('rewrites groupId to the resolved, sorted deviceIds and drops groupId from the arguments', async () => {
    mocks.resolveScriptRunTargets.mockResolvedValueOnce(okResolution([dev(3), dev(1), dev(2)]));
    const result = await normalizeRunScriptGroupTarget(makeAuth(), {
      scriptId: SCRIPT, groupId: GROUP, parameters: { a: 1 },
    }, ORG_A);

    expect(result.args).toEqual({ scriptId: SCRIPT, parameters: { a: 1 }, deviceIds: [dev(1), dev(2), dev(3)] });
    expect('groupId' in result.args).toBe(false);
    expect(result.group).toEqual({
      groupId: GROUP,
      count: 3,
      idsHash: groupTargetIdsHash([dev(1), dev(2), dev(3)]),
    });
    // The resolver ran under the caller's own DB context, never a bare pool.
    expect(mocks.runOutsideDbContext).toHaveBeenCalled();
    expect(mocks.withDbAccessContext).toHaveBeenCalled();
    expect(mocks.resolveScriptRunTargets).toHaveBeenCalledWith(expect.objectContaining({
      target: { type: 'groups', groupIds: [GROUP] },
    }));
  });

  it('describes the frozen set as count + short hash of the ids as of resolution', async () => {
    mocks.resolveScriptRunTargets.mockResolvedValueOnce(okResolution([dev(2), dev(1)]));
    const result = await normalizeRunScriptGroupTarget(makeAuth(), { scriptId: SCRIPT, groupId: GROUP }, ORG_A);
    const expectedHash = createHash('sha256').update([dev(1), dev(2)].join(',')).digest('hex').slice(0, 12);
    expect(result.group.idsHash).toBe(expectedHash);
    expect(result.note).toContain('2 devices');
    expect(result.note).toContain(expectedHash);
    expect(result.note).toContain(GROUP.slice(0, 8));
  });

  it('carries resolver warnings (refused groups, site exclusions) into the approval note', async () => {
    mocks.resolveScriptRunTargets.mockResolvedValueOnce(
      okResolution([dev(1)], ORG_A, ['2 device(s) in the selected group(s) are at sites outside your access and were excluded']),
    );
    const result = await normalizeRunScriptGroupTarget(makeAuth(), { scriptId: SCRIPT, groupId: GROUP }, ORG_A);
    expect(result.note).toContain('outside your access');
  });

  it(`rejects a group resolving above the AI cap (${RUN_SCRIPT_AI_MAX_DEVICES}) naming the count, never truncating`, async () => {
    const ids = Array.from({ length: 11 }, (_, i) => dev(i + 1));
    mocks.resolveScriptRunTargets.mockResolvedValueOnce(okResolution(ids));
    const err = await normalizeRunScriptGroupTarget(makeAuth(), { scriptId: SCRIPT, groupId: GROUP }, ORG_A)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunScriptGroupTargetError);
    expect((err as RunScriptGroupTargetError).code).toBe('group_target_too_large');
    expect((err as Error).message).toContain('11');
    expect((err as Error).message).toContain(String(RUN_SCRIPT_AI_MAX_DEVICES));
  });

  it('rejects a group above the route cap with the resolved count and the AI cap, never inheriting 500', async () => {
    mocks.resolveScriptRunTargets.mockResolvedValueOnce({
      ok: false, status: 400, code: 'TOO_MANY_TARGETS', error: 'above 500', count: 612,
    });
    const err = await normalizeRunScriptGroupTarget(makeAuth(), { scriptId: SCRIPT, groupId: GROUP }, ORG_A)
      .catch((e: unknown) => e) as RunScriptGroupTargetError;
    expect(err.code).toBe('group_target_too_large');
    expect(err.message).toContain('612');
    expect(err.message).toContain(String(RUN_SCRIPT_AI_MAX_DEVICES));
    expect(err.message).not.toContain('500');
  });

  it('accepts exactly the cap', async () => {
    const ids = Array.from({ length: RUN_SCRIPT_AI_MAX_DEVICES }, (_, i) => dev(i + 1));
    mocks.resolveScriptRunTargets.mockResolvedValueOnce(okResolution(ids));
    const result = await normalizeRunScriptGroupTarget(makeAuth(), { scriptId: SCRIPT, groupId: GROUP }, ORG_A);
    expect(result.args.deviceIds).toHaveLength(RUN_SCRIPT_AI_MAX_DEVICES);
  });

  it('refuses an empty group with the resolver message', async () => {
    mocks.resolveScriptRunTargets.mockResolvedValueOnce({
      ok: false, status: 400, code: 'NO_TARGETS', error: 'The requested device group(s) have no members; nothing was run', count: 0,
    });
    const err = await normalizeRunScriptGroupTarget(makeAuth(), { scriptId: SCRIPT, groupId: GROUP }, ORG_A)
      .catch((e: unknown) => e) as RunScriptGroupTargetError;
    expect(err.code).toBe('group_target_no_targets');
    expect(err.message).toContain('no members');
  });

  describe('org equality — one message for missing, inaccessible and other-org groups', () => {
    async function messageFor(resolution: unknown, intentOrg = ORG_A): Promise<string> {
      mocks.resolveScriptRunTargets.mockResolvedValueOnce(resolution);
      const err = await normalizeRunScriptGroupTarget(makeAuth(), { scriptId: SCRIPT, groupId: GROUP }, intentOrg)
        .catch((e: unknown) => e) as RunScriptGroupTargetError;
      expect(err).toBeInstanceOf(RunScriptGroupTargetError);
      expect(err.code).toBe('group_target_not_found');
      return err.message;
    }

    it('a group in another accessible org is refused exactly like a missing one', async () => {
      const missing = await messageFor({
        ok: false, status: 404, code: 'GROUP_NOT_FOUND', error: `Device group(s) not found or not accessible: ${GROUP}`, groupIds: [GROUP],
      });
      const otherOrg = await messageFor(okResolution([dev(1)], ORG_B), ORG_A);
      expect(otherOrg).toBe(missing);
    });

    it('a group resolving to devices in two orgs is refused (an intent is single-org)', async () => {
      const missing = await messageFor({
        ok: false, status: 404, code: 'GROUP_NOT_FOUND', error: 'x', groupIds: [GROUP],
      });
      const mixed = await messageFor({
        ok: true,
        deviceIds: [dev(1)],
        warnings: [],
        resolvedGroups: [
          { id: GROUP, orgId: ORG_A, memberCount: 1, refused: false },
          { id: GROUP, orgId: ORG_B, memberCount: 1, refused: false },
        ],
      });
      expect(mixed).toBe(missing);
    });
  });

  it('passes the caller site allowlist to the resolver', async () => {
    mocks.resolveScriptRunTargets.mockResolvedValueOnce(okResolution([dev(1)]));
    await normalizeRunScriptGroupTarget(makeAuth({ allowedSiteIds: ['site-1'] }), { scriptId: SCRIPT, groupId: GROUP }, ORG_A);
    expect(mocks.resolveScriptRunTargets).toHaveBeenCalledWith(expect.objectContaining({
      permissions: expect.objectContaining({ allowedSiteIds: ['site-1'] }),
    }));
  });

  it('passes no allowlist for an unrestricted caller', async () => {
    mocks.resolveScriptRunTargets.mockResolvedValueOnce(okResolution([dev(1)]));
    await normalizeRunScriptGroupTarget(makeAuth(), { scriptId: SCRIPT, groupId: GROUP }, ORG_A);
    expect(mocks.resolveScriptRunTargets.mock.calls[0]![0].permissions).toBeUndefined();
  });

  it('refuses a device-pinned caller whose group reaches past its pinned devices (no silent shrink)', async () => {
    mocks.resolveScriptRunTargets.mockResolvedValueOnce(okResolution([dev(1), dev(2)]));
    const err = await normalizeRunScriptGroupTarget(
      makeAuth({ allowedDeviceIds: [dev(1)] }), { scriptId: SCRIPT, groupId: GROUP }, ORG_A,
    ).catch((e: unknown) => e) as RunScriptGroupTargetError;
    expect(err.code).toBe('group_target_out_of_scope');
  });

  it('refuses both deviceIds and groupId together', async () => {
    const err = await normalizeRunScriptGroupTarget(
      makeAuth(), { scriptId: SCRIPT, groupId: GROUP, deviceIds: [dev(1)] }, ORG_A,
    ).catch((e: unknown) => e) as RunScriptGroupTargetError;
    expect(err.code).toBe('group_target_invalid');
    expect(mocks.resolveScriptRunTargets).not.toHaveBeenCalled();
  });

  it('refuses a malformed groupId before any read', async () => {
    const err = await normalizeRunScriptGroupTarget(
      makeAuth(), { scriptId: SCRIPT, groupId: 'not-a-uuid' }, ORG_A,
    ).catch((e: unknown) => e) as RunScriptGroupTargetError;
    expect(err.code).toBe('group_target_invalid');
    expect(mocks.resolveScriptRunTargets).not.toHaveBeenCalled();
  });
});
