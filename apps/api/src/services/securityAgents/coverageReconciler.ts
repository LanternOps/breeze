import type { SecurityAgentCoverageState } from '../../db/schema';
import type { VendorKey } from './securityAgentVendors';

/**
 * Coverage reconciliation, the pure half (#6960 W03, spec 2.7 / 2.9).
 *
 * Per (device, vendor) it compares the DEVICE view (the managed policy's
 * software compliance row: installed / missing, and how the install loop is
 * doing) with the VENDOR view (endpoints the vendor console reports, through a
 * provider-neutral {@link VendorEndpointSource}) and decides a coverage state.
 * The I/O half (`coverageReconcileRun.ts`) loads the inputs and persists the
 * decisions; nothing here touches the database.
 *
 * Precedence for one device:
 *  1. The vendor reports it under the device's own org → `covered`, or
 *     `vendor_offline` when every matching agent is offline.
 *  2. Else the vendor reports it under ANOTHER org (only for vendors that have
 *     a vendor-side org) → `mismatched_org`: a foreign agent LINKED to this
 *     device, or an unlinked foreign agent with its hostname while inventory
 *     shows the agent installed (a name match alone is not evidence when the
 *     agent is missing here). Detection already treats the agent as installed,
 *     so nothing is redeployed, and a technician decides (spec 2.9; no
 *     reassign action).
 *  3. Else the device view: missing with the install loop exhausted (or not
 *     armed) → `gap`; missing with an install still possible → `pending`;
 *     installed but not reported, or never evaluated → `pending`.
 *
 * `gap` deliberately waits for the install loop to give up: a fresh rollout
 * queues installs under a per-pass cap, and calling every queued device a gap
 * would alert on all of them.
 *
 * Caveat (spec 2.7): Huntress sync drops agents whose vendor org is not mapped
 * and links hostnames only inside the mapped org, so an agent installed under
 * an unmapped vendor org has no row at all. Only retained rows are classified;
 * such a device stays `pending` (installed, awaiting the vendor report) rather
 * than a guessed mismatch.
 */

/** What a vendor console reports about one agent, normalised across vendors. */
export interface VendorEndpointView {
  /** Breeze-side id of the vendor endpoint row (huntress_agents.id today). */
  endpointId: string;
  /** The Breeze org the vendor reports this agent under (through the vendor's org mapping). */
  orgId: string;
  /** The Breeze device the vendor sync linked it to, if any. */
  deviceId: string | null;
  hostname: string | null;
  /** null when the vendor gives no usable status. */
  online: boolean | null;
}

/**
 * The vendor view, provider-neutral. Backed by `huntress_agents` in W03;
 * `s1_agents` (W04) and `edr_endpoints` (framework) implement it later.
 */
export interface VendorEndpointSource {
  vendor: VendorKey;
  /**
   * True when a row's org comes from a vendor-side org (Huntress organizations
   * mapped to Breeze orgs), so an agent reported under another Breeze org is a
   * real mismatch. Vendors without one never claim `mismatched_org`.
   */
  reportsVendorOrg: boolean;
  /**
   * Every agent relevant to one Breeze org: rows the vendor reports under the
   * org, plus rows of the same partner's integration that are linked to the
   * org's devices or carry one of their hostnames while unlinked (the
   * cross-org mismatch candidates).
   *
   * `null` means the vendor view is UNAVAILABLE (no active integration, never
   * synced, sync stale): an empty list would read as "the vendor reports
   * nothing" and wrongly downgrade covered devices and resolve live alerts, so
   * the reconciler leaves that vendor's rows and alerts untouched instead.
   */
  listForOrg(orgId: string): Promise<VendorEndpointView[] | null>;
}

export type DeviceInstallView = 'installed' | 'missing' | 'unknown';

export interface DeviceCoverageInput {
  deviceId: string;
  orgId: string;
  /** Normalised hostname and display name. */
  hostnames: readonly string[];
  /** From the managed policy's compliance row: is the vendor's rule a `missing` violation? */
  install: DeviceInstallView;
  /** `software_compliance_status.install_remediation_status`. */
  installRemediationStatus: string | null;
  /** Whether the managed policy is armed to install (it always is unless held). */
  installArmed: boolean;
}

export type ReconciledState = Exclude<SecurityAgentCoverageState, 'vendor_only' | 'not_applicable'>;

export interface CoverageDecision {
  state: ReconciledState;
  reasonCode: string | null;
  detail: string | null;
  vendorEndpointId: string | null;
}

export interface OrgCoverageInput {
  orgId: string;
  reportsVendorOrg: boolean;
  devices: readonly DeviceCoverageInput[];
  endpoints: readonly VendorEndpointView[];
  /**
   * Normalised hostnames of ANY device in the partner (in scope or not) that
   * match an unlinked agent's hostname. Such an agent is a Breeze device's,
   * never `vendor_only`.
   */
  knownDeviceHostnames: ReadonlySet<string>;
}

export interface OrgCoverageResult {
  decisions: Map<string, CoverageDecision>;
  vendorOnly: Array<{ endpointId: string; detail: string }>;
}

const MISMATCH_DETAIL =
  "The vendor reports this device under a different organization's account. Nothing is reinstalled automatically; reassign the agent in the vendor console.";
const VENDOR_ONLY_DETAIL = 'The vendor reports this agent, but no Breeze device in this organization matches it.';

export function normalizeHostname(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

export function classifyOrgCoverage(input: OrgCoverageInput): OrgCoverageResult {
  const linkedByDevice = new Map<string, VendorEndpointView[]>();
  const unlinkedByHostname = new Map<string, VendorEndpointView[]>();
  for (const endpoint of input.endpoints) {
    if (endpoint.deviceId) {
      push(linkedByDevice, endpoint.deviceId, endpoint);
      continue;
    }
    const hostname = normalizeHostname(endpoint.hostname);
    if (hostname) push(unlinkedByHostname, hostname, endpoint);
  }

  // A hostname two in-scope devices share identifies neither.
  const devicesByHostname = new Map<string, number>();
  for (const device of input.devices) {
    for (const hostname of new Set(device.hostnames)) {
      devicesByHostname.set(hostname, (devicesByHostname.get(hostname) ?? 0) + 1);
    }
  }

  const claimed = new Set<string>();
  const decisions = new Map<string, CoverageDecision>();
  for (const device of input.devices) {
    const linked = linkedByDevice.get(device.deviceId) ?? [];
    const byName: VendorEndpointView[] = [];
    for (const hostname of new Set(device.hostnames)) {
      if (devicesByHostname.get(hostname) !== 1) continue;
      byName.push(...(unlinkedByHostname.get(hostname) ?? []));
    }
    const isOwn = (m: VendorEndpointView) => !input.reportsVendorOrg || m.orgId === device.orgId;
    const own = [...linked, ...byName].filter(isOwn);
    // A NAME-only match against another org's agent is evidence of a mismatch
    // only when this device's inventory shows the agent installed. Generic
    // hostnames recur across an MSP's client orgs; when the agent is missing
    // here it is on some other machine and this device is on the install path.
    const foreign = [
      ...linked.filter((m) => !isOwn(m)),
      ...(device.install === 'installed' ? byName.filter((m) => !isOwn(m)) : []),
    ];
    for (const match of [...own, ...foreign]) claimed.add(match.endpointId);

    if (own.length > 0) {
      const live = own.find((m) => m.online !== false);
      decisions.set(device.deviceId, live
        ? { state: 'covered', reasonCode: null, detail: null, vendorEndpointId: live.endpointId }
        : { state: 'vendor_offline', reasonCode: null, detail: 'The vendor reports this agent as offline.', vendorEndpointId: own[0]!.endpointId });
      continue;
    }
    if (foreign.length > 0) {
      decisions.set(device.deviceId, {
        state: 'mismatched_org',
        reasonCode: 'vendor_org_mismatch',
        detail: MISMATCH_DETAIL,
        vendorEndpointId: foreign[0]!.endpointId,
      });
      continue;
    }
    decisions.set(device.deviceId, classifyDeviceView(device));
  }

  const vendorOnly: Array<{ endpointId: string; detail: string }> = [];
  for (const endpoint of input.endpoints) {
    if (endpoint.orgId !== input.orgId || endpoint.deviceId || claimed.has(endpoint.endpointId)) continue;
    const hostname = normalizeHostname(endpoint.hostname);
    if (hostname && input.knownDeviceHostnames.has(hostname)) continue;
    vendorOnly.push({ endpointId: endpoint.endpointId, detail: VENDOR_ONLY_DETAIL });
  }

  return { decisions, vendorOnly };
}

function classifyDeviceView(device: DeviceCoverageInput): CoverageDecision {
  if (device.install === 'unknown') return pending('awaiting_evaluation');
  if (device.install === 'installed') return pending('awaiting_vendor_report');
  if (device.installRemediationStatus === 'gave_up') {
    return {
      state: 'gap',
      reasonCode: 'install_failed',
      detail: 'The agent is not installed and automatic install attempts are exhausted.',
      vendorEndpointId: null,
    };
  }
  if (!device.installArmed) {
    return {
      state: 'gap',
      reasonCode: 'install_not_armed',
      detail: 'The agent is not installed and the policy is not allowed to install it.',
      vendorEndpointId: null,
    };
  }
  return pending('install_pending');
}

function pending(reasonCode: string): CoverageDecision {
  return { state: 'pending', reasonCode, detail: null, vendorEndpointId: null };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export type CoverageAlertKind = 'gap' | 'mismatched_org';

/**
 * Gap and mismatch alerts fire on TRANSITION into the state, judged against the
 * persisted prior state: a device that stays in `gap` raises nothing on later
 * runs, and moving from `gap` to `mismatched_org` raises the new kind.
 */
export function alertTransition(
  prior: SecurityAgentCoverageState | null,
  next: SecurityAgentCoverageState,
): CoverageAlertKind | null {
  if (next !== 'gap' && next !== 'mismatched_org') return null;
  return prior === next ? null : next;
}
