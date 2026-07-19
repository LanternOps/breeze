# Runtime Extension Web Surface — Refined Implementation Plan (Plan 03)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development, task-by-task. Checkbox (`- [ ]`) steps.

**Goal:** Let enabled runtime extensions add authenticated pages, navigation entries, and the two v1 named slots (`device.detail.tabs`, `organization.settings.sections`) without rebuilding the Breeze web image.

**This is a refinement of** `2026-07-15-runtime-extension-platform-03-web.md`, corrected against the actual code by two read-only investigations. The verified seam map is `.superpowers/sdd/plan03-seams.md` — READ IT before any task; briefs cite it.

**Base:** `feat/runtime-ext-03-web`, cut from `feat/runtime-ext-02-operations` (tip `af3a83237` — Plan 02 + the merged packer work; unmerged in PR #2617). Plan 03 stacks on it (user decision).

**Proof scope:** Task 6 = unit/component + a Playwright flow against dev servers. The full stock-image build proof is **deferred to Plan 05** (Workspace conformance), which does the definitive stock-image conformance anyway (user decision).

## Global Constraints (verified)

- `apps/api` has **no `typecheck` script**. Real command: `NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/api/tsconfig.json`. Any plan text saying `pnpm --filter @breeze/api typecheck` is wrong.
- Asset URLs: extension name + pinned digest, `Cache-Control: private, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff`, explicit `Content-Type`.
- The web registry contains **enabled** extensions only, derived from the active server snapshot **and** re-checked against live DB enable state per request (a stale process snapshot must not advertise a disabled extension).
- Extension pages live below `/extensions/:name/*`; they cannot shadow core routes.
- Supported slots are exactly `device.detail.tabs@1` and `organization.settings.sections@1`.
- Web modules may register Custom Elements, use `@breeze/extension-web-sdk`, and call the authenticated API; they may **not** import host React internals. Published web modules bundle their SDK helpers; no host import map.
- Disable removes registry entries immediately; already-mounted elements may finish current work, then unmount after the next registry refresh.
- Never expose artifact URIs, trust keys, filesystem paths, or extension config to the browser.

## Corrections baked in (do not re-derive)

- **Plan 01 manifest `web` schema already exists** (`manifest.ts:104-131`, pages/nav/slots strict + uniqueness + traversal-safety). Task 1 does NOT rebuild it; the web-SDK contracts package is the net-new piece.
- **Slot contracts are a latent blocker.** `hostDescriptor.ts:56` `slots` is `Object.freeze({})` — any manifest with web slots is reported incompatible today. Populating the two named contracts is **apps/api** work (Task 2), not SDK work.
- **Digest + integrity inventory are discarded after reconcile.** `VerifiedExtensionBundle.files` and the artifact digest are local vars in the reconcile loop (`reconciler.ts:598-654`); neither is retained. The asset route needs the inventory as its traversal allowlist and the registry needs the digest for asset URLs. Task 2 adds retention.
- **Web file citations corrected**, `Tab` is a closed union (needs widening), `OrgSettingsPage` has **no `<form>`** (the plan's "form-submit boundary" is fiction; real boundary is the error-banner split at `466-469`), e2e is at repo-root `e2e-tests/`, and there is **no Web Components precedent** (dynamic runtime-URL import needs `/* @vite-ignore */`). All in the seam map.

---

### Task 1: Public web SDK + slot contracts

**Files:** create `packages/extension-web-sdk/{package.json,tsconfig.json,src/contracts.ts,src/events.ts,src/index.ts,src/contracts.test.ts}`.

- Package mirrors `extension-sdk` conventions (private, type:module, no build, test+typecheck scripts). Dep: `zod`.
- Strict Zod parsers + TS types for `DeviceDetailTabContextV1 {contractVersion:1,deviceId,organizationId,siteId}`, `ExtensionPageContextV1 {contractVersion:1,extensionName,path,organizationId}`, `OrganizationSettingsSectionContextV1 {contractVersion:1,organizationId}`.
- `ExtensionHostEventV1` union: `navigate{path}` | `toast{tone,message}` | `refresh-registry`. `dispatchExtensionHostEvent()` emits a bubbling, composed `breeze-extension-event`.
- Navigation validation accepts only `/extensions/<current-extension>/...`; rejects absolute URLs, protocol-relative, encoded traversal, backslashes.
- TDD: contract tests first (accept minimum device context; reject out-of-namespace navigate). Verify: `pnpm -F @breeze/extension-web-sdk test && pnpm -F @breeze/extension-web-sdk typecheck`.
- Note: the manifest schema already validates slot *shape*; do NOT add a name→version whitelist here — that lives in the host descriptor (Task 2).

### Task 2: API foundation — slot host descriptor + retained bundle info

**Files:** modify `apps/api/src/extensions/hostDescriptor.ts`, `reconciler.ts`, `faultAttribution.ts` (or a new `webAssets.ts` holding the retained map); new tests.

**This is the under-stated foundation. Do it before the registry/asset routes.**

- **Populate the slot contracts:** set `HOST_DESCRIPTOR.slots` (or a dedicated web-host descriptor consumed by `compatibility.ts:46-50`) to `{ 'device.detail.tabs':[1], 'organization.settings.sections':[1] }`. Add a test proving a manifest declaring `device.detail.tabs@1` now passes compatibility, and `@2` / an unknown slot still fails. Verify the tripwire: with the map empty, the accept-test must fail.
- **Retain per-active-extension info:** alongside `registerExtensionRoot`/`clearExtensionRoot` (`reconciler.ts:653`), capture `{ digest: bundle.artifactDigest, files: bundle.files }` into a snapshot map (mirroring `extensionRootsSnapshot()`), cleared on withdraw/failure. Expose an accessor `(name) => { root, digest, files } | undefined`. This is the single source both later routes read.
- Verify: focused tests + `apps/api` typecheck (real command).

### Task 3: Authenticated web registry API + digest-addressed assets

**Files:** create `apps/api/src/extensions/webRegistry.ts` (+test), `apps/api/src/routes/extensionsWeb.ts` (+test); modify `apps/api/src/index.ts`.

- `buildRuntimeWebRegistry(snapshots)` → `{ apiVersion:'breeze.extensions.web/v1', revision, extensions[] }`. Sort by name then contribution id; `revision` = sha256 of the canonical projection. Per extension include only browser-needed public fields: name, version, **digest (from Task 2's map)**, module URL, page/nav/slot descriptors from `manifest.web`. Never expose URIs/keys/paths/config.
- `GET /api/v1/extensions/registry` — authed (`authMiddleware`), projects only enabled contributions, **re-checks `stateStore.isEnabled(name)`** per the `runOutsideDbContext(withSystemDbAccessContext)` idiom.
- `GET /api/v1/extensions/assets/:name/:digest/*` — resolve the requested member against Task 2's retained `{root, files}`: it must be in the verified inventory (the allowlist) AND resolve below the extraction root; digest must match the active record. Allow `.js/.mjs/.css/.json/.wasm/.svg/.png/.jpg/.jpeg/.gif/.webp/.woff2`; reject `.node`, source maps, HTML, unknown. Set nosniff + specific Content-Type + immutable cache. Re-hash bytes with `assertVerifiedMemberBytes` (TOCTOU).
- Mount as a `createExtensionsWebRoutes(deps)` factory + production singleton, mirroring `extensionsAdmin.ts`; test with mocked auth + injected fakes.
- Security tests (from plan): unauthenticated → 401; `../server/index.cjs`, `%2e%2e/...`, `module.node` → 404; digest mismatch, disabled, missing integrity entry, disallowed content type, symlink escape all rejected.

### Task 4: Browser registry client + page host + Custom-Element bridge

**Files:** create `apps/web/src/lib/extensions/registry.ts` (+test), `apps/web/src/components/extensions/ExtensionElementHost.tsx` (+test), `ExtensionPageHost.tsx`, `apps/web/src/pages/extensions/[name]/[...path].astro`.

- Registry client wraps `fetchWithAuth` (mirror `src/lib/api/catalog.ts`), caches by `revision`, validates before use, keeps one in-flight promise per immutable module URL (no double-import). Dynamic import is `import(/* @vite-ignore */ approvedSameOriginUrl)` only after registry lookup + origin/path validation. Clear cache on `refresh-registry` event and on auth change.
- `ExtensionElementHost` creates the declared element via `document.createElement()`, assigns a **frozen** `context`, appends to a host ref. Listens only for typed `breeze-extension-event`: `navigate` → `navigateTo()`, `toast` → `showToast()`, reject malformed/out-of-namespace. Error boundary attributes failures by extension+element, no stack to user. (First Web Component in the app — no precedent; keep it framework-independent.)
- `[...path].astro` validates name+path, renders the normal authenticated layout, hydrates `ExtensionPageHost`, which resolves the page descriptor and passes `{contractVersion:1,extensionName,path,organizationId}` with `organizationId` from `useOrgScope()` (not a query string). Absent/disabled → standard not-found. One generic route, not one file per extension.
- Verify: focused web tests + `pnpm -F @breeze/web typecheck`.

### Task 5: Navigation injection + the two named slots

**Files:** create `apps/web/src/components/extensions/{useExtensionNavigation.ts,ExtensionSlotHost.tsx}` (+tests); modify `Sidebar.tsx`, `DeviceDetails.tsx`, `OrgSettingsPage.tsx`.

- **Sidebar:** append one "Extensions" `NavSection` (to `navSections`, ~192-366) after core sections, items from enabled runtime navigation sorted by `order` → name → id. Re-validate every href. Preserve permission/mobile-collapse; a registry failure hides only the Extensions section.
- **DeviceDetails:** widen `Tab` to admit `ext:<name>:<id>` (update the union 76-104 and `tabFromHash`/`VALID_TABS` 154-192), append registry tab descriptors to the inline `tabs` array (245-441), render one `ExtensionSlotHost` in a new `{activeTab === extId && ...}` block (484-739). Pass only `{contractVersion:1,deviceId,organizationId,siteId}`. Preserve hash behavior + all core branches.
- **OrgSettingsPage:** append a `TAB_GROUPS` entry AND a matching `renderContent()` case (both, or nav silently breaks) — mirror the `Pax8OrgTab` bolt-on (case ~563). Render enabled sections in deterministic order, context `{contractVersion:1,organizationId}`. Do NOT touch the error-banner-vs-full-page split (466-469).
- Tests: namespaced links after core nav; documented device-context only (no full device/org leak); deterministic order; no links for disabled; hash-safe ext tab ids.

### Task 6: Prove web security + runtime disable (Playwright, dev servers)

**Files:** create `e2e-tests/tests/runtime-extensions.spec.ts` (+ a Page Object if needed) and a signed fixture extension; modify `e2e-tests` config only if required. **Not** `apps/web/e2e/`.

- Flow: sign+stage the fixture via Plan 02 helpers, log in (existing `AuthPage`/fixtures), open its page, find its sidebar entry + device tab, disable via admin API, refresh registry, verify all three contributions disappear, re-enable, verify they return.
- CSP/module-loading: confirm `script-src 'self'`, no `unsafe-eval`; a forged registry response with a remote module URL must be rejected by the loader. (Confirm which CSP mechanism — `astro.config.mjs` vs `middleware.ts` — is authoritative before asserting.)
- **Defer** the stock-image build proof to Plan 05. Note the deferral in the test file and the plan-verification checklist.
- Verify: `pnpm -F @breeze/web test && pnpm -F @breeze/web typecheck` + the Playwright spec against dev servers.

## Plan Verification

- [ ] `pnpm -F @breeze/extension-web-sdk test && pnpm -F @breeze/extension-web-sdk typecheck`.
- [ ] `pnpm -F @breeze/api test:run src/extensions src/routes/extensionsWeb.test.ts` + `apps/api` tsc (real command).
- [ ] `pnpm -F @breeze/web test && pnpm -F @breeze/web typecheck`.
- [ ] Playwright runtime-extensions flow passes against dev servers; browser network log shows the module fetched only from `/api/v1/extensions/assets/...`.
- [ ] Disabling removes new requests + registry entries while an in-flight request finishes.
- [ ] Slot-contract tripwire proven (empty host-descriptor slots ⇒ activation fails).
- [ ] Stock-image conformance explicitly deferred to Plan 05 (recorded).
