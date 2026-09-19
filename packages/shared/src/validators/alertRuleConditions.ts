import { z } from 'zod';

// Canonical write-path schema for server-evaluated alert rule conditions.
// Extended types (bandwidth_high, disk_io_high, network_errors, patch_compliance,
// cert_expiry) have evaluator handlers but known payload/unit bugs — they are
// write-blocked until fixed (see plans/monitoring/2026-07-30 follow-ups). `custom`
// has no handler at all. Reads of existing rows remain tolerant (no parse on read).
// Every metric name the threshold evaluator resolves to a device_metrics column
// (METRIC_NAME_MAP in apps/api/src/services/alertConditions/utils.ts). The
// `*Percent` / `memory` / `processes` aliases are accepted, not advertised: the
// AlertRuleTab dropdown offers only cpu/ram/disk for NEW rules, but AI-authored
// and pre-consolidation rows carry the aliases, and a narrower enum here would
// hard-400 an otherwise untouched Alerts tab on save.
export const ALERT_METRIC_NAMES = [
  'cpu', 'cpuPercent',
  'ram', 'ramPercent', 'memory',
  'disk', 'diskPercent',
  'processCount', 'processes',
] as const;

const metricConditionSchema = z.object({
  // `threshold` is the evaluator's OWN canonical name for this handler
  // (handlers/threshold.ts declares `type: 'threshold'` with `aliases: ['metric']`)
  // and the pre-consolidation AI tool docs advertised it, so stored rows carry
  // it. Canonicalize to `metric` — the spelling every other surface (editor,
  // decompose, docs) uses — exactly as `status` is folded into `offline` below.
  type: z.enum(['metric', 'threshold']).transform(() => 'metric' as const),
  metric: z.enum(ALERT_METRIC_NAMES),
  // `neq` is included because the evaluator supports it — threshold.ts's own
  // validate() accepts gt/gte/lt/lte/eq/neq. The editor has always offered
  // "Not Equal", so omitting it here 400s a save the evaluator would have run.
  operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'neq']),
  value: z.number(),
  // Sustained window, in MINUTES, that the threshold handler averages samples
  // over (`cond.durationMinutes || 1`, handlers/threshold.ts). The old
  // `duration` (seconds) field is deliberately gone: no metric handler ever
  // read it, so it advertised a sustained window that silently did nothing,
  // while Zod's strip mode silently dropped the durationMinutes the evaluator
  // DOES honour — degrading a sustained rule to a 1-minute window on edit.
  durationMinutes: z.number().int().min(1).max(10080).optional(),
});

// Unlike the metric handler, the OFFLINE handler really does read a legacy
// `duration` field (handlers/offline.ts resolveDurationMinutes, for rows the old
// editor saved as `{type:'status', duration:N}`). Accept it and fold it into the
// canonical `durationMinutes` — stripping it would silently reset such a rule to
// the handler's 5-minute default the first time its policy is re-saved.
const offlineConditionSchema = z.object({
  type: z.enum(['offline', 'status']).transform(() => 'offline' as const),
  durationMinutes: z.number().int().min(1).max(10080).optional(),
  duration: z.number().int().min(1).max(10080).optional(),
}).transform(({ duration, durationMinutes, ...rest }) => {
  const resolved = durationMinutes ?? duration;
  return resolved === undefined ? rest : { ...rest, durationMinutes: resolved };
});

const eventLogConditionSchema = z.object({
  type: z.literal('event_log'),
  category: z.enum(['security', 'hardware', 'application', 'system']),
  level: z.enum(['warning', 'error', 'critical']),
  sourcePattern: z.string().max(500).optional(),
  messagePattern: z.string().max(500).optional(),
  countThreshold: z.number().int().min(1).max(10000).default(1),
  windowMinutes: z.number().int().min(1).max(1440).default(15),
});

// discriminatedUnion, not union: with a plain union every member fails on a
// malformed condition and Zod surfaces a bare `invalid_union` whose message is
// "Invalid input" — the HTTP and AI surfaces then tell the caller nothing about
// WHICH field is wrong. Discriminating on `type` picks exactly one member and
// reports that member's own issue (e.g. the metric enum message), and an
// unrecognised `type` gets a message naming every accepted type.
//
// Zod 4 supports a discriminator that is an enum with a `.transform()` (the
// `metric|threshold` and `offline|status` aliases below) and an option that is
// itself a piped object schema (offline's duration fold) — both are exercised
// by alertRuleConditions.test.ts, which is what keeps this switch honest.
export const alertRuleConditionSchema = z.discriminatedUnion('type', [
  metricConditionSchema,
  offlineConditionSchema,
  eventLogConditionSchema,
]);
