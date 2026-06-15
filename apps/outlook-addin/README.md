# Breeze AI for Office — Outlook add-in

Task-pane add-in delivering the governed Breeze AI assistant to MSP client
end-users inside Outlook. Spec: `docs/superpowers/specs/2026-06-12-breeze-ai-for-office-design.md`.

## Prerequisites

- Node 22 (`nvm use 22.20.0`) and `pnpm install` from the repo root.
- HTTPS dev certs (Office hosts require https):

  ```bash
  pnpm run certs   # office-addin-dev-certs install — one-time, may prompt for the OS keychain
  ```

- `.env` (copy `.env.example`): `VITE_API_BASE_URL`, `VITE_CLIENT_AI_ENTRA_CLIENT_ID`
  (must equal the API's `CLIENT_AI_ENTRA_CLIENT_ID`), `ADDIN_BASE_URL`.
- The API's `CORS_ALLOWED_ORIGINS` must include this app's origin
  (`https://localhost:3004` for dev).

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm dev` | Generates icons + `manifest.xml`, serves the pane at `https://localhost:3004` |
| `pnpm build` | Type-check + production build into `dist/` + manifest |
| `pnpm test` | Vitest (jsdom + the Office.js mock in `src/__tests__/officeMock.ts`) |
| `pnpm manifest` | Re-render `manifest.xml` from `manifest.template.xml` + env |
| `pnpm validate-manifest` | `office-addin-manifest validate manifest.xml` |

## Sideloading the generated `manifest.xml`

- **Outlook on the web:** Settings ▸ Mail ▸ Customize actions / Get Add-ins ▸
  My add-ins ▸ Custom Addins ▸ Add a custom add-in ▸ Add from file.
- **Outlook desktop:** add the add-in from the same **Get Add-ins** dialog
  (Outlook reads its manifest centrally, not from a per-host `wef/` folder).
- Production distribution is M365 **centralized deployment** by the MSP (spec §2).

## Entra app registration

Silent SSO needs the registration described in the plan (Task 2 prerequisites):
SPA redirect URI `<origin>/taskpane.html`, Application ID URI
`api://<host>/<client-id>`, delegated scope `access_as_user`, the Office client
app `ea5a67f6-b6f3-4338-b240-c655ddc3cc8e` pre-authorized, and **v2.0 access
tokens** (`requestedAccessTokenVersion: 2`). Without pre-authorization, the
add-in falls back to the MSAL popup — functional, just not silent.

## Runtime config

The JS bundle is deployment-neutral. At boot it fetches `/config.json`
(`{ "apiBaseUrl": "...", "entraClientId": "..." }`) from its own origin. For
local dev the committed `public/config.json` (localhost defaults) is served by
Vite; the `VITE_*` env vars are dev fallbacks that fill any field `/config.json` leaves absent or empty (the committed `public/config.json` ships an empty `entraClientId`, so `VITE_CLIENT_AI_ENTRA_CLIENT_ID` fills it for local SSO).

To produce a deployment's config:

    node scripts/generate-config.mjs --api-base-url https://us.2breeze.app --client-id <entra-client-id>

The manifest is still per-deployment (Office reads static XML and cannot fetch
runtime config) — keep generating it with `scripts/generate-manifest.mjs`.

Per deployment, `config.json`'s `apiBaseUrl` and the manifest's `VITE_API_BASE_URL`
(rendered into `<AppDomain>`) must reference the same API origin — they are
produced by two separate scripts (`generate-config.mjs` and `generate-manifest.mjs`).
