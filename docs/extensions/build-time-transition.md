# Build-time extension loading: transition and removal gate

Breeze historically supported loading extensions from source directories under
`extensions/` ("build-time" or "source-directory" loading): hosted images
cloned extension repos into the build context, built them with the API image,
and the loader imported their entry at boot. That path is **deprecated**. The
supported delivery mechanism is a **signed runtime bundle**: a
`breeze-ext`-packed artifact declared in `extensions.yaml`, verified against a
pinned digest and trusted publisher key, migrated, staged through the v1 SDK
contract, and activated by the reconciler — all against a stock Breeze image
that contains public SDK/host code only.

## What changed

- Stock images (`docker/Dockerfile.api`, `apps/api/Dockerfile`) no longer
  install, build, or bake in anything from `extensions/*`. The runtime image
  ships an empty `/app/extensions` mount point (`BREEZE_EXTENSIONS_DIR`) where
  deployments place `extensions.yaml` and artifacts.
- `extensions/*` was removed from `pnpm-workspace.yaml`. A legacy source
  checkout builds standalone inside its own directory.
- Source-directory loading is gated behind
  **`BREEZE_LEGACY_SOURCE_EXTENSIONS=true`**. Without the flag, present source
  extensions are skipped with a structured
  `legacy_source_extension_skipped` warning naming the flag.
- With the flag set, every loaded source extension emits one structured
  `legacy_source_extension_loaded` deprecation warning, and still runs through
  the same staged v1 contribution registry, auth default-deny gateway, and
  tenancy/RLS tripwires as runtime bundles.
- An extension name may be delivered by **only one path at a time**: if a
  source directory and an `extensions.yaml` runtime artifact share a name, the
  boot fails (previously the second activation silently replaced the first).

## Compatibility window and removal gate

- **First stable release containing the server SDK v1 runtime host:**
  **v0.98.0**, tagged 2026-07-19 (host descriptor: `breezeVersion 0.1.0`,
  `serverSdk 1.0.0`, `breeze.extensions/v1`). Note v0.98.0 was cut hours
  before this deprecation merged, so it carries the v1 host but NOT the
  `BREEZE_LEGACY_SOURCE_EXTENSIONS` gate.
- **The deprecation itself** (the flag gate, structured warnings, same-name
  simultaneity check, and extension-free stock images) ships in the first
  stable release cut after 2026-07-19 that contains it — call that release
  **D** (v0.99.0, unless a v0.98.x patch release picks it up).
- **Earliest stable release allowed to remove the legacy adapter and
  source-directory discovery path: the first stable minor release after D** —
  i.e. the legacy path remains loadable, behind the flag, for D's entire
  release series.

Removal additionally requires ALL of:

1. The SDK v1 compatibility fixtures (`packages/extension-sdk/fixtures/v1/*`
   and the blocking API CI gate described in `sdk-compatibility.md`) are green
   on the release candidate.
2. A published migration guide covering the source-directory → signed-bundle
   conversion (pack, sign, declare in `extensions.yaml`), with
   `breeze-workspace` as the reference implementation.
3. A release-note entry announcing the removal.

What removal covers: `loadSourceExtensions`, `discoverExtensions`'
source-directory scanning, the legacy `breeze-extension.json` → v1 manifest
adapter in the loader, and the `BREEZE_LEGACY_SOURCE_EXTENSIONS` flag itself.

**What removal does NOT cover:** the public v1 SDK
(`@breeze/extension-sdk`, `@breeze/extension-web-sdk`), the v1 manifest
schema, the runtime reconciler, or the SDK v1 CI gate. Removing the
source-directory loader is a delivery-path retirement, not an SDK version
bump; the v1 SDK remains governed by the separate policy in
`sdk-compatibility.md`.

## Migrating an extension

1. Adopt the v1 manifest (`manifest.json`, `breeze.extensions/v1`) and the
   two-argument `register(registrar, context)` SDK contract.
2. Build server (CJS) and web (ESM) entries; pack and sign with `breeze-ext
   pack` / `breeze-ext sign`.
3. Declare the artifact in `extensions.yaml` (name, uri, pinned `sha256:`
   digest — required in production — and a publisher declared in the
   `publishers` map).
4. Remove the source checkout from `extensions/` (or leave it and drop the
   flag: it will be skipped with a warning; the same NAME cannot be both).

The end-to-end conformance reference is the `breeze-workspace` repository
(`test/conformance`), which proves this pipeline against an unmodified stock
image.
