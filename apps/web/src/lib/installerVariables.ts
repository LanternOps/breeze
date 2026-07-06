/**
 * Installer-URL / silent-arg variable vocabulary.
 *
 * A software version's `downloadUrl` and silent install/uninstall args may
 * contain `{{...}}` variables that are resolved **per target device** at deploy
 * time (see the API-side resolver in `services/installerVariables.ts`). This
 * lets one catalog entry serve many organizations — e.g. a licensed installer
 * whose URL embeds a per-org key.
 *
 * Token syntax is deliberately double-brace (`{{org.name}}`) to avoid colliding
 * with the single-brace `{file}` token already used in silent-install args
 * (which the agent substitutes with the downloaded file path, not a tenant
 * value).
 *
 * This module is the single source of truth for the built-in vocabulary and the
 * token grammar; the API resolver mirrors these keys. Keep them in sync — a
 * token the UI offers but the resolver can't fill would ship a literal
 * `{{...}}` to an agent (the resolver guards against that by failing the device
 * loudly, but the UI should never offer an unresolvable built-in).
 */

export type InstallerVariableGroup = 'Organization' | 'Site' | 'Device' | 'Custom fields';

export interface InstallerVariable {
  /** The full token as inserted, e.g. `{{org.name}}`. */
  token: string;
  /** Human label for the picker, e.g. "Organization name". */
  label: string;
  group: InstallerVariableGroup;
  /** Example resolved value, shown as a hint in the picker. */
  example: string;
}

/** Built-in variables, always resolvable for any target device. */
export const BUILTIN_INSTALLER_VARIABLES: InstallerVariable[] = [
  { token: '{{org.name}}', label: 'Organization name', group: 'Organization', example: 'Acme Corp' },
  { token: '{{org.id}}', label: 'Organization ID', group: 'Organization', example: 'a1b2c3d4' },
  { token: '{{site.name}}', label: 'Site name', group: 'Site', example: 'Headquarters' },
  { token: '{{site.id}}', label: 'Site ID', group: 'Site', example: 'e5f6a7b8' },
  { token: '{{device.hostname}}', label: 'Device hostname', group: 'Device', example: 'WKS-014' },
];

/** Build the custom-field token for a device custom field key. */
export const customFieldToken = (fieldKey: string): string => `{{device.customField.${fieldKey}}}`;

const CUSTOM_FIELD_TOKEN = /^\{\{device\.customField\.([a-z][a-z0-9_]*)\}\}$/;
const TOKEN_SCAN = /\{\{\s*[^{}]*?\s*\}\}/g;

/**
 * Return the list of syntactically-tokenish substrings in a string, e.g.
 * `["{{org.name}}", "{{device.customField.licenseKey}}"]`. Used both for
 * highlighting and for validation.
 */
export function findTokens(value: string): string[] {
  return value.match(TOKEN_SCAN) ?? [];
}

/**
 * Validate the variables in a template string against the known vocabulary.
 * `knownCustomFieldKeys` is the set of device custom-field keys defined for the
 * partner/org (from `GET /custom-fields`); pass an empty set when they haven't
 * loaded yet, in which case custom-field tokens are accepted on structure alone
 * so the field never blocks on a slow fetch.
 *
 * Returns the list of tokens that are NOT recognized. An empty array means the
 * string is clean.
 */
export function findUnknownTokens(
  value: string,
  knownCustomFieldKeys: ReadonlySet<string>,
  { requireKnownCustomKeys = false }: { requireKnownCustomKeys?: boolean } = {},
): string[] {
  const builtinTokens = new Set(BUILTIN_INSTALLER_VARIABLES.map((v) => v.token));
  const unknown: string[] = [];
  for (const raw of findTokens(value)) {
    const token = raw.replace(/\s+/g, ''); // tolerate `{{ org.name }}`
    if (builtinTokens.has(token)) continue;
    const custom = CUSTOM_FIELD_TOKEN.exec(token);
    if (custom) {
      const key = custom[1];
      if (!requireKnownCustomKeys || knownCustomFieldKeys.has(key)) continue;
    }
    unknown.push(raw);
  }
  return unknown;
}
