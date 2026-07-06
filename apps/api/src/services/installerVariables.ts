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
 */

export interface InstallerVariableContext {
  org: { id: string; name: string };
  site: { id: string; name: string };
  device: { hostname: string; customFields: Record<string, unknown> | null };
}

// Matches `{{ key }}` with optional inner whitespace; the key itself excludes braces.
const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const CUSTOM_FIELD_KEY = /^device\.customField\.([a-z][a-z0-9_]*)$/;

function resolveKey(key: string, ctx: InstallerVariableContext): string | null {
  switch (key) {
    case 'org.name':
      return ctx.org.name;
    case 'org.id':
      return ctx.org.id;
    case 'site.name':
      return ctx.site.name;
    case 'site.id':
      return ctx.site.id;
    case 'device.hostname':
      return ctx.device.hostname;
    default:
      break;
  }
  const custom = CUSTOM_FIELD_KEY.exec(key);
  const fieldKey = custom?.[1];
  if (fieldKey) {
    const raw = ctx.device.customFields?.[fieldKey];
    // A missing/empty custom field is unresolved on purpose — fail the device
    // loudly rather than ship an installer URL with a blank segment.
    if (raw == null || raw === '') return null;
    return String(raw);
  }
  return null;
}

export interface SubstitutionResult {
  value: string | null;
  /** Full token strings (e.g. `["{{device.customField.licenseKey}}"]`) left unresolved. */
  unresolved: string[];
}

/** Substitute one template string against a device context. Pure + DB-free. */
export function substituteInstallerVariables(
  template: string | null | undefined,
  ctx: InstallerVariableContext,
): SubstitutionResult {
  if (template == null) return { value: null, unresolved: [] };
  if (!template.includes('{{')) return { value: template, unresolved: [] };

  const unresolved: string[] = [];
  const value = template.replace(TOKEN, (match, rawKey: string) => {
    const resolved = resolveKey(rawKey.trim(), ctx);
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
  const args = substituteInstallerVariables(silentInstallArgs, ctx);
  return {
    downloadUrl: url.value,
    silentInstallArgs: args.value,
    unresolved: [...new Set([...url.unresolved, ...args.unresolved])],
  };
}
