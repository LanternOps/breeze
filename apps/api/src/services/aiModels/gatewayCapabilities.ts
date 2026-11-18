/**
 * W06 (#7604, Decision D4): what a gateway-kind offering (openai_compatible;
 * W07's cloud kinds) can do comes ONLY from a current verification. The
 * verification is stored on the offering (`partner_ai_models.capabilities`) as
 * a synthesized Models-API-shaped tree plus a `breeze_verification` record,
 * bound to the endpoint fingerprint and the fidelity-harness version.
 *
 * Missing, malformed, failed, stale-harness or other-endpoint records all
 * derive to UNVERIFIED capabilities (thinking unknown, no tools): W03's
 * `tools_unsupported` rule then keeps the offering off every tool surface, and
 * buildWireParams sends nothing. The RECORD decides tools and thinking; tree
 * leaves that claim more than the record are ignored, so an edited tree alone
 * grants nothing.
 *
 * #12177: the STATE tells "never verified" (`unverified`) apart from "a record
 * is there but fails the schema" (`invalid`), so the operator is told to verify
 * again instead of seeing a model that looks untouched. Both grant nothing. The
 * derivation is pure; the only side effect is a once-per-offering warning and
 * Sentry event for an `invalid` record, and only when the caller names the
 * offering.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { FIDELITY_HARNESS_VERSION } from '../llm/providerFidelityHarness';
import { captureException } from '../sentry';
import { deriveCapabilities, type DerivedCapabilities } from './capabilities';

export interface GatewayVerificationRecord {
  harnessVersion: string;
  endpointFingerprint: string;
  /** ISO timestamp of the verification run. */
  at: string;
  passed: boolean;
  toolUse: boolean;
  adaptiveEffort: boolean;
  /** Scrubbed, ≤ 200 chars. */
  summary: string | null;
}

export type GatewayVerificationState = 'unverified' | 'invalid' | 'verified' | 'failed' | 'stale';

const recordSchema = z.object({
  harnessVersion: z.string().min(1).max(20),
  endpointFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  at: z.string().datetime(),
  passed: z.boolean(),
  toolUse: z.boolean(),
  adaptiveEffort: z.boolean(),
  summary: z.string().max(200).nullable(),
}).strict();

const UNVERIFIED: DerivedCapabilities = Object.freeze({
  thinkingMode: 'unknown',
  effortLevels: [],
  supportsTools: false,
  supportsVision: false,
}) as DerivedCapabilities;

function unverified(): DerivedCapabilities {
  return { ...UNVERIFIED, effortLevels: [] };
}

/**
 * What a verification is bound to: the connection's ROUTING identity (kind +
 * base URL). Deliberately excludes the key and the name: a key rotation does
 * not change what the endpoint does; a URL change does. W07 adds its kinds'
 * routing fields from `providerConfig` (region / project+location / resource);
 * openai_compatible has none, so `providerConfig` is ignored for it.
 */
export function endpointFingerprint(conn: {
  kind: string;
  baseUrl: string | null;
  providerConfig: Record<string, unknown> | null;
}): string {
  const routing: Record<string, unknown> = { kind: conn.kind, baseUrl: conn.baseUrl ?? null };
  return createHash('sha256').update(JSON.stringify(routing)).digest('hex');
}

export function readVerification(raw: unknown): GatewayVerificationRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const parsed = recordSchema.safeParse((raw as { breeze_verification?: unknown }).breeze_verification);
  return parsed.success ? parsed.data : null;
}

type RecordRead =
  | { kind: 'absent' }
  | { kind: 'invalid'; issues: string[] }
  | { kind: 'ok'; record: GatewayVerificationRecord };

/** `path:code` per schema issue; never the value, the message or an unknown key's name. */
function issueSummary(issues: readonly { path: readonly PropertyKey[]; code: string }[]): string[] {
  return issues.map((i) => `${i.path.length > 0 ? i.path.map(String).join('.') : '(record)'}:${i.code}`);
}

/**
 * Like readVerification, but says WHY there is no record. A capabilities column
 * stored double-encoded (a JSON string that holds the tree) is `invalid`, not
 * absent: it is a record nobody can read. It is never parsed into a grant.
 */
function readRecord(raw: unknown): RecordRead {
  if (typeof raw === 'string') {
    let decoded: unknown;
    try { decoded = JSON.parse(raw); } catch { return { kind: 'absent' }; }
    return isObject(decoded) && Object.hasOwn(decoded, 'breeze_verification')
      ? { kind: 'invalid', issues: ['(capabilities):double_encoded'] }
      : { kind: 'absent' };
  }
  if (!isObject(raw) || !Object.hasOwn(raw, 'breeze_verification')) return { kind: 'absent' };
  const parsed = recordSchema.safeParse((raw as { breeze_verification?: unknown }).breeze_verification);
  return parsed.success ? { kind: 'ok', record: parsed.data } : { kind: 'invalid', issues: issueSummary(parsed.error.issues) };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Offerings already reported as invalid by this process. One report each: the
 * read runs on every snapshot and every candidate build. Bounded by clearing,
 * so a huge fleet re-reports at worst once per cap's worth of offerings.
 */
const reportedInvalid = new Set<string>();
const REPORTED_INVALID_CAP = 10_000;

function reportInvalid(offeringId: string, issues: string[]): void {
  if (reportedInvalid.has(offeringId)) return;
  if (reportedInvalid.size >= REPORTED_INVALID_CAP) reportedInvalid.clear();
  reportedInvalid.add(offeringId);
  const message = `offering ${offeringId}: breeze_verification record fails the schema (${issues.join(', ')}); shown as invalid, no tool capability until verified again`;
  console.warn(`[aiModels] ${message}`);
  captureException(
    new Error(message),
    undefined,
    { service: 'aiModels', stage: 'offering_verification_read' },
    { fingerprint: ['aiModels', 'offering_verification_invalid'] },
  );
}

const NO_THINKING = {
  thinking: { types: { adaptive: { supported: false }, enabled: { supported: false } } },
  effort: { supported: false },
};

/** Synthesized Models-API-shaped tree stored in partner_ai_models.capabilities. */
export function verifiedCapabilitiesTree(
  v: GatewayVerificationRecord,
  thinkingSource: unknown | null,
): Record<string, unknown> {
  const src = thinkingSource && typeof thinkingSource === 'object' ? (thinkingSource as Record<string, unknown>) : null;
  const thinkingPart = v.passed && v.adaptiveEffort && src?.thinking
    ? { thinking: src.thinking, effort: src.effort ?? { supported: false } }
    : NO_THINKING;
  return { ...thinkingPart, tool_use: { supported: v.passed && v.toolUse }, breeze_verification: { ...v } };
}

/**
 * `offeringId`: name the offering so an `invalid` record is logged and sent to
 * Sentry (once per offering per process). Every production caller passes it.
 */
export function verifiedGatewayCapabilities(raw: unknown, currentFingerprint: string, opts?: { offeringId?: string }): {
  capabilities: DerivedCapabilities;
  state: GatewayVerificationState;
  record: GatewayVerificationRecord | null;
} {
  const read = readRecord(raw);
  if (read.kind === 'absent') return { capabilities: unverified(), state: 'unverified', record: null };
  if (read.kind === 'invalid') {
    if (opts?.offeringId) reportInvalid(opts.offeringId, read.issues);
    return { capabilities: unverified(), state: 'invalid', record: null };
  }
  const { record } = read;
  if (record.harnessVersion !== FIDELITY_HARNESS_VERSION || record.endpointFingerprint !== currentFingerprint) {
    return { capabilities: unverified(), state: 'stale', record };
  }
  if (!record.passed) return { capabilities: unverified(), state: 'failed', record };

  const derived = deriveCapabilities(raw);
  const thinks = record.adaptiveEffort && (derived.thinkingMode === 'adaptive' || derived.thinkingMode === 'budget');
  return {
    capabilities: {
      thinkingMode: thinks ? derived.thinkingMode : 'none',
      effortLevels: thinks ? [...derived.effortLevels] : [],
      supportsTools: record.toolUse && derived.supportsTools,
      // The harness does not verify image input; never claimed for a gateway kind in v1.
      supportsVision: false,
    },
    state: 'verified',
    record,
  };
}
