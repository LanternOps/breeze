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
 * Two properties are load-bearing:
 *
 *  - **Org-pinned.** The id comes from tool ARGUMENTS, which for a human
 *    principal are not otherwise verified against the intent's org at
 *    creation time. Pinning the read to `orgId` means a foreign (or
 *    nonexistent) id resolves to nothing and the stub simply survives — the
 *    headline can never become a cross-tenant hostname oracle.
 *  - **Never fatal.** A headline is presentation. An approval that would
 *    otherwise be created must not fail because a display-name lookup blipped,
 *    so a failure degrades to the stub — reported to Sentry, never swallowed.
 */

import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { devices } from '../../db/schema/devices';
import { captureException } from '../sentry';

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
 * Deliberately only `deviceId` (singular): that is the argument every
 * `on device <id>...` stub in `buildApprovalDescription` is built from.
 * Multi-device tools (`run_script`'s `deviceIds`, `manage_patches`) render
 * `on N device(s)` and have no single name to substitute.
 */
export function argumentDeviceId(input: Record<string, unknown>): string | null {
  const raw = input.deviceId;
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
 * System scope is safe here only because of the `orgId` pin below.
 */
export async function resolveApprovalDeviceName(deviceId: string, orgId: string): Promise<string | null> {
  try {
    return await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        const [device] = await db
          .select({ hostname: devices.hostname, displayName: devices.displayName })
          .from(devices)
          .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
          .limit(1);
        return device ? (device.displayName ?? device.hostname) : null;
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
