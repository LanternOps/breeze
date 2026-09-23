import type {
  ConnectionEntry,
  ConnectionGroup,
  ConnectionVar,
  EnvSnapshot,
  StatusResult,
} from './types';

/** The truthy vocabulary of `envFlag` (config/env.ts:12) and the M365 `flagEnabled` helpers. */
const TRUTHY_FLAG_VALUES: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'on']);

/** True when `name` holds a non-blank value. Never returns or logs the value. */
export function hasValue(env: EnvSnapshot, name: string): boolean {
  const raw = env[name];
  return typeof raw === 'string' && raw.trim().length > 0;
}

/**
 * D11: a var counts as set when either `NAME` or `NAME_FILE` is set. The
 * builder never opens the file — presence of the path is the whole check.
 */
export function isSet(env: EnvSnapshot, name: string): boolean {
  return hasValue(env, name) || hasValue(env, `${name}_FILE`);
}

/** Mirrors `envFlag(name)` truthiness. */
export function isFlagOn(env: EnvSnapshot, name: string): boolean {
  const raw = env[name];
  return typeof raw === 'string' && TRUTHY_FLAG_VALUES.has(raw.trim().toLowerCase());
}

/** "A", "A and B", "A, B and C". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function isOrAre(names: readonly string[]): string {
  return names.length === 1 ? 'is' : 'are';
}

/**
 * Default status (spec §1): all `required` vars set → enabled; none set →
 * disabled (core: required_missing); some set → misconfigured, naming the
 * missing vars. Optional vars never change the status, so compose defaults
 * such as `TURN_PORT=3478` cannot make an unconfigured entry look half-done.
 */
export function defaultStatus(
  entry: { core?: boolean; vars: readonly ConnectionVar[] },
  env: EnvSnapshot,
): StatusResult {
  const required = entry.vars.filter((v) => v.required).map((v) => v.name);
  const present = required.filter((name) => isSet(env, name));
  if (present.length === required.length) return { status: 'enabled' };
  if (present.length === 0) {
    return entry.core
      ? { status: 'required_missing', reason: `${listNames(required)} ${isOrAre(required)} not set` }
      : { status: 'disabled' };
  }
  const missing = required.filter((name) => !isSet(env, name));
  return {
    status: 'misconfigured',
    reason: `${listNames(present)} ${isOrAre(present)} set but ${listNames(missing)} ${isOrAre(missing)} missing`,
  };
}

/**
 * Feature-flag entries: every flag off → disabled; any flag on → enabled when
 * every `requiredWhenOn` var is set, otherwise misconfigured.
 */
export function flagStatus(
  flags: readonly string[],
  requiredWhenOn: readonly string[],
  env: EnvSnapshot,
): StatusResult {
  const on = flags.filter((flag) => isFlagOn(env, flag));
  if (on.length === 0) return { status: 'disabled' };
  const missing = requiredWhenOn.filter((name) => !isSet(env, name));
  if (missing.length === 0) return { status: 'enabled' };
  return {
    status: 'misconfigured',
    reason: `${listNames(on)} ${isOrAre(on)} on but ${listNames(missing)} ${isOrAre(missing)} missing`,
  };
}

/** Entries configured by any one of several alternative vars. */
export function anyOfStatus(names: readonly string[], env: EnvSnapshot): StatusResult {
  return names.some((name) => isSet(env, name)) ? { status: 'enabled' } : { status: 'disabled' };
}

export type StatusSpec =
  | { kind: 'default' }
  | { kind: 'flags'; flags: readonly string[]; requiredWhenOn: readonly string[] }
  | { kind: 'anyOf'; names: readonly string[] }
  | { kind: 'custom'; fn: (env: EnvSnapshot) => StatusResult };

export type EntrySpec = {
  id: string;
  group: ConnectionGroup;
  label: string;
  docsUrl?: string;
  core?: boolean;
  vars: readonly ConnectionVar[];
  status?: StatusSpec;
};

/**
 * Builds a registry entry and validates it at module load: every name a
 * status spec refers to must be one of the entry's vars, and a default-status
 * entry must mark at least one var `required`.
 */
export function defineEntry(spec: EntrySpec): ConnectionEntry {
  const names = new Set(spec.vars.map((v) => v.name));
  const statusSpec: StatusSpec = spec.status ?? { kind: 'default' };
  const referenced =
    statusSpec.kind === 'flags'
      ? [...statusSpec.flags, ...statusSpec.requiredWhenOn]
      : statusSpec.kind === 'anyOf'
        ? statusSpec.names
        : [];
  for (const name of referenced) {
    if (!names.has(name)) {
      throw new Error(`[connections] entry ${spec.id}: status refers to ${name}, which is not in its vars`);
    }
  }
  if (statusSpec.kind === 'flags' && statusSpec.flags.length === 0) {
    throw new Error(`[connections] entry ${spec.id}: a flags status needs at least one flag`);
  }
  if (statusSpec.kind === 'anyOf' && statusSpec.names.length === 0) {
    throw new Error(`[connections] entry ${spec.id}: an anyOf status needs at least one name`);
  }
  if (statusSpec.kind === 'default' && !spec.vars.some((v) => v.required)) {
    throw new Error(`[connections] entry ${spec.id}: default status needs at least one required var`);
  }

  const status = (env: EnvSnapshot): StatusResult => {
    switch (statusSpec.kind) {
      case 'default':
        return defaultStatus(spec, env);
      case 'flags':
        return flagStatus(statusSpec.flags, statusSpec.requiredWhenOn, env);
      case 'anyOf':
        return anyOfStatus(statusSpec.names, env);
      case 'custom':
        return statusSpec.fn(env);
    }
  };

  return {
    id: spec.id,
    group: spec.group,
    label: spec.label,
    ...(spec.docsUrl ? { docsUrl: spec.docsUrl } : {}),
    ...(spec.core ? { core: true } : {}),
    vars: spec.vars,
    status,
  };
}
