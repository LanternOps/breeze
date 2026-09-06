/**
 * #2698 — apply a script's custom-field write-back to the device it ran on.
 *
 * Authorization is structural: `deviceId` comes from the transport that already
 * authorized the command row, and neither wire channel can name a device, so a
 * script can only ever write its own device's fields. The second gate is
 * per-field: `custom_field_definitions.script_write` must be true.
 *
 * NOT A SECRETS CHANNEL — see the file comment on ./scriptWriteMarkers.
 */
import { extractCustomFieldWrites, type MarkerFailureReason } from './scriptWriteMarkers';
import { validateCustomFieldValue, type CustomFieldValueRejection } from './validateValue';
import {
  loadDeviceForWriteBack,
  loadScriptWritableDefinitions,
  persistDeviceCustomFieldValues,
  type CustomFieldValueWrite,
} from './queries';
import { requestLikeFromSnapshot, writeAuditEventAsync } from '../auditEvents';
import type { ScriptCustomFieldWriteSummary } from '../../db/schema/scripts';

export type CustomFieldWriteRejection =
  | 'unknown_field'
  | 'not_script_writable'
  | 'not_applicable_to_device'
  | 'device_not_found'
  | CustomFieldValueRejection
  | MarkerFailureReason;

export interface ApplyScriptCustomFieldWritesInput {
  /**
   * Supplied by the transport that authorized the command row. There is no
   * field in either wire channel that can name a device, so this is the whole
   * of the device-scope authorization.
   */
  deviceId: string;
  agentId: string;
  commandId: string;
  stdout: string | undefined;
  resultEnvelope: unknown;
}

/** The ingest path has no user and no request; the audit needs neither. */
const AUDIT_REQUEST = requestLikeFromSnapshot({});

/** Returns null when the result carried no write-back request at all. */
export async function applyScriptCustomFieldWrites(
  input: ApplyScriptCustomFieldWritesInput,
): Promise<ScriptCustomFieldWriteSummary | null> {
  // Cheap, pure, and first: the overwhelming majority of script results carry
  // no marker at all and must cost zero database work.
  const extracted = extractCustomFieldWrites(input.stdout, input.resultEnvelope);
  if (extracted.channel === 'none') return null;

  // Marker-level failures are reported under a synthetic key. `failure.sample`
  // is RAW SCRIPT OUTPUT and deliberately never leaves this function.
  const rejected: Array<{ key: string; reason: CustomFieldWriteRejection }> = extracted.failures.map(
    (failure) => ({ key: '(marker)', reason: failure.reason }),
  );
  const applied: string[] = [];

  if (extracted.candidates.size === 0) {
    return { applied, rejected };
  }

  const device = await loadDeviceForWriteBack(input.deviceId);
  if (!device) {
    // RLS or a concurrent delete. Report rather than pretending success.
    console.warn('[customFields] script write-back found no device', {
      deviceId: input.deviceId,
      commandId: input.commandId,
    });
    return { applied, rejected: [...rejected, { key: '(device)', reason: 'device_not_found' }] };
  }

  // The DEVICE's org, never one the caller could name.
  const definitions = await loadScriptWritableDefinitions(device.orgId);
  const byKey = new Map(definitions.map((d) => [d.fieldKey, d]));

  // Per-key upsert into `device_custom_field_values`, with no
  // optimistic-concurrency check: two script results for the same device that
  // overlap can lose one field's write. This mirrors the PATCH value endpoint
  // (routes/devices/customFieldValues.ts) exactly, is self-healing (the next run
  // of the same script rewrites the value), and a version column here would be a
  // device-wide contention point far worse than the rare lost update. Accepted
  // deliberately, not overlooked. Since #3257 W05 the blast radius is smaller
  // still: the upsert is keyed on (device_id, definition_id), so two concurrent
  // runs writing DIFFERENT keys no longer clobber each other at all — only two
  // runs writing the SAME key can race.
  const writes: CustomFieldValueWrite[] = [];

  for (const [key, raw] of extracted.candidates) {
    const definition = byKey.get(key);
    if (!definition) {
      rejected.push({ key, reason: 'unknown_field' });
      continue;
    }
    if (definition.scriptWrite !== true) {
      rejected.push({ key, reason: 'not_script_writable' });
      continue;
    }
    if (
      Array.isArray(definition.deviceTypes) &&
      definition.deviceTypes.length > 0 &&
      (device.osType === null || !definition.deviceTypes.includes(device.osType))
    ) {
      rejected.push({ key, reason: 'not_applicable_to_device' });
      continue;
    }
    const validated = validateCustomFieldValue(definition, raw);
    if (!validated.ok) {
      rejected.push({ key, reason: validated.reason });
      continue;
    }
    writes.push({
      definitionId: definition.id,
      fieldKey: key,
      type: definition.type,
      value: validated.value,
    });
    applied.push(key);
  }

  if (applied.length === 0) {
    // No audit row when nothing landed: an audit event records a CHANGE, and
    // there was none. The rejection is not lost — it is persisted on
    // `script_executions.custom_field_result` (surfaced by GET
    // /scripts/executions/:id) and warned by the caller. Auditing every
    // rejected marker would also add an agent-driven row per script run to a
    // table already dominated by agent telemetry.
    return { applied, rejected };
  }

  // The compare-before-write that used to live here MOVED INTO the writer
  // (#3257 W05, `persistDeviceCustomFieldValues`), where it is a `setWhere` on
  // the upsert and therefore applies to all three write paths instead of this
  // one. Its reasoning is unchanged and is documented there: a write that
  // actually changes a value propagates through the projection trigger to an
  // UPDATE on `devices`, which fires the partner-export statement trigger and
  // takes an EXCLUSIVE per-org advisory lock held to COMMIT — the difference
  // between a fleet-wide script being cheap and being a per-org serialisation
  // point. Do not re-add a compare here; it would be a second, drifting copy.
  //
  // ONE BEHAVIOUR NARROWED HERE, deliberately. This used to read a boolean
  // "the UPDATE matched no row" and turn it into a typed
  // `{ key: '(device)', reason: 'device_not_found' }` rejection, persisted on
  // `script_executions.custom_field_result` and visible on
  // GET /scripts/executions/:id. An upsert has no such signal. If the device is
  // deleted between `loadDeviceForWriteBack` above and this write, the composite
  // (device_id, org_id) FK now raises 23503 instead — which
  // commandResultHandlers.ts catches: it console.errors, reports to Sentry, and
  // discards the whole summary rather than persisting a half-built one. The
  // failure stays LOUD to engineering; what the OPERATOR sees narrows from a
  // typed per-field rejection to "a run with no write-back". Accepted for a race
  // that needs a device delete inside this window. To type it again, catch 23503
  // here and re-raise it as `device_not_found` — do not reintroduce a
  // pre-flight existence check, which would only move the race.
  await persistDeviceCustomFieldValues(device.id, device.orgId, writes, 'script');

  // Audited even when every upsert was skipped as unchanged: the script
  // asserted these values and that assertion is the auditable event. Keys only —
  // a value can be anything the script computed and must never enter the audit
  // payload.
  await writeAuditEventAsync(AUDIT_REQUEST, {
    orgId: device.orgId,
    actorType: 'agent',
    actorId: device.id,
    action: 'device.custom_field.update',
    resourceType: 'device',
    resourceId: device.id,
    resourceName: device.hostname ?? device.displayName ?? undefined,
    details: {
      changedFields: applied,
      rejectedFields: rejected.map((r) => ({ key: r.key, reason: r.reason })),
      source: 'script',
      channel: extracted.channel,
      commandId: input.commandId,
      agentId: input.agentId,
    },
    result: rejected.length > 0 ? 'failure' : 'success',
  });

  return { applied, rejected };
}
