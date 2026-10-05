/**
 * W06 (#7604, Decision D4): what a gateway-kind offering (openai_compatible;
 * W07's cloud kinds) can do comes ONLY from a current verification. The
 * verification is stored on the offering (`partner_ai_models.capabilities`) as
 * a synthesized Models-API-shaped tree plus a `breeze_verification` record,
 * bound to the endpoint fingerprint and the fidelity-harness version.
 *
 * Missing, malformed, failed, stale-harness or other-endpoint records all
 * derive to UNVERIFIED (thinking unknown, no tools): W03's `tools_unsupported`
 * rule then keeps the offering off every tool surface, and buildWireParams
 * sends nothing. The RECORD decides tools and thinking; tree leaves that claim
 * more than the record are ignored, so an edited tree alone grants nothing.
 * Pure; no I/O.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { FIDELITY_HARNESS_VERSION } from '../llm/providerFidelityHarness';
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

export type GatewayVerificationState = 'unverified' | 'verified' | 'failed' | 'stale';

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

export function verifiedGatewayCapabilities(raw: unknown, currentFingerprint: string): {
  capabilities: DerivedCapabilities;
  state: GatewayVerificationState;
  record: GatewayVerificationRecord | null;
} {
  const record = readVerification(raw);
  if (!record) return { capabilities: unverified(), state: 'unverified', record: null };
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
