/**
 * Tenant-variable vocabulary for the `{{var.<key>}}` pickers (#3409 PR2).
 *
 * Turns the `GET /tenant-variables` payload into the flat entry list both
 * pickers render, and derives the warn-only "this key doesn't exist" notice.
 *
 * The token grammar itself lives in `@breeze/shared` (`variableTokens.ts`) and
 * is NEVER re-implemented here — the whole point of that module is that the
 * editor, the save-time check and the dispatch-time resolver agree on exactly
 * which substrings are tokens.
 */

import { findVariableTokens, type TenantVariable } from '@breeze/shared';
import { useEffect, useState } from 'react';
import { asList } from '@/lib/asList';
import { fetchWithAuth } from '@/stores/auth';

/** One offerable variable. `value` is deliberately absent — pickers insert keys, never values. */
export interface TenantVariableEntry {
  key: string;
  description: string | null;
  isSecret: boolean;
}

/**
 * Flatten the API rows into picker entries, sorted by key.
 *
 * A key can be owned at both scopes (an org-owned row overriding a
 * partner-wide one). Resolution precedence is org-beats-partner, so the org
 * row is the one whose description/secret flag the picker must show — offering
 * both would present one token twice with contradictory hints.
 */
export function toTenantVariableEntries(rows: readonly TenantVariable[]): TenantVariableEntry[] {
  const byKey = new Map<string, TenantVariableEntry>();
  for (const row of rows) {
    if (typeof row?.key !== 'string' || row.key === '') continue;
    const existing = byKey.get(row.key);
    // First writer wins unless this row is the org-owned override.
    if (existing && row.ownerScope !== 'organization') continue;
    byKey.set(row.key, {
      key: row.key,
      description: row.description ?? null,
      isSecret: row.isSecret === true,
    });
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Load the variables visible to the current scope. `fetchWithAuth` injects the
 * active orgId, so the caller must not append one.
 *
 * Degrades to an empty list on any failure: the pickers are an affordance, not
 * a gate, and an empty list also suppresses unknown-key warnings (see
 * `findUnknownVariableKeys`) so a dead fetch can never flag a valid token.
 */
export async function fetchTenantVariableEntries(): Promise<TenantVariableEntry[]> {
  try {
    const response = await fetchWithAuth('/tenant-variables?limit=200');
    if (!response.ok) return [];
    return toTenantVariableEntries(asList<TenantVariable>(await response.json()));
  } catch {
    return [];
  }
}

/**
 * `fetchTenantVariableEntries` as mount-time state; `[]` until it resolves (or
 * if it fails). Pass `enabled: false` to defer the request — e.g. a modal that
 * is mounted closed shouldn't fetch until it opens.
 */
export function useTenantVariables(enabled = true): TenantVariableEntry[] {
  const [entries, setEntries] = useState<TenantVariableEntry[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void fetchTenantVariableEntries().then((loaded) => {
      if (!cancelled) setEntries(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return entries;
}

/**
 * Keys referenced by `content` that `knownKeys` doesn't contain, de-duplicated.
 *
 * `requireKnownKeys` defaults to false so the caller can pass
 * `knownKeys.size > 0` and accept every token on structure alone until the
 * async list arrives — the same convention `VariableInput` uses for
 * custom-field keys. An empty set must never mean "every token is unknown".
 *
 * Non-tokens (`${{var.x}}`, `{{ var.x }}`, `{{org.name}}`, Jinja, GitHub
 * Actions expressions) are invisible here because `findVariableTokens` never
 * matches them — one grammar, shared with the server.
 */
export function findUnknownVariableKeys(
  content: string,
  knownKeys: ReadonlySet<string>,
  { requireKnownKeys = false }: { requireKnownKeys?: boolean } = {},
): string[] {
  if (!requireKnownKeys) return [];
  return findVariableTokens(content).filter((key) => !knownKeys.has(key));
}
