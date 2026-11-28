/**
 * Deploy-key management for full partner admins (#8318 wave D-1, spec §10):
 * list, mint, rotate, revoke. Called only by routes/preAssignmentDeployKeys.ts,
 * which resolves the partner and validates the step-up grant first.
 *
 * Every read and write runs in a fresh system context bound to ONE partner id
 * (partner_deploy_keys is system-only under RLS, like the holding-area
 * ledger). Each entry point re-checks canManagePartnerWidePolicies on the
 * actor, so the service never trusts its caller for the gate.
 *
 * Mint and rotate:
 *   1. eligibility (services/deployKeys/eligibility.ts) — refused before the
 *      holding org is created;
 *   2. getOrCreateUnassignedPoolOrg, in its own system context, BEFORE the
 *      transaction below (it takes the same holding-area lock in its own
 *      transaction);
 *   3. one transaction: the per-partner holding-area lock, eligibility again,
 *      the active-key count for the image (at most
 *      DEPLOY_KEY_MAX_ACTIVE_PER_IMAGE, counted under the lock so two
 *      concurrent mints cannot both pass), then — when a step-up grant is
 *      given — the actor's assurance and live session are locked and the
 *      single-use grant consumed, and the row is written.
 *   Lifetime is measured on the database clock (`now()` + N days), the same
 *   clock the lifetime CHECK compares against.
 *
 * Rotate writes a successor with `rotated_from_id`; the old key stays active
 * (it is the one in the images already in the field) until it is revoked.
 *
 * Revoke marks the key revoked in its own short transaction and then, in the
 * same request, expires every device it parked
 * (expireDevicesParkedByDeployKey, which also cancels their open reattach
 * intents with `key_revoked`). There is no option to skip that. Revoking an
 * already revoked key is not an error: it runs the expiry again, so a revoke
 * whose expiry failed part-way can simply be repeated.
 *
 * LOCK ORDER (holdingAreaLock.ts): holding-area lock → deploy-key row →
 * users / refresh-family rows (step-up). Revoke takes the key row only, never
 * the holding-area lock after it, so it cannot deadlock against an enrollment
 * that holds the holding-area lock and then claims a use on the key row.
 */
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { partnerDeployKeys, type PartnerDeployKey } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { canManagePartnerWidePolicies } from '../partnerWideAccess';
import { consumeStepUpGrant, type StepUpGrantBinding } from '../mfaStepUpGrant';
import { lockActorAssurance } from '../stepUpActorAssurance';
import { lockLiveUserSession } from '../unassignedPool/assignParkedDeviceSteps';
import { lockPartnerHoldingArea } from '../unassignedPool/holdingAreaLock';
import { getOrCreateUnassignedPoolOrg } from '../unassignedPool/poolOrg';
import { DEPLOY_KEY_MAX_ACTIVE_PER_IMAGE } from '../unassignedPool/limits';
import { expireDevicesParkedByDeployKey, type ExpireByKeyResult } from '../unassignedPool/incidentActions';
import { readDeployKeyEligibility, type DeployKeyIneligibleReason } from './eligibility';
import { generateDeployKey, hashDeployKey } from './keyFormat';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const inSystemContext = <T>(fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn));

/** Most keys one list returns; a partner holds a handful per image. */
const LIST_LIMIT = 500;

export interface DeployKeyActor {
  auth: AuthContext;
  partnerId: string;
}

export interface DeployKeyStepUp {
  grantId: string;
  binding: StepUpGrantBinding;
}

/** Every column except the hash. */
const VIEW_COLUMNS = {
  id: partnerDeployKeys.id,
  partnerId: partnerDeployKeys.partnerId,
  name: partnerDeployKeys.name,
  imageLabel: partnerDeployKeys.imageLabel,
  status: partnerDeployKeys.status,
  createdBy: partnerDeployKeys.createdBy,
  createdAt: partnerDeployKeys.createdAt,
  expiresAt: partnerDeployKeys.expiresAt,
  maxUsage: partnerDeployKeys.maxUsage,
  usageCount: partnerDeployKeys.usageCount,
  maxParked: partnerDeployKeys.maxParked,
  revokedAt: partnerDeployKeys.revokedAt,
  revokedBy: partnerDeployKeys.revokedBy,
  rotatedFromId: partnerDeployKeys.rotatedFromId,
  lastUsedAt: partnerDeployKeys.lastUsedAt,
  lastUsedIp: partnerDeployKeys.lastUsedIp,
  sourceCidrs: partnerDeployKeys.sourceCidrs,
};

type DeployKeyRow = Omit<PartnerDeployKey, 'keyHash'>;

/** What the routes return for a key. Never carries the hash. */
export type DeployKeyView = DeployKeyRow & { expired: boolean };

function toView(row: DeployKeyRow, now: number = Date.now()): DeployKeyView {
  return { ...row, expired: row.expiresAt.getTime() <= now };
}

export type DeployKeyRefusalCode =
  | 'PARTNER_WIDE_WRITE_DENIED'
  | 'PARTNER_NOT_FOUND'
  | 'DEPLOY_KEY_NOT_ELIGIBLE'
  | 'ACTIVE_KEY_LIMIT_REACHED'
  | 'DEPLOY_KEY_NOT_FOUND'
  | 'DEPLOY_KEY_REVOKED'
  | 'STEP_UP_REQUIRED';

export type DeployKeyRefusal = {
  ok: false;
  code: DeployKeyRefusalCode;
  message: string;
  /** Present on DEPLOY_KEY_NOT_ELIGIBLE. */
  reason?: Exclude<DeployKeyIneligibleReason, 'partner_not_found'>;
};

const INELIGIBLE_MESSAGE: Record<Exclude<DeployKeyIneligibleReason, 'partner_not_found'>, string> = {
  partner_not_trusted: 'Deploy keys need a partner in good standing (trust state "trusted")',
  enrollment_switch_off: 'Deploy-key enrollment is switched off for this partner',
  payment_method_missing: 'Deploy keys need a payment method on file',
  billing_status_contradicts_payment: 'Deploy keys are unavailable while the subscription is not in good standing',
};

function refuse(code: DeployKeyRefusalCode, message: string): DeployKeyRefusal {
  return { ok: false, code, message };
}

const DENIED = () => refuse('PARTNER_WIDE_WRITE_DENIED', 'Deploy keys are managed by full partner admins only');
const NOT_FOUND = () => refuse('DEPLOY_KEY_NOT_FOUND', 'Deploy key not found');

function ineligible(reason: DeployKeyIneligibleReason): DeployKeyRefusal {
  if (reason === 'partner_not_found') return refuse('PARTNER_NOT_FOUND', 'Partner not found');
  return { ok: false, code: 'DEPLOY_KEY_NOT_ELIGIBLE', message: INELIGIBLE_MESSAGE[reason], reason };
}

function activeLimitRefusal(): DeployKeyRefusal {
  return refuse(
    'ACTIVE_KEY_LIMIT_REACHED',
    `This image already has ${DEPLOY_KEY_MAX_ACTIVE_PER_IMAGE} active deploy keys (the current one and its rotation successor). Revoke one before minting or rotating another.`,
  );
}

/** Unexpired active keys of one image (label compared case-insensitively). */
async function countActiveKeysForImage(tx: Tx, partnerId: string, imageLabel: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(partnerDeployKeys)
    .where(and(
      eq(partnerDeployKeys.partnerId, partnerId),
      eq(partnerDeployKeys.status, 'active'),
      sql`${partnerDeployKeys.expiresAt} > now()`,
      sql`lower(${partnerDeployKeys.imageLabel}) = lower(${imageLabel})`,
    ));
  return row?.n ?? 0;
}

/**
 * The allow-list as a cidr[] expression: host bits cleared (`network()`),
 * duplicates dropped, sorted. Null means "any source".
 */
function sourceCidrsSql(cidrs: readonly string[] | null | undefined): SQL | null {
  if (!cidrs || cidrs.length === 0) return null;
  const items = sql.join(cidrs.map((c) => sql`${c}`), sql`, `);
  return sql`ARRAY(SELECT DISTINCT network(x::inet) FROM unnest(ARRAY[${items}]::text[]) AS x ORDER BY 1)::cidr[]`;
}

/** Locks the actor's assurance and session, then consumes the grant. */
async function consumeStepUpInTransaction(tx: Tx, auth: AuthContext, stepUp: DeployKeyStepUp): Promise<boolean> {
  const assured = await lockActorAssurance(tx, auth, stepUp.binding)
    && await lockLiveUserSession(tx, { userId: auth.user.id, sid: stepUp.binding.sid });
  return assured && consumeStepUpGrant(stepUp.grantId, stepUp.binding);
}

export async function listDeployKeys(actor: DeployKeyActor): Promise<{ ok: true; keys: DeployKeyView[] } | DeployKeyRefusal> {
  if (!canManagePartnerWidePolicies(actor.auth)) return DENIED();
  const rows = await inSystemContext(() => db
    .select(VIEW_COLUMNS)
    .from(partnerDeployKeys)
    .where(eq(partnerDeployKeys.partnerId, actor.partnerId))
    .orderBy(desc(partnerDeployKeys.createdAt), desc(partnerDeployKeys.id))
    .limit(LIST_LIMIT));
  const now = Date.now();
  return { ok: true, keys: rows.map((r) => toView(r as DeployKeyRow, now)) };
}

export interface MintDeployKeyInput {
  name: string;
  imageLabel: string;
  expiresInDays: number;
  maxUsage: number;
  maxParked: number;
  sourceCidrs?: readonly string[] | null;
}

export type DeployKeyIssued = { ok: true; key: DeployKeyView; plaintextKey: string };

/** Shared front half of mint and rotate: gate, eligibility, holding org. */
async function prepareIssue(actor: DeployKeyActor): Promise<DeployKeyRefusal | null> {
  if (!canManagePartnerWidePolicies(actor.auth)) return DENIED();
  const eligibility = await inSystemContext(() => readDeployKeyEligibility(db, actor.partnerId));
  if (!eligibility.eligible) return ineligible(eligibility.reason);
  await getOrCreateUnassignedPoolOrg(actor.partnerId);
  return null;
}

export async function mintDeployKey(input: {
  actor: DeployKeyActor;
  key: MintDeployKeyInput;
  stepUp: DeployKeyStepUp | null;
}): Promise<DeployKeyIssued | DeployKeyRefusal> {
  const { actor, key } = input;
  const refused = await prepareIssue(actor);
  if (refused) return refused;

  const plaintextKey = generateDeployKey();
  const keyHash = hashDeployKey(plaintextKey);

  return inSystemContext(() => db.transaction(async (tx): Promise<DeployKeyIssued | DeployKeyRefusal> => {
    await lockPartnerHoldingArea(tx, actor.partnerId);
    const eligibility = await readDeployKeyEligibility(tx, actor.partnerId);
    if (!eligibility.eligible) return ineligible(eligibility.reason);
    if (await countActiveKeysForImage(tx, actor.partnerId, key.imageLabel) >= DEPLOY_KEY_MAX_ACTIVE_PER_IMAGE) {
      return activeLimitRefusal();
    }
    if (input.stepUp && !(await consumeStepUpInTransaction(tx, actor.auth, input.stepUp))) {
      return refuse('STEP_UP_REQUIRED', 'Step-up required');
    }
    const [row] = await tx
      .insert(partnerDeployKeys)
      .values({
        partnerId: actor.partnerId,
        name: key.name,
        imageLabel: key.imageLabel,
        keyHash,
        createdBy: actor.auth.user.id,
        expiresAt: sql`now() + make_interval(days => ${key.expiresInDays}::int)`,
        maxUsage: key.maxUsage,
        maxParked: key.maxParked,
        sourceCidrs: sourceCidrsSql(key.sourceCidrs),
      })
      .returning(VIEW_COLUMNS);
    if (!row) throw new Error('deploy key insert returned no row');
    return { ok: true, key: toView(row as DeployKeyRow), plaintextKey };
  }));
}

export interface RotateDeployKeyInput {
  expiresInDays: number;
  name?: string;
  maxUsage?: number;
  maxParked?: number;
  /** Omitted: inherit. Null: clear the allow-list. */
  sourceCidrs?: readonly string[] | null;
}

export async function rotateDeployKey(input: {
  actor: DeployKeyActor;
  deployKeyId: string;
  key: RotateDeployKeyInput;
  stepUp: DeployKeyStepUp | null;
}): Promise<(DeployKeyIssued & { rotatedFrom: DeployKeyView }) | DeployKeyRefusal> {
  const { actor, key } = input;
  const refused = await prepareIssue(actor);
  if (refused) return refused;

  const plaintextKey = generateDeployKey();
  const keyHash = hashDeployKey(plaintextKey);

  return inSystemContext(() => db.transaction(async (tx) => {
    await lockPartnerHoldingArea(tx, actor.partnerId);
    const eligibility = await readDeployKeyEligibility(tx, actor.partnerId);
    if (!eligibility.eligible) return ineligible(eligibility.reason);
    const [old] = await tx
      .select(VIEW_COLUMNS)
      .from(partnerDeployKeys)
      .where(and(eq(partnerDeployKeys.id, input.deployKeyId), eq(partnerDeployKeys.partnerId, actor.partnerId)))
      .limit(1)
      .for('update');
    if (!old) return NOT_FOUND();
    if (old.status === 'revoked') {
      return refuse('DEPLOY_KEY_REVOKED', 'A revoked deploy key cannot be rotated; mint a new one');
    }
    if (await countActiveKeysForImage(tx, actor.partnerId, old.imageLabel) >= DEPLOY_KEY_MAX_ACTIVE_PER_IMAGE) {
      return activeLimitRefusal();
    }
    if (input.stepUp && !(await consumeStepUpInTransaction(tx, actor.auth, input.stepUp))) {
      return refuse('STEP_UP_REQUIRED', 'Step-up required');
    }
    const sourceCidrs = key.sourceCidrs === undefined ? old.sourceCidrs : key.sourceCidrs;
    const [row] = await tx
      .insert(partnerDeployKeys)
      .values({
        partnerId: actor.partnerId,
        name: key.name ?? old.name,
        imageLabel: old.imageLabel,
        keyHash,
        createdBy: actor.auth.user.id,
        expiresAt: sql`now() + make_interval(days => ${key.expiresInDays}::int)`,
        maxUsage: key.maxUsage ?? old.maxUsage,
        maxParked: key.maxParked ?? old.maxParked,
        sourceCidrs: sourceCidrsSql(sourceCidrs),
        rotatedFromId: old.id,
      })
      .returning(VIEW_COLUMNS);
    if (!row) throw new Error('deploy key insert returned no row');
    return {
      ok: true as const,
      key: toView(row as DeployKeyRow),
      plaintextKey,
      rotatedFrom: toView(old as DeployKeyRow),
    };
  }));
}

export type DeployKeyRevoked = {
  ok: true;
  key: DeployKeyView;
  /** The key was already revoked; the expiry ran again. */
  alreadyRevoked: boolean;
  expiry: ExpireByKeyResult;
};

export async function revokeDeployKey(input: {
  actor: DeployKeyActor;
  deployKeyId: string;
}): Promise<DeployKeyRevoked | DeployKeyRefusal> {
  const { actor, deployKeyId } = input;
  if (!canManagePartnerWidePolicies(actor.auth)) return DENIED();

  const revoked = await inSystemContext(() => db.transaction(async (tx) => {
    const [current] = await tx
      .select(VIEW_COLUMNS)
      .from(partnerDeployKeys)
      .where(and(eq(partnerDeployKeys.id, deployKeyId), eq(partnerDeployKeys.partnerId, actor.partnerId)))
      .limit(1)
      .for('update');
    if (!current) return null;
    if (current.status === 'revoked') return { row: current as DeployKeyRow, alreadyRevoked: true };
    const [row] = await tx
      .update(partnerDeployKeys)
      .set({ status: 'revoked', revokedAt: sql`now()`, revokedBy: actor.auth.user.id })
      .where(eq(partnerDeployKeys.id, deployKeyId))
      .returning(VIEW_COLUMNS);
    if (!row) throw new Error('deploy key revoke returned no row');
    return { row: row as DeployKeyRow, alreadyRevoked: false };
  }));
  if (!revoked) return NOT_FOUND();

  // After the revoke committed: a concurrent enrollment either claimed its use
  // before (its ledger row is visible now) or fails its claim on the revoked
  // key, so nothing this key parks escapes the sweep.
  const expiry = await expireDevicesParkedByDeployKey({
    partnerId: actor.partnerId,
    deployKeyId,
    actorUserId: actor.auth.user.id,
  });
  return { ok: true, key: toView(revoked.row), alreadyRevoked: revoked.alreadyRevoked, expiry };
}
