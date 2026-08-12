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
 * NOT global, and deliberately so: a module-level global regex carries
 * mutable `lastIndex` state, and every consumer here shares this one module
 * instance across the whole process. `.test()` on a global regex advances
 * `lastIndex`, and `String.prototype.matchAll` SEEDS its internal matcher from
 * the regex it is handed — so one `hasVariableTokens()` call would leave an
 * offset behind that made a later `findVariableTokens()` silently skip every
 * token before it. Since API requests interleave across `await` points, that
 * desynchronised two different requests through one shared offset.
 *
 * Scanning for ALL tokens therefore goes through
 * {@link createVariableTokenMatcher}, which mints a fresh, independently
 * stateful matcher per call. This constant stays non-global so that sharing it
 * is safe: `.test()` and `.exec()` on a non-global regex never touch
 * `lastIndex`.
 */
export const VARIABLE_TOKEN_PATTERN = /(?<!\$)\{\{var\.([a-z][a-z0-9_]{0,63})\}\}/;

/**
 * A FRESH global matcher for the token grammar. Never hoist the result into a
 * shared binding — `lastIndex` is per-instance state, and sharing one instance
 * across calls is exactly the bug the comment above describes.
 */
export function createVariableTokenMatcher(): RegExp {
  return new RegExp(VARIABLE_TOKEN_PATTERN.source, 'g');
}

/** `{{var.<key>}}` — the inverse of matching: build a token to insert a key. */
export function variableToken(key: string): string {
  return `{{var.${key}}}`;
}

/** Unique keys referenced in `content`, in first-seen order. */
export function findVariableTokens(content: string): string[] {
  const seen = new Set<string>();
  for (const match of content.matchAll(createVariableTokenMatcher())) {
    // The capture group always participates when the outer pattern matches
    // (it is not itself optional); the `| undefined` in its type is only
    // TS's general capture-group typing under noUncheckedIndexedAccess.
    const key = match[1];
    if (key !== undefined) seen.add(key);
  }
  return [...seen];
}

export function hasVariableTokens(content: string): boolean {
  // Safe to share the module-level instance: VARIABLE_TOKEN_PATTERN is
  // non-global, so .test() leaves no lastIndex behind for the next caller.
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
 * UNRESOLVED: it is reported in `unresolved` and the original token is left
 * untouched in the output, rather than collapsing to an empty string. An
 * empty value is unresolved for the same reason the existing installer
 * tokenizer treats it that way (`installerVariables.ts` `resolveKey`) — a
 * blank substitution should fail loudly, not ship silently as nothing.
 *
 * `unresolved` is de-duplicated: it feeds a user-facing failure message, and
 * a key written three times in one script is still one missing variable.
 *
 * Note the replacement is a FUNCTION, not a string — so a value containing
 * `$&` or `$1` is inserted verbatim instead of being re-interpreted as a
 * replacement pattern. Values substitute exactly as stored, with no escaping.
 */
export function replaceVariableTokens(
  content: string,
  lookup: (key: string) => string | undefined | null
): SubstitutedVariableTokens {
  const unresolved = new Set<string>();
  const substituted = content.replace(createVariableTokenMatcher(), (token, key: string) => {
    const value = lookup(key);
    if (value === undefined || value === null || value === '') {
      unresolved.add(key);
      return token;
    }
    return value;
  });
  return { content: substituted, unresolved: [...unresolved] };
}
