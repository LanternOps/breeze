/**
 * Full-control W18 PR B (#6789): the effect-digest pin of the four-eyes
 * `manage_org_portal_settings:set_sensitive_access` (Decision 2). The pin hashes
 * the org, the requested flags and the row's CURRENT sensitive, permission and
 * parent values, so an approval released after any of them changed refuses
 * (content_changed) and writes nothing. Mandatory per action (pinnedEffectPolicy.ts).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../db';
import { computeEffectDigestForRelease, computeEffectDigestOutcome, effectDigestResolverKey, requiresPinnedEffectDigest } from './effectDigest';
import { PORTAL_TOOL_SENSITIVE_KEYS } from '../portal/portalSensitiveParents';

const ORG = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const TOOL = 'manage_org_portal_settings';

const state: { row: Record<string, unknown> | undefined; selected: string[]; orgExists: boolean } = { row: undefined, selected: [], orgExists: true };
const database = {
  select: (cols: Record<string, unknown>) => {
    const orgLookup = Object.keys(cols).join() === 'id';
    if (!orgLookup) state.selected = Object.keys(cols);
    const rows = orgLookup ? (state.orgExists ? [{ id: ORG }] : []) : (state.row ? [state.row] : []);
    return { from: () => ({ where: () => ({ limit: async () => rows }) }) };
  },
} as unknown as Database;

const args = (flags: Record<string, boolean>, orgId = ORG) => ({ action: 'set_sensitive_access', orgId, flags });

async function pinned(input: Record<string, unknown>): Promise<string> {
  const outcome = await computeEffectDigestOutcome(TOOL, input, database);
  if (outcome.kind !== 'pinned') throw new Error(`not pinned: ${JSON.stringify(outcome)}`);
  return outcome.digest;
}

beforeEach(() => {
  state.row = undefined;
  state.selected = [];
  state.orgExists = true;
});

describe('manage_org_portal_settings:set_sensitive_access pin (#6789)', () => {
  it('is the only mandatory, resolvable action of the tool', () => {
    expect(requiresPinnedEffectDigest(TOOL, { action: 'set_sensitive_access' })).toBe(true);
    expect(effectDigestResolverKey(TOOL, 'set_sensitive_access')).toBe(`${TOOL}:set_sensitive_access`);
    // Control: the supervised update and the read stay unpinned.
    expect(requiresPinnedEffectDigest(TOOL, { action: 'update' })).toBe(false);
    expect(effectDigestResolverKey(TOOL, 'update')).toBeNull();
    expect(effectDigestResolverKey(TOOL, 'get')).toBeNull();
  });

  it('reads exactly the sensitive, permission and parent columns', async () => {
    await pinned(args({ enablePatchDetail: true }));
    expect(state.selected.sort()).toEqual([...PORTAL_TOOL_SENSITIVE_KEYS].sort());
  });

  it('a missing row pins as the defaults', async () => {
    const missing = await pinned(args({ enablePatchDetail: true }));
    state.row = Object.fromEntries(PORTAL_TOOL_SENSITIVE_KEYS.map((k) => [k, false]));
    expect(await pinned(args({ enablePatchDetail: true }))).toBe(missing);
  });

  it('release after drift refuses: a flag changed between pin and release gives another digest', async () => {
    state.row = { ...Object.fromEntries(PORTAL_TOOL_SENSITIVE_KEYS.map((k) => [k, false])) };
    const atApproval = await pinned(args({ enableNetworkVisibility: true, enableNetworkAlerts: true }));
    // Someone turns physical placement on in the meantime: enabling the parent would now show rack data too.
    state.row = { ...state.row, enablePhysicalPlacement: true };
    const atRelease = await computeEffectDigestForRelease(TOOL, args({ enableNetworkVisibility: true, enableNetworkAlerts: true }), database);
    expect(atRelease.digest).not.toBeNull();
    expect(atRelease.digest).not.toBe(atApproval);
    // Control: an unchanged row recomputes the same digest.
    state.row = { ...state.row, enablePhysicalPlacement: false };
    expect((await computeEffectDigestForRelease(TOOL, args({ enableNetworkVisibility: true, enableNetworkAlerts: true }), database)).digest).toBe(atApproval);
  });

  it('binds the org and the requested flags, independent of key order', async () => {
    const a = await pinned(args({ enablePatchDetail: true, enableHourBlock: false }));
    expect(await pinned(args({ enableHourBlock: false, enablePatchDetail: true }))).toBe(a);
    expect(await pinned(args({ enablePatchDetail: true, enableHourBlock: false }, ORG_B))).not.toBe(a);
    expect(await pinned(args({ enablePatchDetail: false, enableHourBlock: false }))).not.toBe(a);
  });

  it('a missing or deleted org does not pin (TARGET_ABSENT), so the mandatory pin refuses the intent', async () => {
    state.orgExists = false;
    state.row = Object.fromEntries(PORTAL_TOOL_SENSITIVE_KEYS.map((k) => [k, false]));
    expect(await computeEffectDigestOutcome(TOOL, args({ enablePatchDetail: true }), database))
      .toEqual({ kind: 'unresolved', reason: 'target_absent' });
  });

  it('a missing or malformed org or flags argument does not pin', async () => {
    expect(await computeEffectDigestOutcome(TOOL, { action: 'set_sensitive_access', flags: { enablePatchDetail: true } }, database))
      .toEqual({ kind: 'unresolved', reason: 'missing_arg' });
    expect(await computeEffectDigestOutcome(TOOL, { action: 'set_sensitive_access', orgId: ORG }, database))
      .toEqual({ kind: 'unresolved', reason: 'missing_arg' });
    expect(await computeEffectDigestOutcome(TOOL, { action: 'set_sensitive_access', orgId: 'not-a-uuid', flags: { enablePatchDetail: true } }, database))
      .toEqual({ kind: 'unresolved', reason: 'target_absent' });
    expect(await computeEffectDigestOutcome(TOOL, args({ enableTickets: true } as never), database))
      .toEqual({ kind: 'unresolved', reason: 'missing_arg' });
  });
});
