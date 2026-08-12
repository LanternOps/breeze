/**
 * The `{{var.<key>}}` content token grammar (#3409 PR2) — shared by the API
 * (dispatch-time resolution, save-time secret rejection) and the web (script
 * editor picker, warn-only validation) so the two surfaces can never diverge.
 */

/**
 * `{{var.<key>}}` — no inner whitespace, key grammar enforced (mirrors
 * TENANT_VARIABLE_KEY_PATTERN in ./tenantVariables), `${{...}}` excluded.
 *
 * The `(?<!\$)` lookbehind rejects a token immediately preceded by `$`
 * without consuming that character, so match offsets stay clean for
 * `String.replace`. A leading `$` means the author wrote shell or GitHub
 * Actions syntax (`${{ github.event_name }}`), not a Breeze variable — this
 * grammar must never eat that construct.
 *
 * There is exactly ONE strict token form (no inner whitespace). The existing
 * installer tokenizer normalizes whitespace on the client but only trims on
 * the server (`apps/web/src/lib/installerVariables.ts:83` vs
 * `apps/api/src/services/installerVariables.ts:79`), which already produces
 * client-passes/server-fails divergence for that namespace. Do not extend
 * that bug into `var.*` — both sides import this one pattern.
 *
 * Global: use with `matchAll` / `String.replace`, never `.test()` in a loop
 * (a global regex is stateful via `lastIndex`).
 */
export const VARIABLE_TOKEN_PATTERN = /(?<!\$)\{\{var\.([a-z][a-z0-9_]{0,63})\}\}/g;

/** `{{var.<key>}}` — the inverse of matching: build a token to insert a key. */
export function variableToken(key: string): string {
  return `{{var.${key}}}`;
}

/** Unique keys referenced in `content`, in first-seen order. */
export function findVariableTokens(content: string): string[] {
  const seen = new Set<string>();
  for (const match of content.matchAll(VARIABLE_TOKEN_PATTERN)) {
    // The capture group always participates when the outer pattern matches
    // (it is not itself optional); the `| undefined` in its type is only
    // TS's general capture-group typing under noUncheckedIndexedAccess.
    const key = match[1];
    if (key !== undefined) seen.add(key);
  }
  return [...seen];
}

export function hasVariableTokens(content: string): boolean {
  // .test() on a global regex mutates lastIndex; reset first so a caller
  // reusing VARIABLE_TOKEN_PATTERN elsewhere never sees a stale offset.
  VARIABLE_TOKEN_PATTERN.lastIndex = 0;
  return VARIABLE_TOKEN_PATTERN.test(content);
}

export interface SubstitutedVariableTokens {
  content: string;
  unresolved: string[];
}

/**
 * Substitute every `{{var.<key>}}` token in `content` with `lookup(key)`.
 *
 * A SINGLE `String.replace` pass drives the whole substitution, so a value
 * that itself contains `{{var.*}}` text is never re-scanned — no recursive
 * expansion, by construction rather than by a depth guard.
 *
 * `lookup` returning `undefined`, `null`, or `''` means the key is
 * UNRESOLVED: it is pushed to `unresolved` and the original token is left
 * untouched in the output, rather than collapsing to an empty string. An
 * empty value is unresolved for the same reason the existing installer
 * tokenizer treats it that way (`installerVariables.ts` `resolveKey`) — a
 * blank substitution should fail loudly, not ship silently as nothing.
 */
export function replaceVariableTokens(
  content: string,
  lookup: (key: string) => string | undefined | null
): SubstitutedVariableTokens {
  const unresolved: string[] = [];
  const substituted = content.replace(VARIABLE_TOKEN_PATTERN, (token, key: string) => {
    const value = lookup(key);
    if (value === undefined || value === null || value === '') {
      unresolved.push(key);
      return token;
    }
    return value;
  });
  return { content: substituted, unresolved };
}
