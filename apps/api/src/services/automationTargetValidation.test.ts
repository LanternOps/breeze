import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
}));

import { db } from '../db';
import { validateAutomationTargetConditions } from './automationTargetValidation';

const O1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const O2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const P1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';
const D1 = '33333333-3333-4333-8333-333333333333';
const D2 = '44444444-4444-4444-8444-444444444444';

const orgOwner = { orgId: O1, partnerId: null };
const partnerOwner = { orgId: null, partnerId: P1 };

function queueSelect(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }),
  } as never);
}

beforeEach(() => {
  vi.mocked(db.select).mockReset();
});

describe('validateAutomationTargetConditions', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a legacy condition array', [{ type: 'os', operator: 'is', value: 'windows' }]],
    ['an empty legacy array', []],
    ['an empty object', {}],
  ])('passes %s through untouched, with no DB read', async (_label, conditions) => {
    await expect(validateAutomationTargetConditions({ owner: orgOwner, conditions })).resolves.toEqual({ ok: true });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rejects an object whose type is unknown (it would otherwise target every device in the org)', async () => {
    const r = await validateAutomationTargetConditions({ owner: orgOwner, conditions: { type: 'gruops', groupIds: [G1] } });
    expect(r).toMatchObject({ ok: false, code: 'INVALID_TARGET' });
  });

  it('rejects an object with keys but no type', async () => {
    const r = await validateAutomationTargetConditions({ owner: orgOwner, conditions: { groupIds: [G1] } });
    expect(r).toMatchObject({ ok: false, code: 'INVALID_TARGET' });
  });

  it('rejects a non-object, non-array value', async () => {
    const r = await validateAutomationTargetConditions({ owner: orgOwner, conditions: 'groups' });
    expect(r).toMatchObject({ ok: false, code: 'INVALID_TARGET' });
  });

  it('rejects an empty groupIds list and a filter target without a filter', async () => {
    await expect(validateAutomationTargetConditions({ owner: orgOwner, conditions: { type: 'groups', groupIds: [] } }))
      .resolves.toMatchObject({ ok: false, code: 'INVALID_TARGET' });
    await expect(validateAutomationTargetConditions({ owner: orgOwner, conditions: { type: 'filter' } }))
      .resolves.toMatchObject({ ok: false, code: 'INVALID_TARGET' });
  });

  it('accepts an org-owned groups target whose groups are all in the owner org', async () => {
    queueSelect([{ id: G1, orgId: O1 }, { id: G2, orgId: O1 }]);
    await expect(validateAutomationTargetConditions({ owner: orgOwner, conditions: { type: 'groups', groupIds: [G1, G2] } }))
      .resolves.toEqual({ ok: true });
  });

  it('rejects a group from another org, naming it', async () => {
    queueSelect([{ id: G1, orgId: O1 }, { id: G2, orgId: O2 }]);
    const r = await validateAutomationTargetConditions({ owner: orgOwner, conditions: { type: 'groups', groupIds: [G1, G2] } });
    expect(r).toMatchObject({ ok: false, code: 'INVALID_TARGET', groupIds: [G2] });
  });

  it('rejects a nonexistent group with the same message as a cross-org one (no existence leak)', async () => {
    queueSelect([{ id: G1, orgId: O1 }]);
    const missing = await validateAutomationTargetConditions({ owner: orgOwner, conditions: { type: 'groups', groupIds: [G1, G2] } });
    queueSelect([{ id: G1, orgId: O1 }, { id: G2, orgId: O2 }]);
    const crossOrg = await validateAutomationTargetConditions({ owner: orgOwner, conditions: { type: 'groups', groupIds: [G1, G2] } });
    expect(missing).toEqual(crossOrg);
  });

  it('rejects a device from another org, or a missing one, naming it', async () => {
    queueSelect([{ id: D1, orgId: O1 }]);
    const r = await validateAutomationTargetConditions({ owner: orgOwner, conditions: { type: 'devices', deviceIds: [D1, D2] } });
    expect(r).toMatchObject({ ok: false, code: 'INVALID_TARGET', deviceIds: [D2] });
  });

  it('accepts an org-owned devices target in the owner org', async () => {
    queueSelect([{ id: D1, orgId: O1 }]);
    await expect(validateAutomationTargetConditions({ owner: orgOwner, conditions: { type: 'devices', deviceIds: [D1] } }))
      .resolves.toEqual({ ok: true });
  });

  it('rejects groups and devices targets on a partner-wide automation, steering to all/filter', async () => {
    const groups = await validateAutomationTargetConditions({ owner: partnerOwner, conditions: { type: 'groups', groupIds: [G1] } });
    const devices = await validateAutomationTargetConditions({ owner: partnerOwner, conditions: { type: 'devices', deviceIds: [D1] } });
    for (const r of [groups, devices]) {
      expect(r).toMatchObject({ ok: false, code: 'INVALID_TARGET' });
      expect(r.ok === false && r.error).toMatch(/partner-wide/i);
      expect(r.ok === false && r.error).toMatch(/all devices|filter/i);
    }
    expect(db.select).not.toHaveBeenCalled();
  });

  it('accepts all and filter targets on a partner-wide automation', async () => {
    await expect(validateAutomationTargetConditions({ owner: partnerOwner, conditions: { type: 'all' } }))
      .resolves.toEqual({ ok: true });
    await expect(validateAutomationTargetConditions({
      owner: partnerOwner,
      conditions: { type: 'filter', filter: { operator: 'AND', conditions: [{ field: 'osType', operator: 'equals', value: 'windows' }] } },
    })).resolves.toEqual({ ok: true });
  });
});
