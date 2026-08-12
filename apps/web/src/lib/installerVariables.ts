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

export type InstallerVariableGroup =
  | 'Organization'
  | 'Site'
  | 'Device'
  | 'Custom fields'
  /** Tenant variables (#3409) — `{{var.<key>}}`, dynamic like custom fields. */
  | 'Variables';

export interface InstallerVariable {
  /** The full token as inserted, e.g. `{{org.name}}`. */
  token: string;
  /** Human label for the picker, e.g. "Organization name". */
  label: string;
  group: InstallerVariableGroup;
  /** Example resolved value, shown as a hint in the picker. */
  example: string;
}

/**
 * Built-in variables, always resolvable for any target device.
 *
 * IMPORTANT: every token here MUST have a matching arm in the API resolver's
 * `resolveKey` switch (`apps/api/src/services/installerVariables.ts`). The two
 * key sets are kept in sync by convention; the `BUILTIN_TOKENS` tripwire test in
 * `installerVariables.test.ts` catches an accidental addition on this side.
 */
export const BUILTIN_INSTALLER_VARIABLES: readonly InstallerVariable[] = [
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
 * `{{var.<key>}}` (#3409) — matched against the RAW token, never the
 * whitespace-normalized one. The `var.*` namespace has exactly one strict form
 * on both client and server (`VARIABLE_TOKEN_PATTERN` in `@breeze/shared`);
 * accepting `{{ var.x }}` here would recreate the client-passes/server-fails
 * divergence the legacy tokens above already suffer from.
 */
const VARIABLE_TOKEN = /^\{\{var\.([a-z][a-z0-9_]{0,63})\}\}$/;

/**
 * Return the list of syntactically-tokenish substrings in a string, e.g.
 * `["{{org.name}}", "{{device.customField.licenseKey}}"]`. Used both for
 * highlighting and for validation.
 */
export function findTokens(value: string): string[] {
  return value.match(TOKEN_SCAN) ?? [];
}

/**
 * Same scan as {@link findTokens}, but carrying each match's offset so a
 * caller can inspect the character BEFORE the token — which is the only way
 * to see a `$` prefix, since `$` sits outside the match itself.
 *
 * Uses a fresh matcher rather than the shared `TOKEN_SCAN` instance:
 * `matchAll` seeds its internal matcher from the regex it is handed, so a
 * module-level global regex would carry `lastIndex` state between callers.
 */
function scanTokens(value: string): Array<{ raw: string; offset: number }> {
  const matcher = new RegExp(TOKEN_SCAN.source, 'g');
  return [...value.matchAll(matcher)].map((m) => ({ raw: m[0], offset: m.index }));
}

/**
 * Validate the variables in a template string against the known vocabulary.
 * `knownCustomFieldKeys` is the set of device custom-field keys defined for the
 * partner/org (from `GET /custom-fields`); pass an empty set when they haven't
 * loaded yet, in which case custom-field tokens are accepted on structure alone
 * so the field never blocks on a slow fetch. `variableKeys` /
 * `requireKnownVariableKeys` are the same pair for tenant variables
 * (`GET /tenant-variables`, #3409).
 *
 * Returns the list of tokens that are NOT recognized. An empty array means the
 * string is clean.
 */
export function findUnknownTokens(
  value: string,
  knownCustomFieldKeys: ReadonlySet<string>,
  {
    requireKnownCustomKeys = false,
    variableKeys,
    requireKnownVariableKeys = false,
  }: {
    requireKnownCustomKeys?: boolean;
    variableKeys?: ReadonlySet<string>;
    requireKnownVariableKeys?: boolean;
  } = {},
): string[] {
  const builtinTokens = new Set(BUILTIN_INSTALLER_VARIABLES.map((v) => v.token));
  const unknown: string[] = [];
  for (const { raw, offset } of scanTokens(value)) {
    // raw, not normalized — strict grammar. The `$` guard mirrors the shared
    // pattern's `(?<!\$)` lookbehind and the server's `template[offset - 1]`
    // check (`apps/api/src/services/installerVariables.ts`): a `${{var.x}}`
    // is deliberately NOT a variable token, and the server treats it as
    // unknown and fails the deploy. Without this the client validated it
    // clean — the exact client-passes/server-fails divergence VARIABLE_TOKEN's
    // docblock above claims to prevent. Falling through (rather than
    // `continue`) lands it in `unknown` via the checks below.
    const variable = offset > 0 && value[offset - 1] === '$' ? null : VARIABLE_TOKEN.exec(raw);
    if (variable) {
      const key = variable[1];
      if (!requireKnownVariableKeys || variableKeys?.has(key)) continue;
      unknown.push(raw);
      continue;
    }
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
