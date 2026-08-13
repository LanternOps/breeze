# NU Branding: Renamed vs Protocol

What was rebranded to Nodes Unlimited, and the hard list of identifiers that
must NEVER be renamed. See also [msi.md](msi.md),
[operations.md](operations.md), [known-issues.md](known-issues.md).

## Renamed (user-visible only)

- **Installers** — Windows MSI ProductName "NU Agent", Manufacturer
  "Nodes Unlimited" ([msi.md](msi.md)); macOS pkg + "NU Agent Signing"
  identity.
- **Service display names** — "NU Agent" / "NU Agent Watchdog"
  (`agent/installer/nu-agent.wxs` lines 350/385).
- **Viewer product** — NU-branded remote-desktop viewer.
- **Web chrome** — logo, product name, theme in the web app.

## PROTOCOL — never rename

Renaming any of these breaks deployed agents or the enrollment/update chain:

| Identifier | Why it is wire format |
|---|---|
| `brz_` token prefix | Auth middleware matches it (`apps/api/src/middleware/agentAuth.ts`, `partnerApiAuth.ts`, OpenAPI spec). Existing enrolled agents hold `brz_` tokens. |
| `breeze-{component}-{os}-{arch}[.exe]` binary filenames | `parseBinaryFilename()` in `apps/api/src/services/binarySync.ts` matches this regex exactly; renamed files = zero binaries discovered, silent fallback to upstream ([operations.md](operations.md)). |
| `BreezeAgent` / `BreezeWatchdog` Windows service names | Agent code, watchdog, and the MSI's `sc`/ServiceControl custom actions reference them; renaming orphans every existing install ([msi.md](msi.md)). |
| `breeze://` deep-link scheme | The web app emits it (remote connect buttons in `apps/web/src/components/remote/`); installed viewers register it. |
| `BREEZE_*` env names | Server/agent config contract (`BREEZE_VERSION`, `BREEZE_API_IMAGE`, `BREEZE_WEB_IMAGE`, …). |
| DB identifiers | Database name `breeze`, table/column names — migrations and every query depend on them. |
| Go module path | Import paths baked into every source file; changing it forks the module identity. |

**Rule of thumb:** if a name crosses a process, network, or install boundary
(agent ↔ server, installer ↔ OS, web ↔ viewer), it is protocol. Only strings a
human reads in UI are branding.
