/**
 * `identity_onboarding` — onboard one person into Microsoft 365 and/or Google
 * Workspace (Operator Recipe Library spec §6.3 last paragraph, §5.2, §6.4–§6.7;
 * W07 R2a, Amendment B1/B2/B4).
 *
 * PURE. Data plus pure functions, scanned by `purity.test.ts`: it may import
 * only `zod`, `@breeze/shared`, `../operationKey` and siblings. Discovery,
 * collision and seat reads, account resolution and dispatch all live OUTSIDE
 * `recipes/`.
 *
 * THE STAGING CONTRACT. Onboarding is offboarding's mirror with one inversion:
 * account creation is FIRST. A provisioning effect addresses the account by
 * its immutable external id (spec §5.2), and that id does not exist until the
 * create has settled, so the plan comes in two stages at two plan revisions,
 * each the plan of ONE `effect` step (B1):
 *
 *  - Stage 1, `create_accounts` at revision r, plans from snapshot 1
 *    (`discover`, `stage: 'create'`). `buildIdentityOnboardingCreatePlan`
 *    emits at most one effect per provider Breeze can create accounts on —
 *    today only `m365_create_user` (Google has no create tool, D-R2-3). Its
 *    arguments come from the input; only `targetId` comes from the facts.
 *    Every effect in it is secret-bearing.
 *  - Stage 2, `provision_effects` at revision r+1, plans from snapshot 2
 *    (`resolve_accounts`, `stage: 'provision'`, snapshot 1 plus `accounts`).
 *    `buildIdentityOnboardingProvisionPlan` emits the licence, group and OU
 *    effects in `EFFECT_PROVIDER_ORDER`, each addressed by the RESOLVED
 *    account. No effect in it is secret-bearing.
 *
 * `buildPlan` dispatches on `facts.stage` and nothing else (B2) — never on
 * "does any account exist", which a half-resolved pair would answer wrongly.
 * It parses the facts with a STRICT schema and THROWS on anything malformed,
 * so effect dispatch's build-failure policy decides what happens; malformed
 * facts are never read as an empty plan.
 *
 * THE COLLISION GATE IS PER PROVIDER AND STRICT (B1, B.0 item 12). The M365
 * create is planned only when snapshot 1 recorded `upnTaken === false`. `true`
 * (someone holds the UPN) and `null` (the check could not run) both omit it
 * and become manual items. A Google collision never touches the M365 create.
 *
 * WHAT THE PLAN NEVER CONTAINS:
 *  - a Google create effect: no tool exists. The `manual_create_google` step
 *    does it by hand (`buildManualCreateGoogleItem`).
 *  - a password reset: the credential is minted inside `m365_create_user`'s
 *    own sealed result; a reset would be a second credential and a second
 *    non-idempotent effect.
 *  - a known-dynamic or role-assignable-true M365 group, or a Google group the
 *    model-after person owns or manages: always human work, with a reason.
 *  - a SKU whose frozen seat state is not `available` (B6).
 *  - mailbox settings, delegation or forwarding: not onboarding work.
 */
import { z } from 'zod';
import {
  identityOnboardingConfirmOutputSchema,
  identityOnboardingInputSchema,
  identityOnboardingReviewOutputSchema,
  onboardingProviders,
  type IdentityOnboardingInput,
} from '@breeze/shared';
import { buildTaskOperationKey } from '../operationKey';
import { capabilityForTool, HELPDESK_ALLOWLIST_CAPABILITY } from './capabilityMap';
import { EFFECT_PROVIDER_ORDER, MANUAL_WORK_MAX_ITEMS } from './identityOffboarding';
import type {
  CapabilityRequirement,
  DiscoveryFacts,
  EffectProvider,
  NextStepContext,
  PlannedEffect,
  RecipeBounds,
  RecipeDefinition,
  RecipeManualWorkItem,
} from './types';

export const IDENTITY_ONBOARDING_WORKFLOW_KEY = 'identity_onboarding' as const;
export const IDENTITY_ONBOARDING_WORKFLOW_VERSION = 1 as const;
/** Bump whenever `taskContextOnboarding.ts`'s rendering changes (see serviceRecovery.ts). */
export const IDENTITY_ONBOARDING_PROMPT_VERSION = 'identity_onboarding/v1' as const;

/** The spine (B1). Two `effect` steps, one per plan revision; no approval steps. */
export const IDENTITY_ONBOARDING_STEP_KEYS = Object.freeze([
  'intake', 'confirm_details', 'discover', 'review', 'create_accounts',
  'manual_create_google', 'resolve_accounts', 'provision_effects', 'wait_start',
  'manual_work', 'verify_outcome', 'document',
] as const);
export type IdentityOnboardingStepKey = (typeof IDENTITY_ONBOARDING_STEP_KEYS)[number];

/**
 * STAGE 1's catalog. Every entry is secret-bearing, which keeps the creation
 * approval a single-secrecy-kind set and the credential on its own child
 * intent's sealed result.
 *
 * One entry: Breeze has no Google create-user tool (D-R2-3). When
 * `google_create_user` ships, add it here and retire `manual_create_google`
 * and the `google.account.create` capability.
 */
export const IDENTITY_ONBOARDING_CREATE_TOOLS = Object.freeze(['m365_create_user'] as const);

/** STAGE 2's catalog, in plan order within each provider. No entry is secret-bearing. */
export const IDENTITY_ONBOARDING_PROVISION_TOOLS = Object.freeze([
  // Google. OU first: it decides which policies apply to everything after it.
  'google_move_ou',
  'google_assign_license',
  'google_add_to_group',
  // M365. Licence before membership: a group add refused at dispatch then
  // never costs the licence (Amendment Task 7).
  'm365_assign_license',
  'm365_add_to_group',
] as const);

/**
 * The CLOSED catalog, six tools. `buildPlan` may emit nothing else, readiness
 * maps every entry to a capability, and the agent-allowlist capability names
 * exactly this list.
 */
export const IDENTITY_ONBOARDING_EFFECT_TOOLS = Object.freeze([
  ...IDENTITY_ONBOARDING_CREATE_TOOLS,
  ...IDENTITY_ONBOARDING_PROVISION_TOOLS,
] as const);

/**
 * EMPTY, and that is an assertion (D-R2-11). Every tool above has a real
 * probe: M1 gives the three M365 actions criteria and R2 Task 5 adds the three
 * Google ones. A future tool with no observable end state must be declared
 * here with its subsumer rather than reach `verify_outcome` unasserted.
 */
export const IDENTITY_ONBOARDING_UNOBSERVABLE_EFFECTS: Readonly<Record<string, never>> = Object.freeze({});

/**
 * Spec §6.7. 14 days like offboarding: a start date is routinely a week or
 * more after the ticket, and `wait_start` must fit inside the task's deadline
 * (admission refuses a startAt beyond it, Task 10).
 */
export const IDENTITY_ONBOARDING_BOUNDS: RecipeBounds = Object.freeze({
  maxReasoningRuns: 6,
  maxMutationAttempts: 2,
  freshnessSeconds: 900,
  observeWakeAfterMs: 60_000,
  verificationWakeAfterMs: 120_000,
  unknownEffectHorizonMs: 60 * 60 * 1000,
  deadlineMs: 14 * 24 * 60 * 60 * 1000,
});

/**
 * Ten capabilities. `m365.graph.*` are `permission_grant` because M1's role
 * readiness gives a real per-role answer; `google.tool.*` are `agent_tool`
 * because Google's authority is domain-wide delegation granted at connection
 * time. This mirrors R1's split.
 */
export const IDENTITY_ONBOARDING_CAPABILITIES: readonly CapabilityRequirement[] = Object.freeze([
  { key: 'm365.connection', kind: 'provider_connection', provider: 'm365',
    detail: 'Connect Microsoft 365 for this organization.' },
  { key: 'm365.graph.user_create', kind: 'permission_grant', provider: 'm365',
    detail: 'Creating Microsoft 365 accounts (User.ReadWrite.All). Re-consent Microsoft 365.',
    toolNames: ['m365_create_user'] },
  { key: 'm365.graph.license_assign', kind: 'permission_grant', provider: 'm365',
    detail: 'Assigning Microsoft 365 licences (User.ReadWrite.All). Re-consent Microsoft 365.',
    toolNames: ['m365_assign_license'] },
  { key: 'm365.graph.group_membership_write', kind: 'permission_grant', provider: 'm365',
    detail: 'Adding Microsoft 365 group memberships (GroupMember.ReadWrite.All). Re-consent Microsoft 365.',
    toolNames: ['m365_add_to_group'] },

  { key: 'google.workspace.connection', kind: 'provider_connection', provider: 'google',
    detail: 'Connect Google Workspace for this organization.' },
  { key: 'google.tool.org_unit_write', kind: 'agent_tool', provider: 'google',
    detail: 'Moving a Google user into an organizational unit.', toolNames: ['google_move_ou'] },
  { key: 'google.tool.license_write', kind: 'agent_tool', provider: 'google',
    detail: 'Assigning Google Workspace licences.', toolNames: ['google_assign_license'] },
  { key: 'google.tool.group_membership_write', kind: 'agent_tool', provider: 'google',
    detail: 'Adding Google group memberships.', toolNames: ['google_add_to_group'] },

  // D-R2-3: no Google create-user tool exists, so nothing a tenant can do
  // makes this satisfied. `always_manual`: it degrades to the
  // `manual_create_google` step and does NOT hold the recipe at
  // `setup_required`. It names no tool because there is none to gate.
  // WHEN `google_create_user` SHIPS: make this an `agent_tool` capability naming
  // it, add the tool to IDENTITY_ONBOARDING_CREATE_TOOLS, and retire the step.
  { key: 'google.account.create', kind: 'tool_source', provider: 'google',
    availability: 'always_manual',
    detail: 'Breeze cannot create Google Workspace accounts yet. This step is done by hand, with generated instructions on the ticket.' },

  { key: HELPDESK_ALLOWLIST_CAPABILITY, kind: 'agent_tool', provider: null,
    detail: 'The helpdesk agent must be allowed to use the identity tools this recipe dispatches.',
    toolNames: [...IDENTITY_ONBOARDING_EFFECT_TOOLS] },
] satisfies CapabilityRequirement[]);

// ---------------------------------------------------------------------------
// The facts contract (B2 "Strict facts")
// ---------------------------------------------------------------------------

const idString = z.string().min(1).max(255);
const labelString = z.string().min(1).max(512);

/**
 * Snapshot 1's M365 collision pre-read. `upnTaken` is three-way (Amendment
 * Task 7): `false` = not found, `true` = someone holds the UPN (with their
 * object id), `null` = the check could not run. The record itself is `null`
 * when M365 is not in scope.
 */
const m365CollisionSchema = z.object({
  upnTaken: z.boolean().nullable(),
  existingObjectId: idString.nullable(),
}).strict();
const googleCollisionSchema = z.object({
  emailTaken: z.boolean().nullable(),
  existingUserId: idString.nullable(),
}).strict();

/** B6: one requested SKU's live seat evidence, frozen. Only `available` is planned. */
export const ONBOARDING_SEAT_STATES = Object.freeze(['available', 'unavailable', 'not_subscribed', 'unknown'] as const);
const seatSchema = z.object({
  skuId: z.string().min(1).max(64),
  /** Null when the SKU was not seen (absent from the subscribed list). */
  skuPartNumber: z.string().min(1).max(128).nullable(),
  state: z.enum(ONBOARDING_SEAT_STATES),
  /** `prepaidUnits.enabled − consumedUnits`; null when the counts were missing or malformed. Never read as 0. */
  available: z.number().int().nullable(),
  observedAt: z.string().datetime(),
  /** Why the state is not `available`, in words (e.g. the read refusal). */
  reason: z.string().min(1).max(500).nullable(),
}).strict();

/**
 * A requested M365 group as discovery saw it. `roleAssignable` is `null`
 * (unknown) in practice: no shipped read projects `isAssignableToRole`
 * (B.0 item 15), and `false` would claim the group is safe to edit. A `null`
 * group is planned; the executor's pre-write gate is the backstop. `dynamic`
 * is from `groupTypes`; `null` when it could not be read.
 */
const m365GroupSchema = z.object({
  id: idString,
  name: labelString.nullable(),
  dynamic: z.boolean().nullable(),
  roleAssignable: z.boolean().nullable(),
}).strict();
/** A requested Google group; `modelAfterRole` is the model-after person's role in it, when known. */
const googleGroupSchema = z.object({
  email: z.string().min(3).max(320),
  name: labelString.nullable(),
  modelAfterRole: z.enum(['MEMBER', 'MANAGER', 'OWNER']).nullable(),
}).strict();

/** The model-after person's own access, as read (informational; the INPUT decides the plan). */
const modelAfterSchema = z.object({
  contactId: z.string().uuid(),
  label: labelString.nullable(),
  m365: z.object({
    groupIds: z.array(idString).max(200),
    skuIds: z.array(z.string().min(1).max(64)).max(60),
  }).strict().nullable(),
  google: z.object({
    groupEmails: z.array(z.string().min(3).max(320)).max(200),
    licenses: z.array(z.object({ productId: z.string().min(1).max(128), skuId: z.string().min(1).max(128) }).strict()).max(20),
  }).strict().nullable(),
}).strict();

const flagSchema = z.object({
  code: z.string().min(1).max(64),
  subject: z.string().max(320),
  detail: z.string().max(2000).nullable(),
}).strict();

/** Snapshot 1's fields; snapshot 2 carries every one of them forward unchanged. */
const factsBaseShape = {
  /** The contact's `ai_operator_task_targets` row (B4) — `PlannedEffect.targetId` in both stages. */
  targets: z.object({
    contactTargetId: z.string().uuid(),
    contactLabel: labelString.nullable(),
  }).strict(),
  collisions: z.object({
    m365: m365CollisionSchema.nullable(),
    google: googleCollisionSchema.nullable(),
  }).strict(),
  seats: z.object({ m365: z.array(seatSchema).max(64) }).strict(),
  groups: z.object({
    m365: z.array(m365GroupSchema).max(100),
    google: z.array(googleGroupSchema).max(100),
  }).strict(),
  modelAfter: modelAfterSchema.nullable(),
  /** Tools readiness said this org cannot dispatch, FROZEN with the facts so a later readiness change cannot alter a sealed plan. */
  degradedTools: z.array(z.string().min(1).max(128)).max(64),
  /** Capability key → satisfied, as computed at discover. */
  capabilityReadiness: z.record(z.string(), z.boolean()),
  /** Closed-enum discovery flags (`identityProvisioning.ts`). */
  flags: z.array(flagSchema).max(64),
  /** Collections discovery could only list in part. */
  truncated: z.array(z.string().min(1).max(64)).max(32),
};

/** A resolved account (snapshot 2): the immutable id and the frozen principal label. */
const resolvedAccountSchema = z.object({
  externalId: idString,
  /** Google: the canonical primary email the Google tools address. M365: the UPN, for display only. */
  principalLabel: z.string().min(1).max(320),
}).strict();
/** M365 is addressed by the immutable Entra object id, which is always a GUID. */
const ENTRA_OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const resolvedM365AccountSchema = resolvedAccountSchema.extend({
  externalId: z.string().regex(ENTRA_OBJECT_ID, 'not an Entra object id (GUID)'),
}).strict();

/** The comparison form of an address (the canonical form `resolve_accounts` freezes: trimmed, lowercased). */
function canonicalAddress(raw: string): string {
  return raw.trim().toLowerCase();
}

export const identityOnboardingCreateFactsSchema = z.object({
  stage: z.literal('create'),
  ...factsBaseShape,
}).strict();

export const identityOnboardingProvisionFactsSchema = z.object({
  stage: z.literal('provision'),
  ...factsBaseShape,
  accounts: z.object({
    m365: resolvedM365AccountSchema.nullable(),
    google: resolvedAccountSchema.nullable(),
  }).strict(),
}).strict();

/**
 * The planning snapshot's `facts`, both stages. Task 7/12's `discover` writes
 * the `create` arm into snapshot 1; Task 12's `resolve_accounts` writes the
 * `provision` arm (snapshot 1's fields unchanged, plus `accounts`) into
 * snapshot 2.
 */
export const identityOnboardingFactsSchema = z.discriminatedUnion('stage', [
  identityOnboardingCreateFactsSchema,
  identityOnboardingProvisionFactsSchema,
]);
export type IdentityOnboardingFacts = z.infer<typeof identityOnboardingFactsSchema>;
export type IdentityOnboardingCreateFacts = z.infer<typeof identityOnboardingCreateFactsSchema>;
export type IdentityOnboardingProvisionFacts = z.infer<typeof identityOnboardingProvisionFactsSchema>;
export type OnboardingSeatFact = z.infer<typeof seatSchema>;

/**
 * Parse planning facts strictly. THROWS on anything malformed, and on a
 * stage-2 account for a provider whose snapshot-1 collision check was not
 * strictly clear — that account can only be someone else's (B.0 item 13).
 */
export function parseIdentityOnboardingFacts(facts: DiscoveryFacts): IdentityOnboardingFacts {
  const parsed = identityOnboardingFactsSchema.safeParse(facts);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`identity_onboarding: malformed planning facts at '${issue?.path.join('.') ?? ''}': ${issue?.message ?? 'invalid'}`);
  }
  const f = parsed.data;
  if (f.stage === 'provision') {
    if (f.accounts.m365 !== null && f.collisions.m365?.upnTaken !== false) {
      throw new Error('identity_onboarding: a resolved Microsoft 365 account contradicts snapshot 1, whose UPN collision check was not clear');
    }
    if (f.accounts.google !== null && f.collisions.google?.emailTaken !== false) {
      throw new Error('identity_onboarding: a resolved Google account contradicts snapshot 1, whose email collision check was not clear');
    }
  }
  return f;
}

function factsForStage<S extends IdentityOnboardingFacts['stage']>(
  facts: DiscoveryFacts,
  stage: S,
): Extract<IdentityOnboardingFacts, { stage: S }> {
  const f = parseIdentityOnboardingFacts(facts);
  if (f.stage !== stage) {
    throw new Error(`identity_onboarding: the ${stage} plan cannot be built from stage '${f.stage}' facts`);
  }
  return f as Extract<IdentityOnboardingFacts, { stage: S }>;
}

// ---------------------------------------------------------------------------
// Shared filters — one each, used by the plan AND the manual list, so the two
// can never disagree about what is hand-work.
// ---------------------------------------------------------------------------

/** The M365 create is planned only on a strict `false` (B1). */
function m365CreateClear(f: Pick<IdentityOnboardingFacts, 'collisions'>): boolean {
  return f.collisions.m365?.upnTaken === false;
}
function googleEmailClear(f: Pick<IdentityOnboardingFacts, 'collisions'>): boolean {
  return f.collisions.google?.emailTaken === false;
}

type GroupRefusal = 'dynamic' | 'role_assignable' | 'model_after_privileged' | 'not_described';

/**
 * THE PRIVILEGED-GROUP GUARD (D-R2-9; Amendment Task 7). A requested group is
 * not planned when it is known-dynamic, role-assignable (`true`), owned or
 * managed by the model-after person (Google), or absent from the discovered
 * facts (nobody checked it). Unknown role (`null`) IS planned.
 */
function m365GroupRefusal(f: IdentityOnboardingFacts, groupId: string): GroupRefusal | null {
  const g = f.groups.m365.find((x) => x.id === groupId);
  if (!g) return 'not_described';
  if (g.roleAssignable === true) return 'role_assignable';
  if (g.dynamic === true) return 'dynamic';
  return null;
}
function googleGroupRefusal(f: IdentityOnboardingFacts, groupEmail: string): GroupRefusal | null {
  const g = f.groups.google.find((x) => x.email.toLowerCase() === groupEmail.toLowerCase());
  if (!g) return 'not_described';
  if (g.modelAfterRole === 'OWNER' || g.modelAfterRole === 'MANAGER') return 'model_after_privileged';
  return null;
}

/** Requested SKU → its frozen seat fact (undefined when discovery recorded none). */
function seatFor(f: IdentityOnboardingFacts, skuId: string): OnboardingSeatFact | undefined {
  return f.seats.m365.find((s) => s.skuId.toLowerCase() === skuId.toLowerCase());
}
/** B6: only `available` is planned. A missing fact is never "probably fine". */
function seatPlannable(f: IdentityOnboardingFacts, skuId: string): boolean {
  return seatFor(f, skuId)?.state === 'available';
}

function reasonFor(input: IdentityOnboardingInput): string {
  return `Onboarding ${input.displayName} (Breeze Operator task).`;
}

type Push = (provider: EffectProvider, toolName: string, accountExternalId: string | null, args: Record<string, unknown>) => void;

function planner(input: IdentityOnboardingInput, targetId: string): { out: PlannedEffect[]; push: Push } {
  const out: PlannedEffect[] = [];
  const reason = reasonFor(input);
  const push: Push = (provider, toolName, accountExternalId, args) => {
    out.push({
      ordinal: out.length,
      toolName,
      provider,
      targetId, // ai_operator_task_targets.id (B4), never the contact id
      accountExternalId,
      canonicalArguments: Object.freeze({ ...args, reason }),
    });
  };
  return { out, push };
}

/** Filter the frozen degraded set, then renumber densely (offboarding's rule). */
function withoutDegraded(plan: readonly PlannedEffect[], f: IdentityOnboardingFacts): PlannedEffect[] {
  const degraded = new Set(f.degradedTools);
  return plan.filter((e) => !degraded.has(e.toolName)).map((e, i) => ({ ...e, ordinal: i }));
}

// ---------------------------------------------------------------------------
// The two plans
// ---------------------------------------------------------------------------

/**
 * STAGE 1. Pure. At most one effect per provider that can create accounts —
 * a loop over EFFECT_PROVIDER_ORDER, so `google_create_user` is an addition
 * here and nowhere else (D-R2-8). Throws on facts that are malformed or not
 * stage `create`.
 */
export function buildIdentityOnboardingCreatePlan(
  input: IdentityOnboardingInput,
  facts: DiscoveryFacts,
): PlannedEffect[] {
  const f = factsForStage(facts, 'create');
  const { out, push } = planner(input, f.targets.contactTargetId);
  for (const provider of EFFECT_PROVIDER_ORDER) {
    if (provider === 'm365') {
      if (input.m365 === null || !m365CreateClear(f)) continue;
      // D-R2-1: there is no account yet, so no external id.
      push('m365', 'm365_create_user', null, {
        userPrincipalName: input.m365.userPrincipalName,
        displayName: input.displayName,
        mailNickname: input.m365.mailNickname,
        usageLocation: input.m365.usageLocation,
      });
    }
    // google: no create tool exists (D-R2-3); `manual_create_google` does it.
  }
  return withoutDegraded(out, f);
}

/**
 * STAGE 2. Pure. The licence, group and OU effects, each addressed by the
 * resolved account: M365 by its immutable object id (never the UPN, spec
 * §5.2); Google by the frozen primary email its tools take, with the
 * immutable id as `accountExternalId`. A provider with no resolved account
 * gets nothing. Throws on facts that are malformed or not stage `provision`.
 */
export function buildIdentityOnboardingProvisionPlan(
  input: IdentityOnboardingInput,
  facts: DiscoveryFacts,
): PlannedEffect[] {
  const f = factsForStage(facts, 'provision');
  const { out, push } = planner(input, f.targets.contactTargetId);
  for (const provider of EFFECT_PROVIDER_ORDER) {
    if (provider === 'google') {
      const g = input.google;
      const account = f.accounts.google;
      if (g === null || account === null) continue;
      // The Google tools address the account by this label: it must be the
      // address the technician asked for, never another user's.
      if (canonicalAddress(account.principalLabel) !== canonicalAddress(g.primaryEmail)) {
        throw new Error('identity_onboarding: the resolved Google account\'s principal label is not the requested primary email');
      }
      const userEmail = account.principalLabel;
      const id = account.externalId;
      if (g.orgUnitPath !== null) push('google', 'google_move_ou', id, { userEmail, orgUnitPath: g.orgUnitPath });
      for (const l of g.licenses) {
        push('google', 'google_assign_license', id, { userEmail, productId: l.productId, skuId: l.skuId });
      }
      for (const groupEmail of g.groupEmails) {
        if (googleGroupRefusal(f, groupEmail) !== null) continue;
        // MEMBER pinned in the approved arguments, never left to a tool default (D-R2-9).
        push('google', 'google_add_to_group', id, { userEmail, groupEmail, role: 'MEMBER' });
      }
    } else {
      const m = input.m365;
      const account = f.accounts.m365;
      if (m === null || account === null) continue;
      const userIdentifier = account.externalId;
      const skuIds = m.skuIds.filter((s) => seatPlannable(f, s));
      // ONE effect: Graph's assignLicense takes the array. Omitted when empty —
      // the executor's schema refuses `skuIds: []`.
      if (skuIds.length > 0) push('m365', 'm365_assign_license', userIdentifier, { userIdentifier, skuIds });
      for (const groupId of m.groupIds) {
        if (m365GroupRefusal(f, groupId) !== null) continue;
        push('m365', 'm365_add_to_group', userIdentifier, { groupId, userIdentifier });
      }
    }
  }
  return withoutDegraded(out, f);
}

/** `RecipeDefinition.buildPlan`: strict parse, then dispatch on `facts.stage` (B2). */
export function buildIdentityOnboardingPlan(input: IdentityOnboardingInput, facts: DiscoveryFacts): PlannedEffect[] {
  const f = parseIdentityOnboardingFacts(facts);
  return f.stage === 'create'
    ? buildIdentityOnboardingCreatePlan(input, facts)
    : buildIdentityOnboardingProvisionPlan(input, facts);
}

// ---------------------------------------------------------------------------
// Manual work (spec §6.5)
// ---------------------------------------------------------------------------

/** `ticket_checklist_items.label` is varchar(500). */
const MAX_LABEL_CHARS = 500;
const MAX_DETAIL_CHARS = 2000;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
function bounded(item: RecipeManualWorkItem): RecipeManualWorkItem {
  return { ...item, label: clip(item.label, MAX_LABEL_CHARS), detail: clip(item.detail, MAX_DETAIL_CHARS) };
}

/**
 * The `manual_create_google` step's single item, or null when that step is
 * not taken: Google out of scope, or snapshot 1 did not record the primary
 * email as strictly free (a collision or an unrun check is a manual item in
 * the final list instead, and Google stays unresolved, B1).
 *
 * Kept OUT of `buildIdentityOnboardingManualWork`: that list is the final
 * `manual_work` step, by which point the account exists.
 */
export function buildManualCreateGoogleItem(
  input: IdentityOnboardingInput,
  facts: DiscoveryFacts,
): RecipeManualWorkItem | null {
  const f = parseIdentityOnboardingFacts(facts);
  const g = input.google;
  if (g === null || !googleEmailClear(f)) return null;
  return bounded({
    key: 'create_google_account', origin: 'capability', capabilityKey: 'google.account.create',
    label: `Create ${input.displayName}'s Google Workspace account`,
    detail:
      'Breeze cannot create Google accounts yet. In the Google Admin console open '
      + 'Directory → Users → Add new user and create:\n'
      + `  Primary email: ${g.primaryEmail}\n`
      + `  First name: ${g.givenName}   Last name: ${g.familyName}\n`
      + (g.orgUnitPath !== null ? `  Organizational unit: ${g.orgUnitPath}\n` : '')
      + 'Set a temporary password, tick "Ask for a password change at the next sign-in", '
      + `and hand the password to ${input.displayName} yourself — Breeze never sees it. `
      + 'Tick this item once the account exists; Breeze then reads its id back by that exact '
      + 'primary email and assigns the licences and group memberships you approve next.',
  });
}

const GROUP_REFUSAL_TEXT: Readonly<Record<GroupRefusal, string>> = Object.freeze({
  dynamic: 'It is a dynamic-membership group, which computes its members from user attributes: change the '
    + 'attribute or the rule instead of adding the person directly.',
  role_assignable: 'It is a role-assignable group: membership grants an Entra admin role, so Breeze never adds '
    + 'anyone to it. Decide whether this person needs that role, and if so add them in the Entra admin centre.',
  model_after_privileged: 'The person this onboarding was modelled after owns or manages this group, so Breeze '
    + 'did not copy it. Decide whether the new person should be a member (or more), and add them by hand.',
  not_described: 'Breeze could not check this group before planning, so it did not add the person. Check the '
    + 'group and add them by hand if it is right.',
});

const SEAT_STATE_TEXT: Readonly<Record<Exclude<OnboardingSeatFact['state'], 'available'>, string>> = Object.freeze({
  unavailable: 'The organization has no free seat for this licence. Buy a seat or free one, then assign it.',
  not_subscribed: 'The organization is not subscribed to this licence. Subscribe (or pick another licence), then assign it.',
  unknown: 'Breeze could not confirm a free seat for this licence, so it did not plan the assignment.',
});

/**
 * Every item of the final `manual_work` step, in a STABLE order with unique
 * keys: the handover items, collisions, licences not planned, groups not
 * planned, capability gaps, discovery flags and truncations, review flags.
 * `manualWork.ts` binds rows by index, so index i must mean the same item on
 * every wake — the order is structural and the map dedupes.
 *
 * Reads either stage's facts (strictly; throws on malformed). Cap the result
 * with `capOnboardingManualWork` before handing it to `manualWork.ts`.
 */
export function buildIdentityOnboardingManualWork(
  input: IdentityOnboardingInput,
  facts: DiscoveryFacts,
  readiness: Readonly<Record<string, boolean>>,
  reviewFlags: readonly { code: string; subject: string; detail: string }[],
): RecipeManualWorkItem[] {
  const f = parseIdentityOnboardingFacts(facts);
  const items = new Map<string, RecipeManualWorkItem>();
  const add = (item: RecipeManualWorkItem): void => {
    if (!items.has(item.key)) items.set(item.key, bounded(item));
  };
  const name = f.targets.contactLabel ?? input.displayName;
  const providers = onboardingProviders(input);

  // 1. Always: the handover itself is human work (spec §6.3).
  add({
    key: 'credential_handover', origin: 'always', capabilityKey: null,
    label: `Hand ${name} their sign-in details`,
    detail: (providers.m365
      ? 'The Microsoft 365 temporary password is sealed and can be revealed ONCE, by the person who approved '
        + 'the account creation, from that approval\'s entry in the AI activity feed. It expires 7 days after the '
        + 'account was created. The account must change its password at first sign-in, so it is safe to hand '
        + 'over in person. If the 7 days lapse unrevealed, do not create a second account: reset the password. '
      : '')
      + (providers.google ? 'The Google Workspace password is the one you set when you created that account by hand. ' : '')
      + 'Hand the sign-in details over in person or by phone, never by email.',
  });
  add({
    key: 'assign_hardware', origin: 'always', capabilityKey: null,
    label: `Assign ${name}'s company hardware`,
    detail: 'Prepare and hand over the laptop, phone, keys and badge this person needs, and record what was issued.',
  });
  add({
    key: 'enroll_mfa', origin: 'always', capabilityKey: null,
    label: `Help ${name} enroll multi-factor authentication`,
    detail: 'At first sign-in, make sure this person registers an authenticator app or security key on every '
      + 'account Breeze created, and that no account is left without multi-factor authentication.',
  });
  add({
    key: 'update_documentation', origin: 'always', capabilityKey: null,
    label: `Update documentation for ${name}`,
    detail: 'Add this person to contact lists, on-call rotas and runbooks, and record the accounts and access they were given.',
  });

  // 2. Collisions (B1). Per provider; a Google result never names M365.
  if (input.m365 !== null) {
    const c = f.collisions.m365;
    const upn = input.m365.userPrincipalName;
    if (c?.upnTaken === true) {
      add({
        key: `resolve_upn_collision:${upn}`, origin: 'discovery', capabilityKey: null,
        label: `Resolve the Microsoft 365 sign-in name ${upn}: it is already taken`,
        detail: `A Microsoft 365 account already holds ${upn} (object id ${c.existingObjectId ?? 'not returned'}), so `
          + 'Breeze did not create one: adopting it could hand this person someone else\'s identity. Decide whether '
          + 'that account is really theirs, or pick another sign-in name and start a new task.',
      });
    } else if (c?.upnTaken !== false) {
      add({
        key: 'collision_check_failed:m365', origin: 'discovery', capabilityKey: null,
        label: `Check whether ${upn} is free in Microsoft 365`,
        detail: `Breeze could not check whether a Microsoft 365 account already holds ${upn}, so it did not create `
          + 'one. Check in the Microsoft 365 admin centre, then create the account by hand or start a new task.',
      });
    }
  }
  if (input.google !== null) {
    const c = f.collisions.google;
    const email = input.google.primaryEmail;
    if (c?.emailTaken === true) {
      add({
        key: `resolve_email_collision:${email}`, origin: 'discovery', capabilityKey: null,
        label: `Resolve the Google Workspace address ${email}: it is already taken`,
        detail: `A Google Workspace user already holds ${email} (id ${c.existingUserId ?? 'not returned'}), so Breeze `
          + 'did not ask for the account to be created and did not provision Google. Decide whether that account '
          + 'is really this person\'s, or pick another address.',
      });
    } else if (c?.emailTaken !== false) {
      add({
        key: 'collision_check_failed:google', origin: 'discovery', capabilityKey: null,
        label: `Check whether ${email} is free in Google Workspace`,
        detail: `Breeze could not check whether a Google Workspace user already holds ${email}, so it did not `
          + 'provision Google. Check in the Google Admin console and set the account up by hand.',
      });
    }
  }

  // 3. M365 licences the plan did not assign (B6).
  if (input.m365 !== null) {
    for (const skuId of input.m365.skuIds) {
      if (seatPlannable(f, skuId)) continue;
      const seat = seatFor(f, skuId);
      const label = seat?.skuPartNumber ?? skuId;
      const why = seat === undefined
        ? 'Breeze recorded no seat information for this licence, so it did not plan the assignment.'
        : `${SEAT_STATE_TEXT[seat.state as Exclude<OnboardingSeatFact['state'], 'available'>]}${seat.reason ? ` (${seat.reason})` : ''}`;
      add({
        key: `manual_license:${label}`, origin: 'discovery', capabilityKey: null,
        label: `Assign the Microsoft 365 licence ${label} to ${name} by hand`,
        detail: `${why} Assign it in the Microsoft 365 admin centre (Users → Active users → Licenses and apps).`,
      });
    }
  }

  // 4. Groups the plan refused to touch.
  if (input.m365 !== null) {
    for (const groupId of input.m365.groupIds) {
      const refusal = m365GroupRefusal(f, groupId);
      if (refusal === null) continue;
      const groupName = f.groups.m365.find((g) => g.id === groupId)?.name ?? groupId;
      add({
        key: `manual_group_add:${groupId}`, origin: 'discovery', capabilityKey: null,
        label: `Decide on the Microsoft 365 group "${groupName}" for ${name}`,
        detail: GROUP_REFUSAL_TEXT[refusal],
      });
    }
  }
  if (input.google !== null) {
    for (const groupEmail of input.google.groupEmails) {
      const refusal = googleGroupRefusal(f, groupEmail);
      if (refusal === null) continue;
      add({
        key: `manual_group_add:${groupEmail}`, origin: 'discovery', capabilityKey: null,
        label: `Decide on the Google group ${groupEmail} for ${name}`,
        detail: GROUP_REFUSAL_TEXT[refusal],
      });
    }
  }

  // 5. Capability gaps — only for tools the input asks for (so an M365-only
  // onboarding is never told to do Google work by hand).
  const wanted = new Set<string>();
  if (input.m365 !== null) {
    wanted.add('m365_create_user');
    if (input.m365.skuIds.length > 0) wanted.add('m365_assign_license');
    if (input.m365.groupIds.length > 0) wanted.add('m365_add_to_group');
  }
  if (input.google !== null) {
    if (input.google.orgUnitPath !== null) wanted.add('google_move_ou');
    if (input.google.licenses.length > 0) wanted.add('google_assign_license');
    if (input.google.groupEmails.length > 0) wanted.add('google_add_to_group');
  }
  const degraded = new Set(f.degradedTools);
  const gaps = new Set<string>();
  for (const tool of IDENTITY_ONBOARDING_EFFECT_TOOLS) {
    if (!wanted.has(tool)) continue;
    const capabilityKey = ONBOARDING_CAPABILITY_FOR_TOOL[tool];
    if (capabilityKey && (degraded.has(tool) || readiness[capabilityKey] !== true)) gaps.add(capabilityKey);
  }
  for (const cap of IDENTITY_ONBOARDING_CAPABILITIES) {
    if (!gaps.has(cap.key)) continue;
    const provider = cap.provider === 'm365' ? 'Microsoft 365' : 'Google Workspace';
    add({
      key: `capability:${cap.key}`, origin: 'capability', capabilityKey: cap.key,
      label: `Do by hand in ${provider}: ${cap.detail}`,
      detail: `Breeze cannot do this for ${name} in this organization: ${cap.detail} `
        + `Do it in the ${provider} admin console for ${name}, then tick this item.`,
    });
  }

  // 6. Discovery flags and truncations.
  for (const flag of f.flags) {
    add({
      key: `discovery_flag:${flag.code}:${flag.subject}`, origin: 'discovery', capabilityKey: null,
      label: `Check by hand: ${flag.code.replace(/_/g, ' ')}${flag.subject ? ` (${flag.subject})` : ''}`,
      detail: flag.detail ?? 'Discovery could not confirm this automatically. Check it by hand.',
    });
  }
  for (const what of f.truncated) {
    add({
      key: `discovery_truncated:${what}`, origin: 'discovery', capabilityKey: null,
      label: `Review the rest of ${what} by hand`,
      detail: `Discovery listed only the first entries of ${what}; anything past that limit was not checked. `
        + 'Review the remainder in the provider\'s admin console.',
    });
  }

  // 7. Review flags (closed enum, validated before they reach here).
  for (const flag of reviewFlags) {
    add({
      key: `flag:${flag.code}:${flag.subject}`, origin: 'flag', capabilityKey: null,
      label: `Review: ${flag.code.replace(/_/g, ' ')} — ${flag.subject}`,
      detail: flag.detail,
    });
  }

  return [...items.values()];
}

/**
 * Fit a manual list into `MANUAL_WORK_MAX_ITEMS` (offboarding's bound, the one
 * `manualWork.ts` enforces) without losing anything silently: the first
 * `max - 1` items are kept and the rest fold into ONE final item naming each.
 * Mirrors offboarding's `capManualWork` with onboarding's wording.
 */
export function capOnboardingManualWork(
  items: readonly RecipeManualWorkItem[],
  max: number = MANUAL_WORK_MAX_ITEMS,
): RecipeManualWorkItem[] {
  if (items.length <= max) return [...items];
  const kept = items.slice(0, max - 1);
  const rest = items.slice(max - 1);
  return [...kept, {
    key: 'overflow', origin: 'flag', capabilityKey: null,
    label: `Review ${rest.length} more item(s) listed in this step's details`,
    detail: clip('This onboarding produced more checklist items than fit on one ticket. Do each of these by hand: '
      + rest.map((i) => i.label).join('; '), MAX_DETAIL_CHARS),
  }];
}

// ---------------------------------------------------------------------------
// The recipe
// ---------------------------------------------------------------------------

/** Read the frozen input off a resolver context; the coordinator passes the parsed checkpoint input. */
function inputOf(ctx: NextStepContext): IdentityOnboardingInput {
  return ctx.input as IdentityOnboardingInput;
}
/** Defensive, strict-`false` read for a pure resolver: absent or malformed facts are never "free". */
function googleEmailFreeIn(facts: Readonly<Record<string, unknown>>): boolean {
  const collisions = facts.collisions;
  if (collisions === null || typeof collisions !== 'object') return false;
  const google = (collisions as Record<string, unknown>).google;
  if (google === null || typeof google !== 'object') return false;
  return (google as Record<string, unknown>).emailTaken === false;
}

export const identityOnboardingRecipe: RecipeDefinition<IdentityOnboardingInput> = {
  key: IDENTITY_ONBOARDING_WORKFLOW_KEY,
  version: IDENTITY_ONBOARDING_WORKFLOW_VERSION,
  promptVersion: IDENTITY_ONBOARDING_PROMPT_VERSION,
  gateClass: 'deterministic',
  targetKinds: ['contact', 'ticket'],
  requires: IDENTITY_ONBOARDING_CAPABILITIES,
  inputSchema: identityOnboardingInputSchema,

  steps: Object.freeze({
    intake: { kind: 'reason', phase: 'investigate', next: 'confirm_details' },
    // The mandatory human confirmation. No other step names `discover`.
    confirm_details: { kind: 'human_work', phase: 'investigate', inputSchema: identityOnboardingConfirmOutputSchema, next: 'discover' },
    discover: { kind: 'probe', phase: 'plan', next: 'review' },
    review: { kind: 'reason', phase: 'plan', next: 'create_accounts' },
    // Stage 1 at revision r: propose → four-eyes approval → walk, inside E4's
    // planEffectStep. `manual_create_google` only when Google is in scope and
    // snapshot 1 recorded its address as strictly free (B1).
    create_accounts: {
      kind: 'effect', phase: 'execute', inputSchema: identityOnboardingReviewOutputSchema,
      next: (ctx) => (inputOf(ctx).google !== null && googleEmailFreeIn(ctx.facts) ? 'manual_create_google' : 'resolve_accounts'),
    },
    manual_create_google: { kind: 'human_work', phase: 'execute', next: 'resolve_accounts' },
    // Reads back this task's OWN creations, freezes them, bumps r → r+1 and
    // writes snapshot 2 — one transaction (B2/B7).
    resolve_accounts: { kind: 'probe', phase: 'execute', next: 'provision_effects' },
    // Stage 2 at revision r+1.
    provision_effects: {
      kind: 'effect', phase: 'execute',
      next: (ctx) => (inputOf(ctx).startAt !== null ? 'wait_start' : 'manual_work'),
    },
    wait_start: { kind: 'wait', phase: 'execute', next: 'manual_work' },
    // The handover items. Named `manual_work` so R1's manualWork.ts serves it (B.0 item 9).
    manual_work: { kind: 'human_work', phase: 'execute', next: 'verify_outcome' },
    verify_outcome: { kind: 'probe', phase: 'verify', next: 'document' },
    document: { kind: 'document', phase: 'document', terminal: true },
  }),

  /**
   * Sparse ON PURPOSE. The model proposes out of the two `reason` steps and
   * nowhere else; `discover` appears in no permitted set.
   */
  permittedNextSteps: Object.freeze({
    intake: ['confirm_details'],
    review: ['create_accounts'],
  }),

  bounds: IDENTITY_ONBOARDING_BOUNDS,
  buildPlan: buildIdentityOnboardingPlan,
  entryStepKey: 'intake',
  planningSnapshotStepKey: 'discover',
  /**
   * TOTAL for every step that plans (B2). `intake`, `confirm_details` and
   * `discover` are absent on purpose: the first two run before any snapshot
   * exists and `discover` writes snapshot 1 rather than reading it, so a load
   * at any of them fails closed (`snapshot_step_unmapped`).
   */
  planningSnapshotStepFor: Object.freeze({
    review: 'discover',
    create_accounts: 'discover',
    manual_create_google: 'discover',
    resolve_accounts: 'discover',
    provision_effects: 'resolve_accounts',
    wait_start: 'resolve_accounts',
    manual_work: 'resolve_accounts',
    verify_outcome: 'resolve_accounts',
    document: 'resolve_accounts',
  }),
  unobservableEffects: IDENTITY_ONBOARDING_UNOBSERVABLE_EFFECTS,

  /**
   * One operation per external effect, byte-for-byte the key effect dispatch
   * builds; the revision is in the key, so a create at r and a provision at
   * r+1 never collide. The workflow-key fallback covers steps with no tool.
   */
  operationKey: (args) => buildTaskOperationKey({
    taskStepKey: args.stepKey,
    toolName: args.toolName ?? IDENTITY_ONBOARDING_WORKFLOW_KEY,
    targetId: args.targetId,
    planRevision: args.planRevision,
    ordinal: args.ordinal,
  }),
};

/** Effect tool → the capability key that gates it. Derived, never hand-maintained. */
export const ONBOARDING_CAPABILITY_FOR_TOOL: Readonly<Record<string, string>> =
  capabilityForTool(identityOnboardingRecipe);
