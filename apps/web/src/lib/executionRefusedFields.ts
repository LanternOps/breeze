/**
 * Early-warning mirror of the API's execution-target denylist
 * (`EXECUTION_REFUSED_AGENT_FIELDS` + `custom.*` in
 * `apps/api/src/services/filterEngine.ts`).
 *
 * A dynamic device group whose rules match on a field the device reports about
 * itself is refused as an execution target by the server. This copy only lets a
 * picker disable such a group BEFORE the round trip and say why. The server
 * stays authoritative: it re-checks, and its refusal warnings are rendered too.
 * `executionRefusedFields.test.ts` pins this list to the API source.
 */
export const EXECUTION_REFUSED_FIELDS: readonly string[] = [
  'hostname',
  'displayName',
  'tags',
  'deviceRole',
  'lastUser',
  'helperVersion',
  'agentVersion',
  'software.installed',
  'software.notInstalled',
  'hostsWorkloads',
  'workloadRuntimes',
  'logShippingFailing',
];

const REFUSED = new Set(EXECUTION_REFUSED_FIELDS);

export function executionRefusedFieldsUsed(fieldsUsed: readonly string[] | null | undefined): string[] {
  return (fieldsUsed ?? []).filter((field) => REFUSED.has(field) || field.startsWith('custom.'));
}
