/**
 * `identity_onboarding`'s `resolve_accounts` — adopt the accounts THIS task
 * created, then move the task from stage 1 to stage 2 in one transaction
 * (W07 Task 9; Amendment B1 "Resolve only what this task created", B2 "The
 * stage transition is ONE transaction", B7, B.0 item 13, B.9 item 9, B.10 Q4).
 *
 * Offboarding freezes accounts at admission because they already exist.
 * Onboarding cannot: `ai_operator_task_target_accounts.external_id` is NOT
 * NULL and there is nothing to put in it until the create has settled. So the
 * freeze happens here, between creation and the provisioning plan, and the
 * failure this module exists to prevent is ADOPTING A STRANGER. After a
 * collision the create is not planned, so a read by UPN would find the
 * EXISTING holder of that name, and provisioning would then grant licences
 * and groups to someone else. Therefore:
 *
 *  - MICROSOFT 365 resolves only from this task's own `m365_create_user`
 *    operation at `createPlanRevision`. That operation is matched on org,
 *    task, step `create_accounts`, revision, the operation key and the
 *    argument digest E4 itself would compute for the planned create effect.
 *    Its NON-SECRET result keys are projected in SQL (`result->>'…'`); the
 *    whole `result` column is never selected, because it carries the sealed
 *    credential. The projection must show `success: true`, `action:
 *    'm365.user.create'`, a GUID `userId` and the requested UPN, and
 *    `result_state` must be `succeeded` as well — but `succeeded` alone is not
 *    proof (the release worker can record a non-command result as succeeded),
 *    and the intent's `completed` status is not required (the operation
 *    result persists before the intent's completion CAS). The account is then
 *    read BY THAT ID through the audited read path, and its UPN must equal the
 *    requested one. There is no UPN lookup anywhere in this file.
 *  - GOOGLE resolves only when snapshot 1 recorded the primary email as
 *    strictly free (`emailTaken === false`) AND a user ticked the
 *    `manual_create_google` item (read through E3's `readHumanWorkStep`). The
 *    read by the canonical primary email must return exactly that primary
 *    email; its immutable id is what gets frozen. A ticked item never
 *    authorizes adopting an account that collided.
 *
 * THE FAILURE RULE (R1's). A transient provider fault RETHROWS
 * (`DiscoveryTransientError`), so the wake retries; a Breeze db error
 * rethrows as itself. Every definitive answer is a per-provider reason. When
 * neither provider resolves the result is `no_account_resolved` and the
 * caller hands off WITHOUT bumping.
 *
 * TWO HALVES. `resolveCreatedAccounts` does the provider reads and runs
 * OUTSIDE any transaction. `commitOnboardingStageTransition` runs INSIDE the
 * caller's leased write, on the caller's handle, and does B2 steps 1–4:
 * guards, `bumpPlanRevisionInTx` r → r+1, the freeze + contact links, and
 * snapshot 2 on the `resolve_accounts` row. A guard miss THROWS
 * `OnboardingStageTransitionAbort`: the leased write commits whenever its
 * callback returns, so an early return would commit the patch without the
 * bump.
 *
 * TENANCY. The Breeze reads run in system scope; every statement carries an
 * explicit `org_id` + `task_id` predicate, and returned rows are re-checked
 * against them before they are trusted. Provider reads resolve their
 * connection in a db context scoped to exactly this org (`inOrgContext`).
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { planningSnapshotRefSchema, type IdentityOnboardingInput, type PlanningSnapshotRef } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { m365Connections } from '../../db/schema/m365';
import { aiOperatorOperations, aiOperatorTasks } from '../../db/schema/aiOperatorTasks';
import { aiOperatorTaskSteps, aiOperatorTaskTargets } from '../../db/schema/aiOperatorTaskGraph';
import { canonicalizeUserEmail, resolveContextByOrg } from '../aiToolsGoogle';
import { getDirectoryClient, normalizeGoogleError } from '../googleClient';
import { readHumanWorkStep } from './humanWorkService';
import {
  DiscoveryTransientError,
  errorMessage,
  inOrgContext,
  isTransientGoogle,
  M365ReadFailed,
  m365Read,
  rethrowIfTransientM365,
} from './identityDiscovery';
import { bumpPlanRevisionInTx, effectArgumentDigest, planEffectOperationKey } from './planApproval';
import { sealPlanningSnapshot, type PlanningSnapshotEnvelope } from './planningSnapshot';
import {
  buildIdentityOnboardingCreatePlan,
  identityOnboardingCreateFactsSchema,
  parseIdentityOnboardingFacts,
  type IdentityOnboardingCreateFacts,
  type IdentityOnboardingProvisionFacts,
} from './recipes/identityOnboarding';
import type { DiscoveryFacts } from './recipes/types';
import { freezeTargetAccount, upsertContactExternalLinks, type TargetDbHandle } from './targetService';

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

export type OnboardingAccountProvider = 'm365' | 'google';

/** Exactly snapshot 2's `accounts` member shape. */
export interface ResolvedOnboardingAccount {
  /** Entra object id / Google user id — immutable, never the UPN. */
  externalId: string;
  /** The canonical UPN / primary email. Display only for M365; Google's tools address it. */
  principalLabel: string;
}

export type OnboardingAccounts = IdentityOnboardingProvisionFacts['accounts'];

/** Why one in-scope provider did not resolve. Each is a reason to name in the hand-off. */
export type UnresolvedAccountReason =
  /** Snapshot 1: someone else holds the UPN / primary email. Never adopted. */
  | 'upn_collision' | 'email_collision'
  /** Snapshot 1: the collision check could not run (`null`). Never adopted. */
  | 'collision_unchecked'
  /** The create plan had no create for this provider (degraded at discover). */
  | 'create_not_planned'
  /** No operation of this task matches the expected key, digest, step and revision. */
  | 'create_operation_missing'
  /** The operation exists but its projected result does not prove the create. */
  | 'create_result_unproven'
  /** The read by id / exact email found no user. */
  | 'account_not_found'
  /** The read returned a different user, id or address than the one created. */
  | 'account_mismatch'
  /** A definitive (non-transient) read refusal. */
  | 'account_read_failed'
  /** Google: the manual-create item was not ticked by a user. */
  | 'manual_item_not_ticked'
  /** Google: no usable connection for this org. */
  | 'connection_unavailable';

/**
 * Whether an unresolved reason means this task never created an account at
 * that provider (`true`: expected absent, the transition may go on without
 * it) or that one MAY exist and could not be confirmed (`false`: the caller
 * must hand off, never bump, so nothing re-creates it). Every value is
 * classified here; a new reason does not compile until it is.
 */
export const UNRESOLVED_REASON_EXPECTED_ABSENT: Readonly<Record<UnresolvedAccountReason, boolean>> = {
  upn_collision: true,
  email_collision: true,
  collision_unchecked: true,
  create_not_planned: true,
  create_operation_missing: false,
  create_result_unproven: false,
  account_not_found: false,
  account_mismatch: false,
  account_read_failed: false,
  manual_item_not_ticked: false,
  connection_unavailable: false,
};

export function isExpectedAbsentReason(reason: UnresolvedAccountReason): boolean {
  return UNRESOLVED_REASON_EXPECTED_ABSENT[reason] === true;
}

export interface UnresolvedAccount {
  provider: OnboardingAccountProvider;
  reason: UnresolvedAccountReason;
  detail: string;
}

export interface ResolveCreatedAccountsInput {
  orgId: string;
  taskId: string;
  /** `task.attemptOrdinal` — the `manual_create_google` step row's attempt. */
  attemptOrdinal: number;
  /** `checkpoint.createPlanRevision` — the revision `create_accounts` dispatched at. */
  createPlanRevision: number;
  /** The frozen, parsed recipe input (`checkpoint.recipeInput`). */
  input: IdentityOnboardingInput;
  /** Snapshot 1's facts exactly as `loadPlanningFacts` verified them. */
  facts: DiscoveryFacts;
}

export type ResolveCreatedAccountsResult =
  | {
    ok: true;
    accounts: OnboardingAccounts;
    /** The connection row to freeze with each account; `null` when none (nullable by design). */
    connectionIds: { m365: string | null; google: string | null };
    /** In-scope providers that did not resolve — the caller names them as manual work. */
    unresolved: UnresolvedAccount[];
  }
  | { ok: false; reason: 'no_account_resolved'; unresolved: UnresolvedAccount[]; detail: string }
  | { ok: false; reason: 'facts_invalid'; detail: string };

type ProviderOutcome =
  | { resolved: true; account: ResolvedOnboardingAccount; connectionId: string | null }
  | { resolved: false; unresolved: UnresolvedAccount };

const CREATE_STEP_KEY = 'create_accounts';
const RESOLVE_STEP_KEY = 'resolve_accounts';
const M365_CREATE_TOOL = 'm365_create_user';
const M365_CREATE_ACTION = 'm365.user.create';
/** The M365 actions profile — the connection effects write through (contactResolution.ts's rule). */
const M365_ACTIONS_PROFILE = 'customer-graph-actions';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COORDINATOR = { kind: 'coordinator' } as const;

function unresolved(provider: OnboardingAccountProvider, reason: UnresolvedAccountReason, detail: string): ProviderOutcome {
  return { resolved: false, unresolved: { provider, reason, detail: detail.slice(0, 500) } };
}

/** Snapshot 1, strictly: the `create` arm only. */
function createFacts(facts: DiscoveryFacts): IdentityOnboardingCreateFacts | { error: string } {
  const parsed = identityOnboardingCreateFactsSchema.safeParse(facts);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: `snapshot 1 is not strict stage-1 facts at '${issue?.path.join('.') ?? ''}': ${issue?.message ?? 'invalid'}` };
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Microsoft 365
// ---------------------------------------------------------------------------

interface ProjectedCreateOperation {
  id: string;
  orgId: string;
  taskId: string;
  taskStepKey: string;
  planRevision: number | null;
  operationKey: string;
  argumentDigest: string;
  resultState: string;
  resultSuccess: string | null;
  resultAction: string | null;
  resultUserId: string | null;
  resultUserPrincipalName: string | null;
}

/**
 * This task's own create operation, PROJECTED. The four `result->>…` keys are
 * the whole of what is read from `result`; the column itself is never in the
 * projection (`credentialHandover.secrets.contract.test.ts`, this file's
 * test). Every identity column is selected so it can be re-checked in code.
 */
async function readOwnCreateOperation(
  orgId: string, taskId: string, planRevision: number, operationKey: string,
): Promise<ProjectedCreateOperation[]> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => db
    .select({
      id: aiOperatorOperations.id,
      orgId: aiOperatorOperations.orgId,
      taskId: aiOperatorOperations.taskId,
      taskStepKey: aiOperatorOperations.taskStepKey,
      planRevision: aiOperatorOperations.planRevision,
      operationKey: aiOperatorOperations.operationKey,
      argumentDigest: aiOperatorOperations.argumentDigest,
      resultState: aiOperatorOperations.resultState,
      resultSuccess: sql<string | null>`${aiOperatorOperations.result}->>'success'`,
      resultAction: sql<string | null>`${aiOperatorOperations.result}->>'action'`,
      resultUserId: sql<string | null>`${aiOperatorOperations.result}->>'userId'`,
      resultUserPrincipalName: sql<string | null>`${aiOperatorOperations.result}->>'userPrincipalName'`,
    })
    .from(aiOperatorOperations)
    .where(and(
      eq(aiOperatorOperations.orgId, orgId),
      eq(aiOperatorOperations.taskId, taskId),
      eq(aiOperatorOperations.taskStepKey, CREATE_STEP_KEY),
      eq(aiOperatorOperations.planRevision, planRevision),
      eq(aiOperatorOperations.operationKey, operationKey),
    ))
    .limit(2)));
}

async function m365ActionsConnectionId(orgId: string): Promise<string | null> {
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(async () => db
    .select({ id: m365Connections.id, profile: m365Connections.profile })
    .from(m365Connections)
    .where(eq(m365Connections.orgId, orgId))
    .limit(10)));
  return rows.find((r) => r.profile === M365_ACTIONS_PROFILE)?.id ?? null;
}

async function resolveM365(
  args: ResolveCreatedAccountsInput, f: IdentityOnboardingCreateFacts, m: NonNullable<IdentityOnboardingInput['m365']>,
): Promise<ProviderOutcome> {
  const requested = canonicalizeUserEmail(m.userPrincipalName);
  const collision = f.collisions.m365;
  // Strict `false` only (B1). Checked BEFORE anything is read: after a
  // collision the holder of the UPN exists, and no read here may find them.
  if (collision?.upnTaken === true) {
    return unresolved('m365', 'upn_collision',
      `${requested ?? m.userPrincipalName} already belonged to another Microsoft 365 user`
      + `${collision.existingObjectId ? ` (${collision.existingObjectId})` : ''}; Breeze did not create or adopt an account.`);
  }
  if (collision?.upnTaken !== false) {
    return unresolved('m365', 'collision_unchecked',
      `Breeze could not check whether ${requested ?? m.userPrincipalName} was free, so it did not create or adopt an account.`);
  }
  if (!requested) {
    return unresolved('m365', 'create_not_planned', 'The requested sign-in name is not a single plain address.');
  }
  // The planned create, rebuilt from the same input and snapshot 1 the
  // approval sealed, so the key and digest are the ones E4 dispatched under.
  const create = buildIdentityOnboardingCreatePlan(args.input, f).find((e) => e.toolName === M365_CREATE_TOOL);
  if (!create) {
    return unresolved('m365', 'create_not_planned',
      'The Microsoft 365 account create was not in the approved plan (the tool was unavailable at discovery).');
  }
  const operationKey = planEffectOperationKey({
    stepKey: CREATE_STEP_KEY, planRevision: args.createPlanRevision, toolName: create.toolName,
    targetId: create.targetId, ordinal: create.ordinal,
  });
  const argumentDigest = effectArgumentDigest(create);

  const rows = await readOwnCreateOperation(args.orgId, args.taskId, args.createPlanRevision, operationKey);
  // Re-checked in code as well as in SQL: whatever returned a row, only this
  // task's own create at this revision, with these exact arguments, counts.
  const own = rows.filter((r) => r.orgId === args.orgId && r.taskId === args.taskId
    && r.taskStepKey === CREATE_STEP_KEY && r.planRevision === args.createPlanRevision
    && r.operationKey === operationKey && r.argumentDigest === argumentDigest);
  if (own.length !== 1) {
    return unresolved('m365', 'create_operation_missing',
      `No record of this task creating ${requested} was found, so Breeze did not look the account up by name.`);
  }
  const op = own[0]!;
  const createdUpn = op.resultUserPrincipalName !== null ? canonicalizeUserEmail(op.resultUserPrincipalName) : null;
  if (op.resultState !== 'succeeded' || op.resultSuccess !== 'true' || op.resultAction !== M365_CREATE_ACTION
    || op.resultUserId === null || !GUID.test(op.resultUserId) || createdUpn !== requested) {
    return unresolved('m365', 'create_result_unproven',
      `This task's create operation for ${requested} does not record a successful create of that account (${op.resultState}).`);
  }
  const userId = op.resultUserId;

  let resource: Record<string, unknown>;
  try {
    const r = await m365Read(args.orgId, { type: 'm365.user.get', userIdOrUpn: userId });
    if (r.kind !== 'resource') throw new M365ReadFailed('graph_response_invalid', 'user read returned a collection');
    resource = r.resource;
  } catch (err) {
    if (err instanceof M365ReadFailed && err.code === 'graph_not_found') {
      return unresolved('m365', 'account_not_found', `The created Microsoft 365 user ${userId} could not be found.`);
    }
    rethrowIfTransientM365(err);
    const code = err instanceof M365ReadFailed ? err.code : 'error';
    return unresolved('m365', 'account_read_failed', `Reading the created Microsoft 365 user failed (${code}): ${errorMessage(err)}`);
  }
  const readId = typeof resource.id === 'string' ? resource.id : null;
  const readUpn = typeof resource.userPrincipalName === 'string' ? canonicalizeUserEmail(resource.userPrincipalName) : null;
  if (readId === null || readId.toLowerCase() !== userId.toLowerCase() || readUpn !== requested) {
    return unresolved('m365', 'account_mismatch',
      `The Microsoft 365 user ${userId} is now ${readUpn ?? 'unnamed'}, not ${requested}; Breeze did not adopt it.`);
  }
  return {
    resolved: true,
    account: { externalId: userId, principalLabel: requested },
    connectionId: await m365ActionsConnectionId(args.orgId),
  };
}

// ---------------------------------------------------------------------------
// Google Workspace
// ---------------------------------------------------------------------------

/** E3's authoritative read: a linked, same-org item, ticked by a user. */
async function manualCreateTicked(args: ResolveCreatedAccountsInput): Promise<boolean> {
  const view = await readHumanWorkStep(args.orgId, args.taskId, 'manual_create_google', args.attemptOrdinal);
  return view !== null && view.checklistItemId !== null && view.itemLabel !== null
    && view.itemDoneAt !== null && view.itemDoneByUserId !== null;
}

async function resolveGoogle(
  args: ResolveCreatedAccountsInput, f: IdentityOnboardingCreateFacts, g: NonNullable<IdentityOnboardingInput['google']>,
): Promise<ProviderOutcome> {
  const requested = canonicalizeUserEmail(g.primaryEmail);
  const collision = f.collisions.google;
  if (collision?.emailTaken === true) {
    return unresolved('google', 'email_collision',
      `${requested ?? g.primaryEmail} already belonged to another Google Workspace user`
      + `${collision.existingUserId ? ` (${collision.existingUserId})` : ''}; Breeze did not adopt an account.`);
  }
  if (collision?.emailTaken !== false) {
    return unresolved('google', 'collision_unchecked',
      `Breeze could not check whether ${requested ?? g.primaryEmail} was free, so it did not adopt an account.`);
  }
  if (!requested) {
    return unresolved('google', 'account_mismatch', 'The requested primary address is not a single plain address.');
  }
  if (!(await manualCreateTicked(args))) {
    return unresolved('google', 'manual_item_not_ticked',
      `Nobody has ticked the item confirming ${requested} was created in Google Workspace.`);
  }

  let ctx: Awaited<ReturnType<typeof resolveContextByOrg>>;
  try {
    ctx = await inOrgContext(args.orgId, () => resolveContextByOrg(args.orgId));
  } catch (err) {
    // A throw here is Breeze I/O (the connection row, its key), not a fact.
    throw new DiscoveryTransientError('google', 'connection', errorMessage(err));
  }
  if ('error' in ctx) {
    return unresolved('google', 'connection_unavailable', 'No usable Google Workspace connection for this organization.');
  }
  let dir: ReturnType<typeof getDirectoryClient>;
  try {
    dir = getDirectoryClient(ctx.keyJson, ctx.conn.adminEmail);
  } catch (err) {
    return unresolved('google', 'connection_unavailable', `The Google Workspace connection is unusable: ${errorMessage(err)}`);
  }
  let data: { id?: unknown; primaryEmail?: unknown };
  try {
    data = (await dir.users.get({ userKey: requested })).data as typeof data;
  } catch (err) {
    const norm = normalizeGoogleError(err);
    if (norm.code === 'google_not_found') {
      return unresolved('google', 'account_not_found', `No Google Workspace user ${requested} exists yet.`);
    }
    if (isTransientGoogle(err)) throw new DiscoveryTransientError('google', norm.code, errorMessage(err));
    return unresolved('google', 'account_read_failed', `Reading ${requested} failed (${norm.code}): ${norm.message}`);
  }
  const id = typeof data.id === 'string' && data.id.length > 0 ? data.id : null;
  const primary = typeof data.primaryEmail === 'string' ? canonicalizeUserEmail(data.primaryEmail) : null;
  // Exact canonical match: a lookup that resolved through an alias is a
  // different person's account.
  if (id === null || primary !== requested) {
    return unresolved('google', 'account_mismatch',
      `${requested} resolves to ${primary ?? 'a user with no primary address'}, not to itself; Breeze did not adopt it.`);
  }
  return {
    resolved: true,
    account: { externalId: id, principalLabel: requested },
    connectionId: (ctx.conn as { id?: string }).id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Half 1 — provider reads, OUTSIDE any transaction
// ---------------------------------------------------------------------------

/**
 * Resolve the accounts this task created. Runs outside any transaction (the
 * caller then opens its leased write). Throws only on a transient provider
 * fault or Breeze I/O, so the wake retries.
 */
export async function resolveCreatedAccounts(args: ResolveCreatedAccountsInput): Promise<ResolveCreatedAccountsResult> {
  const f = createFacts(args.facts);
  if ('error' in f) return { ok: false, reason: 'facts_invalid', detail: f.error };

  const accounts: OnboardingAccounts = { m365: null, google: null };
  const connectionIds: { m365: string | null; google: string | null } = { m365: null, google: null };
  const missed: UnresolvedAccount[] = [];
  const take = (provider: OnboardingAccountProvider, out: ProviderOutcome): void => {
    if (out.resolved) {
      accounts[provider] = out.account;
      connectionIds[provider] = out.connectionId;
    } else {
      missed.push(out.unresolved);
    }
  };
  // Provider order (`EFFECT_PROVIDER_ORDER`): google, then m365.
  if (args.input.google !== null) take('google', await resolveGoogle(args, f, args.input.google));
  if (args.input.m365 !== null) take('m365', await resolveM365(args, f, args.input.m365));

  if (accounts.m365 === null && accounts.google === null) {
    const detail = missed.map((u) => `${u.provider}: ${u.reason}`).join('; ') || 'no provider in scope';
    return { ok: false, reason: 'no_account_resolved', unresolved: missed, detail: `no created account resolved (${detail})` };
  }
  return { ok: true, accounts, connectionIds, unresolved: missed };
}

// ---------------------------------------------------------------------------
// Half 2 — the stage transition, INSIDE the caller's leased write
// ---------------------------------------------------------------------------

export type StageTransitionGuard =
  /** The task is not at `createPlanRevision` (or its row is gone). */
  | 'revision_moved'
  /** The task's current step is not `resolve_accounts`. */
  | 'wrong_step'
  /** An operation at `createPlanRevision` is `pending` or `unknown`. */
  | 'operation_unsettled'
  /** The checkpoint's snapshot ref no longer points at the `discover` row the facts came from. */
  | 'snapshot_ref_moved'
  /** The contact target (ordinal 0) is missing or detached. */
  | 'contact_target_missing'
  /** No `resolve_accounts` step row at this attempt and revision. */
  | 'resolve_step_missing'
  /** The `resolve_accounts` row already carries an envelope (snapshot 2 is written once). */
  | 'snapshot_already_written'
  /** Snapshot 2 does not parse on the recipe's strict provision schema. */
  | 'facts_invalid'
  /** The caller passed a resolution with no account (a `no_account_resolved` must hand off, not bump). */
  | 'nothing_resolved'
  /** `bumpPlanRevisionInTx` did not move the task from r to r+1. */
  | 'bump_lost';

/**
 * Thrown from inside the caller's `alsoInTransaction` to ROLL BACK. Catch it
 * OUTSIDE the leased write: nothing was committed.
 */
export class OnboardingStageTransitionAbort extends Error {
  constructor(readonly guard: StageTransitionGuard, detail: string) {
    super(`resolve_accounts stage transition aborted (${guard}): ${detail}`);
    this.name = 'OnboardingStageTransitionAbort';
  }
}

export type StageTransitionDbHandle = TargetDbHandle;

export interface CommitStageTransitionInput {
  orgId: string;
  taskId: string;
  leaseEpoch: number;
  attemptOrdinal: number;
  /** `checkpoint.createPlanRevision` = r. */
  createPlanRevision: number;
  /** `checkpoint.planningSnapshot` as read when snapshot 1 was loaded (points at `discover`). */
  snapshotRef: PlanningSnapshotRef;
  /** Snapshot 1's verified facts (the same `facts` given to `resolveCreatedAccounts`). */
  facts: DiscoveryFacts;
  resolved: Extract<ResolveCreatedAccountsResult, { ok: true }>;
  now: Date;
}

export interface StageTransitionCommitted {
  /** r + 1: the revision `provision_effects` must be opened at. */
  newRevision: number;
  /** The `resolve_accounts` step row now holding snapshot 2. */
  resolveStepId: string;
  /** The ref to write into the task checkpoint's `planningSnapshot`. */
  snapshot: PlanningSnapshotRef;
  envelope: PlanningSnapshotEnvelope;
  contactTargetId: string;
  frozen: OnboardingAccountProvider[];
  supersededApprovalId: string | null;
}

function abort(guard: StageTransitionGuard, detail: string): never {
  throw new OnboardingStageTransitionAbort(guard, detail);
}

/** Absent, or the task checkpoint's REF copied by the move — never an envelope. */
function stepRowHoldsEnvelope(checkpoint: unknown): boolean {
  const held = (checkpoint as Record<string, unknown> | null | undefined)?.planningSnapshot;
  return held !== undefined && !planningSnapshotRefSchema.safeParse(held).success;
}

/** Snapshot 2, pure: snapshot 1's verified facts, then `stage: 'provision'`, then `accounts`. */
function buildSnapshot2(input: CommitStageTransitionInput): { facts: IdentityOnboardingProvisionFacts; sealed: ReturnType<typeof sealPlanningSnapshot> } {
  const s1 = createFacts(input.facts);
  if ('error' in s1) abort('facts_invalid', s1.error);
  let parsed;
  try {
    // The recipe's own strict parse, including its rule that a resolved
    // account may not contradict a snapshot-1 collision check.
    parsed = parseIdentityOnboardingFacts({ ...s1, stage: 'provision', accounts: input.resolved.accounts });
  } catch (err) {
    abort('facts_invalid', errorMessage(err));
  }
  if (parsed.stage !== 'provision') abort('facts_invalid', 'snapshot 2 did not parse as the provision stage');
  return { facts: parsed, sealed: sealPlanningSnapshot(parsed, input.now) };
}

/**
 * B2 steps 1–4 on the CALLER's handle, inside its leased write at r:
 *   1. guards — the task is at r, at `resolve_accounts`, no operation at r is
 *      `pending`/`unknown`, the ref still points at `discover`;
 *   2. `bumpPlanRevisionInTx` r → r+1 (anything but `bumped: true` throws);
 *   3. freeze each resolved account (with its `target_account_frozen` event)
 *      and upsert the contact's external links;
 *   4. write snapshot 2 onto the `resolve_accounts` row, once.
 * Opens no transaction and no db context. Every miss THROWS
 * `OnboardingStageTransitionAbort`; it never returns early. The caller then
 * re-points the ref, settles `resolve_accounts` and opens `provision_effects`
 * at `newRevision` on the same handle.
 */
export async function commitOnboardingStageTransition(
  dbh: StageTransitionDbHandle,
  input: CommitStageTransitionInput,
): Promise<StageTransitionCommitted> {
  const r = input.createPlanRevision;
  const { orgId, taskId } = input;
  const providers = (['google', 'm365'] as const).filter((p) => input.resolved.accounts[p] !== null);
  if (providers.length === 0) abort('nothing_resolved', 'no account resolved; hand off instead of bumping');
  // Pure, and before any statement: a malformed snapshot 2 never costs a bump.
  const snapshot2 = buildSnapshot2(input);

  // ── 1. Guards ────────────────────────────────────────────────────────────
  const [task] = await dbh
    .select({
      id: aiOperatorTasks.id, orgId: aiOperatorTasks.orgId, revision: aiOperatorTasks.revision,
      currentStepKey: aiOperatorTasks.currentStepKey, checkpoint: aiOperatorTasks.checkpoint,
    })
    .from(aiOperatorTasks)
    .where(and(eq(aiOperatorTasks.id, taskId), eq(aiOperatorTasks.orgId, orgId)))
    .limit(1);
  if (!task || task.id !== taskId || task.orgId !== orgId || task.revision !== r) {
    abort('revision_moved', `the task is at revision ${task?.revision ?? '(missing)'}, not the create revision ${r}`);
  }
  if (task.currentStepKey !== RESOLVE_STEP_KEY) {
    abort('wrong_step', `the task is at step '${task.currentStepKey ?? '(none)'}', not '${RESOLVE_STEP_KEY}'`);
  }
  const ref = (task.checkpoint as Record<string, unknown> | null)?.planningSnapshot as Partial<PlanningSnapshotRef> | undefined;
  if (!ref || ref.stepId !== input.snapshotRef.stepId || ref.digest !== input.snapshotRef.digest) {
    abort('snapshot_ref_moved', 'the task checkpoint no longer references the snapshot the accounts were resolved from');
  }
  const [refRow] = await dbh
    .select({ id: aiOperatorTaskSteps.id, orgId: aiOperatorTaskSteps.orgId, taskId: aiOperatorTaskSteps.taskId, stepKey: aiOperatorTaskSteps.stepKey })
    .from(aiOperatorTaskSteps)
    .where(and(eq(aiOperatorTaskSteps.orgId, orgId), eq(aiOperatorTaskSteps.taskId, taskId), eq(aiOperatorTaskSteps.id, input.snapshotRef.stepId)))
    .limit(1);
  if (!refRow || refRow.orgId !== orgId || refRow.taskId !== taskId || refRow.stepKey !== 'discover') {
    abort('snapshot_ref_moved', `the planning snapshot ref points at '${refRow?.stepKey ?? '(missing)'}', not 'discover'`);
  }
  const unsettled = await dbh
    .select({ id: aiOperatorOperations.id })
    .from(aiOperatorOperations)
    .where(and(
      eq(aiOperatorOperations.orgId, orgId),
      eq(aiOperatorOperations.taskId, taskId),
      eq(aiOperatorOperations.planRevision, r),
      inArray(aiOperatorOperations.resultState, ['pending', 'unknown']),
    ))
    .limit(1);
  if (unsettled.length > 0) {
    abort('operation_unsettled', `an operation at revision ${r} has not settled; its effect may still land`);
  }
  const contactTargetId = snapshot2.facts.targets.contactTargetId;
  const [contact] = await dbh
    .select({
      id: aiOperatorTaskTargets.id, orgId: aiOperatorTaskTargets.orgId, taskId: aiOperatorTaskTargets.taskId,
      targetKind: aiOperatorTaskTargets.targetKind, contactId: aiOperatorTaskTargets.contactId,
    })
    .from(aiOperatorTaskTargets)
    .where(and(eq(aiOperatorTaskTargets.orgId, orgId), eq(aiOperatorTaskTargets.taskId, taskId), eq(aiOperatorTaskTargets.id, contactTargetId)))
    .limit(1);
  if (!contact || contact.orgId !== orgId || contact.taskId !== taskId || contact.targetKind !== 'contact' || !contact.contactId) {
    abort('contact_target_missing', `the contact target ${contactTargetId} is missing or detached`);
  }
  const contactId = contact.contactId;
  // Read directly, never through stepService's open-step upsert: its conflict
  // path resets the row to `running` (stepService.ts:104-121).
  const [resolveRow] = await dbh
    .select({
      id: aiOperatorTaskSteps.id, orgId: aiOperatorTaskSteps.orgId, taskId: aiOperatorTaskSteps.taskId,
      stepKey: aiOperatorTaskSteps.stepKey, planRevision: aiOperatorTaskSteps.planRevision, checkpoint: aiOperatorTaskSteps.checkpoint,
    })
    .from(aiOperatorTaskSteps)
    .where(and(
      eq(aiOperatorTaskSteps.orgId, orgId),
      eq(aiOperatorTaskSteps.taskId, taskId),
      eq(aiOperatorTaskSteps.stepKey, RESOLVE_STEP_KEY),
      eq(aiOperatorTaskSteps.attemptOrdinal, input.attemptOrdinal),
    ))
    .orderBy(desc(aiOperatorTaskSteps.createdAt))
    .limit(1)
    .for('update');
  if (!resolveRow || resolveRow.orgId !== orgId || resolveRow.taskId !== taskId
    || resolveRow.stepKey !== RESOLVE_STEP_KEY || resolveRow.planRevision !== r) {
    abort('resolve_step_missing', `no '${RESOLVE_STEP_KEY}' step row at attempt ${input.attemptOrdinal}, revision ${r}`);
  }
  if (stepRowHoldsEnvelope(resolveRow.checkpoint)) {
    abort('snapshot_already_written', `the '${RESOLVE_STEP_KEY}' row already carries a planning snapshot`);
  }

  // ── 2. The bump, r → r+1, on this handle ────────────────────────────────
  const bump = await bumpPlanRevisionInTx(dbh, {
    orgId, taskId, fromRevision: r, leaseEpoch: input.leaseEpoch,
    detail: `resolve_accounts: froze ${providers.join(', ')}; provisioning plans at the next revision`,
  });
  if (bump.bumped !== true || bump.newRevision !== r + 1) {
    abort('bump_lost', `the plan revision did not move ${r} -> ${r + 1} (bumped=${String(bump.bumped)}, at ${bump.newRevision})`);
  }

  // ── 3. Freeze + links ────────────────────────────────────────────────────
  for (const provider of providers) {
    const account = input.resolved.accounts[provider]!;
    // The actor makes freezeTargetAccount append `target_account_frozen`
    // (provider, immutable id, label — no secret).
    await freezeTargetAccount(dbh, {
      orgId, taskId, targetId: contactTargetId, provider,
      connectionId: input.resolved.connectionIds[provider],
      externalId: account.externalId, principalLabel: account.principalLabel, actor: COORDINATOR,
    });
  }
  await upsertContactExternalLinks(dbh, {
    orgId, contactId,
    links: providers.map((system) => ({ system, externalId: input.resolved.accounts[system]!.externalId })),
  });

  // ── 4. Snapshot 2, once ──────────────────────────────────────────────────
  const stepCheckpoint = { ...((resolveRow.checkpoint as Record<string, unknown> | null) ?? {}), planningSnapshot: snapshot2.sealed.envelope };
  const written = await dbh
    .update(aiOperatorTaskSteps)
    .set({ checkpoint: stepCheckpoint as unknown as Record<string, unknown>, updatedAt: new Date() })
    .where(and(
      eq(aiOperatorTaskSteps.id, resolveRow.id),
      eq(aiOperatorTaskSteps.orgId, orgId),
      eq(aiOperatorTaskSteps.taskId, taskId),
      // The write-once CAS: no envelope (which always carries `facts`) yet.
      sql`(${aiOperatorTaskSteps.checkpoint} #> '{planningSnapshot,facts}') IS NULL`,
    ))
    .returning({ id: aiOperatorTaskSteps.id });
  if (written.length !== 1) {
    abort('snapshot_already_written', `the '${RESOLVE_STEP_KEY}' row gained a planning snapshot concurrently`);
  }

  return {
    newRevision: bump.newRevision,
    resolveStepId: resolveRow.id,
    snapshot: { stepId: resolveRow.id, digest: snapshot2.sealed.digest },
    envelope: snapshot2.sealed.envelope,
    contactTargetId,
    frozen: [...providers],
    supersededApprovalId: bump.supersededApprovalId,
  };
}
