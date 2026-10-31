import { semverCompare } from './semverCompare';

/**
 * Network-isolation containment (#10088, spec
 * docs/superpowers/specs/security/2026-10-25-network-isolation-containment-spec.md), shared by the API
 * (gates, the episode table's vocabulary, the allowlist builder) and the web console (menu gating, the
 * isolate dialog), so the two cannot drift. The SQL CHECKs in
 * apps/api/migrations/2027-01-17-200000-device-network-isolations.sql mirror these tuples;
 * networkIsolation.migration.test.ts compares them.
 */

/**
 * First agent release that can isolate. `'999.0.0'` is a fail-closed sentinel (Gate B decision 6):
 * no real agent satisfies it, so nothing can isolate a device until W1g pins the release that ships
 * the capable Windows agent. The gate never blocks a release.
 */
export const NETWORK_ISOLATION_MIN_AGENT_VERSION = '999.0.0';

/** `securityCapabilities.networkIsolationVersion` levels. 0 = cannot isolate. */
export const NETWORK_ISOLATION_CAPABILITY = { base: 1, deadMan: 2 } as const;

/** TTL policy (OD5): 72 h default, 30 days maximum, a 12 h expiring-soon alert. */
export const NETWORK_ISOLATION_TTL = { defaultHours: 72, maxHours: 720, expiringSoonHours: 12 } as const;

/** Every episode state (spec §3.2). */
export const ISOLATION_STATES = [
  'requested',
  'dispatched',
  'applying',
  'applied',
  'verified',
  'release_requested',
  'released',
  'expired',
  'failed',
  'released_locally',
  'self_released',
  'uninstalled',
] as const;
export type IsolationState = (typeof ISOLATION_STATES)[number];

/** In flight: the server still owes the device a decision (isolate, or the release tombstone). */
export const ACTIVE_STATES = [
  'requested',
  'dispatched',
  'applying',
  'applied',
  'verified',
  'release_requested',
] as const satisfies readonly IsolationState[];

/**
 * The states an AGENT may report for an episode (heartbeat `containment.networkIsolation.state` and
 * command results). requested / dispatched / release_requested are server bookkeeping and uninstalled
 * is recorded by the uninstall path, so an agent never claims them.
 */
export const AGENT_REPORTABLE_STATES = [
  'applying',
  'applied',
  'verified',
  'released',
  'expired',
  'failed',
  'released_locally',
  'self_released',
] as const satisfies readonly IsolationState[];
export type AgentReportableIsolationState = (typeof AGENT_REPORTABLE_STATES)[number];

/** Wire bounds shared by the server builder, the Zod schemas and the agent (W1d). */
export const NETWORK_ISOLATION_LIMITS = {
  /** Entries in one desired block's `allow`. */
  maxAllowEntries: 64,
  /** Journal events in one report; the agent sends the oldest unacknowledged events first. */
  maxReportEvents: 200,
} as const;

/** Terminal, but a human must acknowledge it before the device can be isolated again. */
export const UNRESOLVED_TERMINAL_STATES = ['released_locally', 'self_released'] as const satisfies readonly IsolationState[];

/** Terminal and resolved: out of the one-unresolved-episode-per-device index. */
export const RESOLVED_TERMINAL_STATES = ['released', 'expired', 'failed', 'uninstalled'] as const satisfies readonly IsolationState[];

export const ISOLATION_FAILURE_CODES = [
  'unsupported_platform',
  'mechanism_unavailable',
  'apply_error',
  'control_plane_unreachable',
  'enforcement_not_observed',
  'not_delivered',
  'agent_unsupported',
] as const;
export type IsolationFailureCode = (typeof ISOLATION_FAILURE_CODES)[number];

export const ISOLATION_RELEASE_KINDS = [
  'console',
  'ai',
  'expired',
  'dead_man',
  'local_code',
  'local_forced',
  'uninstall',
  'system',
] as const;
export type IsolationReleaseKind = (typeof ISOLATION_RELEASE_KINDS)[number];

/** The server's intent, kept apart from the observed state. */
export const ISOLATION_DESIRED_STATES = ['isolated', 'released'] as const;
export type IsolationDesiredState = (typeof ISOLATION_DESIRED_STATES)[number];

/** Per-OS enforcement engine: WFP (Windows), pf (macOS), nftables (Linux). */
export const ISOLATION_MECHANISMS = ['wfp', 'pf', 'nft'] as const;
export type IsolationMechanism = (typeof ISOLATION_MECHANISMS)[number];

export const ISOLATION_REQUESTED_BY_KINDS = ['user', 'brain', 'system'] as const;
export type IsolationRequestedByKind = (typeof ISOLATION_REQUESTED_BY_KINDS)[number];

/** Agent journal phases (agent/internal/isolation/journal, W1d), as reported on the heartbeat. */
export const ISOLATION_JOURNAL_PHASES = ['none', 'provisional', 'committed', 'releasing', 'released', 'rolled_back'] as const;
export type IsolationJournalPhase = (typeof ISOLATION_JOURNAL_PHASES)[number];

/**
 * The agent's ECH DNS-over-HTTPS endpoints, in order: the mirror of `DefaultEndpoints` in
 * agent/internal/ech/doh.go (a test parses the Go file). The allowlist permits their hosts so the
 * agent's control-plane dial keeps working while isolated.
 */
export const ECH_DOH_ENDPOINT_URLS: readonly string[] = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/resolve',
];

const ACTIVE_SET: ReadonlySet<string> = new Set(ACTIVE_STATES);
const UNRESOLVED_TERMINAL_SET: ReadonlySet<string> = new Set(UNRESOLVED_TERMINAL_STATES);
const RESOLVED_TERMINAL_SET: ReadonlySet<string> = new Set(RESOLVED_TERMINAL_STATES);

export function isActiveIsolationState(state: string): state is (typeof ACTIVE_STATES)[number] {
  return ACTIVE_SET.has(state);
}

/** Active or awaiting acknowledgement: the states the per-device unique index covers. */
export function isUnresolvedIsolationState(state: string): boolean {
  return ACTIVE_SET.has(state) || UNRESOLVED_TERMINAL_SET.has(state);
}

export function isResolvedTerminalIsolationState(state: string): state is (typeof RESOLVED_TERMINAL_STATES)[number] {
  return RESOLVED_TERMINAL_SET.has(state);
}

/**
 * Whether an agent may be asked to START an isolation: its version is at or above the gate AND it
 * reports `networkIsolationVersion >= 1`. Fails CLOSED: a missing, empty, `dev` or unparseable
 * version, and a missing, zero, negative or non-integer capability, are all unsupported. A
 * prerelease of the minimum counts as the minimum (the forceReboot.ts rule). Never consult this to
 * decide whether a RELEASE may be sent.
 */
export function agentSupportsNetworkIsolation(
  agentVersion: string | null | undefined,
  capabilityVersion: number | null | undefined,
): boolean {
  if (typeof capabilityVersion !== 'number' || !Number.isInteger(capabilityVersion)) return false;
  if (capabilityVersion < NETWORK_ISOLATION_CAPABILITY.base) return false;
  if (typeof agentVersion !== 'string') return false;
  const cmp = semverCompare(agentVersion.trim(), NETWORK_ISOLATION_MIN_AGENT_VERSION);
  return cmp !== null && cmp >= 0;
}

/** Ordering identity shared by agent evidence, command results, and persisted safe reports. */
export interface IsolationOrderingKey { isolationId: string; generation: number; journalSeq: number }

/** Deliberate persistence whitelist: no secrets, resolved addresses, or agent prose. */
export type SafeAgentReport = (IsolationOrderingKey & {
  state: AgentReportableIsolationState; phase: IsolationJournalPhase;
  mechanism: IsolationMechanism | null; ruleDigest: string | null;
}) | { isolationId: null; phase: 'none' };

export type IsolationStartRefusal =
  | 'feature_disabled' | 'partner_not_enabled' | 'agent_below_gate' | 'agent_not_ready' | 'device_lifecycle'
  | 'unsupported_platform' | 'trust_restricted' | 'isolation_already_active'
  | 'isolation_unacknowledged' | 'incident_mismatch' | 'site_forbidden';

export function isUnresolvedTerminalIsolationState(state: string): state is (typeof UNRESOLVED_TERMINAL_STATES)[number] {
  return UNRESOLVED_TERMINAL_SET.has(state);
}
export function isTerminalIsolationState(state: string): state is (typeof UNRESOLVED_TERMINAL_STATES | typeof RESOLVED_TERMINAL_STATES)[number] {
  return isUnresolvedTerminalIsolationState(state) || isResolvedTerminalIsolationState(state);
}
export function isIsolationFailureCode(code: unknown): code is IsolationFailureCode {
  return typeof code === 'string' && ISOLATION_FAILURE_CODES.includes(code as IsolationFailureCode);
}
export function failureCodeFromJournalType(type: string): IsolationFailureCode | undefined {
  const code = type.startsWith('failed_') ? type.slice('failed_'.length) : undefined;
  return isIsolationFailureCode(code) ? code : undefined;
}
export const ISOLATION_RELEASE_JOURNAL_TYPES = {
  released_dead_man: 'dead_man', released_local_code: 'local_code', released_local_forced: 'local_forced',
} as const satisfies Record<string, IsolationReleaseKind>;

export const ISOLATION_RESULT_PHASE_BY_STATE: Readonly<Record<AgentReportableIsolationState, IsolationJournalPhase>> = {
  applying: 'provisional', applied: 'committed', verified: 'committed', failed: 'rolled_back',
  released: 'released', expired: 'released', released_locally: 'released', self_released: 'released',
};
