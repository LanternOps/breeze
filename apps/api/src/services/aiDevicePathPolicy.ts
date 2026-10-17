/**
 * Tenant AI data policy in the executeTool gate (spec 2026-10-15 §2).
 *
 * `executeTool` (aiTools.ts) calls {@link applyDevicePathPolicy} right after
 * `enforceDeviceArgs` has verified the device rows, for every principal that
 * dispatches through it (every caller of executeTool). The level comes from the DEVICE's org
 * — the data owner — never from the session org: a partner-scope login's
 * session org is just its first accessible org.
 *
 * Fail closed. The owning partner is read here from the device org's row
 * under the caller's RLS and cross-checked against the context's own partner.
 * When it cannot be established (no DB context, org row invisible, a context
 * partner that disagrees, no verified device at all) the call is judged under
 * `off` semantics with source `unresolved`. It never falls back to the
 * built-in `no_user_profiles` default, which is looser than a partner that
 * chose `off` (the W01 review finding on #8854).
 *
 * An organization-session context carries `currentPartnerId = null` by design
 * (middleware/auth.ts). That alone is not "cannot establish": the partner
 * comes from the device org row, and the ceiling row is read through the
 * pinned `readOwnPartnerAxisRows` path in aiDataPolicy.ts.
 */
import { getCurrentDbAccessContext } from '../db';
import type { AiDeviceFileReadLevel } from '../db/schema/aiDataPolicies';
import {
  levelRank,
  readOrgPartnerId,
  resolveAiDataPolicyForEstablishedPartner,
  type AiDataPolicySource,
} from './aiDataPolicy';
import { aiPathRefusal, USER_PROFILE_BLOCKED_MESSAGE } from './aiPathRestriction';
import { PATH_FIELDS } from './aiToolPathFields';

/** Tools refused outright under `off` (spec §2 "Behaviour by level"). */
export const OFF_DENIED_TOOLS: ReadonlySet<string> = new Set([
  'file_operations',
  'request_diagnostic_access',
  'diagnostic_list_directory',
  'diagnostic_read_file',
]);

/** Per-tool actions refused under `off`; the action key is `commandType` for execute_command. */
export const OFF_DENIED_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  execute_command: new Set(['file_list', 'file_read']),
};

const ACTION_KEY: Readonly<Record<string, string>> = { execute_command: 'commandType' };

export type GatePolicySource = AiDataPolicySource | 'unresolved';

/** Why the owning partner could not be established (logged; never sent to the model). */
export type UnresolvedCause = 'no_verified_device' | 'no_db_context' | 'org_unresolved' | 'partner_mismatch' | 'partner_not_granted';

/** What the gate judges a call by: the strictest level across its device orgs. */
export type GatePolicy = {
  deviceFileReadLevel: AiDeviceFileReadLevel;
  source: { deviceFileReadLevel: GatePolicySource };
  /** Set only when `source` is `unresolved`. */
  unresolvedCause?: UnresolvedCause;
};

function unresolved(cause: UnresolvedCause, orgId?: string): GatePolicy {
  console.warn('[aiDevicePathPolicy] AI data policy unresolved; judging the call under off', { cause, orgId });
  return { deviceFileReadLevel: 'off', source: { deviceFileReadLevel: 'unresolved' }, unresolvedCause: cause };
}

const OFF_MESSAGE = 'AI device file access is turned off by the AI data policy for this organization';
const UNRESOLVED_MESSAGE =
  "AI device file access is refused: the AI data policy for this device's organization could not be established";
const NO_DEVICE_MESSAGE =
  'AI device file access is refused: this tool call does not name a device, so the AI data policy of the data owner cannot be checked';
const PROFILE_POINTER =
  ' For read-only troubleshooting of a profile path, ask an administrator to approve it with request_diagnostic_access, then use diagnostic_list_directory / diagnostic_read_file.';

/** Dotted input key paths of `toolName` that the level applies to (every non-exempt PATH_FIELDS entry). */
export function safePathFieldsFor(toolName: string): string[] {
  return Object.entries(PATH_FIELDS)
    .filter(([key, c]) => key.startsWith(toolName + '.') && c.kind !== 'exempt')
    .map(([key]) => key.slice(toolName.length + 1));
}

/** Every value at a dotted key path; arrays at any level flatten (PATH_FIELDS keys flatten them too). */
function valuesAt(input: unknown, dotted: string): unknown[] {
  let current: unknown[] = [input];
  for (const seg of dotted.split('.')) {
    current = current.flatMap((v) => {
      if (Array.isArray(v)) return v.flatMap((e) => (e && typeof e === 'object' ? [(e as Record<string, unknown>)[seg]] : []));
      return v && typeof v === 'object' ? [(v as Record<string, unknown>)[seg]] : [];
    });
  }
  return current.flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v) => v !== undefined);
}

function pathValues(toolName: string, input: Record<string, unknown>): string[] {
  return safePathFieldsFor(toolName).flatMap((field) => valuesAt(input, field)).filter((v): v is string => typeof v === 'string');
}

function isOffDenied(toolName: string, input: Record<string, unknown>): boolean {
  if (OFF_DENIED_TOOLS.has(toolName)) return true;
  const action = input[ACTION_KEY[toolName] ?? 'action'];
  return typeof action === 'string' && OFF_DENIED_ACTIONS[toolName]?.has(action) === true;
}

/** Whether any level could change this call's outcome; when not, the gate takes no policy read. */
export function isPolicyRelevant(toolName: string, input: Record<string, unknown>): boolean {
  return isOffDenied(toolName, input) || pathValues(toolName, input).length > 0;
}

export type DevicePathPolicyResult =
  | { ok: true }
  | { ok: false; error: string; condition: 'policy_denied'; policy: { level: AiDeviceFileReadLevel; source: GatePolicySource } };

/** Pure verdict for one call under an already-resolved policy. */
export function enforceDevicePathPolicy(toolName: string, input: Record<string, unknown>, policy: GatePolicy): DevicePathPolicyResult {
  const level = policy.deviceFileReadLevel;
  const source = policy.source.deviceFileReadLevel;
  const deny = (error: string): DevicePathPolicyResult => ({ ok: false, error, condition: 'policy_denied', policy: { level, source } });
  const unresolvedMessage = policy.unresolvedCause === 'no_verified_device' ? NO_DEVICE_MESSAGE : UNRESOLVED_MESSAGE;
  if (level === 'off' && isOffDenied(toolName, input)) {
    return deny(source === 'unresolved' ? unresolvedMessage : OFF_MESSAGE);
  }
  if (level === 'any_with_approval') return { ok: true };
  for (const value of pathValues(toolName, input)) {
    if (aiPathRefusal(value, { level }) !== USER_PROFILE_BLOCKED_MESSAGE) continue;
    if (source === 'unresolved') return deny(`${unresolvedMessage}, so user profile folders are refused.`);
    // Under off the diagnostic tools are refused too, so the pointer would mislead.
    return deny(`${USER_PROFILE_BLOCKED_MESSAGE} (level: ${level}, set by: ${source}).${level === 'no_user_profiles' ? PROFILE_POINTER : ''}`);
  }
  return { ok: true };
}

/**
 * The device org's owning partner, or why it cannot be established: no
 * ambient DB context, the org row is invisible to the caller, or the
 * context's own partner (or partner grant) names a different partner.
 */
async function establishDevicePartner(orgId: string): Promise<{ partnerId: string } | { cause: UnresolvedCause }> {
  const ctx = getCurrentDbAccessContext();
  if (!ctx) return { cause: 'no_db_context' };
  const partnerId = await readOrgPartnerId(orgId);
  if (!partnerId) return { cause: 'org_unresolved' };
  if (ctx.scope === 'system') return { partnerId };
  if (ctx.currentPartnerId != null && ctx.currentPartnerId !== partnerId) return { cause: 'partner_mismatch' };
  if (ctx.scope === 'partner' && !(ctx.accessiblePartnerIds ?? []).includes(partnerId)) return { cause: 'partner_not_granted' };
  return { partnerId };
}

/**
 * Strictest policy across the verified devices' orgs. Any org whose partner
 * cannot be established — or an empty device list, where there is no data
 * owner to resolve from — makes the whole call unresolved (`off`, logged).
 */
export async function resolveDevicePolicyForGate(devices: ReadonlyArray<{ orgId: string }>): Promise<GatePolicy> {
  if (devices.length === 0) return unresolved('no_verified_device');
  let strictest: GatePolicy | null = null;
  for (const orgId of new Set(devices.map((d) => d.orgId))) {
    const established = await establishDevicePartner(orgId);
    if ('cause' in established) return unresolved(established.cause, orgId);
    const policy = await resolveAiDataPolicyForEstablishedPartner(orgId, established.partnerId);
    if (!strictest || levelRank(policy.deviceFileReadLevel) < levelRank(strictest.deviceFileReadLevel)) {
      strictest = { deviceFileReadLevel: policy.deviceFileReadLevel, source: { deviceFileReadLevel: policy.source.deviceFileReadLevel } };
    }
  }
  return strictest ?? unresolved('no_verified_device');
}

/**
 * The gate step `executeTool` runs after `enforceDeviceArgs`. No DB read for
 * a call no level could affect; otherwise resolve from the verified devices
 * and judge. Must run inside the dispatch DB context.
 */
export async function applyDevicePathPolicy(
  toolName: string,
  input: Record<string, unknown>,
  verifiedDevices: ReadonlyArray<{ orgId: string }>,
): Promise<DevicePathPolicyResult> {
  if (!isPolicyRelevant(toolName, input)) return { ok: true };
  return enforceDevicePathPolicy(toolName, input, await resolveDevicePolicyForGate(verifiedDevices));
}
