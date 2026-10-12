import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  RESTORE_POINT_PAYLOAD_KEY,
  RESTORE_POINT_REQUEST_VERSION,
  type RestorePointRequestBlock,
  type RestorePointTrigger,
} from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { deviceCommands, devices } from '../db/schema';
import { deviceRestorePointAttempts } from '../db/schema/deviceRestorePointAttempts';
import type { DeliveryRefreshContext } from './commandDeliveryRefusal';
import { resolveSystemProtectionForDevice } from './featureConfigResolver';
import { captureException } from './sentry';

/**
 * Windows System Restore checkpoint requests (#4609, W05 #4756).
 *
 * THE SINGLE CHOKEPOINT. Every command-creation site for `install_patches`,
 * `script` and `software_install` calls {@link buildRestorePointRequest} and
 * nothing else. A second resolution site is how a feature silently stops
 * applying to one of its surfaces.
 *
 * The decision is made when the concrete per-device command is created, never
 * at schedule-authoring time and never via heartbeat config.
 *
 * Mixed-fleet contract (agent/internal/systemrestore/request.go): a MISSING
 * block means the agent's legacy default -- install_patches attempts a
 * best-effort checkpoint, script / software_install do not. The platform
 * defaults equal those legacy defaults, so:
 *   - no policy anywhere (or an unreadable one)  -> no block, no ledger row;
 *     the payload stays byte-identical to what it was before this feature.
 *   - explicit policy, toggle on                 -> enabled:true block + a
 *     `requested` ledger row.
 *   - explicit policy, toggle off, patch         -> enabled:false block (the
 *     only way to say "off" to a new agent; old agents ignore it), no row.
 *   - explicit policy, toggle off, script/sw     -> no block (agent default is
 *     already off), no row.
 *
 * The ledger records requests and observations, never a promise that a
 * checkpoint exists or can be restored.
 */

export interface BuildRestorePointRequestInput {
  deviceId: string;
  orgId: string;
  osType: string | null | undefined;
  trigger: RestorePointTrigger;
  /** The action, without the policy's label prefix (e.g. "install 3 updates"). */
  label: string;
  deviceCommandId?: string | null;
  scriptExecutionId?: string | null;
  softwareDeploymentId?: string | null;
  patchJobId?: string | null;
  /** Use this exact label instead of `${labelPrefix}: ${label}` (re-stamp at delivery). */
  labelOverride?: string;
  validForMs?: number;
}

/**
 * 24 hours: long enough for a device that is briefly offline, short enough that
 * a policy change is not ignored for a whole queue TTL (7 days for standard
 * commands) -- an older snapshot is re-resolved at delivery.
 */
export const RESTORE_POINT_DEFAULT_VALID_FOR_MS = 24 * 60 * 60 * 1000;

const LABEL_MAX_LENGTH = 180;

export const RESTORE_POINT_SUPERSEDED_MESSAGE =
  'superseded before delivery: the policy snapshot expired';

/**
 * Returns the block to stamp under `payload.restorePoint`, or null when the
 * payload must not carry one. Writes the `requested` ledger row when (and only
 * when) the block asks for a checkpoint.
 *
 * Resolution and the ledger insert run in a FRESH system context, escaping any
 * caller context: the resolver reports "no policy" for a device it cannot see,
 * and a contextless worker or a narrowly-scoped caller would otherwise turn
 * that into a silent unprotected dispatch. The resolver's own predicates are
 * hierarchy-scoped to this device, so system scope widens visibility only to
 * the rows that legitimately apply to it.
 *
 * Deliberately NOT wrapped in try/catch: a resolver or insert error fails
 * command creation visibly instead of silently downgrading protection.
 */
export async function buildRestorePointRequest(
  input: BuildRestorePointRequestInput,
): Promise<RestorePointRequestBlock | null> {
  // Windows-only, decided server-side. The agent's own !windows no-op is
  // defence in depth, not the gate.
  if (!isWindowsOsType(input.osType)) return null;

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const resolved = await resolveSystemProtectionForDevice(input.deviceId);

      // No policy anywhere, or a winning policy whose stored settings failed
      // the schema (the resolver already warned): behave exactly as before
      // this feature. The agent's legacy defaults equal the platform defaults.
      if (resolved.isPlatformDefault || resolved.invalidStoredSettings) return null;

      const toggle = toggleForTrigger(input.trigger, resolved.settings);
      // Only install_patches needs an explicit "off": a missing block there
      // means legacy-enabled to the agent.
      if (!toggle && input.trigger !== 'patch') return null;

      const now = new Date();
      const block: RestorePointRequestBlock = {
        v: RESTORE_POINT_REQUEST_VERSION,
        requestId: randomUUID(),
        enabled: toggle,
        label: (input.labelOverride ?? `${resolved.settings.labelPrefix}: ${input.label}`).slice(0, LABEL_MAX_LENGTH),
        resolvedAt: now.toISOString(),
        policyRevision: resolved.policyRevision ?? '',
        validUntil: new Date(now.getTime() + (input.validForMs ?? RESTORE_POINT_DEFAULT_VALID_FOR_MS)).toISOString(),
      };

      // Nothing was requested for an enabled:false block, so no row. Reporting
      // of `skipped_disabled` belongs to result ingest (W06/W07).
      if (!block.enabled) return block;

      await db.insert(deviceRestorePointAttempts).values({
        requestId: block.requestId,
        orgId: input.orgId,
        deviceId: input.deviceId,
        deviceCommandId: input.deviceCommandId ?? null,
        trigger: input.trigger,
        status: 'requested',
        policyRevision: resolved.policyRevision,
        requestedAt: now,
        scriptExecutionId: input.scriptExecutionId ?? null,
        softwareDeploymentId: input.softwareDeploymentId ?? null,
        patchJobId: input.patchJobId ?? null,
      });

      return block;
    }),
  );
}

/** Spread into a payload literal: `...restorePointPayloadField(block)`. */
export function restorePointPayloadField(
  block: RestorePointRequestBlock | null,
): { restorePoint?: RestorePointRequestBlock } {
  return block ? { [RESTORE_POINT_PAYLOAD_KEY]: block } : {};
}

/**
 * Record the command id on the ledger row once the command exists (sites that
 * cannot reserve the id before building the payload).
 *
 * Best-effort: the command has already been created, so failing here would
 * report a dispatched action as failed. The row stays joinable by `requestId`,
 * which is its identity; `device_command_id` is an optional convenience.
 */
export async function linkRestorePointCommand(
  block: RestorePointRequestBlock | null,
  deviceCommandId: string,
): Promise<void> {
  if (!block?.enabled) return;
  try {
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        await db
          .update(deviceRestorePointAttempts)
          .set({ deviceCommandId })
          .where(eq(deviceRestorePointAttempts.requestId, block.requestId));
      }),
    );
  } catch (err) {
    console.error('[restorePointRequest] failed to link the command id onto the requested ledger row', {
      requestId: block.requestId,
      deviceCommandId,
      error: err instanceof Error ? err.message : String(err),
    });
    captureException(err);
  }
}

/**
 * Remove the `requested` row for a block whose command was never created
 * (dispatch refused / insert failed). Nothing was asked of the agent, so an
 * absent row is the truthful record. Best-effort: never masks the caller's
 * original failure.
 */
export async function discardRestorePointRequest(
  block: RestorePointRequestBlock | null,
): Promise<void> {
  if (!block?.enabled) return;
  try {
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        await db
          .delete(deviceRestorePointAttempts)
          .where(and(
            eq(deviceRestorePointAttempts.requestId, block.requestId),
            eq(deviceRestorePointAttempts.status, 'requested'),
          ));
      }),
    );
  } catch (err) {
    console.error('[restorePointRequest] failed to discard requested ledger row for an uncreated command', {
      requestId: block.requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function isWindowsOsType(osType: string | null | undefined): boolean {
  return (osType ?? '').toLowerCase().includes('windows');
}

function toggleForTrigger(
  trigger: RestorePointTrigger,
  settings: { beforePatching: boolean; beforeScripts: boolean; beforeSoftwareInstall: boolean },
): boolean {
  switch (trigger) {
    case 'patch':
      return settings.beforePatching;
    case 'script':
      return settings.beforeScripts;
    case 'software_install':
      return settings.beforeSoftwareInstall;
  }
}

// ============================================
// Stale snapshots at delivery (#4609 W05 Task 5.4)
// ============================================

const COMMAND_TYPE_TRIGGERS: Readonly<Record<string, RestorePointTrigger>> = {
  install_patches: 'patch',
  script: 'script',
  software_install: 'software_install',
};

/** Stale when `validUntil` has passed, or cannot be read at all. */
export function isRestorePointBlockStale(block: { validUntil?: unknown }, now: Date): boolean {
  if (typeof block.validUntil !== 'string') return true;
  const until = Date.parse(block.validUntil);
  if (Number.isNaN(until)) return true;
  return until <= now.getTime();
}

/** The stamped block, when it is one the agent would read (an object with v:1). */
function readRestorePointBlock(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const raw = (payload as Record<string, unknown>)[RESTORE_POINT_PAYLOAD_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if ((raw as Record<string, unknown>).v !== RESTORE_POINT_REQUEST_VERSION) return null;
  return raw as Record<string, unknown>;
}

/**
 * Cheap, DB-free test for the delivery path: only a payload carrying an
 * expired block needs the re-stamp step. Every command without the key, and
 * every fresh block (including transport redelivery of the same command id),
 * is delivered exactly as before.
 */
export function isStaleRestorePointPayload(payload: unknown, now: Date): boolean {
  const block = readRestorePointBlock(payload);
  return block !== null && isRestorePointBlockStale(block, now);
}

/** Terminalise a still-`requested` row whose snapshot expired before delivery. */
export async function supersedeStaleRestorePoint(requestId: string): Promise<void> {
  await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      await db
        .update(deviceRestorePointAttempts)
        .set({ status: 'failed', message: RESTORE_POINT_SUPERSEDED_MESSAGE })
        .where(and(
          eq(deviceRestorePointAttempts.requestId, requestId),
          eq(deviceRestorePointAttempts.status, 'requested'),
        ))
        .returning({ id: deviceRestorePointAttempts.id });
    }),
  );
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Delivery-time step for a claimed command whose `restorePoint` snapshot has
 * expired (a queued command can wait up to the 7-day standard TTL; the
 * snapshot is valid for 24 h). Supersedes the old `requested` row, re-resolves
 * the policy NOW through the chokepoint (fresh requestId, bound to this same
 * command), and persists ONLY the `restorePoint` key onto the command row --
 * so a later redelivery of the same command reuses the new snapshot instead of
 * re-resolving again, and nothing a per-type refresher minted into the
 * outgoing payload (a presigned URL, a storage session) is ever written back.
 *
 * Throws on any failure, which the delivery path treats as "release the row
 * and try again at the next check-in" -- a stale snapshot is never delivered.
 */
export async function refreshRestorePointForDelivery(
  payload: Record<string, unknown>,
  ctx: Pick<DeliveryRefreshContext, 'commandId' | 'deviceId' | 'type' | 'claimedAt'>,
): Promise<Record<string, unknown>> {
  const stale = readRestorePointBlock(payload);
  if (!stale || !isRestorePointBlockStale(stale, new Date())) return payload;
  const trigger = COMMAND_TYPE_TRIGGERS[ctx.type];
  if (!trigger) return payload;

  const oldRequestId = stringOrNull(stale.requestId);
  if (oldRequestId) await supersedeStaleRestorePoint(oldRequestId);

  const [device] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ orgId: devices.orgId, osType: devices.osType })
        .from(devices)
        .where(eq(devices.id, ctx.deviceId))
        .limit(1),
    ),
  );
  if (!device) throw new Error(`restore-point refresh: device ${ctx.deviceId} not found`);

  const fresh = await buildRestorePointRequest({
    deviceId: ctx.deviceId,
    orgId: device.orgId,
    osType: device.osType,
    trigger,
    label: '',
    // The action text is not recoverable from every payload (a script's name
    // is not on it), so the original label is kept verbatim.
    labelOverride: typeof stale.label === 'string' ? stale.label : undefined,
    deviceCommandId: ctx.commandId,
    scriptExecutionId: stringOrNull(payload.executionId),
    softwareDeploymentId: stringOrNull(payload.deploymentId),
    patchJobId: stringOrNull(payload.patchJobId),
  });

  try {
    await persistRestorePointKey(ctx.commandId, ctx.claimedAt, fresh);
  } catch (err) {
    await discardRestorePointRequest(fresh);
    throw err;
  }

  console.warn('[restorePointRequest] restore-point snapshot expired before delivery; re-resolved', {
    commandId: ctx.commandId,
    supersededRequestId: oldRequestId,
    requestId: fresh?.requestId ?? null,
  });

  const { [RESTORE_POINT_PAYLOAD_KEY]: _expired, ...rest } = payload;
  return fresh ? { ...rest, [RESTORE_POINT_PAYLOAD_KEY]: fresh } : rest;
}

/**
 * Single-key write onto the CLAIMED row. Joins the caller's transaction when
 * there is one (the claim's row lock is held there; a separate connection
 * would wait on it), and is keyed on the claim so it can never touch a row
 * another delivery has since re-claimed or terminalised.
 */
async function persistRestorePointKey(
  commandId: string,
  claimedAt: Date | null,
  block: RestorePointRequestBlock | null,
): Promise<void> {
  const nextPayload = block
    ? sql`jsonb_set(coalesce(${deviceCommands.payload}, '{}'::jsonb), '{restorePoint}', ${JSON.stringify(block)}::jsonb)`
    : sql`${deviceCommands.payload} - 'restorePoint'`;
  const updated = await withSystemDbAccessContext(() =>
    db
      .update(deviceCommands)
      .set({ payload: nextPayload })
      .where(and(
        eq(deviceCommands.id, commandId),
        eq(deviceCommands.status, 'sent'),
        ...(claimedAt ? [eq(deviceCommands.executedAt, claimedAt)] : []),
      ))
      .returning({ id: deviceCommands.id }),
  );
  if (updated.length === 0) {
    throw new Error(`restore-point refresh: command ${commandId} is no longer held by this claim`);
  }
}
