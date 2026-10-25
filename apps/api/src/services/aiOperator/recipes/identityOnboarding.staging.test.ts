/**
 * THE STAGING AND GRANT SAFETY CONTRACT (spec §6.3, §6.4, §9(b), §11; W07
 * Amendment B.9 item 4).
 *
 * Properties over ONE cross-product of inputs × planning snapshots:
 *
 *   P1 DISJOINT STAGES, BY SECRECY. Every create-stage tool is secret-bearing
 *      and no provision-stage tool is, asserted against the SHIPPED
 *      `isSecretBearingTool` (what plan approval and intent creation
 *      consult), for both catalogs and for every plan in every case. So no
 *      tool can appear in both stages, and each stage's approval is a
 *      single-secrecy-kind set: a credential can never ride in on a
 *      provisioning approval. (The plan's separate P2 "pure kinds" is folded
 *      in here, B.9 item 4.)
 *
 *   P3 NO PRIVILEGE. No known-dynamic or role-assignable M365 group, and no
 *      Google group the model-after person owns or manages, is ever a planned
 *      effect — and each one requested has a manual item, so the work is
 *      never silently dropped. Every `google_add_to_group` pins MEMBER.
 *
 *   P4 NO PLACEHOLDER IDENTIFIER. Every provisioning effect is addressed by
 *      the RESOLVED account, an M365 argument never carries the UPN (spec
 *      §5.2), and a stage-2 snapshot with no resolved account plans nothing.
 *
 *   P5 STAGE SEPARATION. `buildPlan` on a stage-1 snapshot never contains a
 *      provisioning tool, and on a stage-2 snapshot never a create tool.
 *
 * The cross-product is the point: the bugs these guard against appear only
 * when some providers are absent, some groups are privileged, some seats are
 * gone and the dense renumbering shifts everything.
 *
 * Discrimination is proved by MUTATION (Task 4 Step 2), recorded in the
 * commit: (1) delete the M365 group-refusal filter in the provision builder →
 * P3 red; (2) add `m365_create_user` to the provision catalog and emit it →
 * P1 and P5 red; (3) address M365 provisioning by the input UPN instead of
 * the resolved id → P4 red.
 */
import { describe, expect, it } from 'vitest';
import type { IdentityOnboardingInput } from '@breeze/shared';
import { isSecretBearingTool } from '../../actionIntents/secretBearingTools';
import {
  IDENTITY_ONBOARDING_CREATE_TOOLS,
  IDENTITY_ONBOARDING_EFFECT_TOOLS,
  IDENTITY_ONBOARDING_PROVISION_TOOLS,
  buildIdentityOnboardingCreatePlan,
  buildIdentityOnboardingManualWork,
  buildIdentityOnboardingProvisionPlan,
  identityOnboardingRecipe,
} from './identityOnboarding';

const SKU = '18181a46-0d4e-45cd-891e-60aabd171b4e';
const G_OK = 'aaaaaaaa-0000-4000-8000-000000000001';
const G_DYN = 'aaaaaaaa-0000-4000-8000-000000000002';
const G_ROLE = 'aaaaaaaa-0000-4000-8000-000000000003';
const CONTACT_TARGET = '00000000-0000-4000-8000-0000000000c1';
const UPN = 'priya@customer.example';
const M365_ID = 'obj-1111';
const GOOGLE_ID = '900100';
const GOOGLE_LABEL = 'priya@customer.example';

const M365_BLOCK = {
  userPrincipalName: UPN, mailNickname: 'priya', usageLocation: 'CA', skuIds: [SKU], groupIds: [G_OK, G_DYN, G_ROLE],
};
const GOOGLE_BLOCK = {
  primaryEmail: UPN, givenName: 'Priya', familyName: 'Raman', orgUnitPath: '/Staff/Finance',
  licenses: [{ productId: 'Google-Apps', skuId: '1010020020' }],
  groupEmails: ['all@customer.example', 'fin@customer.example'],
};

function parse(over: Record<string, unknown>): IdentityOnboardingInput {
  return identityOnboardingRecipe.inputSchema.parse({
    displayName: 'Priya Raman', m365: M365_BLOCK, google: GOOGLE_BLOCK, ...over,
  });
}

const PRIVILEGED_M365 = new Set([G_DYN, G_ROLE]);
const M365_GROUPS = [
  { id: G_OK, name: 'Finance', dynamic: false, roleAssignable: null },
  { id: G_DYN, name: 'Dynamic All', dynamic: true, roleAssignable: null },
  { id: G_ROLE, name: 'Helpdesk Admins', dynamic: false, roleAssignable: true },
];
const GOOGLE_GROUPS = [
  { email: 'all@customer.example', name: 'All Staff', modelAfterRole: 'MEMBER' },
  { email: 'fin@customer.example', name: 'Finance', modelAfterRole: null },
];
const GOOGLE_GROUPS_OWNED = [
  { email: 'all@customer.example', name: 'All Staff', modelAfterRole: 'MEMBER' },
  { email: 'fin@customer.example', name: 'Finance', modelAfterRole: 'OWNER' },
];
const seat = (state: string, available: number | null) => ({
  m365: [{ skuId: SKU, skuPartNumber: 'STANDARDPACK', state, available, observedAt: '2026-10-01T09:00:00.000Z',
    reason: state === 'unknown' ? 'read refused' : null }],
});
const CLEAR = { m365: { upnTaken: false, existingObjectId: null }, google: { emailTaken: false, existingUserId: null } };

type Facts = Record<string, unknown>;
function stage1(over: Facts = {}): Facts {
  return {
    stage: 'create',
    targets: { contactTargetId: CONTACT_TARGET, contactLabel: 'Priya Raman' },
    collisions: CLEAR,
    seats: seat('available', 12),
    groups: { m365: M365_GROUPS, google: GOOGLE_GROUPS },
    modelAfter: null,
    degradedTools: [],
    capabilityReadiness: {},
    flags: [],
    truncated: [],
    ...over,
  };
}
const BOTH = {
  m365: { externalId: M365_ID, principalLabel: UPN },
  google: { externalId: GOOGLE_ID, principalLabel: GOOGLE_LABEL },
};
function stage2(over: Facts = {}): Facts {
  return { ...stage1(), stage: 'provision', accounts: BOTH, ...over };
}

function factSets(): Array<[string, Facts]> {
  return [
    ['s1 clear', stage1()],
    ['s1 upn taken', stage1({ collisions: { ...CLEAR, m365: { upnTaken: true, existingObjectId: 'obj-9999' } } })],
    ['s1 upn unchecked', stage1({ collisions: { ...CLEAR, m365: { upnTaken: null, existingObjectId: null } } })],
    ['s1 google email taken', stage1({ collisions: { ...CLEAR, google: { emailTaken: true, existingUserId: '777' } } })],
    ['s1 create degraded', stage1({ degradedTools: ['m365_create_user'] })],
    ['s2 resolved both', stage2()],
    ['s2 resolved m365 only', stage2({ accounts: { ...BOTH, google: null } })],
    ['s2 resolved google only', stage2({ accounts: { ...BOTH, m365: null } })],
    ['s2 resolved none', stage2({ accounts: { m365: null, google: null } })],
    ['s2 no free seat', stage2({ seats: seat('unavailable', 0) })],
    ['s2 seat unknown', stage2({ seats: seat('unknown', null) })],
    ['s2 model-after owns a google group', stage2({ groups: { m365: M365_GROUPS, google: GOOGLE_GROUPS_OWNED } })],
    ['s2 provisioning degraded', stage2({ degradedTools: ['google_move_ou', 'm365_assign_license'] })],
  ];
}

function inputSets(): Array<[string, Record<string, unknown>]> {
  return [
    ['both providers', {}],
    ['m365 only', { google: null }],
    ['google only', { m365: null }],
    ['no grants at all', {
      m365: { ...M365_BLOCK, skuIds: [], groupIds: [] },
      google: { ...GOOGLE_BLOCK, licenses: [], groupEmails: [], orgUnitPath: null },
    }],
    ['with a start date', { startAt: '2026-10-05T13:00:00.000Z' }],
    ['only privileged m365 groups requested', { m365: { ...M365_BLOCK, groupIds: [G_DYN, G_ROLE] } }],
  ];
}

interface Case { name: string; input: IdentityOnboardingInput; facts: Facts; stage: 'create' | 'provision' }
function cases(): Case[] {
  const out: Case[] = [];
  for (const [fn, f] of factSets()) {
    for (const [inName, i] of inputSets()) {
      out.push({ name: `${fn} / ${inName}`, input: parse(i), facts: f, stage: f.stage as Case['stage'] });
    }
  }
  return out;
}
const ALL = cases();
const STAGE1 = ALL.filter((c) => c.stage === 'create');
const STAGE2 = ALL.filter((c) => c.stage === 'provision');
const CREATE_SET = new Set<string>(IDENTITY_ONBOARDING_CREATE_TOOLS);
const PROVISION_SET = new Set<string>(IDENTITY_ONBOARDING_PROVISION_TOOLS);

/** The stage's own builder: a create builder never sees stage-2 facts and vice versa. */
function stagePlan(c: Case) {
  return c.stage === 'create'
    ? buildIdentityOnboardingCreatePlan(c.input, c.facts)
    : buildIdentityOnboardingProvisionPlan(c.input, c.facts);
}

describe('the cross-product is the size it claims (a 0-case run is a stall, not a pass)', () => {
  it('has 78 cases, 30 at stage 1 and 48 at stage 2', () => {
    expect(ALL).toHaveLength(78);
    expect(STAGE1).toHaveLength(30);
    expect(STAGE2).toHaveLength(48);
  });
});

describe('P1 — the two stages are DISJOINT, by secrecy (B.9 item 4)', () => {
  it('every create-catalog tool is secret-bearing and no provision-catalog tool is', () => {
    for (const t of IDENTITY_ONBOARDING_CREATE_TOOLS) expect(isSecretBearingTool(t), t).toBe(true);
    for (const t of IDENTITY_ONBOARDING_PROVISION_TOOLS) expect(isSecretBearingTool(t), t).toBe(false);
    for (const t of IDENTITY_ONBOARDING_CREATE_TOOLS) expect(PROVISION_SET.has(t), t).toBe(false);
    expect(new Set(IDENTITY_ONBOARDING_EFFECT_TOOLS).size).toBe(IDENTITY_ONBOARDING_EFFECT_TOOLS.length);
    expect(IDENTITY_ONBOARDING_EFFECT_TOOLS.length).toBe(CREATE_SET.size + PROVISION_SET.size);
  });

  for (const c of ALL) {
    it(`holds for ${c.name}`, () => {
      for (const e of stagePlan(c)) {
        expect(isSecretBearingTool(e.toolName), `${e.toolName} at stage ${c.stage}`).toBe(c.stage === 'create');
      }
    });
  }

  it('the control: the assertion is discriminating, not vacuous', () => {
    // Without this, a create plan that emitted nothing would satisfy P1 everywhere.
    const c = ALL.find((x) => x.name === 's1 clear / both providers')!;
    const created = stagePlan(c);
    expect(created.length).toBeGreaterThan(0);
    expect(isSecretBearingTool(created[0]!.toolName)).toBe(true);
    const p = stagePlan(ALL.find((x) => x.name === 's2 resolved both / both providers')!);
    expect(p.length).toBeGreaterThan(0);
    expect(p.some((e) => isSecretBearingTool(e.toolName))).toBe(false);
  });
});

describe('P3 — NO PRIVILEGED GROUP is ever a planned effect, and none is silently dropped', () => {
  for (const c of STAGE2) {
    it(`holds for ${c.name}`, () => {
      const plan = stagePlan(c);
      const m365Added = plan.filter((e) => e.toolName === 'm365_add_to_group')
        .map((e) => (e.canonicalArguments as { groupId: string }).groupId);
      for (const gid of m365Added) expect(PRIVILEGED_M365.has(gid), `planned privileged ${gid}`).toBe(false);

      const google = (c.facts.groups as { google: Array<{ email: string; modelAfterRole: string | null }> }).google;
      const owned = new Set(google.filter((g) => g.modelAfterRole === 'OWNER' || g.modelAfterRole === 'MANAGER').map((g) => g.email));
      const googleAdded = plan.filter((e) => e.toolName === 'google_add_to_group')
        .map((e) => (e.canonicalArguments as { groupEmail: string }).groupEmail);
      for (const em of googleAdded) expect(owned.has(em), `planned owned ${em}`).toBe(false);
      for (const e of plan.filter((x) => x.toolName === 'google_add_to_group')) {
        expect(e.canonicalArguments).toMatchObject({ role: 'MEMBER' });
      }

      const items = new Set(buildIdentityOnboardingManualWork(c.input, c.facts, {}, []).map((i) => i.key));
      for (const gid of c.input.m365?.groupIds ?? []) {
        if (PRIVILEGED_M365.has(gid)) expect(items.has(`manual_group_add:${gid}`), `no item for ${gid}`).toBe(true);
      }
      for (const em of c.input.google?.groupEmails ?? []) {
        if (owned.has(em)) expect(items.has(`manual_group_add:${em}`), `no item for ${em}`).toBe(true);
      }
    });
  }

  it('the control: a non-privileged group IS planned, so P3 is not passing on an empty plan', () => {
    const plan = stagePlan(ALL.find((x) => x.name === 's2 resolved both / both providers')!);
    expect(plan.filter((e) => e.toolName === 'm365_add_to_group')
      .map((e) => (e.canonicalArguments as { groupId: string }).groupId)).toEqual([G_OK]);
  });
});

describe('P4 — NO PLACEHOLDER IDENTIFIER, ever (spec §5.2)', () => {
  for (const c of STAGE2) {
    it(`holds for ${c.name}`, () => {
      const accounts = c.facts.accounts as { m365: { externalId: string } | null; google: { externalId: string; principalLabel: string } | null };
      const plan = stagePlan(c);
      if (accounts.m365 === null && accounts.google === null) {
        expect(plan).toEqual([]);
        return;
      }
      for (const e of plan) {
        const args = e.canonicalArguments as Record<string, unknown>;
        if (e.provider === 'm365') {
          expect(accounts.m365, 'an M365 effect with no resolved M365 account').not.toBeNull();
          expect(e.accountExternalId).toBe(accounts.m365!.externalId);
          expect(args.userIdentifier).toBe(accounts.m365!.externalId);
          // The UPN must NEVER address an M365 provisioning effect.
          expect(JSON.stringify(args)).not.toContain(UPN);
        }
        if (e.provider === 'google') {
          expect(accounts.google, 'a Google effect with no resolved Google account').not.toBeNull();
          expect(e.accountExternalId).toBe(accounts.google!.externalId);
          // Google's tools address by primary email by design; it must be the RESOLVED account's.
          expect(args.userEmail).toBe(accounts.google!.principalLabel);
        }
        expect(e.targetId).toBe(CONTACT_TARGET);
      }
    });
  }

  it('the control: a stage-2 plan with resolved accounts is non-empty and carries M365 effects', () => {
    const plan = stagePlan(ALL.find((x) => x.name === 's2 resolved both / both providers')!);
    expect(plan.some((e) => e.provider === 'm365')).toBe(true);
    expect(stagePlan(ALL.find((x) => x.name === 's2 resolved none / both providers')!)).toEqual([]);
  });
});

describe('P5 — a plan never crosses its snapshot\'s stage', () => {
  for (const c of ALL) {
    it(`holds for ${c.name}`, () => {
      const names = identityOnboardingRecipe.buildPlan(c.input, c.facts).map((e) => e.toolName);
      const forbidden = c.stage === 'create' ? PROVISION_SET : CREATE_SET;
      for (const n of names) expect(forbidden.has(n), `${n} planned from a stage-${c.stage} snapshot`).toBe(false);
      expect(identityOnboardingRecipe.buildPlan(c.input, c.facts)).toEqual(stagePlan(c));
    });
  }

  it('the control: each stage produces its own tools somewhere in the product', () => {
    expect(STAGE1.some((c) => identityOnboardingRecipe.buildPlan(c.input, c.facts).length > 0)).toBe(true);
    expect(STAGE2.some((c) => identityOnboardingRecipe.buildPlan(c.input, c.facts).length > 0)).toBe(true);
  });
});

describe('the catalog is closed and the ordinals are dense, for every case', () => {
  for (const c of ALL) {
    it(`holds for ${c.name}`, () => {
      const plan = stagePlan(c);
      expect(plan.map((e) => e.ordinal)).toEqual(plan.map((_, i) => i));
      for (const e of plan) expect(IDENTITY_ONBOARDING_EFFECT_TOOLS).toContain(e.toolName);
    });
  }
});
