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
  persistDeviceCustomFields,
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

function readExistingCustomFields(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>) }
    : {};
}

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

  // Read-modify-write, with no optimistic-concurrency check: two script results
  // for the same device that overlap can lose one field's write. This mirrors
  // the PATCH value endpoint (routes/devices/customFieldValues.ts) exactly, is
  // self-healing (the next run of the same script rewrites the value), and a
  // version column here would be a device-wide contention point far worse than
  // the rare lost update. Accepted deliberately, not overlooked.
  const existing = readExistingCustomFields(device.customFields);
  const merged = { ...existing };

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
    merged[key] = validated.value;
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

  // Compare BEFORE writing. An unchanged object means no UPDATE, which means
  // the devices statement trigger takes no per-org advisory lock and writes no
  // WAL — the difference between a fleet-wide script being cheap and being a
  // per-org serialisation point. Only the applied keys can differ, because
  // `merged` starts as a copy of `existing` and nothing else mutates it.
  const unchanged = applied.every(
    (key) => Object.prototype.hasOwnProperty.call(existing, key) && Object.is(merged[key], existing[key]),
  );
  if (!unchanged) {
    const ok = await persistDeviceCustomFields(device.id, device.orgId, merged);
    if (!ok) {
      console.warn('[customFields] script write-back UPDATE matched no row', {
        deviceId: device.id,
        commandId: input.commandId,
      });
      return {
        applied: [],
        rejected: [...rejected, { key: '(device)', reason: 'device_not_found' }],
      };
    }
  }

  // Audited even when the write was a no-op merge: the script asserted these
  // values and that assertion is the auditable event. Keys only — a value can
  // be anything the script computed and must never enter the audit payload.
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
