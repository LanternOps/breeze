import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ visible: [] as string[], queries: 0, partnerForOrg: 'p-1' as string | null }));

vi.mock('../../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          state.queries++;
          return Promise.resolve(state.visible.map((id) => ({ id })));
        },
      }),
    }),
  },
}));

vi.mock('../patches/helpers', () => ({
  resolvePartnerIdForOrg: vi.fn(async () => state.partnerForOrg),
}));

import { YARA_MAX_RULE_SETS_PER_POLICY } from '@breeze/shared';
import { checkSecurityRuleSetsWrite } from './securityRuleSetGate';

const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const ORG_OWNER = { orgId: 'org-1', partnerId: null };
const PARTNER_OWNER = { orgId: null, partnerId: 'p-1' };

beforeEach(() => {
  state.visible = [];
  state.queries = 0;
  state.partnerForOrg = 'p-1';
});

describe('checkSecurityRuleSetsWrite', () => {
  it('passes settings that do not mention ruleSetIds, or an empty list, without a query', async () => {
    await expect(checkSecurityRuleSetsWrite(ORG_OWNER, { autoQuarantine: false })).resolves.toEqual({ ok: true });
    await expect(checkSecurityRuleSetsWrite(ORG_OWNER, { ruleSetIds: [] })).resolves.toEqual({ ok: true });
    await expect(checkSecurityRuleSetsWrite(ORG_OWNER, null)).resolves.toEqual({ ok: true });
    expect(state.queries).toBe(0);
  });

  it('rejects a non-array, a non-UUID entry, and more than the per-policy max (400)', async () => {
    await expect(checkSecurityRuleSetsWrite(ORG_OWNER, { ruleSetIds: A })).resolves.toMatchObject({ ok: false, status: 400 });
    await expect(checkSecurityRuleSetsWrite(ORG_OWNER, { ruleSetIds: [A, 'nope'] })).resolves.toMatchObject({ ok: false, status: 400 });
    const tooMany = Array.from({ length: YARA_MAX_RULE_SETS_PER_POLICY + 1 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    await expect(checkSecurityRuleSetsWrite(ORG_OWNER, { ruleSetIds: tooMany })).resolves.toMatchObject({ ok: false, status: 400 });
    expect(state.queries).toBe(0);
  });

  it('accepts sets the policy owner may attach', async () => {
    state.visible = [A, B];
    await expect(checkSecurityRuleSetsWrite(ORG_OWNER, { ruleSetIds: [A, B.toUpperCase()] })).resolves.toEqual({ ok: true });
  });

  it('rejects any set the owner may not attach, naming it (400)', async () => {
    state.visible = [A];
    const res = await checkSecurityRuleSetsWrite(PARTNER_OWNER, { ruleSetIds: [A, B] });
    expect(res).toMatchObject({ ok: false, status: 400, body: { code: 'YARA_RULE_SET_NOT_ATTACHABLE', ruleSetIds: [B] } });
  });

  it('an org policy whose org has no partner can still attach (own org + built-in branch only)', async () => {
    state.partnerForOrg = null;
    state.visible = [A];
    await expect(checkSecurityRuleSetsWrite(ORG_OWNER, { ruleSetIds: [A] })).resolves.toEqual({ ok: true });
  });
});
