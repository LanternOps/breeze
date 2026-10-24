/**
 * CSS custom properties `document.css` reads from the host and does not set
 * itself, so every host app must define them in its light `:root` (the CSS
 * fallback only keeps an undefined host from painting a broken accent).
 * Package-owned `--doc-*` variables are excluded. `paperTokens.test.ts` derives the real set from `document.css`
 * and fails if this list is incomplete.
 */
export const DOCUMENT_HOST_TOKENS: readonly string[] = ['paper-primary'];
