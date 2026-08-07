import { z } from 'zod';

/**
 * Wire schema for the SNMP metrics an agent reports back for a poll.
 *
 * WHY THIS EXISTS. Nothing between the agent socket and the `snmp_metrics`
 * INSERT validated this payload. `routes/agentWs.ts` types a command result as
 * `z.any()`, and both SNMP call sites reach it with a bare
 * `result.result as { metrics?: SnmpMetricResult[] }` cast — so
 * `SnmpMetricResult` was a type-level fiction with no runtime backing, and a
 * malformed metric crashed the worker rather than being rejected:
 *
 *  - a non-string `oid` (`123`, `null`) sails through `isPostgresTextSafe`
 *    vacuously (its `.length` is undefined, so the loop body never runs) and
 *    then throws `TypeError: value.slice is not a function` in `clampToLength`.
 *  - a garbage `timestamp` becomes an `Invalid Date`, which the driver rejects
 *    with a `RangeError` when it serialises the bind parameter.
 *
 * Neither carries a SQLSTATE, so the class-22 fast-fail classified both as
 * TRANSIENT and they consumed the whole ~155s retry budget before being
 * dropped — the same poison-pill shape this PR removes, wearing a different
 * error type. Validating here converts that into a deterministic, first-attempt
 * rejection.
 *
 * Modelled on `routes/backup/resultSchemas.ts` (safeParse'd in
 * `backupWorker.ts`), including its F13 lesson: be permissive about fields that
 * are not load-bearing, because failing a whole result over one cosmetic field
 * loses the data that actually matters.
 */
export const snmpMetricResultSchema = z.object({
  /**
   * The only genuinely required field. It is a NOT NULL varchar(200) AND the
   * series key (`metric_rollups` hashes `device_id || ':' || oid`), so a metric
   * without a usable OID has nowhere to be stored and nothing to be joined to.
   * A metric that fails here is dropped individually.
   */
  oid: z.string().min(1),
  /**
   * Nullish, not required: the agent sets it to the OID string when a template
   * gives no friendly name, and the row builder already falls back to the OID.
   * A missing name must never cost us the reading.
   */
  name: z.string().nullish(),
  /**
   * Deliberately unconstrained. `sanitizeSnmpMetricValue` accepts literally
   * anything (it `String()`s non-null input and hex-encodes what a text column
   * cannot hold), so there is no shape here that can break the insert — and an
   * enum/union would reject readings we can store perfectly well.
   */
  value: z.unknown(),
  /**
   * Also unconstrained, because the failure mode is a bad *value*, not a bad
   * type: `new Date('nope')` and `new Date({})` are both `Invalid Date`. It is
   * validated by `resolveMetricTimestamp`, which falls back to the ingest clock
   * rather than discarding the reading — a poll timestamp is always within
   * seconds of now, so the fallback is nearly lossless while dropping the
   * metric would not be.
   */
  timestamp: z.unknown(),
  /**
   * Kept a loose optional string ON PURPOSE. It is untrusted wire input and the
   * downstream allowlist (`AGENT_HEX_ENCODING`, plus the hex-shape check in
   * `resolveDeclaredValueType`) is what makes it safe — an enum here would only
   * move the rejection earlier and cost us the whole metric over a field that
   * is advisory.
   */
  valueEncoding: z.string().nullish(),
});

export type ParsedSnmpMetricResult = z.infer<typeof snmpMetricResultSchema>;

/**
 * First zod issue rendered as a short `path: message` string, for log/Sentry
 * context. Bounded on purpose — see the message cap in snmpWorker.ts.
 */
export function describeMetricParseIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'unknown validation failure';
  const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
  return `${path}: ${issue.message}`.slice(0, 120);
}
