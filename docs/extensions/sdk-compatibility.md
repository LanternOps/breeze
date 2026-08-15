# Extension SDK compatibility policy

Breeze negotiates extension compatibility before loading or activating an
extension. The host descriptor advertises the manifest API versions, Breeze
version, server and web SDK versions, capabilities, and supported contract
versions for each UI slot.

`checkExtensionCompatibility` is intentionally a pure check. It compares the
manifest API and semantic-version ranges, verifies that every requested valid
capability is advertised by the host, and performs exact slot contract-version
lookups. It does not load extension artifacts, mutate the contribution
registry, or infer capabilities from declared contributions.

## SDK v1 release gate

The minimal SDK v1 fixture lives at
`packages/extension-sdk/fixtures/v1/minimal`. The blocking API CI job parses its
manifest with `parseExtensionManifestV1`, checks host compatibility, loads its
server entry, and finishes an immutable staging session without activating the
live registry.

SDK v1 must remain in this explicit CI gate until at least one stable Breeze
release has shipped after SDK v2 first ships. Removing the v1 fixture or gate
before that release is not supported. After the window closes, removal requires
an intentional compatibility-policy change and release-note entry; it must not
happen as incidental test cleanup.

## Delivery

Extensions are delivered one way: as first-party **built-ins** under `ee/`,
compiled into the API image and loaded at boot behind a per-deployment enable
flag. The former third-party delivery paths — source-directory ("build-time")
loading and signed runtime bundles declared in `extensions.yaml` — have been
removed, along with `@breeze/extension-api`, `@breeze/extension-cli`, and the
`BREEZE_EXTENSIONS_DIR` / `BREEZE_LEGACY_SOURCE_EXTENSIONS` switches. That
removal retired delivery mechanisms only: the public v1 SDK, the v1 manifest
schema, and this document's CI gate are unaffected and remain governed by the
SDK v2 window above.
