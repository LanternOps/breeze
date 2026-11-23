/**
 * TPM evidence for a reattach (#8318 wave T2, spec §7.3, §8, §12.2).
 *
 * `tpm_continuity` says one thing: the new install (source) proved possession
 * of the same TPM endorsement key the existing record (target) proved before.
 * It is KEY continuity, not "the same physical TPM" and not "a genuine TPM":
 * the EK certificate is not validated yet (wave T3), a cloned virtual TPM
 * carries its keys along, and a software TPM can be given any key. What it
 * replaces is the typed hostname confirmation, nothing else (§8).
 *
 * One rule, here, for every reader: detection (services/reinstallCandidates),
 * the candidates viewer, the request and the stage/confirm re-check
 * (revalidation.ts). Anything short of every condition is `hint`, with the
 * reason the viewer shows.
 *
 * Reads of device_hardware take no row lock. The invariant that makes them
 * stable inside a reattach transaction: every writer of the tpm_* columns
 * (services/tpmAttestation, services/tpmBaseline) locks the device
 * row FOR NO KEY UPDATE (or stronger) first, and the request and confirm hold
 * both device rows FOR UPDATE. Phase 1 (stage) holds FOR KEY SHARE, which does
 * not block those writers: its re-check is advisory, confirm's is the
 * authoritative one (tpmBaselineWriters.contract.test.ts pins the writers).
 * The holder count is kept still by a per-key advisory lock (lockTpmKey).
 */
import { and, eq, inArray, notExists, notInArray, sql } from 'drizzle-orm';
import { deviceHardware, deviceReattachments, devices, organizations } from '../../db/schema';
import type { ReattachTx } from './intentStore';

export type ReattachEvidenceLevel = 'hint' | 'tpm_continuity';

/** Why a pair is `hint` and not `tpm_continuity`. Never says which key. */
export type TpmEvidenceGap =
  | 'source_no_key'
  | 'source_key_changed'
  | 'source_key_not_proven_by_install'
  | 'target_no_key'
  | 'target_key_changed'
  | 'keys_differ'
  | 'key_shared';

export type TpmEvidence =
  | { level: 'tpm_continuity' }
  | { level: 'hint'; gap: TpmEvidenceGap };

/** The tpm_* columns of one device_hardware row (null fields when the row is absent). */
export interface TpmKeyState {
  ekSha256: string | null;
  attestedAt: Date | null;
  mismatchSha256: string | null;
}

export const NO_TPM_KEY: TpmKeyState = { ekSha256: null, attestedAt: null, mismatchSha256: null };

export interface TpmEvidenceInput {
  source: TpmKeyState;
  /** When the source's CURRENT install enrolled (installStartedAt): its baseline must have been proven by THIS install. */
  sourceInstallStartedAt: Date;
  target: TpmKeyState;
  /**
   * Other devices of the partner, besides the source and the target, whose
   * baseline is the same key, retired reattach sources excluded (their row
   * keeps the key of the machine that moved on). Any is `key_shared`: a
   * cloned VM template, not one machine. Ephemeral and decommissioned rows
   * count: fail toward `hint`.
   */
  otherHolders: number;
}

/**
 * `tpm_continuity` only when:
 *  - the source has a baseline, holds no mismatch, and proved it at or after
 *    its current install started (installStartedAt: a re-enrolled row keeps
 *    the previous install's hardware row; that proof is not this install's);
 *  - the target has a baseline and holds no mismatch (a key change waiting
 *    for review is exactly what continuity must not paper over);
 *  - both baselines are the same key;
 *  - no other device of the partner carries that key.
 * Pure.
 */
export function tpmEvidence(input: TpmEvidenceInput): TpmEvidence {
  const { source, target } = input;
  if (!source.ekSha256 || !source.attestedAt) return { level: 'hint', gap: 'source_no_key' };
  if (source.mismatchSha256) return { level: 'hint', gap: 'source_key_changed' };
  if (source.attestedAt.getTime() < input.sourceInstallStartedAt.getTime()) {
    return { level: 'hint', gap: 'source_key_not_proven_by_install' };
  }
  if (!target.ekSha256) return { level: 'hint', gap: 'target_no_key' };
  if (target.mismatchSha256) return { level: 'hint', gap: 'target_key_changed' };
  if (source.ekSha256 !== target.ekSha256) return { level: 'hint', gap: 'keys_differ' };
  if (input.otherHolders > 0) return { level: 'hint', gap: 'key_shared' };
  return { level: 'tpm_continuity' };
}

/**
 * Whether the SOURCE side alone can ever give `tpm_continuity` (detection's
 * gate before it searches by key): a baseline this install proved, no
 * mismatch held.
 */
export function sourceKeyUsable(source: TpmKeyState, sourceInstallStartedAt: Date): source is TpmKeyState & { ekSha256: string } {
  return Boolean(source.ekSha256 && source.attestedAt && !source.mismatchSha256
    && source.attestedAt.getTime() >= sourceInstallStartedAt.getTime());
}

/**
 * When the current install of a device row started: the latest of its
 * enrollment, a re-enroll onto it (`install_enrolled_at`, wave T2) and a
 * reattach confirm that handed it to a new install (`incarnation_started_at`).
 * Rows from before `install_enrolled_at` read as enrolled.
 */
export function installStartedAt(row: {
  createdAt: Date;
  enrolledAt: Date | null;
  installEnrolledAt: Date | null;
  incarnationStartedAt: Date | null;
}): Date {
  const times = [row.enrolledAt ?? row.createdAt, row.installEnrolledAt, row.incarnationStartedAt]
    .filter((t): t is Date => t instanceof Date)
    .map((t) => t.getTime());
  return new Date(Math.max(...times));
}

type Reader = Pick<ReattachTx, 'select'>;
type Locker = Pick<ReattachTx, 'select' | 'execute'>;

/**
 * Serialize everyone who makes, or counts, holders of one key: a
 * transaction-scoped advisory lock on the key hash. The device row locks keep
 * the source's and the target's key still; this keeps a THIRD device from
 * becoming a holder between the holder count and the commit (two clones
 * attesting while a reattach confirms). Taken after the caller's device row
 * locks, by the count (readTpmEvidence with `lockKey`) and by every writer
 * that sets a baseline (services/tpmAttestation, services/tpmBaseline). Keyed
 * by the hash alone: a collision across partners only serializes.
 */
export async function lockTpmKey(tx: Pick<ReattachTx, 'execute'>, ekSha256: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`device-tpm-ek:${ekSha256}`}, 0))`);
}

/** The tpm_* columns of these devices (absent rows are NO_TPM_KEY). */
export async function readTpmKeyStates(reader: Reader, deviceIds: readonly string[]): Promise<Map<string, TpmKeyState>> {
  const out = new Map<string, TpmKeyState>(deviceIds.map((id) => [id, NO_TPM_KEY]));
  if (deviceIds.length === 0) return out;
  const rows = await reader
    .select({
      deviceId: deviceHardware.deviceId,
      ekSha256: deviceHardware.tpmEkPubSha256,
      attestedAt: deviceHardware.tpmAttestedAt,
      mismatchSha256: deviceHardware.tpmEkMismatchSha256,
    })
    .from(deviceHardware)
    .where(inArray(deviceHardware.deviceId, [...deviceIds]));
  for (const { deviceId, ...state } of rows) out.set(deviceId, state);
  return out;
}

/**
 * How many devices of `partnerId`, other than `excludeDeviceIds`, carry
 * `ekSha256` as their baseline, retired reattach sources not counted. Needs
 * a system DB context (partner-wide, and the ledger). Counts at most 1: the
 * rule only asks "any".
 */
export async function countOtherKeyHolders(
  reader: Reader,
  input: { partnerId: string; ekSha256: string; excludeDeviceIds: readonly string[] },
): Promise<number> {
  // NOT EXISTS, never NOT IN: a NULL in the subquery would make NOT IN
  // exclude every row and turn the count into 0 (fail open).
  const retired = reader
    .select({ one: sql`1` })
    .from(deviceReattachments)
    .where(eq(deviceReattachments.sourceDeviceId, devices.id));
  const rows = await reader
    .select({ id: deviceHardware.deviceId })
    .from(deviceHardware)
    .innerJoin(devices, eq(devices.id, deviceHardware.deviceId))
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .where(and(
      eq(deviceHardware.tpmEkPubSha256, input.ekSha256),
      eq(organizations.partnerId, input.partnerId),
      input.excludeDeviceIds.length > 0 ? notInArray(devices.id, [...input.excludeDeviceIds]) : sql`true`,
      notExists(retired),
    ))
    .limit(1);
  return rows.length;
}

/**
 * The evidence for (source, target) as it is now, read in `reader`'s
 * transaction (system scope). Callers that need it stable hold both device
 * rows FOR UPDATE (see the module comment).
 */
export async function readTpmEvidence(
  reader: Locker,
  input: {
    partnerId: string;
    sourceDeviceId: string;
    sourceInstallStartedAt: Date;
    targetDeviceId: string;
    /** Hold the key's advisory lock to commit (lockTpmKey): the request and the stage/confirm re-check. */
    lockKey?: boolean;
  },
): Promise<TpmEvidence> {
  const states = await readTpmKeyStates(reader, [input.sourceDeviceId, input.targetDeviceId]);
  const source = states.get(input.sourceDeviceId) ?? NO_TPM_KEY;
  const target = states.get(input.targetDeviceId) ?? NO_TPM_KEY;
  const base = { source, target, sourceInstallStartedAt: input.sourceInstallStartedAt };
  // Count only when every other condition holds: the count is the one
  // partner-wide read.
  const otherwise = tpmEvidence({ ...base, otherHolders: 0 });
  if (otherwise.level === 'hint') return otherwise;
  if (input.lockKey) await lockTpmKey(reader, source.ekSha256!);
  const otherHolders = await countOtherKeyHolders(reader, {
    partnerId: input.partnerId,
    ekSha256: source.ekSha256!,
    excludeDeviceIds: [input.sourceDeviceId, input.targetDeviceId],
  });
  return tpmEvidence({ ...base, otherHolders });
}
