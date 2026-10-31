# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.125.0** (2026-10-27).

---

## Release to-do (pre-cut gates — see `/release` Step 0.2)

## Self-Hosting / Upgrade Notes (fold into the release body)

- **On-device notices are opt-in (#10190 W04).** `PROMPT_HOST_ENABLED_KINDS` is optional. Unset (or `default`) means the code default, which enables nothing in this release. Set it to `notice.info` on the `api` service to opt in. Enable it only after this release's Breeze Assist build is published. No migration.
- **Restart prompts are opt-in too (#10190 W05).** Add `restart.prompt,restart.final` to `PROMPT_HOST_ENABLED_KINDS` (for example `notice.info,restart.prompt,restart.final`) only after the W05 Breeze Assist build is published. Unset still enables nothing. No migration.
- **DNS Security stores blocked and redirected queries only, by default (#10054).** DNS sync no longer stores allowed queries (about 99% of rows; around 1M a day on a busy tenant) unless the integration opts in with `config.storeAllowedTraffic: true` (**DNS Security → Integrations → Stored data → Store allowed traffic**). This applies to every existing integration on upgrade. Cisco Umbrella integrations also stop downloading allowed records, which saves request budget. The Overview tab and `GET /dns-security/stats` now say **Not stored** (`allowedTraffic: "none"`, `allowedQueries: null`, `blockedRate: null`) instead of showing zero allowed queries. Allowed rows stored before the upgrade are **not** deleted; retention removes them as they age out, and the docs (DNS Security → Stored traffic) show how to delete them by hand in batches. No migration, no new environment variable.

## Features / API

## Migrations

### Flows W05 (#5215 / #5220, PR D — web, limits and egress audit)

Behind `FLOWS_ENABLED` (default off). No new environment variables.

- **Webhook tab on a webhook flow.** Shows the URL, the authentication mode and how to sign a request, the secret's fingerprint and the reason of the last refused request. **Create secret** / **Rotate secret** (rotation asks first: the old secret stops working at once) shows the new secret once. When enabling a new version clears the secret, the page says so. The tab lists recent deliveries with their status, organization, run link and attempts; users limited to some sites or devices are told the delivery id and organization value are hidden.
- **Run limits are visible and configurable.** The flow page shows this month's runs against the flow and owner caps, and a banner when runs are being refused (the flow stays enabled); the flow list badges such flows. New page **Settings → Flow limits** (`/settings/flow-limits`) sets the partner default (needs `automations.write`, MFA and full partner organization access) and an organization override that can only lower it. New routes `GET /api/v1/flows/limits[?orgId=]` and `PUT /api/v1/flows/limits` (`{ orgId?, limits: { monthlyRunsPerOwner?, monthlyRunsPerFlow?, aiTokensPerRun? } }`, `null` clears a value); a raise above the partner value is refused with `422 limit_above_partner_ceiling`. The organization and partner settings editors no longer change `settings.flows`.
- **Steps and runs:** the step list describes `notify`, `http_request` and `ai` steps; the run timeline groups for-each items that ran in parallel and shows an `ai` step's tokens and cost, an `http_request` step's HTTP status, and the agent run that started a flow. The AI agent tool picker lists enabled manual flows as `flow__<slug>` tools.
- **`ai` step calls are now in the LLM egress audit** (surface `flow_ai_step`) when the organization's model runs on a partner catalog endpoint.
- `GET /api/v1/flows` rows now carry `lastAdmissionRefusal`; `GET /api/v1/flows/:id/webhook-deliveries` adds `identifiersHidden`.
- **Migration** `2027-01-08-140000-flow-ai-step-egress-surface.sql`: re-issues the `llm_egress_events_surface_chk` CHECK with `flow_ai_step` added; DDL only, no backfill. Re-adding the CHECK scans `llm_egress_events` once to validate existing rows (no rewrite).

### On-device dialogs (#10190)

- **One MSP identity for device prompts.** The server now resolves, in one place, the name, colour and logo a device's prompts are drawn under: the partner name (sanitized; an organization can never change it), with the colour and logo from Settings → Partner → Branding and the organization's portal branding winning where one is set. Agents that report `securityCapabilities.promptIdentityProtocolVersion: 1` receive it as a new heartbeat block, `promptIdentity` (no shipped agent reports it yet), and download the logo from the new agent-authenticated `GET /api/v1/agents/:id/prompt-identity/logo?sha256=<hex>`. Only PNG, JPEG or WebP logos of at most 256 KB and 1024 px per side are used; SVG and anything else mean no logo. An `https://` logo is fetched once by the server through the SSRF guard and cached; the device never fetches a URL. Endpoint-message sender cards use the same resolver: unchanged for partners without an organization portal colour, and an organization's portal colour now sets the accent.
- **The caller-verification card now shows the Partner → Branding logo** (or the organization's portal branding logo where one is set) instead of the partner's login-page logo. An `https://` logo is shown as before; an uploaded logo is shown once the agent has synced it to Breeze Assist and `/api/v1/helper/config` names the same logo (`branding.logo`, W04 below). No migration, no new environment variables.
- **Notice cards and one notification list (W04).** With `notice.info` enabled, Breeze Assist draws notices as small cards that never take focus and stay in its Notifications list until they expire. Endpoint message cards look as before and now appear in the same list; the tray's "Notifications (n)" counts both.
- **Safe-mode, macOS permission and remote-session-ended notices** move onto the prompt contract when `notice.info` is enabled and the device's Assist supports it; otherwise they use today's toasts and dialogs.
- **The caller-verification card now shows uploaded logos.** When the logo named in `/api/v1/helper/config` (`branding.logo`) is the one the agent synced to Breeze Assist, the card draws those bytes. Otherwise it shows the `https://` logo as before, or none.
- **Endpoint messages fall back to the generic sender identity** when the partner name sanitizes to empty, instead of failing the send.
- **Restart prompt on the prompt host (W05, #10181).** With `restart.prompt` and `restart.final` enabled, a scheduled restart is one card per restart in every signed-in session, drawn by Breeze Assist or, as a fallback, by the native helper (`TaskDialogIndirect` on Windows). The card names the MSP, the restart time and the postponements left; its buttons are **Postpone until <time>** (the default, shown only while a postponement remains and moves the restart by at least 5 minutes) or **OK**, and **Restart now**. Reminders update the same card; a postponement updates it where it is; two sessions stay in step (the first answer wins). A locked session gets the card at unlock with the same restart time. The last minute still belongs to the OS countdown, now announced by a closing card. An operator cancel turns the card into "Restart cancelled", and "Your computer restarted at <time>" is left in the list for the next sign-in. The restart policy, rungs, deadline and budget are unchanged.
- **Legacy restart box defaults to Postpone (W05, P8).** On Windows, the restart Yes/No box (used when the restart kinds are not enabled) now makes **No — the postponement — the default button**, so Enter no longer restarts the machine. A box left unanswered still means no decision.
- **Restart decisions are audited (W05).** Agents report the person's last decision in `rebootStatus.lastUserAction`; the server writes `device.reboot.user_postponed` or `device.reboot.user_restart_now` once per decision, with the renderer (`assist`, `native` or `headless`). The patch policy editor previews the restart card.
- **Remote consent card and a clickable session pill (W06).** With `remote.consent` enabled, Breeze Assist asks for remote-session consent on the branded prompt card: the technician the server allows it to show, Allow / Deny with Deny focused and on Esc, and a countdown that states what happens if no one answers. With `remote.session` enabled, the "remote session in progress" indicator becomes a pill the user can click to see who is connected and since when, to end the session (after a confirmation; remote access policy `allow_user_end_session`, default on; technicians see "Ended by the user") and to report a problem, which opens Assist's Request Support chat with the session id filled in. Both kinds are opt-in through `PROMPT_HOST_ENABLED_KINDS`; without them, consent and the banner work exactly as today. Needs Breeze Assist 0.1.3.
- **Elevation request cards (W07, #10178, #10180).** With `elevation.request` enabled, a standard user who sends an elevation request to IT sees a stateful Breeze Assist card instead of toasts: **Waiting for your IT support team** with the time IT has to answer (the server's pending expiry), **Cancel request** (withdraws it on the server as `user_cancelled`) and **Hide**; then **approved** (naming the technician only when the remote access policy's technician identity level allows it), **denied** (with the technician's reason), **expired**, **failed** or **cancelled**. When UAC is not on the secure desktop, the first question ("Send request" / "Cancel", Cancel is the default) is asked on Assist too; on the secure desktop the SYSTEM helper still asks natively. Opt-in through `PROMPT_HOST_ENABLED_KINDS`; without it, elevation works exactly as today. Needs Breeze Assist 0.1.4, and the API migration `2027-01-15-100000-pam-withdrawn-reason-user-cancelled.sql` deployed before the agent.

### Flows — Jobs conversion (#5215 W06)

**PR A — conversion foundations.** Behind `FLOWS_ENABLED` (still default off in this PR; PR C turns it on). No new environment variables. Nothing converts a Job yet: the conversion routes, the switch and the Jobs page arrive in PRs B and C.

- **Three new flow built-ins** (flow steps, not AI tools): `resolve_targets` (Tier 1, `devices.read`) resolves a device target, a legacy condition list or an earlier step's device set in the run's organization; `create_alert` (Tier 2, `alerts.write`) raises an alert on one device with the same writer legacy Jobs use; `run_script_on_targets` (Tier 3, the `run_script` permission) runs one library script on a device set with the legacy Job guarantees — queued for offline devices with the standard delivery window (a queued dispatch counts as success), a per-device lock, cancellation between devices, and a durable per-device record so a retried release never runs a device twice. A step refuses more than 500 devices (`targets_over_cap`) and never truncates. A script that runs elevated cannot be used.
- **Fleet pre-approval.** When enabling a flow, a user can pre-approve a `run_script_on_targets` step with a device cap (`fleetMaxTargets`, 1–500) so schedule, event and UI runs dispatch without asking. The approval binds the script content, parameters, run context, offline policy, target definition and every dynamic group's definition; any change, or more devices than the cap, stops the run with `binding_drift` before anything is dispatched. Webhook and tool runs always ask. When a step waits for approval, the approval names the exact devices, and only those run when it is approved.
- **`notify` reaches webhook and PagerDuty channels.** A PagerDuty notice from a step uses dedup key `flow:<runId>:<stepId>:<item>`.
- **Conversion census** for operators: `cd apps/api && npx tsx scripts/automationConversionCensus.ts` prints, as JSON, how this installation's Jobs would convert (counts only — no ids or names).
- **Migration** `2027-01-09-100000-flow-automation-conversions.sql`: adds `flow_automation_conversions` and `automation_occurrence_claims` (both with row-level security), the column `automations.converted_to_flow_id`, and re-issues the `flow_runs` / `flow_run_steps` error-code CHECKs with `targets_over_cap`, `targets_unresolvable`, `alert_create_failed` and `script_dispatch_failed`. DDL only; no backfill.

**PR B — conversion service, switch, revert and cutover.** Still behind `FLOWS_ENABLED`; no new migration and no new environment variables. The Jobs page UI arrives in PR C.

- **Conversion API** (interactive sessions with MFA; API keys get `interactive_session_required`): `GET /api/v1/flows/conversions/preview/:automationId`, `POST /api/v1/flows/conversions` (one Job → a draft flow plus a shadow ledger row), `POST /api/v1/flows/conversions/bulk`, `GET /api/v1/flows/conversions[?state=]`, `GET /api/v1/flows/conversions/:id`, `POST …/:id/switch` and `POST …/:id/revert`. Partner-wide Jobs need the partner-wide policy permission. `GET /automations/:id` and the `manage_automations` AI tool report the conversion.
- **Shadow.** While a conversion is in shadow the Job keeps running; each legacy trigger also records whether the draft would have matched. Editing the Job or the draft resets the counters. A switch needs at least 10 minutes of shadow and either clean counters or an explicit acknowledgement.
- **Switch** runs in one transaction as the user: it creates the generated scripts for `execute_command` actions (named `Moved from Job "<name>" — command <n>`), carries a webhook Job's secret over, enables the flow with every normal enable check (including fleet pre-approvals), disables the Job and marks it converted. The flow takes over 60 seconds later (`switch_at`). A disabled Job cannot be switched (`409 automation_disabled`).
- **Exactly once across the cutover.** Each trigger occurrence (schedule slot in UTC, event id, webhook signature or delivery id) is claimed atomically with admission on both engines, so an occurrence is run by the Job or by the flow, never both and never neither. A converted schedule fires twice in a DST repeated hour, as the Job did.
- **The Job's webhook URL keeps working.** After the switch, deliveries to `/api/v1/automations/webhooks/:id` are forwarded to the flow: same HMAC secret, `x-breeze-event-id` / `x-breeze-nonce` become the delivery id (a retried delivery is a duplicate), a body that is not a JSON object is `415`, and the legacy plain-secret header gets `401`.
- **Converted Jobs are frozen.** Editing, deleting, enabling, triggering or running a switched Job returns `409 automation_converted { flowId }` (the AI tool refuses the same way).
- **Revert** re-enables the Job immediately and stops the flow admitting anything new; flow runs already started, including ones waiting for approval, finish. A reverted flow is disabled once it has drained.
- **`resolve_targets` also takes `deviceIds`**, so an event Job whose first action is a notice or an alert converts (it bound the triggering device and was refused before).
- **Known differences from the Job** (verified by the parity suite): a notice's severity `high` or `medium` becomes `warning` (`low` becomes `info`), and an on-failure notice says "Automation <name> action <n> failed on <host>" instead of the action's failure reason.

**PR C — Jobs move to Flows (R1).** No migration.

- **`FLOWS_ENABLED` now defaults to `true`.** Unset or empty turns Flows on; the compose files pass `${FLOWS_ENABLED:-true}` and both `.env.example` files ship `FLOWS_ENABLED=true`. **To keep Flows off, set `FLOWS_ENABLED=false`**: every flow route then answers 404, Jobs stay fully writable (including creating new ones), and "Move to Flows" does not appear.
- **New Jobs are made in Flows.** With Flows on, `POST /api/v1/automations` answers `410 { "error": "automations_moved_to_flows", "flowsUrl": "/flows" }` and the Jobs page's "New job" opens Flows. Existing Jobs keep running and stay editable until they are switched. Managed rows (AI triage seeding, monitor compile, policy workflows) are unaffected.
- **Jobs page.** A "Move to Flows" column with the fidelity of each Job in shadow (**Exact**, **Needs review**, or **Can't move yet** with the blocker in words), a per-Job panel at `#convert-<jobId>` with the findings, the flow's steps and the shadow counters, a banner with "Start shadow for all convertible" for the selected organization (shadow only — nothing is ever switched automatically), and Revert. A switched Job is read-only and links to its flow; the flow's page shows "Moved from Job <name>".
- **The switch dialog asks for every authority the flow gains**: each script step's pre-approval is off by default and needs a device cap (1–500, per run and per organization — an all-orgs flow multiplies it by the organization count); a Job limited to its creator's sites needs an explicit "wider scope" acceptance; the user accepts that the flow runs as them and pauses if their account is turned off or narrowed (the Job did not); generated scripts are shown with their body. Switch is never offered before the shadow is 10 minutes old.
- **Event-triggered Jobs convert only with durable event dispatch.** Set both lines, or event Jobs show "Can't move yet" (`event_dispatch_not_durable`):
  ```
  EVENT_DISPATCH_MODE=enforce
  EVENT_DISPATCH_QUEUE_SUBSCRIBERS=webhook-delivery,notification-dispatcher,flow-event-trigger
  ```
  (keep any other subscribers you already list; `flow-event-trigger` must be among them).
- **Webhook senders keep the Job's URL** (it forwards to the flow; see PR B). The flow accepts JSON-object bodies only, and senders that send the plain secret header must move to `X-Breeze-Webhook-Token` (they get `401` after the switch while `AUTOMATION_WEBHOOK_ALLOW_LEGACY_SECRET` is on).
- **What can't move yet** (the Job keeps running unchanged): managed or policy-workflow Jobs, Jobs used for compliance remediation, `deploy_software` actions, service restarts, elevated scripts, event filters on null, lists or objects, cron expressions the flow scheduler reads differently, unknown target conditions, more than 400 current targets, all-orgs Jobs that target groups or use a webhook, a command with no shell on a mixed-OS target set, more than 20 notices per run, unsupported notification channels, a monthly run estimate above the flow limit, references the owner does not own, and text containing `{{`.
- Later releases (tracked in #10336, not this one) make Jobs read-only and then stop running unswitched Jobs per installation.

### PAM (#8971)

A UAC elevation the end user declines on the device (Deny, the PAM dialog times out, or it fails) can no longer be approved and launched afterwards. Three PRs, merged A → B → C.

- **Server (PR A).** New elevation status `withdrawn` with `withdrawn_at` / `withdrawn_reason` (`user_denied`, `user_timeout`, `dialog_error`). New agent route `POST /api/v1/agents/:id/elevation-requests/:requestId/withdraw` moves the calling device's own pending UAC request to `withdrawn` under a row lock, writes an `elevation_audit` `withdrawn` row (actor `end_user`) and the audit-log action `pam.elevation_request.withdrawn`, expires the request's phone approvals and publishes `elevation.withdrawn`. Exactly one of approve / deny / withdraw / TTL expiry wins. A technician who approves a withdrawn request gets a 409 whose body now carries `currentStatus` (also on a lost race, re-read rather than the stale `pending`). `GET /pam/elevation-requests?status=withdrawn` and the AI tool `get_elevation_history` accept the new status.
- **Agent (PR B).** The agent records the user's answer in a durable local file, `pam-declined-requests.json`, next to `pam-lifetime-ledger.json`, before it dismisses consent.exe. `pam_apply_v2` and the legacy `actuate_elevation` refuse a declined request with failure code `user_declined` (`pam_actuations.failure_code`), wait up to 100 s when an approval lands while the dialog is still open (`user_decision_pending` if no answer), and refuse every remote apply for 24 h after the file is found corrupt (`user_decline_record_untrusted`; the file is moved to `.corrupt` and an Error is logged). The agent retries the withdraw until the server answers, across restarts and offline periods. Against a server without the route (404) the local refusal still holds.
- **Web (PR C).** "Withdrawn" badge and filter, the reason under it, "Declined on the device" on an approved or auto-approved request the agent refused, and a respond-dialog message when the user withdrew the request (submit stays disabled; closing refreshes the list). Distinct lines for "No answer on the device" (`user_decision_pending`) and "Refused: device decision record unavailable" (`user_decline_record_untrusted`). The PAM audit CSV export gains two trailing columns, `withdrawnAt` and `withdrawnReason`; existing column positions are unchanged.
- **Residual risk for old agents (accepted).** Agents without PR B never call the route, so for them the 15–20 minute pending-TTL window from #8971 stays open until the device runs an agent with PR B. No server-side mitigation is sound: the server cannot tell "the user is still deciding" from "the user declined" unless the agent says so. Shortening `PAM_PENDING_REQUEST_TTL_MINUTES` narrows the window and is an operator option, not a code change. PR B ships to endpoints only with a release and fleet promote, gated on the Windows lab run.
- **Migrations** `2027-01-10-100000-pam-elevation-withdrawn-enum.sql` (adds `withdrawn` to `elevation_status` and `elevation_audit_event_type`; unused in that file) and `2027-01-10-100100-pam-elevation-withdrawn-columns.sql` (two nullable columns, the named CHECK `elevation_requests_withdrawn_reason_chk`, and `elevation_requests_status_timestamps_chk` re-created with a `withdrawn` clause). DDL only, no backfill. Re-adding both CHECKs scans `elevation_requests` once to validate existing rows (no rewrite).

### PAM (#8928)

- **End users now hear back on elevation requests they hand to IT (Windows).** When a standard user sends a UAC elevation request to IT from the Breeze dialog, the agent tells them how it ended: **Request approved** (and the program starts), **approved but couldn't start**, **Request denied** (with the technician's reason, first 500 characters), or **Request expired**. If the request can't reach the server, the user is told so (at most once per program per 5 minutes) and that the Windows prompt still accepts admin credentials. Notices name the MSP from Settings → Partner → Branding, or say "IT". Requests from before an agent restart, auto-approvals and policy denials show nothing. Needs this release's Windows agent.
- **Deny reasons are shown to the end user.** The deny field in the PAM respond dialog, on PAM cards in the approvals inbox and on the mobile app's PAM deny sheet now says so. The stored `denial_reason` is unchanged; the copy sent to the device has control characters removed and is capped at 500 characters. The mobile deny sheet now also caps input at 500 characters (the server limit); this ships with the next mobile release.
- **New command type `pam_request_notify`** (partner-trust gated, like `notify_user`). Queued on a deny or a stale-pending expiry, only for devices reporting `securityCapabilities.pamUserNotifyProtocolVersion: 1`; it is never dispatched to other agents and expires unclaimed after 60 minutes. The deny reason is erased from the command payload once the command finishes. The elevation-ingest `201` response gains an optional `supportName`.
- **Migration** `2027-01-10-110000-pam-user-notify-capability.sql`: adds `devices.pam_user_notify_protocol_version integer NOT NULL DEFAULT 0`. DDL only, no backfill. No new environment variables, no new setting.

### Device groups

- **Dynamic groups keyed on installed software now follow inventory changes (#10497).** When an accepted software inventory report adds or removes a name, the device is re-evaluated against its organization's software-keyed dynamic groups; before, a software change alone never updated membership. A device moved to another organization, by the move action or by assigning a parked device, is now evaluated against the destination organization's dynamic groups. Membership that went stale before this release is not recomputed automatically: to refresh a group now, edit it and save its filter (software-keyed groups, and groups in organizations that received a moved device). No migration, no new environment variables.
### Agent

- **Windows agent now collects Warning and Information Application events from `APCPBEAgent` (APC PowerChute Business Edition, #10493).** `event_log` monitors on PowerChute UPS events (EventID 2000, Warning, e.g. "UPS On Battery") can now fire. The built-in Warning/Information provider list is now `MsiInstaller`, `APCPBEAgent`; every other provider is still collected at Error/Critical only. Needs this release's Windows agent. No migration, no new environment variables, no new setting.

### Webhooks

- **Alert webhook payload v2.** Each webhook has a `payloadVersion`: existing webhooks stay on v1 byte for byte, and new webhooks default to v2, including webhooks created through the API without `payloadVersion`. V2 alert data adds status, hostname, site, organization name, an alert link, and more. Manual retries carry `X-Breeze-Replay-Of`. New `alert.escalated` subscriptions are rejected; `alert.acknowledged` and `alert.suppressed` are now offered in the form (`alert.suppressed` is sent only when Breeze AI suppresses an alert). Migration `2027-01-12-100000-webhook-payload-version.sql` adds three columns on `webhook_deliveries` and one on `webhooks`, with version CHECKs on both tables. The delivery CHECK is `NOT VALID`, enforces new or updated rows, and requires no table scan. DDL only, no backfill, and no new environment variables.
### UniFi

- **UniFi site mapping lists every site (#10491, #10492).** The cloud (Site Manager) mapping card now reads every page of hosts and sites instead of the first page only, lists sites on self-hosted UniFi Network Application servers (`network-server` hosts) that were previously hidden, and shows sites whose host is missing from Site Manager under "Unknown console". `GET /unifi/hosts` gains the additive fields `type`, `unknownConsole` and `omitted`. Each sync now reads `/v1/devices` and the ISP metrics once per run rather than once per mapping.
- **UniFi cloud sync no longer files one customer's devices under another (#10492).** Site Manager's `/v1/devices` does not say which site a device is on, so devices now sync only for a mapping whose host runs that one site. On a multi-site host (typically a self-hosted Network Application serving several customers), mapped sites get WAN health but not devices, and the run is `partial` with the reason. Before, every mapping on such a host received all of the host's devices, and the last mapping processed owned them. Device rows already written that way are left as they are (not moved, not swept). A failed account-wide `/v1/sites` or `/v1/devices` read now fails the run (status `failed`, connection marked `error`, or `reauth_required` on a 401) instead of reporting `partial`; an ISP-metrics read failure no longer blocks device sync. No migration, no new environment variables.

### Partner API alert write-back

- **New opt-in scope `alerts:write` (#10532, part of #10528).** A partner service principal granted `alerts:write` can call `POST /api/v1/partner-api/alerts/<alertId>/acknowledge` and `POST /api/v1/partner-api/alerts/<alertId>/resolve` (`{ "note"?: string }`, at most 2000 characters) on alerts in any organization it can reach. The scope is never part of a default scope set or a preset, and whoever grants it must hold `alerts.write`. It does not grant reading alert content (`alerts:read`). Repeating an acknowledge or a resolve answers `200` with `changed: false` and publishes no second event; an alert outside the principal's organizations answers `404`; an alert whose status does not allow the action answers `409` with `details.status`. Each real transition writes an `alert.acknowledge` / `alert.resolve` audit row attributed to the principal.
- **Principal attribution.** Alerts gain `acknowledged_by_principal_id` and `resolved_by_principal_id`. A principal resolve records `resolution_reason = manual` and counts as a person's resolve: it starts no automatic AI verdict run, the fix-outcome watcher treats it as a human resolve, and AI org summaries do not count it as auto-resolved. v2 alert webhooks now fill `acknowledgedByPrincipalId` and `resolvedByPrincipalId`; v1 `alert.acknowledged` / `alert.resolved` data carries the key only when a principal acted, so existing v1 payloads are unchanged.
- **Migrations** `2027-01-12-400000-partner-api-alerts-write-scope.sql` (adds `alerts:write` to the scope CHECK function) and `2027-01-12-400100-alerts-principal-attribution.sql` (`-- @no-transaction`: two nullable columns, FKs to `partner_service_principals` `ON DELETE SET NULL` added `NOT VALID` then validated, two partial indexes built `CONCURRENTLY`). DDL only, no backfill. Validating the FKs scans `alerts` once under a lock that does not block writes. No new environment variables, no new setting.
### Webhook retries

- **Webhook deliveries now retry for about 21 hours (#10530).** A failed attempt is retried on a fixed schedule after 1 min, 5 min, 30 min, 2 h, 6 h and 12 h (each ±20%), then marked `failed`. Retry state lives in Postgres (delivery status `scheduled` with the next attempt time), with BullMQ delayed jobs waking each attempt. A wake-up lost to a failed enqueue or to Redis data loss is re-driven by the recovery sweep once the delivery is more than 15 minutes overdue.
- **Editing or disabling a webhook stops its scheduled retries;** each is marked `failed` (`superseded_by_edit:`) when it next comes due, including retries re-driven by the recovery sweep. A delivery keeps the payload version it was recorded at, including manual replays and legacy rows.
- **The Redis dead-letter queue and per-webhook `retry_policy` are retired.** At upgrade, pending rows and old in-memory retries are re-driven. Entries whose delivery no longer exists or already finished are dropped and counted; DLQ entries become `failed` deliveries when their webhook still exists. Entries that fail to process stay in Redis and are retried by the recovery sweep.
- **Connection health follows terminal failures.** An incident opens when a delivery ends `failed` after its last attempt with no later success: for a dead endpoint, about 21 hours after the first failed attempt, rather than minutes. Decrypt failures open an incident immediately.
- **Test and manual retry requests remain accepted if queuing fails.** `POST /webhooks/:id/test` and `POST /webhooks/:id/retry/:deliveryId` return 202; the AI `test_webhook` tool also reports acceptance. The delivery stays `pending`, and the recovery sweep sends it within about 15–20 minutes. Test deliveries to failing endpoints follow the full retry schedule.
- **Migrations:** `2027-01-12-300000-webhook-delivery-scheduled-enum.sql` adds the enum value; `2027-01-12-300100-webhook-delivery-scheduled-indexes.sql` adds the scheduled partial index concurrently; `2027-01-12-300200-webhook-delivery-failed-at-generation.sql` adds nullable `failed_at` (terminal failure time) and `webhook_generation` (recorded approval generation), builds the failure-time index concurrently, and drops the old creation-time failure index. No backfill: legacy rows keep null values; legacy failed rows do not open new incidents, tracked health and retention fall back to creation time, and legacy null generations fall back to the webhook’s current generation. No new environment variables.
### Device groups (partner-owned, dark)

- Schema support only: no partner-owned group can be created yet; the create route lands in a later wave.
- `2027-01-12-200000-device-groups-partner-ownership.sql`: DDL for partner ownership, revision fields, ownership checks and RLS; `device_groups.org_id` becomes nullable. No backfill or rows written.
- `2027-01-12-200100-device-group-membership-owner-integrity.sql`: replaces the membership group FK with a deferred constraint trigger, adds owner revalidation and reparent detach, and replaces the device-move function. DDL and function replacements only; no backfill or rows written.
- `2027-01-12-200200-config-assignment-partner-device-group-targets.sql`: replaces five assignment-integrity and export functions to support partner group targets. DDL and function replacements only; no backfill or rows written.
- Execution targets now refuse a group id they cannot resolve. No new environment variable or setting.

### Partner webhooks

- Full partner administrators can create **All organizations** webhooks for events from every live organization they manage. Payload v2 includes organization external IDs; organization users cannot view partner webhooks.
- `2027-01-13-100000-webhooks-partner-ownership.sql` adds partner ownership, owner-based RLS, and the delivery event-organization guard.
- `2027-01-13-100100-webhook-deliveries-org-id-backfill.sql` fills delivery `org_id` in 10k-row batches and validates the organization/test-send invariant. `2027-01-13-100200-webhook-deliveries-org-id-index.sql` builds the organization index concurrently for erasure, merge, and export.
- No new environment variables.
### Device groups (partner-owned, dark) — W2a

- Still dark: no partner-owned group can be created yet. No migration, environment variable or setting.
- Config-policy and automation-schedule expansion of a `device_group` assignment now resolves a partner-owned group to its members in every org of the partner.
- Every other target surface (maintenance windows, backup SLAs, script runs, software deployments, automations, endpoint messages, AI agent triggers, peripheral policies, the enrollment default group, user device-group scope) answers a partner-owned group id with `400 PARTNER_GROUP_TARGET_UNSUPPORTED`. The groups API and the AI `manage_groups` tool treat partner-owned groups as read-only (`400 PARTNER_GROUP_READ_ONLY`).

### Partner API external ticket refs

- **Three alert reference routes (#10533, part of #10528).** `PUT` and `DELETE /api/v1/partner-api/alerts/<id>/external-ticket` require `alerts:write` and manage only the caller's principal-namespaced reference. PUT accepts an HTTPS URL and uses full replacement; identical PUTs and repeated DELETEs are idempotent. `GET /api/v1/partner-api/alerts/<id>/external-tickets` requires `alerts:read` and lists every principal's references plus eligible PSA mappings.
- **Create a ticket from an alert.** Partner API ticket creation accepts `alertId` and atomically writes a `created_from` link. Unknown or inaccessible alerts return 404; a different accessible org returns 422; reusing an idempotency key with a different alert id returns 409.
- **Organization exports include `externalLinks`.** Link insert, exported-field update, and deletion advance the org export watermark, including removal of the last link.
- **Alert pages show read-only External tickets chips,** using the ticket number when available and linking only HTTPS URLs. Org-scoped users see only org-owned PSA mappings; partner-principal refs and partner-owned PSA mappings are hidden.
- **V2 alert webhook `externalTickets` now includes references permitted for its owner at enrichment time.** Partner-owned webhooks receive principal refs and their partner’s or the alert org’s PSA mappings. Org-owned webhooks receive only org-owned PSA mappings, never partner-principal refs or partner-owned PSA mappings. Use the GET route for current state under the same viewer restrictions. V1 payloads are unchanged.
- **Migrations:** `2027-01-14-110000-alerts-id-org-unique.sql` builds `alerts_id_org_uq` concurrently on the hot alerts table; `2027-01-14-110100-alert-external-refs.sql` creates the tenant-isolated reference table, constraints, indexes and RLS policies; `2027-01-14-110200-org-external-links-export-watermark.sql` adds the link-change watermark triggers. DDL/trigger definitions only: the migrations write no rows. No new environment variables.

### Device groups (partner-owned, dark) — W2b

- Partner-owned dynamic groups now have per-device and revisioned per-org evaluation, excluding Quick Support and holding organizations.
- Still dark: nothing user-visible until W3 adds the create route. No migration, setting or environment variable.
- A six-hour retry sweep repairs missed evaluations; it is a retry cadence, with no freshness SLA.

### Device group software rules

Dynamic device groups can now match software versions below, at least, or equal to a chosen version, and match software vendors by name or substring. Version rules compare numeric segments and ignore suffixes such as “(x64)” or “-beta”, so 1.2 and 1.2.0 match equally. Membership updates when installed versions or vendors change, even when software names stay the same.
### Event logs

- Agent event-log uploads are now validated per row (#10494). Previously one invalid event made the API reject the whole upload with 400, and every event in that collection window was lost.
- An empty or whitespace-only event message is stored as `(no message text)`; the event's source, ID and level are kept. Rows that still fail validation (for example a message over 2000 characters or `details` over 64 KB) are dropped individually, and the other rows are stored.
- Response bodies gain `invalidDropped` and `emptyMessageCoerced` counts, and the API logs one `[EventLogs]` warning per affected upload. An upload where every row is invalid returns 200 with `count: 0`.
- No migration, environment variable or setting. Existing agents benefit without an update.

### Device groups (partner-owned) — W3 API

- Partner administrators with access to all organizations can create, edit, preview, and delete partner-owned dynamic device groups through the API.
- Organization users can read their partner's group names and All orgs ownership fields, with only their own organization's members and counts; filter rules stay hidden.
- Partner-owned configuration policies can target their partner's groups, using device-group assignment precedence.
- Unsupported group filter references return `PARTNER_GROUP_FILTER_UNSUPPORTED`; manual membership changes and pinning remain unavailable for partner groups.
- No migration, setting, or environment variable is required for this wave.

#### Review fixes

- Partner-group previews that time out before evaluating any organization now return the standard `422 filter_query_timeout` response; successful partial previews report whether a timeout or the preview budget stopped evaluation.
- Group create, edit, and add-device requests with malformed JSON now return an explicit `400 Malformed JSON in request body` error.


### Device groups (partner-owned) — UI

- Partner administrators with access to all organizations can create **All organizations** device groups from the Device Groups page and from the device list's "save as group" dialog. Partner-wide groups are dynamic only; the form hides static membership and the Organization and Device Group filter fields.
- The Device Groups page lists organization and partner-wide groups together, with an **All orgs** badge, an owner filter, the last evaluation time, a count of organizations that failed to evaluate, and a member list with an Organization column.
- Organization users see a partner-wide group's name, the **All orgs** badge and their own organization's devices; filter rules stay hidden and the group is read-only for them.
- Partner-owned configuration policies can assign partner-wide groups from the Assignments tab. A partner-wide monitor's **Deploy monitor** dialog lists partner-wide groups next to organization groups.
- The AI assistant's refusal to change a partner-wide group now says where a partner administrator can change it.
- No migration, setting, or environment variable.
### AI full control (#6754) — W14 billing tools, PR B

- **Generate a contract invoice from chat (four-eyes).** `manage_contracts` gains `preview_invoice` (what the next billing run would invoice) and `generate_invoice`, which needs a second approver and refuses to release if the invoice changed after approval. An auto-issued invoice is emailed only if its total is the approved one, and only to the approved recipients.
- **QuickBooks / Xero sync tool.** `manage_accounting_sync` reads connection status, mappings and customers; links, unlinks or re-syncs a mapping (one approver); pushes invoices into the books (four-eyes, up to 10 per call, pushed at release rather than queued).
- **Durable approvals of partner-wide actions now release.** A released action reconstructed for a partner user now carries that user's current "all organizations" access, so partner-wide gates (rate cards, partner billing settings, accounting) no longer refuse a full-partner administrator's approved action.
- AI agents are never offered these writes. No migration, setting or environment variable.

### Agent event-log collection

- **Windows event logs are no longer skipped.** The collector keeps a record-ID bookmark per query in `eventlog_bookmarks.json` in the agent data directory and advances it only past events it uploaded. A failed, timed-out or capped query, or a failed upload, is retried on the next pass instead of being dropped. Queries read oldest-first, so a backlog drains over passes; a bookmark more than 24 hours behind skips the older events and logs a warning.
- **Upgrade behaviour:** the first pass after upgrade starts 15 minutes before the agent started, so events from the restart gap of a default interval are collected; duplicates are ignored by the server. Older events are not back-filled.
- **The Security category now collects audit events.** It reads Audit Failure events (failed logons and others) plus account lockout, audit log cleared, audit policy changed, user created or deleted, and members added to security groups. These Level 0 audit events are reported as `warning`, so the `minimumLevel` setting and event-log monitors apply to them.
- **Events without message text are no longer sent empty.** The agent uses the event's insertion strings, or a placeholder naming the provider and event ID.
- No migration, environment variable or setting.

### Event-log providers in policy

Add up to 20 Application event providers in an Event Logs configuration policy to collect their Warning and Information events alongside the built-in providers.
Only the winning policy for each device applies; newly added providers start with the next collection pass, without a history back-fill.
Update agents to a release containing this change before relying on the provider list. Older agents ignore it.

### AI tools — Pax8 (#6754 W15)
- `get_pax8_status`: inspect integration health and company readiness with full partner access.
- `search_pax8_products`: find mapped products and read provisioning requirements, commitments and live vendor pricing.
- `manage_pax8_subscriptions`: inspect seat drift, request a supervised sync, or link and unlink billing contract lines.
- `manage_pax8_orders`: stage and edit drafts, preview live costs and commitments, and request a supervised dry run.
### Partner settings copy matches the inheritance badges (#10372)

The default-expiry and maximum-lifetime selects and the partner agent-pin caption no longer say organizations "configure individually" or are "pinned for all"; each now agrees with its Org can override / Partner-wide badge.
