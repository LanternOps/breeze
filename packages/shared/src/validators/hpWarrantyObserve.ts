import { z } from 'zod';

/**
 * HP warranty observe record (#5511, observe-first amendment §2).
 *
 * Observe is the read-only step before any HP warranty collection may act.
 * The agent reports what HP's warranty WMI namespace holds on the device (its
 * shape, never its identity) and the prerequisites CMSL would need, through the
 * existing agent-log path: one record, component
 * {@link HP_WARRANTY_OBSERVE_COMPONENT}, message
 * {@link HP_WARRANTY_OBSERVE_MESSAGE}, with this object under the `observation`
 * field. There is no new table, column or route.
 *
 * The record is untrusted device output, so:
 * - every object is strict and every key is required (nullable, never
 *   optional), so a golden carries every key the schema has;
 * - every string is bounded and refuses control characters;
 * - a WMI value is reported only under a property name that passes
 *   {@link isHpWarrantyObservableName} (deny first, then allow): no serial,
 *   product number, SKU, UUID, identifying number, customer or contact field
 *   can carry a value;
 * - version strings carry a `v` prefix, so the agent-log redactor never reads a
 *   four-part version as an IPv4 address;
 * - the whole object is at most {@link HP_WARRANTY_OBSERVE_MAX_BYTES}.
 *
 * The API re-validates the record at ingest (routes/agents/logs.ts) and keeps
 * only a record that parses. The agent mirrors these shapes in
 * agent/internal/hpwarrantyobserve; both sides test against the goldens in that
 * package's testdata/wire.
 */

export const HP_WARRANTY_OBSERVE_COMPONENT = 'hp_warranty_observe';
export const HP_WARRANTY_OBSERVE_MESSAGE = 'vendor_observation';
export const HP_WARRANTY_OBSERVE_MAX_BYTES = 16 * 1024;

/**
 * Deny-then-allow for WMI property names whose VALUES may be reported. Names
 * alone (with their CIM type) are always reported; they carry no identity.
 * The agent holds the same patterns (hpwarrantyobserve.denyPattern/allowPattern)
 * and testdata/wire/name_filter.json pins both sides to the same answers.
 */
export const HP_WARRANTY_VALUE_NAME_DENY =
  /serial|product.?(number|no)|sku|uuid|identif|customer|email|name|address|phone|country/i;
export const HP_WARRANTY_VALUE_NAME_ALLOW =
  /(start|end|expir\w*)\w*date|type|status|desc|level|coverage|offer|lastupdat|cache|timestamp/i;
const PROPERTY_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function isHpWarrantyObservableName(name: string): boolean {
  return PROPERTY_NAME.test(name) && !HP_WARRANTY_VALUE_NAME_DENY.test(name) && HP_WARRANTY_VALUE_NAME_ALLOW.test(name);
}

const NO_CONTROL_CHARS = /^[^\u0000-\u001f\u007f]*$/;
const text = (max: number) => z.string().max(max).regex(NO_CONTROL_CHARS, 'must not contain control characters');
const count = z.number().int().min(0).max(100_000);
const version = z.string().max(32).regex(/^v\d{1,9}(\.\d{1,9}){0,3}$/, 'must be a v-prefixed dotted version');

export const HP_WARRANTY_NAMESPACE_STATES = ['present', 'absent', 'access_denied', 'error', 'not_checked'] as const;
export const HP_WARRANTY_DATE_FORMATS = ['cim_datetime', 'ms_json_date', 'iso8601', 'other'] as const;
export const HP_WARRANTY_REGISTRY_STATES = ['enabled', 'disabled', 'other', 'absent', 'unreadable'] as const;
export const HP_WARRANTY_OBSERVE_CONFLICTS = ['hp_support_assistant', 'hp_insights'] as const;

const namespaceState = z.enum(HP_WARRANTY_NAMESPACE_STATES);
const registryState = z.enum(HP_WARRANTY_REGISTRY_STATES);
const propertyName = z.string().regex(PROPERTY_NAME, 'must be a WMI property name');

const classObservationSchema = z
  .object({
    state: z.enum(['present', 'absent', 'access_denied', 'error']),
    properties: z
      .array(
        z
          .object({
            name: propertyName,
            cimType: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,23}$/, 'must be a CIM type name'),
          })
          .strict(),
      )
      .max(64),
    rowCount: count.nullable(),
    rows: z
      .array(
        z
          .record(propertyName, text(64).nullable())
          .refine((row) => Object.keys(row).length <= 64, 'too many values in a row')
          .refine(
            (row) => Object.keys(row).every(isHpWarrantyObservableName),
            'a value is reported under a property name the filter does not allow',
          ),
      )
      .max(25),
    dateFormats: z
      .record(propertyName, z.enum(HP_WARRANTY_DATE_FORMATS))
      .refine((m) => Object.keys(m).length <= 64, 'too many date formats')
      .refine((m) => Object.keys(m).every(isHpWarrantyObservableName), 'a date format names a filtered property'),
  })
  .strict();

export const hpWarrantyObservationSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.enum(['observe', 'act']),
    model: text(64).nullable(),
    family: text(64).nullable(),
    nativeArch: z.enum(['amd64', 'arm64', 'x86', 'unknown']),
    namespaces: z
      .object({
        rootHp: namespaceState,
        instrumentedServices: namespaceState,
        v1: namespaceState,
        instrumentedBios: namespaceState,
      })
      .strict(),
    classes: z
      .object({
        total: count,
        names: z.array(propertyName).max(32),
      })
      .strict()
      .nullable(),
    hpWarranty: classObservationSchema.nullable(),
    hpEntitlements: classObservationSchema.nullable(),
    /** null when the module directory could not be read. */
    cmsl: z
      .array(
        z
          .object({
            name: z.string().max(64).regex(/^(?:HPCMSL|HP\.[A-Za-z0-9.]{1,61})$/i, 'must be an HP module directory'),
            versions: z.array(version).max(8),
          })
          .strict(),
      )
      .max(16)
      .nullable(),
    powershell: z
      .object({
        v51: z.boolean().nullable(),
        strongCrypto64: registryState,
        strongCrypto32: registryState,
        schannelTls12Client: registryState,
      })
      .strict(),
    winget: z
      .object({
        present: z.boolean().nullable(),
        version: version.nullable(),
      })
      .strict(),
    conflicts: z
      .array(
        z
          .object({
            name: z.enum(HP_WARRANTY_OBSERVE_CONFLICTS),
            version: version.nullable(),
          })
          .strict(),
      )
      .max(4),
    errors: z
      .array(
        z
          .object({
            step: z.string().regex(/^[a-z0-9_]{1,32}$/, 'must be a step name'),
            code: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/, 'must be an error code'),
          })
          .strict(),
      )
      .max(16),
  })
  .strict()
  .refine(
    (o) => new TextEncoder().encode(JSON.stringify(o)).length <= HP_WARRANTY_OBSERVE_MAX_BYTES,
    `observation exceeds ${HP_WARRANTY_OBSERVE_MAX_BYTES} bytes`,
  );

export type HpWarrantyObservation = z.infer<typeof hpWarrantyObservationSchema>;

/**
 * The stored `fields` of an observe record. Ingest keeps `component` and a
 * parsed `observation`; anything else the agent sent is dropped, and a record
 * that fails the contract keeps only a rejection marker, never its contents.
 */
export function sanitizeHpWarrantyObserveFields(fields: unknown): Record<string, unknown> {
  const raw = fields && typeof fields === 'object' && !Array.isArray(fields)
    ? (fields as Record<string, unknown>).observation
    : undefined;
  const parsed = hpWarrantyObservationSchema.safeParse(raw);
  if (!parsed.success) {
    return { component: HP_WARRANTY_OBSERVE_COMPONENT, observationRejected: 'contract' };
  }
  return { component: HP_WARRANTY_OBSERVE_COMPONENT, observation: parsed.data };
}
