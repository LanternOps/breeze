// Self-host Monaco's editor assets from our own origin instead of the
// @monaco-editor/loader default (`https://cdn.jsdelivr.net/npm/monaco-editor@<v>/min/vs`).
//
// The assets are copied from the `monaco-editor` package's `min/vs` directory
// into `public/monaco/vs` at build time by `scripts/copy-monaco-assets.ts`
// (wired into the `predev`/`prebuild` npm lifecycle), and Astro serves them
// from `'self'`. Pointing the loader here lets us drop `cdn.jsdelivr.net` from
// the CSP `script-src`/`style-src` — a broad package CDN in those directives is
// a CSP-bypass gadget host. See #1023.
//
// `@monaco-editor/react` is imported dynamically (not statically) so it stays
// out of the static bundle graph: ScriptForm deliberately lazy-loads the editor
// to dodge Astro View Transition hydration issues, and a static import here
// would pull the wrapper back into its eager chunk.
//
// Must resolve before the Monaco editor first initialises the loader; callers
// await it ahead of importing the editor component. Idempotent: once the editor
// has called loader.init(), the loader reads its config a single time, so a
// later config() is a no-op — we keep the guard so the intent is explicit and
// callers can await it freely. The flag is only set after config() succeeds, so
// a failed dynamic import doesn't latch the guard and block a later retry.
//
// The structural stylesheet (editor.main.css) is imported here, statically, so
// Astro bundles it into the CSS of every route that mounts an editor. Without
// it the AMD loader injects the stylesheet as a runtime <link> once per page
// session, and Astro's View-Transition swap rebuilds <head> from the incoming
// page's markup — dropping that link, which the loader singleton never
// re-injects. The editor then renders mangled (no gutter, offset text, stray
// scrollbar artefacts) on SPA navigation. ScriptForm carried this import for
// #1186; the approvals script-proposal card did not and regressed the same way.
// Every consumer imports this module ahead of the editor, so it is the one
// home. The CSS is self-contained (inline data: URIs), so Vite needs no asset
// resolution; `monaco-editor/min/vs/editor/editor.main.css` is aliased in
// astro.config.mjs and vitest.config.ts because monaco >=0.56 no longer
// exports the AMD `min/vs/**` subpaths.
import 'monaco-editor/min/vs/editor/editor.main.css';

let configured = false;

export async function configureMonacoLoader(): Promise<void> {
  if (configured) return;
  const { loader } = await import('@monaco-editor/react');
  loader.config({ paths: { vs: '/monaco/vs' } });
  configured = true;
}
