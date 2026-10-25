/**
 * The `identity_onboarding` recipe, at the pure level (W07 R2a Task 3;
 * Amendment B1, B2, B4).
 *
 * Everything asserted here is a property of DATA: the twelve-step spine, the
 * per-step snapshot map, the strict facts contract, the two plan builders and
 * the `facts.stage` dispatch between them, the per-provider strict-`false`
 * collision gate, the closed effect catalog, the privileged-group filter and
 * the manual-work list. Nothing here touches a database, a provider or a
 * clock.
 *
 * The STAGING PROPERTY (the two plans never overlap, each is one secrecy kind,
 * no privileged group survives) lives in `identityOnboarding.staging.test.ts`,
 * over a cross-product.
 */
import { describe, expect, it } from 'vitest';
import type { IdentityOnboardingInput } from '@breeze/shared';
import { buildTaskOperationKey } from '../operationKey';
import { HELPDESK_ALLOWLIST_CAPABILITY } from './capabilityMap';
import { EFFECT_PROVIDER_ORDER, MANUAL_WORK_MAX_ITEMS } from './identityOffboarding';
import {
  IDENTITY_ONBOARDING_BOUNDS,
  IDENTITY_ONBOARDING_CAPABILITIES,
  IDENTITY_ONBOARDING_CREATE_TOOLS,
  IDENTITY_ONBOARDING_EFFECT_TOOLS,
  IDENTITY_ONBOARDING_PROMPT_VERSION,
  IDENTITY_ONBOARDING_PROVISION_TOOLS,
  IDENTITY_ONBOARDING_STEP_KEYS,
  IDENTITY_ONBOARDING_UNOBSERVABLE_EFFECTS,
  IDENTITY_ONBOARDING_WORKFLOW_KEY,
  IDENTITY_ONBOARDING_WORKFLOW_VERSION,
  ONBOARDING_CAPABILITY_FOR_TOOL,
  buildIdentityOnboardingCreatePlan,
  buildIdentityOnboardingManualWork,
  buildIdentityOnboardingProvisionPlan,
  buildManualCreateGoogleItem,
  capOnboardingManualWork,
  identityOnboardingFactsSchema,
  identityOnboardingRecipe,
} from './identityOnboarding';
import * as onboardingModule from './identityOnboarding';
import { recipeDataProblems } from './index';
import { resolveDeterministicNextStep } from './resolveNextStep';
import type { AnyRecipeDefinition } from './types';

const SKU_A = '18181a46-0d4e-45cd-891e-60aabd171b4e';
const SKU_B = '05e9a617-0261-4cee-bb44-138d3ef5d965';
const GRP_OK = 'aaaaaaaa-0000-4000-8000-000000000001';
const GRP_DYN = 'aaaaaaaa-0000-4000-8000-000000000002';
const GRP_ROLE = 'aaaaaaaa-0000-4000-8000-000000000003';
const GRP_UNREAD = 'aaaaaaaa-0000-4000-8000-000000000004';
const CONTACT_TARGET = '00000000-0000-4000-8000-0000000000c1';
const UPN = 'priya@customer.example';
const recipe = identityOnboardingRecipe as unknown as AnyRecipeDefinition;

function input(over: Record<string, unknown> = {}): IdentityOnboardingInput {
  return identityOnboardingRecipe.inputSchema.parse({
    displayName: 'Priya Raman',
    m365: {
      userPrincipalName: UPN,
      mailNickname: 'priya',
      usageLocation: 'CA',
      skuIds: [SKU_A],
      groupIds: [GRP_OK, GRP_DYN, GRP_ROLE],
    },
    google: {
      primaryEmail: UPN,
      givenName: 'Priya',
      familyName: 'Raman',
      orgUnitPath: '/Staff/Finance',
      licenses: [{ productId: 'Google-Apps', skuId: '1010020020' }],
      groupEmails: ['all@customer.example', 'fin@customer.example'],
    },
    ...over,
  });
}

/** Snapshot 1 (`discover`): collisions clear, one seat free. */
function createFacts(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stage: 'create',
    targets: { contactTargetId: CONTACT_TARGET, contactLabel: 'Priya Raman' },
    collisions: {
      m365: { upnTaken: false, existingObjectId: null },
      google: { emailTaken: false, existingUserId: null },
    },
    seats: {
      m365: [{
        skuId: SKU_A, skuPartNumber: 'STANDARDPACK', state: 'available', available: 12,
        observedAt: '2026-10-01T09:00:00.000Z', reason: null,
      }],
    },
    groups: {
      m365: [
        { id: GRP_OK, name: 'Finance', dynamic: false, roleAssignable: null },
        { id: GRP_DYN, name: 'Dynamic All', dynamic: true, roleAssignable: null },
        { id: GRP_ROLE, name: 'Helpdesk Admins', dynamic: false, roleAssignable: true },
      ],
      google: [
        { email: 'all@customer.example', name: 'All Staff', modelAfterRole: 'MEMBER' },
        { email: 'fin@customer.example', name: 'Finance', modelAfterRole: null },
      ],
    },
    modelAfter: null,
    degradedTools: [],
    capabilityReadiness: {},
    flags: [],
    truncated: [],
    ...over,
  };
}

/** Snapshot 2 (`resolve_accounts`): snapshot 1 + stage + both resolved accounts. */
function provisionFacts(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...createFacts(),
    stage: 'provision',
    accounts: {
      m365: { externalId: 'obj-1111', principalLabel: UPN },
      google: { externalId: '900100', principalLabel: UPN },
    },
    ...over,
  };
}

const ALL_READY: Record<string, boolean> = Object.fromEntries(
  IDENTITY_ONBOARDING_CAPABILITIES.map((c) => [c.key, true]),
);
const keysOf = (items: readonly { key: string }[]) => items.map((i) => i.key);
const toolsOf = (plan: readonly { toolName: string }[]) => plan.map((e) => e.toolName);

describe('recipe identity', () => {
  it('declares its key, version, prompt version and the deterministic gate class', () => {
    expect(IDENTITY_ONBOARDING_WORKFLOW_KEY).toBe('identity_onboarding');
    expect(identityOnboardingRecipe.key).toBe(IDENTITY_ONBOARDING_WORKFLOW_KEY);
    expect(identityOnboardingRecipe.version).toBe(IDENTITY_ONBOARDING_WORKFLOW_VERSION);
    expect(IDENTITY_ONBOARDING_WORKFLOW_VERSION).toBe(1);
    expect(identityOnboardingRecipe.promptVersion).toBe(IDENTITY_ONBOARDING_PROMPT_VERSION);
    expect(IDENTITY_ONBOARDING_PROMPT_VERSION).toBe('identity_onboarding/v1');
    expect(identityOnboardingRecipe.gateClass).toBe('deterministic');
  });

  it('targets a contact and a ticket, never a device', () => {
    expect([...identityOnboardingRecipe.targetKinds].sort()).toEqual(['contact', 'ticket']);
  });

  it('carries spec §6.7 bounds — 14 days, 6 reasoning runs, 2 mutation attempts', () => {
    expect(IDENTITY_ONBOARDING_BOUNDS.deadlineMs).toBe(14 * 24 * 60 * 60 * 1000);
    expect(IDENTITY_ONBOARDING_BOUNDS.maxReasoningRuns).toBe(6);
    expect(IDENTITY_ONBOARDING_BOUNDS.maxMutationAttempts).toBe(2);
    expect(identityOnboardingRecipe.bounds).toBe(IDENTITY_ONBOARDING_BOUNDS);
  });

  it('declares NO unobservable effect, and that is an assertion not an omission (D-R2-11)', () => {
    expect(IDENTITY_ONBOARDING_UNOBSERVABLE_EFFECTS).toEqual({});
    expect(Object.isFrozen(IDENTITY_ONBOARDING_UNOBSERVABLE_EFFECTS)).toBe(true);
    expect(identityOnboardingRecipe.unobservableEffects).toBe(IDENTITY_ONBOARDING_UNOBSERVABLE_EFFECTS);
  });

  it('does NOT export ONBOARDING_DEGRADABLE_REFUSALS — dispatch-time degradation is not built (Amendment Task 12, Q3)', () => {
    expect(Object.hasOwn(onboardingModule, 'ONBOARDING_DEGRADABLE_REFUSALS')).toBe(false);
  });

  it('has consistent recipe data: recipeDataProblems is empty', () => {
    expect(recipeDataProblems(recipe)).toEqual([]);
  });
});

describe('the step graph (Amendment B1)', () => {
  it('declares exactly the twelve spine steps, in order, with account creation before provisioning', () => {
    expect([...IDENTITY_ONBOARDING_STEP_KEYS]).toEqual([
      'intake', 'confirm_details', 'discover', 'review', 'create_accounts',
      'manual_create_google', 'resolve_accounts', 'provision_effects', 'wait_start',
      'manual_work', 'verify_outcome', 'document',
    ]);
    expect(Object.keys(identityOnboardingRecipe.steps)).toEqual([...IDENTITY_ONBOARDING_STEP_KEYS]);
    const at = (k: string) => IDENTITY_ONBOARDING_STEP_KEYS.indexOf(k as never);
    expect(at('create_accounts')).toBeLessThan(at('resolve_accounts'));
    expect(at('resolve_accounts')).toBeLessThan(at('provision_effects'));
  });

  it('assigns each step the kind B1 names — two effect steps, no approval steps', () => {
    const kinds = Object.fromEntries(
      Object.entries(identityOnboardingRecipe.steps).map(([k, s]) => [k, s.kind]),
    );
    expect(kinds).toEqual({
      intake: 'reason',
      confirm_details: 'human_work',
      discover: 'probe',
      review: 'reason',
      create_accounts: 'effect',
      manual_create_google: 'human_work',
      resolve_accounts: 'probe',
      provision_effects: 'effect',
      wait_start: 'wait',
      manual_work: 'human_work',
      verify_outcome: 'probe',
      document: 'document',
    });
    expect(Object.keys(identityOnboardingRecipe.steps)).not.toContain('create_approval');
    expect(Object.keys(identityOnboardingRecipe.steps)).not.toContain('plan_approval');
    expect(Object.keys(identityOnboardingRecipe.steps)).not.toContain('handover_work');
  });

  it('enters at intake and makes `document` the only terminal step', () => {
    expect(identityOnboardingRecipe.entryStepKey).toBe('intake');
    expect(Object.entries(identityOnboardingRecipe.steps).filter(([, s]) => s.terminal).map(([k]) => k))
      .toEqual(['document']);
  });

  it('lets the model propose ONLY out of the two reason steps, and only forward', () => {
    expect(identityOnboardingRecipe.permittedNextSteps).toEqual({
      intake: ['confirm_details'],
      review: ['create_accounts'],
    });
  });

  it('CANNOT REACH `discover` WITHOUT `confirm_details` — the mandatory human confirmation', () => {
    const namesDiscover = Object.entries(identityOnboardingRecipe.steps)
      .filter(([, s]) => s.next === 'discover').map(([k]) => k);
    expect(namesDiscover).toEqual(['confirm_details']);
    for (const permitted of Object.values(identityOnboardingRecipe.permittedNextSteps)) {
      expect(permitted).not.toContain('discover');
    }
  });

  it('attaches the two reason-output schemas to the steps the model proposes INTO', () => {
    expect(identityOnboardingRecipe.steps.confirm_details!.inputSchema).toBeDefined();
    expect(identityOnboardingRecipe.steps.create_accounts!.inputSchema).toBeDefined();
    for (const k of ['intake', 'discover', 'review', 'resolve_accounts', 'provision_effects', 'manual_work']) {
      expect(identityOnboardingRecipe.steps[k]!.inputSchema, k).toBeUndefined();
    }
  });

  const next = (from: string, i: IdentityOnboardingInput, facts: Record<string, unknown>) =>
    resolveDeterministicNextStep(recipe, from, { input: i, facts, readiness: {} });

  it('walks the fixed edges', () => {
    const i = input();
    expect(next('intake', i, {})).toEqual({ ok: true, key: 'confirm_details' });
    expect(next('confirm_details', i, {})).toEqual({ ok: true, key: 'discover' });
    expect(next('discover', i, createFacts())).toEqual({ ok: true, key: 'review' });
    expect(next('review', i, createFacts())).toEqual({ ok: true, key: 'create_accounts' });
    expect(next('manual_create_google', i, createFacts())).toEqual({ ok: true, key: 'resolve_accounts' });
    expect(next('resolve_accounts', i, createFacts())).toEqual({ ok: true, key: 'provision_effects' });
    expect(next('wait_start', i, provisionFacts())).toEqual({ ok: true, key: 'manual_work' });
    expect(next('manual_work', i, provisionFacts())).toEqual({ ok: true, key: 'verify_outcome' });
    expect(next('verify_outcome', i, provisionFacts())).toEqual({ ok: true, key: 'document' });
    expect(next('document', i, provisionFacts()).ok).toBe(false);
  });

  it('opens manual_create_google only when Google is in scope AND snapshot 1 said the email is strictly free (B1)', () => {
    expect(next('create_accounts', input(), createFacts())).toEqual({ ok: true, key: 'manual_create_google' });
    expect(next('create_accounts', input({ google: null }), createFacts()))
      .toEqual({ ok: true, key: 'resolve_accounts' });
    for (const emailTaken of [true, null]) {
      const facts = createFacts({
        collisions: { m365: { upnTaken: false, existingObjectId: null }, google: { emailTaken, existingUserId: null } },
      });
      expect(next('create_accounts', input(), facts), `emailTaken=${String(emailTaken)}`)
        .toEqual({ ok: true, key: 'resolve_accounts' });
    }
    // No facts at all is never read as "free".
    expect(next('create_accounts', input(), {})).toEqual({ ok: true, key: 'resolve_accounts' });
  });

  it('takes wait_start only when a startAt was given', () => {
    expect(next('provision_effects', input(), provisionFacts())).toEqual({ ok: true, key: 'manual_work' });
    expect(next('provision_effects', input({ startAt: '2026-10-05T13:00:00.000Z' }), provisionFacts()))
      .toEqual({ ok: true, key: 'wait_start' });
  });
});

describe('per-step planning snapshots (Amendment B2)', () => {
  it('plans stage 1 from `discover`', () => {
    expect(identityOnboardingRecipe.planningSnapshotStepKey).toBe('discover');
  });

  it('maps every consumer step to its snapshot exactly as B2 lists them', () => {
    expect(identityOnboardingRecipe.planningSnapshotStepFor).toEqual({
      review: 'discover',
      create_accounts: 'discover',
      manual_create_google: 'discover',
      resolve_accounts: 'discover',
      provision_effects: 'resolve_accounts',
      wait_start: 'resolve_accounts',
      manual_work: 'resolve_accounts',
      verify_outcome: 'resolve_accounts',
      document: 'resolve_accounts',
    });
  });

  it('names no snapshot for the three steps that run BEFORE or AS snapshot 1 (a load there fails closed)', () => {
    // intake and confirm_details run before discover writes snapshot 1, and
    // discover writes it rather than reading it. A load at any of them is
    // `snapshot_step_unmapped`, never a fallback (B2: the map is total for
    // every step that plans; these three do not plan).
    for (const k of ['intake', 'confirm_details', 'discover']) {
      expect(Object.hasOwn(identityOnboardingRecipe.planningSnapshotStepFor!, k), k).toBe(false);
    }
  });
});

describe('the strict facts contract (B2 "Strict facts")', () => {
  it('parses both stages', () => {
    expect(identityOnboardingFactsSchema.parse(createFacts()).stage).toBe('create');
    expect(identityOnboardingFactsSchema.parse(provisionFacts()).stage).toBe('provision');
  });

  it('refuses an unknown key, a missing stage, a stage-1 envelope carrying accounts and a stage-2 one without', () => {
    expect(identityOnboardingFactsSchema.safeParse({ ...createFacts(), extra: 1 }).success).toBe(false);
    const { stage: _stage, ...noStage } = createFacts();
    expect(identityOnboardingFactsSchema.safeParse(noStage).success).toBe(false);
    expect(identityOnboardingFactsSchema.safeParse({ ...createFacts(), accounts: { m365: null, google: null } }).success)
      .toBe(false);
    const { accounts: _accounts, ...noAccounts } = provisionFacts();
    expect(identityOnboardingFactsSchema.safeParse(noAccounts).success).toBe(false);
  });

  it('round-trips through JSON (facts ride a jsonb column)', () => {
    for (const f of [createFacts(), provisionFacts()]) {
      const parsed = identityOnboardingFactsSchema.parse(f);
      expect(identityOnboardingFactsSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    }
  });

  it('buildPlan THROWS on malformed facts — never an empty plan', () => {
    for (const bad of [{}, { stage: 'create' }, { ...createFacts(), stage: 'other' }, { ...createFacts(), targets: {} },
      { ...createFacts(), collisions: { m365: { upnTaken: 'no', existingObjectId: null }, google: null } }]) {
      expect(() => identityOnboardingRecipe.buildPlan(input(), bad), JSON.stringify(bad).slice(0, 60)).toThrow(/identity_onboarding/);
    }
  });

  it('refuses a stage-2 account for a provider whose snapshot-1 collision check was not strictly clear (B.0 item 13)', () => {
    for (const upnTaken of [true, null]) {
      const facts = provisionFacts({
        collisions: { m365: { upnTaken, existingObjectId: 'obj-9999' }, google: { emailTaken: false, existingUserId: null } },
      });
      expect(() => identityOnboardingRecipe.buildPlan(input(), facts), String(upnTaken)).toThrow(/collision/);
    }
    const google = provisionFacts({
      collisions: { m365: { upnTaken: false, existingObjectId: null }, google: { emailTaken: true, existingUserId: '777' } },
    });
    expect(() => identityOnboardingRecipe.buildPlan(input(), google)).toThrow(/collision/);
  });

  it('each builder refuses the other stage\'s facts', () => {
    expect(() => buildIdentityOnboardingCreatePlan(input(), provisionFacts())).toThrow(/stage/);
    expect(() => buildIdentityOnboardingProvisionPlan(input(), createFacts())).toThrow(/stage/);
  });
});

describe('buildPlan dispatches on facts.stage, never on "any resolved account" (B2)', () => {
  it('stage create → the create plan', () => {
    expect(identityOnboardingRecipe.buildPlan(input(), createFacts()))
      .toEqual(buildIdentityOnboardingCreatePlan(input(), createFacts()));
    expect(toolsOf(identityOnboardingRecipe.buildPlan(input(), createFacts()))).toEqual(['m365_create_user']);
  });

  it('stage provision → the provision plan', () => {
    expect(identityOnboardingRecipe.buildPlan(input(), provisionFacts()))
      .toEqual(buildIdentityOnboardingProvisionPlan(input(), provisionFacts()));
  });

  it('a stage-2 envelope with NO resolved account is still stage 2: an empty plan, never a create', () => {
    const facts = provisionFacts({ accounts: { m365: null, google: null } });
    expect(identityOnboardingRecipe.buildPlan(input(), facts)).toEqual([]);
  });
});

describe('buildIdentityOnboardingCreatePlan — stage 1', () => {
  it('takes TWO parameters (B4)', () => {
    expect(buildIdentityOnboardingCreatePlan.length).toBe(2);
    expect(buildIdentityOnboardingProvisionPlan.length).toBe(2);
  });

  it('emits exactly one m365_create_user effect, its arguments from input only', () => {
    const plan = buildIdentityOnboardingCreatePlan(input(), createFacts());
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ ordinal: 0, toolName: 'm365_create_user', provider: 'm365' });
    expect(plan[0]!.canonicalArguments).toEqual({
      userPrincipalName: UPN,
      displayName: 'Priya Raman',
      mailNickname: 'priya',
      usageLocation: 'CA',
      reason: 'Onboarding Priya Raman (Breeze Operator task).',
    });
  });

  it('addresses the contact TARGET ROW and no account (B4): targetId from facts, accountExternalId null', () => {
    const [e] = buildIdentityOnboardingCreatePlan(input(), createFacts());
    expect(e!.targetId).toBe(CONTACT_TARGET);
    expect(e!.accountExternalId).toBeNull();
  });

  it('plans the create ONLY when collisions.m365.upnTaken === false, strictly (B1)', () => {
    const at = (m365: unknown) => buildIdentityOnboardingCreatePlan(input(), createFacts({
      collisions: { m365, google: { emailTaken: false, existingUserId: null } },
    }));
    expect(toolsOf(at({ upnTaken: false, existingObjectId: null }))).toEqual(['m365_create_user']);
    expect(at({ upnTaken: true, existingObjectId: 'obj-9999' })).toEqual([]);
    // null means "could not check", which is NOT clear.
    expect(at({ upnTaken: null, existingObjectId: null })).toEqual([]);
    // A missing M365 collision record is not clear either.
    expect(at(null)).toEqual([]);
  });

  it('a GOOGLE collision never affects the M365 create (B.0 item 12)', () => {
    for (const emailTaken of [true, null]) {
      const plan = buildIdentityOnboardingCreatePlan(input(), createFacts({
        collisions: { m365: { upnTaken: false, existingObjectId: null }, google: { emailTaken, existingUserId: '777' } },
      }));
      expect(toolsOf(plan), String(emailTaken)).toEqual(['m365_create_user']);
    }
  });

  it('emits NOTHING when M365 is not in scope — Google creation is human work (D-R2-3)', () => {
    expect(buildIdentityOnboardingCreatePlan(input({ m365: null }), createFacts())).toEqual([]);
    expect([...IDENTITY_ONBOARDING_CREATE_TOOLS]).toEqual(['m365_create_user']);
  });

  it('emits nothing when m365_create_user is in the frozen degraded set', () => {
    expect(buildIdentityOnboardingCreatePlan(input(), createFacts({ degradedTools: ['m365_create_user'] }))).toEqual([]);
  });

  it('emits no licence, group or OU effect', () => {
    const names = toolsOf(buildIdentityOnboardingCreatePlan(input(), createFacts()));
    for (const t of IDENTITY_ONBOARDING_PROVISION_TOOLS) expect(names).not.toContain(t);
  });

  it('does not read seats, groups or model-after facts: changing them changes nothing', () => {
    const plain = buildIdentityOnboardingCreatePlan(input(), createFacts());
    const other = buildIdentityOnboardingCreatePlan(input(), createFacts({
      seats: { m365: [] }, groups: { m365: [], google: [] },
    }));
    expect(other).toEqual(plain);
  });
});

describe('buildIdentityOnboardingProvisionPlan — stage 2', () => {
  const plan = buildIdentityOnboardingProvisionPlan(input(), provisionFacts());
  const names = toolsOf(plan);

  it('emits the expected effects in provider order and table order', () => {
    expect(names).toEqual([
      'google_move_ou', 'google_assign_license', 'google_add_to_group', 'google_add_to_group',
      'm365_assign_license', 'm365_add_to_group',
    ]);
    expect([...EFFECT_PROVIDER_ORDER]).toEqual(['google', 'm365']);
  });

  it('numbers ordinals densely from 0', () => {
    expect(plan.map((e) => e.ordinal)).toEqual(plan.map((_, i) => i));
  });

  it('every emitted tool is in the closed provisioning catalog, and the full catalog is the six tools', () => {
    for (const n of names) expect(IDENTITY_ONBOARDING_PROVISION_TOOLS).toContain(n);
    expect([...IDENTITY_ONBOARDING_EFFECT_TOOLS]).toEqual([
      'm365_create_user',
      'google_move_ou', 'google_assign_license', 'google_add_to_group',
      'm365_assign_license', 'm365_add_to_group',
    ]);
  });

  it('emits no create effect', () => {
    expect(names).not.toContain('m365_create_user');
  });

  it('addresses M365 by the IMMUTABLE external id, never the UPN, in metadata AND arguments', () => {
    for (const e of plan.filter((x) => x.provider === 'm365')) {
      expect(e.accountExternalId).toBe('obj-1111');
      expect(e.canonicalArguments).toMatchObject({ userIdentifier: 'obj-1111' });
      expect(JSON.stringify(e.canonicalArguments)).not.toContain(UPN);
    }
  });

  it('addresses Google by the resolved account (id in metadata, frozen primary email in arguments)', () => {
    for (const e of plan.filter((x) => x.provider === 'google')) {
      expect(e.accountExternalId).toBe('900100');
      expect(e.canonicalArguments).toMatchObject({ userEmail: UPN });
    }
  });

  it('pins the contact target row as targetId on every effect (B4)', () => {
    for (const e of plan) expect(e.targetId).toBe(CONTACT_TARGET);
  });

  it('assigns every available M365 SKU in ONE effect', () => {
    const facts = provisionFacts({
      seats: {
        m365: [SKU_A, SKU_B].map((skuId) => ({
          skuId, skuPartNumber: skuId === SKU_A ? 'STANDARDPACK' : 'ENTERPRISEPACK', state: 'available', available: 3,
          observedAt: '2026-10-01T09:00:00.000Z', reason: null,
        })),
      },
    });
    const p = buildIdentityOnboardingProvisionPlan(input({
      m365: { userPrincipalName: UPN, mailNickname: 'priya', usageLocation: 'CA', skuIds: [SKU_A, SKU_B], groupIds: [] },
    }), facts);
    expect(toolsOf(p).filter((n) => n === 'm365_assign_license')).toHaveLength(1);
    expect(p.find((e) => e.toolName === 'm365_assign_license')!.canonicalArguments)
      .toMatchObject({ userIdentifier: 'obj-1111', skuIds: [SKU_A, SKU_B] });
  });

  it('plans ONLY SKUs whose seat state is `available`; every other state is omitted (B6)', () => {
    for (const state of ['unavailable', 'not_subscribed', 'unknown'] as const) {
      const facts = provisionFacts({
        seats: { m365: [{ skuId: SKU_A, skuPartNumber: 'STANDARDPACK', state, available: state === 'unavailable' ? 0 : null,
          observedAt: '2026-10-01T09:00:00.000Z', reason: state === 'unknown' ? 'read refused' : null }] },
      });
      const p = buildIdentityOnboardingProvisionPlan(input(), facts);
      expect(toolsOf(p), state).not.toContain('m365_assign_license');
      expect(p.map((e) => e.ordinal)).toEqual(p.map((_, i) => i));
    }
    // A requested SKU with no seat fact at all is not planned either.
    const none = buildIdentityOnboardingProvisionPlan(input(), provisionFacts({ seats: { m365: [] } }));
    expect(toolsOf(none)).not.toContain('m365_assign_license');
  });

  it('orders the M365 group adds AFTER the M365 licence assignment (Amendment Task 7)', () => {
    const lic = names.indexOf('m365_assign_license');
    const firstAdd = names.indexOf('m365_add_to_group');
    expect(lic).toBeGreaterThanOrEqual(0);
    expect(firstAdd).toBeGreaterThan(lic);
  });

  it('filters KNOWN-dynamic groups and role-assignable-true groups; plans roleAssignable: null (B.0 item 15)', () => {
    const planned = plan.filter((e) => e.toolName === 'm365_add_to_group')
      .map((e) => (e.canonicalArguments as { groupId: string }).groupId);
    expect(planned).toEqual([GRP_OK]); // GRP_OK has roleAssignable: null
    expect(planned).not.toContain(GRP_DYN);
    expect(planned).not.toContain(GRP_ROLE);
  });

  it('does not plan a requested M365 group discovery never described', () => {
    const p = buildIdentityOnboardingProvisionPlan(input({
      m365: { userPrincipalName: UPN, mailNickname: 'priya', usageLocation: 'CA', skuIds: [], groupIds: [GRP_OK, GRP_UNREAD] },
    }), provisionFacts());
    expect(p.filter((e) => e.toolName === 'm365_add_to_group')
      .map((e) => (e.canonicalArguments as { groupId: string }).groupId)).toEqual([GRP_OK]);
  });

  it('PINS role: MEMBER on every google_add_to_group effect (D-R2-9)', () => {
    const adds = plan.filter((x) => x.toolName === 'google_add_to_group');
    expect(adds).toHaveLength(2);
    for (const e of adds) expect(e.canonicalArguments).toMatchObject({ role: 'MEMBER' });
  });

  it('does not plan a Google group the model-after person owns or manages', () => {
    const facts = provisionFacts({
      groups: {
        m365: [],
        google: [
          { email: 'all@customer.example', name: 'All Staff', modelAfterRole: 'MEMBER' },
          { email: 'fin@customer.example', name: 'Finance', modelAfterRole: 'OWNER' },
        ],
      },
    });
    const added = buildIdentityOnboardingProvisionPlan(input(), facts)
      .filter((e) => e.toolName === 'google_add_to_group')
      .map((e) => (e.canonicalArguments as { groupEmail: string }).groupEmail);
    expect(added).toEqual(['all@customer.example']);
  });

  it('fans Google licences out one effect per (productId, skuId) pair', () => {
    expect(plan.find((x) => x.toolName === 'google_assign_license')!.canonicalArguments)
      .toMatchObject({ userEmail: UPN, productId: 'Google-Apps', skuId: '1010020020' });
  });

  it('emits google_move_ou only when an orgUnitPath was given', () => {
    expect(plan.find((e) => e.toolName === 'google_move_ou')!.canonicalArguments)
      .toMatchObject({ userEmail: UPN, orgUnitPath: '/Staff/Finance' });
    const noOu = buildIdentityOnboardingProvisionPlan(
      input({ google: { primaryEmail: UPN, givenName: 'P', familyName: 'R' } }), provisionFacts(),
    );
    expect(toolsOf(noOu)).not.toContain('google_move_ou');
  });

  it('omits a provider whose account did not resolve, and keeps the other', () => {
    const m365Only = buildIdentityOnboardingProvisionPlan(input(), provisionFacts({
      accounts: { m365: { externalId: 'obj-1111', principalLabel: UPN }, google: null },
    }));
    expect(m365Only.length).toBeGreaterThan(0);
    expect(m365Only.every((e) => e.provider === 'm365')).toBe(true);
  });

  it('skips a provider block the technician never enabled, even with an account in the facts', () => {
    const p = buildIdentityOnboardingProvisionPlan(input({ google: null }), provisionFacts());
    expect(p.every((e) => e.provider === 'm365')).toBe(true);
  });

  it('filters the frozen degraded set and renumbers densely', () => {
    const p = buildIdentityOnboardingProvisionPlan(input(), provisionFacts({ degradedTools: ['google_move_ou', 'm365_assign_license'] }));
    expect(toolsOf(p)).toEqual(['google_assign_license', 'google_add_to_group', 'google_add_to_group', 'm365_add_to_group']);
    expect(p.map((e) => e.ordinal)).toEqual([0, 1, 2, 3]);
  });

  it('is DETERMINISTIC and frozen', () => {
    expect(buildIdentityOnboardingProvisionPlan(input(), provisionFacts())).toEqual(plan);
    for (const e of plan) expect(Object.isFrozen(e.canonicalArguments)).toBe(true);
  });
});

describe('required capabilities (spec §4.1)', () => {
  it('names a capability for every tool in the catalog (derived via capabilityForTool)', () => {
    for (const tool of IDENTITY_ONBOARDING_EFFECT_TOOLS) {
      expect(ONBOARDING_CAPABILITY_FOR_TOOL[tool], `no capability mapped for ${tool}`).toBeTruthy();
      expect(IDENTITY_ONBOARDING_CAPABILITIES.map((c) => c.key)).toContain(ONBOARDING_CAPABILITY_FOR_TOOL[tool]);
    }
    expect(Object.values(ONBOARDING_CAPABILITY_FOR_TOOL)).not.toContain(HELPDESK_ALLOWLIST_CAPABILITY);
  });

  it('declares google.account.create as the ONLY always_manual capability, gating no tool (D-R2-3)', () => {
    expect(IDENTITY_ONBOARDING_CAPABILITIES.filter((c) => c.availability === 'always_manual').map((c) => c.key))
      .toEqual(['google.account.create']);
    const cap = IDENTITY_ONBOARDING_CAPABILITIES.find((c) => c.key === 'google.account.create')!;
    expect(cap.kind).toBe('tool_source');
    expect(cap.toolNames).toBeUndefined();
  });

  it('declares the helpdesk allowlist umbrella naming EVERY effect tool', () => {
    const cap = IDENTITY_ONBOARDING_CAPABILITIES.find((c) => c.key === HELPDESK_ALLOWLIST_CAPABILITY);
    expect(cap).toBeDefined();
    expect([...cap!.toolNames!].sort()).toEqual([...IDENTITY_ONBOARDING_EFFECT_TOOLS].sort());
  });

  it('is the recipe requires list', () => {
    expect(identityOnboardingRecipe.requires).toBe(IDENTITY_ONBOARDING_CAPABILITIES);
  });
});

describe('buildManualCreateGoogleItem — the manual_create_google step\'s instructions', () => {
  it('names the exact account to create and is tied to google.account.create', () => {
    const item = buildManualCreateGoogleItem(input(), createFacts())!;
    expect(item.key).toBe('create_google_account');
    expect(item.origin).toBe('capability');
    expect(item.capabilityKey).toBe('google.account.create');
    expect(item.detail).toContain(UPN);
    expect(item.detail).toContain('/Staff/Finance');
    expect(item.detail).toContain('Priya');
    expect(item.detail).toContain('Raman');
  });

  it('is null when Google is out of scope or snapshot 1 did not say the email is strictly free', () => {
    expect(buildManualCreateGoogleItem(input({ google: null }), createFacts())).toBeNull();
    for (const emailTaken of [true, null]) {
      expect(buildManualCreateGoogleItem(input(), createFacts({
        collisions: { m365: { upnTaken: false, existingObjectId: null }, google: { emailTaken, existingUserId: null } },
      }))).toBeNull();
    }
  });
});

describe('buildIdentityOnboardingManualWork (spec §6.5)', () => {
  it('always emits the four handover items', () => {
    expect(keysOf(buildIdentityOnboardingManualWork(input(), provisionFacts(), ALL_READY, [])))
      .toEqual(expect.arrayContaining(['credential_handover', 'assign_hardware', 'enroll_mfa', 'update_documentation']));
  });

  it('never repeats the Google account-creation item (it is its own step)', () => {
    expect(keysOf(buildIdentityOnboardingManualWork(input(), provisionFacts(), ALL_READY, [])))
      .not.toContain('create_google_account');
  });

  it('the credential item names neither the credential nor its carrier key', () => {
    const item = buildIdentityOnboardingManualWork(input(), provisionFacts(), ALL_READY, [])
      .find((i) => i.key === 'credential_handover')!;
    expect(item.detail).not.toMatch(/temporaryPassword/);
    expect(item.detail).not.toMatch(/Temporary password:\s*\S/);
  });

  it('a taken UPN → resolve_upn_collision:<upn> naming the existing object id', () => {
    const facts = createFacts({
      collisions: { m365: { upnTaken: true, existingObjectId: 'obj-9999' }, google: { emailTaken: false, existingUserId: null } },
    });
    const item = buildIdentityOnboardingManualWork(input(), facts, ALL_READY, [])
      .find((i) => i.key === `resolve_upn_collision:${UPN}`);
    expect(item).toBeDefined();
    expect(item!.detail).toContain('obj-9999');
  });

  it('an unchecked UPN → collision_check_failed:m365; an unchecked email → collision_check_failed:google', () => {
    const facts = createFacts({
      collisions: { m365: { upnTaken: null, existingObjectId: null }, google: { emailTaken: null, existingUserId: null } },
    });
    const keys = keysOf(buildIdentityOnboardingManualWork(input(), facts, ALL_READY, []));
    expect(keys).toContain('collision_check_failed:m365');
    expect(keys).toContain('collision_check_failed:google');
    expect(keys.some((k) => k.startsWith('resolve_upn_collision:'))).toBe(false);
  });

  it('a taken Google email → resolve_email_collision:<email> naming the existing id, and no M365 collision item', () => {
    const facts = createFacts({
      collisions: { m365: { upnTaken: false, existingObjectId: null }, google: { emailTaken: true, existingUserId: '777' } },
    });
    const items = buildIdentityOnboardingManualWork(input(), facts, ALL_READY, []);
    const item = items.find((i) => i.key === `resolve_email_collision:${UPN}`);
    expect(item).toBeDefined();
    expect(item!.detail).toContain('777');
    expect(keysOf(items).some((k) => k.startsWith('resolve_upn_collision:') || k === 'collision_check_failed:m365')).toBe(false);
  });

  it('emits a manual_license item for every requested SKU that was not planned, naming the reason', () => {
    for (const [state, expectWord] of [['unavailable', 'seat'], ['not_subscribed', 'subscri'], ['unknown', 'read refused']] as const) {
      const facts = provisionFacts({
        seats: { m365: [{ skuId: SKU_A, skuPartNumber: 'STANDARDPACK', state, available: state === 'unavailable' ? 0 : null,
          observedAt: '2026-10-01T09:00:00.000Z', reason: state === 'unknown' ? 'read refused' : null }] },
      });
      const item = buildIdentityOnboardingManualWork(input(), facts, ALL_READY, []).find((i) => i.key === 'manual_license:STANDARDPACK');
      expect(item, state).toBeDefined();
      expect(item!.detail.toLowerCase(), state).toContain(expectWord);
    }
    // No seat fact at all: keyed by the SKU id.
    expect(keysOf(buildIdentityOnboardingManualWork(input(), provisionFacts({ seats: { m365: [] } }), ALL_READY, [])))
      .toContain(`manual_license:${SKU_A}`);
    // An available SKU produces no item.
    expect(keysOf(buildIdentityOnboardingManualWork(input(), provisionFacts(), ALL_READY, []))
      .some((k) => k.startsWith('manual_license:'))).toBe(false);
  });

  it('emits one item per group the plan refused to touch, saying why', () => {
    const items = buildIdentityOnboardingManualWork(input(), provisionFacts(), ALL_READY, []);
    expect(keysOf(items)).toContain(`manual_group_add:${GRP_DYN}`);
    expect(keysOf(items)).toContain(`manual_group_add:${GRP_ROLE}`);
    expect(keysOf(items)).not.toContain(`manual_group_add:${GRP_OK}`);
    expect(items.find((i) => i.key === `manual_group_add:${GRP_ROLE}`)!.detail.toLowerCase()).toContain('role');
    expect(items.find((i) => i.key === `manual_group_add:${GRP_DYN}`)!.detail.toLowerCase()).toContain('dynamic');
  });

  it('emits one item per MISSING capability for a tool the input asks for', () => {
    const partial = { ...ALL_READY, 'm365.graph.group_membership_write': false };
    const degraded = buildIdentityOnboardingManualWork(input(), provisionFacts(), partial, [])
      .find((i) => i.capabilityKey === 'm365.graph.group_membership_write');
    expect(degraded).toBeDefined();
    expect(degraded!.origin).toBe('capability');
    // Not for a tool the input never asks for.
    const noGroups = input({ m365: { userPrincipalName: UPN, mailNickname: 'priya', usageLocation: 'CA', skuIds: [SKU_A], groupIds: [] } });
    expect(buildIdentityOnboardingManualWork(noGroups, provisionFacts(), partial, [])
      .some((i) => i.capabilityKey === 'm365.graph.group_membership_write')).toBe(false);
  });

  it('turns a review flag and a discovery flag into items', () => {
    const items = buildIdentityOnboardingManualWork(input(), provisionFacts({
      flags: [{ code: 'model_after_unreadable', subject: 'm365', detail: 'Could not read the model-after person.' }],
    }), ALL_READY, [
      { code: 'unverified_domain', subject: 'customer.example', detail: 'The domain is not verified on the tenant.' },
    ]);
    expect(items.filter((i) => i.origin === 'flag').map((i) => i.detail)).toEqual(['The domain is not verified on the tenant.']);
    expect(keysOf(items)).toContain('discovery_flag:model_after_unreadable:m365');
  });

  it('is stable, deduplicated by key and bounded per item', () => {
    const items = buildIdentityOnboardingManualWork(input(), provisionFacts(), {}, []);
    expect(new Set(keysOf(items)).size).toBe(items.length);
    expect(items).toEqual(buildIdentityOnboardingManualWork(input(), provisionFacts(), {}, []));
    for (const i of items) expect(i.label.length).toBeLessThanOrEqual(500);
  });

  it('throws on malformed facts', () => {
    expect(() => buildIdentityOnboardingManualWork(input(), {}, ALL_READY, [])).toThrow(/identity_onboarding/);
  });
});

describe('capOnboardingManualWork', () => {
  it('folds anything past the bound into one final item, keeping order', () => {
    const many = Array.from({ length: MANUAL_WORK_MAX_ITEMS + 5 }, (_, i) => ({
      key: `k${i}`, label: `item ${i}`, detail: 'd', origin: 'always' as const, capabilityKey: null,
    }));
    const capped = capOnboardingManualWork(many);
    expect(capped).toHaveLength(MANUAL_WORK_MAX_ITEMS);
    expect(capped[0]!.key).toBe('k0');
    expect(capped.at(-1)!.key).toBe('overflow');
    expect(capped.at(-1)!.detail).toContain('onboarding');
    expect(capped.at(-1)!.detail).toContain(`item ${MANUAL_WORK_MAX_ITEMS + 4}`);
    expect(capOnboardingManualWork(many.slice(0, 3))).toEqual(many.slice(0, 3));
  });
});

describe('operationKey — one operation per external effect', () => {
  it('agrees BYTE FOR BYTE with buildTaskOperationKey, for both stages', () => {
    for (const [stepKey, plan] of [
      ['create_accounts', buildIdentityOnboardingCreatePlan(input(), createFacts())],
      ['provision_effects', buildIdentityOnboardingProvisionPlan(input(), provisionFacts())],
    ] as const) {
      for (const e of plan) {
        expect(identityOnboardingRecipe.operationKey({
          stepKey, targetId: e.targetId, planRevision: 3, ordinal: e.ordinal, toolName: e.toolName,
        })).toBe(buildTaskOperationKey({
          taskStepKey: stepKey, planRevision: 3, toolName: e.toolName, targetId: e.targetId, ordinal: e.ordinal,
        }));
      }
    }
  });

  it('gives the same effect at two plan revisions two different keys', () => {
    const e = buildIdentityOnboardingCreatePlan(input(), createFacts())[0]!;
    const k = (rev: number) => identityOnboardingRecipe.operationKey({
      stepKey: 'create_accounts', targetId: e.targetId, planRevision: rev, ordinal: 0, toolName: e.toolName,
    });
    expect(k(1)).not.toBe(k(2));
  });

  it('falls back to the workflow key for a step with no provider tool', () => {
    expect(identityOnboardingRecipe.operationKey({
      stepKey: 'resolve_accounts', targetId: CONTACT_TARGET, planRevision: 1, ordinal: 0,
    })).toContain('identity_onboarding');
  });
});
