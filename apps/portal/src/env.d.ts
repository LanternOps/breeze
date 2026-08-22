/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    /**
     * Per-request nonce set by `src/middleware.ts`, allowing the single
     * runtime-themed `<style>` element the layouts emit for the partner brand
     * accent. The production CSP bans inline style *attributes*
     * (`style-src-attr 'none'`), so this is how a per-partner colour reaches
     * the page without reopening them. See `src/lib/docAccent.ts`.
     */
    cspNonce: string;
  }
}

interface ImportMetaEnv {
  readonly PUBLIC_API_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
