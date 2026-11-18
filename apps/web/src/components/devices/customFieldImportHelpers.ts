import type { CustomFieldType } from '@breeze/shared';

/**
 * Pure helpers for the "Import from another RMM" wizard (#9679).
 */

/**
 * Mirrors `CustomFieldsPage.tsx`'s `generateFieldKey` with two additions: camelCase
 * boundaries are split BEFORE lowercasing (`backupPlan` → `backup_plan`, not
 * `backupplan`), and the result is guaranteed to satisfy the server's
 * `^[a-z][a-z0-9_]*$` key regex — the key is generated once for up to 30 rows with
 * no per-row key input, so a label like "2nd Monitor" or "###" would otherwise 400
 * the whole batch.
 */
export function generateFieldKey(name: string): string {
  const base = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  if (base === '') return 'f_untitled';
  if (!/^[a-z]/.test(base)) return `f_${base}`;
  return base;
}

const TYPE_ALIASES: Record<Exclude<CustomFieldType, 'text'>, string[]> = {
  number: ['number', 'numeric', 'integer', 'int', 'decimal', 'float', 'double', 'currency'],
  boolean: ['boolean', 'bool', 'checkbox', 'yesno', 'toggle', 'truefalse'],
  date: ['date', 'datetime', 'timestamp'],
  dropdown: ['dropdown', 'select', 'list', 'choice', 'enum', 'picklist', 'option', 'options'],
};

/** Guess a Breeze field type from an incumbent export's Type cell. Unknown → `text`. */
export function guessFieldType(raw: string): CustomFieldType {
  const norm = raw.toLowerCase().replace(/[^a-z]+/g, '');
  if (!norm) return 'text';
  for (const [type, aliases] of Object.entries(TYPE_ALIASES) as Array<[CustomFieldType, string[]]>) {
    if (aliases.includes(norm)) return type;
  }
  return 'text';
}

export type ValueIdentifierField = 'deviceId' | 'serialNumber' | 'hostname';

const IDENTIFIER_HEADER_GUESSES: Record<ValueIdentifierField, string[]> = {
  deviceId: ['deviceid', 'breezedeviceid'],
  serialNumber: ['serial', 'serialnumber', 'serialno', 'servicetag'],
  hostname: ['hostname', 'host', 'devicename', 'computername', 'machinename'],
};

export type GuessedColumnRole = `identifier:${ValueIdentifierField}` | 'customField';

const normHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Pre-map step-2 columns: well-known identifier headers, and headers that match an
 * existing field's key or name (normalized, so `backupPlan` and `Backup Plan` both
 * hit `backup_plan`). Anything else is left unmapped (= "Ignore").
 */
export function guessValueColumnRoles(
  headers: string[],
  knownFields: ReadonlyArray<{ fieldKey: string; name: string }>,
): { roles: Record<string, GuessedColumnRole>; fieldKeys: Record<string, string> } {
  const roles: Record<string, GuessedColumnRole> = {};
  const fieldKeys: Record<string, string> = {};
  const claimedIdentifiers = new Set<ValueIdentifierField>();
  const claimedFields = new Set<string>();
  const identifierKeys = Object.keys(IDENTIFIER_HEADER_GUESSES) as ValueIdentifierField[];

  // Pass 1: identifiers.
  const identifierHeaders = new Set<string>();
  for (const header of headers) {
    const norm = normHeader(header);
    if (!norm) continue;
    const identifier = identifierKeys.find(
      (f) => !claimedIdentifiers.has(f) && IDENTIFIER_HEADER_GUESSES[f].includes(norm),
    );
    if (identifier) {
      claimedIdentifiers.add(identifier);
      roles[header] = `identifier:${identifier}`;
      identifierHeaders.add(header);
    }
  }

  // Pass 2: exact key matches first, then name matches; a field is claimed by one column only.
  const claimField = (header: string, match: (f: { fieldKey: string; name: string }, norm: string) => boolean) => {
    const norm = normHeader(header);
    if (!norm || roles[header]) return;
    const field = knownFields.find((f) => !claimedFields.has(f.fieldKey) && match(f, norm));
    if (!field) return;
    claimedFields.add(field.fieldKey);
    roles[header] = 'customField';
    fieldKeys[header] = field.fieldKey;
  };
  for (const header of headers) claimField(header, (f) => f.fieldKey === header);
  for (const header of headers) claimField(header, (f, norm) => normHeader(f.fieldKey) === norm);
  for (const header of headers) claimField(header, (f, norm) => normHeader(f.name) === norm);
  return { roles, fieldKeys };
}
