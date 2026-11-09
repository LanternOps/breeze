// Drop-in replacement for bare `zod` in browser bundles (web + portal Astro
// configs alias `^zod$` to this file via packages/shared/zodJitlessAlias.mjs).
//
// zod reads the global `jitless` flag when an object schema is *constructed*,
// and its JIT probe (`new Function('')`) is reported as an eval violation under
// the web CSP (`script-src 'self'`). Setting the flag here — in the module every
// importer of `zod` evaluates first — covers every browser entry regardless of
// import order, instead of relying on the barrel/topology side effect (#9972).
//
// Imports `zod/v4` (not `zod`) so the alias does not recurse. Both resolve to the
// same underlying modules, so the config is shared with the real package.
import { z } from 'zod/v4';

if ('document' in globalThis || 'WorkerGlobalScope' in globalThis) {
  z.config({ jitless: true });
}

export * from 'zod/v4';
export { z, z as default };
