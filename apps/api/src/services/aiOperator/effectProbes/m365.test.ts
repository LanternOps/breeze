/**
 * M365 arm of the effect-probe registry (Recipe Library M1 #6170).
 *
 * The adapter's job is narrow and every part of it is load-bearing:
 *   - keyed by TOOL name (the approved effect set is), one probe per tool in
 *     M365_HEADLESS_ACTIONS, and never a probe-only action id;
 *   - arguments rebuilt by the SAME typed builder the headless write uses and
 *     re-validated by the shared schema — a probe must observe exactly what the
 *     write would have written;
 *   - a strictly org-scoped db context per probe (the operator worker calls
 *     probes with no context, under which RLS hides the connection);
 *   - `observedAt` converted from the ISO string to a Date.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { M365_PROBE_ACTION_IDS } from '@breeze/shared/m365';
import type { PlannedEffect } from '../recipes/types';

const { probeM365Effect, withDbAccessContext, runOutsideDbContext } = vi.hoisted(() => ({
  probeM365Effect: vi.fn(),
  withDbAccessContext: vi.fn(),
  runOutsideDbContext: vi.fn(),
}));

vi.mock('../../m365ControlPlane/effectProbes', () => ({
  probeM365Effect: (...args: unknown[]) => probeM365Effect(...args),
}));
vi.mock('../../../db', () => ({
  withDbAccessContext: (ctx: unknown, fn: () => unknown) => withDbAccessContext(ctx, fn),
  runOutsideDbContext: (fn: () => unknown) => runOutsideDbContext(fn),
}));

import { __resetEffectProbesForTest, getEffectProbe, listProbedTools, probeEffect } from './index';
import { registerM365EffectProbes } from './m365';
import { M365_HEADLESS_ACTIONS } from '../../m365ToolsHeadless';

const ORG = '44444444-4444-4444-8444-444444444444';
const GROUP = '55555555-5555-4555-8555-555555555555';
const ctx = {
  orgId: ORG, taskId: 't1', planRevision: 1,
  effectRequestedAt: new Date('2026-10-16T12:00:00Z'), phase: 'post' as const,
};

function effect(toolName: string, canonicalArguments: Record<string, unknown>): PlannedEffect {
  return { ordinal: 0, toolName, provider: 'm365', targetId: null, accountExternalId: null, canonicalArguments };
}

beforeEach(() => {
  __resetEffectProbesForTest();
  probeM365Effect.mockReset();
  withDbAccessContext.mockReset().mockImplementation((_ctx: unknown, fn: () => unknown) => fn());
  runOutsideDbContext.mockReset().mockImplementation((fn: () => unknown) => fn());
});

describe('registerM365EffectProbes', () => {
  it('registers exactly one probe per headless M365 tool, and returns their names', () => {
    const names = registerM365EffectProbes();
    expect([...names].sort()).toEqual(Object.keys(M365_HEADLESS_ACTIONS).sort());
    expect(listProbedTools()).toEqual(Object.keys(M365_HEADLESS_ACTIONS).sort());
  });

  it('never registers a probe-only action id as a tool', () => {
    registerM365EffectProbes();
    for (const id of M365_PROBE_ACTION_IDS) expect(getEffectProbe(id)).toBeUndefined();
  });
});

describe('M365 effect probe adapter', () => {
  beforeEach(() => { registerM365EffectProbes(); });

  it('rebuilds the typed action from canonical arguments and converts observedAt to a Date', async () => {
    probeM365Effect.mockResolvedValue({ state: 'satisfied', observedAt: '2026-10-16T12:00:09.000Z', detail: 'not a member' });
    const result = await probeEffect(
      effect('m365_remove_from_group', { groupId: GROUP, userIdentifier: 'dana@customer.example', reason: 'offboarding' }),
      ctx,
    );
    expect(result).toEqual({ state: 'satisfied', observedAt: new Date('2026-10-16T12:00:09.000Z'), detail: 'not a member' });
    expect(probeM365Effect).toHaveBeenCalledWith(
      'm365.group.membership.remove',
      { type: 'm365.group.membership.remove', groupId: GROUP, userIdentifier: 'dana@customer.example', reason: 'offboarding' },
      { orgId: ORG, effectRequestedAt: ctx.effectRequestedAt },
    );
  });

  it('runs the probe inside a strictly org-scoped db context, outside any ambient one', async () => {
    probeM365Effect.mockResolvedValue({ state: 'unknown', observedAt: '2026-10-16T12:00:09.000Z', detail: 'x' });
    await probeEffect(effect('m365_disable_user', { userIdentifier: 'dana@customer.example', reason: 'x' }), ctx);
    expect(runOutsideDbContext).toHaveBeenCalledTimes(1);
    expect(withDbAccessContext).toHaveBeenCalledTimes(1);
    expect(withDbAccessContext.mock.calls[0]?.[0]).toMatchObject({
      scope: 'organization', orgId: ORG, accessibleOrgIds: [ORG],
    });
  });

  it('answers unknown — and never calls Graph — when the captured arguments do not form a valid action', async () => {
    const result = await probeEffect(effect('m365_remove_from_group', { groupId: 'not-a-guid', userIdentifier: 'x@y.z', reason: 'r' }), ctx);
    expect(result.state).toBe('unknown');
    expect(result.detail).toContain('m365_remove_from_group');
    expect(probeM365Effect).not.toHaveBeenCalled();
  });

  it('ignores extra canonical keys rather than forwarding them (the builder reads fields explicitly)', async () => {
    probeM365Effect.mockResolvedValue({ state: 'satisfied', observedAt: '2026-10-16T12:00:09.000Z', detail: 'ok' });
    await probeEffect(effect('m365_disable_user', { userIdentifier: 'dana@customer.example', reason: 'x', orgId: ORG, extra: 1 }), ctx);
    expect(probeM365Effect.mock.calls[0]?.[1]).toEqual({ type: 'm365.user.disable', userIdentifier: 'dana@customer.example', reason: 'x' });
  });
});
