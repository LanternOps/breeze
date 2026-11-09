/**
 * #10428 W06 (spec §5.3, hybrid): the one standing-instruction check every
 * Wisp path that can change a device runs — the chat pre-tool (and the Tier-2
 * after-wait re-check), worker proposals (assessment, troubleshooting) and
 * release of a pending intent.
 *
 * The call's verbs come from the code-owned verb map (aiToolStandingVerbs.ts);
 * its devices from the tool's registry `deviceArgs` (the ids the dispatch gate
 * will check). The memory broker finds every live instruction on those
 * devices that the call would break, and the hybrid rule decides:
 *   - a CONFIRMED, enforceable deny on an EXACT verb → refuse;
 *   - any other match → warn (the caller forces a human card or notes it);
 *   - no match → none.
 * Narrowing only: nothing here can admit a call.
 *
 * `run_script { groupId }` names its devices through a group, so the group is
 * expanded to its members with the caller's reach, by the same resolver
 * intent creation pins the run's devices with; a group that reach cannot
 * resolve refuses. Configuration calls that select by group or site
 * (maintenance windows, browser policy, group edits) only match `any_change`
 * and are matched on the devices they name; their group/site selectors are not
 * expanded.
 */
import type { StandingVerb } from '@breeze/shared';
import type { AuthContext } from '../../middleware/auth';
import { resolveWritableToolOrgId } from '../aiToolWriteOrg';
import { standingVerbsFor } from '../aiToolStandingVerbs';
import { captureException } from '../sentry';
import type { GrantCeiling } from './grantAuthority';
import {
  findStandingInstructionMatches,
  standingInstructionDecision,
  standingInstructionRefusalMessage,
  type StandingInstructionMatch,
} from './memoryBroker';

/** A failed check on a Wisp device-changing call refuses it (fails closed; plan Open Decision 3). */
export const STANDING_CHECK_UNAVAILABLE_MESSAGE = "Couldn't check remembered instructions; try again.";

/** Upper bound on the conflict text one warning carries onto a card. */
export const STANDING_CONFLICT_TEXT_MAX = 300;

export type StandingInstructionCheck =
  | { action: 'refuse'; error: string; match: StandingInstructionMatch }
  | { action: 'warn'; text: string; matches: StandingInstructionMatch[] }
  | { action: 'none' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The device ids a call names in its declared `deviceArgs` (string or array
 * form). A value that is not a device id is skipped: the dispatch gate refuses
 * the whole call on it, so it can never run against a device.
 */
export function suppliedStandingDeviceIds(deviceArgs: readonly string[], input: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  for (const arg of deviceArgs) {
    const raw = input[arg];
    if (raw == null) continue;
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      if (typeof value === 'string' && UUID.test(value)) ids.add(value.toLowerCase());
    }
  }
  return [...ids];
}

/**
 * The registry's `deviceArgs` for a tool. Imported on demand: the registry hub
 * is heavy, and loading it here (rather than reading the leaf map) guarantees
 * it is populated in every process that enforces, so a missing entry can never
 * silently mean "no devices".
 */
async function deviceArgsFor(toolName: string): Promise<readonly string[]> {
  const { aiTools } = await import('../aiTools');
  const tool = aiTools.get(toolName);
  // Only reached for a tool the verb map enforces; the contract test keeps
  // every such tool in the registry with deviceArgs, so a miss is a fault.
  if (!tool) throw new Error(`standing-instruction check: '${toolName}' is in the verb map but not in the tool registry`);
  return tool.deviceArgs ?? [];
}

/** A group target the caller's reach cannot resolve: the call is refused with the resolver's message. */
export class StandingGroupTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StandingGroupTargetError';
  }
}

/**
 * The members of a `run_script { groupId }` target, resolved as
 * `createActionIntent` resolves them (actionIntents/runScriptGroupTarget.ts),
 * under the caller's reach and write org. Without a reach it throws: a group
 * target is never read as "no devices".
 */
async function runScriptGroupDeviceIds(auth: AuthContext | undefined, input: Record<string, unknown>): Promise<string[]> {
  if (!auth) throw new Error('a run_script group target needs the caller reach to be checked against standing instructions');
  const org = resolveWritableToolOrgId(auth, typeof input.orgId === 'string' ? input.orgId : undefined);
  if (!org.orgId) throw new StandingGroupTargetError(org.error ?? 'Organization context required');
  const { normalizeRunScriptGroupTarget, RunScriptGroupTargetError } = await import('../actionIntents/runScriptGroupTarget');
  try {
    const normalized = await normalizeRunScriptGroupTarget(auth, input, org.orgId);
    const ids = normalized.args.deviceIds;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch (err) {
    if (err instanceof RunScriptGroupTargetError) throw new StandingGroupTargetError(err.message);
    throw err;
  }
}

function conflictText(matches: StandingInstructionMatch[]): string {
  const text = [...new Set(matches.map((m) => m.text))].join('; ');
  return text.length > STANDING_CONFLICT_TEXT_MAX ? `${text.slice(0, STANDING_CONFLICT_TEXT_MAX - 1)}…` : text;
}

/**
 * The decision for one call. Throws when the lookup cannot run (a
 * `StandingGroupTargetError` when a group target cannot be resolved); callers
 * decide how to fail closed. `auth` is the reach the call would run under; it
 * is needed only to expand a group target.
 */
export async function evaluateStandingInstructions(args: {
  ceiling: GrantCeiling;
  toolName: string;
  input: Record<string, unknown>;
  auth?: AuthContext;
  now?: Date;
}): Promise<StandingInstructionCheck> {
  const verbs: { exact: StandingVerb[]; possible: StandingVerb[] } = standingVerbsFor(args.toolName, args.input);
  if (verbs.exact.length === 0 && verbs.possible.length === 0) return { action: 'none' };
  let deviceIds = suppliedStandingDeviceIds(await deviceArgsFor(args.toolName), args.input);
  if (deviceIds.length === 0 && args.toolName === 'run_script' && args.input.groupId != null) {
    deviceIds = suppliedStandingDeviceIds(['deviceIds'], { deviceIds: await runScriptGroupDeviceIds(args.auth, args.input) });
  }
  if (deviceIds.length === 0) return { action: 'none' };

  const matches = await findStandingInstructionMatches({
    ceiling: args.ceiling,
    deviceIds,
    exact: verbs.exact,
    possible: verbs.possible,
    ...(args.now ? { now: args.now } : {}),
  });
  const decision = standingInstructionDecision(matches);
  if (decision.action === 'refuse') {
    return { action: 'refuse', error: standingInstructionRefusalMessage(decision.match), match: decision.match };
  }
  if (decision.action === 'warn') return { action: 'warn', text: conflictText(decision.matches), matches: decision.matches };
  return { action: 'none' };
}

/**
 * The chat pre-tool's form: never throws. A lookup that cannot run refuses
 * the call with a retry message (only Wisp device-changing calls reach it).
 */
export async function checkStandingInstructionsForCall(args: {
  ceiling: GrantCeiling;
  toolName: string;
  input: Record<string, unknown>;
  auth?: AuthContext;
}): Promise<{ action: 'refuse'; error: string } | { action: 'warn'; text: string } | { action: 'none' }> {
  try {
    const check = await evaluateStandingInstructions(args);
    if (check.action === 'refuse') return { action: 'refuse', error: check.error };
    if (check.action === 'warn') return { action: 'warn', text: check.text };
    return { action: 'none' };
  } catch (err) {
    if (err instanceof StandingGroupTargetError) return { action: 'refuse', error: err.message };
    console.error(`[WispStanding] standing-instruction check failed for '${args.toolName}' (grant ${args.ceiling.grantId}); refusing`, err);
    captureException(err instanceof Error ? err : new Error(String(err)));
    return { action: 'refuse', error: STANDING_CHECK_UNAVAILABLE_MESSAGE };
  }
}

/** The card/intent description of a warned call: every channel (web, mobile, the queue) shows the conflict. */
export function standingConflictDescription(text: string, description: string): string {
  return `Conflicts with a remembered instruction: '${text}'. ${description}`;
}
