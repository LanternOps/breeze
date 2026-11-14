---
spec: docs/superpowers/specs/integrations/2026-11-09-credential-fill-hudu-design.md
kind: wave-index
---

# Credential fill — wave index

**Goal:** A technician fills a stored login into a remote desktop session without
the secret reaching their machine, and copies one in the proxy window; Hudu is
the first source.

**Spec:** `docs/superpowers/specs/integrations/2026-11-09-credential-fill-hudu-design.md`

This file fixes the wave boundaries and the names that cross them. Each wave has
its own plan file, written just before that wave starts so it is planned against
current `main`. A wave's plan may not rename anything in "Cross-wave contracts"
without updating this file in the same PR.

## Waves

| Wave | Delivers | Depends on | Surface | Plan |
|---|---|---|---|---|
| W01 | Credential source tables, adapter interface, Hudu adapter, partner admin API (connect, test, sync containers, map to orgs, exposure mode, sub-scope rules), permissions | — | API, DB | `2026-11-09-credential-fill-w01-source-framework-hudu.md` |
| W02 | Settings → Integrations → Credential sources UI (connect, mapping screen, exposure mode) | W01 | Web | not written |
| W03 | Session credential list, fill and copy routes; scope checks; MFA rules; synchronous audit; TOTP; `credential_fill` command dispatch with sealed, purged payload | W01 | API | not written |
| W04 | Agent `credential_fill` handler, `credentialFill` capability, credential-only injection entry point, result codes | W03 contract (can be built against a fake) | Go agent | not written |
| W05 | Viewer credentials panel with Fill buttons | W03, W04 | Viewer | not written |
| W06 | Proxy window credentials panel with Copy and step-up | W03 | Web | not written |
| W07 | Relevance sorting (asset match, tunnel host match), per-device and per-user usage views, docs page | W03 | API, Web, Docs | not written |

W02 and W03 can run in parallel after W01. W04 can start once W03's command
contract below is merged. W05 needs a lab leg on a real Windows session (logon
screen, UAC prompt, a browser login form) before the feature is announced.

## Cross-wave contracts

Names here are binding on every wave.

**Permissions** (partner-scope only): `credential_sources:manage`,
`credentials:fill`, `credentials:copy`.

**Tables:** `credential_source_connections`, `credential_source_containers`,
`credential_source_allowed_sub_scopes`.

**Adapter (W01 → W03, W07)**, in `apps/api/src/services/credentialSources/`:

```ts
type CredentialField = 'username' | 'password' | 'otp';

interface CredentialMetadata {
  vendorId: string; name: string; username: string | null; urlHost: string | null;
  subScopeId: string | null; subScopeName: string | null;
  assetRef: string | null; hasOtp: boolean;
}

interface FetchedSecret {
  value: string; kind: 'text' | 'otp_seed' | 'otp_code';
  containerId: string; subScopeId: string | null; subScopeName: string | null;
}

interface CredentialSourceAdapter {
  capabilities: { subScopes: boolean; otp: 'none' | 'seed' | 'code'; assetLinks: boolean };
  testConnection(): Promise<void>;
  listContainers(): Promise<{ vendorId: string; name: string }[]>;
  listSubScopes(): Promise<{ vendorId: string; name: string; containerId: string | null }[]>;
  listCredentials(containerId: string): Promise<CredentialMetadata[]>;
  fetchSecret(vendorCredentialId: string, field: CredentialField): Promise<FetchedSecret>;
}

getCredentialSourceAdapter(provider: string)
resolveCredentialSource(connectionId: string, partnerId: string): Promise<CredentialSourceAdapter>
```

**Credential reference (W03 → W05, W06):** an opaque string the client echoes
back. It encodes connection id + vendor credential id and carries no authority;
the server re-derives every check from it.

**Fill request (W05 → W03):** `{ credentialRef: string, field: 'username' | 'password' | 'otp' | 'username_password' }`.
Response: `{ result: FillResult }` and nothing else.

**Agent command (W03 → W04):** type `credential_fill`; payload
`{ sessionId, sessionGeneration, steps: Array<{ kind: 'text', value } | { kind: 'key', key: 'Tab' }> }`,
sealed at rest, one-shot, short expiry, purged on completion or expiry.
`username_password` is three steps in one command.

**Result codes (W04 → W03 → W05):** `ok`, `input_unavailable`,
`unsupported_characters`, `session_gone`, `expired`, `delivery_uncertain`.
`FillResult` is exactly this set plus the server-side refusals W03 defines.

**Agent capability (W04 → W03):** `credentialFill: true` in the agent's
advertised capabilities. W03 refuses fills for agents without it.

**Audit action names (W03 → W07):** `credential.fill`, `credential.copy`,
`credential_source.*` for management changes. Attempt entry written
synchronously before any secret is fetched; outcome appended after.

## Rules every wave inherits

- No secret in any log, audit entry, error, trace, cache or client response on
  the desktop path.
- Interactive user sessions only; API keys, service principals, MCP and AI
  contexts are refused at the route.
- Scope checks run against the source's response on every use, never against
  client input or a cached list.
- New `en` strings ship in all eight locales. Web mutations use `runAction`.
- Full rigor: TDD, one independent review round per wave, contract and
  integration suites before each PR.

## Tracking

Feature and wave issues are registered once the W01 plan is approved;
`tracking_issue:` is added to this file's frontmatter at that point.
