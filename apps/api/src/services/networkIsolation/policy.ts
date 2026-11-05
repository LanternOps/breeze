import { agentAcceptsPolicyAllow, containmentExtraAllowToEntries, type IsolationAllowEntry } from '@breeze/shared';
import { withDbTransaction } from '../../db';
import { resolveContainmentPolicy } from '../featureConfigResolver';

/** What the containment policy adds to one device's allowlist (#10100, spec §3.4). */
export interface IsolationPolicy {
  /** `scope:"any"` permits. A policy is their only source. */
  extras: readonly IsolationAllowEntry[];
  /** The resolver's revision; null when there is nothing to send under one. */
  revision: string | null;
}

export const NO_ISOLATION_POLICY: IsolationPolicy = Object.freeze({ extras: Object.freeze([]), revision: null });

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
  return extras.length > 0 ? { extras, revision: policy.revision } : NO_ISOLATION_POLICY;
}
