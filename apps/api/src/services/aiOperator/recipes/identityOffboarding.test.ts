// apps/api/src/services/aiOperator/recipes/identityOffboarding.test.ts
/**
 * The `identity_offboarding` recipe, exhaustively, at the pure level.
 *
 * Everything asserted here is a property of DATA: the step graph, the closed
 * effect catalog, the argument shapes, the safety ordering, and the three
 * things the recipe must never emit. Nothing here touches a database, a
 * provider or a clock — the recipe owns no I/O (spec §6.1) and this file is
 * the proof that its behaviour is fully determined by (input, facts).
 *
 * The ORDERING PROPERTY lives in the sibling `identityOffboarding.ordering.test.ts`
 * so the two can be reasoned about separately: this file says what the plan
 * contains, that file says what every prefix of it means.
 */
import { describe, expect, it } from 'vitest';
import type { IdentityOffboardingInput } from '@breeze/shared';
import {
  CAPABILITY_FOR_TOOL,
  EFFECT_PROVIDER_ORDER,
  IDENTITY_OFFBOARDING_BOUNDS,
  IDENTITY_OFFBOARDING_CAPABILITIES,
  IDENTITY_OFFBOARDING_EFFECT_TOOLS,
  IDENTITY_OFFBOARDING_PROMPT_VERSION,
  IDENTITY_OFFBOARDING_STEP_KEYS,
  IDENTITY_OFFBOARDING_UNOBSERVABLE_EFFECTS,
  IDENTITY_OFFBOARDING_WORKFLOW_KEY,
  IDENTITY_OFFBOARDING_WORKFLOW_VERSION,
  MANUAL_WORK_MAX_ITEMS,
  buildIdentityOffboardingManualWork,
  buildIdentityOffboardingPlan,
  capManualWork,
  identityOffboardingRecipe,
  type IdentityManualWorkItem,
} from './identityOffboarding';
import { resolveDeterministicNextStep } from './resolveNextStep';
import { buildTaskOperationKey } from '../operationKey';

const CONTACT = '00000000-0000-4000-8000-000000000001';
const DEVICE = '00000000-0000-4000-8000-0000000000d1';
/** The contact's ai_operator_task_targets.id — what PlannedEffect.targetId carries (E4). */
const CONTACT_TARGET = '00000000-0000-4000-8000-0000000000e1';

function input(over: Partial<IdentityOffboardingInput> = {}): IdentityOffboardingInput {
  return identityOffboardingRecipe.inputSchema.parse({ contactId: CONTACT, ...over });
}

/** Both providers present, two groups each, one licence each, one phone each. */
const FULL_FACTS = Object.freeze({
  google: {
    present: true, externalId: '101', primaryEmail: 'dana@customer.example',
    groups: [
      { id: 'g1', email: 'all@customer.example', name: 'All Staff', ownership: 'shared', dynamic: false, roleAssignable: false },
      { id: 'g2', email: 'fin@customer.example', name: 'Finance', ownership: 'sole', dynamic: false, roleAssignable: false },
    ],
    licenses: [{ productId: 'Google-Apps', skuId: '1010020020', name: 'Workspace Business Standard' }],
    mobileDevices: [{ id: 'md1', model: 'Pixel 8', status: 'APPROVED' }],
  },
  m365: {
    present: true, externalId: 'e5b1…', userPrincipalName: 'dana@customer.example',
    groups: [
      { id: 'mg1', name: 'Marketing', ownership: 'unknown', dynamic: false, roleAssignable: false },
      { id: 'mg2', name: 'Dynamic All', ownership: 'unknown', dynamic: true, roleAssignable: false },
    ],
    licenses: [{ skuId: '18181a46-0d4e-45cd-891e-60aabd171b4e', skuPartNumber: 'STANDARDPACK' }],
    intuneDevices: [{ id: 'id1', deviceName: 'DANA-IPHONE' }],
  },
  breeze: { suggestedDevices: [] },
  flags: [],
  // Frozen by `discover` into the planning snapshot (amended 2026-10-18).
  targets: { contactTargetId: CONTACT_TARGET },
  degradedTools: [],
} as const);

const ALL_READY: Record<string, boolean> = Object.fromEntries(
  IDENTITY_OFFBOARDING_CAPABILITIES.map((c) => [c.key, true]),
);

describe('recipe identity', () => {
  it('declares its key, version, prompt version and gate class', () => {
    expect(identityOffboardingRecipe.key).toBe('identity_offboarding');
    expect(IDENTITY_OFFBOARDING_WORKFLOW_KEY).toBe('identity_offboarding');
    expect(identityOffboardingRecipe.version).toBe(IDENTITY_OFFBOARDING_WORKFLOW_VERSION);
    expect(identityOffboardingRecipe.promptVersion).toBe(IDENTITY_OFFBOARDING_PROMPT_VERSION);
    expect(identityOffboardingRecipe.gateClass).toBe('deterministic');
  });

  it('targets a contact and a ticket, never a device alone', () => {
    expect([...identityOffboardingRecipe.targetKinds].sort()).toEqual(['contact', 'device', 'ticket']);
  });

  it('carries spec §6.7 bounds — 14 days, 6 reasoning runs, 2 mutation attempts per effect', () => {
    expect(IDENTITY_OFFBOARDING_BOUNDS.deadlineMs).toBe(14 * 24 * 60 * 60 * 1000);
    expect(IDENTITY_OFFBOARDING_BOUNDS.maxReasoningRuns).toBe(6);
    expect(IDENTITY_OFFBOARDING_BOUNDS.maxMutationAttempts).toBe(2);
    expect(identityOffboardingRecipe.bounds).toBe(IDENTITY_OFFBOARDING_BOUNDS);
  });
});

describe('the step graph (spec §6.3)', () => {
  it('declares exactly the eight spine steps, in order (amended 2026-10-18)', () => {
    expect([...IDENTITY_OFFBOARDING_STEP_KEYS]).toEqual([
      'intake', 'confirm_identity', 'discover', 'review', 'effects',
      'manual_work', 'verify_outcome', 'document',
    ]);
    expect(Object.keys(identityOffboardingRecipe.steps).sort())
      .toEqual([...IDENTITY_OFFBOARDING_STEP_KEYS].sort());
  });

  it('assigns each step the kind spec §6.1s table implies', () => {
    const kinds = Object.fromEntries(
      Object.entries(identityOffboardingRecipe.steps).map(([k, s]) => [k, s.kind]),
    );
    expect(kinds).toEqual({
      intake: 'reason',
      confirm_identity: 'human_work',
      discover: 'probe',
      review: 'reason',
      effects: 'effect',
      manual_work: 'human_work',
      verify_outcome: 'probe',
      document: 'document',
    });
  });

  it('has exactly ONE effect-kind step — E4 binds one approval per revision to the step that proposed it', () => {
    const effectSteps = Object.entries(identityOffboardingRecipe.steps)
      .filter(([, st]) => st.kind === 'effect').map(([k]) => k);
    expect(effectSteps).toEqual(['effects']);
    for (const gone of ['plan_approval', 'wait_cutoff', 'device_actions']) {
      expect(identityOffboardingRecipe.steps[gone]).toBeUndefined();
    }
  });

  it('declares the R1a-0 recipe data: snapshot step, entry step, unobservable map', () => {
    expect(identityOffboardingRecipe.planningSnapshotStepKey).toBe('discover');
    expect(identityOffboardingRecipe.entryStepKey).toBe('intake');
    expect(identityOffboardingRecipe.unobservableEffects).toBe(IDENTITY_OFFBOARDING_UNOBSERVABLE_EFFECTS);
  });

  it('makes `document` the only terminal step', () => {
    const terminal = Object.entries(identityOffboardingRecipe.steps)
      .filter(([, s]) => s.terminal).map(([k]) => k);
    expect(terminal).toEqual(['document']);
  });

  it('CANNOT REACH `discover` WITHOUT `confirm_identity` — the mandatory human confirmation', () => {
    // Two independent statements of the same rule, because this is spec §11's
    // first risk row and a single assertion is a single point of rot.
    expect(resolveDeterministicNextStep(identityOffboardingRecipe as never, 'intake', {
      input: input(), facts: FULL_FACTS, readiness: ALL_READY,
    })).toEqual({ ok: true, key: 'confirm_identity' });
    // No step anywhere in the recipe names `discover` as its next EXCEPT
    // confirm_identity, and the model's permitted set never contains it.
    const namesDiscover = Object.entries(identityOffboardingRecipe.steps)
      .filter(([, s]) => s.next === 'discover').map(([k]) => k);
    expect(namesDiscover).toEqual(['confirm_identity']);
    for (const permitted of Object.values(identityOffboardingRecipe.permittedNextSteps)) {
      expect(permitted).not.toContain('discover');
    }
  });

  it('lets the model propose ONLY out of the two reason steps, and only forward', () => {
    expect(identityOffboardingRecipe.permittedNextSteps).toEqual({
      intake: ['confirm_identity'],
      review: ['effects'],
    });
  });

  it('attaches the intake and review output schemas to the steps that CONSUME them', () => {
    // A reason step's output is validated against the NEXT step's inputSchema
    // through E1's validateRecipeNextStep — so the schema lives on the target.
    expect(identityOffboardingRecipe.steps.confirm_identity!.inputSchema).toBeDefined();
    expect(identityOffboardingRecipe.steps.effects!.inputSchema).toBeDefined(); // review's output (amended)
    expect(identityOffboardingRecipe.steps.intake!.inputSchema).toBeUndefined();
    expect(identityOffboardingRecipe.steps.manual_work!.inputSchema).toBeUndefined();
  });

  it('review → effects → manual_work, with or without a cutoff or devices (amended 2026-10-18)', () => {
    // The cutoff is the walk's post-approval not-before gate (checkpoint
    // dispatchNotBefore, written by advanceReview from input.cutoffAt), not a
    // step; selected devices are manual items, not an effect step.
    for (const over of [{}, { cutoffAt: '2026-10-23T17:00:00.000Z' }, { deviceIds: [DEVICE] }]) {
      const ctx = { input: input(over as never), facts: FULL_FACTS, readiness: ALL_READY };
      expect(resolveDeterministicNextStep(identityOffboardingRecipe as never, 'review', ctx)).toEqual({ ok: true, key: 'effects' });
      expect(resolveDeterministicNextStep(identityOffboardingRecipe as never, 'effects', ctx)).toEqual({ ok: true, key: 'manual_work' });
    }
  });

  it('never skips manual_work — hardware and every selected device are ALWAYS human work', () => {
    const items = buildIdentityOffboardingManualWork(input({ deviceIds: [DEVICE] }), FULL_FACTS, ALL_READY, []).map((i) => i.key);
    expect(items).toContain('collect_hardware');
    expect(items).toContain(`device_signout_${DEVICE}`);
    expect(buildIdentityOffboardingPlan(input({ deviceIds: [DEVICE] }), FULL_FACTS).every((e) => e.provider !== 'breeze')).toBe(true);
  });

  it('ends manual_work → verify_outcome → document', () => {
    const ctx = { input: input(), facts: FULL_FACTS, readiness: ALL_READY };
    expect(resolveDeterministicNextStep(identityOffboardingRecipe as never, 'manual_work', ctx)).toEqual({ ok: true, key: 'verify_outcome' });
    expect(resolveDeterministicNextStep(identityOffboardingRecipe as never, 'verify_outcome', ctx)).toEqual({ ok: true, key: 'document' });
    expect(resolveDeterministicNextStep(identityOffboardingRecipe as never, 'document', ctx).ok).toBe(false);
  });
});

describe('buildPlan — the closed effect catalog', () => {
  const plan = buildIdentityOffboardingPlan(input(), FULL_FACTS);
  const names = plan.map((e) => e.toolName);

  it('NEVER emits google_offboard_user', () => {
    expect(names).not.toContain('google_offboard_user');
    expect(IDENTITY_OFFBOARDING_EFFECT_TOOLS).not.toContain('google_offboard_user');
  });

  it('NEVER emits google_wipe_mobile_device — that tool is a FULL FACTORY RESET', () => {
    expect(names).not.toContain('google_wipe_mobile_device');
    expect(IDENTITY_OFFBOARDING_EFFECT_TOOLS).not.toContain('google_wipe_mobile_device');
  });

  it('every emitted tool is in the closed catalog', () => {
    for (const n of names) expect(IDENTITY_OFFBOARDING_EFFECT_TOOLS).toContain(n);
  });

  it('numbers ordinals densely from 0 and never repeats one', () => {
    expect(plan.map((e) => e.ordinal)).toEqual(plan.map((_, i) => i));
  });

  it('runs every Google effect before every M365 effect (EFFECT_PROVIDER_ORDER)', () => {
    expect(EFFECT_PROVIDER_ORDER).toEqual(['google', 'm365']);
    const lastGoogle = plan.map((e) => e.provider).lastIndexOf('google');
    const firstM365 = plan.map((e) => e.provider).indexOf('m365');
    expect(lastGoogle).toBeLessThan(firstM365);
  });

  it('fans group removal out to ONE effect per group, per provider', () => {
    expect(names.filter((n) => n === 'google_remove_from_group')).toHaveLength(2);
    // mg2 is dynamic-membership: never planned (M1 refuses it), a manual item instead.
    expect(names.filter((n) => n === 'm365_remove_from_group')).toHaveLength(1);
  });

  it('fans licence removal and Intune retire out per licence / per device', () => {
    expect(names.filter((n) => n === 'google_remove_license')).toHaveLength(1);
    expect(names.filter((n) => n === 'm365_remove_license')).toHaveLength(1);
    // Intune retire rides the wipeMobile toggle (default OFF), like the Google account wipe.
    expect(names.filter((n) => n === 'm365_retire_intune_device')).toHaveLength(0);
    const wiped = buildIdentityOffboardingPlan(input({ effects: { wipeMobile: true } as never }), FULL_FACTS);
    expect(wiped.filter((e) => e.toolName === 'm365_retire_intune_device')).toHaveLength(1);
  });

  it('addresses every provider effect by the IMMUTABLE external id, never the UPN', () => {
    for (const e of plan) {
      if (e.provider === 'google') expect(e.accountExternalId).toBe('101');
      if (e.provider === 'm365') expect(e.accountExternalId).toBe('e5b1…');
    }
  });

  it('pins the contact TARGET ROW id (not the contact id) as targetId on every provider effect', () => {
    for (const e of plan) expect(e.targetId).toBe(CONTACT_TARGET);
    for (const e of plan) expect(e.targetId).not.toBe(CONTACT);
  });

  it('omits every tool in facts.degradedTools and renumbers densely — the degraded set is part of the frozen snapshot', () => {
    const p = buildIdentityOffboardingPlan(input(), { ...FULL_FACTS, degradedTools: ['m365_retire_intune_device', 'google_set_vacation'] });
    expect(p.map((e) => e.toolName)).not.toContain('m365_retire_intune_device');
    expect(p.map((e) => e.toolName)).not.toContain('google_set_vacation');
    expect(p.map((e) => e.ordinal)).toEqual(p.map((_, i) => i));
  });

  it('is DETERMINISTIC — same input and facts produce an identical list', () => {
    expect(buildIdentityOffboardingPlan(input(), FULL_FACTS)).toEqual(plan);
  });

  it('emits no mobile wipe by default and one when the toggle is on', () => {
    expect(names).not.toContain('google_account_wipe_mobile_device');
    const wiped = buildIdentityOffboardingPlan(input({ effects: { wipeMobile: true } as never }), FULL_FACTS);
    expect(wiped.map((e) => e.toolName)).toContain('google_account_wipe_mobile_device');
  });

  it('omits an effect whose toggle is off, and renumbers densely', () => {
    const p = buildIdentityOffboardingPlan(input({ effects: { removeGroups: false } as never }), FULL_FACTS);
    expect(p.map((e) => e.toolName)).not.toContain('google_remove_from_group');
    expect(p.map((e) => e.ordinal)).toEqual(p.map((_, i) => i));
  });

  it('skips a whole provider block when discovery found no account there', () => {
    const googleOnly = { ...FULL_FACTS, m365: { ...FULL_FACTS.m365, present: false } };
    const p = buildIdentityOffboardingPlan(input(), googleOnly);
    expect(p.every((e) => e.provider !== 'm365')).toBe(true);
    expect(p.length).toBeGreaterThan(0);
  });

  it('emits NO M365 forwarding or mailbox-delegate effect — no Exchange executor exists (spec §7.3)', () => {
    const withDelegate = buildIdentityOffboardingPlan(
      input({ inheritorContactId: null, forwardTo: 'sam@customer.example', effects: { mailDelegate: true } as never }),
      FULL_FACTS,
    ).map((e) => `${e.provider}:${e.toolName}`);
    expect(withDelegate).toContain('google:google_set_forwarding');
    expect(withDelegate).toContain('google:google_add_mail_delegate');
    expect(withDelegate.filter((n) => n.startsWith('m365:') && /forward|delegate/.test(n))).toEqual([]);
  });

  it('OMITS m365_remove_license entirely when keepMailbox is set, and keeps google_remove_license', () => {
    const p = buildIdentityOffboardingPlan(input({ keepMailbox: true }), FULL_FACTS).map((e) => e.toolName);
    expect(p).not.toContain('m365_remove_license');
    expect(p).toContain('google_remove_license');
  });

  it('carries canonical arguments that match each tools shipped shape', () => {
    const full = buildIdentityOffboardingPlan(input({ effects: { wipeMobile: true } as never }), FULL_FACTS);
    const byName = new Map(full.map((e) => [e.toolName, e.canonicalArguments]));
    expect(byName.get('google_set_vacation')).toMatchObject({ userEmail: 'dana@customer.example', enable: true });
    expect(byName.get('google_remove_from_group')).toMatchObject({ userEmail: 'dana@customer.example', groupEmail: expect.any(String) });
    expect(byName.get('google_remove_license')).toMatchObject({ userEmail: 'dana@customer.example', productId: 'Google-Apps', skuId: '1010020020' });
    expect(byName.get('google_suspend_user')).toMatchObject({ userEmail: 'dana@customer.example' });
    expect(byName.get('m365_remove_from_group')).toMatchObject({ groupId: expect.any(String), userIdentifier: 'e5b1…' });
    expect(byName.get('m365_remove_license')).toMatchObject({ userIdentifier: 'e5b1…', skuIds: ['18181a46-0d4e-45cd-891e-60aabd171b4e'] });
    expect(byName.get('m365_retire_intune_device')).toMatchObject({ managedDeviceId: 'id1' });
    expect(byName.get('m365_disable_user')).toMatchObject({ userIdentifier: 'e5b1…' });
    for (const [, args] of byName) expect((args as { reason?: string }).reason).toBeTruthy();
  });

  it('declares google_signout unobservable and NAMES the criterion that subsumes it (spec §6.6)', () => {
    expect(IDENTITY_OFFBOARDING_UNOBSERVABLE_EFFECTS).toEqual({ google_signout: 'google_suspend_user' });
    const p = buildIdentityOffboardingPlan(input(), FULL_FACTS).map((e) => e.toolName);
    // Every unobservable effect's subsuming effect must itself be in the plan,
    // or the task can never reach verified_resolved (spec §6.6's last rule).
    for (const [effect, subsumer] of Object.entries(IDENTITY_OFFBOARDING_UNOBSERVABLE_EFFECTS)) {
      if (p.includes(effect)) expect(p).toContain(subsumer);
    }
  });
});

describe('required capabilities (spec §4.1)', () => {
  it('names a capability for every tool in the catalog', () => {
    for (const tool of IDENTITY_OFFBOARDING_EFFECT_TOOLS) {
      expect(CAPABILITY_FOR_TOOL[tool], `no capability mapped for ${tool}`).toBeTruthy();
      expect(IDENTITY_OFFBOARDING_CAPABILITIES.map((c) => c.key)).toContain(CAPABILITY_FOR_TOOL[tool]);
    }
  });

  it('declares the three Exchange capabilities as the ONLY always_manual ones', () => {
    const exchange = ['m365.exchange.forwarding', 'm365.exchange.mailbox_delegate', 'm365.exchange.shared_mailbox_conversion'];
    const keys = IDENTITY_OFFBOARDING_CAPABILITIES.map((c) => c.key);
    for (const k of exchange) {
      expect(keys).toContain(k);
      expect(IDENTITY_OFFBOARDING_CAPABILITIES.find((c) => c.key === k)!.kind).toBe('tool_source');
    }
    // Exactly these three, no more: an `always_manual` capability is invisible
    // to readiness, so mis-classifying a FIXABLE gap as always_manual would
    // hide a real "re-consent Microsoft 365" from the technician forever.
    expect(IDENTITY_OFFBOARDING_CAPABILITIES.filter((c) => c.availability === 'always_manual').map((c) => c.key).sort())
      .toEqual([...exchange].sort());
  });

  it('classifies every OTHER capability as tenant_fixable (explicitly or by default)', () => {
    for (const c of IDENTITY_OFFBOARDING_CAPABILITIES) {
      if (c.key.startsWith('m365.exchange.')) continue;
      expect(c.availability ?? 'tenant_fixable', `${c.key}`).toBe('tenant_fixable');
    }
  });

  it('declares the helpdesk agent-allowlist capability naming EVERY effect tool', () => {
    const cap = IDENTITY_OFFBOARDING_CAPABILITIES.find((c) => c.key === 'agent.helpdesk.tool_allowlist');
    expect(cap?.kind).toBe('agent_tool');
    expect(cap).toBeDefined();
    expect([...cap!.toolNames!].sort()).toEqual([...IDENTITY_OFFBOARDING_EFFECT_TOOLS].sort());
  });
});

describe('buildIdentityOffboardingManualWork (spec §6.5)', () => {
  it('always emits the three fixed items', () => {
    const keys = buildIdentityOffboardingManualWork(input(), FULL_FACTS, ALL_READY, []).map((i) => i.key);
    expect(keys).toEqual(expect.arrayContaining(['collect_hardware', 'transfer_file_ownership', 'update_documentation']));
  });

  it('emits M365 forwarding and delegation as human work whenever the effect was requested', () => {
    const keys = buildIdentityOffboardingManualWork(
      input({ forwardTo: 'sam@customer.example', effects: { mailDelegate: true } as never }),
      FULL_FACTS, ALL_READY, [],
    ).map((i) => i.key);
    expect(keys).toContain('m365_forwarding_manual');
    expect(keys).toContain('m365_mailbox_delegate_manual');
  });

  it('emits shared-mailbox conversion when keepMailbox is set', () => {
    expect(buildIdentityOffboardingManualWork(input({ keepMailbox: true }), FULL_FACTS, ALL_READY, []).map((i) => i.key))
      .toContain('shared_mailbox_conversion');
  });

  it('emits one item per MISSING capability, with generated instructions and the capability key', () => {
    const partial = { ...ALL_READY, 'm365.graph.intune_retire': false };
    // wipeMobile on, so the Intune retire WOULD be planned (it defaults off).
    const items = buildIdentityOffboardingManualWork(input({ effects: { wipeMobile: true } as never }), FULL_FACTS, partial, []);
    const degraded = items.find((i) => i.capabilityKey === 'm365.graph.intune_retire');
    expect(degraded).toBeDefined();
    expect(degraded!.origin).toBe('capability');
    expect(degraded!.detail.length).toBeGreaterThan(20);
    expect(degraded!.label.length).toBeLessThanOrEqual(500);
  });

  it('emits a degraded item for every tool in the FROZEN degraded set the plan would have held', () => {
    const items = buildIdentityOffboardingManualWork(
      input(), { ...FULL_FACTS, degradedTools: ['google_suspend_user'] }, ALL_READY, [],
    );
    expect(items.map((i) => i.capabilityKey)).toContain('google.tool.suspend');
  });

  it('emits NO degraded item for an effect the plan would not contain (no noise for unrequested work)', () => {
    const partial = { ...ALL_READY, 'm365.graph.intune_retire': false };
    const items = buildIdentityOffboardingManualWork(input(), FULL_FACTS, partial, []); // wipeMobile off
    expect(items.map((i) => i.capabilityKey)).not.toContain('m365.graph.intune_retire');
    const noGoogle = { ...FULL_FACTS, google: { ...FULL_FACTS.google, present: false } };
    const googleDown = Object.fromEntries(Object.keys(ALL_READY).map((k) => [k, !k.startsWith('google.')]));
    expect(buildIdentityOffboardingManualWork(input(), noGoogle, googleDown, [])
      .filter((i) => i.origin === 'capability' && i.capabilityKey?.startsWith('google.'))).toEqual([]);
  });

  it('throws on facts with no targets.contactTargetId or no degradedTools — never plans against a guess', () => {
    const { targets: _t, ...noTargets } = FULL_FACTS;
    const { degradedTools: _d, ...noDegraded } = FULL_FACTS;
    expect(() => buildIdentityOffboardingPlan(input(), noTargets)).toThrow(/contactTargetId/);
    expect(() => buildIdentityOffboardingPlan(input(), noDegraded)).toThrow(/degradedTools/);
  });

  it('a disable held back by caller verification is a SPECIFIC manual item, not a "missing grant" one, and is not planned', () => {
    const facts = { ...FULL_FACTS, degradedTools: ['m365_disable_user'], callerVerificationTools: ['m365_disable_user'] };
    expect(buildIdentityOffboardingPlan(input(), facts).map((e) => e.toolName)).not.toContain('m365_disable_user');
    const items = buildIdentityOffboardingManualWork(input(), facts, ALL_READY, []);
    const held = items.find((i) => i.key === 'caller_verification:m365_disable_user');
    expect(held?.detail).toContain('caller-verification policy');
    expect(items.map((i) => i.key)).not.toContain('capability:m365.graph.user_disable');
  });

  it('no label of the recipe\'s own manual items trips the completion record\'s secret filter', () => {
    const items = buildIdentityOffboardingManualWork(input({ keepMailbox: true, deviceIds: [DEVICE] }), FULL_FACTS, {}, []);
    for (const i of items) expect(i.label, i.key).not.toMatch(/credential|password|secret|token|recovery|\bpin\b|\botp\b/i);
  });

  it('emits an item for every UNKNOWN-ownership M365 group the plan removes (D-R1-7)', () => {
    const items = buildIdentityOffboardingManualWork(input(), FULL_FACTS, ALL_READY, []);
    // ONE item naming every such group — never one per group (the list is capped).
    const owners = items.filter((i) => i.key.startsWith('confirm_m365_group_owner'));
    expect(owners.map((i) => i.key)).toEqual(['confirm_m365_group_owners']);
    expect(owners[0]!.label).toContain('2 Microsoft 365 group(s)');
  });

  it('emits an item for a dynamic or role-assignable group instead of planning its removal', () => {
    expect(buildIdentityOffboardingPlan(input(), FULL_FACTS)
      .filter((e) => e.toolName === 'm365_remove_from_group')
      .map((e) => (e.canonicalArguments as { groupId: string }).groupId))
      .not.toContain('mg2');
    expect(buildIdentityOffboardingManualWork(input(), FULL_FACTS, ALL_READY, []).map((i) => i.key))
      .toContain('manual_m365_group_removals');
  });

  it('turns a review flag into an item', () => {
    const items = buildIdentityOffboardingManualWork(input(), FULL_FACTS, ALL_READY, [
      { code: 'sole_group_owner', subject: 'Finance', detail: 'Dana is the only owner.' },
    ]);
    const flagged = items.filter((i) => i.origin === 'flag');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.detail).toContain('Dana is the only owner.');
  });

  it('keepMailbox with the licence capability UNSATISFIED never tells a person to remove the licence', () => {
    // Removing the licence starts the mailbox deletion clock; with keepMailbox
    // the plan omits it, and the manual list must not put it back as human work.
    const items = buildIdentityOffboardingManualWork(
      input({ keepMailbox: true }), FULL_FACTS, { ...ALL_READY, 'm365.graph.license_write': false }, [],
    ).map((i) => i.key);
    expect(items).not.toContain('capability:m365.graph.license_write');
    expect(items).toContain('shared_mailbox_conversion');
    // Control: without keepMailbox the same readiness DOES produce the item.
    expect(buildIdentityOffboardingManualWork(
      input(), FULL_FACTS, { ...ALL_READY, 'm365.graph.license_write': false }, [],
    ).map((i) => i.key)).toContain('capability:m365.graph.license_write');
  });

  it('M365 forwarding copy does not claim it must precede the disable the plan already ran', () => {
    const item = buildIdentityOffboardingManualWork(input({ forwardTo: 'sam@customer.example' }), FULL_FACTS, ALL_READY, [])
      .find((i) => i.key === 'm365_forwarding_manual')!;
    expect(item.detail).not.toMatch(/before the account is disabled/);
    expect(item.detail).toMatch(/does not stop the mailbox receiving mail/);
  });

  it('a degraded mail step yields a lockout_held item naming the missing tool', () => {
    const f = { ...FULL_FACTS, degradedTools: ['m365_set_auto_reply'] };
    expect(buildIdentityOffboardingPlan(input(), f).map((e) => e.toolName)).not.toContain('m365_disable_user');
    const held = buildIdentityOffboardingManualWork(input(), f, ALL_READY, []).find((i) => i.key === 'lockout_held:m365')!;
    expect(held.detail).toContain('m365_set_auto_reply');
    expect(held.label).toMatch(/Disable .* by hand, after the mail steps/);
  });

  it('every frozen admission problem becomes its own "check by hand" item', () => {
    const f = { ...FULL_FACTS, admissionProblems: ['m365 lookup failed (executor_unavailable)', 'google connection unavailable'] };
    const items = buildIdentityOffboardingManualWork(input(), f, ALL_READY, []);
    const problems = items.filter((i) => i.key.startsWith('admission_problem:'));
    expect(problems.map((i) => i.key)).toEqual(['admission_problem:0', 'admission_problem:1']);
    expect(problems[0]!.detail).toContain('m365 lookup failed (executor_unavailable)');
  });

  it('a CONNECTED provider with no account for the person asks a human to confirm — unless a read flag already covers it', () => {
    const noM365 = { ...FULL_FACTS, m365: { ...(FULL_FACTS.m365 as object), present: false } };
    expect(buildIdentityOffboardingManualWork(input(), noM365, ALL_READY, []).map((i) => i.key))
      .toContain('confirm_no_account:m365');
    // Not connected → nothing to confirm.
    expect(buildIdentityOffboardingManualWork(input(), noM365, { ...ALL_READY, 'm365.connection': false }, []).map((i) => i.key))
      .not.toContain('confirm_no_account:m365');
    // A frozen account that could not be read already has its flag item.
    const flagged = { ...noM365, flags: [{ code: 'm365_read_failed', subject: 'dana', detail: 'x' }] };
    expect(buildIdentityOffboardingManualWork(input(), flagged, ALL_READY, []).map((i) => i.key))
      .not.toContain('confirm_no_account:m365');
    // Present → nothing to confirm.
    expect(buildIdentityOffboardingManualWork(input(), FULL_FACTS, ALL_READY, []).map((i) => i.key))
      .not.toContain('confirm_no_account:m365');
  });

  it('is stable and deduplicated by key', () => {
    const items = buildIdentityOffboardingManualWork(input({ keepMailbox: true }), FULL_FACTS, {}, []);
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
    expect(items).toEqual(buildIdentityOffboardingManualWork(input({ keepMailbox: true }), FULL_FACTS, {}, []));
  });
});

describe('operationKey — one operation per external effect', () => {
  it('includes step, EFFECT tool, target, revision and ordinal', () => {
    const k = identityOffboardingRecipe.operationKey({
      stepKey: 'effects', targetId: CONTACT, planRevision: 3, ordinal: 4,
      toolName: 'google_suspend_user',
    });
    expect(k).toContain('effects');
    expect(k).toContain('google_suspend_user');
    expect(k).toContain('r3');
    expect(k).toContain('n4');
    expect(k.length).toBeLessThanOrEqual(200);
  });

  it('agrees BYTE FOR BYTE with what effectDispatch builds for the same effect', () => {
    // The permanent (org_id, task_id, operation_key) index is the whole replay
    // guarantee, and E4's planOrdinalFromOperationKey parses this exact format
    // back out at release. Two spellings of one identity would defeat both, so
    // this is asserted against buildTaskOperationKey directly rather than
    // against a literal.
    const effect = buildIdentityOffboardingPlan(input(), FULL_FACTS)
      .find((e) => e.toolName === 'google_suspend_user')!;
    expect(identityOffboardingRecipe.operationKey({
      stepKey: 'effects', targetId: effect.targetId, planRevision: 3,
      ordinal: effect.ordinal, toolName: effect.toolName,
    })).toBe(buildTaskOperationKey({
      taskStepKey: 'effects', planRevision: 3, toolName: effect.toolName,
      targetId: effect.targetId, ordinal: effect.ordinal,
    }));
  });

  it('gives two different effects of one step two different keys', () => {
    const plan = buildIdentityOffboardingPlan(input(), FULL_FACTS);
    const keys = plan.map((e) => identityOffboardingRecipe.operationKey({
      stepKey: 'effects', targetId: e.targetId, planRevision: 1,
      ordinal: e.ordinal, toolName: e.toolName,
    }));
    expect(new Set(keys).size).toBe(plan.length);
  });

  it('falls back to the workflow key for a step with no provider tool', () => {
    expect(identityOffboardingRecipe.operationKey({
      stepKey: 'verify_outcome', targetId: CONTACT, planRevision: 1, ordinal: 0,
    })).toContain('identity_offboarding');
  });
});

describe('registry', () => {
  it('is registered under its own key and resolves at its version', async () => {
    const { RECIPES, RECIPE_KEYS, getRecipe } = await import('./index');
    expect(RECIPE_KEYS).toContain('identity_offboarding');
    expect(RECIPES.identity_offboarding).toBe(identityOffboardingRecipe as never);
    expect(getRecipe('identity_offboarding', 1)).toBe(identityOffboardingRecipe as never);
    expect(getRecipe('identity_offboarding', 2)).toBeNull();
  });
});

describe('capManualWork', () => {
  const mk = (n: number): IdentityManualWorkItem[] => Array.from({ length: n }, (_, i) => ({
    key: `k${i}`, label: `item ${i}`, detail: 'd', origin: 'flag', capabilityKey: null,
  }));

  it('passes a list at or under the cap through unchanged', () => {
    expect(capManualWork(mk(MANUAL_WORK_MAX_ITEMS))).toEqual(mk(MANUAL_WORK_MAX_ITEMS));
  });

  it('folds everything past the cap into ONE final item that names each folded item', () => {
    const out = capManualWork(mk(100));
    expect(out).toHaveLength(MANUAL_WORK_MAX_ITEMS);
    expect(out.slice(0, MANUAL_WORK_MAX_ITEMS - 1)).toEqual(mk(100).slice(0, MANUAL_WORK_MAX_ITEMS - 1));
    const last = out[MANUAL_WORK_MAX_ITEMS - 1]!;
    expect(last.key).toBe('overflow');
    expect(last.label).toContain(`${100 - (MANUAL_WORK_MAX_ITEMS - 1)} more`);
    expect(last.detail).toContain('item 63');
    expect(last.detail).toContain('item 99');
  });
});
