/**
 * `identity_onboarding`'s two reason steps (D-R1-9, W07 Task 8): prompt
 * rendering, the prompt version, and the server-side cross-checks that run
 * AFTER E1's schema layer (`validateRecipeNextStep`).
 *
 * Why each rule exists:
 *  - `intake` may only name contacts that EXIST IN THE ORG, in EITHER list. A
 *    hallucinated uuid must never reach `confirm_details`' card, where a
 *    technician would tick "yes, that's her manager" against a row that does
 *    not exist.
 *  - `review` may only use flags from the closed enum, the three exception
 *    classes, and tool names the plan actually contains. An exception about a
 *    tool that was never planned is a hallucination or another task's
 *    reasoning, and must not become a human-work item telling a technician to
 *    check something that was never attempted.
 *  - The review rendering states WHICH of the two plan stages it reviews. A
 *    model that cannot tell will narrate the wrong half of the onboarding. The
 *    stage comes from the snapshot's `facts.stage` (Amendment B2's single
 *    dispatch key), so an EMPTY stage-1 plan (a UPN collision) still says
 *    stage 1; a plan that contradicts its stage is refused.
 *  - No credential-shaped material reaches the model. The create effect's
 *    arguments carry no password today (the executor mints it into a sealed
 *    result); case 5 is what proves the rendering cannot start leaking one if
 *    that ever changes, because effect arguments are rendered from an
 *    allowlist of keys, never walked.
 *  - D-R2-9: the model never expands "model after". The rendering shows the
 *    model-after person's memberships as COUNTS only, and the grants it lists
 *    are the input's, so there is no group or licence in the prompt the model
 *    could ask to add.
 *  - The success shapes carry nothing the model wrote into a field a caller
 *    treats as authoritative (case 13).
 *
 * The last case is a PIN, not a red: it fingerprints the rendering of a fixed
 * fixture together with `IDENTITY_ONBOARDING_PROMPT_VERSION`, so a rendering
 * change that does not bump the version (D-R1-9) fails here.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { identityOnboardingInputSchema } from '@breeze/shared';
import type { PlannedEffect, RecipeManualWorkItem } from './recipes/types';
import {
  IDENTITY_ONBOARDING_PROMPT_VERSION,
  buildIdentityOnboardingCreatePlan,
  buildIdentityOnboardingProvisionPlan,
  identityOnboardingFactsSchema,
  type IdentityOnboardingFacts,
} from './recipes/identityOnboarding';
import {
  ONBOARDING_CONTEXT_MAX_CHARS,
  renderOnboardingIntakeContext,
  renderOnboardingReviewContext,
  validateOnboardingConfirmOutput,
  validateOnboardingReviewOutput,
} from './taskContextOnboarding';

const C1 = '00000000-0000-4000-8000-000000000001';
const C2 = '00000000-0000-4000-8000-000000000002';
const C3 = '00000000-0000-4000-8000-000000000003';
const STRANGER = '00000000-0000-4000-8000-0000000000ff';
const TARGET = '00000000-0000-4000-8000-0000000000aa';
const SKU = '00000000-0000-4000-8000-000000000b01';
const GROUP = '00000000-0000-4000-8000-000000000c01';
/** Generated-looking: the shape `generateTempPassword` produces. */
const TOKEN = 'Mz9!Qw7rT2yU8iO4pA6sD';
/** ≥ 20 chars of a password alphabet (no separators) with a lower, an upper and a digit. */
const TOKEN_SHAPE = /(?=[A-Za-z0-9!#$%&*?^~]*[a-z])(?=[A-Za-z0-9!#$%&*?^~]*[A-Z])(?=[A-Za-z0-9!#$%&*?^~]*\d)[A-Za-z0-9!#$%&*?^~]{20,}/;

const input = identityOnboardingInputSchema.parse({
  displayName: 'Robin Vale',
  jobTitle: 'Accountant',
  managerContactId: STRANGER,
  modelAfterContactId: C2,
  m365: {
    userPrincipalName: 'robin@customer.example', mailNickname: 'robin', usageLocation: 'US',
    skuIds: [SKU], groupIds: [GROUP],
  },
  google: {
    primaryEmail: 'robin@customer.example', givenName: 'Robin', familyName: 'Vale',
    orgUnitPath: '/Finance', licenses: [{ productId: 'Google-Apps', skuId: '1010020027' }],
    groupEmails: ['finance@customer.example'],
  },
});

const BASE = {
  targets: { contactTargetId: TARGET, contactLabel: 'Robin Vale' },
  collisions: {
    m365: { upnTaken: false, existingObjectId: null },
    google: { emailTaken: false, existingUserId: null },
  },
  seats: { m365: [{ skuId: SKU, skuPartNumber: 'SPE_E3', state: 'available', available: 4, observedAt: '2026-10-23T12:00:00.000Z', reason: null }] },
  groups: {
    m365: [{ id: GROUP, name: 'Finance Team', dynamic: false, roleAssignable: null }],
    google: [{ email: 'finance@customer.example', name: 'Finance', modelAfterRole: 'MEMBER' }],
  },
  modelAfter: {
    contactId: C2, label: 'Sam Reed',
    m365: { groupIds: [GROUP, 'obj-1111'], skuIds: [SKU] },
    google: { groupEmails: ['finance@customer.example', 'admins@customer.example'], licenses: [] },
  },
  degradedTools: [],
  capabilityReadiness: { 'm365.connection': true },
  flags: [],
  truncated: [],
};
const STAGE1 = identityOnboardingFactsSchema.parse({ stage: 'create', ...BASE }) as IdentityOnboardingFacts;
const STAGE2 = identityOnboardingFactsSchema.parse({
  stage: 'provision', ...BASE,
  accounts: {
    m365: { externalId: 'obj-2222', principalLabel: 'robin@customer.example' },
    google: { externalId: '900100', principalLabel: 'robin@customer.example' },
  },
}) as IdentityOnboardingFacts;
const CREATE_PLAN = buildIdentityOnboardingCreatePlan(input, STAGE1);
const PROVISION_PLAN = buildIdentityOnboardingProvisionPlan(input, STAGE2);

const MANUAL: RecipeManualWorkItem[] = [
  { key: 'assign_hardware', origin: 'always', capabilityKey: null, label: "Assign Robin Vale's company hardware",
    detail: 'Prepare and hand over the laptop.' },
  { key: 'manual_license:SPE_E5', origin: 'discovery', capabilityKey: null, label: 'Assign the licence SPE_E5 by hand',
    detail: 'The organization has no free seat for this licence.' },
];

function review(over: Partial<Parameters<typeof renderOnboardingReviewContext>[0]> = {}): string {
  return renderOnboardingReviewContext({
    objective: 'Onboard Robin, starts Monday', input, facts: STAGE1, plannedEffects: CREATE_PLAN,
    manualWork: MANUAL, degradedCapabilities: [], ...over,
  });
}
const stageLine = (out: string): string | undefined => /^stage: (.*)$/m.exec(out)?.[1];

describe('renderOnboardingIntakeContext', () => {
  it('1. includes the objective, the new hire, the chosen principals and every candidate — and no contact outside the list', () => {
    const out = renderOnboardingIntakeContext({
      objective: 'Onboard Robin, starts Monday',
      input,
      orgCandidates: [
        { contactId: C1, name: 'Dana Ruiz', email: 'dana@customer.example', title: 'Finance Director' },
        { contactId: C2, name: 'Sam Reed', email: null, title: null },
      ],
    });
    expect(out).toContain('Onboard Robin, starts Monday');
    expect(out).toContain('Robin Vale');
    expect(out).toContain('m365_account_to_create: robin@customer.example');
    expect(out).toContain('google_account_to_create: robin@customer.example');
    for (const s of [C1, 'Dana Ruiz', 'dana@customer.example', 'Finance Director', C2, 'Sam Reed']) expect(out).toContain(s);
    // The given manager id is NOT a candidate, so it never reaches the prompt.
    expect(out).not.toContain(STRANGER);
    expect(out).toContain('manager_given: yes (not among the candidates below)');
    expect(out).toMatch(new RegExp(`${C2} .*given as model-after`));
    expect(out.trimEnd().endsWith('TASK_FACTS>>>')).toBe(true);
  });

  it('2. is bounded: 200 candidates stay under 16 KiB and say how many were omitted', () => {
    const orgCandidates = Array.from({ length: 200 }, (_, i) => ({
      contactId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      name: `Person ${i} ${'x'.repeat(80)}`, email: `p${i}@customer.example`, title: 'Staff',
    }));
    const out = renderOnboardingIntakeContext({ objective: 'o', input, orgCandidates });
    expect(out.length).toBeLessThan(16 * 1024);
    expect(out.length).toBeLessThanOrEqual(ONBOARDING_CONTEXT_MAX_CHARS);
    expect(out).toMatch(/\(150 more candidates omitted\)/);
    expect(out.split('TASK_FACTS>>>').length - 1).toBe(1);
  });
});

describe('renderOnboardingReviewContext', () => {
  it('3. lists planned effects grouped by provider in plan order with ordinals, manual items with reasons, degraded capabilities in words', () => {
    const out = review({
      facts: STAGE2, plannedEffects: PROVISION_PLAN, degradedCapabilities: ['google.tool.license_write', 'm365.graph.user_create'],
    });
    const google = out.indexOf('\ngoogle:\n');
    const m365 = out.indexOf('\nm365:\n');
    const positions = PROVISION_PLAN.map((e) => out.indexOf(`#${e.ordinal} ${e.toolName}`));
    expect(PROVISION_PLAN.map((e) => e.toolName)).toEqual([
      'google_move_ou', 'google_assign_license', 'google_add_to_group', 'm365_assign_license', 'm365_add_to_group',
    ]);
    expect(positions.every((p) => p > -1)).toBe(true);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
    expect(google).toBeGreaterThan(-1);
    expect(google).toBeLessThan(positions[0]!);
    expect(m365).toBeGreaterThan(positions[2]!);
    expect(m365).toBeLessThan(positions[3]!);
    // What each effect addresses, from an allowlist of argument keys.
    expect(out).toContain('orgUnitPath=/Finance');
    expect(out).toContain(`groupId=${GROUP} ("Finance Team")`);
    // Manual work, with its reason.
    expect(out).toContain("Assign Robin Vale's company hardware — Prepare and hand over the laptop.");
    expect(out).toContain('Assign the licence SPE_E5 by hand — The organization has no free seat for this licence.');
    // Degraded capabilities in plain language, not just keys.
    expect(out).toContain('Assigning Google Workspace licences.');
    expect(out).toContain('Creating Microsoft 365 accounts');
    // D-R2-9: model-after memberships are counts only; an unrequested group never appears.
    expect(out).toContain('model_after: Sam Reed');
    expect(out).not.toContain('admins@customer.example');
    expect(out).not.toContain('obj-1111');
  });

  it('4. states the stage in words from facts.stage — an empty stage-1 plan is still stage 1; a contradicting plan is refused', () => {
    const s1 = review();
    expect(stageLine(s1)).toBe('stage 1 of 2: account creation');
    expect(s1).toContain('next_stage: stage 2 of 2: licences, groups and OU');
    expect(s1).toContain('#0 m365_create_user');

    // A UPN collision: the create plan is empty, but this is still stage 1.
    const collided = identityOnboardingFactsSchema.parse({
      stage: 'create', ...BASE,
      collisions: { ...BASE.collisions, m365: { upnTaken: true, existingObjectId: 'obj-1111' } },
    }) as IdentityOnboardingFacts;
    const empty = review({ facts: collided, plannedEffects: buildIdentityOnboardingCreatePlan(input, collided) });
    expect(stageLine(empty)).toBe('stage 1 of 2: account creation');
    expect(empty).toContain('m365 sign-in name: TAKEN (object id obj-1111)');

    const s2 = review({ facts: STAGE2, plannedEffects: PROVISION_PLAN });
    expect(stageLine(s2)).toBe('stage 2 of 2: licences, groups and OU');
    expect(s2).not.toContain('next_stage:');

    // A plan whose tools contradict its snapshot's stage never renders.
    expect(() => review({ facts: STAGE2, plannedEffects: CREATE_PLAN })).toThrow(/stage/);
    expect(() => review({ facts: STAGE1, plannedEffects: PROVISION_PLAN })).toThrow(/stage/);
  });

  it('5. renders no secret-shaped material, even if an effect or a fact smuggles some in', () => {
    // Pinned premise: the real create effect carries no password.
    expect(Object.keys(CREATE_PLAN[0]!.canonicalArguments).sort())
      .toEqual(['displayName', 'mailNickname', 'reason', 'usageLocation', 'userPrincipalName']);
    const tampered: PlannedEffect = {
      ...CREATE_PLAN[0]!,
      canonicalArguments: {
        ...CREATE_PLAN[0]!.canonicalArguments,
        passwordProfile: { password: TOKEN, forceChangePasswordNextSignIn: true },
        password: TOKEN, clientSecret: 'cs', vaultRef: 'vault://x',
      },
    };
    const smuggledFacts = {
      ...STAGE1,
      targets: { ...STAGE1.targets, contactLabel: `Robin passwordProfile ${TOKEN}` },
      flags: [{ code: 'x', subject: 'clientSecret=abc', detail: '-----BEGIN PRIVATE KEY----- serviceAccountKey vaultRef' }],
      // An unexpected key on the facts object is never walked.
      serviceAccountKey: '-----BEGIN PRIVATE KEY-----',
    } as unknown as IdentityOnboardingFacts;
    const out = review({
      facts: smuggledFacts, plannedEffects: [tampered],
      manualWork: [{ ...MANUAL[0]!, detail: `temporary_password=${TOKEN} clientSecret` }],
    });
    expect(out).toContain('#0 m365_create_user');
    expect(out).not.toMatch(/clientSecret|serviceAccountKey|vaultRef|-----BEGIN|passwordProfile/i);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toMatch(TOKEN_SHAPE);
  });
});

describe('validateOnboardingConfirmOutput', () => {
  const org = new Set([C1, C2, C3]);

  it('6. accepts ids present in the org set', () => {
    expect(validateOnboardingConfirmOutput({
      managerCandidateContactIds: [C1], modelAfterCandidateContactIds: [C2, C3], ambiguous: false, rationale: 'exact title',
    }, org)).toEqual({ ok: true, managerCandidateContactIds: [C1], modelAfterCandidateContactIds: [C2, C3] });
  });

  it('7. REJECTS an id absent from the org set with unknown_contact, naming it — in EITHER list', () => {
    const inManager = validateOnboardingConfirmOutput({
      managerCandidateContactIds: [C1, STRANGER], modelAfterCandidateContactIds: [C2], ambiguous: false, rationale: 'x',
    }, org);
    expect(inManager).toMatchObject({ ok: false, reason: 'unknown_contact' });
    expect((inManager as { detail: string }).detail).toContain(STRANGER);
    expect((inManager as { detail: string }).detail).toContain('manager');

    const inModelAfter = validateOnboardingConfirmOutput({
      managerCandidateContactIds: [C1], modelAfterCandidateContactIds: [STRANGER], ambiguous: false, rationale: 'x',
    }, org);
    expect(inModelAfter).toMatchObject({ ok: false, reason: 'unknown_contact' });
    expect((inModelAfter as { detail: string }).detail).toContain(STRANGER);
    expect((inModelAfter as { detail: string }).detail).toContain('model-after');
  });

  it('8. REJECTS a payload that fails the schema with schema', () => {
    expect(validateOnboardingConfirmOutput({
      managerCandidateContactIds: ['dana'], modelAfterCandidateContactIds: [], ambiguous: false, rationale: 'x',
    }, org)).toMatchObject({ ok: false, reason: 'schema' });
    // `.strict()`: a chosen id the model slipped in is a refusal, not ignored.
    expect(validateOnboardingConfirmOutput({
      managerCandidateContactIds: [C1], modelAfterCandidateContactIds: [], ambiguous: false, rationale: 'x', managerContactId: C1,
    }, org)).toMatchObject({ ok: false, reason: 'schema' });
  });

  it('9. accepts TWO EMPTY candidate lists with ambiguous:true — "could not find the manager" must reach the technician', () => {
    expect(validateOnboardingConfirmOutput({
      managerCandidateContactIds: [], modelAfterCandidateContactIds: [], ambiguous: true, rationale: 'no match',
    }, org)).toEqual({ ok: true, managerCandidateContactIds: [], modelAfterCandidateContactIds: [] });
  });
});

describe('validateOnboardingReviewOutput', () => {
  const planned = new Set(CREATE_PLAN.map((e) => e.toolName));

  it('10. accepts flags from the enum and exceptions about planned tools', () => {
    const r = validateOnboardingReviewOutput({
      flags: [{ code: 'no_seat_available', subject: 'SPE_E5', detail: 'No free seat.' }],
      exceptions: [{ toolName: 'm365_create_user', classification: 'human_work', detail: 'Confirm the UPN suffix.' }],
      summary: 'One licence gap.',
    }, planned);
    expect(r).toMatchObject({ ok: true, summary: 'One licence gap.' });
    expect((r as { flags: unknown[] }).flags).toHaveLength(1);
    expect((r as { exceptions: unknown[] }).exceptions).toHaveLength(1);
  });

  it('11. REJECTS an exception naming a tool absent from the plan with unknown_tool', () => {
    const r = validateOnboardingReviewOutput({
      flags: [],
      exceptions: [{ toolName: 'm365_add_to_group', classification: 'retry', detail: 'x' }],
      summary: 's',
    }, planned);
    expect(r).toMatchObject({ ok: false, reason: 'unknown_tool' });
    expect((r as { detail: string }).detail).toContain('m365_add_to_group');
  });

  it('12. REJECTS a flag code outside the enum with schema', () => {
    expect(validateOnboardingReviewOutput({
      flags: [{ code: 'grant_global_admin', subject: 's', detail: 'd' }], exceptions: [], summary: 's',
    }, planned)).toMatchObject({ ok: false, reason: 'schema' });
  });
});

describe('authority', () => {
  it('13. success shapes carry ONLY what a caller may act on — no rationale passthrough into a decision path', () => {
    const c = validateOnboardingConfirmOutput({
      managerCandidateContactIds: [C1, C1], modelAfterCandidateContactIds: [C2], ambiguous: true, rationale: 'pick me',
    }, new Set([C1, C2]));
    expect(Object.keys(c).sort()).toEqual(['managerCandidateContactIds', 'modelAfterCandidateContactIds', 'ok']);
    expect(c).toEqual({ ok: true, managerCandidateContactIds: [C1], modelAfterCandidateContactIds: [C2] });

    const r = validateOnboardingReviewOutput({ flags: [], exceptions: [], summary: 'fine' }, new Set());
    expect(Object.keys(r).sort()).toEqual(['exceptions', 'flags', 'ok', 'summary']);
  });

  it('PIN: the rendering fingerprint moves only with IDENTITY_ONBOARDING_PROMPT_VERSION (D-R1-9)', () => {
    const rendered = [
      renderOnboardingIntakeContext({ objective: 'o', input, orgCandidates: [{ contactId: C1, name: 'Dana', email: null, title: null }] }),
      review(),
      review({ facts: STAGE2, plannedEffects: PROVISION_PLAN }),
    ].join('\n');
    const sha = createHash('sha256').update(rendered).digest('hex');
    // Changing the rendering? Bump IDENTITY_ONBOARDING_PROMPT_VERSION in
    // recipes/identityOnboarding.ts AND update both values below together.
    expect({ version: IDENTITY_ONBOARDING_PROMPT_VERSION, sha })
      .toEqual({ version: 'identity_onboarding/v1', sha: '5c48c7e27acb97ffd63be39f646f338c02e84a61c9cd6a23ff6ede3197393176' });
  });
});
