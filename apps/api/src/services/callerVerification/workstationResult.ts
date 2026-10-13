/**
 * Workstation result handling for caller verification (#6354 W02).
 *
 * ONE leaf handler, `handleCallerVerifyResult`, used by both agent
 * transports (registered in `commandResultHandlers`, so HTTP and WS reach the
 * same code), by the late-rejection paths and by reconciliation. It never
 * implements a decision itself: everything goes through W01 `applyDecision`,
 * whose expiry-aware status CAS makes a duplicate or replayed result a no-op.
 *
 * Ownership comes from the PERSISTED command (the verification row that
 * references this command id, on the transport-authenticated device whose
 * org matches the verification), never from the verification id in the
 * payload or result. The device row is share-locked so a concurrent org move
 * (which locks it FOR UPDATE before revoking workstation grants) serializes
 * with result processing.
 *
 * Runs in whatever DB context the caller holds (the HTTP request's org
 * transaction, the WS finalize org context, or a reconciliation system
 * context); `withSystemDbAccessContext` only opens a system context when
 * there is none.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { deviceCommands, devices } from '../../db/schema';
import { callerVerifications as v } from '../../db/schema/callerVerification';
import type { CommandResultHandler } from '../commandResultHandlers';
import { applyDecision, type Decision } from './service';
import { observeLogin } from './subjects';
import { CALLER_VERIFY_COMMAND, readWorkstationResult, type WorkstationResult } from './workstationProtocol';

type HandlerParams = Parameters<CommandResultHandler>[0];
type Principal = { osPrincipal: string; osUsername: string; upn: string | null };

// Mirrors systemCleanup.UNKNOWN_COMMAND_TYPE_PREFIX without importing that
// module's command-queue graph into this leaf.
const UNKNOWN_COMMAND_TYPE_PREFIX = 'unknown command type:';

/** Durable late-rejection marker merged into `device_commands.result`. */
export const NOT_ME_RECEIPT_KEY = 'callerVerificationNotMe';

export function decisionForResult(value: WorkstationResult | null, agentError?: string | null): Decision {
  if (!value) {
    // An agent that predates caller_verify answers "unknown command type".
    return {
      kind: 'undeliverable',
      reason: typeof agentError === 'string' && agentError.trimStart().startsWith(UNKNOWN_COMMAND_TYPE_PREFIX)
        ? 'helper_outdated'
        : 'invalid_result',
    };
  }
  if (value.choice === 'not_me') return { kind: 'not_me' };
  if (!value.delivered) return { kind: 'undeliverable', reason: value.error ?? 'helper_outdated' };
  if (!value.choice || value.choice === 'timeout') return { kind: 'timeout' };
  // A number is only meaningful with the agent-verified principal behind it.
  if (!value.principal) return { kind: 'undeliverable', reason: 'invalid_result' };
  return { kind: 'choice', value: value.choice };
}

export function principalForResult(value: WorkstationResult | null, hostname: string | null): Principal | undefined {
  const p = value?.principal;
  if (!p) return undefined;
  const osPrincipal = p.sid ?? (p.uid !== undefined && hostname ? `uid:${p.uid}@${hostname}` : undefined);
  return osPrincipal ? { osPrincipal, osUsername: p.username, upn: p.upn ?? null } : undefined;
}

export function isCallerNotMe(stdout: string | undefined, result: unknown): boolean {
  return readWorkstationResult(stdout, result)?.choice === 'not_me';
}

export async function handleCallerVerifyResult({ commandId, resolvedDeviceId, result, stdout }: HandlerParams): Promise<void> {
  await withSystemDbAccessContext(async () => {
    const [owned] = await db.select({
      id: v.id, orgId: v.orgId, contactId: v.contactId, status: v.status, matchValue: v.matchValue, deviceHostname: v.deviceHostname,
    }).from(v)
      .innerJoin(deviceCommands, and(
        eq(deviceCommands.id, v.agentCommandId),
        eq(deviceCommands.deviceId, resolvedDeviceId),
        eq(deviceCommands.type, CALLER_VERIFY_COMMAND),
        eq(deviceCommands.targetRole, 'agent'),
      ))
      .innerJoin(devices, and(eq(devices.id, resolvedDeviceId), eq(devices.orgId, v.orgId)))
      .where(and(eq(v.agentCommandId, commandId), eq(v.method, 'workstation')))
      .limit(1)
      .for('share', { of: devices });
    if (!owned) {
      // Not this device's workstation verification (moved org, foreign
      // device, unlinked command). Nothing is applied; say so.
      console.warn('[callerVerification] workstation result not tied to a verification on this device; ignored', { commandId, deviceId: resolvedDeviceId });
      return;
    }

    const value = readWorkstationResult(stdout, result.result);
    const decision = decisionForResult(value, result.error);
    const principal = principalForResult(value, owned.deviceHostname);
    const view = await applyDecision({ verificationId: owned.id, decision, principal });
    // Only a just-verified matching number is evidence about who sat at the
    // console; observeLogin binds it to an EXISTING directory binding or not
    // at all, in this same transaction.
    if (view.status === 'verified' && decision.kind === 'choice' && decision.value === owned.matchValue && principal?.upn) {
      await observeLogin({ orgId: owned.orgId, contactId: owned.contactId, ...principal });
    }
  }, 'callerVerification.commandResult');
}

/**
 * Record a late "This is not me" on the owned command row WITHOUT reopening
 * it: the original stored result is kept and a marker key is merged in, so
 * reconciliation can re-apply the rejection if the decision step fails.
 * Returns false (and writes nothing) for anything but a readable rejection
 * on this device's caller_verify row.
 */
export async function persistCallerNotMeReceipt(input: { commandId: string; deviceId: string; stdout?: string; result?: unknown }): Promise<boolean> {
  if (!isCallerNotMe(input.stdout, input.result)) return false;
  const rows = await db.update(deviceCommands).set({
    result: sql`coalesce(${deviceCommands.result}, '{}'::jsonb) || jsonb_build_object(${NOT_ME_RECEIPT_KEY}::text, true)`,
  }).where(and(
    eq(deviceCommands.id, input.commandId),
    eq(deviceCommands.deviceId, input.deviceId),
    eq(deviceCommands.targetRole, 'agent'),
    eq(deviceCommands.type, CALLER_VERIFY_COMMAND),
  )).returning({ id: deviceCommands.id });
  return rows.length === 1;
}
