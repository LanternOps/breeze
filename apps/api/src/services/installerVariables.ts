/**
 * Deploy-time substitution of `{{...}}` variables in a software version's
 * download URL and silent install/uninstall args.
 *
 * This is the generic sibling of `edrInstallerResolver.ts`: where that resolves
 * a fixed set of single-brace EDR secrets (`{huntress_org_key}`, …) for built-in
 * packages, this resolves double-brace tenant variables (`{{org.name}}`,
 * `{{device.customField.licenseKey}}`) for ANY package, per target device.
 *
 * Double braces are deliberate — they never collide with the single-brace
 * `{file}` token the agent substitutes with the downloaded installer path.
 *
 * The web-side vocabulary/validation lives in
 * `apps/web/src/lib/installerVariables.ts`; keep the two key sets in sync.
 *
 * Contract: an unrecognized or unfillable token (typo, or a custom field the
 * device doesn't have) is returned in `unresolved` and left verbatim in the
 * string. Callers MUST fail that device rather than dispatch a literal `{{...}}`
 * to an agent.
 *
 * `var.<key>` (#3409 PR2) is the ONE namespace here that is ALSO substituted
 * at script dispatch (`tenantVariableResolution.ts`) via a different, strict
 * tokenizer (`VARIABLE_TOKEN_PATTERN` in `@breeze/shared`, no inner
 * whitespace, no `${{...}}` escape). See `isStrictVariableToken` below for how
 * this file's own whitespace-tolerant TOKEN regex is kept from silently
 * accepting a form the script-content path would reject.
 */
import { findVariableTokens } from '@breeze/shared';

export interface InstallerVariableContext {
  org: { id: string; name: string };
  site: { id: string; name: string };
  device: { hostname: string; customFields: Record<string, unknown> | null };
  /**
   * Tenant variables (#3409 PR2), prefetched and flattened by the caller
   * (`softwareDeployment.ts`) — KEY → non-secret VALUE only. Secret variables
   * are omitted from this map entirely by the caller, so a `{{var.<secret>}}`
   * reference here always falls through to the `unresolved` branch, never a
   * substituted secret value.
   */
  vars: Record<string, string>;
}

// Matches `{{ key }}` with optional inner whitespace; the key itself excludes braces.
const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const CUSTOM_FIELD_KEY = /^device\.customField\.([a-z][a-z0-9_]*)$/;

// A device-writable custom-field value substituted into `silentInstallArgs`
// lands verbatim inside an installer command line the agent splits into
// argv (`splitCommandLine`). A value containing whitespace inserts a whole
// new argv element (e.g. a value of `X TRANSFORMS=\\host\share\t.mst`
// smuggles in a `TRANSFORMS=` flag the template never intended), and a
// value containing a quote or backslash can escape the template's own
// quoting. Custom fields are free-text (validateCustomFieldValue only
// bounds length), so this is enforced here at substitution time rather than
// at write time — the same value is fine in other contexts (device notes,
// ticket fields), just not spliced into an argv position.
//
// Deliberately conservative: letters, digits, and a small set of
// punctuation common in license keys / simple identifiers / paths. No
// whitespace, quotes, backslash, or shell/argv metacharacters.
const ARGV_SAFE_VALUE = /^[A-Za-z0-9._:@+/-]*$/;

export function isArgvSafeValue(value: string): boolean {
  return ARGV_SAFE_VALUE.test(value);
}

// org.name / site.name legitimately contain spaces ("Acme Corp"), so they
// aren't held to ARGV_SAFE_VALUE's narrow allowlist. Instead, when
// substituted into an argv-safe template (silentInstallArgs) they are
// wrapped in double quotes to keep the value as one argv element — matching
// how the agent's own splitCommandLine (agent/internal/remote/tools/
// software_install.go) re-splits the resulting string: it toggles argv
// boundaries on `"` and treats a space inside a quoted span as literal.
// EXCEPT when the template occurrence is already written inside its own
// `"..."` pair (e.g. `TRANSFORMS="{{org.name}}"`, standard MSI-property
// syntax some templates already use) — there the escaped value is inserted
// as-is and the template's own quotes do the wrapping, because doubling up
// (`""Acme Corp""`) would cancel under splitCommandLine and revert to
// unquoted. See the `alreadyQuoted` check in `substituteInstallerVariables`.
// Only characters that would break that quoting are rejected:
//   - a literal `"` — would terminate our wrapping quote early and let the
//     rest of the value supply new, unintended argv elements/flags.
//   - a control character — never a legitimate business name character.
//   - a trailing backslash — would sit directly adjacent to the closing
//     quote we append, forming a `\"` sequence that some argv parsers (e.g.
//     Windows CreateProcess-style re-quoting further down the pipeline)
//     treat as an escaped quote, even though splitCommandLine itself has no
//     backslash-escaping.
const ARGV_QUOTABLE_VALUE = /^[^"\x00-\x1f\x7f]*$/;

export function isArgvQuotableValue(value: string): boolean {
  return ARGV_QUOTABLE_VALUE.test(value) && !value.endsWith('\\');
}

function quoteForArgv(value: string): string {
  return `"${value}"`;
}

function resolveKey(
  key: string,
  ctx: InstallerVariableContext,
  isStrictVariableToken: boolean,
  argvSafe: boolean,
  alreadyQuoted: boolean,
): string | null {
  let raw: unknown;
  switch (key) {
    case 'org.name':
      raw = ctx.org.name;
      if (argvSafe && raw != null && raw !== '') {
        const str = String(raw);
        if (!isArgvQuotableValue(str)) return null;
        raw = alreadyQuoted ? str : quoteForArgv(str);
      }
      break;
    case 'org.id':
      raw = ctx.org.id;
      break;
    case 'site.name':
      raw = ctx.site.name;
      if (argvSafe && raw != null && raw !== '') {
        const str = String(raw);
        if (!isArgvQuotableValue(str)) return null;
        raw = alreadyQuoted ? str : quoteForArgv(str);
      }
      break;
    case 'site.id':
      raw = ctx.site.id;
      break;
    case 'device.hostname':
      raw = ctx.device.hostname;
      break;
    default: {
      if (key.startsWith('var.')) {
        // The var.* namespace must accept ONLY the strict `{{var.<key>}}`
        // token form shared with script content (no inner whitespace, no
        // `${{...}}` escape — see the module docblock). This tokenizer
        // normalizes whitespace and tolerates a `${{` prefix for the
        // pre-existing org.*/site.*/device.* namespaces (that regex is left
        // untouched deliberately — changing it would alter their established
        // behaviour), but extending that leniency to var.* would let an
        // installer template silently resolve a token that the
        // script-content path (`findVariableTokens`, used for save-time
        // secret rejection and dispatch substitution) treats as inert
        // literal text — a divergence between the two surfaces referencing
        // the same nominal vocabulary. So a loosely-written `{{ var.x }}`
        // (or a `$`-escaped `${{var.x}}`) is deliberately treated as unknown
        // here too, exactly like an unrecognized token.
        if (!isStrictVariableToken) return null;
        raw = ctx.vars[key.slice(4)] ?? null;
        break;
      }
      const fieldKey = CUSTOM_FIELD_KEY.exec(key)?.[1];
      if (!fieldKey) return null; // unknown token — not in the vocabulary
      raw = ctx.device.customFields?.[fieldKey];
      // Custom-field values reaching an argv position must stay inside the
      // safe charset above — treat a violation as unresolved (fail the
      // device) rather than splicing an unsafe value into the command line.
      if (argvSafe && raw != null && raw !== '' && !isArgvSafeValue(String(raw))) {
        return null;
      }
    }
  }
  // Uniform fail-loudly: a missing OR blank resolution — built-in (e.g. a device
  // with an empty hostname) or custom field — is treated as unresolved so a
  // device never ships an installer URL/args with a blank segment.
  if (raw == null || raw === '') return null;
  return String(raw);
}

export interface SubstitutionResult {
  value: string | null;
  /** Full token strings (e.g. `["{{device.customField.licenseKey}}"]`) left unresolved. */
  unresolved: string[];
}

/**
 * Substitute one template string against a device context. Pure + DB-free.
 *
 * `argvSafe` — set for a template that lands in a command line the agent
 * splits into argv (`silentInstallArgs`). When set, a custom-field value
 * containing a character outside the argv-safe charset is treated as
 * unresolved instead of being substituted verbatim.
 */
export function substituteInstallerVariables(
  template: string | null | undefined,
  ctx: InstallerVariableContext,
  options: { argvSafe?: boolean } = {},
): SubstitutionResult {
  if (template == null) return { value: null, unresolved: [] };
  if (!template.includes('{{')) return { value: template, unresolved: [] };

  const argvSafe = options.argvSafe ?? false;
  const unresolved: string[] = [];
  const value = template.replace(TOKEN, (match: string, rawKey: string, offset: number) => {
    // Per-OCCURRENCE strictness for the var.* namespace: `findVariableTokens`
    // applied to the isolated match reproduces the shared `{{var.<key>}}`
    // grammar exactly (key charset, no inner whitespace), and the manual
    // `$`-prefix check covers `${{var.x}}` — a case findVariableTokens alone
    // can't see since the `$` sits outside `match`. Computed per match (not
    // just per key) so the same key written once strictly and once loosely
    // in one template is judged independently each time.
    const isStrictVariableToken = template[offset - 1] !== '$' && findVariableTokens(match).length === 1;
    // Per-OCCURRENCE quoting: a template author who already wrote
    // `TRANSFORMS="{{org.name}}"` supplied the wrapping quotes themselves —
    // standard MSI-property syntax. If we also wrap the resolved value, the
    // two adjacent `"` pairs cancel out under the agent's splitCommandLine
    // (each `"` just toggles quote state), silently reverting the template
    // to unquoted and reintroducing the space-breaks-argv bug. So this only
    // adds quotes when the occurrence ISN'T already sitting directly inside
    // a literal `"..."` pair in the template.
    const alreadyQuoted = template[offset - 1] === '"' && template[offset + match.length] === '"';
    const resolved = resolveKey(rawKey.trim(), ctx, isStrictVariableToken, argvSafe, alreadyQuoted);
    if (resolved == null) {
      unresolved.push(match);
      return match;
    }
    return resolved;
  });
  return { value, unresolved };
}

export interface ResolvedInstallerVariables {
  downloadUrl: string | null;
  silentInstallArgs: string | null;
  /** De-duplicated unresolved tokens across both fields; non-empty ⇒ fail the device. */
  unresolved: string[];
}

/** Substitute both installer fields for one device and collect all unresolved tokens. */
export function resolveInstallerVariables(
  downloadUrl: string | null,
  silentInstallArgs: string | null,
  ctx: InstallerVariableContext,
): ResolvedInstallerVariables {
  const url = substituteInstallerVariables(downloadUrl, ctx);
  const args = substituteInstallerVariables(silentInstallArgs, ctx, { argvSafe: true });
  return {
    downloadUrl: url.value,
    silentInstallArgs: args.value,
    unresolved: [...new Set([...url.unresolved, ...args.unresolved])],
  };
}
