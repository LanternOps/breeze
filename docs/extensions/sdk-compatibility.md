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
manifest through the `@breeze/extension-api` legacy-to-v1 adapter, checks host
compatibility, loads its CommonJS server entry, and finishes an immutable
staging session without activating the live registry.

SDK v1 must remain in this explicit CI gate until at least one stable Breeze
release has shipped after SDK v2 first ships. Removing the v1 fixture or gate
before that release is not supported. After the window closes, removal requires
an intentional compatibility-policy change and release-note entry; it must not
happen as incidental test cleanup.

## Legacy source-directory (build-time) loading

The v1 runtime host first shipped in v0.98.0; source-directory extension
loading is deprecated and gated behind `BREEZE_LEGACY_SOURCE_EXTENSIONS=true`
starting with the first stable release after v0.98.0 that contains the gate,
for a one-release-series compatibility window recorded (with its removal
conditions) in `build-time-transition.md`. That removal retires a delivery
path only — it does not remove the public v1 SDK, the v1 manifest schema, or
this document's CI gate, which are governed by the SDK v2 window above.
