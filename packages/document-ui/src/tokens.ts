/**
 * CSS custom properties `document.css` reads WITHOUT a fallback and does not
 * set itself, so every host app must define them in its light `:root`.
 * Package-owned `--doc-*` variables and anything read with a fallback are
 * excluded. `paperTokens.test.ts` derives the real set from `document.css`
 * and fails if this list is incomplete.
 */
export const DOCUMENT_HOST_TOKENS: readonly string[] = ['paper-primary'];
