import type { TopologyInterfaceMetricSeriesName, TopologyInterfaceSampleV1 } from '@breeze/shared';

/**
 * Counter-safe interface window math (M3 Task 5). Pure.
 *
 * A window is the span between two consecutive raw samples of ONE interface
 * generation from ONE source/producer epoch. Continuity is checked before any
 * arithmetic: a generation (epoch) change, source/producer change, device
 * restart (uptime rollback), counter discontinuity, width change, non-increasing
 * time or a gap beyond three cadences invalidates the whole window — no rate is
 * ever produced across them. Counters are subtracted as BigInt before any
 * conversion, so uint64 values never lose precision.
 *
 * 64-bit counters that decrease invalidate that direction. A 32-bit decrease is
 * accepted only as exactly one feasible wrap under the capacity bound; with
 * unknown capacity, or when more than one wrap would fit, the direction is
 * `ambiguous_wrap` even if the counter increased. Speed changes invalidate
 * utilization only. Values above capacity are flagged, never clamped.
 */
export type InterfaceRateSample = Pick<TopologyInterfaceSampleV1,
  'interfaceId' | 'interfaceEpoch' | 'sampledAt' | 'counterWidth' | 'inOctets' | 'outOctets' | 'inErrors' | 'outErrors' | 'inDiscards' | 'outDiscards'
  | 'inPackets' | 'outPackets' | 'capacityBps' | 'discontinuityTicks' | 'deviceUptimeTicks' | 'adminStatus' | 'operStatus'> & {
  sourceId: string; producerEpoch: string; expectedIntervalSeconds: number;
};

export type InterfaceWindowInvalidReason =
  | 'first_sample' | 'non_increasing_time' | 'interface_generation_changed' | 'source_changed' | 'device_restarted'
  | 'counter_discontinuity' | 'gap' | 'counter_width_changed';

export type InterfaceWindow = {
  interfaceId: string; interfaceEpoch: string; sourceId: string; producerEpoch: string;
  from: Date; to: Date; elapsedMs: number;
  /** Elapsed time when the window is continuous, else 0. Per-series validity is the series value being non-null. */
  validDurationMs: number;
  inBps: number | null; outBps: number | null;
  inUtilizationPct: number | null; outUtilizationPct: number | null;
  inErrorsPerSecond: number | null; outErrorsPerSecond: number | null;
  inDiscardsPerSecond: number | null; outDiscardsPerSecond: number | null;
  /** Window-level continuity failures; any entry nulls every series. */
  invalid: InterfaceWindowInvalidReason[];
  /** Why a series is null. */
  reasons: Partial<Record<TopologyInterfaceMetricSeriesName, string>>;
  /** Plausibility flags on otherwise-valid values (e.g. above capacity). */
  anomalies: string[];
};

export const INTERFACE_WINDOW_MAX_GAP_CADENCES = 3;
const SERIES_FIELDS = {
  in_bps: 'inBps', out_bps: 'outBps', in_utilization_pct: 'inUtilizationPct', out_utilization_pct: 'outUtilizationPct',
  in_errors_per_second: 'inErrorsPerSecond', out_errors_per_second: 'outErrorsPerSecond',
  in_discards_per_second: 'inDiscardsPerSecond', out_discards_per_second: 'outDiscardsPerSecond',
} as const satisfies Record<TopologyInterfaceMetricSeriesName, keyof InterfaceWindow>;
export const INTERFACE_WINDOW_SERIES_FIELDS = SERIES_FIELDS;

const big = (value: string | null | undefined) => (typeof value === 'string' ? BigInt(value) : null);

type Delta = { delta: bigint } | { reason: string };
/** Octet/packet counter delta with width and wrap rules. */
function octetDelta(prev: string | null, curr: string | null, width: 32 | 64 | null, capacityBps: bigint | null, elapsedMs: bigint): Delta {
  const a = big(prev), b = big(curr);
  if (a === null || b === null || width === null) return { reason: 'not_reported' };
  if (width === 64) return b >= a ? { delta: b - a } : { reason: 'counter_decreased' };
  const modulus = 1n << 32n;
  if (capacityBps === null || capacityBps <= 0n) return { reason: 'ambiguous_wrap' };
  const delta = b >= a ? b - a : modulus - a + b;
  const maxDelta = capacityBps * elapsedMs / 8000n;
  return delta <= maxDelta && delta + modulus > maxDelta ? { delta } : { reason: 'ambiguous_wrap' };
}
/** Counter32 error/discard delta: a decrease is unknowable, never a negative count. */
function eventDelta(prev: string | null, curr: string | null): Delta {
  const a = big(prev), b = big(curr);
  if (a === null || b === null) return { reason: 'not_reported' };
  return b >= a ? { delta: b - a } : { reason: 'counter_decreased' };
}

export function calculateInterfaceWindow(previous: InterfaceRateSample | null, current: InterfaceRateSample): InterfaceWindow {
  const to = new Date(current.sampledAt);
  const from = previous ? new Date(previous.sampledAt) : to;
  const elapsedMs = to.getTime() - from.getTime();
  const window: InterfaceWindow = {
    interfaceId: current.interfaceId, interfaceEpoch: current.interfaceEpoch, sourceId: current.sourceId, producerEpoch: current.producerEpoch,
    from, to, elapsedMs: Math.max(0, elapsedMs), validDurationMs: 0,
    inBps: null, outBps: null, inUtilizationPct: null, outUtilizationPct: null,
    inErrorsPerSecond: null, outErrorsPerSecond: null, inDiscardsPerSecond: null, outDiscardsPerSecond: null,
    invalid: [], reasons: {}, anomalies: [],
  };
  const invalid = (reason: InterfaceWindowInvalidReason) => { if (!window.invalid.includes(reason)) window.invalid.push(reason); };
  if (!previous) invalid('first_sample');
  else {
    if (previous.interfaceId !== current.interfaceId || previous.interfaceEpoch !== current.interfaceEpoch) invalid('interface_generation_changed');
    if (previous.sourceId !== current.sourceId || previous.producerEpoch !== current.producerEpoch) invalid('source_changed');
    if (elapsedMs <= 0) invalid('non_increasing_time');
    if (elapsedMs > INTERFACE_WINDOW_MAX_GAP_CADENCES * current.expectedIntervalSeconds * 1000) invalid('gap');
    const upA = big(previous.deviceUptimeTicks), upB = big(current.deviceUptimeTicks);
    if (upA !== null && upB !== null && upB < upA) invalid('device_restarted');
    if ((previous.discontinuityTicks ?? null) !== (current.discontinuityTicks ?? null)) invalid('counter_discontinuity');
    if (previous.counterWidth !== current.counterWidth) invalid('counter_width_changed');
  }
  if (window.invalid.length || !previous) {
    for (const series of Object.keys(SERIES_FIELDS) as TopologyInterfaceMetricSeriesName[]) window.reasons[series] = window.invalid[0]!;
    return window;
  }

  window.validDurationMs = elapsedMs;
  const elapsed = BigInt(elapsedMs);
  const prevCapacity = big(previous.capacityBps), capacity = big(current.capacityBps);
  const capacityStable = prevCapacity !== null && capacity !== null && prevCapacity === capacity && capacity > 0n;
  // The wrap bound uses the larger reported capacity so a speed change cannot hide a second wrap.
  const bound = prevCapacity !== null && capacity !== null ? (prevCapacity > capacity ? prevCapacity : capacity) : null;
  const width = current.counterWidth;

  const direction = (dir: 'in' | 'out') => {
    const bps = `${dir}_bps` as const, util = `${dir}_utilization_pct` as const;
    const result = octetDelta(previous[`${dir}Octets`], current[`${dir}Octets`], width, bound, elapsed);
    if ('reason' in result) { window.reasons[bps] = result.reason; window.reasons[util] = result.reason; return; }
    const rate = Number(result.delta * 8000n) / elapsedMs;
    window[SERIES_FIELDS[bps]] = rate;
    if (capacity !== null && capacity > 0n && rate > Number(capacity)) window.anomalies.push(`${dir}_exceeds_capacity`);
    if (!capacityStable) { window.reasons[util] = prevCapacity !== null && capacity !== null && prevCapacity !== capacity ? 'capacity_changed' : 'capacity_unknown'; return; }
    window[SERIES_FIELDS[util]] = rate / Number(capacity) * 100;
  };
  direction('in');
  direction('out');

  const events = (series: 'in_errors_per_second' | 'out_errors_per_second' | 'in_discards_per_second' | 'out_discards_per_second',
    field: 'inErrors' | 'outErrors' | 'inDiscards' | 'outDiscards') => {
    const result = eventDelta(previous[field], current[field]);
    if ('reason' in result) { window.reasons[series] = result.reason; return; }
    window[SERIES_FIELDS[series]] = Number(result.delta * 1000n) / elapsedMs;
  };
  events('in_errors_per_second', 'inErrors');
  events('out_errors_per_second', 'outErrors');
  events('in_discards_per_second', 'inDiscards');
  events('out_discards_per_second', 'outDiscards');
  return window;
}
