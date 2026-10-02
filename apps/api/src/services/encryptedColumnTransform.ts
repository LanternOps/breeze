import {
  encryptSecret,
  isEncryptedSecret,
  reencryptSecret,
  shouldReencryptSecret,
} from './secretCrypto';

/**
 * The pure half of the encrypted-column registry: the column spec type, the
 * AAD constructor and the value transform that seals plaintext secrets and
 * re-seals ciphertext under the active key. No database import, so a schema
 * module (db/schema/backup.ts's sealed provider_config column) can use the
 * exact transform the rotation walker in encryptedColumnRegistry.ts runs —
 * the two can never disagree on which leaves are secret or which AAD binds
 * them. encryptedColumnRegistry.ts re-exports everything here.
 */

export type EncryptedColumnKind = 'text' | 'text-array' | 'json';

export interface EncryptedColumnSpec {
  table: string;
  column: string;
  kind: EncryptedColumnKind;
  idColumn?: string;
  /**
   * How the ciphertext is bound to its location.
   *
   * 'column' (default) — AAD is `table.column`. Stops a blob being moved
   * between COLUMNS, which is all the historical columns need: their rows are
   * addressed by an id the tenant cannot choose.
   *
   * 'row' — AAD is `table.column:<row id>`. Additionally stops a blob being
   * moved between ROWS, which for a tenant-owned column means between TENANTS:
   * without it, someone with DB write access could paste another tenant's
   * ciphertext into their own row and have the application decrypt it back to
   * them. Row-bound columns must be written by a caller that knows the row id
   * (see services/tenantVariables.ts) — the generic
   * `encryptColumnValueForWrite` helper refuses them rather than sealing a
   * value under the wrong AAD.
   */
  aadBinding?: 'column' | 'row';
  /**
   * Override the `table.column` part of the AAD. Only for a column MOVED to a
   * new table, whose existing ciphertext was sealed under its old location:
   * the tag stays the column's logical identity so every stored value still
   * decrypts (notification channel config, #6379).
   */
  aadTag?: string;
  /**
   * JSON columns only: secret leaves identified by WHERE they sit, in addition
   * to the global `SECRET_JSON_KEYS` names. For a key too generic to seal in
   * every registered JSON column (`webhooks`), or one that only names a
   * credential in one place. Each path is object keys from the column root;
   * array positions are not segments, so a path to an array covers every
   * string entry in it.
   */
  secretJsonPaths?: readonly (readonly string[])[];
  /**
   * JSON columns only: a column-specific predicate over the leaf's path (object
   * keys from the column root), checked in addition to `SECRET_JSON_KEYS` and
   * `secretJsonPaths`. For a column whose secret names are a pattern rather
   * than a fixed list, or whose secrets can be objects whose every leaf must be
   * sealed (a backup destination's service-account credentials). Must be the
   * same predicate the column's response masking uses, so a leaf sealed at rest
   * is also masked on read.
   */
  isSecretLeaf?: (path: readonly string[]) => boolean;
  description: string;
}

/**
 * The AAD string for a registered column. The single constructor for both the
 * write path and the rotation walker, so the two can never derive a different
 * binding for the same column.
 */
export function columnAad(spec: EncryptedColumnSpec, rowId?: string): string {
  const base = spec.aadTag ?? `${spec.table}.${spec.column}`;
  if (spec.aadBinding !== 'row') return base;
  if (!rowId) {
    throw new Error(`${base} is row-bound: a row id is required to derive its AAD`);
  }
  return `${base}:${rowId}`;
}

const SECRET_JSON_KEYS = new Set([
  'secret',
  'webhookSecret',
  'clientSecret',
  'accessToken',
  'refreshToken',
  'token',
  'apiKey',
  'apiSecret',
  'apiKeyValue',
  'authToken',
  'authPassword',
  'routingKey',
  'integrationKey',
  'webhookUrl',
  'password',
  'privateKey',
  'encrypted',
  'elasticsearchApiKey',
  'elasticsearchPassword',
  'community',
  'authPassphrase',
  'privacyPassphrase',
  'authPassword',
  'privPassword',
]);

function pathsEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index]);
}

/**
 * Whether the leaf at `path` (object keys from the column root) inside a
 * registered JSON column is a secret: its key is one of `SECRET_JSON_KEYS`, or
 * the path is one of the column's `secretJsonPaths`. The single definition
 * behind at-rest sealing below.
 */
export function isSecretJsonPath(
  path: readonly string[],
  secretPaths: readonly (readonly string[])[] = [],
): boolean {
  const key = path[path.length - 1];
  if (key !== undefined && SECRET_JSON_KEYS.has(key)) return true;
  return secretPaths.some((secretPath) => pathsEqual(secretPath, path));
}

// Gate AAD-binding rollout behind an env var so this branch can ship the
// machinery without forcing a v2 -> v3 rewrite across all production secrets
// at the same time. Flip to default-on once the rotation script has been run
// at least once with ENABLE_AAD_V3=true.
function aadV3Enabled(): boolean {
  return process.env.ENABLE_AAD_V3 === 'true';
}

function maybeReencryptString(value: string, force: boolean, aad?: string, alwaysAad = false): string {
  const withAad = aad && (alwaysAad || aadV3Enabled()) ? aad : undefined;
  const opts = withAad ? { aad: withAad } : undefined;
  if (isEncryptedSecret(value)) {
    return shouldReencryptSecret(value, { targetWithAad: Boolean(withAad) })
      ? reencryptSecret(value, opts) ?? value
      : value;
  }
  if (!force) {
    return value;
  }
  // Plaintext reaching a registered column is a first encryption, not a
  // rotation, so it goes through `encryptSecret`. `reencryptSecret` requires an
  // active key id and throws without one, which would fail the whole write on a
  // deployment that has not set APP_ENCRYPTION_KEY_ID — the shipped default.
  // `encryptSecret` seals to v1 under the global key in that configuration,
  // matching how every other write path degrades.
  return encryptSecret(value, opts) ?? value;
}

interface JsonSecretWalk {
  secretPaths: readonly (readonly string[])[];
  isSecretLeaf?: (path: readonly string[]) => boolean;
  aad?: string;
  alwaysAad: boolean;
}

function transformJsonSecrets(value: unknown, path: readonly string[], walk: JsonSecretWalk): unknown {
  if (typeof value === 'string') {
    const secret = isSecretJsonPath(path, walk.secretPaths) || walk.isSecretLeaf?.(path) === true;
    if (isEncryptedSecret(value) || (secret && value.length > 0)) {
      return maybeReencryptString(value, secret, walk.aad, walk.alwaysAad);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => transformJsonSecrets(entry, path, walk));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        transformJsonSecrets(entryValue, [...path, entryKey], walk),
      ])
    );
  }

  return value;
}

export function transformEncryptedColumnValue(
  spec: EncryptedColumnSpec,
  value: unknown,
  rowId?: string,
): unknown {
  // AAD binds the ciphertext to its schema location so a blob from one column
  // cannot be silently swapped into another. Only written for new v3 rows
  // (gated by ENABLE_AAD_V3); existing v2 rows continue to decrypt unchanged.
  //
  // Row-bound columns are exempt from that gate: they are new, so they have no
  // v2 rows to migrate and no flag day to coordinate. Their binding is applied
  // from the first write, which is also what makes it safe for the write path
  // and this walker to agree without consulting an env var.
  const aad = columnAad(spec, rowId);
  const alwaysAad = spec.aadBinding === 'row';

  if (spec.kind === 'text') {
    return typeof value === 'string' ? maybeReencryptString(value, true, aad, alwaysAad) : value;
  }

  if (spec.kind === 'text-array') {
    return Array.isArray(value)
      ? value.map((entry) => typeof entry === 'string' ? maybeReencryptString(entry, true, aad, alwaysAad) : entry)
      : value;
  }

  return transformJsonSecrets(value, [], {
    secretPaths: spec.secretJsonPaths ?? [],
    isSecretLeaf: spec.isSecretLeaf,
    aad,
    alwaysAad,
  });
}
