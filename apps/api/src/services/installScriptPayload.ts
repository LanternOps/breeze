/**
 * Builds the `preInstallScript` / `postInstallScript` objects of a
 * `software_install` command (#6958, plan D3).
 *
 * Authored script text uses the installer-variable grammar of
 * `installerVariables.ts` (`{{org.name}}`, `{{site.id}}`, `{{device.hostname}}`,
 * `{{device.customField.<k>}}`, `{{var.<k>}}`) plus the agent-filled
 * `{{install.dir}}` / `{{install.file}}`. Each token is rewritten to an
 * executor placeholder (`{{var.x}}` -> `{{var_x}}`) and its resolved value goes
 * into `parameters`. The agent's `executor.RenderParameterReferences`
 * (agent/internal/executor/paramrefs.go) then turns every placeholder into a
 * `BREEZE_PARAM_*` environment reference, so no value is ever spliced into
 * the script file. That is why no charset filter applies to values here,
 * unlike the argv-bound `silentInstallArgs`.
 *
 * `{{install_dir}}` / `{{install_file}}` get NO server value: the agent sets
 * them from its real staging paths and refuses a payload that sends either.
 *
 * Fail loudly, like installer templates: an unknown or unfillable token, a
 * value or key the agent would refuse, or two keys that fold to one
 * environment name returns `unresolved`, and the caller fails the device.
 */
import { SOFTWARE_INSTALL_SCRIPT_TIMEOUT_MS } from '@breeze/shared';
import {
  INSTALLER_VARIABLE_TOKEN,
  isStrictVariableTokenOccurrence,
  resolveInstallerVariableKey,
  type InstallerVariableContext,
} from './installerVariables';

export type InstallScriptLanguage = 'powershell' | 'bash';

export type InstallScriptPayload = {
  language: InstallScriptLanguage;
  content: string;
  parameters: Record<string, string>;
  timeoutSeconds: number;
};

export type BuildInstallScriptPayloadResult =
  | { ok: true; payload: InstallScriptPayload }
  /** `unsupportedOs`: the device OS has no install-script language. */
  | { ok: false; unresolved: string[]; unsupportedOs?: true };

/** Agent-owned placeholders (software_install_scripts.go installScriptParamDir/File). */
const AGENT_FILLED_TOKENS: Record<string, string> = {
  'install.dir': 'install_dir',
  'install.file': 'install_file',
};
const RESERVED_ENV_NAMES = new Set(Object.values(AGENT_FILLED_TOKENS).map((k) => parameterEnvName(k)));

// Mirrors the agent's limits (software_install_scripts.go): a key outside the
// executor placeholder grammar, a value with a NUL or over 8 KiB, or more than
// 64 parameters makes the agent refuse the whole payload after delivery.
const PARAM_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PARAM_VALUE_BYTES = 8192;
const MAX_PARAMS = 64;

const encoder = new TextEncoder();

export function scriptLanguageForOs(osType: string): InstallScriptLanguage | null {
  switch (osType) {
    case 'windows':
      return 'powershell';
    case 'macos':
    case 'linux':
      return 'bash';
    default:
      return null;
  }
}

/** `'var.controld_provisioning_code'` -> `'var_controld_provisioning_code'`. */
export function scriptTokenToParameterKey(token: string): string {
  return token.replace(/\./g, '_');
}

/**
 * The agent's `BREEZE_PARAM_*` name for a parameter key. MUST stay identical to
 * `parameterEnvName` in agent/internal/executor/paramrefs.go.
 */
export function parameterEnvName(key: string): string {
  return `BREEZE_PARAM_${key.replace(/-/g, '_').toUpperCase()}`;
}

/**
 * Keys that share an environment name with another key, or with an
 * agent-owned parameter. Sorted. The executor refuses a colliding set
 * (checkParameterKeyCollisions), and an agent-owned name is refused outright.
 */
export function findParameterKeyCollisions(keys: readonly string[]): string[] {
  const byEnv = new Map<string, string[]>();
  for (const key of new Set(keys)) {
    const name = parameterEnvName(key);
    byEnv.set(name, [...(byEnv.get(name) ?? []), key]);
  }
  const offenders: string[] = [];
  for (const [name, group] of byEnv) {
    if (group.length > 1 || RESERVED_ENV_NAMES.has(name)) offenders.push(...group);
  }
  return offenders.sort();
}

export function buildInstallScriptPayload(
  content: string,
  osType: string,
  ctx: InstallerVariableContext,
): BuildInstallScriptPayloadResult {
  const language = scriptLanguageForOs(osType);
  if (!language) return { ok: false, unresolved: [], unsupportedOs: true };

  const unresolved: string[] = [];
  const parameters: Record<string, string> = {};
  // parameter key -> the authored tokens that produced it, for the collision
  // message (several spellings of one token, e.g. `{{ org.name }}`, share a key).
  const tokensByKey = new Map<string, string>();

  const rendered = content.replace(INSTALLER_VARIABLE_TOKEN, (match: string, rawKey: string, offset: number) => {
    const key = rawKey.trim();
    const agentKey = AGENT_FILLED_TOKENS[key];
    if (agentKey) return `{{${agentKey}}}`;

    const value = resolveInstallerVariableKey(
      key,
      ctx,
      isStrictVariableTokenOccurrence(content, match, offset),
      false, // values travel as env references, never in argv
      false,
    );
    const paramKey = scriptTokenToParameterKey(key);
    if (
      value == null ||
      !PARAM_KEY_PATTERN.test(paramKey) ||
      value.includes('\u0000') ||
      encoder.encode(value).length > MAX_PARAM_VALUE_BYTES
    ) {
      unresolved.push(match);
      return match;
    }
    parameters[paramKey] = value;
    if (!tokensByKey.has(paramKey)) tokensByKey.set(paramKey, match);
    return `{{${paramKey}}}`;
  });

  for (const key of findParameterKeyCollisions(Object.keys(parameters))) {
    unresolved.push(tokensByKey.get(key) ?? key);
  }
  if (Object.keys(parameters).length > MAX_PARAMS) {
    unresolved.push(...[...tokensByKey.values()].slice(MAX_PARAMS));
  }
  if (unresolved.length > 0) return { ok: false, unresolved: [...new Set(unresolved)] };

  return {
    ok: true,
    payload: {
      language,
      content: rendered,
      parameters,
      timeoutSeconds: SOFTWARE_INSTALL_SCRIPT_TIMEOUT_MS / 1000,
    },
  };
}
