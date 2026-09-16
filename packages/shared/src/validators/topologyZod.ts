import { z } from 'zod';

// Browsers and browser workers enforce the web CSP. Disable the optional eval
// probe before any topology schema is constructed; preserve the server parser.
if ('document' in globalThis || 'WorkerGlobalScope' in globalThis) {
  z.config({ jitless: true });
}
