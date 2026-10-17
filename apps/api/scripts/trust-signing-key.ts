#!/usr/bin/env tsx
/**
 * `trust:signing-key` — operator CLI for the Trust Center attestation keyset
 * (W3b, #8771). Keys sign the public trust-page attestations served at
 * /api/v1/trust/attestation/*; verifiers fetch the public halves from
 * /api/v1/trust/attestation/jwks.json.
 *
 *   list                      Print the keyset.
 *   prepare                   Create a PENDING key. It is published in the JWKS
 *                             at once, but does not sign.
 *   activate <kid> [--force]  Make a pending key the signer. The previous signer
 *                             becomes verify_only (still in the JWKS so archived
 *                             attestations verify) and its private key is
 *                             destroyed. Refused until the pending key has been
 *                             published for the JWKS max-age (600 s) so caching
 *                             verifiers already hold it; --force skips the wait.
 *   revoke <kid> [--replace]  Remove a key from the JWKS and destroy its private
 *                             key (compromise). Revoking the signer leaves NO
 *                             signer — attestation answers 503 — unless
 *                             --replace, which mints and activates a successor
 *                             in the same transaction. Verifiers that cache the
 *                             JWKS stop trusting the key within 10 minutes.
 *
 * Usage:
 *   pnpm --filter @breeze/api trust:signing-key list
 *   pnpm --filter @breeze/api trust:signing-key prepare
 *   pnpm --filter @breeze/api trust:signing-key activate trust-AbCdEf0123456789
 *   pnpm --filter @breeze/api trust:signing-key revoke trust-AbCdEf0123456789 --replace
 *
 * Prints kids, statuses and dates only — never key material. Each command
 * writes an audit_logs system entry `trust_signing_key.<command>`.
 * Exit codes: 0 success, 1 refusal or failure — including a committed key change whose audit entry could not be
 * written, or a revoke that could not be announced to running API instances (both say so on stderr).
 */
import { closeDb } from '../src/db';
import { closeRedis } from '../src/services/redis';
import { createAuditLog } from '../src/services/auditService';
import {
  activateTrustSigningKey,
  listTrustSigningKeys,
  notifyTrustKeysetChanged,
  prepareTrustSigningKey,
  revokeTrustSigningKey,
  type TrustKeyInfo,
} from '../src/services/trustPage/attestationKeys';

const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
const USAGE = 'usage: trust-signing-key list | prepare | activate <kid> [--force] | revoke <kid> [--replace]';

export type TrustSigningKeyCommand =
  | { command: 'list' }
  | { command: 'prepare' }
  | { command: 'activate'; kid: string; force: boolean }
  | { command: 'revoke'; kid: string; replace: boolean };

export function parseTrustSigningKeyArgs(argv: string[]): TrustSigningKeyCommand {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const [command, kid, ...rest] = argv.filter((a) => !a.startsWith('--'));
  if (rest.length > 0) throw new Error(USAGE);
  const allowFlags = (allowed: string[]) => {
    for (const f of flags) if (!allowed.includes(f)) throw new Error(`unknown flag ${f}\n${USAGE}`);
  };
  switch (command) {
    case 'list':
    case 'prepare':
      if (kid) throw new Error(USAGE);
      allowFlags([]);
      return { command };
    case 'activate':
      if (!kid) throw new Error(USAGE);
      allowFlags(['--force']);
      return { command, kid, force: flags.has('--force') };
    case 'revoke':
      if (!kid) throw new Error(USAGE);
      allowFlags(['--replace']);
      return { command, kid, replace: flags.has('--replace') };
    default:
      throw new Error(USAGE);
  }
}

const iso = (d: Date | null) => (d ? d.toISOString() : '-');

export function formatKeyset(keys: TrustKeyInfo[]): string {
  if (keys.length === 0) return '(no trust signing keys — one is created on first attestation)';
  const header = ['kid', 'status', 'created', 'activated', 'retired', 'revoked'];
  const rows = keys.map((k) => [k.kid, k.status, iso(k.createdAt), iso(k.activatedAt), iso(k.retiredAt), iso(k.revokedAt)]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  return [header, ...rows].map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd()).join('\n');
}

async function audit(cmd: TrustSigningKeyCommand, kid: string | null, keyset: TrustKeyInfo[]): Promise<void> {
  await createAuditLog({
    orgId: null,
    actorType: 'system',
    actorId: SYSTEM_ACTOR_ID,
    action: `trust_signing_key.${cmd.command}`,
    resourceType: 'trust_signing_key',
    resourceName: kid ?? undefined,
    details: {
      ...('force' in cmd ? { force: cmd.force } : {}),
      ...('replace' in cmd ? { replace: cmd.replace } : {}),
      keyset: keyset.map((k) => ({ kid: k.kid, status: k.status })),
    },
    result: 'success',
    initiatedBy: 'manual',
  });
}

async function main(): Promise<void> {
  const cmd = parseTrustSigningKeyArgs(process.argv.slice(2));
  let kid: string | null = null;
  let keyset: TrustKeyInfo[];
  switch (cmd.command) {
    case 'list':
      keyset = await listTrustSigningKeys();
      break;
    case 'prepare': {
      const prepared = await prepareTrustSigningKey();
      kid = prepared.kid;
      keyset = await listTrustSigningKeys();
      console.log(`[trust-signing-key] Prepared ${prepared.kid}. It is in the JWKS now; activate it in 10 minutes or later.`);
      break;
    }
    case 'activate':
      kid = cmd.kid;
      keyset = await activateTrustSigningKey(cmd.kid, { force: cmd.force });
      console.log(`[trust-signing-key] Activated ${cmd.kid}. The previous signer is verify_only.`);
      break;
    case 'revoke':
      kid = cmd.kid;
      keyset = await revokeTrustSigningKey(cmd.kid, { replace: cmd.replace });
      console.log(
        cmd.replace
          ? `[trust-signing-key] Revoked ${cmd.kid} and activated a successor.`
          : `[trust-signing-key] Revoked ${cmd.kid}. If it was the signer, attestation answers 503 until a key is activated.`,
      );
      break;
  }
  console.log(formatKeyset(keyset));

  // The key change has COMMITTED by now. Announce it before anything else can fail, so a compromise response
  // reaches every API instance even if the audit write below does not land.
  if (cmd.command !== 'list') {
    const outcome = await notifyTrustKeysetChanged();
    if (outcome === 'published') {
      console.log('[trust-signing-key] Running API instances notified.');
    } else {
      console.error(
        `[trust-signing-key] WARNING: running API instances were NOT notified (${outcome}); they keep the previous keyset for up to 60 s each.`,
      );
      if (cmd.command === 'revoke') process.exitCode = 1;
    }
  }

  try {
    await audit(cmd, kid, keyset);
  } catch (err) {
    console.error(
      `[trust-signing-key] The key change above COMMITTED, but its audit_logs entry trust_signing_key.${cmd.command} could not be written: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  }
}

// Only run when executed directly — importing this module must not open a DB pool or exit the process.
const invokedDirectly = typeof process.argv[1] === 'string' && /trust-signing-key(\.ts|\.js|\.cjs)?$/.test(process.argv[1]);

if (invokedDirectly) {
  main()
    .catch((error: unknown) => {
      console.error(`[trust-signing-key] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeRedis();
      await closeDb();
      process.exit(process.exitCode ?? 0);
    });
}
