# Task 6 report — Playwright proof of web security + runtime disable/re-enable

**Status:** DONE_WITH_CONCERNS
**Branch:** `feat/runtime-ext-03-web`
**Scope:** final task of Plan 03 (runtime web extensions)

> This path previously held (and, per the task-6-brief convention noted in
> the Plan 02 report, is expected to hold in each task's own report) the
> Task 6 deliverable for **this** plan — Plan 03. It is overwritten here.

---

## 1. What was built

### 1.1 Fixture extension — `e2e-tests/fixtures/runtime-extension/`

A minimal but genuinely multi-surface extension, name `e2e-fixture`:

| File | Purpose |
|---|---|
| `manifest.json` | Declares `web.entry: web/index.js`, one page (`/` → `e2e-fixture-page`), one nav item (label "E2E Fixture", order 1), and two slots: `device.detail.tabs@1` → `e2e-fixture-device-tab`, `organization.settings.sections@1` → `e2e-fixture-org-section`. `server.entry` points at a no-op server module (schema-mandatory even for a web-only extension). |
| `server/index.cjs` | `module.exports = { register() {} }` — contributes nothing server-side; exists only to satisfy the manifest schema. |
| `web/index.ts` | Source for `web.entry`. Registers all three custom elements using **only** the public `@breeze/extension-web-sdk` surface (`parseExtensionPageContextV1`, `parseDeviceDetailTabContextV1`, `parseOrganizationSettingsSectionContextV1`) — imported by **relative path** (`../../../../packages/extension-web-sdk/src/index`), not the bare `@breeze/extension-web-sdk` specifier, because `e2e-tests` is a standalone npm project (its own `package-lock.json`), **not** a member of the root `pnpm-workspace.yaml` (`apps/*`, `packages/*`, `extensions/*` only) — there is no `node_modules` entry to resolve a bare specifier against. Each element renders `data-testid`-tagged, parsed-context-derived text via safe DOM APIs (`createElement`/`textContent`, not `innerHTML`). |
| `stage.ts` | Build/pack/sign helper (`pnpm --filter @breeze/e2e-tests run stage:runtime-extension-fixture`). Bundles `web/index.ts` → self-contained ESM via the esbuild binary already present at `packages/extension-web-sdk/node_modules/.bin/esbuild` (a transitive vitest dependency — no new `esbuild` dependency added anywhere), then packs + signs with the **real** `@breeze/extension-cli` by shelling out to `pnpm --filter @breeze/extension-cli exec tsx src/cli.ts pack/sign` (same reason as above: `e2e-tests` can't `import` the CLI package directly). Generates a fresh Ed25519 keypair every run. Prints the exact `breezectl extensions install ...` command, the artifact URI/digest/publisher-key paths, and the restart requirement. |

**Verified working end-to-end, offline, this session:**
```
$ pnpm --filter @breeze/e2e-tests run stage:runtime-extension-fixture
Fixture built and signed:
  digest: sha256:37fc3b00898863dea351ea7649b0e7a34a9a72ad27a14d4c32fc2db9a38e14fe
  ...

$ pnpm --filter @breeze/extension-cli exec tsx src/cli.ts inspect <signed.breeze-ext> --public-key <publisher.pem>
digest: sha256:37fc3b00898863dea351ea7649b0e7a34a9a72ad27a14d4c32fc2db9a38e14fe
name: e2e-fixture
version: 1.0.0
apiVersion: breeze.extensions/v1
signature: valid
integrity: ok
migrations: none
```
This proves the manifest is schema-valid, the payload is well-formed, and the signature verifies against the public key — the full Plan 02 packer/signer chain accepts this fixture.

### 1.2 Page Object — `e2e-tests/pages/RuntimeExtensionPage.ts`

Locates the fixture's **own** content entirely by `data-testid` (per `e2e-tests/README.md`'s hard rule). Locates the three **host-chrome** entry points — Sidebar nav link, `DeviceDetails` tab button — by `href`/label text instead, since neither carries a `data-testid` today and Task 6's brief scopes file changes to `e2e-tests/` + the fixture, not `apps/web/src` (`Sidebar.tsx`, `DeviceDetails.tsx`). This is documented as an explicit, deliberate deviation in the Page Object's header comment, with a one-line follow-up recommendation (add `data-testid` to those two host components in a task that owns them). The org-settings slot's *content* container already carries `data-testid="org-tab-extensions"` (pre-existing, Task 5) so no deviation was needed there.

### 1.3 Spec — `e2e-tests/tests/runtime-extensions.spec.ts` (5 tests)

| Test | file:line | Asserts |
|---|---|---|
| `fixture is staged and enabled; page + nav + both slots render its content` | :141 | Sidebar nav link → page host renders (`e2e-fixture-page-heading`, `-extension-name`, `-path`); every network request the page issued during this flow is same-origin, and at least one hits `/api/v1/extensions/assets/e2e-fixture/...`; navigates to the seeded device, opens the `device.detail.tabs@1` tab, asserts rendered `deviceId`; resolves the current org id from `localStorage['breeze-org']` and asserts the `organization.settings.sections@1` content. |
| `served CSP forbids unsafe-eval and only allows script-src self (+ the one pinned Cloudflare host)` | :190 | Reads the `Content-Security-Policy` **response header** on the extension page; asserts `script-src` contains no `unsafe-eval`/`unsafe-inline` and every source token is either `'self'` or the one pinned `https://static.cloudflareinsights.com` host. |
| `SECURITY: a forged registry response advertising a remote moduleUrl is never fetched` | :232 | Intercepts `GET /api/v1/extensions/registry`, rewrites the fixture's `moduleUrl` to `https://evil.example.test/module.js`, reloads the page; asserts the fallback `extension-element-unavailable` renders (not the real content) **and** that no request URL ever started with the forged origin — i.e. the loader's same-origin check (`assertSameOriginAssetUrl`) rejected it before any `import()`/fetch was attempted, not merely that CSP blocked it after the fact. |
| `disable removes the nav entry, page, and both slot contributions without a restart` | :269 | Calls the platform-admin `disable` endpoint (Node-side HTTP, not through the browser session — see §2), reloads, asserts the sidebar link, page (now `extension-page-not-found`), device tab button, and org section content all disappear. |
| `re-enable restores the nav entry, page, and both slot contributions` | :300 | Calls `enable`, reloads, asserts all four surfaces return. |

The stock-image deferral is recorded both as a spec-file comment (top of `runtime-extensions.spec.ts`, "STOCK-IMAGE BUILD PROOF: DEFERRED TO PLAN 05" section) and by checking off the corresponding item in `docs/superpowers/plans/2026-07-18-runtime-extension-platform-03-web-refined.md`'s "Plan Verification" list.

### 1.4 Why the admin disable/enable calls don't ride the browser session

The seeded E2E login user (`E2E_ADMIN_EMAIL` / `admin@breeze.local`, created by `apps/api/src/db/seed.ts` `seedDefaultAdmin`) is **not** granted `isPlatformAdmin` by any seed script in this repo (`grep -rn "isPlatformAdmin" apps/api/src/db/*.ts apps/api/scripts/*.ts` — zero hits), and `extensionsAdminRoutes` requires `platformAdminMiddleware` (`isPlatformAdmin === true`). So the spec's `setEnabled()` helper makes a separate `request.post(...)` call with `Authorization: Bearer ${BREEZE_ADMIN_TOKEN}` — the exact same env var and transport `breezectl extensions enable/disable` itself uses (`apps/api/scripts/breezectl.lib.ts`) — rather than assuming the browser's authed session has admin rights.

---

## 2. CSP mechanism — which is authoritative, and how I confirmed it

**Two mechanisms exist and I read both fully, plus the Astro source that implements the CSP feature (not just its docs):**

- `apps/web/astro.config.mjs:76-79` (`security.csp.directives` + `scriptDirective.resources: ["'self'", 'https://static.cloudflareinsights.com']`) — Astro's built-in CSP feature.
- `apps/web/src/middleware.ts` (+ `src/lib/csp.ts`) — a hand-rolled `onRequest` middleware that sets `Content-Security-Policy` and other security headers on every response.

**Finding: `middleware.ts` is the sole mechanism that produces an actual HTTP response header when this spec's target — `astro dev` — is running. `astro.config.mjs`'s CSP is inert in dev mode entirely.**

Confirmed by reading the installed Astro package's own source, not just the doc comment:
- `apps/web/node_modules/astro/dist/types/public/config.d.ts` (`security.csp` doc comment): *"Due to the nature of the Vite dev server, this feature isn't supported while working in `dev` mode. Instead, you can test this in your Astro project using `build` and `preview`."* Also: *"Astro will add a `<meta>` element inside the `<head>`"* — i.e. even when active, it is a **meta tag**, not a header, for prerendered routes.
- `apps/web/node_modules/astro/dist/core/app/dev/app.js:60`: the dev server's `App` is constructed with `shouldInjectCspMetaTags: false` unconditionally.
- `apps/web/node_modules/astro/dist/core/fetch/fetch-state.js:304`: `cspDestination: manifest.csp?.cspDestination ?? (routeData.prerender ? "meta" : "header")` — for a genuinely built/served **SSR** route in *production*, Astro *can* set an actual `content-security-policy` response header (not just a meta tag) — but only when `shouldInjectCspMetaTags` is true, which requires `settings.config.security.csp` truthy AND the request going through the **build** pipeline (`plugin-manifest.js`), never the dev server (`shouldInjectCspMetaTags: false` there, confirmed above).
- `apps/web/node_modules/astro/dist/runtime/server/render/page.js:29,61`: the header-injection branch (`headers.set("content-security-policy", ...)`) is gated on `result.shouldInjectCspMetaTags && (cspDestination === "header" || "adapter")`.

So: in `astro dev` (this spec's target — "Playwright proof ... against dev servers"), Astro's own CSP is **completely inert** — no meta tag, no header, nothing. `middleware.ts`'s `onRequest` is therefore the **only** thing that can put a `Content-Security-Policy` header on a response in this environment, and even that is **off by default** in dev:

```ts
// middleware.ts
if (import.meta.env.DEV && !strictDevCsp) {
  headers.delete('Content-Security-Policy');
  ...
}
```

`strictDevCsp = import.meta.env.DEV && readFlag('CSP_STRICT_DEV')`. **`CSP_STRICT_DEV=1` on the web dev server is therefore a hard prerequisite for the CSP test to have anything to assert on at all** — documented as a comment directly above the assertion in the spec, and the test fails with an explicit, actionable message (not a confusing `undefined` diff) if the header is absent.

When `CSP_STRICT_DEV=1` and no `CSP_ALLOW_*` escape hatches are set, `buildFallbackCspDirectives({ allowInlineScript: false, ... })` emits `script-src 'self' https://static.cloudflareinsights.com` — no `unsafe-eval`, no `unsafe-inline` — which is what the spec asserts (source-by-source, not a brittle exact-string match, since the directive legitimately carries the one pinned Cloudflare host alongside `'self'`).

(Separately, in a real **production build+adapter** deployment — not this spec's target — both mechanisms can be simultaneously live: Astro's own header/meta for SSR routes, patched-but-not-overridden by `middleware.ts`, which only appends `script-src-attr`/`style-src-elem`/`style-src-attr` and other headers when an existing CSP is already present. `middleware.ts` never removes or replaces `script-src` if Astro already set one. That production interplay is out of this spec's scope, which explicitly targets dev servers.)

---

## 3. A blocker discovered while writing this spec (NOT fixed — outside Task 6's file scope)

`apps/api/src/extensions/hostDescriptor.ts:59` hardcodes `HOST_DESCRIPTOR.webSdkVersion: undefined`. Per Task 2's own report (`.superpowers/sdd/task-2-report.md:156-161`): *"Left `HOST_DESCRIPTOR.webSdkVersion` unchanged (still `undefined`) — out of scope per the task ... a manifest with `web.slots` still also needs `requires.webSdk` (schema-mandatory once `web` is declared), which will still fail compatibility at the API tier on that separate, deliberate gap."* Neither Task 3, 4, nor 5 touched it (`grep -n "webSdkVersion\|HOST_DESCRIPTOR" .superpowers/sdd/task-{3,4,5}-report.md` — zero hits).

`checkExtensionCompatibility` (`compatibility.ts:32-38`) unconditionally adds `"unsupported web SDK range ..."` whenever `manifest.requires.webSdk !== undefined && host.webSdkVersion === undefined` — and `requires.webSdk` is schema-mandatory the instant `manifest.web` is present (`packages/extension-sdk/src/manifest.ts` superRefine: *"webSdk is required when web is declared"*).

**I confirmed this empirically, not just by reading**, with a throwaway vitest case (`apps/api/src/extensions/__zzz_compat_check.test.ts`, run then deleted — not part of the committed diff) that ran `checkExtensionCompatibility(fixtureManifest, HOST_DESCRIPTOR)` — the *real*, unmodified, shipped `HOST_DESCRIPTOR`:

```
AssertionError: expected [ 'unsupported web SDK range *' ] to deeply equal []
```

**Consequence:** on this branch as it stands through Task 5, `reconcileExtensions()` will mark **any** extension that declares `web` (not just this fixture) `lifecycleState: 'incompatible'` and never activate it — independent of whether a dev stack is reachable. This is why the spec is environment-gated for a *second*, more fundamental reason than "no stack was running": even with a stack up, staging this (or any) web-bearing extension against the real, current `HOST_DESCRIPTOR` will fail at the compatibility gate today.

I did **not** fix this. It sits in `apps/api/src/extensions/hostDescriptor.ts`, outside Task 6's stated file scope ("create `e2e-tests/tests/runtime-extensions.spec.ts` + Page Object + fixture; modify `e2e-tests` config only if required"). The fix is small and has a precedent to mirror exactly: `HOST_SERVER_SDK_VERSION`/`HOST_BREEZE_VERSION` are pinned constants read from real `package.json` files and asserted against by `hostDescriptor.test.ts`; the same pattern (pin `webSdkVersion` to `packages/extension-web-sdk/package.json`'s `"version"`, add the matching assertion) would close this. Flagging for whoever picks up this thread next (a follow-up task, or before Plan 05's stock-image conformance run, which will hit the exact same wall).

---

## 4. Offline gate results (all run this session)

```
$ pnpm -F @breeze/web test
 Test Files  475 passed (475)
      Tests  4208 passed (4208)
 (jsdom "Not implemented: navigation to another Document" lines are pre-existing warnings, not failures)

$ pnpm -F @breeze/web exec astro check
Result (1433 files):
- 0 errors
- 0 warnings
- 225 hints

$ pnpm -F @breeze/api test:run src/extensions src/routes/extensionsWeb.test.ts
 Test Files  21 passed (21)
      Tests  259 passed (259)

$ NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/api/tsconfig.json
(exit 0, no output)

$ cd e2e-tests && npx tsc --noEmit -p tsconfig.json     # new tsconfig, see §5
(exit 0, no output)

$ cd e2e-tests && npx playwright test --list tests/runtime-extensions.spec.ts
Total: 5 tests in 1 file    # spec parses and collects correctly
```

None of these gates were previously touched by this task, so they double as a regression check on Tasks 1-5's work — all green, unaffected.

---

## 5. Whether a dev stack was reachable — it was not

Checked, this session: no `.breeze-stack.json` in `e2e-tests/`, `E2E_BASE_URL` unset, `curl --max-time 3 http://localhost:4321` → connection refused, `curl --max-time 3 http://localhost:3001/api/v1/health` → connection refused. Per the task instructions, I did not attempt to stand up Postgres+API+web+store — out of scope and expensive, and (per §3) would hit the `HOST_DESCRIPTOR.webSdkVersion` wall regardless.

**Exact command to run this spec against a real stack, once §3's blocker is fixed:**

```bash
# 1. Build + sign the fixture (offline, verified working this session):
pnpm --filter @breeze/e2e-tests run stage:runtime-extension-fixture

# 2. Install it into your dev stack's extensions.yaml (command is printed by
#    step 1, tailored to that run's artifact path/digest/pubkey):
BREEZE_EXTENSIONS_CONFIG=/path/to/extensions.yaml \
pnpm --filter @breeze/api run breezectl:dev -- extensions install \
  --name e2e-fixture --uri file:///.../signed.breeze-ext \
  --version 1.0.0 --digest sha256:<...> --publisher e2e-fixture-publisher

# 3. Restart the API process (reconcileExtensions() only runs at boot).

# 4. Start the web dev server with CSP_STRICT_DEV=1 (required for the CSP
#    test — see §2) and BREEZE_ADMIN_TOKEN set to a platform-admin access
#    token (required for the disable/enable tests — see §1.4).

# 5. Run it:
cd e2e-tests
BREEZE_ADMIN_TOKEN=<platform-admin token> \
E2E_BASE_URL=http://localhost:4321 \
E2E_API_URL=http://localhost:3001 \
npx playwright test tests/runtime-extensions.spec.ts
```

Without `BREEZE_ADMIN_TOKEN` set, the suite self-skips with an explicit reason (`test.skip` at the top of the `describe` block) rather than failing confusingly.

---

## 6. Files changed

**Created**
- `e2e-tests/fixtures/runtime-extension/manifest.json`
- `e2e-tests/fixtures/runtime-extension/server/index.cjs`
- `e2e-tests/fixtures/runtime-extension/web/index.ts`
- `e2e-tests/fixtures/runtime-extension/stage.ts`
- `e2e-tests/pages/RuntimeExtensionPage.ts`
- `e2e-tests/tests/runtime-extensions.spec.ts`
- `e2e-tests/tsconfig.json` (no project-wide tsconfig existed for `e2e-tests`; added a minimal one — `pages/**`, `tests/**`, `fixtures/**`, top-level `*.ts` — scoped to exclude `perf-harness/`/`doc-verify/`/`live-signup/`, which have their own tooling/aren't this task's concern)

**Modified**
- `e2e-tests/package.json` — added `stage:runtime-extension-fixture` script. No new dependencies (see §1.1/§1.3 for why the CLI/SDK are invoked by shelling out / relative import instead).
- `e2e-tests/package-lock.json` — regenerated by `npm install` (first install in this worktree — `node_modules` was empty); diff is npm normalizing optional-binary `libc` metadata only, no dependency-graph change.
- `e2e-tests/.gitignore` — added `fixtures/runtime-extension/build/` (the freshly-generated-per-run artifact + private key must never be committed).
- `docs/superpowers/plans/2026-07-18-runtime-extension-platform-03-web-refined.md` — checked off the "Stock-image conformance explicitly deferred to Plan 05" Plan Verification item. No other items checked (not verified live this session).

---

## 7. Self-review

- Fixture contributes exactly the four surfaces the brief asked for (nav, page, device tab, org section) — no more, no less — and its manifest actually validated + packed + signed + verified through the real Plan 02 toolchain this session, not just written and assumed correct.
- The spec's security assertions target genuine behavior, not proxies: the forged-`moduleUrl` test asserts on the absence of any network request to the foreign origin (the loader's synchronous pre-import check), not merely "CSP would have blocked it" — those are different claims and I kept them separate in the comment.
- CSP mechanism determination was done by reading the actual installed Astro source (`node_modules/astro/dist/...`), not inferred from the doc comment alone — the doc comment and the source agree, but I wanted the source to be the citation.
- The `HOST_DESCRIPTOR.webSdkVersion` blocker (§3) was verified empirically with a real (throwaway, deleted) test against the actual shipped code, not asserted from reading alone.
- Kept strictly within the brief's file scope: no changes to `apps/web/src` or `apps/api/src` (the Page Object's host-chrome-locator deviation is the direct, documented consequence of honoring that boundary rather than quietly adding testids elsewhere).
- Did not fabricate a "live run passed" claim anywhere — the report states plainly, twice, that the live run did not happen and why.

## 8. Concerns

1. **(Blocking for any future live run, not just mine) `HOST_DESCRIPTOR.webSdkVersion` gap — §3.** Confirmed via a real test run against the shipped code. This is the single most important finding in this report; it blocks Plan 03's live proof (this spec) and will also block Plan 05's stock-image conformance work unless fixed first. Recommend a small follow-up task before either.
2. **Host-chrome locators (Sidebar nav link, device tab button) use `href`/text, not `data-testid`** — a deliberate, documented deviation from `e2e-tests/README.md`'s hard rule, forced by Task 6's file-scope boundary. Low-risk (both are stable, deterministic strings derived from the same manifest data the assertions already check), but worth a one-line follow-up in a task that owns `apps/web/src/components/{layout/Sidebar,devices/DeviceDetails}.tsx`.
3. **`CSP_STRICT_DEV=1` + `BREEZE_ADMIN_TOKEN` are both required env prerequisites** not previously part of this suite's documented env-var table (`e2e-tests/README.md`). I did not add them there — README changes felt like more scope than this task needed given the spec's own header comment already documents them exhaustively — but a follow-up could promote them into the README's table for discoverability.
4. **`e2e-tests`' isolation from the pnpm workspace** (its own `package-lock.json`, not in `pnpm-workspace.yaml`) is pre-existing and not something I changed, but it materially shaped this task's design (relative import instead of a package dependency; CLI shell-out instead of a library import) — flagging in case a future task wants to fold `e2e-tests` into the pnpm workspace properly, which would let fixtures like this one depend on workspace packages directly.
