import { fileURLToPath } from 'node:url';

// Vite `resolve.alias` entry (array form) routing bare `zod` to the jitless shim.
// Exact-match regex: `zod/v4` etc. (imported by the shim itself) must not be rewritten.
export const zodJitlessAlias = {
  find: /^zod$/,
  replacement: fileURLToPath(new URL('./src/zodJitlessShim.ts', import.meta.url))
};
