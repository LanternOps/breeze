# Pre-release sweep B — `0ed8ee1cec` → main `b41ca83e41` (2026-10-10)

Follows `2026-10-09-v0.121.0-followup-to-main.md` (base `0ed8ee1cec`). This pass covers the release cut merged on 2026-10-10 (≈30 PRs landed through the merge queue that day) **plus a whole-app regression crawl** (ui-qa-sweep Phases 2–4), the first since 2026-08-24.

| | |
|---|---|
| Range | `0ed8ee1cec` → `origin/main` `b41ca83e41` (51 commits) |
| Gate | Release cut "A": every open PR green on head + one recorded review was merged via the queue. Still open: #8264 (heartbeat policy read — CI rerun after a 4th rebase; no UI, follow-up row), #6574 and #8320 (blocked on Todd's CHANGES_REQUESTED reviews). |
| Stack | `pnpm wt-stack up` on `qa/sweep-b-b41ca83e41` @ `b41ca83e41`, baseUrl `http://localhost:33205` (project `breeze-wt-qa-sweep-b-b41ca83e41`) |
| Flags enabled | same `.env` as the 10-06/10-09 sweeps (`WEBAUTHN_RP_ID=localhost`, `MFA_FORCE_FOR_PARTNER_ADMIN=false`, AI agents/catalog/MCP OAuth/tool sources on; workspace and M365 off). No new UI-gating env var in the range. |
| Driver | skill `pre-release-sweep` + `ui-qa-sweep`; inventory agent (sonnet); browser agents (opus) drive **headless Playwright scripts** (Playwright MCP unavailable this session) |

## Change inventory

Status ∈ `TODO | PASS | PARTIAL | FAIL | BLOCKED | N/A`. Click-paths read from diffs, not yet confirmed on the live stack.

| PR | Title | Surface | Route / click-path | Expected visible outcome | Prereq | Group | Status |
|---|---|---|---|---|---|---|---|
| #8363 | Org payment settings need second-factor confirmation | web | `/settings/organizations/<id>/billing` (org Contracts & Billing tab, `OrgBillingSettings` > Payments section) > change a payment setting > Save | A "Confirm it's you" panel appears with the copy "Changing this organization's payment settings needs a fresh second-factor check for these exact values." Fields are "Authenticator code", "Confirm", and "Set up a second factor" if none is enrolled. | Admin with `canManageAutopay`. TOTP or passkey enrolled; SMS-only gives the `noFactorSmsOnly` text. Stripe connected so the Payments section renders. SQL: seed a TOTP row. | A | TODO |
| #8358 | Autopay charge-now and payment settings need step-up; cap checked before charge | web | `/billing/invoices/<id>` > "Charge now" (`autopay.chargeNow`). Also `/settings/billing` Payments tab and `/billing/autopay`. | Step-up panel "Charging this invoice now needs a fresh second-factor check." After confirming, a charge toast. The authorization-request recipient override gets its own step-up. | Stripe plus a saved payment method (BLOCKED). The "Charge now" button needs `autopay.canChargeNow` and `chargePreview`. SQL fixture: an open invoice with an active autopay link. The step-up panel can be seen without a real Stripe call. | A | TODO |
| #8328 | Autopay runs only for active partners; resetting an invoice link resets its autopay links | api-only | None. Worker and route logic. | Autopay does not fire for a suspended or inactive partner. | Set partner status to suspended, then run the autopay job (SQL or worker). | E | N/A, no visible UI |
| #8248 | Quotes require part number for parts order | web | `/billing/quotes/<id>` (draft) > product line | A line with no part number shows "Add a part number to include this in the parts order." The Send dialog says "N product line has no part number and won't be added to the parts order." and the button reads "Send anyway" instead of "Send proposal". The order breakdown shows "Not in this order (no part number): …". | A draft quote with a product line and a blank SKU/part number. Seed via SQL. | A | TODO |
| #8249 | Public quote "Sign & pay" goes straight to Stripe checkout | portal | `/quote/<token>` (public accept page, `PublicQuoteView` and `SignaturePanel`) | The button reads "Sign & pay $X" or "Sign & pay deposit $X", with the note "You'll then go to secure payment." After signing: "Signed and accepted. Taking you to secure payment." and a redirect to checkout. | `payOnAccept` needs Stripe and a partner taking online payment (BLOCKED for checkout). Without Stripe the label stays as before. The label branch can be checked with a quote carrying a deposit or due-on-acceptance amount, plus Stripe test keys if available. | A | TODO |
| #8276 | Block hours drawdown engine | api-only | None. `contractWorker` job plus `moveOrg` and `preAssignment` hooks. | Nothing new in the UI. Ledger or period-close changes show in the DB only. | A contract with a block-hours config. Run the worker (SQL fixture). | E | N/A, no web surface |
| #8323 | Reliability baseline markers UI (W02) | web | `/devices/<id>` Overview > reliability panel (`DeviceReliabilityPanel`) > "Mark work done" | The dialog "Mark work done on this device" has "What was done" (Reimaged, Remediated or Hardware replaced), "When the work finished" and "Note". Saving shows "Marker saved — scoring restarts from this point". The panel then shows the banner "Scoring since … — provisional, N of 14 days reported", a "Provisional" pill, "Before → since", and "Marker history" with a Clear action ("Clear marker"). The device list reliability badge turns grey with the title "provisional (recent fix or reimage)". The device Activity feed shows `device.reliability.*` rows with a shield icon. | Offline fixture devices are fine. Needs a device with reliability data and `devices:write`. SQL: reliability score history. Remediated requires a note. | B | TODO |
| #8319 | Reliability baseline markers API (W01) | api-only | Covered through #8323's UI. Reimage reset comes from heartbeat/enrolment. | Automatic marker shows "Breeze (automatic)" in marker history. | Live agent for the auto-reset path (BLOCKED). The manual path works through the UI. | B | N/A, covered by #8323 |
| #8348 | Physical placement for devices and discovered assets | api-only | None in the UI (`devices/placement.ts`, `discoveryAssetPlacement.ts`). | Nothing visible. Check through API/curl only. | API token. | E | N/A, no UI yet |
| #8223 | Site location pins; location-sites read; partner toggle | web | `/settings/ticketing#timeTracking` (Time tracking card, partner scope) | New toggle "Suggest a timer when a technician arrives at a client site". Help text: "Each technician must also allow location on their phone. Location is checked on the phone and is never sent to Breeze." Enabling shows "Default arrival radius (m)", range 50–1000 (default 150). An out-of-range value gives "Arrival radius must be between 50 and 1000 meters". If the load fails, Save is disabled and "Could not load the saved settings…" shows. | Partner admin. Pins are written by the mobile app, so no pin UI is testable here. | C | TODO |
| #8175 | Portal performance metrics visibility | web (setting). The portal has no page in this PR. | `/settings/organization#portal` (`OrgPortalSettingsEditor` > visibility toggles) | New toggle "Performance metrics": "Show read-only CPU, memory, disk and network performance trends for your customer's machines." It defaults to on and persists across a save and reload. API `GET /portal/performance/overview` returns `PORTAL_PERFORMANCE_METRICS_DISABLED` when it is off. | A seeded org. Portal user login for the API path. No portal page consumes it yet, so curl is needed. | C | TODO |
| #8286 | Client AI templates: dedicated permissions plus MFA on writes | web | `/ai-for-office#templates` | The Templates tab (`ai-office-tab-templates`) shows only with `client_ai_templates:read`. Without it, a `#templates` deep link falls back to `#orgs`. Create, edit and delete need `client_ai_templates:write` plus an MFA-assured session, so a non-MFA session gets an MFA-required refusal. | Roles: a custom role without the grant, a role with read only, and one with the `*:*` wildcard. MFA enrolled for the write path. The AI-for-office feature may be partner-scope and EE-gated. | D | TODO |
| #8303 | Ticket webhooks wave 4 (`ticket.updated`/`assigned`) | web | `/integrations/webhooks` > create or edit webhook > event list | New events "Ticket Updated" ("Triggered when ticket fields are edited."), "Ticket Assigned" ("Triggered when a ticket is assigned or unassigned."), "Ticket Commented" and "Ticket Status Changed". Delivery log is visible after editing or assigning a ticket. | Outbox worker running. A webhook sink needs outbound HTTP, so use a local echo URL. SQL: a ticket. | D | TODO |
| #8344 | Customer email replies write a `ticket.commented` outbox row | api-only | None | A webhook for `ticket.commented` fires on an inbound reply. | Inbound email (BLOCKED locally). SQL: insert a comment and check the outbox. | E | N/A, inbound email needed |
| #8332 | Service principal keys issued by owner; end with owner's sessions | api-only, with a visible consequence | `/settings/partner-service-principals`, and `/settings/api-keys` for key issue and rotate | Keys can be issued and rotated only by the owner. A key stops working after the owner's sessions end. | Partner scope, with a second user to test non-owner refusal. Migration `partner-sp-key-owner-epochs`. | D | TODO |
| #8327 | Diagnostics: credential stores never grantable; self-approval needs second factor | api-only, with a visible consequence | `/approvals` and the device diagnostics/access grant flow. No page changed in the diff. | Requests naming a credential store are refused. Self-approving needs a second factor. | A live agent or device for a diagnostics session (BLOCKED). Only the API refusal is testable. | E | N/A, live agent needed |
| #8226 | Scoped contact responsibilities | api-only | None in the diff. Org Contacts tab at `/settings/organizations/<id>` is the closest existing UI. | No UI change. API only. | Two contacts with different scopes (SQL). | E | N/A, API only |
| #8316 | Converting a quarantined M365 email keeps body and sender name | api-only | None | The converted ticket keeps its body and sender name. | M365 connection (BLOCKED). SQL: a quarantined email row. | E | N/A, M365 required |
| #8282 | DB pool admission gate, lag-tolerant deadlines, deferred reclaim | api-only | None | None. Behaviour under load only. | Env vars below. Load test only. | E | N/A, infra only |
| #8259 | EDR W01b: provider framework and Bitdefender GravityZone read path | api-only | `/security/edr` shows no changes in the diff. Routes are `routes/edr/*`. | Nothing new visible. The provider list may include GravityZone through the API. | A GravityZone tenant (BLOCKED). | E | N/A, real EDR needed |
| #7619 | Cloudflare Gateway DNS: real APIs for event sync and list edits | web (indirect) | `/dns-security` > integration > sync | Sync pulls Gateway events and edits lists. | A Cloudflare account (BLOCKED). | D | N/A, Cloudflare account needed |
| #8213 | Breeze Assist starts hidden; tray-icon setting removed | web (setting removed), helper | `/configuration-policies/<id>` > Helper tab | The "Show tray icon" checkbox is gone. The context-menu text reads "Configure which items appear in the Breeze Assist right-click context menu." A stored `showTrayIcon` is dropped on the next save. | A policy with a Helper link. The helper app itself needs a live device (BLOCKED). | B | TODO |
| #8221 | Workload host inventory W01 (API contract) | api-only | `/devices/<id>` effective-config tab only. The `workload_inventory` policy tab is explicitly excluded until W04. | No editor tab. The device effective-config tab may list the feature. | Agent heartbeat for data (BLOCKED). | B | N/A, W04 adds UI |
| #8218 | Ring app-rules column; dual-read evaluation | api-only | `/settings/update-rings` or `/patches` rings. Not in the diff. | No change. | Update ring fixture. | E | N/A, no UI change |
| #8212 | BYOK refusal-fallback pricing | api-only | None | AI usage cost uses the key's own offering rate (`/settings/ai-usage`). | BYOK key and a refusal (BLOCKED). | E | N/A, provider needed |
| #8110 | Network proxy loads device CSS/JS without tunnel cookie | api-only | Device Network proxy (`tunnelHttp`) | Proxied device pages load styles. | Live agent (BLOCKED). | E | N/A, live agent needed |
| #7336 | Edition-migration reinstall detached and canaried per org | agent-only/api | None | None. | Live agent. | F | N/A, agent lab only |
| #8154 | macOS permission checks off ScreenCaptureKit | agent-only | None | None. | macOS lab device. | F | N/A, agent lab |
| #8150 | Failed Storage Spaces probe not treated as pools present | agent-only | None | None. | Windows lab. | F | N/A, agent lab |
| #8266 | Clipboard v2 viewer (chunked, images, status chip, paste) | viewer | None | Status chip and image paste in the viewer. | Viewer plus live agent. | F | N/A, viewer lab |
| #8263 | One audit row per desktop session for clipboard | api/agent | `/security/admin-audit` | One audit row per session. | Live session. | F | N/A, live agent needed |
| #8262 | Chunked clipboard, policy status | agent-only | None | None. | Lab. | F | N/A, agent lab |
| #8251 | Release held keys when viewer goes away | agent-only | None | None. | Lab. | F | N/A, agent lab |
| #8322 | Hash empty peripheral group list as `[]` | agent-only | None | None. | Lab. | F | N/A, agent lab |
| #8346 | Dev setup docs and govulncheck wrapper | docs-chore | None | None. | None. | none | N/A, docs/dev tooling |
| #8343 | Release signing secrets from protected environments | docs-chore | None | None. | None. | none | N/A, CI/release only |
| #8342 | Partner API ticket comments and scopes docs | docs-chore | None | None. | None. | none | N/A, docs only |
| #8347 | On-demand service catalog spec | docs-chore | None | None. | None. | none | N/A, spec doc |
| #8341 | Ticket migration windows spec | docs-chore | None | None. | None. | none | N/A, spec doc |
| #8149 | Network proxy dedicated tunnel origin spec | docs-chore | None | None. | None. | none | N/A, spec doc |
| #8172 | Community Ecosystem docs page | docs-chore | docs site, if built | A new docs page exists. | Docs build. | none | N/A, docs only |
| #8126 | Deploy doc: roll worker, drop hotfix pin | docs-chore | None | None. | None. | none | N/A, docs only |
| #8324 | Agent display branding spec marked implemented | docs-chore | None | None. | None. | none | N/A, spec doc |
| #8277 | Agent localization and Helper branding spec | docs-chore | None | None. | None. | none | N/A, spec doc |
| #8162 | Physical placement and circuits V1 spec | docs-chore | None | None. | None. | none | N/A, spec doc |
| #8275 | Customer work approval W01 | api-only | `routes/tickets/approvalSettings.ts` only. No web page in the diff. | No UI. | Permission catalog entry. | E | N/A, API only, no UI yet |


**New env vars:** none gate a UI surface. Infra-only: `DB_TIMER_LAG_GRACE_MS` (2000), `DB_POOL_ACQUIRE_TIMEOUT_MS` (15000→10000), `DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS` (15000) from #8282. DB toggles: `enablePerformanceMetrics` (#8175, default on), `timeTracking.locationSuggestions` (#8223, default off).

## Whole-app regression crawl (ui-qa-sweep)

| Phase | Area | Status |
|---|---|---|
| 2 | Login + every sidebar destination renders, primary data call status, console errors | TODO |
| 3 | Everyday workflows (devices, device actions, alerts, scripts, patches, remote, search, filters/tags/custom fields, reports/audit, theme/profile) | TODO |
| 4 | Setup tasks (org/site, users/roles, enrollment, notification channels, config policies, partner settings, monitoring/discovery, backup/DR, integrations) | TODO |

## Sweep log (append as you go)

## UI/UX paper cuts

| # | Where | Observation | Severity | Disposition |
|---|---|---|---|---|

## Fixes applied

| Commit | Area | What | Test |
|---|---|---|---|

## Issues filed

| Issue | Title | From row |
|---|---|---|

## Summary
