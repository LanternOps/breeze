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

## Web SDK 1.1: host API

`@breeze/extension-web-sdk` 1.1.0 adds host API v1. The Breeze API accepts a
Bearer access token only, and that token stays in the web app's memory, so an
extension element that calls the global `fetch` is always answered 401. Before
it assigns `context`, the web host assigns a frozen `ExtensionHostApiV1` to the
element's `hostApi` property (`EXTENSION_HOST_API_PROPERTY`). Every element
that calls its own API must send requests through `hostApi.fetch(path, init)`:

- `path` must be root-relative and inside the extension's own namespace,
  `/api/v1/ext/<name>/...`. Absolute and protocol-relative URLs, other
  extensions' namespaces, core API routes, dot segments, and percent-encoding
  or empty segments in the path are refused with `ExtensionApiPathError`
  before any request is sent. Percent-encoding is allowed in the query.
- Only `method`, `headers`, `body` and `signal` are passed on. The host drops
  `Authorization` and `Cookie` headers set by the extension. It then attaches
  the session, refreshes it on 401 and injects the active organization,
  exactly as for its own requests. The access token itself is never exposed
  to extension code.
- On the element side, validate the assigned value with
  `parseExtensionHostApiV1`. If the element has no host API, show an error and
  send nothing. A bare `fetch` only gets a 401.

A manifest whose web code depends on the host API declares
`requires.webSdk: "^1.1.0"`. In tests, `createTestHostApi` from
`@breeze/extension-testkit` builds a host API with the same checks over a fake
transport.
