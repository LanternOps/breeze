import { z } from 'zod';

// Browsers and browser workers enforce the web CSP. Set zod `jitless` before
// any schema is constructed so zod never probes `new Function`. The config is
// global (shared by every zod copy via globalThis), so this module is imported
// for its side effect first by the topology subpaths AND by the package barrel
// (src/index.ts). Server runtimes keep zod's JIT parser.
if ('document' in globalThis || 'WorkerGlobalScope' in globalThis) {
  z.config({ jitless: true });
}
