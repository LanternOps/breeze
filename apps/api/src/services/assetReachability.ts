/**
 * Reachability derivation (spec §4, decision D1).
 *
 * PURE. No I/O, no DB, no clock except the injected `now`. Callers
 * (services/assetReachabilityLoader.ts, the list/detail routes, the AI tools)
 * assemble the input; this module only ranks it.
 *
 * WHY DERIVED, NOT MATERIALISED: four independent pipelines write the asset's
 * state today (discovery scan, discovery disappeared-sweep, UniFi sync, UniFi
 * telemetry) and none of them coordinates with the other two that actually
 * probe the device (the SNMP poller and the network-check worker, which write
 * their own tables). A materialised `reachability_*` column would be whichever
 * of those six wrote last. So we rank at read time, by EVIDENCE CLASS:
 *
 *   host class     network_check (icmp/tcp), probe, scan, unifi
 *   protocol class snmp
 *
 * A protocol-class SUCCESS is positive evidence (an SNMP reply proves the host
 * answered). A protocol-class FAILURE proves nothing about the host:
 * `consecutive_failures` is incremented at DISPATCH (jobs/snmpWorker.ts
 * markPollDispatched), so `offline` can mean the bridging agent, the
 * credentials, or a missing template just as easily as the device.
 *
 * http_check and dns_check NEVER contribute: a TLS or DNS failure is not host
 * evidence (agent/internal/heartbeat/handlers_monitor.go:264 returns
 * status=offline for a certificate problem on a perfectly reachable host).
 */

export type ReachabilityState = 'responding' | 'not_responding' | 'unverified';
export type ReachabilitySource = 'network_check' | 'probe' | 'scan' | 'unifi' | 'snmp';
export type SnmpDetailState = 'ok' | 'failing' | 'no_template' | 'no_agent' | 'asset_moved' | 'never_polled';

export interface Reachability {
  state: ReachabilityState;
  /** null only when unverified with no observation at all. */
  source: ReachabilitySource | null;
  observedAt: string | null;
  lastKnown: { state: 'responding' | 'not_responding'; source: ReachabilitySource; observedAt: string } | null;
  detail: {
    networkCheck?: { state: 'online' | 'degraded' | 'offline'; observedAt: string; responseMs: number | null; monitorId: string };
    probe?: { state: 'ok' | 'failed' | 'pending'; observedAt: string | null; responseMs: number | null };
    snmp?: { state: SnmpDetailState; observedAt: string | null; consecutiveFailures: number };
    scan?: { state: 'seen' | 'missed'; observedAt: string | null; source: 'scan' | 'unifi' };
  };
}

export interface ReachabilityAssetInput {
  isOnline: boolean;
  statusObservedAt: Date | string | null;
  statusSource: 'scan' | 'unifi' | null;
  lastSeenAt: Date | string | null;
  lastProbeAt: Date | string | null;
  lastProbeStatus: 'pending' | 'ok' | 'failed' | null;
  lastProbeResponseMs: number | null;
}

export interface ReachabilitySnmpInput {
  isActive: boolean;
  lastStatus: string | null;
  lastPolled: Date | string | null;
  lastPollAttemptedAt: Date | string | null;
  pollingInterval: number | null;
  consecutiveFailures: number;
}

export interface ReachabilityMonitorInput {
  id: string;
  monitorType: 'icmp_ping' | 'tcp_port' | 'http_check' | 'dns_check';
  isActive: boolean;
  lastStatus: 'online' | 'offline' | 'degraded' | 'unknown';
  lastChecked: Date | string | null;
  lastResponseMs: number | null;
  pollingInterval: number;
}

export interface ReachabilityInput {
  asset: ReachabilityAssetInput;
  snmpDevice: ReachabilitySnmpInput | null;
  networkMonitors: ReachabilityMonitorInput[];
  /** From the asset's discovery profile when it is an `interval` schedule; null for cron/none. */
  scanIntervalSeconds: number | null;
}

export const PROBE_FRESHNESS_MS = 15 * 60_000;
export const PROBE_STALE_PENDING_MS = 2 * 60_000;
export const UNIFI_FRESHNESS_MS = 60 * 60_000;
export const DEFAULT_SCAN_FRESHNESS_MS = 24 * 60 * 60_000;
export const MIN_NETWORK_CHECK_FRESHNESS_MS = 5 * 60_000;
export const MIN_SNMP_FRESHNESS_MS = 10 * 60_000;

/** Host-class monitor types. http_check/dns_check are absent on purpose (§4.1). */
const HOST_MONITOR_TYPES = new Set(['icmp_ping', 'tcp_port']);

const SNMP_FAILURE_DETAIL: Record<string, SnmpDetailState> = {
  offline: 'failing',
  warning: 'failing',
  no_template: 'no_template',
  no_agent_in_site: 'no_agent',
  asset_missing: 'asset_moved',
  asset_no_site: 'asset_moved',
};

type Observation = {
  polarity: 'positive' | 'negative';
  source: ReachabilitySource;
  at: number;
  iso: string;
  /** Milliseconds after `at` during which this observation still counts. */
  windowMs: number;
};

function toMillis(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function observe(
  polarity: 'positive' | 'negative',
  source: ReachabilitySource,
  at: number,
  windowMs: number,
): Observation {
  return { polarity, source, at, iso: iso(at), windowMs };
}

export function deriveReachability(input: ReachabilityInput, now: Date = new Date()): Reachability {
  const nowMs = now.getTime();
  const detail: Reachability['detail'] = {};
  const observations: Observation[] = [];

  // ── network_check (host class) ────────────────────────────────────────────
  // Every eligible monitor is considered and the freshest wins the detail slot,
  // so a device with both an ICMP and a TCP check reports whichever last spoke.
  let bestMonitor: { obs: Observation; monitor: ReachabilityMonitorInput } | null = null;
  for (const monitor of input.networkMonitors) {
    if (!monitor.isActive) continue;
    if (!HOST_MONITOR_TYPES.has(monitor.monitorType)) continue;
    if (monitor.lastStatus === 'unknown') continue;
    const at = toMillis(monitor.lastChecked);
    if (at === null) continue;
    const windowMs = Math.max(2 * monitor.pollingInterval * 1000, MIN_NETWORK_CHECK_FRESHNESS_MS);
    const obs = observe(monitor.lastStatus === 'offline' ? 'negative' : 'positive', 'network_check', at, windowMs);
    if (!bestMonitor || obs.at > bestMonitor.obs.at) bestMonitor = { obs, monitor };
  }
  if (bestMonitor) {
    observations.push(bestMonitor.obs);
    detail.networkCheck = {
      state: bestMonitor.monitor.lastStatus as 'online' | 'degraded' | 'offline',
      observedAt: bestMonitor.obs.iso,
      responseMs: bestMonitor.monitor.lastResponseMs,
      monitorId: bestMonitor.monitor.id,
    };
  }

  // ── probe (host class) ────────────────────────────────────────────────────
  const probeAt = toMillis(input.asset.lastProbeAt);
  const probeStatus = input.asset.lastProbeStatus;
  if (probeAt !== null && probeStatus) {
    // A pending stamp older than PROBE_STALE_PENDING_MS means the agent never
    // answered — that IS a failure, and treating it as one is what stops the UI
    // spinning forever on a dead bridge.
    const resolved: 'ok' | 'failed' | 'pending' =
      probeStatus === 'pending' && nowMs - probeAt > PROBE_STALE_PENDING_MS ? 'failed' : probeStatus;
    detail.probe = { state: resolved, observedAt: iso(probeAt), responseMs: input.asset.lastProbeResponseMs };
    if (resolved !== 'pending') {
      observations.push(observe(resolved === 'ok' ? 'positive' : 'negative', 'probe', probeAt, PROBE_FRESHNESS_MS));
    }
  }

  // ── scan / unifi (host class) ─────────────────────────────────────────────
  // See the DECISIONS block in the plan: an undated negative is no observation.
  const statusAt = toMillis(input.asset.statusObservedAt);
  const sightedAt = statusAt ?? (input.asset.isOnline ? toMillis(input.asset.lastSeenAt) : null);
  if (sightedAt !== null) {
    const scanSource: 'scan' | 'unifi' = input.asset.statusSource ?? 'scan';
    const windowMs = scanSource === 'unifi'
      ? UNIFI_FRESHNESS_MS
      : input.scanIntervalSeconds != null
        ? 2 * input.scanIntervalSeconds * 1000
        : DEFAULT_SCAN_FRESHNESS_MS;
    detail.scan = { state: input.asset.isOnline ? 'seen' : 'missed', observedAt: iso(sightedAt), source: scanSource };
    observations.push(observe(input.asset.isOnline ? 'positive' : 'negative', scanSource, sightedAt, windowMs));
  }

  // ── snmp (protocol class) ─────────────────────────────────────────────────
  const snmp = input.snmpDevice;
  if (snmp && snmp.isActive) {
    const polledAt = toMillis(snmp.lastPolled);
    const attemptedAt = toMillis(snmp.lastPollAttemptedAt);
    const windowMs = Math.max(2 * (snmp.pollingInterval ?? 300) * 1000, MIN_SNMP_FRESHNESS_MS);
    if (snmp.lastStatus === 'online' && polledAt !== null) {
      detail.snmp = { state: 'ok', observedAt: iso(polledAt), consecutiveFailures: snmp.consecutiveFailures };
      observations.push(observe('positive', 'snmp', polledAt, windowMs));
    } else if (snmp.lastStatus && SNMP_FAILURE_DETAIL[snmp.lastStatus]) {
      // Protocol-class negatives are REPORTED but never ranked — they cannot
      // produce not_responding on their own (spec §4.2 rule 5).
      detail.snmp = {
        state: SNMP_FAILURE_DETAIL[snmp.lastStatus]!,
        observedAt: attemptedAt !== null ? iso(attemptedAt) : null,
        consecutiveFailures: snmp.consecutiveFailures,
      };
    } else if (polledAt === null) {
      detail.snmp = { state: 'never_polled', observedAt: null, consecutiveFailures: snmp.consecutiveFailures };
    } else {
      // Polled successfully once, current status unrecognised — report the last
      // success as stale evidence rather than inventing a failure state.
      detail.snmp = { state: 'ok', observedAt: iso(polledAt), consecutiveFailures: snmp.consecutiveFailures };
      observations.push(observe('positive', 'snmp', polledAt, windowMs));
    }
  }

  // ── rank (spec §4.2 rules 1-4) ────────────────────────────────────────────
  const freshest = (polarity: 'positive' | 'negative', requireFresh: boolean): Observation | null => {
    let best: Observation | null = null;
    for (const obs of observations) {
      if (obs.polarity !== polarity) continue;
      // Rule 1: only host-class negatives are eligible; the SNMP branch above
      // never pushes a negative, so `polarity === 'negative'` is host-class by
      // construction.
      if (requireFresh && nowMs - obs.at > obs.windowMs) continue;
      if (!best || obs.at > best.at) best = obs;
    }
    return best;
  };

  const positive = freshest('positive', true);
  const negative = freshest('negative', true);

  if (positive || negative) {
    const winner = !negative || (positive && positive.at >= negative.at) ? positive! : negative!;
    return {
      state: winner.polarity === 'positive' ? 'responding' : 'not_responding',
      source: winner.source,
      observedAt: winner.iso,
      lastKnown: null,
      detail,
    };
  }

  // Rule 4 — nothing inside a window. Report the freshest observation of ANY
  // age so the UI can say "Unverified - last seen by scan 19 h ago".
  let stalest: Observation | null = null;
  for (const obs of observations) {
    if (!stalest || obs.at > stalest.at) stalest = obs;
  }

  return {
    state: 'unverified',
    source: null,
    observedAt: null,
    lastKnown: stalest
      ? { state: stalest.polarity === 'positive' ? 'responding' : 'not_responding', source: stalest.source, observedAt: stalest.iso }
      : null,
    detail,
  };
}

/**
 * The devices-list `status` axis (spec §4.4). `unverified` is `unknown`, NEVER
 * `offline` — that conflation is F1 and #4622's manual-asset bug in one.
 */
export function reachabilityToListStatus(r: Reachability): 'online' | 'offline' | 'unknown' {
  if (r.state === 'responding') return 'online';
  if (r.state === 'not_responding') return 'offline';
  return 'unknown';
}
