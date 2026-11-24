import { fetchWithAuth } from '../../../stores/auth';
import { extractApiError } from '@/lib/apiError';
import { i18n } from '@/lib/i18n';
import { runAction } from '@/lib/runAction';
import { TARGET_LEVEL_ORDER, type ConfigPolicyTargetLevel } from '../appliesToSummary';
import type { ApplyPayload, StoredAssignment } from './appliesToDraft';

// Client and wire parsers for the applies-to panel (#12467, plan W02c P1).
//
// The reach shapes are copied from the API as built (W02a, #12531) and the
// Apply shapes from W02b (#12543, not yet on main). When #12543 merges, keep
// these parsers (the web must not trust the wire) but check them against the
// route's literals again.

/** `GET /configuration-policies/:id/reach` and each value of the batch read. */
export interface ConfigPolicyReach {
  direct: number;
  throughChildren: number;
  organizations: number;
  /**
   * The API stopped counting early: every number is a LOWER bound. Show
   * "at least N", never N. Reach is what the caller can see: a site-restricted
   * tech may see `direct: 0` on a policy that applies elsewhere.
   */
  partial?: true;
}

/** The dry run's device delta (`200 { dryRun: true, delta }`). */
export interface AssignmentDelta {
  added: number;
  removed: number;
  /**
   * The bound stopped the count: the numbers are APPROXIMATE in either
   * direction, not a bound. Unlike reach, do not say "at least".
   */
  partial?: true;
}

export type ApplyEntryRef = { op: 'add' | 'update' | 'remove'; index: number };

/** What a refused Apply or dry run said. `conflict` is the 409 `assignment_conflict`. */
export interface ApplyFailure {
  conflict: boolean;
  message?: string;
  entry?: ApplyEntryRef;
}

export type DryRunOutcome =
  | { ok: true; delta: AssignmentDelta }
  | { ok: false; status: number; failure: ApplyFailure };

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isFilter = (v: unknown): v is string[] | null =>
  v === null || (Array.isArray(v) && v.every((x) => typeof x === 'string'));

function parseStoredAssignment(raw: unknown): StoredAssignment | null {
  if (!isRecord(raw)) return null;
  const { id, level, targetId, priority } = raw;
  const roleFilter = raw.roleFilter ?? null;
  const osFilter = raw.osFilter ?? null;
  if (typeof id !== 'string' || typeof targetId !== 'string' || typeof priority !== 'number') return null;
  if (!TARGET_LEVEL_ORDER.includes(level as ConfigPolicyTargetLevel)) return null;
  if (!isFilter(roleFilter) || !isFilter(osFilter)) return null;
  return { id, level: level as ConfigPolicyTargetLevel, targetId, priority, roleFilter, osFilter };
}

/** The `data` rows of the assignments read, or null when the body is not that shape. */
export function parseStoredAssignments(body: unknown): StoredAssignment[] | null {
  if (!isRecord(body) || !Array.isArray(body.data)) return null;
  return body.data.map(parseStoredAssignment).filter((row): row is StoredAssignment => row !== null);
}

export function parseReach(raw: unknown): ConfigPolicyReach | null {
  if (!isRecord(raw)) return null;
  const { direct, throughChildren, organizations } = raw;
  if (!isCount(direct) || !isCount(throughChildren) || !isCount(organizations)) return null;
  return { direct, throughChildren, organizations, ...(raw.partial === true ? { partial: true as const } : {}) };
}

/** The dry run's `delta`, or null when the body is not a dry-run answer. */
export function parseDelta(body: unknown): AssignmentDelta | null {
  if (!isRecord(body) || body.dryRun !== true || !isRecord(body.delta)) return null;
  const { added, removed, partial } = body.delta;
  if (!isCount(added) || !isCount(removed)) return null;
  return { added, removed, ...(partial === true ? { partial: true as const } : {}) };
}

/** Apply's 201 carries the written rows; the panel only needs how many. */
export function parseApplyResult(body: unknown): { added: number; updated: number; removed: number } | null {
  if (!isRecord(body)) return null;
  const { added, updated, removed } = body;
  if (!Array.isArray(added) || !Array.isArray(updated) || !Array.isArray(removed)) return null;
  return { added: added.length, updated: updated.length, removed: removed.length };
}

function parseEntryRef(raw: unknown): ApplyEntryRef | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.op !== 'add' && raw.op !== 'update' && raw.op !== 'remove') return undefined;
  if (!isCount(raw.index)) return undefined;
  return { op: raw.op, index: raw.index };
}

export function parseApplyFailure(body: unknown): ApplyFailure {
  if (!isRecord(body)) return { conflict: false };
  const conflict = body.error === 'assignment_conflict';
  const message = conflict
    ? (typeof body.message === 'string' ? body.message : undefined)
    : (typeof body.error === 'string' ? body.error : undefined);
  const entry = parseEntryRef(body.entry);
  return { conflict, ...(message ? { message } : {}), ...(entry ? { entry } : {}) };
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

/** The policy's assignment rows the caller may list (rows outside their site ceiling are absent). */
export async function fetchAssignments(policyId: string): Promise<StoredAssignment[]> {
  const response = await fetchWithAuth(`/configuration-policies/${policyId}/assignments`);
  const body = await readJson(response);
  const fallback = i18n.t('policies:configurationPolicies.appliesToPanel.loadFailed');
  if (!response.ok) throw new Error(extractApiError(body, fallback));
  const rows = parseStoredAssignments(body);
  if (!rows) throw new Error(fallback);
  return rows;
}

export interface ApplyOptions {
  /** Copy for a refusal by machine token (`code`, else `error`), e.g. to name the colliding target. */
  friendly?: (code: string, message: string, body?: unknown) => string | undefined;
  /** Toast a 409 `assignment_conflict` too. Off by default: the panel shows it inline with Reload. */
  toastConflict?: boolean;
  /**
   * No success toast. Activate (W03d C3) applies then activates, and toasts
   * once, for the activation.
   */
  silentSuccess?: boolean;
}

/** Commit a staged change. Throws the ActionError runAction raised (already toasted, except a conflict). */
export async function applyAssignments(
  policyId: string,
  payload: ApplyPayload,
  options: ApplyOptions = {},
): Promise<{ added: number; updated: number; removed: number }> {
  const errorFallback = i18n.t('policies:configurationPolicies.appliesToPanel.applyFailed');
  return runAction({
    request: () =>
      fetchWithAuth(`/configuration-policies/${policyId}/assignments/apply`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    errorFallback,
    ...(options.silentSuccess ? {} : { successMessage: i18n.t('policies:configurationPolicies.appliesToPanel.applied') }),
    parseSuccess: (data) => parseApplyResult(data) ?? { added: 0, updated: 0, removed: 0 },
    ...(options.friendly ? { friendly: options.friendly } : {}),
    suppressErrorToast: (status, _code, body) =>
      !options.toastConflict && status === 409 && isRecord(body) && body.error === 'assignment_conflict',
  });
}

/**
 * What the staged change would do, without writing anything. The API runs the
 * same checks as Apply, so a refusal comes back here first; the panel shows it
 * at the foot. Never throws.
 */
export async function dryRunAssignments(policyId: string, payload: ApplyPayload): Promise<DryRunOutcome> {
  let response: Response;
  try {
    // runaction-exempt: a dry run writes nothing and runs on every draft change (debounced); a toast per keystroke would be noise, and the panel renders the outcome inline at its foot.
    response = await fetchWithAuth(`/configuration-policies/${policyId}/assignments/apply`, {
      method: 'POST',
      body: JSON.stringify({ ...payload, dryRun: true }),
    });
  } catch {
    return { ok: false, status: 0, failure: { conflict: false } };
  }
  const body = await readJson(response);
  if (!response.ok) return { ok: false, status: response.status, failure: parseApplyFailure(body) };
  const delta = parseDelta(body);
  if (!delta) return { ok: false, status: response.status, failure: { conflict: false } };
  return { ok: true, delta };
}

/** The batch reach route takes at most this many ids. */
export const REACH_BATCH_LIMIT = 100;

/**
 * Reach for many policies. An id absent from the answer (the caller cannot
 * read it, or it was malformed) is unknown, never 0. Throws when a read fails.
 */
export async function fetchReach(ids: readonly string[]): Promise<Record<string, ConfigPolicyReach>> {
  const unique = [...new Set(ids)];
  const out: Record<string, ConfigPolicyReach> = {};
  for (let i = 0; i < unique.length; i += REACH_BATCH_LIMIT) {
    const chunk = unique.slice(i, i + REACH_BATCH_LIMIT);
    const response = await fetchWithAuth(`/configuration-policies/reach?ids=${chunk.join(',')}`);
    const body = await readJson(response);
    if (!response.ok || !isRecord(body) || !isRecord(body.data)) throw new Error(`reach ${response.status}`);
    for (const [id, raw] of Object.entries(body.data)) {
      const reach = parseReach(raw);
      if (reach) out[id] = reach;
    }
  }
  return out;
}

/** Reach for one policy, or null when the answer is malformed. Throws when the read fails. */
export async function fetchPolicyReach(policyId: string): Promise<ConfigPolicyReach | null> {
  const response = await fetchWithAuth(`/configuration-policies/${policyId}/reach`);
  const body = await readJson(response);
  if (!response.ok) throw new Error(`reach ${response.status}`);
  return parseReach(body);
}
