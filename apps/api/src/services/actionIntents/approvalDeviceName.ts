/**
 * #5363 — the target device's HUMAN name for an approval headline.
 *
 * The guardrail description an approval carries names its device by an id
 * stub (`on device 6eae0f70...` — `buildApprovalDescription` in
 * aiGuardrails.ts). #5106 taught `buildActionLabel` to rewrite that stub into
 * `on <name>`, but only ever fed it a name inside `createActionIntent`'s
 * `ai_agent` branch, where a SCOPED sweep device is already loaded for free.
 * Every human-originated intent (chat, `mcp_api`) — and any agent intent
 * without an explicit scope — reached the approver with the raw stub, which
 * is what the mobile takeover renders as its 28pt headline.
 *
 * This module is the one place that turns "the device id these arguments
 * name" into "the device name an approver recognises", so the chat bridge,
 * the intent service, and anything else that renders an approval headline
 * cannot drift on what that means.
 *
 * Three properties are load-bearing:
 *
 *  - **Org-pinned.** The id comes from tool ARGUMENTS, which for a human
 *    principal are not otherwise verified against the intent's org at
 *    creation time. Pinning the read to `orgId` means a foreign (or
 *    nonexistent) id resolves to nothing and the stub simply survives — the
 *    headline can never become a cross-tenant hostname oracle.
 *  - **Follows the filing caller's reach (#11674).** The stored label is
 *    readable by the principal that filed the intent, so the name is given
 *    only for a device inside that principal's reach: its org condition, and
 *    its site allowlist and exact-device ceiling (`deviceInSiteScope`, the
 *    standard ticket/device site gate). Outside it, the stub stays. A
 *    principal with no org condition gets the stub, with no read.
 *  - **Never fatal.** A headline is presentation. An approval that would
 *    otherwise be created must not fail because a display-name lookup blipped,
 *    so a failure degrades to the stub — reported to Sentry, never swallowed.
 */

import { and, eq, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { devices } from '../../db/schema/devices';
import type { AuthContext } from '../../middleware/auth';
import { captureException } from '../sentry';

/** The slice of the filing caller's auth an approval-label read is cut to. */
export type ApprovalCallerReach = Pick<AuthContext, 'orgCondition' | 'allowedSiteIds' | 'allowedDeviceIds'>;

/** Does the caller's reach carry the org condition every real AuthContext has? Without it, nothing is read. */
export function hasCallerOrgReach(reach: ApprovalCallerReach | null | undefined): reach is ApprovalCallerReach {
  return typeof reach?.orgCondition === 'function';
}

/**
 * Is `deviceId` inside the caller's site allowlist and exact-device ceiling?
 * `deviceInSiteScope` (routes/tickets/siteScope.ts), the standard gate. It is
 * loaded only when the caller is restricted on either axis: an unrestricted
 * caller passes it without a read, and siteScope.ts imports the full schema
 * index, which the intent service must not pull in just to build a label.
 */
export async function deviceInCallerReach(reach: ApprovalCallerReach, deviceId: string): Promise<boolean> {
  if (reach.allowedSiteIds === undefined && reach.allowedDeviceIds === undefined) return true;
  const { deviceInSiteScope } = await import('../../routes/tickets/siteScope');
  return deviceInSiteScope(reach, deviceId);
}

/**
 * Shape-only UUID guard. `devices.id` is a Postgres `uuid`, so a malformed
 * argument would raise 22P02 and abort the statement — turning a cosmetic
 * lookup into a failed approval. Version/variant are deliberately NOT
 * constrained (unlike `CANONICAL_UUID_LOWER` in intentService, which gates
 * what gets WRITTEN): this only decides whether an id is safe to compare.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The device id THIS call's arguments name, when they name one at all.
 *
 * `deviceId` (singular) is the argument nearly every `on device <id>...` stub
 * in `buildApprovalDescription` is built from. A `deviceIds` list with exactly
 * one entry also names one device: `run_script` renders it as that stub
 * (#11979). A longer list renders `on N device(s)` and has no single name.
 * Callers only substitute where the headline carries THIS id's stub, so a tool
 * whose headline counts its devices is unaffected.
 */
export function argumentDeviceId(input: Record<string, unknown>): string | null {
  const raw = input.deviceId !== undefined
    ? input.deviceId
    : Array.isArray(input.deviceIds) && input.deviceIds.length === 1 ? input.deviceIds[0] : undefined;
  return typeof raw === 'string' && UUID_SHAPE.test(raw) ? raw : null;
}

/**
 * Resolve `deviceId` to the name an approver recognises — display name first,
 * hostname second, matching the projection #5106 added for scoped agent
 * intents — or `null` when it cannot be resolved.
 *
 * Opens its OWN system-scoped context: `createActionIntent`'s callers reach it
 * from a contextless stack (the one route with a request context wraps the
 * call in `runOutsideDbContext` for exactly this reason — see
 * routes/aiAgents.ts's supervised-key promotion), so an ambient-context read
 * would silently return zero rows under `breeze.scope = 'none'` and quietly
 * leave the stub in place. `runOutsideDbContext` keeps that true for a caller
 * that DOES hold one, where a bare system wrapper is a no-op passthrough.
 * System scope is safe here only because of the `orgId` pin and the caller's
 * reach below.
 */
export async function resolveApprovalDeviceName(
  deviceId: string,
  orgId: string,
  reach: ApprovalCallerReach,
): Promise<string | null> {
  if (!hasCallerOrgReach(reach)) return null;
  try {
    return await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        const conditions: SQL[] = [eq(devices.id, deviceId), eq(devices.orgId, orgId)];
        const reachCondition = reach.orgCondition(devices.orgId);
        if (reachCondition) conditions.push(reachCondition);
        const [device] = await db
          .select({ hostname: devices.hostname, displayName: devices.displayName })
          .from(devices)
          .where(and(...conditions))
          .limit(1);
        if (!device) return null;
        if (!(await deviceInCallerReach(reach, deviceId))) return null;
        return device.displayName ?? device.hostname;
      }, 'actionIntents.approvalDeviceName'),
    );
  } catch (err) {
    // Reported, not swallowed: the only symptom of this failing is an
    // approval headline that quietly goes back to naming a truncated UUID,
    // which is invisible to everything except the approver holding the phone.
    captureException(err instanceof Error ? err : new Error(String(err)));
    console.error(`[actionIntents] Failed to resolve the approval device name for ${deviceId}:`, err);
    return null;
  }
}
