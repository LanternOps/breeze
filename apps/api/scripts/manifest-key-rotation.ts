#!/usr/bin/env tsx
/**
 * `manifest-key-rotation` — the two-phase, operator-driven rotation of a
 * deployment's agent-update manifest signing key.
 *
 * WHY THIS IS TWO PHASES
 * Wave 6 Task 6 froze trust-on-first-use in the agent: once an agent has
 * pinned its one deployment signing key, any previously unseen key is
 * rejected. Rotation therefore cannot be a single act — the fleet has to
 * ADOPT the new key (via a signed delegation) BEFORE the server starts
 * signing with it. Activating first would strand every agent that had not
 * yet checked in: it would be offered manifests signed by a key it does not
 * trust, with re-enrollment as the only remedy.
 *
 *   prepare   Creates a new keypair stored as RETIRED, plus a delegation
 *             record signed by the CURRENT ACTIVE key. Changes nothing about
 *             which key signs manifests. Agents begin adopting the new key
 *             on their next check-in.
 *
 *   activate  Retires the old key, activates the new one, and stamps the
 *             delegation as activated — in one transaction. Runs ONLY when
 *             --epoch matches the prepared epoch AND --confirm-adoption is
 *             present.
 *
 * ROTATION IS OPERATIONALLY FROZEN. `--confirm-adoption` is the operator
 * asserting they have verified fleet adoption. Per the Wave 6 rollout gate,
 * do NOT run `activate` until every non-retired device that checked in
 * during the preceding 30 days reports the prepared delegation epoch,
 * dormant devices are explicitly retired or assigned administrator
 * recovery, and missing-ID compatibility has been disabled.
 *
 * Usage (from the API container / a dev checkout):
 *   pnpm --filter @breeze/api exec tsx scripts/manifest-key-rotation.ts prepare
 *   pnpm --filter @breeze/api exec tsx scripts/manifest-key-rotation.ts prepare --valid-days 45
 *   pnpm --filter @breeze/api exec tsx scripts/manifest-key-rotation.ts activate --epoch 3 --confirm-adoption
 *
 * Exit codes: 0 success, 1 refusal or failure.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';

import { closeDb, db, withSystemDbAccessContext } from '../src/db';
import {
  manifestSigningKeys,
  manifestSigningKeyDelegations,
} from '../src/db/schema/manifestSigningKeys';
import {
  delegationTimestamp,
  signManifestKeyDelegation,
  verifyManifestKeyDelegation,
  type ManifestDelegationSignedFields,
} from '../src/services/manifestSigning';
import { encryptSecret, decryptForColumn } from '../src/services/secretCrypto';

const RAW_KEY_LEN = 32;
const MAX_VALID_DAYS = 365;

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export interface StoredSigningKey {
  keyId: string;
  publicKeyB64: string;
  privateKeyEnc: string;
  status: string;
}

export interface StoredDelegation {
  epoch: number;
  oldKeyId: string;
  newKeyId: string;
  newPublicKeyB64: string;
  notBefore: string;
  notAfter: string;
  signatureB64: string;
  activatedAt: Date | null;
}

export interface PrepareArgs {
  command: 'prepare';
  validDays: number;
}

export interface ActivateArgs {
  command: 'activate';
  epoch: number;
  confirmAdoption: boolean;
}

export type RotationArgs = PrepareArgs | ActivateArgs;

/**
 * The storage seam. Everything the CLI decides is expressed against this
 * interface so the refusal rules — which are the security-relevant part —
 * are unit-testable without a database, and so `prepare`/`activate` each
 * get exactly ONE write call that the real implementation makes
 * transactional.
 */
export interface RotationStore {
  loadActiveKey(): Promise<StoredSigningKey | null>;
  loadDelegations(): Promise<StoredDelegation[]>;
  insertPreparedRotation(input: {
    newKey: { keyId: string; publicKeyB64: string; privateKeyEnc: string };
    delegation: Omit<StoredDelegation, 'activatedAt'>;
  }): Promise<void>;
  applyActivation(input: {
    epoch: number;
    oldKeyId: string;
    newKeyId: string;
    activatedAt: Date;
  }): Promise<void>;
}

// ---------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------

const USAGE = `usage:
  manifest-key-rotation prepare [--valid-days N]
  manifest-key-rotation activate --epoch N --confirm-adoption`;

export function parseRotationArgs(argv: string[]): RotationArgs {
  const [command, ...rest] = argv;

  if (command === 'prepare') {
    let validDays = 30;
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === '--valid-days') {
        validDays = parseIntegerFlag('--valid-days', rest[i + 1]);
        i += 1;
        continue;
      }
      throw new Error(`unknown flag ${rest[i]}\n${USAGE}`);
    }
    return { command: 'prepare', validDays };
  }

  if (command === 'activate') {
    let epoch: number | null = null;
    let confirmAdoption = false;
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === '--epoch') {
        epoch = parseIntegerFlag('--epoch', rest[i + 1]);
        i += 1;
        continue;
      }
      if (rest[i] === '--confirm-adoption') {
        confirmAdoption = true;
        continue;
      }
      throw new Error(`unknown flag ${rest[i]}\n${USAGE}`);
    }
    if (epoch === null) throw new Error(`activate requires --epoch\n${USAGE}`);
    return { command: 'activate', epoch, confirmAdoption };
  }

  throw new Error(
    `${command ? `unknown subcommand "${command}"` : 'missing subcommand'}\n${USAGE}`,
  );
}

/**
 * Strict non-negative integer parsing. Number() would happily accept
 * "1.5", "1e3", " 2 " and "0x10"; an epoch that does not round-trip
 * through the Go agent's strconv.ParseUint is a rotation that silently
 * cannot be adopted.
 */
function parseIntegerFlag(flag: string, raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new Error(
      `${flag} requires a non-negative decimal integer (got ${raw === undefined ? 'nothing' : `"${raw}"`})`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${flag} is out of range`);
  }
  return value;
}

// ---------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------

export async function runPrepare(
  store: RotationStore,
  args: PrepareArgs,
  now: Date = new Date(),
): Promise<StoredDelegation> {
  if (
    !Number.isInteger(args.validDays) ||
    args.validDays <= 0 ||
    args.validDays > MAX_VALID_DAYS
  ) {
    throw new Error(
      `--valid-days must be between 1 and ${MAX_VALID_DAYS} (got ${args.validDays})`,
    );
  }

  const active = await store.loadActiveKey();
  if (!active) {
    throw new Error(
      'no active manifest signing key — nothing to delegate FROM. This deployment has never signed a manifest locally (BINARY_SOURCE=github), so there is no rotation to perform.',
    );
  }

  const delegations = await store.loadDelegations();

  // Refuse a second prepared delegation. Two live records would make the
  // adoption gate ambiguous (which epoch does the operator confirm?) and
  // would let an operator activate the older one after the fleet had
  // already moved past it.
  const pending = delegations.filter(
    (d) => d.activatedAt === null && Date.parse(d.notAfter) > now.getTime(),
  );
  if (pending.length > 0) {
    throw new Error(
      `a delegation is already prepared and pending (epoch ${pending[0]!.epoch}, valid until ${pending[0]!.notAfter}). Activate it with --epoch ${pending[0]!.epoch} --confirm-adoption, or let it expire, before preparing another.`,
    );
  }

  // Monotonic over ALL history, not just live records. Reusing the epoch of
  // an abandoned/expired delegation would produce a record every agent that
  // ever adopted that epoch rejects as a replay.
  const epoch =
    delegations.reduce((max, d) => Math.max(max, d.epoch), 0) + 1;

  const { keyId, publicKeyB64, seedB64 } = generateSigningKey();
  const privateKeyEnc = encryptSecret(seedB64);
  if (!privateKeyEnc) {
    throw new Error('encryptSecret returned null for the new Ed25519 seed');
  }

  const notBefore = delegationTimestamp(now);
  const notAfter = delegationTimestamp(
    new Date(now.getTime() + args.validDays * 24 * 60 * 60 * 1000),
  );

  const fields: ManifestDelegationSignedFields = {
    oldKeyId: active.keyId,
    newKeyId: keyId,
    newPublicKeyB64: publicKeyB64,
    epoch,
    notBefore,
    notAfter,
  };

  // Sign with the CURRENTLY ACTIVE key — the one the fleet already trusts.
  // This is the whole security property: an attacker holding the database
  // but not this private key cannot produce a record any agent will accept.
  const oldSeedB64 = decryptForColumn(
    'manifest_signing_keys',
    'private_key_enc',
    active.privateKeyEnc,
  );
  if (!oldSeedB64) {
    throw new Error(
      'could not decrypt the active signing key — check APP_ENCRYPTION_KEY',
    );
  }
  const signatureB64 = signManifestKeyDelegation(fields, oldSeedB64);

  // Self-check before consuming the epoch. A record that does not verify
  // here will not verify on any agent either, and the epoch would be burnt.
  if (!verifyManifestKeyDelegation(fields, signatureB64, active.publicKeyB64)) {
    throw new Error(
      'internal error: the delegation just signed does not verify against the active public key — refusing to store it',
    );
  }

  const delegation: Omit<StoredDelegation, 'activatedAt'> = {
    ...fields,
    signatureB64,
  };

  await store.insertPreparedRotation({
    newKey: { keyId, publicKeyB64, privateKeyEnc },
    delegation,
  });

  return { ...delegation, activatedAt: null };
}

function generateSigningKey(): {
  keyId: string;
  publicKeyB64: string;
  seedB64: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  return {
    // Same operator-readable shape ensureActiveSigningKey uses.
    keyId: `deploy-${new Date().toISOString().slice(0, 10)}-${randomBytes(4).toString('hex')}`,
    publicKeyB64: spki.subarray(spki.length - RAW_KEY_LEN).toString('base64'),
    seedB64: pkcs8.subarray(pkcs8.length - RAW_KEY_LEN).toString('base64'),
  };
}

// ---------------------------------------------------------------------
// activate
// ---------------------------------------------------------------------

export async function runActivate(
  store: RotationStore,
  args: ActivateArgs,
  now: Date = new Date(),
): Promise<StoredDelegation> {
  // Checked FIRST and before any read, so the refusal cannot be confused
  // with "there was nothing to activate anyway".
  if (!args.confirmAdoption) {
    throw new Error(
      'refusing to activate without --confirm-adoption. Activating before the fleet has adopted the new key strands every agent that has not yet checked in: it will be offered manifests signed by a key it does not trust, and re-enrollment is the only remedy. Confirm fleet adoption of the prepared epoch first.',
    );
  }

  const delegations = await store.loadDelegations();
  const pending = delegations.filter((d) => d.activatedAt === null);

  if (pending.length === 0) {
    throw new Error(
      'no prepared delegation to activate — run `prepare` first (an already-activated epoch cannot be activated again).',
    );
  }

  // Select by IDENTITY, never by position. `loadDelegations` has no ORDER BY,
  // and an abandoned expired prepare stays unactivated forever (nothing in the
  // lifecycle deletes rows, and DELETE is not even granted). Taking pending[0]
  // could therefore land on the stale row: `--epoch <live>` would fail with
  // "does not match the prepared epoch <expired>", and taking that error's
  // advice and passing the expired epoch would fail with "expired" — leaving
  // rotation unactivatable until someone hand-deleted the row. It fails
  // closed, so no wrong key was ever activated, but it wedged the one
  // operation this whole task exists to enable.
  //
  // Selecting by epoch also makes --epoch mean exactly what the brief says it
  // means, independent of row order.
  const prepared = pending.find((d) => d.epoch === args.epoch);
  if (!prepared) {
    const available = pending
      .map((d) => d.epoch)
      .sort((a, b) => a - b)
      .join(', ');
    throw new Error(
      `no prepared delegation with epoch ${args.epoch}. Unactivated epochs on record: ${available}. Re-run with the epoch you have confirmed the fleet has adopted (note an expired record can no longer be activated — prepare a new one).`,
    );
  }

  if (Date.parse(prepared.notAfter) <= now.getTime()) {
    throw new Error(
      `the prepared delegation (epoch ${prepared.epoch}) expired at ${prepared.notAfter}. Agents will no longer accept it; prepare a new one.`,
    );
  }

  await store.applyActivation({
    epoch: prepared.epoch,
    oldKeyId: prepared.oldKeyId,
    newKeyId: prepared.newKeyId,
    activatedAt: now,
  });

  return { ...prepared, activatedAt: now };
}

// ---------------------------------------------------------------------
// The real, database-backed store
// ---------------------------------------------------------------------

export function createDbRotationStore(): RotationStore {
  return {
    async loadActiveKey() {
      return withSystemDbAccessContext(async () => {
        const rows = await db
          .select({
            keyId: manifestSigningKeys.keyId,
            publicKeyB64: manifestSigningKeys.publicKeyB64,
            privateKeyEnc: manifestSigningKeys.privateKeyEnc,
            status: manifestSigningKeys.status,
          })
          .from(manifestSigningKeys)
          .where(eq(manifestSigningKeys.status, 'active'))
          .limit(1);
        return rows[0] ?? null;
      });
    },

    async loadDelegations() {
      return withSystemDbAccessContext(async () => {
        const rows = await db
          .select({
            epoch: manifestSigningKeyDelegations.epoch,
            oldKeyId: manifestSigningKeyDelegations.oldKeyId,
            newKeyId: manifestSigningKeyDelegations.newKeyId,
            newPublicKeyB64: manifestSigningKeyDelegations.newPublicKeyB64,
            notBefore: manifestSigningKeyDelegations.notBefore,
            notAfter: manifestSigningKeyDelegations.notAfter,
            signatureB64: manifestSigningKeyDelegations.signatureB64,
            activatedAt: manifestSigningKeyDelegations.activatedAt,
          })
          .from(manifestSigningKeyDelegations);
        return rows.map((row) => ({
          ...row,
          epoch: Number(row.epoch),
          // Re-render through the same canonical formatter used at write
          // time so the strings compared here are the strings that were
          // signed.
          notBefore: delegationTimestamp(row.notBefore),
          notAfter: delegationTimestamp(row.notAfter),
        }));
      });
    },

    async insertPreparedRotation({ newKey, delegation }) {
      // ONE transaction: an orphan key row with no delegation would leave a
      // private key on disk that nothing can ever authorise, and a
      // delegation with no key row would name a key the server cannot sign
      // with.
      await withSystemDbAccessContext(async () => {
        await db.transaction(async (tx) => {
          await tx.insert(manifestSigningKeys).values({
            keyId: newKey.keyId,
            publicKeyB64: newKey.publicKeyB64,
            privateKeyEnc: newKey.privateKeyEnc,
            // RETIRED on purpose: `prepare` must not change which key signs.
            status: 'retired',
          });
          await tx.insert(manifestSigningKeyDelegations).values({
            epoch: delegation.epoch,
            oldKeyId: delegation.oldKeyId,
            newKeyId: delegation.newKeyId,
            newPublicKeyB64: delegation.newPublicKeyB64,
            notBefore: new Date(delegation.notBefore),
            notAfter: new Date(delegation.notAfter),
            signatureB64: delegation.signatureB64,
          });
        });
      });
    },

    async applyActivation({ epoch, oldKeyId, newKeyId, activatedAt }) {
      await withSystemDbAccessContext(async () => {
        await db.transaction(async (tx) => {
          // Retire BEFORE activating: uq_manifest_signing_keys_active is a
          // partial unique index on (status) WHERE status='active', so the
          // two statements cannot be reordered without tripping it.
          await tx
            .update(manifestSigningKeys)
            .set({ status: 'retired', retiredAt: activatedAt })
            .where(eq(manifestSigningKeys.keyId, oldKeyId));
          await tx
            .update(manifestSigningKeys)
            .set({ status: 'active', retiredAt: null })
            .where(eq(manifestSigningKeys.keyId, newKeyId));
          const stamped = await tx
            .update(manifestSigningKeyDelegations)
            .set({ activatedAt })
            .where(
              and(
                eq(manifestSigningKeyDelegations.epoch, epoch),
                // Only an UNACTIVATED row may be stamped. If a concurrent
                // run already activated it, this matches 0 rows and the
                // guard below rolls the whole transaction back rather than
                // double-rotating.
                isNull(manifestSigningKeyDelegations.activatedAt),
              ),
            )
            .returning({ epoch: manifestSigningKeyDelegations.epoch });
          if (stamped.length === 0) {
            throw new Error(
              `delegation epoch ${epoch} was activated concurrently — rolled back`,
            );
          }
        });
      });
    },
  };
}

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseRotationArgs(process.argv.slice(2));
  const store = createDbRotationStore();

  if (args.command === 'prepare') {
    const delegation = await runPrepare(store, args);
    console.log(
      `[manifest-key-rotation] Prepared delegation epoch ${delegation.epoch}: ${delegation.oldKeyId} -> ${delegation.newKeyId}`,
    );
    console.log(
      `[manifest-key-rotation] Valid ${delegation.notBefore} .. ${delegation.notAfter}`,
    );
    console.log(
      '[manifest-key-rotation] The ACTIVE signing key is unchanged. Agents will adopt the new key on their next check-in.',
    );
    console.log(
      `[manifest-key-rotation] Do NOT activate until every non-retired device that checked in over the last 30 days reports epoch ${delegation.epoch}.`,
    );
    return;
  }

  const delegation = await runActivate(store, args);
  console.log(
    `[manifest-key-rotation] Activated epoch ${delegation.epoch}: ${delegation.newKeyId} is now the active signing key; ${delegation.oldKeyId} is retired.`,
  );
}

// Only run when executed directly — importing this module (the unit test
// does) must not open a DB pool or exit the process.
const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  /manifest-key-rotation(\.ts|\.js|\.cjs)?$/.test(process.argv[1]);

if (invokedDirectly) {
  main()
    .catch((error: unknown) => {
      console.error(
        `[manifest-key-rotation] ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDb();
    });
}
