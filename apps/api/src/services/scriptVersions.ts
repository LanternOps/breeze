/**
 * The ONE writer of `script_versions` (spec §4.1, roadmap §3.2).
 *
 * A version row is an immutable, content-addressed definition of one
 * execution: content plus language, timeout, run context, parameter
 * definitions and a digest, so nothing downstream has to join `scripts` to
 * learn what a past body ran as. Every material change to a script cuts one.
 *
 * Enforced by scriptVersions.writers.contract.test.ts — no other file in
 * apps/api may INSERT into scriptVersions.
 */
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { ScriptApprovalMethod, ScriptOrigin } from '@breeze/shared';
import { db } from '../db';
import { scripts, scriptVersions, type ScriptVersionRow } from '../db/schema/scripts';

export type { ScriptVersionRow };

/**
 * Canonical form for hashing: Unicode NFC, CRLF folded to LF, nothing trimmed.
 *
 * The SQL twin lives in 2026-10-16-100000-script-versions-immutable.sql as
 * `encode(sha256(convert_to(normalize(replace(content, E'\r\n', E'\n'), NFC),
 * 'UTF8')), 'hex')`. Trailing whitespace is deliberately significant — in
 * PowerShell a trailing backtick is a line continuation, so trimming would
 * make two materially different scripts hash the same.
 */
export function sha256Content(content: string): string {
  const canonical = content.normalize('NFC').replace(/\r\n/g, '\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** The Drizzle transaction handle every writer already has in hand. */
export type ScriptVersionTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Read-side executor: the pooled db or a transaction. */
export type ScriptVersionExecutor = typeof db | ScriptVersionTx;

export interface ScriptVersionProvenance {
  origin: ScriptOrigin;
  proposalId?: string | null;
  reviewId?: string | null;
  reviewedAt?: Date | null;
  approvedBy?: string | null;
  approvedAt?: Date | null;
  approvalMethod?: ScriptApprovalMethod | null;
  changelog?: string | null;
  createdBy: string | null;
}

/**
 * Raised when the script row is gone or invisible under RLS, so there is
 * nothing to cut a version from.
 *
 * NOT caught by any caller, deliberately: every call site has already written
 * to `scripts` inside the same transaction, so the only correct response is to
 * let this propagate, roll that write back, and surface a 500 through
 * `app.onError` (which captures it to Sentry). Swallowing it into a 404 would
 * mean reporting "not found" for a save that is half-applied in memory, and
 * catching it to continue would leave a bumped `scripts.version` with no row
 * behind it — unrepairable, since `script_versions` is append-only.
 *
 * It should be unreachable in practice: the row is locked `FOR UPDATE` inside
 * the same transaction that just wrote to it.
 */
export class ScriptVersionCutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptVersionCutError';
  }
}

/**
 * Cut the next immutable version of a script.
 *
 * Contract: the caller has ALREADY written whatever it is changing onto the
 * `scripts` row inside `tx` and has NOT touched `scripts.version`. This helper
 * then locks the row `FOR UPDATE`, increments `version`, and snapshots the
 * AFTER image at the new number. Two concurrent saves serialise on the lock
 * rather than racing to the same version number (which `UNIQUE (script_id,
 * version)` would otherwise turn into a 23505 for the loser).
 *
 * On the create path the caller inserts the script with `version: 0` inside
 * the same transaction; this call moves it to 1 and cuts v1. Version 0 is
 * therefore never observable outside the creating transaction.
 *
 * Must run inside the caller's transaction: a failure after the `scripts`
 * update must not leave a bumped version with no row behind it.
 */
export async function cutScriptVersion(
  tx: ScriptVersionTx,
  args: { scriptId: string; provenance: ScriptVersionProvenance }
): Promise<ScriptVersionRow> {
  const [locked] = await tx
    .select({
      id: scripts.id,
      version: scripts.version,
      content: scripts.content,
      language: scripts.language,
      timeoutSeconds: scripts.timeoutSeconds,
      runAs: scripts.runAs,
      parameters: scripts.parameters,
    })
    .from(scripts)
    .where(eq(scripts.id, args.scriptId))
    .for('update')
    .limit(1);

  if (!locked) {
    throw new ScriptVersionCutError(`script ${args.scriptId} not found or not writable`);
  }

  const nextVersion = locked.version + 1;
  const p = args.provenance;

  await tx
    .update(scripts)
    .set({ version: nextVersion, updatedAt: new Date() })
    .where(eq(scripts.id, args.scriptId));

  const [row] = await tx
    .insert(scriptVersions)
    .values({
      scriptId: args.scriptId,
      version: nextVersion,
      content: locked.content,
      language: locked.language,
      timeoutSeconds: locked.timeoutSeconds,
      runAs: locked.runAs,
      parameters: locked.parameters ?? null,
      contentDigest: sha256Content(locked.content),
      origin: p.origin,
      // Explicit nulls, not undefined: an undefined would let Drizzle omit the
      // column and silently inherit a default that does not exist here.
      proposalId: p.proposalId ?? null,
      reviewId: p.reviewId ?? null,
      reviewedAt: p.reviewedAt ?? null,
      approvedBy: p.approvedBy ?? null,
      approvedAt: p.approvedAt ?? null,
      approvalMethod: p.approvalMethod ?? null,
      changelog: p.changelog ?? null,
      createdBy: p.createdBy ?? null,
    })
    .returning();

  if (!row) {
    throw new ScriptVersionCutError(`failed to insert version ${nextVersion} for script ${args.scriptId}`);
  }
  return row;
}

/** The version row matching the script's CURRENT `scripts.version`. There is
 *  deliberately no `scripts.head_version_id` column — it would close a
 *  scripts <-> script_versions FK cycle that `tenantCascade` rejects. */
export async function headScriptVersion(
  executor: ScriptVersionExecutor,
  scriptId: string
): Promise<ScriptVersionRow | null> {
  const rows = await executor
    .select({ version: scriptVersions })
    .from(scriptVersions)
    .innerJoin(scripts, eq(scripts.id, scriptVersions.scriptId))
    .where(and(eq(scriptVersions.scriptId, scriptId), eq(scriptVersions.version, scripts.version)))
    .limit(1);
  return rows[0]?.version ?? null;
}
