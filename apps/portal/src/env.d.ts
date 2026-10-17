/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    /** Per-request nonce set by `src/middleware.ts` for the one runtime-themed
     *  `<style>` element the layouts emit (partner brand accent); see
     *  `src/lib/docAccent.ts`. */
    cspNonce: string;
    /** Set by trust pages that rendered a loaded card (200 path); the middleware
     *  only emits public Cache-Control when this is true. */
    trustCacheable?: boolean;
  }
}

interface ImportMetaEnv {
  readonly PUBLIC_API_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
