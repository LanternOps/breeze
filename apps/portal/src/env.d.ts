/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    /** Per-request nonce set by `src/middleware.ts` for the one runtime-themed
     *  `<style>` element the layouts emit (partner brand accent); see
     *  `src/lib/docAccent.ts`. */
    cspNonce: string;
  }
}

interface ImportMetaEnv {
  readonly PUBLIC_API_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
