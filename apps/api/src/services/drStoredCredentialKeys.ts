/**
 * DR plans store operator-authored step configuration (`dr_plan_groups.
 * restore_config`), and dispatch copies its `payload` into every device
 * command the step queues. Neither place may hold credential material: a
 * storage destination is resolved by reference from the step's snapshot when
 * the command is delivered, and nothing else a DR step runs takes a secret
 * from the plan.
 *
 * Keys are matched by NAME, case-insensitively, at any depth. The same
 * pattern is applied in SQL by the migration that cleaned existing plans
 * (2026-11-05-100500-backup-command-stored-destination-cleanup.sql) — keep the
 * two in step.
 */
export const DR_CREDENTIAL_KEY_PATTERN_SOURCE =
  '^provider[_-]?config|password|passwd|^pwd$|passphrase|secret|token$|api[_-]?key|access[_-]?key|private[_-]?key|credential|connection[_-]?string|account[_-]?key|shared[_-]?key';

const DR_CREDENTIAL_KEY_PATTERN = new RegExp(DR_CREDENTIAL_KEY_PATTERN_SOURCE, 'i');

export function isCredentialShapedKey(key: string): boolean {
  return DR_CREDENTIAL_KEY_PATTERN.test(key);
}

/** Path of the first credential-shaped key under `value`, or null. */
export function findCredentialShapedKeyPath(
  value: unknown,
  path: (string | number)[] = [],
): (string | number)[] | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findCredentialShapedKeyPath(value[i], [...path, i]);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isCredentialShapedKey(key)) return [...path, key];
    const found = findCredentialShapedKeyPath(child, [...path, key]);
    if (found) return found;
  }
  return null;
}

/** A deep copy of `value` with every credential-shaped key removed. */
export function withoutCredentialShapedKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => withoutCredentialShapedKeys(entry)) as T;
  }
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isCredentialShapedKey(key)) continue;
    out[key] = withoutCredentialShapedKeys(child);
  }
  return out as T;
}
