import { and, desc, eq } from 'drizzle-orm';
import { Counter, type Registry } from 'prom-client';
import { db, withSystemDbAccessContext } from '../db';
import { devices, deviceMtlsCertificates, type DeviceMtlsCertificateState } from '../db/schema';
import { trustsForwardedHeadersFrom } from './clientIp';
import type { RequestLike } from './auditEvents';

/**
 * Security remediation Wave 5, Task 6 — the SINGLE shared certificate/device
 * binding decision used by BOTH the agent REST auth middleware
 * (middleware/agentAuth.ts) and the command WebSocket pre-upgrade gate
 * (routes/agentWs.ts). Spec:
 * .superpowers/sdd/2026-07-23-security-remediation-wave-05-mtls-transport/task-6-brief.md
 *
 * Replaces the TEMPORARY local helpers Task 4 left in routes/agents/mtls.ts
 * (getMtlsBindingMode / readClientCertAssertion) — those existed only so
 * Task 4 could land the renewal-specific proof gate ahead of this task; the
 * renewal-authorization logic in mtls.ts has its OWN semantics
 * (proof-of-possession based) and is deliberately NOT absorbed here — it now
 * reads the mode via `getAgentMtlsBindingMode` below instead of its own copy.
 */

export type AgentMtlsBindingMode = 'off' | 'audit' | 'enforce';

export type AgentCertificateBindingReason =
  | 'matched'
  | 'mode_off'
  | 'untrusted_assertion'
  | 'missing_assertion'
  | 'legacy_identity'
  | 'serial_mismatch'
  | 'certificate_not_active';

export type AgentCertificateBindingDecision = {
  allowed: boolean;
  reason: AgentCertificateBindingReason;
};

/**
 * Reads the compatibility mode for agent certificate binding. Defaults to
 * `off` on ANY absent or invalid value — deliberately fail-open at the
 * config layer (config/validate.ts separately boot-refuses an INVALID value
 * so a typo is caught at startup; this accessor's own fallback exists only
 * for callers that run before/without config validation, e.g. tests).
 */
export function getAgentMtlsBindingMode(): AgentMtlsBindingMode {
  const raw = (process.env.AGENT_MTLS_BINDING_MODE ?? '').trim().toLowerCase();
  return raw === 'audit' || raw === 'enforce' ? raw : 'off';
}

/**
 * The pure certificate/device binding decision. No I/O, no logging — every
 * input is a plain value so REST and WS can call the EXACT same function and
 * are structurally guaranteed to produce the same reason for the same
 * inputs.
 *
 * Trust-gating happens HERE, not just at the header-reading layer: a caller
 * that (incorrectly) forwarded a raw, untrusted header claim through
 * `assertedVerified`/`assertedSerial` still cannot pass verification, because
 * this function independently requires `assertionTrusted` before ever
 * consulting those fields. This is what makes "a verified claim from an
 * untrusted source" (a spoofed header) distinguishable from "no assertion
 * presented" while remaining defense-in-depth against a reader bug.
 *
 * Serial comparison is a direct string equality. Both sides are normalized
 * (uppercase hex, no separators) at their respective READ boundaries before
 * ever reaching this function — `assertedSerial` by
 * `readAgentCertificateAssertion` below, `storedSerial` by
 * `loadAgentCertificateBindingIdentity` — via the shared
 * `normalizeCertificateSerial` helper, so this comparison never has to trust
 * an assumption about either source's on-the-wire or on-disk format.
 */
export function checkAgentCertificateBinding(input: {
  mode: AgentMtlsBindingMode;
  assertionTrusted: boolean;
  assertedVerified: boolean;
  assertedSerial: string | null;
  storedSerial: string | null;
  storedState: DeviceMtlsCertificateState | null;
}): AgentCertificateBindingDecision {
  const { mode, assertionTrusted, assertedVerified, assertedSerial, storedSerial, storedState } = input;

  if (mode === 'off') {
    return { allowed: true, reason: 'mode_off' };
  }

  // No certificate identity of ANY kind is on file for this device — a
  // legacy (pre-mTLS-migration) device, or one that has never been issued a
  // certificate. This is the ONLY unconditional free pass in enforce mode,
  // and is deliberately distinct from `certificate_not_active` below: this
  // case has no history to distrust, while that one does.
  if (storedState === null) {
    return { allowed: true, reason: 'legacy_identity' };
  }

  // The device HAS certificate history, but the current row is not the
  // active identity (e.g. revoked, or a stalled rotation) — a known
  // lifecycle gap, not a legacy absence. Fail closed in enforce; audit only
  // observes.
  if (storedState !== 'active') {
    return { allowed: mode === 'audit', reason: 'certificate_not_active' };
  }

  // From here the device has an ACTIVE stored certificate — enforce requires
  // a verified, trusted, matching assertion.
  if (!assertionTrusted) {
    // A verified claim from an untrusted source is a spoof attempt, not an
    // absent assertion — kept as a distinct reason so it can be alerted on
    // separately from an agent that simply presented nothing.
    const reason = assertedVerified ? 'untrusted_assertion' : 'missing_assertion';
    return { allowed: mode === 'audit', reason };
  }

  if (!assertedVerified) {
    return { allowed: mode === 'audit', reason: 'missing_assertion' };
  }

  if (!assertedSerial || assertedSerial !== storedSerial) {
    return { allowed: mode === 'audit', reason: 'serial_mismatch' };
  }

  return { allowed: true, reason: 'matched' };
}

export interface AgentCertificateAssertion {
  /** True only when the request's immediate TCP peer is a configured trusted proxy (trustsForwardedHeadersFrom). */
  assertionTrusted: boolean;
  /**
   * The RAW header claim: true only if `X-Breeze-Client-Cert-Verified` said
   * true/1 AND a serial header was present. Deliberately NOT gated on
   * `assertionTrusted` — trust-gating is `checkAgentCertificateBinding`'s
   * job, so a caller that passes this straight through still can't be
   * fooled by an untrusted source.
   */
  assertedVerified: boolean;
  /** Uppercase hex, no separators. Present whenever assertedVerified is true, regardless of trust. */
  assertedSerial: string | null;
}

const CLIENT_CERT_VERIFIED_HEADER = 'X-Breeze-Client-Cert-Verified';
const CLIENT_CERT_SERIAL_HEADER = 'X-Breeze-Client-Cert-Serial';

/**
 * The ONE canonical certificate-serial normalization used everywhere a
 * serial crosses a trust boundary in this module: strips every non-hex
 * character (colons, spaces, dashes) and uppercases the rest. Reused by
 * `readAgentCertificateAssertion` (header side) and
 * `loadAgentCertificateBindingIdentity` (stored side) — never copy this
 * regex a second time; import this helper instead. Also exported for
 * callers writing a certificate serial to storage (e.g.
 * routes/agents/mtls.ts's legacy `devices.mtls_cert_serial_number` write),
 * so new rows are stored in the same canonical form this module reads back.
 */
export function normalizeCertificateSerial(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const normalized = raw.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Reads ONLY the two protected internal certificate-assertion headers set by
 * the trusted edge/proxy layer — never raw Cloudflare or other user-supplied
 * headers. `assertionTrusted` is derived exclusively from
 * `trustsForwardedHeadersFrom(c)`.
 */
export function readAgentCertificateAssertion(c: RequestLike): AgentCertificateAssertion {
  const assertionTrusted = trustsForwardedHeadersFrom(c);
  const verifiedHeader = c.req.header(CLIENT_CERT_VERIFIED_HEADER);
  const serialHeader = c.req.header(CLIENT_CERT_SERIAL_HEADER);
  const normalizedSerial = normalizeCertificateSerial(serialHeader);
  const assertedVerified = (verifiedHeader === 'true' || verifiedHeader === '1') && Boolean(normalizedSerial);
  return {
    assertionTrusted,
    assertedVerified,
    assertedSerial: assertedVerified ? normalizedSerial : null,
  };
}

export interface AgentCertificateBindingIdentity {
  storedSerial: string | null;
  storedState: DeviceMtlsCertificateState | null;
}

/**
 * Loads the device's certificate identity for the binding decision: prefers
 * the current `active` device_mtls_certificates row; falls back to the most
 * recently created row for the device (any state) so a revoked/stalled
 * identity is reported as `certificate_not_active` rather than silently
 * treated as legacy; finally falls back to the legacy
 * `devices.mtls_cert_serial_number` column (pre-history-table certificates)
 * treated as an active identity. Reports a fully NULL identity only when
 * none of the three sources has anything on file.
 *
 * Normalizes `storedSerial` (via `normalizeCertificateSerial`) at THIS read
 * boundary, from every source, before returning it — never assumed already
 * canonical. Two populations store a non-canonical value: rows written by
 * the legacy (pre-protocol-v2) renewal path in routes/agents/mtls.ts, which
 * historically wrote Cloudflare's raw `serial_number` string into the
 * legacy `devices.mtls_cert_serial_number` column (format not guaranteed —
 * fixed at the write site too, but old rows predate that fix), and rows
 * Task 1's migration imported verbatim from that same historical column.
 *
 * Runs in a system DB context: `device_mtls_certificates` is FORCE-RLS and
 * this must resolve correctly regardless of the caller's request-scoped
 * tenant context (agentAuthMiddleware may not have entered one yet; the WS
 * pre-upgrade path never has one).
 *
 * SECURITY: `deviceId` must always come from the ALREADY-authenticated
 * agent/device row (the bearer token match), never from client-controlled
 * input — this is what makes it impossible for a bearer token to select a
 * different device's certificate identity.
 */
export async function loadAgentCertificateBindingIdentity(
  deviceId: string,
): Promise<AgentCertificateBindingIdentity> {
  return withSystemDbAccessContext(async () => {
    const [active] = await db
      .select({ serialNumber: deviceMtlsCertificates.serialNumber, state: deviceMtlsCertificates.state })
      .from(deviceMtlsCertificates)
      .where(and(eq(deviceMtlsCertificates.deviceId, deviceId), eq(deviceMtlsCertificates.state, 'active')))
      .limit(1);
    if (active) {
      return { storedSerial: normalizeCertificateSerial(active.serialNumber), storedState: 'active' };
    }

    const [latest] = await db
      .select({ serialNumber: deviceMtlsCertificates.serialNumber, state: deviceMtlsCertificates.state })
      .from(deviceMtlsCertificates)
      .where(eq(deviceMtlsCertificates.deviceId, deviceId))
      .orderBy(desc(deviceMtlsCertificates.createdAt))
      .limit(1);
    if (latest) {
      return { storedSerial: normalizeCertificateSerial(latest.serialNumber), storedState: latest.state };
    }

    const [deviceRow] = await db
      .select({ legacySerial: devices.mtlsCertSerialNumber })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);
    if (deviceRow?.legacySerial) {
      return { storedSerial: normalizeCertificateSerial(deviceRow.legacySerial), storedState: 'active' };
    }

    return { storedSerial: null, storedState: null };
  });
}

export type AgentCertificateBindingPathClass = 'rest' | 'ws';

interface AgentCertificateBindingMetricsRecorder {
  onDecision: (
    mode: AgentMtlsBindingMode,
    reason: AgentCertificateBindingReason,
    pathClass: AgentCertificateBindingPathClass,
  ) => void;
}

const noop = () => {};
let recorder: AgentCertificateBindingMetricsRecorder = { onDecision: noop };

export function setAgentCertificateBindingMetricsRecorder(
  next: Partial<AgentCertificateBindingMetricsRecorder> | null | undefined,
): void {
  recorder = { onDecision: next?.onDecision ?? noop };
}

/**
 * Records ONLY bounded, non-identifying dimensions (mode, reason,
 * path class) — never serials, assertion contents, device/org ids, or any
 * other high-cardinality/sensitive value.
 */
export function recordAgentCertificateBindingMetric(
  mode: AgentMtlsBindingMode,
  reason: AgentCertificateBindingReason,
  pathClass: AgentCertificateBindingPathClass,
): void {
  recorder.onDecision(mode, reason, pathClass);
}

const PROMETHEUS_COUNTER_NAME = 'breeze_agent_certificate_binding_total';

/**
 * Registers (or reuses, if already registered on this Registry) the
 * `breeze_agent_certificate_binding_total{mode,reason,path_class}` counter
 * and wires the module-level recorder to increment it. Mirrors
 * services/actionIntents/metrics.ts's registration pattern.
 */
export function registerAgentCertificateBindingPrometheusCounter(
  registry: Registry,
): Counter<'mode' | 'reason' | 'path_class'> {
  const existing = registry.getSingleMetric(PROMETHEUS_COUNTER_NAME);
  const counter =
    (existing as Counter<'mode' | 'reason' | 'path_class'> | undefined) ??
    new Counter({
      name: PROMETHEUS_COUNTER_NAME,
      help: 'Agent certificate/device binding decisions, by mode, reason, and path class (rest|ws). Never carries serials or identifiers.',
      labelNames: ['mode', 'reason', 'path_class'] as const,
      registers: [registry],
    });
  setAgentCertificateBindingMetricsRecorder({
    onDecision: (mode, reason, pathClass) => counter.labels(mode, reason, pathClass).inc(),
  });
  return counter;
}

/**
 * The single entry point BOTH agentAuthMiddleware and
 * routes/agentWs.ts's validateAgentToken call: resolves the mode, loads the
 * device's certificate identity (skipped entirely in `off` — the default —
 * so the common case costs no extra DB round trip), evaluates the pure
 * decision, and records the bounded metric. REST and WS pass identical
 * `assertion`/`deviceId` shapes through this same function, so they are
 * structurally guaranteed to agree.
 */
export async function enforceAgentCertificateBinding(input: {
  deviceId: string;
  assertion: AgentCertificateAssertion;
  pathClass: AgentCertificateBindingPathClass;
}): Promise<AgentCertificateBindingDecision> {
  const mode = getAgentMtlsBindingMode();
  if (mode === 'off') {
    return { allowed: true, reason: 'mode_off' };
  }

  const identity = await loadAgentCertificateBindingIdentity(input.deviceId);
  const decision = checkAgentCertificateBinding({
    mode,
    assertionTrusted: input.assertion.assertionTrusted,
    assertedVerified: input.assertion.assertedVerified,
    assertedSerial: input.assertion.assertedSerial,
    storedSerial: identity.storedSerial,
    storedState: identity.storedState,
  });
  recordAgentCertificateBindingMetric(mode, decision.reason, input.pathClass);
  return decision;
}
