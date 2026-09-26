import './topologyZod';
import { z } from 'zod';
import { collectionOutcomeSchema, freshnessSchema, graphRelationshipSchema, healthCoverageSchema, healthStatusSchema, topologyRevisionSchema } from './topology';
import {
  topologyPortSchema, topologyReasonSchema, topologySequenceSchema, topologyTimestampSchema, topologyUtf8KeySchema, topologyWireGuard,
} from './topologyPrimitives';

/**
 * Interface measurement transport (M3 Task 1, amendment M3-D1).
 *
 * `if_metrics` is a TELEMETRY family, not a structural source family: a batch
 * never creates collection runs, nodes, relationships or interfaces. Scope
 * (org/site) and source identity are derived server-side from the stored
 * producer authority; the wire never carries them. Counters are unsigned
 * decimal strings (`topologySequenceSchema`, uint64) so no JS-number rounding
 * can occur; a value the device did not report is `null` with a reason, never 0.
 */
export const TOPOLOGY_TELEMETRY_FAMILIES = ['if_metrics'] as const;
export const TOPOLOGY_INTERFACE_METRICS_SCHEMA_VERSION = 1;
export const TOPOLOGY_INTERFACE_METRICS_MAX_SAMPLES = 256;
export const TOPOLOGY_INTERFACE_METRICS_MAX_BYTES = 512 * 1024;
export const TOPOLOGY_INTERFACE_METRICS_INTERVAL_SECONDS = { min: 30, max: 300, default: 60 } as const;
export const TOPOLOGY_INTERFACE_ADMIN_STATUSES = ['up', 'down', 'testing', 'unknown'] as const;
export const TOPOLOGY_INTERFACE_OPER_STATUSES = ['up', 'down', 'testing', 'unknown', 'dormant', 'not_present', 'lower_layer_down'] as const;
/** Octet/packet counters: IF-MIB HC (64-bit) or legacy (32-bit), per `counterWidth`. */
export const TOPOLOGY_INTERFACE_WIDE_COUNTER_FIELDS = ['inOctets', 'outOctets', 'inPackets', 'outPackets'] as const;
/** Error/discard counters: IF-MIB Counter32 only (no HC variant exists). */
export const TOPOLOGY_INTERFACE_COUNTER32_FIELDS = ['inErrors', 'outErrors', 'inDiscards', 'outDiscards'] as const;
export const TOPOLOGY_INTERFACE_COUNTER_FIELDS = [...TOPOLOGY_INTERFACE_WIDE_COUNTER_FIELDS, ...TOPOLOGY_INTERFACE_COUNTER32_FIELDS] as const;
/** TimeTicks (uint32, hundredths of a second). */
export const TOPOLOGY_INTERFACE_TICK_FIELDS = ['discontinuityTicks', 'deviceUptimeTicks'] as const;
export const TOPOLOGY_INTERFACE_RATE_FIELDS = ['reportedInBps', 'reportedOutBps'] as const;
/** Every optional measurement. Absent or null means "not measured" and carries a reason. */
export const TOPOLOGY_INTERFACE_MEASURED_FIELDS = [
  ...TOPOLOGY_INTERFACE_COUNTER_FIELDS, 'capacityBps', ...TOPOLOGY_INTERFACE_TICK_FIELDS, ...TOPOLOGY_INTERFACE_RATE_FIELDS,
] as const;
export type TopologyInterfaceMeasuredField = typeof TOPOLOGY_INTERFACE_MEASURED_FIELDS[number];
/** Reason recorded when a supported field was simply absent from the upload. */
export const TOPOLOGY_INTERFACE_NOT_REPORTED = 'not_reported';

const UINT32_MAX = 4294967295n;
const key = topologyUtf8KeySchema;
const time = topologyTimestampSchema;
const counter = topologySequenceSchema.nullable();
// Source-reported rates are JSON numbers by nature (bits/second); they are
// never cumulative counters and never feed octet fields.
const rate = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const unavailableShape = Object.fromEntries(TOPOLOGY_INTERFACE_MEASURED_FIELDS.map(field => [field, topologyReasonSchema.optional()])) as
  Record<TopologyInterfaceMeasuredField, z.ZodOptional<typeof topologyReasonSchema>>;

/** Absent measured fields parse as null with the `not_reported` reason. */
function fillAbsentMeasurements(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const sample = { ...(value as Record<string, unknown>) };
  const rawUnavailable = sample.unavailable;
  if (rawUnavailable !== undefined && (!rawUnavailable || typeof rawUnavailable !== 'object' || Array.isArray(rawUnavailable))) return value;
  const unavailable = { ...((rawUnavailable ?? {}) as Record<string, unknown>) };
  for (const field of TOPOLOGY_INTERFACE_MEASURED_FIELDS) {
    if (sample[field] === undefined) sample[field] = null;
    if (sample[field] === null && unavailable[field] === undefined) unavailable[field] = TOPOLOGY_INTERFACE_NOT_REPORTED;
  }
  if (sample.counterWidth === undefined) sample.counterWidth = null;
  sample.unavailable = unavailable;
  return sample;
}

const sampleObject = z.object({
  interfaceId: z.uuid(),
  interfaceEpoch: key,
  sampledAt: time,
  counterWidth: z.union([z.literal(32), z.literal(64)]).nullable(),
  inOctets: counter, outOctets: counter,
  inErrors: counter, outErrors: counter,
  inDiscards: counter, outDiscards: counter,
  inPackets: counter, outPackets: counter,
  capacityBps: counter,
  discontinuityTicks: counter,
  deviceUptimeTicks: counter,
  reportedInBps: rate, reportedOutBps: rate,
  adminStatus: z.enum(TOPOLOGY_INTERFACE_ADMIN_STATUSES),
  operStatus: z.enum(TOPOLOGY_INTERFACE_OPER_STATUSES),
  unavailable: z.object(unavailableShape).strict(),
}).strict().superRefine((sample, ctx) => {
  const wide = TOPOLOGY_INTERFACE_WIDE_COUNTER_FIELDS.filter(field => sample[field] !== null);
  if (wide.length && sample.counterWidth === null) ctx.addIssue({ code: 'custom', path: ['counterWidth'], message: 'Counter width is required with octet/packet counters' });
  const bounded32 = [
    ...(sample.counterWidth === 32 ? wide : []),
    ...TOPOLOGY_INTERFACE_COUNTER32_FIELDS, ...TOPOLOGY_INTERFACE_TICK_FIELDS,
  ];
  for (const field of bounded32) {
    const value = sample[field];
    if (value !== null && BigInt(value) > UINT32_MAX) ctx.addIssue({ code: 'custom', path: [field], message: 'Value exceeds its 32-bit width' });
  }
  for (const field of TOPOLOGY_INTERFACE_MEASURED_FIELDS) {
    if (sample.unavailable[field] !== undefined && sample[field] !== null) ctx.addIssue({ code: 'custom', path: ['unavailable', field], message: 'A measured value cannot also be unavailable' });
  }
});
export const topologyInterfaceSampleV1Schema = z.preprocess(fillAbsentMeasurements, sampleObject);

export const topologyInterfaceMetricEnvelopeV1Schema = z.object({
  schemaVersion: z.literal(TOPOLOGY_INTERFACE_METRICS_SCHEMA_VERSION),
  family: z.literal('if_metrics'),
  producerEpoch: key,
  sequence: topologySequenceSchema,
  /** The authorized poll command this batch answers; null only for standing streams. */
  commandId: z.uuid().nullable(),
  configurationRevision: key,
  startedAt: time,
  finishedAt: time,
  captureAgeAtSendMs: z.number().int().min(0).max(86_400_000).nullable(),
  expectedIntervalSeconds: z.number().int().min(TOPOLOGY_INTERFACE_METRICS_INTERVAL_SECONDS.min).max(TOPOLOGY_INTERFACE_METRICS_INTERVAL_SECONDS.max),
  /** Source collection outcome; distinct from any target/port health. */
  outcome: collectionOutcomeSchema,
  reasonCode: topologyReasonSchema.nullable(),
  samples: z.array(topologyInterfaceSampleV1Schema).max(TOPOLOGY_INTERFACE_METRICS_MAX_SAMPLES),
}).strict().superRefine((envelope, ctx) => {
  const started = Date.parse(envelope.startedAt), finished = Date.parse(envelope.finishedAt);
  if (!(finished >= started && finished - started <= envelope.expectedIntervalSeconds * 1000)) ctx.addIssue({ code: 'custom', path: ['finishedAt'], message: 'Invalid collection window' });
  const seen = new Set<string>();
  envelope.samples.forEach((sample, index) => {
    const at = Date.parse(sample.sampledAt);
    if (at < started || at > finished) ctx.addIssue({ code: 'custom', path: ['samples', index, 'sampledAt'], message: 'Sample time is outside the collection window' });
    if (seen.has(sample.interfaceId)) ctx.addIssue({ code: 'custom', path: ['samples', index, 'interfaceId'], message: 'Duplicate interface sample' });
    seen.add(sample.interfaceId);
  });
  const empty = envelope.outcome === 'failed' || envelope.outcome === 'unsupported' || envelope.outcome === 'not_attempted';
  if (empty && envelope.samples.length) ctx.addIssue({ code: 'custom', path: ['samples'], message: 'A failed collection carries no samples' });
  if (envelope.outcome !== 'complete' && envelope.reasonCode === null) ctx.addIssue({ code: 'custom', path: ['reasonCode'], message: 'An incomplete collection needs a reason' });
  if (envelope.outcome === 'complete' && envelope.reasonCode !== null) ctx.addIssue({ code: 'custom', path: ['reasonCode'], message: 'A complete collection has no reason' });
});
/** Byte/authority guard first (no uploaded org/site/device/producer ids anywhere), then the strict schema. */
export const topologyInterfaceMetricEnvelopeV1WireSchema = topologyWireGuard(TOPOLOGY_INTERFACE_METRICS_MAX_BYTES).pipe(topologyInterfaceMetricEnvelopeV1Schema);
export function parseTopologyInterfaceMetricEnvelopeV1(value: unknown) {
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion !== TOPOLOGY_INTERFACE_METRICS_SCHEMA_VERSION) {
    return { accepted: false as const, reason: 'unsupported_major_version' as const };
  }
  const result = topologyInterfaceMetricEnvelopeV1WireSchema.safeParse(value);
  return result.success ? { accepted: true as const, envelope: result.data } : { accepted: false as const, reason: 'invalid_envelope' as const, issues: result.error.issues };
}

// ---- `topology_interface_poll` command payload (M3 Task 3, amendment M3-D2) ----
/**
 * One bounded SNMP interface poll, built by the server-side telemetry-arm
 * dispatcher and delivered over the existing command transport. The agent
 * collects IF-MIB state/counters for exactly `interfaces` (ifIndex → canonical
 * interface UUID + epoch, an allowlist it cannot extend) from exactly `target`,
 * and answers with a `TopologyInterfaceMetricEnvelopeV1` whose producerEpoch,
 * configurationRevision, sequence and expectedIntervalSeconds echo this payload
 * and whose commandId is the command's id.
 *
 * `binding` is server-only: the result adapter re-derives scope/authority from
 * the STORED command row, never from the agent's reply; the agent ignores it.
 * `sequence` is strictly increasing per (arm, producerEpoch) — the dispatcher's
 * counter — and `producerEpoch`/`configurationRevision` are the telemetry
 * producer credentials (`resolveTopologyTelemetryProducer`) at dispatch time.
 * SNMP secrets are TOP-LEVEL strings (`TOPOLOGY_INTERFACE_POLL_SECRET_FIELDS`) so
 * `sensitiveCommandPayload` field encryption and terminal erasure cover them;
 * an erased (terminal) payload still parses.
 */
export const TOPOLOGY_INTERFACE_POLL_COMMAND_TYPE = 'topology_interface_poll' as const;
export const TOPOLOGY_INTERFACE_POLL_COMMAND_VERSION = 1;
export const TOPOLOGY_INTERFACE_POLL_MAX_INTERFACES = TOPOLOGY_INTERFACE_METRICS_MAX_SAMPLES;
export const TOPOLOGY_INTERFACE_POLL_SECRET_FIELDS = ['snmpCommunity', 'snmpAuthPassphrase', 'snmpPrivPassphrase'] as const;
/** Capability the agent advertises in its network context when it can run the poll. */
export const TOPOLOGY_INTERFACE_POLL_CAPABILITY = { name: 'topology_interface_poll', version: 1 } as const;
export const TOPOLOGY_INTERFACE_POLL_AUTH_PROTOCOLS = ['md5', 'sha', 'sha224', 'sha256', 'sha384', 'sha512'] as const;
export const TOPOLOGY_INTERFACE_POLL_PRIV_PROTOCOLS = ['des', 'aes', 'aes192', 'aes256', 'aes192c', 'aes256c'] as const;
const secret = z.string().min(1).max(4096).nullable().optional();
export const topologyInterfacePollInterfaceSchema = z.object({
  interfaceId: z.uuid(),
  interfaceEpoch: key,
  ifIndex: z.number().int().min(1).max(2147483647),
  /** Identity the ifIndex must still carry (ifName / ifPhysAddress); null = not asserted. A mismatch is ifIndex reuse: no sample. */
  expectedName: z.string().min(1).max(255).nullable(),
  expectedPhysAddress: z.string().regex(/^[\da-f]{2}(:[\da-f]{2}){5}$/).nullable(),
}).strict();
export const topologyInterfacePollCommandV1Schema = z.object({
  version: z.literal(TOPOLOGY_INTERFACE_POLL_COMMAND_VERSION),
  family: z.literal('if_metrics'),
  binding: z.object({ orgId: z.uuid(), siteId: z.uuid(), authorityKey: key, armId: z.uuid() }).strict(),
  producerEpoch: key,
  configurationRevision: key,
  sequence: topologySequenceSchema,
  expectedIntervalSeconds: z.number().int().min(TOPOLOGY_INTERFACE_METRICS_INTERVAL_SECONDS.min).max(TOPOLOGY_INTERFACE_METRICS_INTERVAL_SECONDS.max),
  /** Collection budget; the envelope window must fit inside the interval. */
  deadlineMs: z.number().int().min(1000).max(TOPOLOGY_INTERFACE_METRICS_INTERVAL_SECONDS.max * 1000),
  target: z.object({ address: z.union([z.ipv4(), z.ipv6()]), port: topologyPortSchema }).strict(),
  snmp: z.object({
    version: z.enum(['v1', 'v2c', 'v3']),
    timeoutMs: z.number().int().min(100).max(10_000),
    retries: z.number().int().min(0).max(3),
    username: z.string().min(1).max(255).nullable(),
    authProtocol: z.enum(TOPOLOGY_INTERFACE_POLL_AUTH_PROTOCOLS).nullable(),
    privProtocol: z.enum(TOPOLOGY_INTERFACE_POLL_PRIV_PROTOCOLS).nullable(),
  }).strict(),
  snmpCommunity: secret,
  snmpAuthPassphrase: secret,
  snmpPrivPassphrase: secret,
  interfaces: z.array(topologyInterfacePollInterfaceSchema).min(1).max(TOPOLOGY_INTERFACE_POLL_MAX_INTERFACES),
}).strict().superRefine((command, ctx) => {
  if (command.deadlineMs > command.expectedIntervalSeconds * 1000) ctx.addIssue({ code: 'custom', path: ['deadlineMs'], message: 'Deadline exceeds the poll interval' });
  if (command.snmp.version === 'v3' && command.snmp.username === null) ctx.addIssue({ code: 'custom', path: ['snmp', 'username'], message: 'SNMPv3 needs a username' });
  if (command.snmp.privProtocol !== null && command.snmp.authProtocol === null) ctx.addIssue({ code: 'custom', path: ['snmp', 'privProtocol'], message: 'Privacy requires authentication' });
  const ids = new Set<string>(), indexes = new Set<number>();
  command.interfaces.forEach((entry, index) => {
    if (ids.has(entry.interfaceId)) ctx.addIssue({ code: 'custom', path: ['interfaces', index, 'interfaceId'], message: 'Duplicate interface' });
    if (indexes.has(entry.ifIndex)) ctx.addIssue({ code: 'custom', path: ['interfaces', index, 'ifIndex'], message: 'Duplicate ifIndex' });
    ids.add(entry.interfaceId); indexes.add(entry.ifIndex);
  });
});

// ---- History read contract (served by M3 Task 6) ----
export const TOPOLOGY_INTERFACE_METRIC_SERIES = [
  'in_bps', 'out_bps', 'in_utilization_pct', 'out_utilization_pct',
  'in_errors_per_second', 'out_errors_per_second', 'in_discards_per_second', 'out_discards_per_second',
] as const;
export type TopologyInterfaceMetricSeriesName = typeof TOPOLOGY_INTERFACE_METRIC_SERIES[number];
export const TOPOLOGY_INTERFACE_METRIC_UNITS = {
  in_bps: 'bits_per_second', out_bps: 'bits_per_second',
  in_utilization_pct: 'percent', out_utilization_pct: 'percent',
  in_errors_per_second: 'per_second', out_errors_per_second: 'per_second',
  in_discards_per_second: 'per_second', out_discards_per_second: 'per_second',
} as const satisfies Record<TopologyInterfaceMetricSeriesName, string>;
export const TOPOLOGY_INTERFACE_SAMPLE_RESOLUTIONS = ['raw', '5m', '1h'] as const;
/** Retention per resolution; also the maximum history range served at it. */
export const TOPOLOGY_INTERFACE_RESOLUTION_RETENTION_DAYS = { raw: 7, '5m': 30, '1h': 90 } as const;
export const TOPOLOGY_INTERFACE_HISTORY_MAX_BUCKETS = 1000;
export const TOPOLOGY_INTERFACE_HISTORY_MAX_SERIES = 8;
const seriesName = z.enum(TOPOLOGY_INTERFACE_METRIC_SERIES);
const resolution = z.enum(TOPOLOGY_INTERFACE_SAMPLE_RESOLUTIONS);
const DAY_MS = 86_400_000;

export const topologyInterfaceHistoryQuerySchema = z.object({
  series: z.array(seriesName).min(1).max(TOPOLOGY_INTERFACE_HISTORY_MAX_SERIES).refine(v => new Set(v).size === v.length, 'Duplicate series'),
  from: time,
  to: time,
  resolution: z.enum(['auto', ...TOPOLOGY_INTERFACE_SAMPLE_RESOLUTIONS]).default('auto'),
  maxBuckets: z.number().int().min(1).max(TOPOLOGY_INTERFACE_HISTORY_MAX_BUCKETS).default(TOPOLOGY_INTERFACE_HISTORY_MAX_BUCKETS),
}).strict().superRefine((query, ctx) => {
  const range = Date.parse(query.to) - Date.parse(query.from);
  if (!(range > 0)) ctx.addIssue({ code: 'custom', path: ['to'], message: 'History range must be positive' });
  const limit = query.resolution === 'auto' ? TOPOLOGY_INTERFACE_RESOLUTION_RETENTION_DAYS['1h'] : TOPOLOGY_INTERFACE_RESOLUTION_RETENTION_DAYS[query.resolution];
  if (range > limit * DAY_MS) ctx.addIssue({ code: 'custom', path: ['from'], message: 'History range exceeds the resolution retention' });
});
/** Server bucketing grid per resolution; buckets are whole multiples of it and aligned to it. */
export const TOPOLOGY_INTERFACE_RESOLUTION_BASE_SECONDS = { raw: 30, '5m': 300, '1h': 3600 } as const;
/** Interface generations × sources × producer epochs one response may represent (each is its own series). */
export const TOPOLOGY_INTERFACE_HISTORY_MAX_EPOCHS = 8;
export const TOPOLOGY_INTERFACE_SOURCE_KINDS = ['snmp', 'unifi'] as const;
const sourceKind = z.enum(TOPOLOGY_INTERFACE_SOURCE_KINDS);
const coverage = z.enum(['complete', 'partial', 'none']);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const reasons = (max: number) => z.array(topologyReasonSchema).max(max);
const historyPoint = z.object({
  at: time,
  /** Duration-weighted mean over valid measured time; null = no valid measurement (see reasons). */
  value: z.number().finite().nullable(),
  min: z.number().finite().nullable(),
  max: z.number().finite().nullable(),
  validDurationMs: count,
  sampleCount: count,
  gapDurationMs: count,
  reasons: reasons(16),
}).strict();
const historyGap = z.object({ from: time, to: time, reason: topologyReasonSchema }).strict();
/**
 * One represented identity epoch: an interface generation measured by one
 * telemetry source under one producer epoch. A rate is never computed across
 * two of them, so each is its own series (a generation change is a break).
 */
export const topologyInterfaceHistoryEpochSchema = z.object({
  interfaceEpoch: key,
  sourceId: z.uuid(),
  sourceKind,
  producerEpoch: key,
  /** The interface generation is the interface's current one. */
  current: z.boolean(),
  /** `stopped`: the source's measurement authority was revoked; its rows are history only. */
  sourceState: z.enum(['active', 'stopped']),
  from: time,
  to: time,
}).strict();
export const topologyInterfaceHistorySeriesSchema = z.object({
  name: seriesName,
  unit: z.enum(['bits_per_second', 'percent', 'per_second']),
  interfaceEpoch: key,
  sourceId: z.uuid(),
  sourceKind,
  producerEpoch: key,
  coverage,
  points: z.array(historyPoint).max(TOPOLOGY_INTERFACE_HISTORY_MAX_BUCKETS),
  gaps: z.array(historyGap).max(TOPOLOGY_INTERFACE_HISTORY_MAX_BUCKETS),
  reasons: reasons(64),
}).strict().refine(series => series.unit === TOPOLOGY_INTERFACE_METRIC_UNITS[series.name], 'Unit does not match series');
const epochKey = (value: { interfaceEpoch: string; sourceId: string; producerEpoch: string }) => JSON.stringify([value.interfaceEpoch, value.sourceId, value.producerEpoch]);
export const topologyInterfaceHistoryResponseSchema = z.object({
  interfaceId: z.uuid(),
  /** The interface's current generation. */
  interfaceEpoch: key,
  resolution,
  /** Server-selected, grid-aligned interval actually served. */
  interval: z.object({ from: time, to: time, bucketSeconds: z.number().int().positive().max(TOPOLOGY_INTERFACE_RESOLUTION_RETENTION_DAYS['1h'] * 86_400) }).strict(),
  series: z.array(topologyInterfaceHistorySeriesSchema).max(TOPOLOGY_INTERFACE_HISTORY_MAX_SERIES * TOPOLOGY_INTERFACE_HISTORY_MAX_EPOCHS),
  epochs: z.array(topologyInterfaceHistoryEpochSchema).max(TOPOLOGY_INTERFACE_HISTORY_MAX_EPOCHS),
  coverage,
  reasons: reasons(64),
  asOf: time,
}).strict().superRefine((response, ctx) => {
  const epochs = new Set(response.epochs.map(epochKey));
  response.series.forEach((series, index) => {
    if (!epochs.has(epochKey(series))) ctx.addIssue({ code: 'custom', path: ['series', index], message: 'Series epoch is not represented' });
  });
  if (new Set(response.series.map(series => series.name)).size > TOPOLOGY_INTERFACE_HISTORY_MAX_SERIES) {
    ctx.addIssue({ code: 'custom', path: ['series'], message: 'Too many series names' });
  }
});

// ---- Current interface measurement health (served by M3 Task 6) ----
/**
 * Fixed M3 interface thresholds. Errors/discards are per-second rates from one
 * endpoint's latest continuous window; no percentage is claimed without packet
 * denominators, and one endpoint's rate is never summed with its neighbour's.
 */
export const TOPOLOGY_INTERFACE_HEALTH_THRESHOLDS = { errorsPerSecond: 1, discardsPerSecond: 10 } as const;
const measurementRate = z.object({ name: seriesName, unit: z.enum(['bits_per_second', 'percent', 'per_second']), value: z.number().finite().nullable(), reason: topologyReasonSchema.nullable() })
  .strict().refine(rate => rate.unit === TOPOLOGY_INTERFACE_METRIC_UNITS[rate.name], 'Unit does not match series');
export const topologyInterfaceMeasurementSchema = z.object({
  interfaceId: z.uuid(),
  interfaceEpoch: key,
  /** The interface generation was retired; nothing current is claimed about it. */
  retired: z.boolean(),
  status: healthStatusSchema,
  coverage: healthCoverageSchema,
  freshness: freshnessSchema,
  reasons: reasons(32),
  adminStatus: z.enum(TOPOLOGY_INTERFACE_ADMIN_STATUSES).nullable(),
  operStatus: z.enum(TOPOLOGY_INTERFACE_OPER_STATUSES).nullable(),
  capacityBps: topologySequenceSchema.nullable(),
  sourceId: z.uuid().nullable(),
  sourceKind: sourceKind.nullable(),
  observedAt: time.nullable(),
  freshUntil: time.nullable(),
  expectedIntervalSeconds: z.number().int().min(TOPOLOGY_INTERFACE_METRICS_INTERVAL_SECONDS.min).max(86_400).nullable(),
  /** This endpoint's latest continuous window, or null when none is valid. */
  rates: z.object({ from: time, to: time, values: z.array(measurementRate).max(TOPOLOGY_INTERFACE_METRIC_SERIES.length) }).strict().nullable(),
}).strict();
export const topologyLinkHealthResponseSchema = z.object({
  siteId: z.uuid(),
  relationshipId: z.uuid(),
  graphRevision: topologyRevisionSchema,
  healthRevision: topologyRevisionSchema,
  health: graphRelationshipSchema.shape.health,
  /** When the current assessment next changes without new evidence; revalidate by then. */
  freshUntil: time.nullable(),
  /** Whether port measurement may describe this relationship at all (never for membership or inferred edges). */
  interfaceEvidence: z.object({ applies: z.boolean(), reason: topologyReasonSchema.nullable() }).strict(),
  endpoints: z.object({ source: topologyInterfaceMeasurementSchema.nullable(), target: topologyInterfaceMeasurementSchema.nullable() }).strict(),
  asOf: time,
}).strict();
