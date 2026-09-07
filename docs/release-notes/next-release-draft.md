# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.110.0** (2026-09-05).

---

## QuickBooks payment push (#4624)

Payments recorded in Breeze against an invoice that is already in QuickBooks are
now created in QuickBooks automatically, and deleted there when the Breeze
payment is voided or fully refunded. Breeze stays the system of record for its
own payments: a payment edited in QuickBooks is flagged as diverged rather than
silently overwritten in Breeze, and a partial Stripe refund is flagged for the
bookkeeper instead of rewriting a QuickBooks receipt.

**Self-Hosting / Upgrade Notes**

- **This turns ON outbound writes to QuickBooks for every connected realm at
  deploy time.** The new `accounting_connections.push_payments` column defaults
  to `true`, so a realm that is connected and in `push_mode = auto` starts
  creating QuickBooks Payments as soon as the API restarts — no operator action
  required to switch it on, and no per-realm opt-in. Set it to `false` first
  (Integrations → QuickBooks → "Push payments to QuickBooks") on any realm whose
  books you are not ready to have Breeze write into.
- **Only payments recorded AFTER the switch became active are pushed — history
  is never back-filled.** The migration stamps every existing connection's new
  `push_payments_since` with the deploy time, and turning the switch off and
  back on re-stamps it, so a pause never later flushes a backlog. Without this,
  re-pushing an old invoice would have created a QuickBooks Payment for every
  receipt on it — including the ones a bookkeeper had already entered in
  QuickBooks by hand — as duplicate cash against the same invoice. There is no
  supported way to push a payment recorded before the horizon.
- Deleting a payment propagates regardless of BOTH `push_mode` and
  `push_payments`: once Breeze created a Payment in QuickBooks it owns its
  removal, so switching the feature off cannot strand money in the books.
- Migration `2026-10-12-100000-quickbooks-payment-push.sql` adds two columns on
  `accounting_connections` (`push_payments`, `push_payments_since`) and seven on
  `accounting_entity_mappings` (`breeze_origin`, `pending_op`, `pending_since`,
  `claimed_at`, `sync_attempts`, `record_failed_count`, `push_generation`,
  `terminal_reason`), three CHECK constraints and one partial index. It backfills
  `breeze_origin = true` for existing invoice mappings, stamps
  `push_payments_since = now()` on every existing connection, and types
  `terminal_reason` from the legacy message texts — all under
  `set_config('breeze.scope','system', true)`, each logging its row count as a
  `WARNING`. No new tables, no RLS changes.
- New per-connection setting `push_payments` (default **on**) beside the
  existing `pull_payments` toggle on the QuickBooks integration card, and an
  "In QuickBooks" / "QuickBooks sync failed" / "Syncing…" badge on each payment
  row of an invoice.
- **No new worker and no new queue.** Two job types (`push-payment`,
  `delete-payment`) ride the existing `accounting-sync` queue, so the worker
  count is unchanged. The mapping row itself is the outbox: `pending_op` is
  written in the SAME transaction as the payment insert/delete, and the existing
  15-minute `accounting-reconcile` sweep gained a second pass that re-enqueues
  any mapping still owing QuickBooks work. A Redis outage therefore delays a
  push by at most one sweep — it never loses one.
- A payment push that keeps failing now GIVES UP after 100 attempts instead of
  retrying forever: the mapping reads `QuickBooks payment push gave up after 100
  attempts: <reason>. Fix the cause and push the invoice again.`, and the
  invoice's "Push to QuickBooks" button clears the counter and tries again. An
  attempt is one job try, not one sweep — the queue retries a failure five times
  per enqueue and the reconcile sweep re-enqueues every 15 minutes — so the
  practical horizon is about 20 sweeps, roughly five hours. A pending DELETE is
  never capped: once Breeze created a Payment in QuickBooks it owns the removal.
- Re-pushing a payment after somebody **deleted the QuickBooks Payment by hand**
  now actually creates a new one. QuickBooks replays a create's original
  response for a repeated `requestid` for 24 hours, so the retry key can no
  longer be the payment id alone: each time the invoice fan-out re-owns a
  mapping for a fresh create it bumps `push_generation` and the key becomes
  `<payment id>:g<n>`. It still never changes across retries of the same push,
  so a lost response cannot double-book the customer. Previously the re-push
  reported success and re-linked the mapping to the deleted Payment, leaving the
  invoice balance wrong in QuickBooks with no error shown.
- **Voiding a PAID invoice no longer fails against QuickBooks.** QuickBooks
  bumps an invoice's revision every time a payment is applied to it, so the
  void was sent with a stale token and failed with `QuickBooks rejected the
  invoice sync (HTTP 400)` five times before leaving the mapping in error —
  even though QuickBooks does allow voiding an invoice that has a payment
  applied. The void now re-reads the live revision and retries once (the same
  handling the invoice push already had), reads the revision up front when the
  mapping has none stored instead of refusing outright, and stores the revision
  the void returns so the next write does not start stale. **This also fixes
  v0.110.0**, where the bug is live.
- The reconcile sweep's gate widened from `pull_payments` to
  `pull_payments OR push_payments`, so a realm with pull off and push on now
  runs the CDC pass. With pull off that pass touches Breeze's OWN payments only
  — adopting a create whose response was lost, flagging a divergence, noticing a
  Breeze-created Payment deleted in QuickBooks. Every QuickBooks-origin line is
  suppressed and counted as `skipped_pull_disabled` on the run line: a new
  import, an edit of one already imported (which would otherwise have rewritten
  a Breeze payment amount) and a deletion (which would otherwise have deleted
  the Breeze payment row). The CDC cursor is HELD while pull is off, so turning
  `pull_payments` back on still imports everything from the window it was
  switched off in — nothing is permanently skipped. The integration card's
  "Last reconciled" still advances on those runs, so a pull-off connection does
  not read as permanently stalled.
- A **QuickBooks-origin payment can now be voided in Breeze when pull is off**
  (or the realm is disconnected). Breeze refuses that void while payment
  pull-back is running, because the next CDC sweep would re-import the row — but
  with pull off no such sweep runs, so the refusal made the payment permanently
  unremovable. The void now deletes the Breeze row and its mapping only; the
  QuickBooks record is left exactly as it is, and it is audited as such — both
  on the void entry (`quickbooksRecordUntouched`) and as its own
  `invoice.payment.voided_quickbooks_untouched` entry, so the fact is recorded
  however the void was initiated.
- A QuickBooks **reauth outage no longer retires pending payment pushes.** A
  payment job skipped because the realm is not connected records the reason on
  the mapping but no longer counts as an attempt, so an outage longer than about
  a day can no longer exhaust the 100-attempt budget and clear the outbox before
  the operator reconnects. A pending DELETE whose QuickBooks id was never
  recorded also now reaches its 24-hour give-up window while the realm is
  disconnected, instead of waiting for a reconnect that may never come.
- **Org erasure and org merge no longer discard a QuickBooks payment deletion
  Breeze still owes.** A payment mapping with `pending_op = 'delete'` means
  Breeze created a Payment in the partner's QuickBooks and has not yet removed
  it; both sweeps deleted those rows unconditionally, which silently dropped the
  removal and left the payment standing in the customer's books (the merge sweep
  hit every in-flight owed delete for the whole partner, not just the merged
  org). Both now keep those rows and log the count retained; the delete worker
  removes them once QuickBooks confirms, or gives up loudly after 24 hours.
- Re-pushing an invoice after payment activity no longer fails with a stale
  SyncToken. QuickBooks bumps an Invoice's `SyncToken` every time a payment is
  applied to it or removed, so the token Breeze stored at push time went stale
  without Breeze ever writing the invoice again — "Push to QuickBooks" then
  failed with `QuickBooks rejected the invoice sync (HTTP 400)` and parked the
  mapping in `error`, which in turn blocked the payment fan-out with
  `invoice_not_synced`. Breeze now re-reads the live revision on a QuickBooks
  `Stale Object` fault and retries the update once. Pre-existing since Phase C,
  so this also fixes it on v0.110.0.
- Fixes #4542: `invoices.paid_at` is now cleared whenever an invoice falls out
  of `paid` (a voided payment, a QuickBooks reversal, a refund) and on void.
  Existing rows are NOT retro-corrected; the next recompute of an affected
  invoice fixes it.
- **Rollout note:** the sandbox walkthrough for this feature WAS run on
  2026-09-06 (`docs/integrations/quickbooks-sandbox-verification.md`, Phase D2
  checklist items 27-42): 28, 29, 31-42 PASS, 27 not run (the Intuit
  Development webhook URL was not re-registered, #4545; echoes were driven by
  "Sync now"), 30 blocked (no Stripe on the stack). Four defects were found and
  fixed on the branch during the walk (the bullets above).

---

## Network device page + unified device list on by default (#5090)

**Operator-facing (Added / Improved).**
- The Devices list now shows **network devices** (approved, unlinked discovery assets: switches, firewalls, printers, NAS, phones…) alongside agent endpoints, with an **All / Agent / Network** segment, a Class column, and columns that adapt to what is on screen (a Network-only view drops OS/CPU/RAM/Role; an Agent-only view drops Class/Type).
- Quick chips, advanced filters and saved views evaluate network rows client-side for the fields a discovered asset has (status, hostname, tags, site, IP, MAC, last seen, asset type for the Servers chip). A filter on an agent-only field hides network rows **and says so** — "N network devices hidden — Needs Patches applies to agent devices only." Segment badges count the rows the list actually renders.
- Bulk bar states the class composition ("6 selected · 2 agent, 4 network"); agent-only actions (reboot, scripts, software, maintenance, wake, remove) are disabled with a reason on an all-network selection and annotated "2 of 6" on a mixed one. A selection is dropped when its rows leave the visible set.
- New **network device page** at `/devices/network/:id`: identity (hostname, display name, manufacturer, model, OS fingerprint, first seen, editable type with reset), SNMP data, open ports read as capabilities (service names, an "Unencrypted" flag on telnet/ftp-class ports, per-port **Open Web UI** through an online agent as proxy bridge, HTTPS with a self-signed override), monitoring status, and link/unlink to a managed device (unlink pauses auto-linking until re-linked).
- Discovery asset list: the "Agent installed" badge is now "Agent". Search in the Devices list matches LAN/WAN IPs. Sortable headers are keyboard-reachable; the table uses the same status word as cards (Online/Offline).

**Self-Hosting / Upgrade Notes.**
- **Behaviour change (web):** `PUBLIC_ENABLE_NETWORK_DEVICES_IN_LIST` now defaults to **`true`** (was `false`). It is a build-time `PUBLIC_` variable baked into the web image, so the published GHCR `web` image ships with the unified list on; self-hosters who build the web image themselves can pass `PUBLIC_ENABLE_NETWORK_DEVICES_IN_LIST=false` to keep the agent-only list. Nothing to change in `.env` or compose for the published image.
- No migrations. No new required environment variables.
- API additions, additive: `GET /discovery/assets/:id` now returns `siteName` and `suggestedBridgeDeviceId` (the agent that last discovered the asset, used as the default proxy bridge).
- Not in this release: charts for SNMP metrics / network monitor results on the device page (the Monitoring tab shows enabled/not-configured and links to the discovery view), bulk selection in grid view.

---

## AI agent builder (#5048 W01–W03, #5064, #5063, #5065)

**Operator-facing (Added / Improved).**
- Settings → AI agents → **New agent** is now a four-step guided flow: Purpose and posture (mode first, kind cards, owner scope) → What it does (triggers + capability picker) → Safety and oversight → Review and create. The review card is evaluated **server-side** (`POST /ai/agents/preview`) with the same guardrail and catalog helpers the run loop uses, so what it says is what enforcement does.
- The tool allowlist textarea is replaced by a **capability picker**: 15 capabilities, per-operation outcome badges (Approval request / Logged proposal / Executes unattended), a "Recommended for <kind>" preset, search across labels and literal names, and an "Always on: read-only tools" disclosure. Organization agents see operations outside the partner baseline as **Not in partner baseline**.
- Truthful act-mode outcomes: **Run a script** stays an approval request until a script is authorized for the agent (`actAssets.scriptIds`); the picker and the review card say so instead of promising an unattended run.
- Recipient roles with no active members are marked in the form, and the act-mode "recipient" error now says the selected roles have no active members instead of "add a recipient".
- The edit drawer now lays out an agent the way the create flow does: "When it runs" and Permissions first, then a **Safety and oversight** block with protected services / paths / registry keys, unattended authorization, limits and notification roles. Protected resources moved out of the Permissions section into that block.
- **Scripts allowed to run unattended** (#5065): a new list on the Safety step and in the edit drawer authorizes the scripts **Run a script** may execute without approval in act mode. A partner-wide agent's list is the ceiling; an organization's agent picks a subset of it (scripts outside the baseline show **Not in partner baseline**). The picker and review card show the outcome live.

**Self-Hosting / Upgrade Notes.**
- No new env vars, no migrations. The whole feature is still behind `BREEZE_AI_AGENTS_ENABLED` (default `false`); `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED` unchanged.
- API additions, all additive: `GET /ai/agents/tool-catalog`, `GET /ai/agents/ceiling?kind=` (now also carries the baseline's `scriptIds`), `POST /ai/agents/preview`; `GET /roles` gains `activeUserCount` beside `userCount`; catalog operations gain `actRequiresAuthorizedScripts`.
- Behaviour change (API): a PATCH/POST on an **organization-owned** agent that adds a `supervisedActionKeys` entry the row does not already hold is now refused with `422 supervised_keys_grant_only` — keys reach org rows only through the four-eyes graduation grant. Partner rows are unaffected.
- Behaviour change (API): the partner ∩ org policy merge is now wildcard-aware for `toolAllowlist` / `supervisedActionKeys` (a bare `manage_services` on the baseline no longer erases an org's `manage_services:restart`).
- Behaviour change (API): `actAssets.scriptIds` is now validated on every write that adds an id (`422 invalid_script_ids`, one `rejected[]` entry per id with `not_found` / `not_in_partner_baseline` / `run_script_not_allowed`): the script must be visible to the agent's owner, an organization agent may only list scripts its partner baseline lists, and the row must allow **Run a script**. Ids that stop resolving later are tolerated as stored-but-inert. `POST /ai/agents/preview` gains `authorizedScriptCount`.

---

