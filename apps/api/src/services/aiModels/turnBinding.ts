/**
 * What a turn was dispatched with (spec §9.2). Persisted on the budget
 * reservation in the SAME transaction as the turn claim (W03 Task 6), compared
 * for live-query reuse (Task 7), and the only source of the rate a settlement
 * may bill. Carries no key material: only connection identity and versions.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AI_SURFACES,
  GATEWAY_CONNECTION_KINDS,
  PROMPT_PROFILES,
  offeringOptionsSchema,
  type AiSurface,
  type GatewayConnectionKind,
  type OfferingOptions,
  type PromptProfile,
} from '@breeze/shared';
import type { AiBillingSource } from '../aiCostTracker';
import type { ThinkingMode } from './capabilities';
import { FAILOVER_CAUSES, MAX_FAILOVER_HOP, type FailoverCause } from './failover';
import type { RateSnapshot } from './pricing';
import type { ResolvedModel } from './resolveModel';
import type { WireParams } from './wireParams';

/** W05: at most this many earlier models' rates ride on one binding. */
export const MAX_CARRIED_RATES = 8;

/** The rate of a model this session ran on before a same-connection switch (W05). */
export interface CarriedRate { wireModel: string; rateSnapshot: RateSnapshot }

export interface TurnBinding {
  v: 1;
  surface: AiSurface;
  role: string;
  partnerId: string | null;
  offeringId: string | null;
  connectionId: string | null;
  connectionKind: 'platform' | 'anthropic_byok' | 'catalog' | GatewayConnectionKind;
  configVersion: number | null;
  catalogRevisionId: string | null;
  funding: AiBillingSource;
  logicalModel: string;
  wireModel: string;
  options: OfferingOptions;
  thinkingMode: ThinkingMode;
  inferenceGeo: string | null;
  wireFingerprint: string;
  rateSnapshot: RateSnapshot;
  refusalFallback: { offeringId: string; wireModel: string; rateSnapshot: RateSnapshot } | null;
  /**
   * W05: rates of the models a same-connection switch moved away from. A
   * resumed query's cumulative modelUsage can still report late deltas under
   * their keys (interrupted turns under-count, spike Q6). Absent on bindings
   * that never switched.
   */
  carriedRates?: CarriedRate[];
  /**
   * W11 (#7609): the model's prompt profile at resolve time. The ledger
   * records it on every row of every surface. Optional (`v` stays 1): a
   * binding persisted before W11 parses without it. Deliberately NOT part of
   * liveQueryKey: a profile change (the emergency Generic switch) applies to
   * the next new live query instead of rotating an idle one.
   */
  promptProfile?: PromptProfile;
  /**
   * W09 (#7607): set when a failover hop serves this turn (ledger provenance;
   * D6 session stamping). Absent — never `null` — on a binding with no
   * failover, so it stays byte-identical to a W03/W05 binding for the
   * stable-key re-bind comparison; absent on bindings stored before W09.
   */
  failover?: TurnBindingFailover;
}

export interface TurnBindingFailover { fromOfferingId: string | null; hop: number; cause: FailoverCause }

/** Key-order-independent JSON, for fingerprints and rate comparisons. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort()
      .filter((k) => record[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Everything the SDK subprocess / request body is built from, minus the price. */
function wireFingerprint(w: WireParams, fallbackWireModel: string | null): string {
  const { applied: _applied, ...wire } = w;
  return createHash('sha256').update(stableJson({ wire, fallbackWireModel })).digest('hex').slice(0, 24);
}

export function turnBindingFrom(r: ResolvedModel): TurnBinding {
  return {
    v: 1,
    surface: r.surface,
    role: r.role,
    partnerId: r.partnerId,
    offeringId: r.offering.id,
    connectionId: r.connection.id,
    connectionKind: r.connection.kind,
    configVersion: r.configVersion ?? null,
    catalogRevisionId: r.catalogRevisionId ?? null,
    funding: r.funding,
    logicalModel: r.logicalModel,
    wireModel: r.wireModel,
    options: r.options,
    thinkingMode: r.thinking,
    inferenceGeo: r.inferenceGeo,
    wireFingerprint: wireFingerprint(r.wireParams, r.refusalFallback?.wireModel ?? null),
    rateSnapshot: r.rateSnapshot,
    refusalFallback: r.refusalFallback
      ? {
          offeringId: r.refusalFallback.offeringId,
          wireModel: r.refusalFallback.wireModel,
          rateSnapshot: r.refusalFallback.rateSnapshot,
        }
      : null,
    promptProfile: r.promptProfile,
    ...(r.failover
      ? { failover: { fromOfferingId: r.failover.fromOfferingId, hop: r.failover.hop, cause: r.failover.cause } }
      : {}),
  };
}

/**
 * Spec §9.2: reuse a live SDK query only if connection id, config_version,
 * catalog revision and wire model are unchanged. The wire fingerprint is
 * stricter by design: effort/thinking/speed/geo/fallbackModel are fixed when
 * the SDK query is created, so a changed one must also recreate it. The price
 * is deliberately absent: a rate change re-binds settlement, not the query.
 */
export function liveQueryKey(b: TurnBinding): string {
  return [
    b.connectionId ?? 'platform',
    b.configVersion ?? '-',
    b.catalogRevisionId ?? '-',
    b.wireModel,
    b.wireFingerprint,
  ].join('|');
}

const ratesSchema = z.object({
  inputCentsPerM: z.number().nonnegative(),
  outputCentsPerM: z.number().nonnegative(),
  cacheReadCentsPerM: z.number().nonnegative(),
  cacheWriteCentsPerM: z.number().nonnegative(),
});
const rateSnapshotSchema = z.object({
  source: z.enum(['platform', 'offering', 'catalog', 'linked_platform']),
  standard: ratesSchema,
  option: z.object({ key: z.literal('speed:fast'), rates: ratesSchema }).optional(),
});
const turnBindingSchema = z.object({
  v: z.literal(1),
  surface: z.enum(AI_SURFACES),
  role: z.string().min(1),
  partnerId: z.string().nullable(),
  offeringId: z.string().nullable(),
  connectionId: z.string().nullable(),
  connectionKind: z.enum(['platform', 'anthropic_byok', 'catalog', ...GATEWAY_CONNECTION_KINDS]),
  configVersion: z.number().int().nullable(),
  catalogRevisionId: z.string().nullable(),
  funding: z.enum(['platform', 'partner_key']),
  logicalModel: z.string().min(1),
  wireModel: z.string().min(1),
  options: offeringOptionsSchema,
  thinkingMode: z.enum(['adaptive', 'budget', 'none', 'unknown']),
  inferenceGeo: z.string().nullable(),
  wireFingerprint: z.string().min(1),
  rateSnapshot: rateSnapshotSchema,
  refusalFallback: z.object({
    offeringId: z.string(), wireModel: z.string(), rateSnapshot: rateSnapshotSchema,
  }).nullable(),
  carriedRates: z.array(z.object({ wireModel: z.string().min(1), rateSnapshot: rateSnapshotSchema }))
    .max(MAX_CARRIED_RATES).optional(),
  // W11: must round-trip, or aiBudgetReservations' stored-vs-new binding
  // comparison would see every stable-key retry as a re-bind.
  promptProfile: z.enum(PROMPT_PROFILES).optional(),
  // W09: mirrors ai_invocations_failover_chk (hop 1..6 with a known cause).
  failover: z.object({
    fromOfferingId: z.string().nullable(),
    hop: z.number().int().min(1).max(MAX_FAILOVER_HOP),
    cause: z.enum(FAILOVER_CAUSES),
  }).optional(),
});

export function parseTurnBinding(raw: unknown): TurnBinding | null {
  const parsed = turnBindingSchema.safeParse(raw);
  return parsed.success ? (parsed.data as TurnBinding) : null;
}

/**
 * W05: the binding plus the rates of the models this session switched away
 * from on the same connection. Never carries the bound model or its refusal
 * fallback (they have their own snapshots), keeps the LATEST rate per model,
 * keeps at most MAX_CARRIED_RATES (the most recent), and returns the binding
 * unchanged rather than emit `carriedRates: []` — so a binding that carries
 * nothing stays byte-identical to W03's for the stable-key re-bind comparison.
 */
export function withCarriedRates(b: TurnBinding, carried: readonly CarriedRate[]): TurnBinding {
  const byModel = new Map<string, CarriedRate>();
  for (const c of carried) {
    if (c.wireModel === b.wireModel || c.wireModel === b.refusalFallback?.wireModel) continue;
    byModel.delete(c.wireModel);   // re-insert so the latest occurrence is last
    byModel.set(c.wireModel, c);
  }
  const list = [...byModel.values()].slice(-MAX_CARRIED_RATES);
  return list.length > 0 ? { ...b, carriedRates: list } : b;
}

export function rateForServedModel(b: TurnBinding, servedWireModel: string): RateSnapshot {
  if (servedWireModel === b.wireModel) return b.rateSnapshot;
  if (b.refusalFallback && servedWireModel === b.refusalFallback.wireModel) return b.refusalFallback.rateSnapshot;
  const carried = b.carriedRates?.find((c) => c.wireModel === servedWireModel);
  if (carried) return carried.rateSnapshot;
  // The SDK reported a model we did not bind (an internal helper call). Price
  // it at the primary rate — same connection, same funding, never a guess —
  // and make the mismatch visible.
  console.warn('[turnBinding] served model not in the binding; priced at the primary rate', {
    bound: b.wireModel, served: servedWireModel,
  });
  return b.rateSnapshot;
}
