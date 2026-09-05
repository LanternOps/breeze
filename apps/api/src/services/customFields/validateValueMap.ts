import { loadVisibleCustomFieldDefinitions } from './queries';
import { validateCustomFieldValue, type CustomFieldValueRejection } from './validateValue';

export type CustomFieldMapRejection = {
  fieldKey: string;
  reason: CustomFieldValueRejection | 'unknown_field' | 'not_applicable_to_device';
};

export type CustomFieldMapResult =
  | { ok: true; values: Record<string, string | number | boolean | null> }
  | { ok: false; rejected: CustomFieldMapRejection[] };

export const INVALID_CUSTOM_FIELD_VALUE_MESSAGE =
  'One or more custom field values are invalid for their definition';

/**
 * Validate and coerce a whole custom-field map for ONE device, against the
 * bounded (org + partner-wide) set of visible definitions.
 *
 * All-or-nothing by design: shared by both `PATCH /devices/:id/custom-fields`
 * and `PATCH /devices/:id`. A single PATCH is one operator action, not a bulk
 * load — the importer (#3257) applies partially instead, because a 30-column
 * row IS a bulk load.
 *
 * `deviceOsType` mirrors the `not_applicable_to_device` gate scriptWriteBack.ts
 * already applies for a definition scoped to specific `deviceTypes` — a null
 * (unknown) osType is treated as non-matching, same as scriptWriteBack.
 */
export async function validateCustomFieldMap(
  orgId: string,
  deviceOsType: string | null,
  updates: Record<string, unknown>,
): Promise<CustomFieldMapResult> {
  const definitions = await loadVisibleCustomFieldDefinitions(orgId);
  const byKey = new Map(definitions.map((d) => [d.fieldKey, d]));
  const rejected: CustomFieldMapRejection[] = [];
  const values: Record<string, string | number | boolean | null> = {};

  for (const [fieldKey, raw] of Object.entries(updates)) {
    const definition = byKey.get(fieldKey);
    if (!definition) {
      rejected.push({ fieldKey, reason: 'unknown_field' });
      continue;
    }
    if (
      Array.isArray(definition.deviceTypes) &&
      definition.deviceTypes.length > 0 &&
      (deviceOsType === null || !definition.deviceTypes.includes(deviceOsType))
    ) {
      rejected.push({ fieldKey, reason: 'not_applicable_to_device' });
      continue;
    }
    const result = validateCustomFieldValue(definition, raw);
    if (!result.ok) {
      rejected.push({ fieldKey, reason: result.reason });
      continue;
    }
    values[fieldKey] = result.value;
  }

  if (rejected.length > 0) {
    return { ok: false, rejected };
  }
  return { ok: true, values };
}
