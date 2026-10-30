import { fileURLToPath } from 'node:url';

/*
 * Breeze Assist reads the device-prompt catalog and the brand contrast maths
 * straight from packages/shared (#10190, plan P3) instead of depending on
 * @breeze/shared: that package's barrels pull in zod and the API's types,
 * which Assist deliberately does not ship (see src/lib/messageMarkdown.tsx).
 *
 * The aliases are a whitelist, not a directory mapping: only the import-free
 * files below resolve. A bare `@prompt-catalog` (the zod-backed index.ts
 * barrel), render.ts or identity.ts does not resolve at all, in Vite, Vitest
 * or tsc (tsconfig.json `paths` carries the same list). An optional `?query`
 * (e.g. `?raw` in the guard test) is passed through.
 *
 * Shared by vite.config.ts and vitest.config.ts so the build and the tests
 * resolve exactly the same files.
 */
const PROMPT_CATALOG_DIR = fileURLToPath(new URL('../../packages/shared/src/promptCatalog', import.meta.url));
const BRAND_CONTRAST_FILE = fileURLToPath(
  new URL('../../packages/shared/src/utils/brandContrast.ts', import.meta.url),
);

export const promptCatalogAliases = [
  {
    find: /^@prompt-catalog\/(catalog\/[a-z]+\.json|negotiate|sanitize)(\?.*)?$/,
    replacement: `${PROMPT_CATALOG_DIR}/$1$2`,
  },
  {
    // One file, not packages/shared/src/utils: nothing else there is reachable.
    find: /^@breeze-brand-contrast(\?.*)?$/,
    replacement: `${BRAND_CONTRAST_FILE}$1`,
  },
];

/** The directories the dev server may serve outside apps/helper. */
export const promptCatalogFsAllow = [PROMPT_CATALOG_DIR, BRAND_CONTRAST_FILE];
