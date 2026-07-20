// Task 6 (Plan 03) web-side fixture. This is the SOURCE for the extension's
// `web.entry` (`web/index.js` per manifest.json). It is authored in
// TypeScript and BUNDLED (see `../stage.ts`, which shells out to esbuild)
// into a single self-contained ESM file before packing — per the plan's own
// "Global Constraints": "Published web modules bundle their SDK helpers; no
// host import map" (docs/superpowers/plans/2026-07-18-runtime-extension-
// platform-03-web-refined.md:20). `@breeze/extension-web-sdk`'s package.json
// `exports` even points at raw TypeScript source (`./src/index.ts`), so
// there is no npm-published browser-ready dist to import unbundled — every
// real extension author bundles this dependency, not just this fixture.
//
// Uses ONLY the public `@breeze/extension-web-sdk` surface (the three
// `parseXContextV1` functions) — no host internals, no app-private modules.
// Imported by RELATIVE path rather than the bare `@breeze/extension-web-sdk`
// specifier: `e2e-tests` is a standalone npm project (its own
// `package-lock.json`), not a member of the root pnpm workspace
// (`pnpm-workspace.yaml`: `apps/*`, `packages/*`, `extensions/*` only), so it
// has no `node_modules` entry for the package to resolve a bare specifier
// against. The relative import resolves to the exact same public
// `src/index.ts` the package's own `exports` field points at — same file,
// same API, just addressed by path instead of package name — and lets
// `tsc`/`tsx` type-check this file with zero extra dependency wiring.
// Registers the three custom elements the manifest declares
// (`e2e-fixture-page`, `e2e-fixture-device-tab`, `e2e-fixture-org-section`)
// and renders an observably-testable, digest-addressed heading plus the
// parsed context fields into `data-testid`-tagged nodes, so the Playwright
// spec can assert real content came from THIS module, not a stub.
import {
  parseDeviceDetailTabContextV1,
  parseExtensionPageContextV1,
  parseOrganizationSettingsSectionContextV1,
} from '../../../../packages/extension-web-sdk/src/index';

/** Host's ExtensionElementHost assigns `el.context = Object.freeze(context)`
 *  synchronously after `document.createElement`, before `appendChild` — so
 *  by the time `connectedCallback` fires (on append), `context` is already
 *  set. Declaring it as a class field (rather than reading via `(this as
 *  any)`) keeps every element's contract explicit and type-checked. */
abstract class FixtureElement extends HTMLElement {
  declare context?: unknown;
}

/** Builds `<tag data-testid="...">text</tag>` via safe DOM APIs
 *  (`createElement` + `textContent`) rather than `innerHTML` string
 *  interpolation — every value rendered below ultimately comes from the
 *  parsed, schema-validated context, but a fixture that models what a real
 *  extension author should do shouldn't demonstrate the unsafe pattern. */
function field(tag: string, testId: string, text: string): HTMLElement {
  const el = document.createElement(tag);
  el.setAttribute('data-testid', testId);
  el.textContent = text;
  return el;
}

class E2eFixturePage extends FixtureElement {
  connectedCallback(): void {
    const ctx = parseExtensionPageContextV1(this.context);
    const root = document.createElement('div');
    root.setAttribute('data-testid', 'e2e-fixture-page-root');
    root.append(
      field('h1', 'e2e-fixture-page-heading', 'E2E Fixture Extension'),
      field('p', 'e2e-fixture-page-extension-name', ctx.extensionName),
      field('p', 'e2e-fixture-page-path', ctx.path),
      field('p', 'e2e-fixture-page-org', ctx.organizationId),
    );
    this.replaceChildren(root);
  }
}

class E2eFixtureDeviceTab extends FixtureElement {
  connectedCallback(): void {
    const ctx = parseDeviceDetailTabContextV1(this.context);
    const root = document.createElement('div');
    root.setAttribute('data-testid', 'e2e-fixture-device-tab-root');
    root.append(
      field('h2', 'e2e-fixture-device-tab-heading', 'E2E Fixture Device Tab'),
      field('p', 'e2e-fixture-device-tab-device-id', ctx.deviceId),
      field('p', 'e2e-fixture-device-tab-org-id', ctx.organizationId),
      field('p', 'e2e-fixture-device-tab-site-id', ctx.siteId),
    );
    this.replaceChildren(root);
  }
}

class E2eFixtureOrgSection extends FixtureElement {
  connectedCallback(): void {
    const ctx = parseOrganizationSettingsSectionContextV1(this.context);
    const root = document.createElement('div');
    root.setAttribute('data-testid', 'e2e-fixture-org-section-root');
    root.append(
      field('h2', 'e2e-fixture-org-section-heading', 'E2E Fixture Org Section'),
      field('p', 'e2e-fixture-org-section-org-id', ctx.organizationId),
    );
    this.replaceChildren(root);
  }
}

// Idempotent define guards: `loadExtensionModule` (apps/web/src/lib/
// extensions/registry.ts) caches by resolved URL and imports each digest
// exactly once, so a second `customElements.define` call for the same tag
// name should never happen in practice — but a defensive guard here means a
// hot-reloaded or re-imported module (e.g. under Vite HMR during local
// fixture iteration) never throws `NotSupportedError` and takes down the
// whole extension surface.
if (!customElements.get('e2e-fixture-page')) {
  customElements.define('e2e-fixture-page', E2eFixturePage);
}
if (!customElements.get('e2e-fixture-device-tab')) {
  customElements.define('e2e-fixture-device-tab', E2eFixtureDeviceTab);
}
if (!customElements.get('e2e-fixture-org-section')) {
  customElements.define('e2e-fixture-org-section', E2eFixtureOrgSection);
}
