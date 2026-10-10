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
| #8363 | Org payment settings need second-factor confirmation | web | `/settings/organizations/<id>/billing` (org Contracts & Billing tab, `OrgBillingSettings` > Payments section) > change a payment setting > Save | A "Confirm it's you" panel appears with the copy "Changing this organization's payment settings needs a fresh second-factor check for these exact values." Fields are "Authenticator code", "Confirm", and "Set up a second factor" if none is enrolled. | Admin with `canManageAutopay`. TOTP or passkey enrolled; SMS-only gives the `noFactorSmsOnly` text. Stripe connected so the Payments section renders. SQL: seed a TOTP row. | A | PASS |
| #8358 | Autopay charge-now and payment settings need step-up; cap checked before charge | web | `/billing/invoices/<id>` > "Charge now" (`autopay.chargeNow`). Also `/settings/billing` Payments tab and `/billing/autopay`. | Step-up panel "Charging this invoice now needs a fresh second-factor check." After confirming, a charge toast. The authorization-request recipient override gets its own step-up. | Stripe plus a saved payment method (BLOCKED). The "Charge now" button needs `autopay.canChargeNow` and `chargePreview`. SQL fixture: an open invoice with an active autopay link. The step-up panel can be seen without a real Stripe call. | A | PARTIAL |
| #8328 | Autopay runs only for active partners; resetting an invoice link resets its autopay links | api-only | None. Worker and route logic. | Autopay does not fire for a suspended or inactive partner. | Set partner status to suspended, then run the autopay job (SQL or worker). | E | N/A, no visible UI |
| #8248 | Quotes require part number for parts order | web | `/billing/quotes/<id>` (draft) > product line | A line with no part number shows "Add a part number to include this in the parts order." The Send dialog says "N product line has no part number and won't be added to the parts order." and the button reads "Send anyway" instead of "Send proposal". The order breakdown shows "Not in this order (no part number): …". | A draft quote with a product line and a blank SKU/part number. Seed via SQL. | A | PASS |
| #8249 | Public quote "Sign & pay" goes straight to Stripe checkout | portal | `/quote/<token>` (public accept page, `PublicQuoteView` and `SignaturePanel`) | The button reads "Sign & pay $X" or "Sign & pay deposit $X", with the note "You'll then go to secure payment." After signing: "Signed and accepted. Taking you to secure payment." and a redirect to checkout. | `payOnAccept` needs Stripe and a partner taking online payment (BLOCKED for checkout). Without Stripe the label stays as before. The label branch can be checked with a quote carrying a deposit or due-on-acceptance amount, plus Stripe test keys if available. | A | PARTIAL |
| #8276 | Block hours drawdown engine | api-only | None. `contractWorker` job plus `moveOrg` and `preAssignment` hooks. | Nothing new in the UI. Ledger or period-close changes show in the DB only. | A contract with a block-hours config. Run the worker (SQL fixture). | E | N/A, no web surface |
| #8323 | Reliability baseline markers UI (W02) | web | `/devices/<id>` Overview > reliability panel (`DeviceReliabilityPanel`) > "Mark work done" | The dialog "Mark work done on this device" has "What was done" (Reimaged, Remediated or Hardware replaced), "When the work finished" and "Note". Saving shows "Marker saved — scoring restarts from this point". The panel then shows the banner "Scoring since … — provisional, N of 14 days reported", a "Provisional" pill, "Before → since", and "Marker history" with a Clear action ("Clear marker"). The device list reliability badge turns grey with the title "provisional (recent fix or reimage)". The device Activity feed shows `device.reliability.*` rows with a shield icon. | Offline fixture devices are fine. Needs a device with reliability data and `devices:write`. SQL: reliability score history. Remediated requires a note. | B | PASS |
| #8319 | Reliability baseline markers API (W01) | api-only | Covered through #8323's UI. Reimage reset comes from heartbeat/enrolment. | Automatic marker shows "Breeze (automatic)" in marker history. | Live agent for the auto-reset path (BLOCKED). The manual path works through the UI. | B | N/A, covered by #8323 |
| #8348 | Physical placement for devices and discovered assets | api-only | None in the UI (`devices/placement.ts`, `discoveryAssetPlacement.ts`). | Nothing visible. Check through API/curl only. | API token. | E | N/A, no UI yet |
| #8223 | Site location pins; location-sites read; partner toggle | web | `/settings/ticketing#timeTracking` (Time tracking card, partner scope) | New toggle "Suggest a timer when a technician arrives at a client site". Help text: "Each technician must also allow location on their phone. Location is checked on the phone and is never sent to Breeze." Enabling shows "Default arrival radius (m)", range 50–1000 (default 150). An out-of-range value gives "Arrival radius must be between 50 and 1000 meters". If the load fails, Save is disabled and "Could not load the saved settings…" shows. | Partner admin. Pins are written by the mobile app, so no pin UI is testable here. | C | PASS |
| #8175 | Portal performance metrics visibility | web (setting). The portal has no page in this PR. | `/settings/organization#portal` (`OrgPortalSettingsEditor` > visibility toggles) | New toggle "Performance metrics": "Show read-only CPU, memory, disk and network performance trends for your customer's machines." It defaults to on and persists across a save and reload. API `GET /portal/performance/overview` returns `PORTAL_PERFORMANCE_METRICS_DISABLED` when it is off. | A seeded org. Portal user login for the API path. No portal page consumes it yet, so curl is needed. | C | PASS |
| #8286 | Client AI templates: dedicated permissions plus MFA on writes | web | `/ai-for-office#templates` | The Templates tab (`ai-office-tab-templates`) shows only with `client_ai_templates:read`. Without it, a `#templates` deep link falls back to `#orgs`. Create, edit and delete need `client_ai_templates:write` plus an MFA-assured session, so a non-MFA session gets an MFA-required refusal. | Roles: a custom role without the grant, a role with read only, and one with the `*:*` wildcard. MFA enrolled for the write path. The AI-for-office feature may be partner-scope and EE-gated. | D | PASS |
| #8303 | Ticket webhooks wave 4 (`ticket.updated`/`assigned`) | web | `/integrations/webhooks` > create or edit webhook > event list | New events "Ticket Updated" ("Triggered when ticket fields are edited."), "Ticket Assigned" ("Triggered when a ticket is assigned or unassigned."), "Ticket Commented" and "Ticket Status Changed". Delivery log is visible after editing or assigning a ticket. | Outbox worker running. A webhook sink needs outbound HTTP, so use a local echo URL. SQL: a ticket. | D | PASS |
| #8344 | Customer email replies write a `ticket.commented` outbox row | api-only | None | A webhook for `ticket.commented` fires on an inbound reply. | Inbound email (BLOCKED locally). SQL: insert a comment and check the outbox. | E | N/A, inbound email needed |
| #8332 | Service principal keys issued by owner; end with owner's sessions | api-only, with a visible consequence | `/settings/partner-service-principals`, and `/settings/api-keys` for key issue and rotate | Keys can be issued and rotated only by the owner. A key stops working after the owner's sessions end. | Partner scope, with a second user to test non-owner refusal. Migration `partner-sp-key-owner-epochs`. | D | PASS |
| #8327 | Diagnostics: credential stores never grantable; self-approval needs second factor | api-only, with a visible consequence | `/approvals` and the device diagnostics/access grant flow. No page changed in the diff. | Requests naming a credential store are refused. Self-approving needs a second factor. | A live agent or device for a diagnostics session (BLOCKED). Only the API refusal is testable. | E | N/A, live agent needed |
| #8226 | Scoped contact responsibilities | api-only | None in the diff. Org Contacts tab at `/settings/organizations/<id>` is the closest existing UI. | No UI change. API only. | Two contacts with different scopes (SQL). | E | N/A, API only |
| #8316 | Converting a quarantined M365 email keeps body and sender name | api-only | None | The converted ticket keeps its body and sender name. | M365 connection (BLOCKED). SQL: a quarantined email row. | E | N/A, M365 required |
| #8282 | DB pool admission gate, lag-tolerant deadlines, deferred reclaim | api-only | None | None. Behaviour under load only. | Env vars below. Load test only. | E | N/A, infra only |
| #8259 | EDR W01b: provider framework and Bitdefender GravityZone read path | api-only | `/security/edr` shows no changes in the diff. Routes are `routes/edr/*`. | Nothing new visible. The provider list may include GravityZone through the API. | A GravityZone tenant (BLOCKED). | E | N/A, real EDR needed |
| #7619 | Cloudflare Gateway DNS: real APIs for event sync and list edits | web (indirect) | `/dns-security` > integration > sync | Sync pulls Gateway events and edits lists. | A Cloudflare account (BLOCKED). | D | N/A, Cloudflare account needed |
| #8213 | Breeze Assist starts hidden; tray-icon setting removed | web (setting removed), helper | `/configuration-policies/<id>` > Helper tab | The "Show tray icon" checkbox is gone. The context-menu text reads "Configure which items appear in the Breeze Assist right-click context menu." A stored `showTrayIcon` is dropped on the next save. | A policy with a Helper link. The helper app itself needs a live device (BLOCKED). | B | PARTIAL |
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
| 2 | Login + every sidebar destination renders, primary data call status, console errors | PASS — 134 routes, none broken |
| 3 | Everyday workflows (devices, device actions, alerts, scripts, patches, remote, search, filters/tags/custom fields, reports/audit, theme/profile) | PARTIAL — audit export fails silently; Cmd+K settings search; tags no feedback |
| 4 | Setup tasks (org/site, users/roles, enrollment, notification channels, config policies, partner settings, monitoring/discovery, backup/DR, integrations) | TODO |

## Sweep log (append as you go)

### Groups A + D (+ Phase 4 notification channels, billing tab) — opus agent, headless Playwright, 2026-10-10

#### [#8363 / Org payment settings step-up] — PASS
- Payments section renders without Stripe Connect: `OrgBillingSettings` shows `OrgPaymentsSettingsSection` whenever GET `/orgs/:id/billing/payment-settings` succeeds; the reminders block (`autopay-reminders-section`) always renders, the autopay block only with `autopayEnabled` (false here). No fixture needed.
- ✅ `/settings/organizations/<Default Org>#billing`, untouched Save (`org-billing-save`): only PATCH `/billing-settings` 200, NO payment-settings PUT; toast "Organization billing settings saved".
- ✅ admin (factorless): "Send payment reminders" → Enabled → Save → PUT 403 `{"code":"STEP_UP_REQUIRED","stepUp":{"operation":"org_payment_settings_update","resource":{"orgId":…,"settings":{"remindersEnabled":true,…}}}}`; no error toast; panel `billing-stepup`: "Confirm it's you / Changing this organization's payment settings needs a fresh second-factor check for these exact values. / Add an authenticator app or passkey to your account first. Set up a second factor" (link → /settings/profile, new tab), Confirm disabled. Cancel → panel gone, no request, draft kept (select still Enabled), nothing written (DB had no row).
- ✅ qa-mfa (TOTP): same change → 403 → panel shows "Authenticator code" + Confirm/Cancel → code → POST /auth/mfa/step-up 200 `{stepUpGrantId}` → PUT 200 (remindersEnabled source `org`) → PATCH billing-settings 200; panel closed; toasts "Reminder settings saved" + "Organization billing settings saved". DB `billing_payment_settings` row for the org, `reminders_enabled=t`.
- ✅ API (admin session): PUT with the stored values and no grant → 200 (no step-up); changed value without grant → 403 STEP_UP_REQUIRED; changed value with another user's already-consumed grant id → 403 STEP_UP_REQUIRED.
- ⚠️ UI/UX: one Save click produces two success toasts ("Reminder settings saved" + "Organization billing settings saved"); the first one names only reminders even though it is the payment-settings save.

#### [#8358 / Autopay charge-now, partner payment settings, request-recipient step-up] — PARTIAL (real charge + cap-before-charge BLOCKED on Stripe)
- SQL fixture (sweepB-AD/fx-autopay.sql, scope=system): `partners.autopay_enabled=true` (Default Partner); `stripe_connect_accounts` aaaa0001-… (status connected, acct_qa_sweepb, US, capabilities checked, api_key 'qa-dummy-not-a-key'); `org_autopay_enrollments` aaaa0002-… (Default Org, active, gen 1); `org_payment_methods` aaaa0003-… (card visa 4242, active, autopay method); invoice aaaa0004-… `QA-AUTOPAY-1` (sent, $120 USD, due -5d); `billing_notice_outbox` aaaa0005-… (invoice_autopay, sent -10d); `invoice_autopay_schedules` aaaa0006-… (eligible, scheduled, terms kind=terms card 4242 lead 1, notice sent -10d). Org `QA Org B` bbbb0001-… (SQL).
- ✅ Partner Payments tab `/settings/billing#payments`, admin (factorless): Payment reminders → Disabled → Save (`autopay-settings-save`) → PUT `/partner/billing/payment-settings` 403 STEP_UP_REQUIRED `{operation:"partner_payment_settings_update",resource:{partnerId,settings:{remindersEnabled:false,…}}}`; panel "Confirm it's you / Changing payment settings needs a fresh second-factor check for these exact values. / Add an authenticator app or passkey to your account first. Set up a second factor"; no error toast.
- ✅ qa-mfa: Enabled → Save → panel with "Authenticator code" → wrong code 000000 → POST /auth/mfa/step-up 400 `mfa_proof_invalid`, inline "Invalid credentials", panel stays → right code → step-up 200 → PUT 200 (remindersEnabled source partner) → toast "Reminder settings saved", panel closes.
- ✅ Charge now `/billing/invoices/aaaa0004…`: panel "Automatic payment / Scheduled / Charge on or around 10/9/2026 / Charge now" (enabled). Click → dialog "Confirm automatic payment / Charge up to $120.00, including any processing fee, for invoice QA-AUTOPAY-1 using Visa ending 4242?" → Charge now → POST charge-now 403 `{operation:"autopay_charge_now",resource:{invoiceId}}` → step-up panel inside the dialog "Charging this invoice now needs a fresh second-factor check." admin: enroll link, Confirm disabled; Cancel closes the dialog, nothing charged.
- ✅ qa-mfa: code → step-up 200 → resubmit with grant accepted → 409 `{"code":"stripe_unavailable","outcome":"deferred"}` (fake connect account; Stripe method-admission call fails) → toast "Stripe unavailable", dialog closes, schedule still Scheduled.
- ✅ Recipient override, `/settings/organizations/<QA Org B>#billing` → card "Automatic payment enrollment / Not requested" → recipient `someone-else@example.com` → Send request → POST `/billing/autopay/requests` 403 `{operation:"autopay_request_recipient",resource:{orgIds:[QA Org B],recipientOverride:"someone-else@example.com"}}` → panel "Sending the authorization request to an address other than the billing contact needs a fresh second-factor check." admin: enroll link. qa-mfa: code → 200 `{"requested":[QA Org B],"skipped":[]}` → toast + inline "Request sent to someone-else@example.com."
- BLOCKED: a real charge and the "cap checked before charge" path. `reserveCollection` calls Stripe in `prepareMethodAdmission` before the cap check, so with a fake connect account it always defers with `stripe_unavailable` first. Needs a Stripe test connect account with a saved test payment method.
- ⚠️ UI/UX: the wrong-code error says "Invalid credentials" (generic; a "That code didn't work, try the current code" would be clearer). Charge-now deferral toast is "Stripe unavailable" (raw reason, no next step).
- Side effect: the deferred charge enqueued an autopay staff-attention item ("Stripe credentials require attention…").

#### [#8248 / Quotes need a part number for the parts order] — PASS
- Fixture (API, admin): draft quote `QA Part Number Quote` Q-2026-0001 (41dbdb87-…, Default Org) with manual lines iPad (cost 300, no PN), Cable (cost 5, no PN), Switch (cost 200, PN SW-24), Setup labor (no cost).
- ✅ `/billing/quotes/41dbdb87…` editor: iPad and Cable carry `quote-line-partnumber-hint-<id>` "Add a part number to include this in the parts order."; Switch (has PN) and Setup labor (no cost, service-like) have none. With "Show cost & margin" off (the default) the hint is not visible (band hidden; matches the PR's reviewer note); after "Show cost & margin" it shows under each line's INTERNAL band.
- ✅ Live: expand Cable's band, type `CBL` into PN (no blur) → hint disappears; clear it → hint returns.
- ✅ Add-manual-line form (new draft `QA Manual Line Hint` 1a3e5baf-… → Pricing table → add line): no hint with only name+price; after Cost 120 → `quote-manual-partnumber-hint-<block>` "Add a part number to include this in the parts order."; after PN DOCK-1 → hint gone.
- ✅ Send proposal: `quote-send-no-part-number-warning` "2 product lines have no part number and won't be added to the parts order."; confirm button reads "Send anyway". Sent to qa-client@example.com → status Sent (inline note "Proposal marked Sent, but no email was delivered — email is not configured on this server. Use "Copy share link"…").
- ✅ Accept on behalf (Purchase order, PO-QA-8248) → POST accept-on-behalf 200, toast "Quote accepted. Invoice INV-2026-0001 issued." → Details tab "TO BE ORDERED · 1 item" lists only Switch (SW-24, $200.00) and footer `quote-order-breakdown-excluded` "Not in this order (no part number): iPad, Cable".

#### [#8249 / Public quote "Sign & pay" goes straight to checkout] — PARTIAL (successful checkout redirect BLOCKED on real Stripe)
- Fixture: two quotes sent via API with a share link (GET `/quotes/:id/share-link`): Q-2026-0002 `QA Sign & Pay deposit` (31333c26-…, 2 × $250, 50% deposit) and Q-2026-0003 `QA Sign & Pay full` (b98f1092-…, no deposit). `payOnAccept` comes from `stripe_connect_accounts` status connected + api_key (the #8358 fixture row).
- ✅ Portal `/portal/quote/<token>` (deposit): panel text "Type your full legal name to sign and accept this proposal. You'll then go to secure payment." and button "Sign & pay deposit $250.00". No-deposit quote: "Sign & pay $500.00" with the same note.
- ✅ Control: SQL set the connect row to `disconnected` → same deposit page shows plain "Accept & sign" and no "secure payment" sentence. Row restored to connected afterwards.
- ✅ Sign (connected, fake key): POST `/quotes/public/:token/accept` 200 `{"status":"converted","invoiceUrl":"…/portal/invoice/<token>","checkoutUrl":null,"payDeferred":false}`; API log `[quoteAcceptCheckout] checkout mint failed after accept … StripeAuthenticationError` (reported, not swallowed); the portal fell back to `location.replace(invoiceUrl)`. The fallback text ("Signed and accepted. We couldn't open payment just now — you can pay from your invoice.") only flashes before the redirect, so I could not capture it.
- BLOCKED: the success path (`checkoutUrl` minted, then redirect to Stripe Checkout with the "Taking you to secure payment." message) needs a real Stripe test connect account.
- ⚠️ ENV (not a product bug): this stack's api has `PUBLIC_APP_URL` set to the production hosted domain and `PUBLIC_PORTAL_URL=https:///portal`, so share links and the post-accept `invoiceUrl` point at the hosted domain. Locally the redirect lands on a Cloudflare 1033 page. I swapped in `http://localhost:33205` by hand.

#### [#8303 / Ticket webhooks wave 4: ticket.updated / ticket.assigned] — PASS
- Fixture: an echo receiver container `qa-sweepb-echo` (node:22-bookworm-slim on the stack network `breeze-wt-qa-sweep-b-b41ca83e41_breeze`, logs every POST). `host.docker.internal` resolves to 0.250.250.254, which the webhook URL safety check always refuses, so the receiver runs on the stack network. Self-host (`IS_HOSTED=false`) allows http to RFC1918.
- ✅ `/integrations#webhooks` → New Webhook: ticket events listed with labels and descriptions: "Ticket Created / Triggered when a ticket is created.", "Ticket Commented / Triggered when a comment or note is added to a ticket.", "Ticket Status Changed / Triggered when a ticket changes status.", "Ticket Updated / Triggered when ticket fields are edited.", "Ticket Assigned / Triggered when a ticket is assigned or unassigned." Created `QA Ticket Hook` → `http://qa-sweepb-echo:8080/hook` with all 5 → POST /webhooks 201, toast "Webhook created".
- ✅ `/tickets/new` → "QA webhook ticket" → toast "Ticket T-2026-0001 created". Then on the workbench: priority → High (PATCH 200), assign QA Partner Tech (POST /assign 200), internal note (POST /comments 201), status → Pending with reason (POST /status 200, toast "Status updated"), unassign.
- ✅ Each produced a `ticket_outbox` row (published) and a `webhook_deliveries` row `delivered` HTTP 200, received by the echo with the `Breeze-Webhooks/1.0` UA and a signature header. The payloads are id-only:
  - `ticket.created` `{ticketId,source:"manual",partnerId,assigneeId:null,actorUserId,internalNumber:"T-2026-0001",actorPrincipalId:null}`
  - `ticket.updated` `{ticketId,changed:["priority","responseSlaMinutes","resolutionSlaMinutes"]}`
  - `ticket.assigned` `{ticketId,partnerId,assigneeId:<qa-tech>,actorUserId,actorPrincipalId:null}`, and on unassign `assigneeId:null`
  - `ticket.commented` `{ticketId,isPublic:false,commentId,originPrincipalId:null,originPrincipalKind:"user"}`
  - `ticket.status_changed` `{ticketId,from:"open",to:"pending",statusId}`
  - No subject, description or comment body in any payload.
- ✅ The webhook detail's Delivery History lists "6 delivery attempts" (created/updated/assigned/commented/status_changed/assigned, all Success HTTP 200).
- ⚠️ Observation (pre-existing, `ticketService.ts:1953`, 2026-08-07): assigning a `new` ticket silently moves it to `open`. That emits `ticket.assigned` but no `ticket.status_changed` and no status feed entry, so a webhook mirror never sees the new→open transition. Med.
- ⚠️ The assignee picker offers an invited (never activated) user ("QA Invite Admin") and a billing-only user. Low.

#### [#8332 / Service-principal keys issued by the owner; end with the owner's sessions] — PASS
- ✅ Owner qa-pa2 (Partner Admin, factorless) `/settings/partner-service-principals` → Create → device-status:read → "QA SP owned by pa2" (POST 201, id 98657b0e-…) → Issue key "pa2-key" (POST /keys 201) → key on `GET /api/v1/partner-api/device-status` → 200.
- ✅ Non-owner admin, same page: Issue key → POST /keys 403 `{"error":"Only this service principal's owner can issue or rotate its keys, re-enable it, or widen its access","code":"SERVICE_PRINCIPAL_OWNER_REQUIRED"}`, shown as a toast, no key reveal. Rotate on pa2-key → POST /keys/:id/rotate 403, same body and toast.
- ✅ Non-owner PATCH (API, admin session): adding `tickets:read` → 403 SERVICE_PRINCIPAL_OWNER_REQUIRED; removing `scripts:read` → 200 (narrowing stays open). Key still 200 afterwards.
- ✅ Owner ordinary logout (POST /auth/logout 200) → key still 200.
- ✅ Owner password change via `/settings/profile` (POST /auth/change-password 200 "Password changed successfully") → same key → **401** `{"error":"Invalid partner API credentials","code":"partner_api_invalid_credentials"}`. qa-pa2's password is now `QaPa2!NewPassw0rd2026`.
- ✅ Org API keys: admin created "QA admin key" (POST /api-keys 201); admin Rotate → 200 + new-key modal; qa-mfa (another Partner Admin, not creator) Rotate → 403 `{"error":"Only the API key's creator can rotate it. Revoke it and create a new key instead.","code":"API_KEY_CREATOR_REQUIRED"}`, toasted.
- ⚠️ UI/UX: the SP page never says who owns a principal and still shows Issue key, Rotate and scope-widening Edit to non-owners, which can only 403. A non-owner Issue key showed the same refusal toast twice. Low/med.
- ⚠️ UI/UX: after a successful API-key Rotate, the reveal modal reads "API Key Created / Your new API key has been created successfully." (create copy reused for rotate). Low.
- Not checked: MCP refusing a key issued by a non-owner. That needs a pre-PR key issued by another admin, which can't be made through the UI any more.

#### [#8286 / Client AI templates: own read/write permissions + MFA on writes] — PASS
- Fixtures:
  - Custom role `QA No Templates` (org-scoped, Default Org, organizations:read+write only), created via the `/settings/roles` UI (toast `Role "QA No Templates" created`). The role editor lists a separate "AI for Office Templates" row.
  - SQL users (password BreezeAdmin123!): qa-notpl@ (org user → QA No Templates), qa-tech@ (Partner Technician: templates read), qa-billing@ (Partner Billing: no grant), qa-invite@ (Partner Admin, status invited).
  - A Redis `invite:<sha256>` key for qa-invite, so its accept-invite session has `mfa:false` (password `QaInvite!Passw0rd2026`).
  - **Stack change:** the API gates the whole `/client-ai/admin/*` group on `CLIENT_AI_ENTRA_CLIENT_ID` (empty → 404 "Breeze AI for Office is not enabled"). I recreated only the api container with `CLIENT_AI_ENTRA_CLIENT_ID=qa-sweepb-dummy-client-id` (shell env on `docker compose … up -d --no-deps --no-build api`; I diffed the rendered compose env against the running container first: identical) and ran SQL `partners.ai_for_office_enabled=true`. The API was down about 20 s. **Still set.**
- ✅ Tab matrix on `/ai-for-office#templates`:
  - qa-billing and qa-notpl: no Templates tab; the deep link falls back to `#orgs`.
  - qa-tech: Templates tab shows the list (2 rows); no Create, Edit or Delete.
  - admin and qa-mfa: Templates tab with Create, Edit and Delete.
- ✅ API matrix:
  - qa-billing and qa-notpl: GET /templates, GET /templates/org-options, POST and a malformed POST `{bogus:true}` all return 403 "Permission denied". The malformed POST is refused before validation.
  - qa-tech: GET 200. org-options, POST and PUT return 403.
  - admin and qa-mfa: org-options 200 `[Default Organization, QA Org B]`, and only Default Organization with `?orgId=Default`. POST 201, PUT 200, malformed POST 400.
- ✅ Write in the UI with TOTP (qa-mfa): the Create dialog's scope options are "All organizations (partner-wide)" and "Default Organization". Save → POST 201, toast "Template created". Delete → DELETE 200, toast `Template "…" deleted`.
- ✅ Non-MFA session (qa-invite via accept-invite, `mfa:false`), each answered 403 `{"error":"MFA required","code":"MFA_REQUIRED"}`:
  - Create: toast "Multi-factor authentication is required", dialog stays open.
  - Edit: refused.
  - Delete: same toast, the row stays.
- Note: factorless admin@ passes the MFA gate, because its password login carries `mfa:true` (mfa_src policy) while the team doesn't require MFA. This matches the other requireMfa routes.
- ⚠️ UI/UX: on an instance without `CLIENT_AI_ENTRA_CLIENT_ID`, the Organizations tab explains "Breeze AI for Office is not enabled on this instance…", but the Templates tab says only "Failed to load templates. Retry". Low.

#### [extra / AI for Office: partner-wide templates hidden from the list] — FAIL (pre-existing, `adminTemplates.ts:96`, 2026-08-07)
- ❌ BUG: qa-mfa creates a template with scope "All organizations (partner-wide)" → POST `/client-ai/admin/templates?orgId=<Default Org>` 201 `{"template":{"id":"62a82703…","orgId":null,…}}`, toast "Template created". The list still shows 1 row, and the new template never appears.
  - The web always sends the header org (`GET /client-ai/admin/templates?orgId=0662de12…`).
  - The route then filters `if (q.orgId) rows = rows.filter((r) => r.orgId === q.orgId)`, which drops every `org_id IS NULL` (partner-wide) row.
  - API proof: without `?orgId` → `["QA api tpl qa-mfa|<org>","QA tpl qa-mfa|partner"]`; with `?orgId=<Default Org>` → only the org row.
  - Partner-wide templates can't be seen, edited or deleted from the UI while an org is selected in the header, which is the normal state.
  - Suggested fix: include `orgId === null` rows when narrowing (or ignore the ambient orgId in TemplatesTab).

#### [extra Phase 4 / Notification channel: Webhook create, validate, test, delete] — PASS
- ✅ `/alerts/delivery` → New Channel: the type cards are Email, Slack, Microsoft Teams, PagerDuty, Webhook, SMS, Pushover. An empty submit gives the inline "Channel name is required" and sends no request.
- ✅ Webhook URL `not a url` → POST `/alerts/channels` 400 `{"error":"Invalid webhook channel configuration","details":["Invalid URL format"]}` → toast "Invalid webhook channel configuration: Invalid URL format", and the modal stays open.
- ✅ Valid `http://qa-sweepb-echo:8080/channel` → 201, toast `Channel "QA Echo Webhook Channel" created`. Test → POST `/channels/:id/test` 200, toast `Test notification sent to "QA Echo Webhook Channel"`. The card shows "Success · Last test: Just now", and the echo received `{"event":"alert.triggered",… "alert":{"id":"test-alert-id",…}}` (UA Breeze-RMM/1.0).
- ✅ An unreachable `http://10.255.255.1:9/dead` channel → Test → after about 15 s, toast "Channel test failed" and card "Reason: aborted" (`notification-channel-last-test-error`). Delete → confirm → DELETE 200, toast `Channel "QA Dead Webhook" deleted`.
- ⚠️ UI/UX: the client never checks the webhook URL (the schema field is a plain optional string). A malformed URL only comes back as a server toast, with no inline error at the URL field. Low.

#### [extra Phase 4 / Partner settings → Billing tab validation] — PARTIAL (works, poor validation UX)
- ✅ `/settings/billing#defaults` (tabs Defaults, Documents, Rates, Payments, Connections): a valid save (terms 30) → PATCH `/partner/billing-settings` 200, toast "Billing settings saved", and the value survives a reload. The invoice prefix input caps at 12 characters (40 typed → 12 saved).
- ⚠️ Out-of-range values are not stopped in the browser. The inputs carry min/max, but Save stays enabled and posts:
  - tax 150 → 400 `{"error":"defaultTaxRate: Too big: expected number to be <=1",…}`
  - tax -5 → 400 "Too small: expected number to be >=0"
  - terms 400 → 400 "<=365"
  - terms 2.5 → 400 "Invalid input: expected int, received number"
- ⚠️ Each one is toasted as raw zod text plus "Check the highlighted fields", but no field is highlighted (no inline error under `main`). For tax, the message says "<=1" while the field is a percent capped at 100. Med. Suspected: `BillingDefaultsTab.tsx` / `PartnerBillingSettingsPage.tsx` save path (no client range check, no fieldErrors mapping).

**Fixtures / stack changes left**
- Users (password BreezeAdmin123! unless noted):
  - qa-mfa@ (082c1c92…, Partner Admin, TOTP `X6DK2EBXLE5PRXGQQ7SFEVNAQ7WCIIAZ`)
  - qa-pa2@ (a40f6731…, Partner Admin, password now `QaPa2!NewPassw0rd2026`)
  - qa-tech@ (6f58e9a0…, Partner Technician)
  - qa-billing@ (2f256443…, Partner Billing)
  - qa-notpl@ (4799bee5…, org user, custom role `QA No Templates` 83222599…)
  - qa-invite@ (21b8b304…, Partner Admin, now active via accept-invite, password `QaInvite!Passw0rd2026`)
- Org `QA Org B` (bbbb0001-0000-4000-8000-000000000001). It now has an autopay enrollment in `requested` (recipient someone-else@example.com).
- Autopay fixture (fx-autopay.sql):
  - `partners.autopay_enabled=true`
  - stripe_connect_accounts aaaa0001… (connected, fake key). This makes `payOnAccept` true and shows "Online payment is enabled" in the quote send dialog.
  - enrollment aaaa0002…, payment method aaaa0003…
  - invoice QA-AUTOPAY-1 aaaa0004… with outbox aaaa0005… and schedule aaaa0006… (still scheduled)
  - one staff-attention item from the deferred charge
- `billing_payment_settings`: Default Org reminders_enabled=true; partner row reminders_enabled=true.
- Quotes:
  - Q-2026-0001 converted → INV-2026-0001
  - Q-2026-0002 and Q-2026-0003 converted via public sign → 2 invoices
  - draft `QA Manual Line Hint` (1a3e5baf…)
- Ticket T-2026-0001 (1078227e…, pending, unassigned) with an internal note. Webhook `QA Ticket Hook` (113e1d6d…) → `http://qa-sweepb-echo:8080/hook`. The echo container is now removed, so later deliveries to it will fail.
- Partner SP `QA SP owned by pa2` (98657b0e…) with key pa2-key (now invalid: owner password changed). Org API key `QA admin key` (a4ee39c6…, rotated).
- AI for Office: `partners.ai_for_office_enabled=true`. Templates `QA tpl qa-mfa` ×2 (partner-wide) and `QA api tpl qa-mfa` (Default Org).
- Role `QA No Templates`. Notification channel `QA Echo Webhook Channel` (77533c7d…).
- **API container recreated with `CLIENT_AI_ENTRA_CLIENT_ID=qa-sweepb-dummy-client-id`.** To revert, run the same `docker compose -p breeze-wt-qa-sweep-b-b41ca83e41 -f docker-compose.yml -f docker-compose.override.yml.dev -f docker-compose.override.yml.worktree --env-file .env --env-file .env.stack up -d --no-deps --no-build api` without that variable.

### Groups B + C, Phase 3 workflows, Phase 2 crawl — opus agent, headless Playwright, 2026-10-10

**Fixtures**
## SQL fixtures applied
- F1: 30 rows `device_reliability_history` for device e2e-windows.local (e65460f3-…) collected_at now-1..30d, bsod every 6th day, outlook.exe hang every 4th, Spooler failure every 5th (system scope).
- F2: `device_reliability` row for e65460f3-… score 58, degrading.

## Fixtures left in DB
- F1/F2: reliability history (30 rows) + device_reliability row for e2e-windows (e65460f3…).
- F3: active reimaged baseline marker 0e43a733-… + cleared remediated marker d64fdeb2-… on e2e-windows.
- F4: config policy "QA SweepB Helper Policy" f31a3e98-… (partner-wide) with helper link 2d263aa0-….
- F5: partner settings timeTracking.locationSuggestions {enabled:true, defaultRadiusM:300}.
- F6: portal_users portal@breeze.local password_hash = admin's (password BreezeAdmin123!). Portal Performance metrics toggle left OFF (default).
- Script "QA SweepB Script (edited)" dfac6ca1-… + 1 queued execution on e2e-windows; 2 queued patch-scan commands (both devices).
- Alerts: be645141 (disk full) acknowledged; 6e5887d5 (high CPU) resolved.
- Tag `qa-sweepb` on e2e-windows; custom field `qa_sweep_rack` deleted (its device value R12-U3 may linger in devices.custom_fields).
- Device list column prefs/page size are localStorage-only (sweep browser contexts).

#### [#8323 reliability baseline markers UI] — PASS
- ✅ `/devices/e65460f3…` Overview reliability panel shows "Mark work done" (`reliability-mark-work-done`). Dialog "Mark work done on this device": labels "What was done" (options Remediated / Reimaged / Hardware replaced), "When the work finished" (datetime min = now-30d, max = now), "Note *".
- ✅ Remediated with empty note → Save disabled; with note → enabled. Save → POST /reliability/:id/baselines 201 → toast "Marker saved — scoring restarts from this point".
- ✅ Banner "Scoring since Remediated on Oct 10, 2026, 03:40 PM by Breeze Admin — provisional, 0 of 14 days reported" + note; "Provisional" pill; trend and MTBF show "—"; "Before → since" Score 62→100, Crashes 5→0, Hangs 7→0, Service failures 6→0, "Before based on 31 days of history"; "Marker history (1)" with Active + Clear.
- ✅ Device list (after enabling the Reliability column via Columns menu, hidden by default): pill "100", grey `bg-muted text-muted-foreground`, title "Reliability 100/100 · provisional (recent fix or reimage)".
- ✅ Clear → confirm dialog "Clear marker" → DELETE 200 → toast "Marker cleared"; banner + pill gone; score back to 62; history shows "Cleared".
- ✅ Activity feed rows "Reliability baseline set — e2e-windows.local" / "Reliability baseline cleared — …" with `lucide-shield-check` icon.
- ✅ Reimaged, backdated 3 days, no note → Save enabled, toast "Marker saved — scoring restarts…", banner "… Reimaged on Oct 7, 2026, 10:00 AM … provisional, 3 of 14 days reported".
- Fixture left: F3 active reimaged marker 0e43a733-… on e2e-windows (cleared remediated marker d64fdeb2-… also remains in history).

#### [#8213 Helper tab — tray-icon setting removed] — PASS (web half; helper app BLOCKED: needs live device)
- ✅ Created partner-wide config policy "QA SweepB Helper Policy" (f31a3e98-…) via /configuration-policies/new → Configure new → POST 201, landed on detail.
- ✅ `#helper` tab: no "tray icon" text anywhere; text "Configure which items appear in the Breeze Assist right-click context menu." present; options Open Breeze Portal / Device Info / Request Support / Custom Portal URL / lifecycle.
- ✅ Save → POST features 201, toast "Saved"; inlineSettings has no showTrayIcon.
- ✅ SQL-injected `showTrayIcon:false` into the link (F4), reloaded, Save → PATCH 200 toast "Saved"; DB inline_settings no longer contains showTrayIcon.
- BLOCKED: Breeze Assist starts-hidden behaviour (needs a live Windows/macOS device with the helper).
- Fixtures: F4 config policy f31a3e98-… + helper link 2d263aa0-… (left in place).

#### [#8223 time-tracking location suggestion toggle + radius] — PASS
- ✅ `/settings/ticketing#timeTracking` card: toggle "Suggest a timer when a technician arrives at a client site" + help "Each technician must also allow location on their phone. Location is checked on the phone and is never sent to Breeze." Default off, radius hidden.
- ✅ Enabling shows "Default arrival radius (m)" = 150, min 50 max 1000.
- ✅ 20 / 5000 / 150.5 + Save → inline "Arrival radius must be between 50 and 1000 meters", zero write requests sent.
- ✅ 300 + Save → PATCH /orgs/partners/me 200 → toast "Time tracking settings saved"; reload shows toggle on, radius 300.
- ✅ Forced GET /orgs/partners/me 500 (route intercept) → Save disabled + "Could not load the saved settings. Saving is disabled until they load; refresh to try again."
- Fixture: partner settings timeTracking.locationSuggestions {enabled:true, defaultRadiusM:300} left (F5).

#### [#8175 portal Performance metrics toggle] — PASS
- ✅ Real route is `/settings/organizations/<orgId>#portal` (the row's `/settings/organization#portal` 301s to `/organizations#portal`, which opens the org list, not the portal editor — see paper cuts).
- ✅ Toggle row "Performance metrics | Show read-only CPU, memory, disk and network performance trends for your customer's machines."
- ℹ️ Initial state OFF, not on as the row says. That is by design: PR body + DB column `portal_branding.enable_performance_metrics DEFAULT false` (fail-closed). The row expectation was wrong; this is not a bug.
- ✅ On → Save → PATCH portal-settings 200, toast "Portal settings saved", reload = on. Off → Save → toast, reload = off.
- ✅ Portal API (portal@breeze.local session): ON → GET /portal/performance/overview 200 `{dataStatus:"no_data",series:[]…}`; OFF → 403 `{"error":"Performance metrics are not enabled for this portal","code":"PORTAL_PERFORMANCE_METRICS_DISABLED"}`; /portal/branding shows enablePerformanceMetrics:false.
- Fixture F6: portal_users portal@breeze.local password_hash copied from admin (password BreezeAdmin123!). Toggle left OFF (default).

#### [P3 devices list: search / quick filter / sort / page size] — PASS
- ✅ /devices "2 of 2 devices"; search "macos" → 1 of 2 (E2E macOS); "zzzz-nomatch" → 0 of 2 + "No devices found. Try adjusting your search or filters." + Clear.
- ✅ Quick chip Offline → chip "Status is offline", 2 of 2 (both fixtures render offline), URL hash filtersV2; filter-clear-all → 2 of 2; Online → 0 of 2 with empty state.
- ✅ Sort by Device toggles asc/desc order. Page size 50 persists across reload (localStorage). No console errors / non-2xx.

#### [P3 device detail tabs] — PASS
- ✅ /devices/42fc7de0… (e2e-macos): Details, Performance, Alerts, Event Log, Hardware, Software, Patches, Scripts, Overview each set the hash (#alerts, #eventlog…), render content, 0 non-2xx, 0 console errors. More menu lists 20 further tabs (Topology … Backup).

#### [P3 device actions on offline device] — PASS
- ✅ Run Script, Connect Desktop, Remote Tools, Power: disabled with title "Device is offline".
- ✅ Wake (enabled) → POST /devices/:id/commands 412 `{"code":"NO_MACS"}` → error toast "e2e-macos.local: No MAC address on file. The agent must check in at least once before Wake-on-LAN is available." Graceful.
- ⚠️ UI/UX: the only reason given for the disabled buttons is the native `title` tooltip (not visible on touch, not announced reliably).

#### [P3 alerts acknowledge / resolve / search] — PASS
- ✅ /alerts row "Ack" on "E2E fixture: disk full" → POST /alerts/:id/acknowledge 200 → toast "Alert Acknowledged"; row status Active → Acknowledged, Ack button removed.
- ✅ Row "Resolve" on "E2E fixture: high CPU" → opens the detail drawer → Resolve → "Resolution note" textarea → "Resolve Alert" → POST /resolve 200 → toast "Alert Resolved"; row now "Resolved", only Dismiss left.
- ✅ Search "disk" → 1 row.
- ⚠️ UI/UX: the row-level "Resolve" button does not resolve. It opens the drawer, where you click Resolve again and then "Resolve Alert". That is three clicks for a button labelled as the action.
- Fixtures changed: alert be645141 (disk full) → acknowledged; 6e5887d5 (high CPU) → resolved.

#### [P3 scripts create / run on offline device] — PASS
- ✅ /scripts/new: name "QA SweepB Script", Windows, Monaco content → Create Script → POST /scripts 201 → toast "Script created" → back to /scripts list with the row.
- ✅ Empty content → inline "Script content is required", no request sent.
- ✅ Row Run → modal; status filter defaults to Online → "No Online devices match. 1 compatible device is hidden by the status filter — show all devices to include it." + "Show all devices"; after that, e2e-windows (offline) is selectable → Execute → "Confirm Execution: Run “QA SweepB Script” on 1 device(s) as System…" → Confirm Execute → toast "Runs when the device is online"; Execution Details "Queued — device offline / Script is queued for delivery to the device". Graceful.
- Fixtures: script dfac6ca1-… "QA SweepB Script" (partner-wide) + 1 queued execution on e2e-windows.

- ✅ Edit: row 'Edit script' → /scripts/dfac6ca1… loads name; rename → Save → PUT 200 → toast 'Script saved' → list shows 'QA SweepB Script (edited)'.
#### [P3 patches view + filter + scan] — PASS
- ✅ /patches Compliance: filter options All (2) / Pending (2) / Critical (1) / Pending Reboot (0) / 3rd-Party Pending (0) / Compliant (0); counts match the rows; an empty filter shows "No devices match your filters."
- ✅ Patches tab (#patches): 3 synthetic patches; severity Critical → 1 row; search "Safari" → 1 row.
- ✅ Run Scan → "Confirm patch scan: Scan for patches on 2 devices in Default Organization?" → Scan → POST /patches/scan 200 → toast "Patch scan queued for 2 devices."
- ⚠️ UI/UX: both devices are offline (`dispatchedCommandIds:[]`, all pending), but the toast does not say the scans wait for the devices to come online. Script run says "Runs when the device is online".
- ⚠️ UI/UX: the Patches tab has no source filter (Microsoft / Apple / third-party). Third-party only shows up as a compliance-status bucket.

#### [P3 Cmd+K global search] — PARTIAL
- ✅ Meta+K opens the palette ("Search devices, scripts, alerts, users, settings…"). "e2e-windows" → Devices: E2E Windows Test Device → click goes to /devices/e65460f3…; "QA SweepB" → Scripts: "QA SweepB Script (edited)" → /scripts/dfac6ca1…; no-match query → empty, no errors.
- ⚠️ UI/UX (med): "enrollment" returns nothing, though the placeholder promises settings. The settings index in `apps/api/src/routes/search.ts` (lines 18-22) holds only 3 hard-coded entries (Profile, Security, User management). The web already has the full `lib/settingsCatalog.ts`, which the palette does not use.
- ⚠️ UI/UX (low): the "Recent" section still shows the old name "QA SweepB Script" after the rename. The recent-items cache is not refreshed.

#### [P3 custom field create → apply → delete] — PASS
- ✅ /settings/custom-fields → Add Custom Field → name "QA Sweep Rack" (key auto `qa_sweep_rack`), partner-wide → POST 201 → toast "Custom field created"; row "QA Sweep Rack · All organizations · Text".
- ✅ /devices/e65460f3…#details shows the field → pencil → "R12-U3" → save → PATCH /devices/:id 200 → toast "Custom field saved", value shown.
- ✅ Delete → DELETE 200 → toast "Custom field deleted", row gone.

#### [P3 saved views (device list) create → apply → delete] — PASS
- ✅ Online chip (0 of 2) → Views → "Save current" → name "QA online only" → POST /filters 201 → toast `Saved view "QA online only"`. Clear filters → 2 of 2; pick the view → 0 of 2, chip "Status is online". The view is also listed on /settings/filters.
- ✅ Delete (trash icon in menu) → DELETE /filters/:id 200 → toast `Deleted view "QA online only"`; entry gone.
- ⚠️ UI/UX (low): deleting a saved view takes one click, with no confirmation and no undo.
- ⚠️ UI/UX (low): "Save current" is disabled ("Build a filter first") when only the search box is used, so a search-term view can't be saved.

#### [P3 device tags: add → filter → remove] — PARTIAL
- ✅ Device actions menu → "Device Settings" → "Add a tag..." "qa-sweepb" → Save Changes → PATCH /devices/:id 200; modal closes. The tag is then visible on the Details tab under "Tags".
- ✅ /devices quick chip "Untagged" → 1 of 2 (only e2e-macos), so the tag was applied.
- ✅ Removing the tag in the same modal → PATCH 200.
- ❌ (low) No success feedback: no toast, and the default Overview tab shows no tags, so from Overview the save looks like the modal just closed. `DeviceSettingsModal.tsx` `handleSave` uses a raw fetchWithAuth with no runAction/successMessage, and the file is listed in `apps/web/src/lib/runActionAllowlist.ts`. This is a known exemption, but it still fails the "2xx with no visible confirmation" rule.
- ⚠️ UI/UX (low): device search "qa-sweepb" → 0 of 2 while the tag was set. The search box does not match tags.
- Fixture: tag `qa-sweepb` left on e2e-windows.

#### [P3 audit trail filter / paginate / export] — FAIL (export error path)
- ✅ /audit shows 25 rows, "Showing 1-25". Next → "Showing 26-50 of 84" with different rows; Previous → back to page 1.
- ✅ Filters panel (Date Range presets, User, Action Types, Resource Types, Apply Filters / Clear All). Apply with "Last 7 days" → GET /audit-logs?…&from=…&to=… 200.
- ✅ Export Logs → GET /audit-logs/export 200 → download `audit-logs-2026-10-10.csv` (95 lines, header id,timestamp,actorId,…).
- ❌ BUG: when the export fails, nothing tells the user. With GET /audit-logs/export forced to 500 `{"error":"boom"}`, clicking Export Logs shows no toast and no inline message, only a console 500. On success there is no toast either, just the browser download. Cause: `apps/web/src/components/audit/AuditLogViewer.tsx` `handleExportLogs` (~line 298) ignores `!response.ok` and has `catch { // Handle error silently }`.
- ⚠️ UI/UX (med): the export ignores the active filters. The request is `/audit-logs/export?orgId=…` with no from/to/action/resource, so after filtering to "Last 7 days" the CSV still holds every entry.
- ⚠️ UI/UX (low): page 1 says "Showing 1-25" with no total (skipCount=true); page 2 says "Showing 26-50 of 84".

#### [P3 theme toggle] — PASS
- ✅ Header "Theme" → Dark sets `<html class="dark">`, body bg rgb(13,16,23). Light and System → class '' and rgb(249,250,251). Dark persists across navigation; the /devices dark screenshot looks clean.

#### [P3 sign out / sign in] — PASS
- ✅ Account menu (Profile, Settings, API Keys, Service Principals, Trusted devices, Connected apps, Billing, Contact support, Activity Log, Sign out) → Sign out → POST /auth/logout 200 → /login. Going to /devices after that → /login. Signing in again → / "Good afternoon, Breeze".

#### [P3 notification channel create → Test → delete] — PASS
- ✅ /alerts/delivery → New Channel → "QA Sweep Webhook", type Webhook, URL https://qa-sweep.invalid/hook → POST /alerts/channels 201 → toast `Channel "QA Sweep Webhook" created`.
- ✅ Test → POST /channels/:id/test 200 with a failed testResult → error toast "getaddrinfo ENOTFOUND qa-sweep.invalid" + inline "Reason: getaddrinfo ENOTFOUND qa-sweep.invalid". The failure is visible, not silent.
- ✅ Delete → confirm → DELETE 200 → toast `Channel "QA Sweep Webhook" deleted`. A re-run had created a second channel; both were deleted, nothing left over.

<details><summary>Phase 2 nav crawl — 134 routes</summary>

#### [Part 2 nav crawl] — PASS (no route broken)

Pass 1: every sidebar destination (73 links, all groups expanded) + every /settings catalog link (29) → 90 unique routes. Pass 2: 44 pages not in the nav (found by diffing apps/web/src/pages against the rendered nav) + legacy redirects. Paced ≥1.5 s per page (~4 s load + 1.5 s gap).

| route | renders (h1 / main chars) | non-2xx calls | console errors |
|---|---|---|---|
| / | Good afternoon, Breeze / 1163 | — | — |
| /organizations | Organizations / 1143 | — | — |
| /devices | Devices & Assets / 731 | — | — |
| /devices/e65460f3-413c-4599-a9a6-90ee71bbc4ff | E2E Windows Test Device / 1513 | — | — |
| /alerts | Alerts / 698 | — | — |
| /approvals | Approvals / 731 | — | — |
| /incidents | Incidents / 326 | — | — |
| /remote | Remote Access / 377 | — | — |
| /scripts | Script Library / 394 | — | — |
| /jobs | Jobs / 455 | — | — |
| /patches | Patch Management / 762 | — | — |
| /vulnerabilities | Vulnerabilities / 707 | — | — |
| /fleet | Fleet Orchestration / 1048 | — | — |
| /workspace | (no h1) / 334 | — | — |
| /settings/ai-agents | AI Agents / 1042 | — | — |
| /ai-agents/runs | Agent runs / 361 | — | — |
| /ai-agents/impact | AI impact / 1168 | — | — |
| /ai-agents/fix-memory | Fix memory / 448 | — | — |
| /ai-agents/fleet-design | Fleet Design / 578 | — | — |
| /settings/ai-usage | AI Usage / 1102 | — | — |
| /settings/ai-script-authoring | Script authoring / 2560 | — | — |
| /settings/tool-sources | Tool Sources / 398 | — | — |
| /devices/groups | Device Groups / 453 | — | — |
| /configuration-policies | Configuration Policies / 523 | — | — |
| /software | Software Library / 329 | — | — |
| /software-inventory | Software / 430 | — | — |
| /software-policies | Software / 477 | — | — |
| /monitoring | Network / 591 | — | — |
| /discovery | Network Discovery / 490 | — | — |
| /onedrive | OneDrive / 594 | — | — |
| /security | Security / 1228 | — | — |
| /security/scans | (no h1) / 800 | — | — |
| /dns-security | DNS Security / 477 | — | — |
| /pam | Privileged Access / 849 | — | — |
| /security/user-risk | User Risk / 397 | — | — |
| /sensitive-data | Sensitive Data / 338 | — | — |
| /peripherals | Peripheral Control / 401 | — | — |
| /ai-risk | AI Risk Engine / 7656 | — | — |
| /cis-hardening | (no h1) / 577 | — | — |
| /audit-baselines | Audit Baselines / 400 | — | — |
| /backup | (no h1) / 2078 | — | — |
| /c2c | Cloud-to-Cloud Backup / 566 | — | — |
| /dr | Disaster Recovery / 651 | — | — |
| /tickets | Tickets / 616 | — | — |
| /timesheet | Timesheet / 441 | — | — |
| /billing/quotes | Quotes / 486 | — | — |
| /billing/autopay | Automatic payment / 337 | — | — |
| /billing/invoices | Invoices / 459 | — | — |
| /contracts | Contracts / 437 | — | — |
| /agreements/templates | (no h1) / 512 | — | — |
| /settings/catalog | Product Catalog / 1136 | — | — |
| /settings/deliverable-templates | Deliverable templates / 397 | — | — |
| /reports | Reports / 1465 | — | — |
| /analytics | Analytics / 769 | — | — |
| /devices/posture | Fleet Posture Report / 1080 | — | — |
| /devices/time | Time synchronization / 1443 | — | — |
| /audit | Audit Trail / 5802 | — | — |
| /logs | Event Logs / 451 | — | — |
| /settings/partner | Partner Settings / 1664 | — | — |
| /settings/billing | Billing settings / 1207 | — | — |
| /settings/ticketing | Ticketing Settings / 676 | — | — |
| /settings/users | Users / 654 | — | — |
| /integrations | Integrations / 599 | — | — |
| /settings | Settings / 1495 | — | — |
| /admin/account-deletion-requests | Account deletion requests / 405 | — | — |
| /admin/quarantined | Quarantined Devices / 438 | — | — |
| /admin/third-party-catalog | Third-Party Package Catalog / 1395 | — | — |
| /admin/llm-provider-catalog | LLM Provider Catalog / 301 | — | — |
| /admin/ai-models | AI models / 2417 | — | — |
| /admin/connected-apps | Connected apps (org-wide) / 425 | — | — |
| /admin/ai-kill-switch | AI Kill Switch / 610 | — | — |
| /admin/system | System / 14714 | — | — |
| /admin/monitor-conversion | Legacy alert conversion / 334 | — | — |
| /settings/partner#security | Partner Settings / 1568 | — | — |
| /settings/roles | Roles / 1425 | — | — |
| /settings/sso | Single Sign-On / 423 | — | — |
| /settings/access-reviews | Access Reviews / 659 | — | — |
| /settings/profile | Profile settings / 2961 | — | — |
| /settings/api-keys | API Keys / 386 | — | — |
| /settings/partner-service-principals | Service principals / 310 | — | — |
| /settings/billing#payments | Billing settings / 2657 | — | — |
| /settings/ticketing#templates | Ticketing Settings / 650 | — | — |
| /settings/enrollment-keys | Enrollment Keys / 404 | — | — |
| /settings/custom-fields | Custom Fields / 437 | — | — |
| /settings/variables | Variables / 397 | — | — |
| /settings/filters | Saved Filters / 423 | — | — |
| /settings/alert-templates → /alerts/monitors | Monitors / 1547 | — | — |
| /settings/partner#ai-provider | Partner Settings / 7087 | — | — |
| /settings/connected-apps | Connected apps / 795 | — | — |
| /settings/office-addin-bindings | Outlook add-in bindings / 390 | — | — |
| /alerts/correlations | Alert Correlations / 467 | GET /api/v1/alerts/correlations 401 {"error":"Missing or invalid authorization header","message":"Missing or invalid authorization header"}; POST /api/v1/auth/refresh 401  | 3 |
| /alerts/delivery | Delivery / 1529 | — | — |
| /alerts/monitors | Monitors / 1547 | — | — |
| /alerts/monitors/new | New monitor / 1554 | — | — |
| /devices/compare | Device Comparison / 1822 | — | — |
| /devices/unassigned → /devices | Devices & Assets / 696 | — | — |
| /integrations/psa | PSA Integrations / 575 | — | — |
| /integrations/webhooks | Webhooks / 396 | — | — |
| /partner | Partner Portal / 1077 | — | — |
| /policies | Policies / 475 | — | — |
| /policies/compliance | Compliance Dashboard / 613 | — | — |
| /policies/new | Create Policy / 1116 | — | — |
| /remote/files | Start File Transfer / 269 | — | — |
| /remote/quick-support | Quick Support / 309 | — | — |
| /remote/sessions | Session History / 538 | — | — |
| /remote/terminal | Start Terminal Session / 266 | — | — |
| /reports/builder | Report Builder / 2348 | — | — |
| /reports/new | Create Report / 2585 | — | — |
| /reports/templates | Report Templates / 5513 | — | — |
| /security/admin-audit | (no h1) / 563 | — | — |
| /security/antivirus | (no h1) / 574 | — | — |
| /security/edr | Endpoint Detection & Response / 548 | — | — |
| /security/encryption | (no h1) / 636 | — | — |
| /security/firewall | (no h1) / 472 | — | — |
| /security/password-policy | (no h1) / 703 | — | — |
| /security/recommendations | (no h1) / 547 | — | — |
| /security/score | (no h1) / 635 | — | — |
| /security/trends | (no h1) / 441 | — | — |
| /security/vulnerabilities | (no h1) / 517 | — | — |
| /configuration-policies/defaults | (no h1) / 3076 | — | — |
| /admin/trust-queue | Partner trust queue / 291 | — | — |
| /admin/sending-domains | Partner sending domains / 213 | — | — |
| /account/connected-apps | (no h1) / 404 | — | — |
| /account/devices | (no h1) / 368 | — | — |
| /agreements/signed | (no h1) / 585 | — | — |
| /ai-for-office | AI for Office / 455 | GET /api/v1/client-ai/admin/orgs 404 {"error":"Breeze AI for Office is not enabled"} | 1 |
| /jobs/new | Create Automation / 1281 | — | — |
| /tickets/new | Create ticket / 381 | — | — |
| /setup → / | Good afternoon, Breeze / 1029 | — | — |
| /settings/system/deprecations → /admin/system | System / 3930 | — | — |
| /alerts/channels → /alerts/delivery | Delivery / 1529 | — | — |
| /settings/webhooks → /integrations#webhooks | Integrations / 599 | — | — |
| /snmp → /monitoring | Network / 591 | — | — |
| /remote/tools → /remote | Remote Access / 377 | — | — |

Crawl notes:
- 134 routes visited, 0 error boundaries, 0 Vite overlays, 0 blank mains.
- `/alerts/correlations` got 401 (alerts/correlations + auth/refresh) in pass 2 only. It was the first page after a fresh login in that run, and a re-run is clean (200, 0 errors). Login-timing artefact, not a defect.
- `/ai-for-office`: GET /client-ai/admin/orgs 404 `{"error":"Breeze AI for Office is not enabled"}`. The page handles it: "Breeze AI for Office is not enabled on this instance. Set CLIENT_AI_ENTRA_CLIENT_ID…". Expected noise (feature unconfigured), but it logs a console 404 every time the page is visited.
- `/devices` "ERRTXT 500" is the "500" page-size option, a false positive.
- No h1 on: /workspace, /agreements/templates, /security/scans, /cis-hardening, /backup, every /security/* sub-page (admin-audit, antivirus, encryption, firewall, password-policy, recommendations, score, trends, vulnerabilities), /configuration-policies/defaults, /account/connected-apps, /account/devices, /agreements/signed. All render content (a11y paper cut: no page heading).
- Settings catalog card "Alert templates" → /settings/alert-templates 301 → /alerts/monitors (h1 "Monitors"). The card links to a legacy URL and the label doesn't match the destination.
- `/settings/system/deprecations` redirects to `/admin/system?tab=deprecations`, which uses a query param for tab state (repo convention is the hash).
- Not in the nav, but reachable from in-page links/tabs (source refs > 0): /alerts/correlations, /alerts/delivery, /alerts/monitors(/new), /devices/compare, /integrations/psa, /partner, /policies(/compliance,/new), /remote/files|quick-support|sessions|terminal, /reports/builder|new|templates, /security/* sub-pages, /configuration-policies/defaults, /account/*, /agreements/signed, /ai-for-office, /jobs/new, /tickets/new.
- Not reachable from any nav or in-app link (0 references in apps/web/src): `/admin/trust-queue` and `/admin/sending-domains` (deliberately unlisted per the SendingDomainsAdmin.tsx comment, "reached by URL"; but the memory notes trust-queue review requests have been missed, so consider a sidebar entry under Admin), `/integrations/webhooks` (renders "Webhooks"; Integrations links to `#webhooks` instead), `/account/test-approval`, `/quick` (public quick-support landing, by design).
- `/devices/unassigned` → client redirect to /devices. `/setup` → / (setup already complete).

</details>


## UI/UX paper cuts

| # | Where | Observation | Severity | Disposition |
|---|---|---|---|---|
| A1 | `/ai-for-office#templates` | Partner-wide templates never listed: web sends `?orgId=<header org>`, `clientAi/adminTemplates.ts:96` keeps only that org's rows (create returns 201 + toast, list unchanged) | med | fix pending |
| A2 | `/settings/billing` defaults | Out-of-range tax (150, -5) and terms (400, 2.5) submit; server 400 shown as raw "defaultTaxRate: Too big: expected number to be <=1" + "Check the highlighted fields" with nothing highlighted; tax entered as percent but message says <=1 | med | fix pending |
| A3 | ticket assign | Assigning a `new` ticket moves it to open without `ticket.status_changed` (`ticketService.ts:1953`) | med | issue pending |
| A4 | `/settings/partner-service-principals` | No owner shown; Issue key / Rotate / Edit offered to non-owners who always get 403; non-owner Issue-key refusal toasted twice | med | issue pending |
| A5 | misc | org Billing save double success toast; step-up wrong code says only "Invalid credentials"; deferred charge toast "Stripe unavailable" with no next step; assignee list includes never-activated invitees and billing-only users; rotate dialog title "API Key Created"; Templates tab "Failed to load templates" when AI for Office is off; channel form doesn't validate the webhook URL client-side | low | noted |
| B1 | `/audit` → Export Logs | Export failure is silent (500 → no toast; `handleExportLogs` swallows non-OK + `catch {}`); export ignores active filters (request carries only orgId) | med | fix pending |
| B2 | Cmd+K | Settings index is 3 hard-coded entries (`routes/search.ts:18-22`) though the placeholder promises settings | med | issue pending |
| B3 | Device Settings → tags | PATCH 200, modal closes, no toast; tags not shown on Overview (`DeviceSettingsModal.tsx`, on runActionAllowlist) | low | fix pending |
| B4 | nav | `/admin/trust-queue`, `/admin/sending-domains`, `/integrations/webhooks` reachable only by URL; "Alert templates" card points at a legacy redirect | low | noted |
| B5 | `/security/*`, `/backup` + ~13 more | no `<h1>` | low | noted |
| B6 | misc | patch-scan toast silent about offline devices; no patch-source filter; alert "Resolve" opens a drawer (+2 clicks); offline reason only in a tooltip; device search doesn't match tags; saved-view delete has no confirm; Cmd+K Recent shows a renamed script's old name; audit pager total missing on page 1; deprecations page uses a query-param tab | low | noted |

## Fixes applied

| Commit | Area | What | Test |
|---|---|---|---|

## Issues filed

| Issue | Title | From row |
|---|---|---|

## Summary
