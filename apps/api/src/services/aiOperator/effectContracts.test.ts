/**
 * Spec §9(a) — the deterministic gate's per-effect contract, over BOTH identity
 * catalogs: `identity_offboarding` (wave #6171, PR R1c, plan Task 24) and
 * `identity_onboarding` (wave #6172, PR R2c, W07 plan Task 23). One file, an
 * outer loop over the two catalogs, so a tool added to either catalog without a
 * fixture is a red here rather than a silent gap.
 *
 * For every effect in either recipe's CLOSED catalog, against provider-response
 * fixtures (`__fixtures__/providers/<toolName>.json`). Today every fixture is a
 * REFERENCE shape authored from the API docs; the lab run re-records them, and
 * the gate-mode tripwire below stays red until it does:
 *
 *   1. PRE-PROBE SHORT-CIRCUITS. When the pre-probe observes the desired end
 *      state, NO write is dispatched: an idempotent effect settles `succeeded`
 *      with `result.noop = true`, a `non_idempotent` one hands off. This is
 *      what makes replay safe without an idempotency key, which neither Graph
 *      nor the Directory API offers (spec §6.6).
 *   2. WRITE IS DISPATCHED when the pre-probe does not observe it, and the
 *      provider write itself (the headless executor the release worker calls)
 *      succeeds on the recorded `writeOk` response — and fails, never
 *      "succeeds", on the recorded refusal.
 *   3. POST-PROBE IS THE VERIFICATION. A successful write call never implies a
 *      successful effect (Operator spec §13).
 *   4. REPLAY IS A NO-OP BY OBSERVATION. Dispatching the same effect twice
 *      performs the write once; the second pass is property 1. EXCEPT the four
 *      tools in REPLAY_REQUESTS_SAME_OPERATION, whose done world cannot be
 *      certified before a write: their replay re-requests the SAME operation
 *      key, and at-most-once is the permanent (org, task, operation_key) index
 *      (real rows: aiOperatorEffectDispatchReplay.integration.test.ts). This
 *      file proves only the key identity for those four.
 *   5. Each tool declares an idempotency class, and a `non_idempotent` one is
 *      never auto-retried.
 *
 * And, for R2, the two properties only a CREATING recipe needs:
 *
 *   6. A NON_IDEMPOTENT EFFECT'S PRE-PROBE HAS ONE ACTIONABLE ANSWER.
 *      `unsatisfied` dispatches; `unknown` and `satisfied` both hand off
 *      (D-R2-4), and neither hand-off mints an intent or writes an operation
 *      row. Driven off the classification over both catalogs, so it cannot be
 *      met for `m365_create_user` alone. The `satisfied` case is the one worth
 *      reading twice: M1's criterion for `m365.user.create` is "a user with this
 *      UPN exists", which cannot tell "we did this already" from "somebody else
 *      holds this name", and only one of those is safe (the fixture's
 *      `preSatisfied` is a COLLISION, and its `_meaning` says so).
 *   7. THE CREATE IS NEVER RETRIED. Driven twice, the second time under a FRESH
 *      operation key (a later plan revision, so the permanent
 *      (org_id, task_id, operation_key) index cannot be what stops it), and
 *      asserted against the operation rows this module writes plus the mints it
 *      makes: exactly one mint, ever, and no operation row on the second pass.
 *      The real-row form (one `ai_operator_operations` row, one executor call)
 *      is aiOperatorIdentityOnboardingGate.integration.test.ts.
 *
 * WHAT IS REAL AND WHAT IS MOCKED. A fixture is only evidence if it is read by
 * the production code that reads the provider, so:
 *   - the PROBES are the real ones (`registerAllEffectProbes`, `probeEffect`,
 *     the Google probes and the M365 control-plane `probeM365Effect`);
 *   - the DISPATCH half is the real `dispatchPlannedEffect` /
 *     `verifyDispatchedEffect`; membership, the mint (`createActionIntent`),
 *     the approver re-proof and the operation-row insert are mocked exactly as
 *     `effectDispatch.test.ts` mocks them. "Write dispatched" means the mint
 *     was called; the real-row form of replay is
 *     `__tests__/integration/aiOperatorEffectDispatchReplay.integration.test.ts`;
 *   - the WRITE is the real headless executor (`executeGoogleToolHeadless`,
 *     `executeM365ToolHeadless`) with only the provider boundary mocked: the
 *     googleapis clients (`googleClient`), the org connection lookup, and the
 *     M365 control-plane read/write services;
 *   - the PLANNED EFFECTS come from the real `buildIdentityOffboardingPlan` and
 *     the real `buildIdentityOnboardingCreatePlan` /
 *     `buildIdentityOnboardingProvisionPlan`, so the arguments each probe and
 *     executor sees are the recipe's, never the fixture's.
 * Every mocked provider call answers ONLY from the fixture phase in play; a
 * call the fixture does not record throws a FixtureGapError, and every
 * property asserts that no such gap was hit (a probe would swallow it into
 * `unknown`, and a Google executor into an `{ error }` result). A fixture that
 * lies about its phase therefore fails here. The provider WRITE call's
 * arguments are checked against the plan's identities (WRITE_ARGS, stated in
 * this file, never in the fixture), so a write aimed at the wrong target fails.
 *
 * `m365_disable_user` is caller-protected: its executor routes through
 * `executeProtectedM365Headless`, whose pinned-intent loader
 * (`aiToolsM365.loadM365MutationContext`) is mocked to a control-plane pin
 * whose object id DIFFERS from the plan's `userIdentifier`, so the test proves
 * the write goes to the pinned id. Its write response is tested at the
 * `executeM365WriteActionByOrg` boundary.
 *
 * GATE MODE. `BREEZE_GATE_SIGNOFF=1` enables the tripwire that fails while any
 * fixture is still a `reference` shape (deviation G1: a permanently red case
 * in `test-api` would block the merge queue). `BREEZE_RECORD_PROVIDER_FIXTURES=1`
 * prints the provider-call capture plan the lab operator records against
 * (README). Both are read only by `*.test.ts` files (envInventory, G8).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const GATE_SIGNOFF = process.env.BREEZE_GATE_SIGNOFF === '1';
const RECORD_CAPTURE_PLAN = process.env.BREEZE_RECORD_PROVIDER_FIXTURES === '1';

// ---------------------------------------------------------------------------
// The provider boundary: every call answers from the fixture phase in play.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => {
  type World = Record<string, unknown>;
  const state = {
    world: null as World | null,
    phase: '' as string,
    tool: '' as string,
    calls: [] as { key: string; args: unknown }[],
    /** Every call the phase in play did not record. Each property asserts this stays empty. */
    gaps: [] as string[],
    /** The mailbox each Gmail client was built for. */
    impersonated: [] as string[],
  };
  class FixtureGapError extends Error {}
  /** Answer `key` from the current fixture phase; a Google `{ error }` entry throws like googleapis does. */
  function answer(key: string, args: unknown): unknown {
    state.calls.push({ key, args });
    const world = state.world;
    if (!world || !Object.prototype.hasOwnProperty.call(world, key)) {
      const gap = `fixture ${state.tool}.${state.phase} records no response for ${key}`;
      state.gaps.push(gap);
      throw new FixtureGapError(gap);
    }
    const r = world[key] as { error?: { code: number; message: string } };
    if (r && typeof r === 'object' && 'error' in r && r.error && typeof r.error.code === 'number') {
      throw Object.assign(new Error(r.error.message), { code: r.error.code, status: r.error.code });
    }
    return r;
  }
  const g = (key: string) => async (args: unknown) => answer(key, args);
  return {
    state,
    FixtureGapError,
    answer,
    directory: {
      users: { get: g('directory.users.get'), update: g('directory.users.update'), signOut: g('directory.users.signOut') },
      groups: { list: g('directory.groups.list') },
      members: {
        delete: g('directory.members.delete'),
        // identity_onboarding (R2c): the add-to-group probe and write.
        get: g('directory.members.get'),
        insert: g('directory.members.insert'),
      },
      mobiledevices: { list: g('directory.mobiledevices.list'), action: g('directory.mobiledevices.action') },
    },
    licensing: {
      licenseAssignments: {
        listForProduct: g('licensing.licenseAssignments.listForProduct'),
        delete: g('licensing.licenseAssignments.delete'),
        // identity_onboarding (R2c): the assign-license probe and write.
        listForProductAndSku: g('licensing.licenseAssignments.listForProductAndSku'),
        insert: g('licensing.licenseAssignments.insert'),
      },
    },
    gmail: {
      users: {
        settings: {
          getVacation: g('gmail.settings.getVacation'),
          updateVacation: g('gmail.settings.updateVacation'),
          getAutoForwarding: g('gmail.settings.getAutoForwarding'),
          updateAutoForwarding: g('gmail.settings.updateAutoForwarding'),
          forwardingAddresses: {
            get: g('gmail.settings.forwardingAddresses.get'),
            create: g('gmail.settings.forwardingAddresses.create'),
          },
          delegates: { list: g('gmail.settings.delegates.list'), create: g('gmail.settings.delegates.create') },
        },
      },
    },
    captureException: vi.fn(),
    checkPlanEffectMembershipSystem: vi.fn(),
    createActionIntent: vi.fn(),
    buildTaskActorAuthContext: vi.fn(async () => ({ user: { id: 'u-approver' } })),
    appendTaskEvent: vi.fn(),
    loadM365MutationContext: vi.fn(),
    inserted: [] as Record<string, unknown>[],
  };
});

vi.mock('../googleClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../googleClient')>()),
  getDirectoryClient: () => h.directory,
  getLicensingClient: () => h.licensing,
  // Gmail settings impersonate the MAILBOX OWNER; record who, so a write to the wrong mailbox fails.
  getGmailClient: (_keyJson: string, subject: string) => { h.state.impersonated.push(subject); return h.gmail; },
}));
vi.mock('../aiToolsGoogle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../aiToolsGoogle')>()),
  resolveContextByOrg: async () => ({ conn: { adminEmail: 'admin@customer.example' }, keyJson: '{}' }),
}));
vi.mock('../m365ControlPlane/readActionService', () => ({
  executeM365ReadActionByOrg: async (_orgId: string, action: { type: string }) => h.answer(`read:${action.type}`, action),
  executeM365ReadAction: vi.fn(),
}));
vi.mock('../m365ControlPlane/writeActionService', () => ({
  executeM365WriteActionByOrg: async (_orgId: string, action: { type: string }) => h.answer(`write:${action.type}`, action),
}));
vi.mock('../aiToolsM365', () => ({
  loadM365MutationContext: h.loadM365MutationContext,
  m365DisableUserHandler: vi.fn(),
  m365ResetPasswordHandler: vi.fn(),
}));
vi.mock('../sentry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sentry')>()),
  captureException: h.captureException,
}));
vi.mock('./planApproval', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./planApproval')>()),
  checkPlanEffectMembershipSystem: h.checkPlanEffectMembershipSystem,
}));
vi.mock('../actionIntents/intentService', () => ({
  createActionIntent: h.createActionIntent,
  ActionIntentError: class ActionIntentError extends Error {
    constructor(message: string, public code: string) { super(message); }
  },
}));
vi.mock('../actionIntents/actorContext', () => ({
  buildTaskActorAuthContext: h.buildTaskActorAuthContext,
  buildAuthContextForIntent: vi.fn(),
}));
vi.mock('./eventService', () => ({ appendTaskEvent: h.appendTaskEvent }));
vi.mock('../../db', () => ({
  db: {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        h.inserted.push(v);
        return { onConflictDoNothing: () => ({ returning: async () => [{ id: 'op-1' }] }) };
      },
    }),
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withDbAccessContext: (_ctx: unknown, fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

import { writeActionFailureCodeSchema, writeActionResultSchema } from '@breeze/shared/m365';
import {
  IDENTITY_OFFBOARDING_EFFECT_TOOLS,
  IDENTITY_OFFBOARDING_UNOBSERVABLE_EFFECTS,
  buildIdentityOffboardingPlan,
  identityOffboardingRecipe,
} from './recipes/identityOffboarding';
import {
  IDENTITY_ONBOARDING_CREATE_TOOLS,
  IDENTITY_ONBOARDING_EFFECT_TOOLS,
  IDENTITY_ONBOARDING_PROVISION_TOOLS,
  IDENTITY_ONBOARDING_UNOBSERVABLE_EFFECTS,
  buildIdentityOnboardingCreatePlan,
  buildIdentityOnboardingProvisionPlan,
  identityOnboardingRecipe,
} from './recipes/identityOnboarding';
import { isSecretBearingTool } from '../actionIntents/secretBearingTools';
import type { PlannedEffect } from './recipes/types';
import { registerAllEffectProbes } from './effectProbes/bootstrap';
import { isStructurallyUnobservable, listProbedTools, probeEffect } from './effectProbes';
import { classifyEffectIdempotency, dispatchPlannedEffect, verifyDispatchedEffect } from './effectDispatch';
import { planEffectOperationKey } from './planApproval';
import { executeGoogleToolHeadless } from '../googleToolsHeadless';
import { M365_HEADLESS_ACTIONS, M365ConnectionUnavailableError, executeM365ToolHeadless } from '../m365ToolsHeadless';

registerAllEffectProbes();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_DIR = fileURLToPath(new URL('./__fixtures__/providers/', import.meta.url));

const worldSchema = z.record(z.string(), z.unknown());
const fixtureSchema = z.object({
  _source: z.string().regex(/^(reference|lab-run-\d{4}-\d{2}-\d{2})$/),
  _recordedFrom: z.string().min(1),
  _notes: z.string().optional(),
  /** Per-phase reading notes, for a phase a future reader is likely to misread (README). */
  _meaning: z.partialRecord(z.enum(['preSatisfied', 'preUnsatisfied', 'writeOk', 'postSatisfied', 'writeRefusal']), z.string().min(1)).optional(),
  toolName: z.string(),
  provider: z.enum(['google', 'm365']),
  preSatisfied: worldSchema.nullable(),
  /** Why the real probe can never answer `satisfied` before this write. Present iff preSatisfied is null. */
  preSatisfiedUnreachable: z.string().min(1).optional(),
  preUnsatisfied: worldSchema,
  writeOk: worldSchema,
  postSatisfied: worldSchema,
  /** Required: dropping it would silently lose the negative half of property 2. */
  writeRefusal: worldSchema,
}).strict().refine((f) => (f.preSatisfied === null) === (f.preSatisfiedUnreachable !== undefined), {
  message: 'preSatisfiedUnreachable must be given exactly when preSatisfied is null',
});
type Fixture = z.infer<typeof fixtureSchema>;

/** readFileSync + JSON.parse, never `import`: the fixture check must not depend on module resolution (G2). */
function loadFixture(toolName: string): Fixture {
  const raw = readFileSync(join(FIXTURE_DIR, `${toolName}.json`), 'utf8');
  const parsed = fixtureSchema.parse(JSON.parse(raw));
  if (parsed.toolName !== toolName) throw new Error(`${toolName}.json declares toolName ${parsed.toolName}`);
  return parsed;
}

// ---------------------------------------------------------------------------
// The plan: one effect per catalog tool, built by the REAL recipe.
// ---------------------------------------------------------------------------

/** The synthetic identities every fixture uses (README). */
const ID = Object.freeze({
  googleEmail: 'dana@customer.example',
  googleId: '101',
  googleGroup: 'all@customer.example',
  googleProduct: 'Google-Apps',
  googleSku: '1010020020',
  destination: 'manager@customer.example',
  m365Oid: '00000000-0000-4000-8000-0000000a0001',
  m365Group: '00000000-0000-4000-8000-0000000b0001',
  m365Sku: '00000000-0000-4000-8000-0000000c0001',
  m365Device: '00000000-0000-4000-8000-0000000d0001',
  contactTarget: '00000000-0000-4000-8000-0000000e0001',
  message: 'Dana has left the organization. Please contact office@customer.example for help.',
});

const PLAN_INPUT = identityOffboardingRecipe.inputSchema.parse({
  contactId: '00000000-0000-4000-8000-000000000001',
  forwardTo: ID.destination,
  autoReplyMessage: ID.message,
  effects: {
    autoReply: true, forwarding: true, mailDelegate: true, removeGroups: true,
    removeLicenses: true, revokeSessions: true, wipeMobile: true, disableAccount: true,
  },
});
const PLAN_FACTS = {
  google: {
    present: true, externalId: ID.googleId, primaryEmail: ID.googleEmail,
    groups: [{ id: 'g1', email: ID.googleGroup, name: 'All Staff', ownership: 'shared', dynamic: false, roleAssignable: false }],
    licenses: [{ productId: ID.googleProduct, skuId: ID.googleSku, name: 'Workspace Business Standard' }],
    mobileDevices: [{ id: 'md1', model: 'Pixel 8', status: 'APPROVED' }],
  },
  m365: {
    present: true, externalId: ID.m365Oid, userPrincipalName: ID.googleEmail,
    groups: [{ id: ID.m365Group, name: 'Marketing', ownership: 'unknown', dynamic: false, roleAssignable: false }],
    licenses: [{ skuId: ID.m365Sku, skuPartNumber: 'STANDARDPACK' }],
    intuneDevices: [{ id: ID.m365Device, deviceName: 'DANA-IPHONE' }],
  },
  breeze: { suggestedDevices: [] },
  flags: [],
  targets: { contactTargetId: ID.contactTarget, contactLabel: 'Dana Whitfield' },
  degradedTools: [],
};
const PLAN = buildIdentityOffboardingPlan(PLAN_INPUT, PLAN_FACTS);

/**
 * identity_onboarding's synthetic identities (README). The new hire, the
 * account the create returns, and the provisioning targets. Distinct from the
 * offboarding values so a fixture can never satisfy the other recipe's tool.
 */
const ONB = Object.freeze({
  upn: 'priya@customer.example',
  googleEmail: 'priya@customer.example',
  googleId: '102',
  googleGroup: 'staff@customer.example',
  googleProduct: 'Google-Apps',
  googleSku: '1010020027',
  orgUnitPath: '/Staff',
  m365Oid: '00000000-0000-4000-8000-0000000a0101',
  /** Someone who already holds the UPN: the create fixture's `preSatisfied` (a collision). */
  m365Holder: '00000000-0000-4000-8000-0000000a0199',
  m365Group: '00000000-0000-4000-8000-0000000b0101',
  m365Sku: '00000000-0000-4000-8000-0000000c0101',
  contactTarget: '00000000-0000-4000-8000-0000000e0101',
  displayName: 'Priya Example',
});

const ONBOARDING_INPUT = identityOnboardingRecipe.inputSchema.parse({
  displayName: ONB.displayName, jobTitle: 'Staff Accountant', siteId: null,
  managerContactId: null, modelAfterContactId: null, startAt: null,
  m365: { userPrincipalName: ONB.upn, mailNickname: 'priya', usageLocation: 'US', skuIds: [ONB.m365Sku], groupIds: [ONB.m365Group] },
  google: {
    primaryEmail: ONB.googleEmail, givenName: 'Priya', familyName: 'Example', orgUnitPath: ONB.orgUnitPath,
    licenses: [{ productId: ONB.googleProduct, skuId: ONB.googleSku }], groupEmails: [ONB.googleGroup],
  },
});
/** Snapshot 1: both names verified free, the seat available, the groups described and ordinary. */
const ONBOARDING_CREATE_FACTS = {
  stage: 'create' as const,
  targets: { contactTargetId: ONB.contactTarget, contactLabel: ONB.displayName },
  collisions: { m365: { upnTaken: false, existingObjectId: null }, google: { emailTaken: false, existingUserId: null } },
  seats: { m365: [{ skuId: ONB.m365Sku, skuPartNumber: 'SPE_E3', state: 'available', available: 5, observedAt: '2026-09-17T09:59:00.000Z', reason: null }] },
  groups: {
    m365: [{ id: ONB.m365Group, name: 'All Staff', dynamic: false, roleAssignable: null }],
    google: [{ email: ONB.googleGroup, name: 'Staff', modelAfterRole: null }],
  },
  modelAfter: null,
  degradedTools: [],
  capabilityReadiness: {},
  flags: [],
  truncated: [],
};
/** Snapshot 2 = snapshot 1 + the accounts `resolve_accounts` froze (B2). */
const ONBOARDING_PROVISION_FACTS = {
  ...ONBOARDING_CREATE_FACTS,
  stage: 'provision' as const,
  accounts: {
    m365: { externalId: ONB.m365Oid, principalLabel: ONB.upn },
    google: { externalId: ONB.googleId, principalLabel: ONB.googleEmail },
  },
};
const ONBOARDING_CREATE_PLAN = buildIdentityOnboardingCreatePlan(ONBOARDING_INPUT, ONBOARDING_CREATE_FACTS);
const ONBOARDING_PROVISION_PLAN = buildIdentityOnboardingProvisionPlan(ONBOARDING_INPUT, ONBOARDING_PROVISION_FACTS);

/** The two closed catalogs that drive this suite. */
const CATALOGS = [
  { recipeKey: 'identity_offboarding', tools: IDENTITY_OFFBOARDING_EFFECT_TOOLS, unobservable: IDENTITY_OFFBOARDING_UNOBSERVABLE_EFFECTS as Readonly<Record<string, string>> },
  { recipeKey: 'identity_onboarding', tools: IDENTITY_ONBOARDING_EFFECT_TOOLS, unobservable: IDENTITY_ONBOARDING_UNOBSERVABLE_EFFECTS as Readonly<Record<string, string>> },
] as const;
const ALL_TOOLS: readonly string[] = CATALOGS.flatMap((c) => [...c.tools]);

/** Each tool's planned effect, and the effect step it is dispatched at. */
const EFFECT_FOR = new Map<string, PlannedEffect>([
  ...PLAN.map((e) => [e.toolName, e] as const),
  ...ONBOARDING_CREATE_PLAN.map((e) => [e.toolName, e] as const),
  ...ONBOARDING_PROVISION_PLAN.map((e) => [e.toolName, e] as const),
]);
const STEP_FOR = new Map<string, string>([
  ...PLAN.map((e) => [e.toolName, 'effects'] as const),
  ...ONBOARDING_CREATE_PLAN.map((e) => [e.toolName, 'create_accounts'] as const),
  ...ONBOARDING_PROVISION_PLAN.map((e) => [e.toolName, 'provision_effects'] as const),
]);

const NOW = new Date('2026-09-17T10:00:00.000Z');
const ORG = '00000000-0000-4000-8000-0000000f0001';
const TASK = { id: '00000000-0000-4000-8000-0000000f00a1', orgId: ORG, attemptOrdinal: 0 };
const APPROVAL = { id: 'p1', planRevision: 1, approverUserId: 'u-approver' };

function stepKeyFor(toolName: string): string {
  const s = STEP_FOR.get(toolName);
  if (!s) throw new Error(`no recipe plans ${toolName}`);
  return s;
}

/** Spec §6.6 classes this recipe's gate expects; the code must agree (property 5). */
const EXPECTED_CLASS: Readonly<Record<string, 'idempotent' | 'idempotent_by_probe' | 'non_idempotent'>> = {
  google_set_vacation: 'idempotent_by_probe',
  google_set_forwarding: 'idempotent_by_probe',
  google_add_mail_delegate: 'idempotent_by_probe',
  m365_revoke_sessions: 'idempotent_by_probe',
  m365_set_auto_reply: 'idempotent_by_probe',
  google_remove_from_group: 'idempotent',
  google_remove_license: 'idempotent',
  google_suspend_user: 'idempotent',
  google_signout: 'idempotent',
  m365_disable_user: 'idempotent',
  m365_remove_license: 'idempotent',
  m365_remove_from_group: 'idempotent',
  m365_retire_intune_device: 'idempotent',
  // Unclassified in EFFECT_IDEMPOTENCY, so the strictest default (deviation G9).
  google_account_wipe_mobile_device: 'non_idempotent',
  // identity_onboarding (spec §6.6; R2a Task 6 classified the Google three).
  m365_create_user: 'non_idempotent',
  m365_assign_license: 'idempotent_by_probe',
  m365_add_to_group: 'idempotent',
  google_move_ou: 'idempotent',
  google_assign_license: 'idempotent_by_probe',
  google_add_to_group: 'idempotent',
};

/**
 * The provider WRITE call each tool's executor must make, by fixture key. The
 * test states this, not the fixture: a fixture that recorded a different call
 * would not make the executor issue it.
 */
const WRITE_CALL: Readonly<Record<string, string>> = {
  google_set_vacation: 'gmail.settings.updateVacation',
  google_set_forwarding: 'gmail.settings.updateAutoForwarding',
  google_add_mail_delegate: 'gmail.settings.delegates.create',
  google_remove_from_group: 'directory.members.delete',
  google_remove_license: 'licensing.licenseAssignments.delete',
  google_account_wipe_mobile_device: 'directory.mobiledevices.action',
  google_signout: 'directory.users.signOut',
  google_suspend_user: 'directory.users.update',
  google_move_ou: 'directory.users.update',
  google_assign_license: 'licensing.licenseAssignments.insert',
  google_add_to_group: 'directory.members.insert',
  ...Object.fromEntries(Object.entries(M365_HEADLESS_ACTIONS).map(([tool, actionId]) => [tool, `write:${actionId}`])),
};

/** The Entra object id the protected-dispatch pin resolves to; differs from the plan's userIdentifier on purpose. */
const PINNED_OID = '00000000-0000-4000-8000-0000000a0099';

/**
 * The arguments each tool's provider WRITE call must carry: the plan's own
 * identities, stated here (never in the fixture), so a write aimed at the
 * wrong user, group, licence, device or mailbox fails. `mailbox` is the
 * impersonated Gmail owner.
 */
const WRITE_ARGS: Readonly<Record<string, { args: Record<string, unknown>; mailbox?: string }>> = {
  google_set_vacation: {
    mailbox: ID.googleEmail,
    args: { userId: 'me', requestBody: { enableAutoReply: true, responseBodyPlainText: ID.message } },
  },
  google_set_forwarding: {
    mailbox: ID.googleEmail,
    args: { userId: 'me', requestBody: { enabled: true, emailAddress: ID.destination } },
  },
  google_add_mail_delegate: { mailbox: ID.googleEmail, args: { userId: 'me', requestBody: { delegateEmail: ID.destination } } },
  google_remove_from_group: { args: { groupKey: ID.googleGroup, memberKey: ID.googleEmail } },
  google_remove_license: { args: { productId: ID.googleProduct, skuId: ID.googleSku, userId: ID.googleEmail } },
  // The SELECTIVE account wipe, never `admin_remote_wipe` (a factory reset; D-R1-1).
  google_account_wipe_mobile_device: {
    args: { customerId: 'my_customer', resourceId: 'md-res-1', requestBody: { action: 'admin_account_wipe' } },
  },
  google_signout: { args: { userKey: ID.googleEmail } },
  google_suspend_user: { args: { userKey: ID.googleEmail, requestBody: { suspended: true } } },
  m365_set_auto_reply: {
    args: { type: 'm365.user.mailbox.auto_reply', userIdentifier: ID.m365Oid, status: 'alwaysEnabled', externalAudience: 'all' },
  },
  m365_remove_from_group: { args: { type: 'm365.group.membership.remove', groupId: ID.m365Group, userIdentifier: ID.m365Oid } },
  m365_remove_license: { args: { type: 'm365.user.license.remove', userIdentifier: ID.m365Oid, skuIds: [ID.m365Sku] } },
  m365_retire_intune_device: { args: { type: 'm365.intune.device.retire', managedDeviceId: ID.m365Device } },
  m365_revoke_sessions: { args: { type: 'm365.user.revoke_sessions', userIdentifier: ID.m365Oid } },
  // Caller-protected: the PINNED object id, never the identifier the plan carries.
  m365_disable_user: { args: { type: 'm365.user.disable', oid: PINNED_OID } },
  // identity_onboarding. The create carries the REQUESTED name and nothing an
  // approver did not see; every provisioning write addresses the RESOLVED
  // account (the immutable Entra object id; Google's frozen primary email).
  m365_create_user: {
    args: { type: 'm365.user.create', userPrincipalName: ONB.upn, displayName: ONB.displayName, mailNickname: 'priya', usageLocation: 'US' },
  },
  m365_assign_license: { args: { type: 'm365.user.license.assign', userIdentifier: ONB.m365Oid, skuIds: [ONB.m365Sku] } },
  m365_add_to_group: { args: { type: 'm365.group.membership.add', groupId: ONB.m365Group, userIdentifier: ONB.m365Oid } },
  google_move_ou: { args: { userKey: ONB.googleEmail, requestBody: { orgUnitPath: ONB.orgUnitPath } } },
  google_assign_license: { args: { productId: ONB.googleProduct, skuId: ONB.googleSku, requestBody: { userId: ONB.googleEmail } } },
  // MEMBER, pinned in the approved arguments (D-R2-9) and carried to the write.
  google_add_to_group: { args: { groupKey: ONB.googleGroup, requestBody: { email: ONB.googleEmail, role: 'MEMBER' } } },
};

/** The error code each Google executor must return on its recorded refusal. */
const GOOGLE_REFUSAL_CODE: Readonly<Record<string, string>> = {
  google_set_vacation: 'google_forbidden',
  google_set_forwarding: 'forwarding_pending_verification',
  google_add_mail_delegate: 'google_forbidden',
  google_remove_from_group: 'google_forbidden',
  google_remove_license: 'google_not_found',
  google_account_wipe_mobile_device: 'google_not_found',
  google_signout: 'google_forbidden',
  google_suspend_user: 'google_forbidden',
  google_move_ou: 'google_error',
  google_assign_license: 'google_error',
  google_add_to_group: 'google_forbidden',
};

/**
 * Tools whose replay, observing the already-done world, re-requests the same
 * operation rather than settling noop. Stated here, not derived from the
 * fixture: three have no pre-write `satisfied` at all, and a retired Intune
 * device whose record Intune has since DELETED (`graph_not_found`) is post-write
 * evidence only — before a write a 404 can also mean a wrong id.
 */
const REPLAY_REQUESTS_SAME_OPERATION: ReadonlySet<string> = new Set([
  'google_signout', 'm365_set_auto_reply', 'm365_remove_from_group', 'm365_retire_intune_device',
  // Its membership probe answers `unknown` before any write (eventual index), like the removal.
  'm365_add_to_group',
]);

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

const capturePlan: Record<string, Record<string, string[]>> = {};

function use(fixture: Fixture, phase: 'preSatisfied' | 'preUnsatisfied' | 'writeOk' | 'postSatisfied' | 'writeRefusal'): void {
  const world = phase === 'preSatisfied' ? fixture.preSatisfied : fixture[phase];
  if (!world) throw new Error(`fixture ${fixture.toolName} has no ${phase} shape`);
  h.state.world = world;
  h.state.phase = phase;
  h.state.tool = fixture.toolName;
}

/** Collect the calls made under the current phase, for the capture plan and for assertions. */
function drainCalls(): { key: string; args: unknown }[] {
  const calls = h.state.calls.splice(0);
  const perTool = (capturePlan[h.state.tool] ??= {});
  const keys = (perTool[h.state.phase] ??= []);
  for (const c of calls) if (!keys.includes(c.key)) keys.push(c.key);
  return calls;
}

function effectFor(toolName: string): PlannedEffect {
  const e = EFFECT_FOR.get(toolName);
  if (!e) throw new Error(`the recipe's plan does not contain ${toolName}`);
  return e;
}

function dispatch(effect: PlannedEffect, approval: typeof APPROVAL = APPROVAL) {
  return dispatchPlannedEffect({ task: TASK, stepKey: stepKeyFor(effect.toolName), approval, effect, partnerId: null, now: NOW });
}

function verify(effect: PlannedEffect) {
  return verifyDispatchedEffect({
    task: TASK, planRevision: APPROVAL.planRevision, effect,
    idempotencyClass: classifyEffectIdempotency(effect.toolName), effectRequestedAt: NOW,
  });
}

function runWrite(effect: PlannedEffect): Promise<string> {
  const args = effect.canonicalArguments as Record<string, unknown>;
  return effect.provider === 'google'
    ? executeGoogleToolHeadless(effect.toolName, args, ORG)
    : executeM365ToolHeadless(effect.toolName, args, ORG, 'intent-1');
}

function parsedError(result: string): string | null {
  try {
    const v = JSON.parse(result) as { error?: unknown };
    return typeof v?.error === 'string' ? v.error : null;
  } catch {
    return null; // Google success results are prose, not JSON.
  }
}

const unobservable = (tool: string) => CATALOGS.some((c) => (c.tools as readonly string[]).includes(tool) && Object.hasOwn(c.unobservable, tool));

/** No probe swallowed an error into `unknown`, and no call went unanswered by the fixture. */
function expectClean(): void {
  expect(h.state.gaps, 'fixture gaps').toEqual([]);
  expect(h.captureException).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  h.inserted.length = 0;
  h.state.calls.length = 0;
  h.state.gaps.length = 0;
  h.state.impersonated.length = 0;
  h.state.world = null;
  h.checkPlanEffectMembershipSystem.mockImplementation(async (input: { toolName: string }) => ({
    ok: true, approvalId: APPROVAL.id, approverUserId: APPROVAL.approverUserId, approvedAssuranceLevel: 3,
    planRevision: APPROVAL.planRevision,
    // The approval row stores the class `proposePlanApproval` derived from this same function.
    idempotencyClass: classifyEffectIdempotency(input.toolName),
  }));
  h.createActionIntent.mockImplementation(async () => ({ id: 'i1', status: 'approved' }));
  h.loadM365MutationContext.mockImplementation(async () => ({
    intent: { id: 'intent-1', requestedByUserId: null },
    ctx: { backend: 'controlPlane', orgId: ORG, connectionId: 'conn-1' },
    // Deliberately NOT the plan's userIdentifier: the write must go to the pin.
    userId: PINNED_OID,
  }));
});

afterAll(() => {
  if (!RECORD_CAPTURE_PLAN) return;
  // The lab operator captures exactly these provider responses (README, "Recording").
  console.log(`[effect-contract capture plan]\n${JSON.stringify(capturePlan, null, 2)}`);
});

// ---------------------------------------------------------------------------
// The suite, driven off the two catalog constants
// ---------------------------------------------------------------------------

describe('the catalogs drive the suite', () => {
  it('identity_offboarding plans exactly one effect per catalog tool for the full-catalog facts', () => {
    expect(PLAN.map((e) => e.toolName).sort()).toEqual([...IDENTITY_OFFBOARDING_EFFECT_TOOLS].sort());
    expect(IDENTITY_OFFBOARDING_EFFECT_TOOLS.length).toBeGreaterThan(0);
  });

  it('identity_onboarding plans each catalog tool exactly once, create tools in stage 1 and provisioning tools in stage 2', () => {
    expect(ONBOARDING_CREATE_PLAN.map((e) => e.toolName)).toEqual([...IDENTITY_ONBOARDING_CREATE_TOOLS]);
    expect(ONBOARDING_PROVISION_PLAN.map((e) => e.toolName)).toEqual([...IDENTITY_ONBOARDING_PROVISION_TOOLS]);
    expect([...ONBOARDING_CREATE_PLAN, ...ONBOARDING_PROVISION_PLAN].map((e) => e.toolName).sort())
      .toEqual([...IDENTITY_ONBOARDING_EFFECT_TOOLS].sort());
    // The secrecy split the two approvals rest on (D-R2-2): every create tool
    // is secret-bearing, no provisioning tool is.
    expect(IDENTITY_ONBOARDING_CREATE_TOOLS.every(isSecretBearingTool)).toBe(true);
    expect(IDENTITY_ONBOARDING_PROVISION_TOOLS.some(isSecretBearingTool)).toBe(false);
  });

  it('the two catalogs are disjoint, so one fixture directory serves both', () => {
    expect(new Set(ALL_TOOLS).size).toBe(ALL_TOOLS.length);
  });

  it('there is exactly one fixture file per catalog tool across both catalogs, and no orphan', () => {
    const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json')).sort();
    expect(files).toEqual(ALL_TOOLS.map((t) => `${t}.json`).sort());
  });

  it('every fixture labels its provenance honestly (reference shape or a dated lab run)', () => {
    for (const tool of ALL_TOOLS) {
      const f = loadFixture(tool);
      if (f._source === 'reference') expect(f._recordedFrom, tool).toMatch(/^reference: /);
      else expect(f._recordedFrom, tool).toBe(f._source);
      expect(f.provider, tool).toBe(effectFor(tool).provider);
    }
  });

  it('the create fixture\'s pre-probe "satisfied" world is labelled a COLLISION, never "already done"', () => {
    const f = loadFixture('m365_create_user');
    expect(f._meaning?.preSatisfied).toMatch(/COLLISION/);
    expect(f._meaning?.preSatisfied).toMatch(/HANDOFF, never a no-op/);
    // And it really is someone else: the holder is not the account the create returns.
    const holder = (f.preSatisfied!['read:m365.user.get'] as { resource: { id: string } }).resource.id;
    const created = (f.writeOk['write:m365.user.create'] as { result: { userId: string } }).result.userId;
    expect(holder).toBe(ONB.m365Holder);
    expect(holder).not.toBe(created);
    expect(created).toBe(ONB.m365Oid);
  });
});

for (const { recipeKey, tools } of CATALOGS) for (const toolName of tools) {
  describe(`effect contract: ${recipeKey} / ${toolName}`, () => {
    it('pre-probe satisfied → dispatches NO write (noop when idempotent, hand-off when not)', async () => {
      const f = loadFixture(toolName);
      const effect = effectFor(toolName);
      if (f.preSatisfied === null) {
        // The fixture claims the probe can never certify this effect before the
        // write. Prove the claim against the REAL probe with the already-done
        // world: it must not answer `satisfied`, so the write is never skipped.
        use(f, 'postSatisfied');
        const pre = await probeEffect(effect, {
          orgId: ORG, taskId: TASK.id, planRevision: 1, effectRequestedAt: NOW, phase: 'pre',
        });
        drainCalls();
        expect(pre.state, `${toolName}: ${f.preSatisfiedUnreachable}`).not.toBe('satisfied');
        expectClean();
        return;
      }
      use(f, 'preSatisfied');
      const out = await dispatch(effect);
      drainCalls();
      expectClean();
      expect(h.createActionIntent).not.toHaveBeenCalled();
      if (classifyEffectIdempotency(toolName) === 'non_idempotent') {
        expect(out.kind).toBe('handoff');
        expect(h.inserted).toHaveLength(0);
      } else {
        expect(out.kind).toBe('noop');
        expect(h.inserted).toHaveLength(1);
        expect(h.inserted[0]).toMatchObject({
          intentId: null, resultState: 'succeeded', result: expect.objectContaining({ noop: true }),
          taskStepKey: stepKeyFor(toolName),
        });
      }
    });

    it('pre-probe unsatisfied → dispatches the write, and the provider write succeeds on writeOk', async () => {
      const f = loadFixture(toolName);
      const effect = effectFor(toolName);
      use(f, 'preUnsatisfied');
      const out = await dispatch(effect);
      drainCalls();
      expectClean();
      expect(out).toMatchObject({ kind: 'dispatching', intentId: 'i1' });
      expect(h.createActionIntent).toHaveBeenCalledTimes(1);
      expect(h.createActionIntent.mock.calls[0]![1]).toMatchObject({
        toolName, input: effect.canonicalArguments,
        task: { taskId: TASK.id, taskStepKey: stepKeyFor(toolName) },
        planApproval: { approvalId: APPROVAL.id, ordinal: effect.ordinal },
      });

      // The write the release worker performs for this intent.
      use(f, 'writeOk');
      const result = await runWrite(effect);
      const calls = drainCalls();
      expectClean();
      expect(parsedError(result), `${toolName} write returned: ${result}`).toBeNull();
      // Exactly one provider write, aimed at the plan's own target.
      const writes = calls.filter((c) => c.key === WRITE_CALL[toolName]);
      expect(writes, `${toolName} must issue ${WRITE_CALL[toolName]} exactly once`).toHaveLength(1);
      expect(writes[0]!.args, `${toolName} write arguments`).toMatchObject(WRITE_ARGS[toolName]!.args);
      if (WRITE_ARGS[toolName]!.mailbox) {
        expect(new Set(h.state.impersonated), `${toolName} must act as the mailbox owner`).toEqual(new Set([WRITE_ARGS[toolName]!.mailbox]));
      }
      if (effect.provider === 'm365') {
        expect(calls.filter((c) => c.key.startsWith('write:'))).toHaveLength(1);
        // The recorded success is a well-formed executor result.
        expect(writeActionResultSchema.safeParse((f.writeOk[WRITE_CALL[toolName]!] as { result: unknown }).result).success).toBe(true);
        if (toolName === 'm365_disable_user') {
          // Caller-protected: the pinned id, and no identifier-based fallback.
          expect(writes[0]!.args).not.toHaveProperty('userIdentifier');
        }
      }
    });

    it('the provider write fails closed or returns an error on the recorded refusal — never a success', async () => {
      const f = loadFixture(toolName);
      const effect = effectFor(toolName);
      use(f, 'writeRefusal');
      if (effect.provider === 'google') {
        const result = await runWrite(effect);
        drainCalls();
        // The recorded refusal, not some other error (a fixture gap would also be `{ error }`).
        expectClean();
        expect(parsedError(result), `${toolName} refusal returned: ${result}`).toBe(GOOGLE_REFUSAL_CODE[toolName]);
        return;
      }
      const refusal = f.writeRefusal[WRITE_CALL[toolName]!] as { ok: false; code: string };
      expect(refusal.ok).toBe(false);
      if (refusal.code === 'consent_upgrade_required') {
        // Refused before any Graph call: fail closed as connection-unavailable.
        await expect(runWrite(effect)).rejects.toBeInstanceOf(M365ConnectionUnavailableError);
      } else {
        expect(writeActionFailureCodeSchema.safeParse(refusal.code).success, refusal.code).toBe(true);
        const result = await runWrite(effect);
        // The executor returns the service's own message for a Graph-level failure.
        expect(parsedError(result), `${toolName} refusal returned: ${result}`).toBe((refusal as unknown as { message: string }).message);
      }
      drainCalls();
      expectClean();
    });

    it('post-probe unsatisfied → the effect is NOT verified even though the write returned 200', async () => {
      const f = loadFixture(toolName);
      const effect = effectFor(toolName);
      use(f, 'writeOk');
      expect(parsedError(await runWrite(effect))).toBeNull();
      drainCalls();
      // The world did not change: the post-probe sees the pre-write state.
      use(f, 'preUnsatisfied');
      const out = await verify(effect);
      drainCalls();
      expectClean();
      expect(out.kind).not.toBe('verified');
      expect(out.kind).toBe(isStructurallyUnobservable(toolName) ? 'handoff' : 'unverified');
      if (out.kind === 'unverified') {
        // Only a non_idempotent effect is barred from a retry (the positive control for property 5).
        expect(out.retryable).toBe(classifyEffectIdempotency(toolName) !== 'non_idempotent');
      }
    });

    it('post-probe satisfied → verified (a declared unobservable effect is never verified)', async () => {
      const f = loadFixture(toolName);
      const effect = effectFor(toolName);
      use(f, 'postSatisfied');
      const out = await verify(effect);
      drainCalls();
      expectClean();
      if (unobservable(toolName)) {
        expect(isStructurallyUnobservable(toolName)).toBe(true);
        expect(out.kind).toBe('handoff');
      } else {
        expect(out).toMatchObject({ kind: 'verified' });
      }
    });

    it(REPLAY_REQUESTS_SAME_OPERATION.has(toolName)
      ? 'replay re-requests the SAME operation key (at-most-once is the operation index)'
      : 'replay performs the write exactly once', async () => {
      const f = loadFixture(toolName);
      const effect = effectFor(toolName);
      use(f, 'preUnsatisfied');
      expect((await dispatch(effect)).kind).toBe('dispatching');
      drainCalls();
      // The write landed; a replayed tick observes the done world.
      use(f, 'postSatisfied');
      const second = await dispatch(effect);
      drainCalls();
      expectClean();
      const key = planEffectOperationKey({
        stepKey: stepKeyFor(toolName), planRevision: APPROVAL.planRevision, toolName, targetId: effect.targetId, ordinal: effect.ordinal,
      });
      if (REPLAY_REQUESTS_SAME_OPERATION.has(toolName)) {
        // The pre-probe cannot certify the done world before a write, so the
        // replay re-requests the SAME operation: at-most-once is the permanent
        // (org, task, operation_key) index `createActionIntent` reserves in,
        // proven on real rows by aiOperatorEffectDispatchReplay.integration.test.ts.
        expect(second.kind).toBe('dispatching');
        const keys = h.createActionIntent.mock.calls.map((c) => (c[1] as { task: { operationKey: string } }).task.operationKey);
        expect(keys).toEqual([key, key]);
      } else {
        expect(second.kind).toBe(classifyEffectIdempotency(toolName) === 'non_idempotent' ? 'handoff' : 'noop');
        expect(h.createActionIntent).toHaveBeenCalledTimes(1);
      }
    });

    it('declares an idempotency class, and a non_idempotent one is never auto-retried', async () => {
      const cls = classifyEffectIdempotency(toolName);
      expect(['idempotent', 'idempotent_by_probe', 'non_idempotent']).toContain(cls);
      expect(cls).toBe(EXPECTED_CLASS[toolName]);
      if (cls !== 'non_idempotent') return;
      const f = loadFixture(toolName);
      const effect = effectFor(toolName);
      // An unknown pre-state hands off: nothing is sent.
      h.state.calls.length = 0;
      h.state.world = {};
      h.state.phase = 'unknown';
      h.state.tool = toolName;
      h.captureException.mockImplementation(() => undefined);
      const handed = await dispatch(effect);
      expect(handed.kind).toBe('handoff');
      expect(h.createActionIntent).not.toHaveBeenCalled();
      // The empty world above was deliberate; clear its gaps before the next phase.
      h.state.calls.length = 0;
      h.state.gaps.length = 0;
      // A post-write unsatisfied is never retryable.
      use(f, 'preUnsatisfied');
      const out = await verify(effect);
      drainCalls();
      expect(out).toMatchObject({ kind: 'unverified', retryable: false });
    });
  });
}

describe('the unobservable exceptions are explicit, not accidental', () => {
  it('google_signout probes `unknown` in BOTH phases and names its subsuming criterion', async () => {
    const effect = effectFor('google_signout');
    h.state.world = {};
    for (const phase of ['pre', 'post'] as const) {
      const r = await probeEffect(effect, { orgId: ORG, taskId: TASK.id, planRevision: 1, effectRequestedAt: NOW, phase });
      expect(r.state).toBe('unknown');
    }
    expect(h.state.calls).toHaveLength(0); // structurally: no provider call at all
    expect(isStructurallyUnobservable('google_signout')).toBe(true);
    expect(IDENTITY_OFFBOARDING_UNOBSERVABLE_EFFECTS.google_signout).toBe('google_suspend_user');
    expect(IDENTITY_OFFBOARDING_EFFECT_TOOLS).toContain('google_suspend_user');
  });

  it('every tool in either catalog either has a probe registered or is declared unobservable', () => {
    const probed = new Set(listProbedTools());
    for (const { recipeKey, tools, unobservable: declaredMap } of CATALOGS) {
      for (const t of tools) {
        const declared = Object.hasOwn(declaredMap, t);
        expect(probed.has(t) || declared, `${recipeKey}: ${t} has neither a probe nor an unobservable declaration`).toBe(true);
        // And no OTHER catalog tool is quietly structurally unobservable.
        if (!declared) expect(isStructurallyUnobservable(t), `${recipeKey}: ${t}`).toBe(false);
      }
    }
  });

  it('identity_onboarding declares NO unobservable effect: every one of its tools is verified by a real probe (D-R2-11)', () => {
    expect(Object.keys(IDENTITY_ONBOARDING_UNOBSERVABLE_EFFECTS)).toEqual([]);
    const probed = new Set(listProbedTools());
    for (const t of IDENTITY_ONBOARDING_EFFECT_TOOLS) expect(probed.has(t), t).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Property 6: the non_idempotent pre-probe rule (D-R2-4), driven off the
// classification over BOTH catalogs, so it cannot hold for m365_create_user alone.
// ---------------------------------------------------------------------------

const NON_IDEMPOTENT_TOOLS = ALL_TOOLS.filter((t) => classifyEffectIdempotency(t) === 'non_idempotent');

describe('the non_idempotent pre-probe rule, over every non_idempotent tool in either catalog (D-R2-4)', () => {
  it('the classification finds the create, and the offboarding wipe (strictest default)', () => {
    // A vacuity guard: an empty list would make every case below pass.
    expect(NON_IDEMPOTENT_TOOLS).toEqual(expect.arrayContaining(['m365_create_user', 'google_account_wipe_mobile_device']));
  });

  for (const toolName of NON_IDEMPOTENT_TOOLS) {
    it(`${toolName}: dispatches ONLY on unsatisfied; hands off on unknown AND on satisfied, minting nothing and writing no operation row`, async () => {
      const f = loadFixture(toolName);
      const effect = effectFor(toolName);

      // satisfied → hand-off (never a noop: a noop would be a succeeded operation row).
      expect(f.preSatisfied, `${toolName} must record a satisfied pre-world for this rule to be exercised`).not.toBeNull();
      use(f, 'preSatisfied');
      const onSatisfied = await dispatch(effect);
      drainCalls();
      expectClean();
      expect(onSatisfied.kind).toBe('handoff');
      expect(h.createActionIntent).not.toHaveBeenCalled();
      expect(h.inserted, 'no operation row on the satisfied hand-off').toHaveLength(0);

      // unknown → hand-off. An empty world makes every read a gap, which the
      // registry turns into `unknown`; the gaps are the point, so clear them.
      h.state.world = {};
      h.state.phase = 'unknown';
      h.state.tool = toolName;
      h.captureException.mockImplementation(() => undefined);
      const onUnknown = await dispatch(effect);
      h.state.calls.length = 0;
      h.state.gaps.length = 0;
      expect(onUnknown.kind).toBe('handoff');
      expect(h.createActionIntent).not.toHaveBeenCalled();
      expect(h.inserted, 'no operation row on the unknown hand-off').toHaveLength(0);
      h.captureException.mockReset();

      // unsatisfied → the ONLY answer that dispatches.
      use(f, 'preUnsatisfied');
      const onUnsatisfied = await dispatch(effect);
      drainCalls();
      expectClean();
      expect(onUnsatisfied).toMatchObject({ kind: 'dispatching', intentId: 'i1' });
      expect(h.createActionIntent).toHaveBeenCalledTimes(1);
    });
  }

  it('the create\'s satisfied hand-off names a COLLISION, not "already done"', async () => {
    use(loadFixture('m365_create_user'), 'preSatisfied');
    const out = await dispatch(effectFor('m365_create_user'));
    drainCalls();
    expectClean();
    expect(out.kind).toBe('handoff');
    if (out.kind === 'handoff') expect(out.handoffSummary).toMatch(/collision/i);
  });
});

// ---------------------------------------------------------------------------
// Property 7: the create is never retried, asserted on operation rows
// ---------------------------------------------------------------------------

describe('m365_create_user is issued at most once, ever — even under a fresh operation key', () => {
  it('a second dispatch at a LATER plan revision (a new operation key) observes the created account and mints nothing', async () => {
    const f = loadFixture('m365_create_user');
    const effect = effectFor('m365_create_user');

    // Pass 1, revision r: the world has no such user, so the create is minted.
    use(f, 'preUnsatisfied');
    expect((await dispatch(effect)).kind).toBe('dispatching');
    drainCalls();
    const keyAtR = planEffectOperationKey({
      stepKey: 'create_accounts', planRevision: APPROVAL.planRevision, toolName: effect.toolName, targetId: effect.targetId, ordinal: effect.ordinal,
    });

    // Pass 2, revision r+1: a different operation key, so the permanent
    // (org, task, operation_key) index CANNOT be what stops a second create.
    // The account now exists; the pre-probe must.
    const later = { ...APPROVAL, id: 'p2', planRevision: APPROVAL.planRevision + 1 };
    const keyAtR1 = planEffectOperationKey({
      stepKey: 'create_accounts', planRevision: later.planRevision, toolName: effect.toolName, targetId: effect.targetId, ordinal: effect.ordinal,
    });
    expect(keyAtR1, 'the second pass really uses a fresh key').not.toBe(keyAtR);
    use(f, 'postSatisfied');
    const second = await dispatch(effect, later);
    drainCalls();
    expectClean();
    expect(second.kind).toBe('handoff');

    // The operation rows and mints, not a call count on a provider mock:
    // one mint, under the revision-r key, and no operation row written by
    // either hand-off (a noop row would read as a succeeded second create).
    const mintedKeys = h.createActionIntent.mock.calls.map((c) => (c[1] as { task: { operationKey: string } }).task.operationKey);
    expect(mintedKeys).toEqual([keyAtR]);
    expect(h.inserted).toEqual([]);
  });

  it('a create whose post-probe does not see the account is unverified and NOT retryable', async () => {
    use(loadFixture('m365_create_user'), 'preUnsatisfied');
    const out = await verify(effectFor('m365_create_user'));
    drainCalls();
    expectClean();
    expect(out).toMatchObject({ kind: 'unverified', retryable: false });
  });
});

// ---------------------------------------------------------------------------
// No fixture carries a credential
// ---------------------------------------------------------------------------

/**
 * The executor's generator (`generateTemporaryPassword`, the M365 actions
 * executor) emits 20 non-space characters mixing lower case, upper case and
 * digits. Anything of that shape in a checked-in fixture would be a real
 * secret in a public repo.
 */
const CREDENTIAL_SHAPE = /^(?=\S*[a-z])(?=\S*[A-Z])(?=\S*\d)\S{16,}$/;
const CREDENTIAL_KEY = /pass(word)?|secret|token|credential|apikey|privatekey/i;
const SYNTHETIC_CREDENTIAL = 'REDACTED-FIXTURE-VALUE';

function stringsIn(value: unknown, path: string, out: { path: string; key: string; value: string }[]): void {
  if (typeof value === 'string') { out.push({ path, key: path.split('.').at(-1) ?? '', value }); return; }
  if (Array.isArray(value)) { value.forEach((v, i) => stringsIn(v, `${path}.${i}`, out)); return; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) stringsIn(v, path ? `${path}.${k}` : k, out);
  }
}

describe('no fixture contains credential-shaped material', () => {
  it('every credential-named field holds the synthetic marker, and no string anywhere has a generated-credential shape', () => {
    const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(ALL_TOOLS.length);
    const findings: string[] = [];
    let markers = 0;
    for (const file of files) {
      const strings: { path: string; key: string; value: string }[] = [];
      stringsIn(JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8')), '', strings);
      for (const s of strings) {
        if (CREDENTIAL_KEY.test(s.key)) {
          if (s.value === SYNTHETIC_CREDENTIAL) markers += 1;
          else findings.push(`${file}:${s.path} is credential-named and not the synthetic marker`);
        }
        if (CREDENTIAL_SHAPE.test(s.value)) findings.push(`${file}:${s.path} has a generated-credential shape`);
      }
    }
    expect(findings).toEqual([]);
    // Non-vacuity: the scan reached the create's success body.
    expect(markers).toBeGreaterThanOrEqual(1);
  });

  it('the create-success fixture\'s temporaryPassword is the literal synthetic marker', () => {
    const f = loadFixture('m365_create_user');
    expect((f.writeOk['write:m365.user.create'] as { result: { temporaryPassword: string } }).result.temporaryPassword)
      .toBe(SYNTHETIC_CREDENTIAL);
  });

  it('the shape check is live: a generated-shape value is caught (control)', () => {
    // Fixed sample in the generator's shape; not a credential for anything.
    expect(CREDENTIAL_SHAPE.test('xK7pQ2mZ9vR4tL8wN3bY')).toBe(true);
    expect(CREDENTIAL_SHAPE.test(SYNTHETIC_CREDENTIAL)).toBe(false);
    expect(CREDENTIAL_SHAPE.test(ONB.m365Oid)).toBe(false);
  });
});

describe('the recording harness never reaches production', () => {
  const API_SRC = fileURLToPath(new URL('../../', import.meta.url));
  const TEST_ONLY_ENV = ['BREEZE_RECORD_PROVIDER_FIXTURES', 'BREEZE_EVAL_LIVE', 'BREEZE_GATE_SIGNOFF'];

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === '__tests__' || name === 'node_modules') continue;
        out.push(...walk(full));
        continue;
      }
      if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full);
    }
    return out;
  }

  it('the gate\'s test-only env vars are read only by *.test.ts files', () => {
    const files = walk(API_SRC);
    expect(files.length).toBeGreaterThan(100); // the walker really walked apps/api/src
    const hits = files.flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return TEST_ONLY_ENV.filter((name) => text.includes(name)).map((name) => `${file}: ${name}`);
    });
    expect(hits).toEqual([]);
  });
});

describe('every fixture is a recording, not a guess', () => {
  // One tripwire per recipe: each recipe's gate is signed off by its own lab
  // run (W06 Task 27; W07 Task 26), so one recipe's re-recording must not wait
  // on, or be masked by, the other's.
  for (const { recipeKey, tools } of CATALOGS) {
    it.skipIf(!GATE_SIGNOFF)(`GATE TRIPWIRE (BREEZE_GATE_SIGNOFF=1): no ${recipeKey} fixture is still marked _source: "reference"`, () => {
      // RED until that recipe's lab run (spec §9(e)) re-records every fixture.
      // That failure IS the gate. Do not edit `_source` to make it pass.
      const stillReference = tools.filter((t) => loadFixture(t)._source === 'reference');
      expect(stillReference).toEqual([]);
    });
  }
});
