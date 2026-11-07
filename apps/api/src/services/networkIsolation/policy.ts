import { agentAcceptsPolicyAllow, containmentExtraAllowToEntries, type IsolationAllowEntry, type NetworkIsolationReport } from '@breeze/shared';
import { withDbTransaction } from '../../db';
import type { DeviceNetworkIsolation } from '../../db/schema';
import { auditRefusedExecutionGroups, type RefusedExecutionGroup } from '../executionTargetGating';
import { resolveContainmentPolicy } from '../featureConfigResolver';

/** What the containment policy adds to one device's allowlist (#10100, spec §3.4). */
export interface IsolationPolicy {
  /** `scope:"any"` permits. A policy is their only source. */
  extras: readonly IsolationAllowEntry[];
  /** The resolver's revision; null when there is nothing to send under one. */
  revision: string | null;
  /** Execution-unsafe groups whose containment policy was not applied to this device. */
  refusedGroups: readonly RefusedExecutionGroup[];
  /** The winning policy's stored settings are malformed, so its permits were dropped. */
  invalidStoredSettings: boolean;
}

const POLICY_GROUP_REFUSED_ACTION = 'device.isolation.policy_group_refused';

export const NO_ISOLATION_POLICY: IsolationPolicy = Object.freeze({ extras: Object.freeze([]), revision: null, refusedGroups: Object.freeze([]), invalidStoredSettings: false });

/**
 * The policy for a device, gated on what its agent accepts. Below `policyAllow` this is no policy and
 * no query: an older agent would reject the whole block over one `scope:"any"` entry, while the fixed
 * permits alone are a narrowing it applies. Malformed stored settings and an unknown device resolve to
 * the W1 defaults (no extras), which arrive here as no policy.
 *
 * Reads in its own savepoint, so a failure leaves the caller's transaction usable; it then throws. A
 * caller with no earlier answer isolates on the fixed permits, and one holding a snapshot keeps it.
 */
export async function readIsolationPolicy(device: { id: string; networkIsolationVersion?: number | null }): Promise<IsolationPolicy> {
  if (!agentAcceptsPolicyAllow(device.networkIsolationVersion)) return NO_ISOLATION_POLICY;
  const policy = await withDbTransaction(() => resolveContainmentPolicy(device.id));
  const extras = containmentExtraAllowToEntries(policy.extraAllow);
  return { extras, revision: extras.length > 0 ? policy.revision : null, refusedGroups: policy.refusedGroups, invalidStoredSettings: policy.invalidStoredSettings };
}

export function auditRefusedPolicyGroups(orgId: string, policy: IsolationPolicy): void {
  if (policy.refusedGroups.length > 0) auditRefusedExecutionGroups(orgId, POLICY_GROUP_REFUSED_ACTION, [...policy.refusedGroups]);
}

/**
 * True while the server's policy for an isolated episode is not the one the agent last adopted. Read
 * this, not the state, to know a change has landed: a failed refresh keeps the old rules and still
 * reports `verified` at the new generation. The agent journals `policy_applied` / `policy_removed` when
 * it adopts a revision, on a verified rules commit or when the rules already match; a failed refresh
 * adopts nothing, so those events are the evidence.
 */
export function isolationPolicyPending(row: Pick<DeviceNetworkIsolation, 'desiredState' | 'allowSnapshotRevision' | 'appliedPolicyRevision'>): boolean {
  return row.desiredState === 'isolated' && row.allowSnapshotRevision !== row.appliedPolicyRevision;
}

/** The agent's closed set (agent/internal/isolation/policy.go). Anything else is recorded as `unknown`. */
const POLICY_REJECT_REASONS: ReadonlySet<string> = new Set(['revision_missing', 'revision_invalid', 'revision_regressed', 'generation_not_advanced', 'spec_invalid']);
const POLICY_JOURNAL_TYPES: ReadonlySet<string> = new Set(['policy_applied', 'policy_removed', 'policy_rejected', 'refresh_reverted']);
const WIRE_REVISION = /^[\x21-\x7e]{1,128}$/;
const WIRE_CODE = /^[a-z0-9_]{1,64}$/;
/** More than any real report holds; a device cannot grow the incident timeline by 200 entries a beat. */
const MAX_POLICY_TIMELINE_ENTRIES = 8;

export interface PolicyEventProgress {
  policyEventSeq: number;
  /** Absent when no commit was reported; null when the agent removed its policy. */
  appliedPolicyRevision?: string | null;
  /** True when the agent committed a policy change in these events. */
  committed: boolean;
  timeline: { type: string; metadata: Record<string, unknown> }[];
}

type JournalEvent = NonNullable<NetworkIsolationReport['events']>[number];

function relevantPolicyEvents(row: Pick<DeviceNetworkIsolation, 'id'>, report: NetworkIsolationReport): JournalEvent[] {
  const bound = report.journalSeq ?? Number.POSITIVE_INFINITY;
  return (report.events ?? [])
    // Only a rejection may lack an identity: the agent drops one that failed validation rather than journal it.
    .filter(event => POLICY_JOURNAL_TYPES.has(event.type) && event.seq <= bound
      && (event.isolationId === row.id || (event.type === 'policy_rejected' && !event.isolationId)))
    .sort((a, b) => a.seq - b.seq);
}

/** Whether this report holds policy events the server has not read. */
export function hasUnreadPolicyEvents(row: Pick<DeviceNetworkIsolation, 'id' | 'policyEventSeq'>, report: NetworkIsolationReport): boolean {
  return relevantPolicyEvents(row, report).some(event => event.seq > row.policyEventSeq);
}

/**
 * Translate the unread policy events of a report (spec §3.8). The agent resends its whole journal on
 * every beat, so `policyEventSeq` marks how far the server has read. Agent text is never copied: a
 * reason outside the closed set becomes `unknown`, and a malformed revision is not believed.
 *
 * A failed refresh retries every beat, so its revert is recorded once per generation, and only while a
 * policy change is outstanding. Any other refresh reverting is not a policy event.
 */
export function readPolicyEvents(row: Pick<DeviceNetworkIsolation, 'id' | 'generation' | 'desiredState' | 'allowSnapshotRevision' | 'appliedPolicyRevision' | 'policyEventSeq'>, report: NetworkIsolationReport): PolicyEventProgress | null {
  const events = relevantPolicyEvents(row, report);
  const readTo = row.policyEventSeq;
  const unread = events.filter(event => event.seq > readTo);
  if (unread.length === 0) return null;

  const progress: PolicyEventProgress = { policyEventSeq: Math.max(readTo, ...unread.map(event => event.seq)), committed: false, timeline: [] };
  for (const event of unread) {
    const base = { journalSeq: event.seq, reportedGeneration: event.generation ?? null };
    if (event.type === 'policy_applied') {
      if (!event.detail || !WIRE_REVISION.test(event.detail)) continue;
      progress.appliedPolicyRevision = event.detail;
      progress.committed = true;
      progress.timeline.push({ type: event.type, metadata: { ...base, revision: event.detail } });
    } else if (event.type === 'policy_removed') {
      progress.appliedPolicyRevision = null;
      progress.committed = true;
      progress.timeline.push({ type: event.type, metadata: { ...base, revision: event.detail && WIRE_REVISION.test(event.detail) ? event.detail : null } });
    } else if (event.type === 'policy_rejected') {
      progress.timeline.push({ type: event.type, metadata: { ...base, reason: event.detail && POLICY_REJECT_REASONS.has(event.detail) ? event.detail : 'unknown' } });
    }
  }

  const applied = progress.appliedPolicyRevision === undefined ? row.appliedPolicyRevision : progress.appliedPolicyRevision;
  if (isolationPolicyPending({ desiredState: row.desiredState, allowSnapshotRevision: row.allowSnapshotRevision, appliedPolicyRevision: applied })) {
    const reverts = events.filter(event => event.type === 'refresh_reverted' && event.generation === row.generation);
    const first = reverts[0];
    if (first && first.seq > readTo) {
      progress.timeline.push({ type: 'policy_refresh_reverted', metadata: { journalSeq: first.seq, reportedGeneration: first.generation ?? null, reason: first.detail && WIRE_CODE.test(first.detail) ? first.detail : 'unknown' } });
    }
  }
  progress.timeline = progress.timeline.slice(-MAX_POLICY_TIMELINE_ENTRIES);
  return progress;
}
