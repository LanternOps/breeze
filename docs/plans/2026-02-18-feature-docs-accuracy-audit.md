# Feature Docs Accuracy Audit (Astro docs)

Date: 2026-02-18
Scope reviewed: `apps/docs/src/content/docs/features/*.mdx` (28 feature pages, including uncommitted docs)
Code surfaces verified: `apps/api/src/**`, `apps/web/src/**`, `apps/mobile/src/**`, `agent/**`

## Method

- Reviewed every feature page top-to-bottom.
- Mapped documented endpoints to mounted API routes under `app.route('/api/v1', api)` in `apps/api/src/index.ts:605`.
- Cross-checked UI claims against actual pages/components in `apps/web/src/pages/**`, `apps/web/src/components/**`, and mobile app code in `apps/mobile/src/**`.

Status scale:
- API: `Complete` | `Partial` | `Missing`
- UI: `Complete` | `Partial` | `Missing`
- Doc Accuracy: `Accurate` | `Minor drift` | `Major drift`

## High-Confidence “Not Actually Coded” / Drift Findings

1. Backup docs describe DB-backed persistence as current behavior, but implementation is in-memory mock store.
- Docs: `apps/docs/src/content/docs/features/device-backup.mdx:164`, `apps/docs/src/content/docs/features/device-backup.mdx:281`, `apps/docs/src/content/docs/features/device-backup.mdx:366`
- Code: seeded in-memory arrays/maps in `apps/api/src/routes/backup/store.ts:6`, `apps/api/src/routes/backup/store.ts:39`, `apps/api/src/routes/backup/store.ts:89`

2. Software Inventory docs read as mostly DB-backed production behavior, but `/software/*` routes are in-memory route-layer data.
- Docs: `apps/docs/src/content/docs/features/software-inventory.mdx:139`, `apps/docs/src/content/docs/features/software-inventory.mdx:370`
- Code: in-memory structures in `apps/api/src/routes/software.ts:7`
- Note: DB-backed device-specific endpoint exists separately at `apps/api/src/routes/devices/software.ts:15`

3. Integrations page overstates coverage/security for non-PSA integrations.
- Doc claims all credentials encrypted at rest: `apps/docs/src/content/docs/features/integrations.mdx:11`
- Actual non-PSA integrations use in-memory maps: `apps/api/src/routes/integrations.ts:7`
- Doc says `test: true` does not persist config: `apps/docs/src/content/docs/features/integrations.mdx:75`
- Code persists before test branch: `apps/api/src/routes/integrations.ts:95`, `apps/api/src/routes/integrations.ts:97`, `apps/api/src/routes/integrations.ts:99`
- Doc PSA provider list includes unsupported enums (`halo`, `syncro`, `kaseya`): `apps/docs/src/content/docs/features/integrations.mdx:197`
- Implemented enum: `apps/api/src/routes/psa.ts:14`

4. Mobile docs say remote actions are submitted via `/devices/:id/actions`, but app currently sends all actions to `/devices/:id/commands`.
- Docs: `apps/docs/src/content/docs/features/mobile.mdx:80`
- Mobile app call path: `apps/mobile/src/services/api.ts:374`
- Additional mismatch: app exposes `lock`/`wake` via command type, but command schema does not accept those types.
- Command schema: `apps/api/src/routes/devices/schemas.ts:37`
- Mobile-specific actions schema supports `wake` (different endpoint): `apps/api/src/routes/mobile.ts:185`

5. Agent Diagnostics docs include a stale “known issue” that appears already fixed.
- Docs claim uppercase log levels shipped: `apps/docs/src/content/docs/features/agent-diagnostics.mdx:64`
- Agent now lowercases before ship: `agent/internal/logging/logging.go:233`
- API ingestion still expects lowercase enum: `apps/api/src/routes/agents/logs.ts:13`

6. Deployments UI workflow in docs references a dedicated “Fleet → Deployments” page that is not present as a standalone web route.
- Docs: `apps/docs/src/content/docs/features/deployments.mdx:81`
- Sidebar has `Fleet` but no `Deployments` nav target: `apps/web/src/components/layout/Sidebar.tsx:43`
- Fleet orchestration page exists: `apps/web/src/pages/fleet/index.astro`

7. System Tools API path prefix is documented as `/api/system-tools/...`; mounted API base is `/api/v1/...`.
- Docs: `apps/docs/src/content/docs/features/system-tools.mdx:459`
- Mount chain: `apps/api/src/index.ts:586`, `apps/api/src/index.ts:605`

## Per-Feature Completion + Accuracy Matrix

| Feature Page | API | UI | Doc Accuracy | Notes |
|---|---|---|---|---|
| `agent-diagnostics.mdx` | Complete | Partial | Minor drift | API implemented; no dedicated web UI (doc says API-only), stale known-issue note. |
| `ai-computer-control.mdx` | Complete | Partial | Accurate | Tooling is API/AI-chat centric; no dedicated standalone web screen. |
| `ai.mdx` | Complete | Complete | Accurate | AI Risk + Fleet UI present. |
| `automations.mdx` | Complete | Complete | Minor drift | Uses shorthand endpoint text like `/:id/...` in troubleshooting. |
| `configuration-policies.mdx` | Complete | Complete | Accurate | CRUD/features/assignments/effective config implemented. |
| `custom-fields.mdx` | Complete | Complete | Accurate | Endpoint examples align; parser misses were placeholder formatting. |
| `deployments.mdx` | Partial | Partial | Minor drift | Resume bug is real and documented; UI pathing overstates dedicated Deployments page. |
| `device-backup.mdx` | Partial | Complete | Major drift | Endpoint surface exists, but backend persistence is mock/in-memory. |
| `device-groups.mdx` | Complete | Complete | Minor drift | Troubleshooting uses shorthand `/:id/...`; mixed `/api` vs `/api/v1` style. |
| `discovery.mdx` | Complete | Complete | Accurate | Discovery API/UI coverage is strong. |
| `integrations.mdx` | Partial | Complete | Major drift | Non-PSA integration persistence/security/provider claims are overstated. |
| `maintenance-windows.mdx` | Complete | Partial | Accurate | API complete; no dedicated first-class maintenance page route. |
| `management-posture.mdx` | Complete | Partial | Accurate | Implemented in device detail management tab, not standalone page. |
| `mcp-server.mdx` | Complete | Partial | Accurate | API complete; configured through API keys/settings flow. |
| `mobile.mdx` | Partial | Complete | Minor drift | Core app exists, but action wiring and command schema mismatch reduce end-to-end completion. |
| `notifications.mdx` | Complete | Complete | Accurate | Notification APIs + UI surfaces present. |
| `patch-management.mdx` | Complete | Complete | Accurate | Patch policies write routes removed; docs mostly reflect this. |
| `plugins.mdx` | Complete | Missing | Accurate | API exists; no web plugin management UI implemented. |
| `policy-management.mdx` | Complete | Complete | Minor drift | Path examples use `/api/...` while mounted base is `/api/v1/...`. |
| `remote-access.mdx` | Complete | Complete | Accurate | Sessions/transfers and UI present. |
| `reports.mdx` | Complete | Complete | Minor drift | Mixed path style (`/api/...` vs `/api/v1/...`), plus a few literal placeholder examples. |
| `scripts.mdx` | Complete | Complete | Accurate | API/UI aligned. |
| `security.mdx` | Complete | Complete | Accurate | API/UI aligned. |
| `snmp.mdx` | Complete | Complete | Accurate | API/UI aligned (minor param-name variance only). |
| `software-inventory.mdx` | Partial | Complete | Major drift | Mixed in-memory + DB reality differs from DB-first narrative. |
| `system-tools.mdx` | Complete | Complete | Major drift | Prefix should be `/api/v1/system-tools/...`, not `/api/system-tools/...`. |
| `tags.mdx` | Complete | Partial | Accurate | Tag APIs implemented; no dedicated tag admin page (tagging lives in device flows). |
| `webhooks.mdx` | Complete | Complete | Accurate | API + webhook UI present. |

## Endpoint-Level Cleanups Needed (Doc Text)

1. Normalize API base path examples to `/api/v1/...` for consistency and correctness.
- Highest-priority pages: `apps/docs/src/content/docs/features/system-tools.mdx`, `apps/docs/src/content/docs/features/policy-management.mdx`, `apps/docs/src/content/docs/features/device-groups.mdx`, `apps/docs/src/content/docs/features/reports.mdx`

2. Replace shorthand troubleshooting endpoints with full paths.
- `apps/docs/src/content/docs/features/automations.mdx:49`
- `apps/docs/src/content/docs/features/automations.mdx:386`
- `apps/docs/src/content/docs/features/automations.mdx:389`
- `apps/docs/src/content/docs/features/device-groups.mdx:505`
- `apps/docs/src/content/docs/features/device-groups.mdx:508`
- `apps/docs/src/content/docs/features/deployments.mdx:207`

3. Keep / remove notes in sync with current code behavior.
- Remove stale Agent Diagnostics uppercase-level warning unless regression reintroduced.

## Recommended Next Pass (Order)

1. ~~Fix major drift pages first: `integrations.mdx`, `device-backup.mdx`, `software-inventory.mdx`, `system-tools.mdx`.~~ **DONE** — Added implementation status asides, corrected PSA provider list, fixed persistence claims, normalized API path prefix.
2. ~~Then normalize pathing/shorthand in `policy-management.mdx`, `device-groups.mdx`, `reports.mdx`, `automations.mdx`, `deployments.mdx`.~~ **DONE** — All `/api/` paths normalized to `/api/v1/`, shorthand endpoints expanded to full paths, Fleet→Deployments nav reference corrected.
3. ~~Align mobile doc with current app behavior.~~ **DONE** — Corrected action endpoint to `POST /mobile/devices/:id/actions`, clarified shutdown/lock use core commands endpoint.
4. ~~Remove stale Agent Diagnostics uppercase-level warning.~~ **DONE** — Replaced with accurate note that agent normalizes to lowercase.
