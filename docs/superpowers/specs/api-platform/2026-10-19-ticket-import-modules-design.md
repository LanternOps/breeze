---
title: Ticket Import Attachments, Modules and the Zammad Module
status: proposed
date: 2026-10-19
owner: Lennon Fiuza
area: api-platform
tracking_issue: LanternOps/breeze#8313
related:
  - docs/superpowers/specs/api-platform/2026-10-10-ticket-migration-windows-design.md
  - docs/agents/tenancy-rls.md
  - docs/agents/settings.md
---

# Ticket Import Attachments, Modules and the Zammad Module

> Steps 2 and 3 of the ticket importers agreed in discussion #8313. Step 1 (migration windows and
> import mode, `2026-10-10-ticket-migration-windows-design.md`) is on `main` through #8486, #8779,
> #8782 and #8884. This spec adds attachments to import mode (step 2), then the module framework,
> the import worker and the wizard (step 3), with Zammad 7.2.2 as the first module. Step 1's §8 is
> binding except where §10 corrects it.

## 1. Summary

Step 1 gave Breeze a way to write historic tickets: a time-boxed migration window for one keyless
partner service principal, and an import mode in `ticketService` that accepts historic values and
produces no side effects. Nothing calls it yet. This spec adds the three things that turn it into an
importer an MSP can use:

- **Attachments in import mode (§4).** Imported comments carry their files. The bytes go to object
  storage only. Any file type is accepted, but anything outside today's allowlist is stored and
  served download-only. The write protocol survives a crash without leaving unreferenced objects.
- **Modules, worker and wizard (§5).** A module reads one source and converts it into Breeze's
  model. A worker runs the import in short resumable slices under a per-partner lease. A partner-
  admin page at `/tickets/import` connects a source, checks it, maps it, runs a dry run, then the
  bulk and delta passes.
- **The Zammad 7.2.2 module (§6).** It reads through the REST API with an agent token and needs no
  Elasticsearch. It maps states, priorities, articles, organizations, owners and requesters. It
  imports inline images as attachments and links merged tickets to their survivor. Two opt-in
  options, off by default, create missing owners as disabled users and missing requesters as
  contacts. They revisit #8313 answer 3 for imports (§5.13, decisions 24 and 25).

The public write routes still do not change, and an import still produces exactly one event per
org, `migration.window_closed` (#8313 answer 7).

### Design constraints

Inherited from step 1 and #8313:

1. **A backfill is repeatable.** A second pass over the same source converges on it. It never
   duplicates what the first pass wrote.
2. **A module converts into Breeze's model.** Nothing source-shaped reaches `ticketService`. The
   only foreign identities are the source's ticket, comment and attachment ids, kept as resume
   keys.
3. **Partner-axis data, partner admins only** (#8313 answer 2). Every new table is partner-axis.
   Every org id it holds is registered like `migration_window_orgs`.
4. **Per-tenant fairness from day one.** One partner's import cannot starve other tenants: a
   renewable per-partner lease, a global cap, and slices short enough to interleave (§5.8).

New in this spec:

5. **Import-only cutover, no live sync.** The case driving the priorities: an MSP leaving a
   self-hosted Zammad 7.2.2 with 17,460 tickets, 69,663 articles (17,112 of them system messages)
   and 71,814 attachment files totalling 3.4 GB, across 17 organizations (#8313 body). It imports
   in bulk a few days ahead, freezes Zammad, runs a delta pass on the same principal, then
   switches. §7 is the runbook. Anything the delta pass cannot apply is counted and listed, never
   silently dropped.
6. **No new trust in the source.** The source URL is customer-supplied (SSRF rules apply), its
   files are customer-supplied (served download-only), and its token is a stored credential
   (row-bound encryption, per-source revoke).

## 2. Repo facts this design is built on (verified 2026-10-19 against `main` 8f240ddbe)

API paths are relative to `apps/api/src/`. Line numbers are as of 8f240ddbe.

| # | Fact | Evidence |
|---|---|---|
| F1 | `importTicket(windowId, input, { partnerId, chunkSize? })` is the only caller of import mode. It must run with no ambient DB context. It returns `{ ticketId, outcome, commentsWritten, commentsSkipped, fieldsUpdated, statusSkipped: boolean }`. | `services/ticketImport/importWriter.ts:67-93`, `:507-514` |
| F2 | `ImportedComment` is `{ sourceId, createdAt, isPublic, author, content ≤ 200,000 }`, with **no attachment field**. Ticket and comment source ids must be unique across the whole source. Text refuses control characters other than tab and line breaks; tags are at most 50 of 100 characters; there is no comment ceiling; every time must be at or before now. A display-only requester **requires** an email. | `services/ticketImport/importedTicket.ts:15-19`, `:21-22`, `:28-38`, `:52`, `:57-60`, `:66-71`, `:105-109` |
| F3 | The writer chunks comments at 100 per transaction and 1 MiB of content (`IMPORT_COMMENT_CHUNK_BYTES`), charges each transaction to the window bucket before opening it, and applies the final status in the last one. On resume it re-applies header fields unless `field_provenance` is `user`, and the status only when this principal wrote the latest `status_change` row. It never changes a resumed ticket's org (`orgId` comes from the stored ticket). | `importWriter.ts:52-65`, `:257-294`, `:359-370`, `:556`, `:573-646` |
| F4 | `kind: 'import'` may appear only in `services/ticketImport/` and `services/ticketWriteMode.ts`; `lockOpenWindowForWrite(` only in `windowLock.ts` and `importWriter.ts`. The side-effect source scan pins five `ticketService` functions; a new import-mode writer is not covered unless added. | `services/ticketImport/importModeConfinement.test.ts:40-50`; `services/ticketService.sideEffects.test.ts:15-23`; `services/ticketService.ts:365-368` |
| F5 | `ticket_attachments` has no window id, no source id and no principal column. `content_type` is `varchar(64)`. A row hangs off a comment; `comment_id IS NULL` means a pending upload. `byte_size` must be 1..10,485,760 outside the artifact backend. | `db/schema/ticketAttachments.ts:8-15`, `:17-47`; `apps/api/migrations/2026-10-16-192900-artifact-attachments.sql:44-46` |
| F6 | Live limits: 10 MiB, 5 per comment (enforced at the route validator, not in the service), and `allowedMimes` JPEG/PNG/WebP/PDF by magic-byte sniff. Everything else is refused at upload. No attachment path scans for malware. | `packages/shared/src/constants/ticketAttachments.ts:7-12`; `packages/shared/src/validators/tickets.ts:233-234`; `services/attachmentSniff.ts:13-18`; `routes/tickets/attachments.ts:67-199` |
| F7 | `addTicketComment` claims pending uploads only for a human: the claim matches `uploaded_by_user_id = <uploader>`, and `humanUserId` throws `403 HUMAN_SESSION_REQUIRED` for any other actor. | `ticketService.ts:164-169`, `:2394-2396`, `:2450-2487` |
| F8 | The inbound-email precedent for a machine writer: bytes are put to storage **outside** the transaction, the transaction inserts already-attached rows with `uploaded_by_user_id = NULL`, and anything stored whose row did not commit is deleted in-process afterwards. A crash between put and commit leaves an object no row references. A new ticket's first-message files ride on one comment, "Attachments from the original email." Skipped files are listed in a note appended to the text. | `services/ticketMailbox/fetchInboundAttachments.ts:14-32`, `:152-206`; `services/inboundEmail/inboundAttachments.ts:13-53`, `:55-86`; `services/inboundEmail/inboundEmailService.ts:926-940` |
| F9 | The pending reaper deletes rows with `comment_id IS NULL AND created_at < now() - 24 h`, whoever uploaded them, and then their objects. Attached rows are never reaped. | `jobs/ticketAttachmentReaper.ts:83-106` |
| F10 | Storage: `selectBackend()` is `'s3'` when `isS3Configured()` (bucket and both keys set), else `'db'`. The ticket path puts a **whole buffer** (`putObjectBuffer`), with the sha256 as object metadata. Streaming multipart upload exists only in the artifact store, which drops the sha256 metadata to stream. Object keys are `ticket-attachments/<attachmentId>`. | `services/blobStorage.ts:41-76`; `services/s3Storage.ts:113-115`, `:419-441`; `services/artifacts/blobStorage.ts:28-42`; `services/ticketAttachmentStorage.ts:65-85` |
| F11 | Serving: both content routes send `X-Content-Type-Options: nosniff`, the **stored** type, and `contentDispositionFor`, which is `inline` only for `image/*` and `attachment` otherwise. The web renders `image/*` as a thumbnail and anything else as a file chip. A pending row is visible only to its uploader; the portal lists attachments of public, non-deleted comments only. Only the uploader or a `TICKETS_MANAGE` holder may delete a row. | `routes/tickets/attachments.ts:389-393`, `:431-438`, `:470-474`; `services/attachmentFilename.ts:30-31`; `routes/portal/tickets.ts:682-689`, `:725`; `apps/web/src/components/tickets/TicketAttachments.tsx:171-173` |
| F12 | `ticket_attachments` registrations: org cascade with object pre-clear, plain merge repoint, export policy listing every column, ticket org-move lists. A new column needs an export classification. | `services/tenantCascade.ts:967`, `:1440-1444`; `services/orgMergeRegistry.ts:1222`; `services/tenantExportPolicyRegistry.ts:913-918`; `services/ticketOrgMoveLockOrder.ts:76` |
| F13 | Comment content is plain text everywhere: staff web, portal and email render it as text. `htmlToText` drops links, clamps output at 50,000 characters and input at 1,000,000. | `apps/web/src/components/tickets/TicketFeed.tsx:215`; `services/inboundEmail/htmlToText.ts:11`, `:20`, `:53-75` |
| F14 | Ticket links (#8675) are on `main`: types `caused_by`, `resolves`, `related`, `duplicate_of` (one `duplicate_of` per source ticket), same-org only. `addTicketLink` has no write mode: it opens its own transaction, takes the org link lock, inserts two `system` feed rows stamped now, emits `ticket.link_added` twice and writes an audit row. `ticket_links` has no window id. | `db/schema/ticketLinks.ts:7`, `:33-34`; `services/ticketLinkService.ts:262-370` |
| F15 | `matchContactByEmail(exec, orgId, email)` returns a contact only when exactly one in the org has that address (a shared mailbox is `none`). Contact email is not unique per org. The portal shows a ticket to a portal user whose contact is the ticket's `requester_contact_id`. | `services/contacts/crud.ts:480-505`; `db/schema/contacts.ts:84-90`; `routes/portal/ticketOwnership.ts:38-40` |
| F16 | `users.email` is globally unique. Import assignee eligibility needs the same partner and an `org_id` that is null or the ticket's org; deactivated users are allowed. There is no "user by email within a partner" helper. | `db/schema/users.ts:29`; `ticketService.ts:568` |
| F17 | `ticket_categories` is partner-only (`partner_id NOT NULL`) and has `UNIQUE (id, partner_id)`. There is no find-or-create. | `db/schema/tickets.ts:16-19`; `apps/api/migrations/2026-06-10-c-ticket-category-tenant-fks.sql:15` |
| F18 | Statuses: `new, open, pending, on_hold, resolved, closed`, with `resolved → open/closed` and `closed → open` only. No ticket column holds a pending-until time, and nothing auto-closes a resolved ticket. `tickets.submitter_email` is nullable. `tickets.custom_fields` holds an intake-form snapshot, not free attributes. | `ticketService.ts:39-46`, `:1292`; `db/schema/portal.ts:170-262` |
| F19 | A time entry always belongs to a human: `time_entries.user_id` is `NOT NULL`, and even AI-proposed entries are executed as the approving technician. Entries feed invoicing and contract hour blocks. | `db/schema/timeTracking.ts:44`; `services/aiTimeEntryProposal.ts:13-16`; `services/invoiceTimeLineRefresh.ts:39`; `services/contractHourBlockClose.ts:14` |
| F20 | Row-bound secrets: `aadBinding: 'row'` binds the AAD to the row id. `encryptColumnValueForWrite` throws for those columns, so each needs a dedicated writer (`backupProviders/credentials.ts`), and the row id is generated before sealing. With no `APP_ENCRYPTION_KEY_ID`, `encryptSecret` falls back to v1 and drops the AAD. | `services/encryptedColumnRegistry.ts:115`, `:155-166`; `services/encryptedColumnTransform.ts:76-83`; `services/backupProviders/credentials.ts:43`, `:59`; `routes/backup/providers.ts:207`; `services/secretCrypto.ts:414-418` |
| F21 | Outbound HTTP to a customer URL: `psaFetch` validates the base URL with `checkSsrfSafe` (`strict-https`, or `on-prem-http` only when `IS_HOSTED` is explicitly false) and calls `safeFetch` with a timeout, `maxBytes` and `allowPrivateNetwork` under the same rule. `safeFetch` pins DNS, follows no redirects and refuses to run inside a held DB context. A changed URL origin forces credentials to be re-entered. | `services/psa/http.ts:33-62`; `services/urlSafety.ts:536-547`; `services/ssrfGuard.ts:41`, `:91`; `config/env.ts:653-655`; `services/credentialOriginBinding.ts:9-19` |
| F22 | The concurrency precedent named by step-1 §8, `reviewConcurrency.ts`, is a per-**org** counter with a 90-second TTL refreshed only by acquire, and no heartbeat. A ZSET lease with per-holder tokens scored by expiry exists in `accountingRateLimit.ts`, without renewal. A busy slot is deferred with `moveToDelayed` plus `DelayedError`, which spends no attempt. | `services/scriptProposals/reviewConcurrency.ts:13-22`; `services/accounting/accountingRateLimit.ts:55`, `:63-82`; `jobs/scriptReviewWorker.ts:49-58`; `jobs/accountingJobDelay.ts:43-71` |
| F23 | `rateLimiter` adds **one ZSET member per unit of cost**, so it cannot meter bytes. The window bucket is `migration_window_rate:{windowId}` through it, with `refundOnReject`. | `services/rate-limit.ts:133-137`; `services/ticketImport/throughput.ts:17-42` |
| F24 | Jobs: a worker joins `workerRegistry`, `EXPECTED_WORKER_NAMES`, the entrypoint closure contract and the readiness manifest. Job ids go through `bullmqJobId` (no `:`), and `enqueueOrReplaceStale` avoids the silent dedupe. Long jobs use `lockDuration 300_000, stalledInterval 60_000, maxStalledCount 2`. No job re-enqueues itself with a cursor today. | `services/workerRegistry.ts:743-750`; `jobs/workerReadinessManifest.ts:119`; `services/bullmqUtils.ts:16-25`, `:67`; `jobs/backupProviderSync.ts:408-414` |
| F25 | The partner-axis pattern of step 1: one `FOR ALL` policy `system OR breeze_has_partner_access(partner_id)`, ENABLE + FORCE, GRANT with DELETE; `PARTNER_TENANT_TABLES`; a non-tenancy `org_id` adds `ORG_AXIS_POLICY_EXCLUDED_TABLES`, the org cascade, a merge policy and an export policy; partner erasure sweeps every `partner_id` table. | `apps/api/migrations/2026-12-25-120000-migration-windows.sql:96-118`; `__tests__/integration/rls-coverage.integration.test.ts:137-140`, `:235`, `:343-344`; `tenantCascade.ts:746-750`, `:2597`; `orgMergeRegistry.ts:585`; `tenantExportPolicyRegistry.ts:640` |
| F26 | A service file that writes a partner-axis table must mention `canManagePartnerWidePolicies` or carry an `ALLOWED_WITHOUT_CAPABILITY_CHECK` exemption. | `__tests__/partner-wide-write-coverage.test.ts:64`, `:416` |
| F27 | Opening a window needs the principal's owner, an interactive session, MFA and a step-up grant for `migration_window_open`. A principal's creator is its owner, and there is no ownership transfer. | `routes/migrationWindows.ts:165-251`; `services/migrationWindows.ts:336-343`; `routes/partnerServicePrincipals.ts:350-401` |
| F28 | The window summary and its event count tickets and comments only. | `db/schema/migrationWindows.ts:11-15`; `services/migrationWindows.ts:196-226`; `apps/docs/src/content/docs/features/webhooks.mdx:147` |
| F29 | "Actions and reports are not settings" (settings rule 2). The org import lives on the Organizations page, not in settings. The web app already has `mintStepUpGrant` (no caller for `migration_window_open` yet) and a polling precedent. | `docs/agents/settings.md:12`; `apps/web/src/components/organizations/board/OrganizationsBoardPage.tsx:682`; `apps/web/src/lib/mfaStepUp.ts:64`; `apps/web/src/components/backup/RestoreWizard.tsx:345`; `apps/web/src/components/setup/SetupStepper.tsx:5-41` |
| F30 | Route namespaces are reserved in the extension SDK, and a new route file needs an MCP coverage entry; `human_only_migration` is an existing exemption kind. | `packages/extension-sdk/src/manifest.ts:41`; `services/mcpCoverage.ts:30`, `:574` |
| F31 | The newest migration on 8f240ddbe is `2027-01-01-000000-s1-integrations-last-full-agent-sync.sql`. Step 1 built its `ticket_comments` resume index `CONCURRENTLY` in a `-- @no-transaction` file. | `apps/api/migrations/`; `apps/api/migrations/2026-12-25-120100-migration-window-ticket-indexes.sql:1`, `:21-22` |
| F32 | `users.status` is `active`, `invited` or `disabled`. `password_hash` is nullable. `disabled_reason` is free text; partner unsuspend re-enables only `partner_suspended`. `email` is globally unique, and `(id, partner_id)` is unique. A users row that is disabled, has no password and has no `partner_users` or `organization_users` row is an existing shape: the neutralized "tombstone" a removed member leaves. | `db/schema/users.ts:15`, `:27-43`; `apps/api/migrations/2026-04-11-users-rls.sql:231-235` (insert needs partner or org access); `apps/api/migrations/2026-08-22-office-addin-user-bindings.sql:22`; `apps/api/migrations/2026-06-18-neutralize-orphaned-users.sql:1-45`; `services/userNeutralization.ts:37-64` |
| F33 | Such a user cannot sign in. Password login refuses a row with no `password_hash`, and any status but `active`, with the generic 401. Refresh needs `active`. A password reset is refused for `disabled` both when it is requested and when it is redeemed. Invite acceptance needs `invited`. A partner SSO provider may match a password-less staff row by email, but refuses to mint without a `partner_users` membership. CF Access needs `active`. | `routes/auth/login.ts:326`, `:428`, `:1050`; `services/passwordResetEligibility.ts:52`, `:128-130`; `jobs/authEmailWorker.ts:105`; `routes/auth/invite.ts:105`, `:177`; `routes/sso.ts:3388-3412`; `routes/auth/ssoLinkCompletion.ts:203-221`; `routes/auth/cfAccessRedirectLogin.ts:174` |
| F34 | Such a user is invisible to pickers and notifications. `GET /users` in partner scope selects from `partner_users`; the ticket assignee pickers and Settings › Users read it. The default-assignee picker joins `partner_users` and active members. Live assignment and every ticket notification (assignee and subscribers) go through `isEligibleTicketRecipient`, which requires `active`. Tickets have no @-mention feature. Import eligibility checks only partner and org, not status or membership. | `routes/users.ts:1431-1451`; `apps/web/src/components/tickets/TicketsPage.tsx:256`; `apps/web/src/components/tickets/TicketWorkbench.tsx:517`; `services/inboundEmail/defaultAssigneeEligibility.ts:52-57`; `services/ticketPush.ts:181-191`; `jobs/ticketNotifyWorker.ts:381`, `:772`, `:805`; `ticketService.ts:506-517`, `:568-575` |
| F35 | Activation is the normal invite. `POST /users/invite` for an email held by a disabled, password-less row of the caller's tenant resets that row to `invited` under the inviting scope. It keeps the row's id, clears `disabled_reason` and every factor, adds the membership and sends the invite. An email held by **another** tenant is answered exactly like an unused one, and no row is created. | `routes/users.ts:1605-1617`, `:1619-1650`, `:1717-1744` |
| F36 | `contacts` is org-scoped (shape 1), with no active flag and no source marker; `created_by` is nullable. Re-import identity is `contact_external_links`, unique on `(org_id, system, external_id)` with `system` free text, and already in the org cascade, merge and export lists. `createContact` emits no event and writes no audit row (the route does); it records destination history with a source such as `import`. Live inbound email already find-or-creates a contact per unknown sender, under an advisory lock on (org, address), with no roles and so no portal access. | `db/schema/contacts.ts:40-65`, `:115-134`; `apps/api/migrations/2026-08-19-contacts.sql:178`, `:196`; `tenantCascade.ts:519`; `orgMergeRegistry.ts:608`; `tenantExportPolicyRegistry.ts:328`; `services/contacts/crud.ts:508-571`; `db/schema/callerVerification.ts:48-50`; `services/inboundEmail/resolveOrg.ts:86`, `:114-135`; `routes/orgContacts.ts:302-318` |
| F37 | A ticket created with a contact also stores the contact's name and email as its submitter snapshot. Deleting a contact sets `tickets.requester_contact_id` to NULL and leaves the snapshot. The contact delete route writes one `contact.delete` audit row per contact. | `ticketService.ts:1185-1191`, `:1227-1233`; `apps/api/migrations/2026-10-04-100000-ticket-requester-contact.sql:43-46`; `routes/orgContacts.ts:364-385`; `services/contacts/crud.ts:736-766` |

## 3. Source facts: Zammad 7.2.2

From the 7.2.2 source (tag `7.2.2`) and the Zammad documentation, read statically. Nothing was run
against a live instance. Items marked **unverified** are collected in §11.

| # | Fact | Source |
|---|---|---|
| Z1 | Ticket visibility comes from group access, not from `admin`, and only **active** groups count. Tickets in a deactivated group are invisible to every token. | [base_scope.rb][z-scope], [has_groups.rb][z-groups-active] |
| Z2 | `GET /api/v1/tickets?page=N&per_page=100` is ordered `id ASC`, capped at 100 per page, has no state filter (closed and merged included), no total and no Elasticsearch dependency. Offset paging can skip one row when a ticket is deleted mid-scan. | [tickets_controller.rb][z-tickets-index], [pagination.rb][z-paginate] |
| Z3 | There is no "changed since" on the list. A structured `updated_at` search needs Elasticsearch; without it `query` is a substring match, and an invalid SQL `condition` makes the search run **unfiltered**. | [can_search.rb][z-can-search], [selector/sql.rb][z-selector-nil] |
| Z4 | `updated_at` moves on almost any change: articles added, edited or deleted, tags, links, merges (both tickets), shared-draft saves and escalation recalculation. | [article.rb][z-article-touch], [ticket.rb][z-merge-touch], [shared_draft_zoom.rb][z-draft-touch], [escalation.rb][z-escalation] |
| Z5 | `GET /ticket_articles/by_ticket/:id` is unpaginated, ordered `created_at, id`, includes internal articles for agents, and lists **all** attachments including inline ones. The asset forms (`full=true`, `all=true`) **omit inline attachments**, and `all=true` also evaluates Core Workflow. | [ticket_articles_controller.rb][z-by-ticket], [ticket.rb][z-by-ticket-order], [article.rb][z-asset-attrs], [assets.rb][z-asset-inline], [assets_all.rb][z-assets-all] |
| Z6 | The API rewrites `src="cid:X"` to `/api/v1/ticket_attachment/{ticket}/{article}/{store_id}?view=inline`. `view=inline` serves a copy resized to 1800 px; no `view` serves the original bytes. Content type comes from the attachment `preferences`. Inline attachments move to `inline_attachments` in a later release. | [article.rb][z-inline-rewrite], [store.rb][z-resize], [download_file.rb][z-download-view], [download_file.rb][z-download-type], [BREAKING_CHANGES.md][z-inline-future] |
| Z7 | Incoming mail attachments have no `Content-Disposition` in `preferences`, and an HTML mail also stores its raw HTML as a `message.html` attachment marked `content-alternative: true`. | [attachment_parser.rb][z-attachment-parser], [content_parser.rb][z-content-alt] |
| Z8 | `GET /api/v1/ticket_attachment/:ticket_id/:article_id/:id` downloads one attachment; the article must belong to `:ticket_id` (or that ticket is merged). Attachment ids are global `stores` ids; `size` is a **string**; equal content shares a `store_file_id`. | [ticket_articles_controller.rb][z-attachment-route], [create_base.rb][z-store-size], [store/file.rb][z-store-file] |
| Z9 | Merge: every article of the merged ticket moves to the survivor (original `created_at` kept), a public `note` with body `merged` is added to the merged ticket, which gets state `merged` and owner 1. Tags and time accountings stay on it. `GET /api/v1/links?link_object=Ticket&link_object_value=<id>` returns the survivor as a `parent` link, and re-pointing makes it the **final** survivor of a chain. | [ticket.rb][z-merge], [ticket.rb][z-merge-marker], [link.rb][z-link-list], [links_controller.rb][z-links-ctrl], [user docs][z-merge-docs] |
| Z10 | A deleted ticket leaves no history or tombstone. `GET /api/v1/tickets/:id` answers **404** for a deleted ticket and **403** for one that exists but is not visible. | [has_history.rb][z-history-destroy], [handles_errors.rb][z-errors] |
| Z11 | Auth is `Authorization: Token token=<token>`. Effective permissions are the user's intersected with the token's list; no read-only permission exists, and `ticket.agent` alone can still create and update users and organizations. The token's user must be active. Each token request writes `last_used_at`. | [intro.rst][z-token-header], [token/permissions.rb][z-token-perms], [users_controller_policy.rb][z-users-policy], [organizations_controller_policy.rb][z-orgs-policy], [authenticates.rb][z-auth-active], [authenticates.rb][z-auth-lastused] |
| Z12 | Map states by **state type**: seeded `new`, `open`, `pending reminder`, `pending close` (type `pending action`), `closed`, `merged`; legacy `removed` may survive. `close_at` is the first close and never reset, `last_close_at` the latest; there is no resolved timestamp. `pending_time` is cleared outside pending states. | [ticket_states.rb][z-states-seed], [state_type.rb][z-state-types], [drop_removed_state.rb][z-removed], [sets_close_time.rb][z-close-time], [ticket.rb][z-pending-time] |
| Z13 | Priorities have no numeric level; seeded `1 low`, `2 normal`, `3 high`; admins can add more. | [create_ticket.rb][z-priorities], [ticket_priorities.rb][z-priorities-seed] |
| Z14 | Article senders are Agent, Customer and System; types are email, sms, chat, fax, phone, twitter status/direct-message, facebook feed post/comment/direct-message, note, web, telegram and whatsapp. Zammad's own "non-system" scope is sender ≠ System. The real author is `origin_by`, else `created_by`. | [ticket_article_senders.rb][z-senders], [ticket_article_types.rb][z-types], [article.rb][z-system-scopes], [adds_metadata_general.rb][z-origin-by] |
| Z15 | `owner_id = 1` means unassigned. Closed tickets keep inactive owners. `GET /api/v1/users` (max 1000 per page, `id ASC`) returns inactive users too; user `email` is not unique and may be empty. `organization_id` on a ticket is nullable. | [ticket.rb][z-owner-unassigned], [ticket.rb][z-owner-reset], [users_controller.rb][z-users-index], [create_base.rb][z-users-table], [ticket.rb][z-ticket-org] |
| Z16 | The ticket JSON carries `time_unit`, the sum of its time accountings. Listing the entries needs `change` access or `admin.time_accounting`. | [create_ticket.rb][z-ticket-columns], [time_accountings_controller_policy.rb][z-time-policy], [assets_all.rb][z-assets-time] |
| Z17 | Object Manager attributes are extra top-level ticket columns; their definitions need `admin.object`. The seeded `type` attribute (Incident, Problem, Request for Change) is inactive by default. | [attribute.rb][z-attrs], [object_manager_attributes_controller_policy.rb][z-attrs-policy], [object_manager_attributes.rb][z-type-attr] |
| Z18 | Tags come from `GET /api/v1/tags?object=Ticket&o_id=<id>`, not from the ticket JSON. Groups (`GET /api/v1/groups`, inactive included) and organizations use the generic index (max 1000). | [tags_controller.rb][z-tags], [groups_controller.rb][z-groups-index], [renders_models.rb][z-generic-index] |
| Z19 | `body_rendering_error = true` means the stored body is a placeholder. API-created bodies are capped at 1,500,000 characters; mail and import truncate instead. `create_article_type_id` comes from the first article. | [article.rb][z-render-error], [article.rb][z-body-limit], [has_ticket_contact_attributes_impact.rb][z-create-type] |
| Z20 | The authenticated API has no generic rate limit; the shipped nginx proxy times out at 300 s. | [public_endpoint.rb][z-rate], [zammad.conf][z-nginx] |

[z-scope]: https://github.com/zammad/zammad/blob/7.2.2/app/policies/ticket_policy/base_scope.rb#L16-L44
[z-groups-active]: https://github.com/zammad/zammad/blob/7.2.2/app/models/concerns/has_groups.rb#L126-L146
[z-tickets-index]: https://github.com/zammad/zammad/blob/7.2.2/app/controllers/tickets_controller.rb#L13-L42
[z-paginate]: https://github.com/zammad/zammad/blob/7.2.2/app/controllers/concerns/can_paginate/pagination.rb#L5-L23
[z-can-search]: https://github.com/zammad/zammad/blob/7.2.2/app/models/concerns/can_search.rb#L189-L207
[z-selector-nil]: https://github.com/zammad/zammad/blob/7.2.2/lib/selector/sql.rb#L59-L67
[z-article-touch]: https://github.com/zammad/zammad/blob/7.2.2/app/models/ticket/article.rb#L49
[z-merge-touch]: https://github.com/zammad/zammad/blob/7.2.2/app/models/ticket.rb#L368-L377
[z-draft-touch]: https://github.com/zammad/zammad/blob/7.2.2/app/models/ticket/shared_draft_zoom.rb#L11
[z-escalation]: https://github.com/zammad/zammad/blob/7.2.2/app/models/ticket/escalation.rb#L6-L8
[z-by-ticket]: https://github.com/zammad/zammad/blob/7.2.2/app/controllers/ticket_articles_controller.rb#L36-L76
[z-by-ticket-order]: https://github.com/zammad/zammad/blob/7.2.2/app/models/ticket.rb#L116
[z-asset-attrs]: https://github.com/zammad/zammad/blob/7.2.2/app/models/ticket/article.rb#L307-L344
[z-asset-inline]: https://github.com/zammad/zammad/blob/7.2.2/app/models/ticket/article/assets.rb#L47
[z-assets-all]: https://github.com/zammad/zammad/blob/7.2.2/app/models/ticket/assets_all.rb#L45-L56
[z-inline-rewrite]: https://github.com/zammad/zammad/blob/7.2.2/app/models/ticket/article.rb#L111-L142
[z-resize]: https://github.com/zammad/zammad/blob/7.2.2/app/models/store.rb#L162-L170
[z-download-view]: https://github.com/zammad/zammad/blob/7.2.2/app/controllers/application_controller/has_download/download_file.rb#L24-L31
[z-download-type]: https://github.com/zammad/zammad/blob/7.2.2/app/controllers/application_controller/has_download/download_file.rb#L18-L50
[z-inline-future]: https://github.com/zammad/zammad/blob/7.2.2/BREAKING_CHANGES.md#L5-L16
[z-attachment-parser]: https://github.com/zammad/zammad/blob/7.2.2/app/models/channel/email_parser/attachment_parser.rb#L37-L69
[z-content-alt]: https://github.com/zammad/zammad/blob/7.2.2/app/models/channel/email_parser/content_parser.rb#L32-L53
[z-attachment-route]: https://github.com/zammad/zammad/blob/7.2.2/app/controllers/ticket_articles_controller.rb#L164-L201
[z-store-size]: https://github.com/zammad/zammad/blob/7.2.2/db/migrate/20120101000001_create_base.rb#L491-L500
[z-store-file]: https://github.com/zammad/zammad/blob/7.2.2/app/models/store/file.rb#L22-L39
[z-merge]: https://github.com/zammad/zammad/blob/7.2.2/app/models/ticket.rb#L355-L486
[z-merge-marker]: https://github.com/zammad/zammad/blob/7.2.2/app/models/ticket.rb#L393-L402
[z-link-list]: https://github.com/zammad/zammad/blob/7.2.2/app/models/link.rb#L16-L67
[z-links-ctrl]: https://github.com/zammad/zammad/blob/7.2.2/app/controllers/links_controller.rb#L8-L23
[z-merge-docs]: https://user-docs.zammad.org/en/latest/advanced/ticket-actions/merge.html
[z-history-destroy]: https://github.com/zammad/zammad/blob/7.2.2/app/models/concerns/has_history.rb#L11
[z-errors]: https://github.com/zammad/zammad/blob/7.2.2/app/controllers/application_controller/handles_errors.rb#L9-L69
[z-token-header]: https://github.com/zammad/zammad-documentation/blob/d6563a0f71590af1c2966c4fa04a0017349ae68e/api/intro.rst#L50-L58
[z-token-perms]: https://github.com/zammad/zammad/blob/7.2.2/app/models/token/permissions.rb#L13-L17
[z-users-policy]: https://github.com/zammad/zammad/blob/7.2.2/app/policies/controllers/users_controller_policy.rb
[z-orgs-policy]: https://github.com/zammad/zammad/blob/7.2.2/app/policies/controllers/organizations_controller_policy.rb
[z-auth-active]: https://github.com/zammad/zammad/blob/7.2.2/app/controllers/application_controller/authenticates.rb#L136
[z-auth-lastused]: https://github.com/zammad/zammad/blob/7.2.2/app/controllers/application_controller/authenticates.rb#L85-L88
[z-states-seed]: https://github.com/zammad/zammad/blob/7.2.2/db/seeds/ticket_states.rb
[z-state-types]: https://github.com/zammad/zammad/blob/7.2.2/app/models/ticket/state_type.rb#L16-L32
[z-removed]: https://github.com/zammad/zammad/blob/7.2.2/db/migrate/20231129085408_drop_removed_state.rb
[z-close-time]: https://github.com/zammad/zammad/blob/7.2.2/app/models/ticket/sets_close_time.rb#L14-L32
[z-pending-time]: https://github.com/zammad/zammad/blob/7.2.2/app/models/ticket.rb#L728-L743
[z-priorities]: https://github.com/zammad/zammad/blob/7.2.2/db/migrate/20120101000010_create_ticket.rb#L39-L49
[z-priorities-seed]: https://github.com/zammad/zammad/blob/7.2.2/db/seeds/ticket_priorities.rb
[z-senders]: https://github.com/zammad/zammad/blob/7.2.2/db/seeds/ticket_article_senders.rb
[z-types]: https://github.com/zammad/zammad/blob/7.2.2/db/seeds/ticket_article_types.rb
[z-system-scopes]: https://github.com/zammad/zammad/blob/7.2.2/app/models/ticket/article.rb#L75-L83
[z-origin-by]: https://github.com/zammad/zammad/blob/7.2.2/app/models/ticket/article/adds_metadata_general.rb#L44-L59
[z-owner-unassigned]: https://github.com/zammad/zammad/blob/7.2.2/app/models/ticket.rb#L709-L714
[z-owner-reset]: https://github.com/zammad/zammad/blob/7.2.2/app/models/ticket.rb#L768-L784
[z-users-index]: https://github.com/zammad/zammad/blob/7.2.2/app/controllers/users_controller.rb#L20-L47
[z-users-table]: https://github.com/zammad/zammad/blob/7.2.2/db/migrate/20120101000001_create_base.rb#L21-L55
[z-ticket-org]: https://github.com/zammad/zammad/blob/7.2.2/app/models/ticket.rb#L716-L726
[z-ticket-columns]: https://github.com/zammad/zammad/blob/7.2.2/db/migrate/20120101000010_create_ticket.rb#L55-L93
[z-time-policy]: https://github.com/zammad/zammad/blob/7.2.2/app/policies/controllers/time_accountings_controller_policy.rb
[z-assets-time]: https://github.com/zammad/zammad/blob/7.2.2/app/models/ticket/assets_all.rb#L101-L111
[z-attrs]: https://github.com/zammad/zammad/blob/7.2.2/app/models/object_manager/attribute.rb#L12-L33
[z-attrs-policy]: https://github.com/zammad/zammad/blob/7.2.2/app/policies/controllers/object_manager_attributes_controller_policy.rb
[z-type-attr]: https://github.com/zammad/zammad/blob/7.2.2/db/seeds/object_manager_attributes.rb#L125-L163
[z-tags]: https://github.com/zammad/zammad/blob/7.2.2/app/controllers/tags_controller.rb#L22-L32
[z-groups-index]: https://github.com/zammad/zammad/blob/7.2.2/app/controllers/groups_controller.rb#L51-L53
[z-generic-index]: https://github.com/zammad/zammad/blob/7.2.2/app/controllers/application_controller/renders_models.rb#L73-L106
[z-render-error]: https://github.com/zammad/zammad/blob/7.2.2/app/models/ticket/article.rb#L346-L350
[z-body-limit]: https://github.com/zammad/zammad/blob/7.2.2/app/models/ticket/article.rb#L368-L379
[z-create-type]: https://github.com/zammad/zammad/blob/7.2.2/app/models/ticket/article/has_ticket_contact_attributes_impact.rb#L85-L94
[z-rate]: https://github.com/zammad/zammad/blob/7.2.2/lib/rack_attack_setup/public_endpoint.rb#L5-L24
[z-nginx]: https://github.com/zammad/zammad/blob/7.2.2/contrib/nginx/zammad.conf#L86
[z-user-me]: https://docs.zammad.org/en/latest/api/user.html

## 4. Step 2: attachments in import mode

### 4.1 Rules

- **An imported attachment is an ordinary `ticket_attachments` row,** attached to an imported
  comment. Readers, the content routes, org moves, merges, export and erasure need no import
  branch.
- **Object storage only.** The writer refuses attachments unless `selectBackend()` is `'s3'`
  (`409 TICKET_IMPORT_OBJECT_STORAGE_REQUIRED`), and a run refuses to start without
  `isS3Configured()` (F10). A 3.4 GB backfill never lands in `bytea`.
- **Any type, served download-only outside the allowlist** (§4.4). No route changes.
- **The live 10 MiB cap and the CHECK stay** (F5). A larger, empty or unfetchable file is skipped.
  It is named in a note appended to its comment and listed in the run report.
- **Attribution.** `uploaded_by_user_id` stays NULL, as for inbound email (F8).
  `origin_principal_id` is the window's principal, `migration_window_id` the writing window, and
  `import_source_id` the source's attachment id, unique per principal. An imported row can be
  deleted only by a technician with `TICKETS_MANAGE`, as any uploader-less row today.
- **No malware scanning,** as for every attachment today (F6). Imported files
  are years of customer mail. They include executables, macro documents and archives that the
  live upload route would refuse. Download-only serving stops a browser from rendering or running
  them. It does not stop a technician from opening one. This is the main risk of §4. It is
  decision 1 (§9), and the maintainer decides it.

### 4.2 Data model

```sql
-- 2027-01-0X-HHMMSS-ticket-import-attachments.sql (transactional; name re-checked at commit, F31)
ALTER TABLE ticket_attachments ADD COLUMN IF NOT EXISTS migration_window_id uuid;   -- FK-less snapshot, like tickets
ALTER TABLE ticket_attachments ADD COLUMN IF NOT EXISTS origin_principal_id uuid;   -- FK-less, like ticket_comments
ALTER TABLE ticket_attachments ADD COLUMN IF NOT EXISTS import_source_id varchar(255);

ALTER TABLE ticket_attachments DROP CONSTRAINT IF EXISTS ticket_attachments_import_shape_chk;
ALTER TABLE ticket_attachments ADD CONSTRAINT ticket_attachments_import_shape_chk CHECK (
  (import_source_id IS NULL) = (origin_principal_id IS NULL)
  AND (import_source_id IS NULL
       OR (uploaded_by_user_id IS NULL AND migration_window_id IS NOT NULL AND storage_backend = 's3'))
) NOT VALID;
ALTER TABLE ticket_attachments VALIDATE CONSTRAINT ticket_attachments_import_shape_chk;

-- 2027-01-0X-HHMMSS-ticket-import-attachment-indexes.sql (-- @no-transaction, as F31's precedent)
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ticket_attachments_import_source_uq
  ON ticket_attachments (origin_principal_id, import_source_id) WHERE import_source_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ticket_attachments_migration_window
  ON ticket_attachments (migration_window_id) WHERE migration_window_id IS NOT NULL;
-- plus the INVALID-index guard DO block of 2026-12-25-120100
```

- **Why a principal column and not a key through the comment.** A reservation (§4.3) exists
  before its comment does, so `comment_id` cannot be part of the resume key. Keying by principal
  matches `ticket_comments_import_source_uq` (F31). A file whose article moved to another ticket
  by a source merge is therefore skipped, not duplicated, exactly like its comment (F3).
- **Registrations.** The three columns are `included` in the `ticket_attachments` export policy
  (F12): two ids and a source id. No FK, so no cascade, merge or org-move change. Neither
  migration writes rows, so neither needs the system-scope line.

### 4.3 The write protocol: reserve, store, attach

The inbound-email shape (F8) puts the bytes first and inserts already-attached rows afterwards. A
crash between the two leaves an object no row points at. No sweeper can find it, and org erasure
cannot either, because erasure finds objects through rows (F12). Over a multi-day import, a crash
or a deploy in the middle of some chunk is likely. The import therefore writes the row **before**
the bytes and lets the existing reaper (F9) clean up after a crash.

For each comment chunk of `importTicket` (F3), before the chunk's own transaction:

1. **Reserve** (import transactions of at most 100 files each, cost 1 unit per new file): upsert a
   pending row for each attachment of the chunk's comments that has none attached for this
   principal. A file whose declared size is over the cap or zero is skipped here and never
   reserved; a chunk with more than 100 files reserves in several transactions. The row gets `comment_id NULL`, `uploaded_by_user_id NULL`, the three import
   columns, `storage_backend 's3'` and `storage_key = ticket-attachments/<id>`. `created_at` is
   **now**, never historic, or the reaper would take it at once. The metadata is provisional:
   the declared size clamped to 1..10,485,760 (the size CHECK, F5), `application/octet-stream`,
   the sanitized filename and a zero digest. A pending row with no uploader is invisible to everyone (F11). On conflict, an existing
   **pending** row keeps its id. Its `created_at` is refreshed, and it is re-pointed to the
   comment's current ticket. An **attached** row means the file is already imported.
2. **Store** (no DB context, F21): for each reserved file, charge the byte bucket (§4.5), download
   the original with `maxBytes` = 10 MiB, sniff, hash, and `putBytes` to the reserved key. A
   re-put of a key overwrites it. Outcomes split in two:
   - **permanent:** the bytes are over the cap or empty, or the source answers 404 or 403 for the
     file. The file is skipped, never put, and named in the comment's note;
   - **transient:** a timeout, a 5xx after the module's retries, or a storage fault. The ticket
     fails for this pass, its pending rows stay (a timed-out put may have landed), and the next
     run retries it. A transient failure never becomes a permanent skip, or a repeat pass could
     not recover the file.
3. **Attach** (the chunk's existing transaction): `addTicketComment` in import mode inserts the
   comment and claims its stored files in the same transaction (§4.3.1). It sets the real
   `content_type`, `byte_size` and `sha256`, `attached_at = created_at = mode.at` and the current
   window id. The pending rows of permanently skipped files are deleted in the same transaction
   (nothing was put for them), and the skip note is appended to the comment text.

| Crash point | State left | Cleaned by |
|---|---|---|
| after 1, before 2 | pending row, no object | the next pass reuses it; else the reaper after 24 h (deleting an absent key is a no-op) |
| during or after 2, before 3 | pending row and object | the next pass re-puts and attaches; else the reaper deletes both |
| after 3 commits | attached row and object | nothing to clean |

A reservation lives minutes, at most about an hour when the bucket defers the chunk (§4.5). The
24-hour grace is far above that. If the reaper still wins a race, the next pass reserves again.

#### 4.3.1 The import claim in `addTicketComment`

`addTicketComment` keeps its single transaction. Only its claim's owner predicate depends on the
mode:

| Mode | Owner predicate | `attached_at` / `created_at` | Metadata |
|---|---|---|---|
| live (unchanged) | `uploaded_by_user_id = humanUserId(actor)` | `now()` / unchanged | unchanged |
| import | `uploaded_by_user_id IS NULL AND origin_principal_id = mode.window.principalId AND import_source_id IS NOT NULL` | `mode.at` / `mode.at` | from `input.imported.attachments` (type, size, sha256 per id) |

- **Neither mode can claim the other's rows:** a NULL uploader never equals a user, and a human
  upload has no origin principal.
- **No per-comment count cap in import mode.** The live cap of 5 lives in the route validator
  (F6), not in the service. A historic email with twelve files keeps twelve.
- **A shortfall is still `409 ATTACHMENT_NOT_CLAIMABLE`,** and it rolls the chunk back.
- **Side effects.** The function is already one of the five the side-effect scan pins (F4). The
  reservation and skip-delete statements live in a new `services/ticketImport/importAttachments.ts`,
  called only from inside `importTicket`'s transactions. Those functions take no write mode, so
  the side-effect test gains a second assertion: `importAttachments.ts` calls none of the four
  side-effect helpers at all. The confinement test needs no change, because no new file takes the
  window lock.

### 4.4 Types, size and serving

| What the sniff finds (F6) | Stored `content_type` | Served as (F11, unchanged routes) |
|---|---|---|
| JPEG, PNG, WebP | that type | `inline` thumbnail, as a live upload |
| PDF | `application/pdf` | `attachment` |
| anything else (Office files, ZIP, EML, TXT, GIF, SVG, HTML, executables) | `application/octet-stream` | `attachment`, `nosniff`, file chip in the UI |

- **The source's declared type is never trusted,** as on the live route (F6). It is not stored
  either: `content_type` is `varchar(64)` (F5), and an Office type is longer than that. The
  filename keeps the extension.
- **No route change.** Download-only serving follows from the stored type: the routes already
  send `attachment` and `nosniff` for anything that is not `image/*`. One type changes: the shared
  `TicketAttachmentMeta.contentType` is typed as the four allowlisted types
  (`packages/shared/src/types/tickets.ts:11`) and widens to `string`. GIF and SVG show as files,
  not previews. That is the price of not widening what renders inline.
- **Permanent skips:** `too_large` (declared or actual size over 10 MiB), `empty` (0 bytes,
  refused by the CHECK) and `not_found` (the source answers 404 or 403 for the file). The note
  appended to the comment follows the inbound note's shape (F8): `[Attachments not imported:
  a.zip (over the 10 MB limit); …]`.
- **Memory.** The ticket path cannot stream (F10). A download is bounded by `maxBytes`, so peak
  memory is `TICKET_IMPORT_SOURCE_CONCURRENCY × 10 MiB`, 20 MiB by default. Streaming would need
  a `putBlobStream` on the ticket path (the artifact store's `Upload` plus bounded hashing), and it
  would have to drop the object's `sha256` metadata as the artifact store did. That is only worth
  it if the 10 MiB cap is raised (decision 3).

### 4.5 Throughput: units and bytes

- **Units.** Each file costs one unit on the window bucket, charged when it is reserved. That is
  one row write, the unit #8313's estimate used. The claim is an update of the same row and costs
  nothing. A reservation transaction holds at most 100 files, so step 1's rule that every import
  transaction fits within the 600/h floor still holds.
- **Bytes.** A sibling bucket per window, `migration_window_bytes:{windowId}`, is limited by
  `TICKET_IMPORT_MAX_BYTES_PER_HOUR` (env, default 2 GiB). It is charged with the declared size
  before each download and fails closed. A refusal is `429 MIGRATION_WINDOW_RATE_LIMITED` with
  `details.kind: 'bytes'` and `retryAfterSeconds`. `rateLimiter` cannot be reused for it, because
  it adds one ZSET member per unit (F23). This bucket is a small Lua token bucket in
  `services/ticketImport/throughput.ts`.
- **Why a sibling and not more units.** `writes_per_hour` meters database writes, and its 600 floor
  is a promise about transactions. Bytes load S3, the network and the source. Folding them into
  units would give `writes_per_hour` two meanings and break the floor for a 10 MiB file.
- **For the case in §1:** at most about 98k writes (#8313's estimate) plus 71,814 file units, so
  about 170k units at most. That is about 8.5 h at the 20,000/h ceiling, or 28 h at the 6,000/h default.
  The 3.4 GB take under 2 h at the default byte rate. Units, not bytes, set the pace.

### 4.6 Window summary

`MigrationWindowSummary` gains `attachmentsImported`, per org and in total, counted at close from
`ticket_attachments.migration_window_id` and `comment_id IS NOT NULL` (served by the new partial
index). The `migration.window_closed` payload gains the same field. That is additive. The webhook
docs row (F28) and the `eventBus` type contract test change with it.

### 4.7 Alternatives rejected

- *Put-then-insert, as inbound email does.* A crash orphans objects that org erasure cannot find
  (§4.3).
- *Upload-then-claim with a synthetic Breeze user.* The claim is human-only on purpose (F7). A
  fake user would be the shadow user #8313 answer 3 rules out.
- *Keeping the source's declared content type, or widening what renders inline.* The declared type
  is untrusted. Inline rendering is the attack surface, and the allowlist is what keeps it small.
- *Charging bytes to the window's writes bucket* (§4.5).
- *A separate import-attachments table.* Every reader, the export, erasure and the org moves would
  need a second branch.

## 5. Step 3: modules, worker and wizard

### 5.1 Shape

```
wizard (/tickets/import) ── routes /ticket-imports/* ── tables (§5.5)
                                   │ enqueue
                                   ▼
            ticket-import worker: one slice per job, under the per-partner lease (§5.8)
              ├─ module.scan / load / convert / fetchAttachment / probe   (source side, no DB)
              ├─ importTicket(windowId, ImportedTicket, { fetchAttachment, … })   (step 1 + §4)
              ├─ importTicketLink(windowId, …)                                     (§5.3)
              └─ ledger, counters and report rows (partner-scoped context)
```

A module never touches the database, and the framework never parses a source.

### 5.2 The module contract

```ts
interface TicketImportModule<Options, Cursor> {
  readonly id: 'zammad';                              // stored on the source row
  readonly optionsSchema: z.ZodType<Options>;         // module options (priority map, toggles)
  connect(src: SourceHandle): Promise<ConnectReport>; // identity, permissions, warnings
  catalog(src: SourceHandle): Promise<SourceCatalog>; // orgs, groups (incl. inactive), priorities, states, attributes
  scan(src: SourceHandle, cursor: Cursor | null): Promise<{ rows: SourceRow[]; next: Cursor | null }>;
  load(src: SourceHandle, row: SourceRow): Promise<LoadedTicket>;     // all a conversion needs, no file bytes
  convert(loaded: LoadedTicket, ctx: ConversionContext): Conversion;  // pure and synchronous
  fetchAttachment(src: SourceHandle, ref: AttachmentRef, maxBytes: number): Promise<Buffer>;
  probe(src: SourceHandle, sourceTicketKey: string): Promise<'present' | 'deleted' | 'hidden'>;
  isSourceArticleId(commentSourceId: string): boolean; // a source article, not a composed note
}

type SourceRow = { key: string; version: string; orgKey: string | null; summary: unknown };
type Conversion =
  | { kind: 'ticket'; ticket: ImportedTicket; links: ImportedLink[]; notes: ReportNote[] }
  | { kind: 'skip'; code: 'no_org' | 'unsupported'; notes: ReportNote[] };
```

- **`convert` is pure.** The framework resolves every Breeze lookup a page needs before calling it
  and passes them in `ConversionContext`: the org and category maps, users by email, contacts by
  org and email (with the import's own contact links, §5.13), the options, `now` and the measured
  clock skew. Conversion is therefore tested
  against recorded source responses alone. #8313 names those tests as a module's cost.
- **Module contract on ids.** Ticket keys and every comment and attachment source id are unique
  across the whole source and stable between passes. They are resume keys per principal (F2). A
  module that reused per-ticket ids would see later tickets' comments skipped as already
  imported. The module documents its id grammar (Zammad's is in §6.5) and exposes
  `isSourceArticleId(id)` so that the writer can tell source articles from notes the module
  composes (§5.3).
- **`version`** orders a ticket's states in the source (Zammad: `updated_at`). It is compared for
  equality only, never across tickets.
- **Times** are UTC instants. A source time up to `TICKET_IMPORT_MAX_CLOCK_SKEW_MS` (default 5 min)
  in the future, measured against the source's HTTP `Date` header at connect, is clamped to now
  and counted. Beyond that the ticket fails with `clock_skew`.

### 5.3 Writer changes

All in `services/ticketImport/`, so the confinement rules of F4 hold.

1. **Attachments (§4).** `ImportedComment.attachments?: ImportedAttachment[]`, each
   `{ sourceId, filename, declaredBytes?, inline }`. `ImportTicketOptions.fetchAttachment(sourceId,
   maxBytes)` comes from the module, and its errors say whether a failure is permanent or
   transient (§4.3). The result gains `attachmentsWritten`,
   `attachmentsSkipped: { sourceId, reason }[]` and `attachmentBytes`.
2. **Requester email optional.** The display-only requester becomes `{ name, email? }`. A Zammad
   customer may have no email (Z15), and `tickets.submitter_email` is nullable (F18). Today the
   whole ticket would fail validation.
3. **Report-only detail on resume.** The plan read already loads the stored ticket. The result
   gains:
   - `requesterChanged`: the stored requester (contact or submitter email) differs from the
     input;
   - `orgChanged`: the input's org differs from the stored one, which the writer never changes
     (F3);
   - `commentsChangedInSource`: a present comment whose stored content or visibility differs from
     the input;
   - `commentsMissingInSource`: a stored source-article id absent from the input. The writer
     takes `ImportTicketOptions.isSourceArticleId` to tell source articles from composed notes;
     without it, nothing is counted.

   Each is counted and listed. None changes a row (§5.9).
4. **`importTicketLink(windowId, { sourceKey, targetKey, linkType, at }, options)`.** It resolves
   both Breeze tickets through this principal's refs, charges 1 unit, and calls `addTicketLink` in
   import mode inside `inImportTransaction`. `addTicketLink` gains `mode: TicketWriteMode` (default
   live):
   - it requires the import actor, both tickets in a window org, and `at` not before either
     creation;
   - its two feed rows are stamped `mode.at` with the window id;
   - `ticket_links.migration_window_id` is stamped (a new FK-less column, export `included`);
   - the events and the audit row go through `ticketSideEffects(mode)`.

   The side-effect scan gains `ticketLinkService.ts`'s `addTicketLink`. Outcomes:
   - `ALREADY_LINKED`: done;
   - `SOURCE_ALREADY_DUPLICATE`: done only when the existing `duplicate_of` already points at
     this target; otherwise `link_not_written` with code `duplicate_elsewhere`;
   - `CROSS_ORG`, `LINK_LIMIT` (50, `ticketLinkService.ts:30`), `DUPLICATE_TARGET_IS_DUPLICATE`
     and `SOURCE_HAS_DUPLICATES`: known impossible, `link_not_written` with that code.

   A known-impossible link is final for that ticket version, so the merged ticket is not reloaded
   on every pass (§6.6).
5. **The eight low findings of the #8884 review:**
   1. `statusSkipped` keeps its name and gains `statusSkip?: { statusOwner: { kind, principalId },
      sourceStatus, currentStatus }`, as the review proposed. The run report lists it (§5.10).
   2. A note in `statusSteps`' docblock: `created_at` defaults to the transaction's start, not
      its commit. A source edit that lands inside a live request's lifetime can therefore sort
      before it.
   3. A racing re-check can no longer write unmetered status units. When the source status
      differs, the plan charges its steps (at most 2) even if it predicts a skip.
   4. The comment at `importWriter.ts:565-567` is reworded. With nothing to write, the reported
      `statusSkipped` is the plan's answer, read without the lock.
   5. One reason code: a ref whose ticket is invisible under the window's RLS is
      `org_outside_window` in the plan too (`:528` against `:382`).
   6. `ImportTicketOptions.chunkBytes` (tests only, like `chunkSize`), with a test that asserts
      the number of transactions.
   7. A test for `statusSkipped: true` on a first import: a Breeze change lands between the header
      transaction and the last one.
   8. A `writtenByImport` unit case: a matching `principalId` with a kind other than
      `service_principal` is not the import.
6. **Created people (opt-in, §5.13).** `ImportedTicket` gains two variants, both resolved by the
   writer inside the ticket's header transaction, so a person is created only for a ticket that is
   actually written:
   - `assigneeToCreate?: { email, name, sourceUserKey, fallbackNote }`, exclusive with
     `assigneeUserId`. It creates or reuses the disabled owner, assigns the ticket, and records the
     ledger row. When the email cannot be used, it writes `fallbackNote` instead, and the ticket
     stays unassigned. On a resume it follows the header rule for the assignee (F3).
   - `requester: { createContact: { name?, email, sourceUserKey } }`, a third requester variant.
     It reuses the import's linked contact, or exactly one email match, or creates the contact and
     its link; with several matches it falls back to display-only. It applies on a first import
     only, because the requester is never re-applied on resume (§5.9).
   - `ImportTicketOptions.people: { sourceId, runId }` names the ledger. Each created person costs
     1 unit.

### 5.4 HTML to text for imports

`htmlToText` (F13) is parametrized, not copied. Its defaults keep today's behaviour, so its three
callers (the Graph and Gmail normalizers and the partner email renderer) do not change:

```ts
htmlToText(html: string, opts?: {
  maxOutputChars?: number;               // default 50_000; import 200_000 (the ImportedComment limit)
  links?: 'drop' | 'inline';             // default 'drop'; import: "text <url>", or "<url>" when text = url
  quotes?: 'flatten' | 'prefix';         // default 'flatten'; import: "> " per quoted line, nested
  image?: (src: string, alt: string) => string | null;  // default: dropped; import: placeholder resolver
}): string
// plus htmlToTextDetailed(...) → { text, truncatedInput, truncatedOutput } for the import's counters
```

- **Links** keep only `http`, `https` and `mailto` (sanitize-html `allowedSchemes`). A
  `javascript:` link keeps its text and loses its URL.
- **Safety invariant kept.** Every regex still runs over sanitize-html output, where attribute
  values are entity-escaped, and none has a nested quantifier. The 1,000,000-character input cap
  stays for imports too: the bodies are sender-controlled mail.
- **Truncation is visible.** A clamped body ends with `[Truncated during import; the full message
  is in the source ticket.]`, and the run counts it.
- **Plain-text bodies** skip the converter. Line endings are normalized, the control characters
  `importedTicket` refuses are stripped (F2), and the text is clamped the same way.

### 5.5 Data model

Seven partner-axis tables, all created with their RLS in the same migration (`FOR ALL` policy
`breeze_current_scope()='system' OR breeze_has_partner_access(partner_id)`, ENABLE + FORCE, GRANT
SELECT/INSERT/UPDATE/DELETE to `breeze_app`, as F25).

```sql
CREATE TABLE IF NOT EXISTS ticket_import_sources (
  id uuid PRIMARY KEY,                                  -- generated before sealing (F20)
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  module varchar(32) NOT NULL,                          -- 'zammad'
  label varchar(64) NOT NULL,
  base_url text NOT NULL,
  credentials_encrypted text,                           -- NULL once revoked; aadBinding 'row'
  partner_service_principal_id uuid NOT NULL,
  options jsonb NOT NULL DEFAULT '{}',                  -- module options; never an org or category id
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_import_sources_id_partner_uq UNIQUE (id, partner_id),
  CONSTRAINT ticket_import_sources_principal_uq UNIQUE (partner_service_principal_id),
  CONSTRAINT ticket_import_sources_principal_fk FOREIGN KEY (partner_service_principal_id, partner_id)
    REFERENCES partner_service_principals(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT ticket_import_sources_revoked_chk CHECK ((revoked_at IS NULL) = (credentials_encrypted IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS ticket_import_org_maps (       -- source org → Breeze org; NULL key = the fallback
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL,
  partner_id uuid NOT NULL,
  source_org_key varchar(255),
  source_org_name varchar(255),                         -- display snapshot
  org_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_import_org_maps_source_fk FOREIGN KEY (source_id, partner_id)
    REFERENCES ticket_import_sources(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT ticket_import_org_maps_org_fk FOREIGN KEY (org_id, partner_id)
    REFERENCES organizations(id, partner_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);
-- unique (source_id, source_org_key) WHERE source_org_key IS NOT NULL; unique (source_id) WHERE source_org_key IS NULL

CREATE TABLE IF NOT EXISTS ticket_import_category_maps (  -- source group → partner category; no row = none
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL,
  partner_id uuid NOT NULL,
  source_group_key varchar(255) NOT NULL,
  source_group_name varchar(255),
  category_id uuid NOT NULL,
  CONSTRAINT ticket_import_category_maps_source_fk FOREIGN KEY (source_id, partner_id)
    REFERENCES ticket_import_sources(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT ticket_import_category_maps_category_fk FOREIGN KEY (category_id, partner_id)
    REFERENCES ticket_categories(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT ticket_import_category_maps_uq UNIQUE (source_id, source_group_key)
);

CREATE TABLE IF NOT EXISTS ticket_import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  source_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('dry_run', 'import')),
  window_id uuid,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'running', 'completed', 'stopped', 'failed', 'cancelled')),
  stop_reason text,                                     -- window_closed | source_unavailable | credentials_revoked | …
  phase text NOT NULL DEFAULT 'scan' CHECK (phase IN ('scan', 'links', 'deletions', 'done')),
  cursor jsonb NOT NULL DEFAULT '{}',                   -- the module's scan cursor
  slice_seq integer NOT NULL DEFAULT 0,                 -- the only slice allowed to run (§5.8)
  counters jsonb NOT NULL DEFAULT '{}',                 -- typed in TS (§5.10)
  options jsonb NOT NULL,                               -- the source options at start
  started_by uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz,
  finished_at timestamptz,
  CONSTRAINT ticket_import_runs_id_partner_uq UNIQUE (id, partner_id),
  CONSTRAINT ticket_import_runs_source_fk FOREIGN KEY (source_id, partner_id)
    REFERENCES ticket_import_sources(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT ticket_import_runs_window_fk FOREIGN KEY (window_id, partner_id)
    REFERENCES migration_windows(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT ticket_import_runs_window_chk CHECK ((kind = 'import') = (window_id IS NOT NULL))
);
-- unique (source_id) WHERE state IN ('queued', 'running'): one active run per source

CREATE TABLE IF NOT EXISTS ticket_import_items (           -- the per-source ticket ledger
  source_id uuid NOT NULL,
  partner_id uuid NOT NULL,
  source_ticket_key varchar(255) NOT NULL,
  state text NOT NULL CHECK (state IN ('imported', 'skipped', 'failed', 'deleted_in_source', 'hidden_in_source')),
  imported_version varchar(64),                         -- source version of the last complete import
  seen_version varchar(64),
  seen_run_id uuid,                                     -- FK-less: runs may be deleted
  failure_code varchar(64),
  attempts integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, source_ticket_key),
  CONSTRAINT ticket_import_items_source_fk FOREIGN KEY (source_id, partner_id)
    REFERENCES ticket_import_sources(id, partner_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ticket_import_run_issues (       -- ids, numbers and codes only, never content
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  partner_id uuid NOT NULL,
  source_ticket_key varchar(255),
  source_ticket_number varchar(255),
  kind varchar(48) NOT NULL,                             -- §5.10
  code varchar(64),
  count integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_import_run_issues_run_fk FOREIGN KEY (run_id, partner_id)
    REFERENCES ticket_import_runs(id, partner_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ticket_import_user_links (       -- owners this source created (§5.13)
  source_id uuid NOT NULL,
  partner_id uuid NOT NULL,
  source_user_key varchar(255) NOT NULL,                -- the Zammad user id
  user_id uuid NOT NULL,
  created_run_id uuid,                                  -- FK-less: runs may be deleted
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, source_user_key),
  CONSTRAINT ticket_import_user_links_source_fk FOREIGN KEY (source_id, partner_id)
    REFERENCES ticket_import_sources(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT ticket_import_user_links_user_fk FOREIGN KEY (user_id, partner_id)
    REFERENCES users(id, partner_id) ON DELETE CASCADE
);
```

| Table | Shape | Registrations |
|---|---|---|
| `ticket_import_sources` | 3 | `PARTNER_TENANT_TABLES`. Partner erasure via `partner_id`. No `org_id`, so no org cascade, merge or export entry (`docs/agents/tenancy-rls.md:65`). `encryptedColumnRegistry` entry `credentials_encrypted`, `aadBinding: 'row'`, with a dedicated writer `services/ticketImport/sourceCredentials.ts` (F20); the AI-output masking test and the `SECRET_ROTATION.md` coverage list follow the registry. |
| `ticket_import_org_maps` | 3, non-tenancy `org_id` | `PARTNER_TENANT_TABLES` and `ORG_AXIS_POLICY_EXCLUDED_TABLES`; `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical, before `organizations`); `orgMergeRegistry` `repoint` (no unique key contains `org_id`, so no dedupe); export `included` for every column; the composite org FK is `DEFERRABLE INITIALLY IMMEDIATE`. |
| `ticket_import_category_maps`, `ticket_import_runs`, `ticket_import_items`, `ticket_import_run_issues`, `ticket_import_user_links` | 3 | `PARTNER_TENANT_TABLES`; partner erasure via `partner_id`. No `org_id` and no org-scoped content. `ticket_import_user_links` references `users (id, partner_id)` (F32), so it cannot name another partner's user. |
| `contact_external_links` (existing) | 1 | The contact ledger, with no change: system `ticket-import:<sourceId>`, external id the source user key (§5.13). Already registered (F36). |
| `ticket_attachments` (3 columns), `ticket_links.migration_window_id` | 1 | Export `included` (§4.2, §5.3). FK-less, so no cascade, merge or deferrability change. |

- **Partner-wide first.** These are not config tables an org could own: an import spans orgs, and
  #8313 answer 2 makes it a partner-admin action. So `partner_id NOT NULL` with no `org_id`
  owner, and the PR states why.
- **Why child tables.** The org and category maps are child tables, not a jsonb map on the source.
  An org id inside jsonb escapes every registration list (step-1 §3.2). A category id inside jsonb
  dangles when the category is deleted. Priority maps and toggles hold no ids and stay in
  `options`. No column is added to `users` or `contacts` (§5.13).
- **ON DELETE behaviour.** Users are `SET NULL` (an audit trail must not block a user's
  deletion). Orgs and categories are `CASCADE` (a deleted target simply unmaps). Sources cascade to
  their maps, runs, ledger and issues. A deleted principal cascades its source, as it already
  cascades its windows.
- **Write gate.** The route files call `canManagePartnerWidePolicies`. The service files that
  write these tables are listed in `ALLOWED_WITHOUT_CAPABILITY_CHECK` (F26), each with its reason:
  `services/ticketImport/sourceStore.ts` and `sourceCredentials.ts` ("called only from the gated
  routes/ticketImports"), `importPeople.ts` ("writes users and the user ledger only inside a
  migration-window transaction"), and `runStore.ts` ("worker under a partner-scoped context; every
  caller-facing write is gated in routes/ticketImports").
- **Where these are caught.** `rls-coverage`, org cascade, org merge, tenant export and
  `orgLifecycleFoundations` (the deferrable FK) run only under **Integration Tests**. Each wave
  runs them before its PR.

### 5.6 Credentials and outbound HTTP

- **Storage** follows `backup_provider_connections` (F20): the id is generated before sealing,
  the credential is sealed with the AAD bound to that row, and reads never select the ciphertext
  (`hasCredentials` instead). Row binding takes effect only with `APP_ENCRYPTION_KEY_ID` set
  (F20). The runbook (§7) says so.
- **Revoke and delete** (#8313 answer 1, per-source revoke):
  - **Revoke** clears `credentials_encrypted` and stamps `revoked_at`/`revoked_by`. The row, its
    principal, its mappings and its run history stay, so a later re-import reconnects with a new
    token and resumes.
  - **Delete** removes the source with its maps, runs, ledger and issues. Imported tickets and the
    principal stay.

  A hard delete is not the revoke. Resume is per principal (F3). A source recreated on a new
  principal would import all 17,460 tickets a second time. Sources are therefore one per principal
  (`UNIQUE`), and a new source can be bound to an existing keyless principal the caller owns.
- **The HTTP client.** `services/ticketImport/sourceFetch.ts` is modeled on `psaFetch` (F21):
  - `checkSsrfSafe` uses `strict-https`, or `on-prem-http` only when `selfHostAllowsPrivateNetwork()`;
    loopback, link-local, metadata and CGNAT stay blocked in both modes;
  - `safeFetch` runs outside any DB context, with no redirects, a per-call timeout
    (`TICKET_IMPORT_SOURCE_TIMEOUT_MS`, default 30 s) and a per-call `maxBytes` (16 MiB for JSON,
    10 MiB for a file);
  - **no URL is ever taken from a response.** Every request URL is the stored base URL plus a
    fixed path and numeric ids. That is stronger than `pinCursorToBase`, which exists to follow
    body-supplied cursors. Zammad pages by number;
  - changing the base URL's origin requires new credentials (`credentialOriginBinding`, F21).

### 5.7 Routes and authorization

Mounted at `/ticket-imports`, a namespace W4 adds to the extension SDK's reserved list (F30), with
`requireScope('partner')` and the partner-wide admin gate. Every write also needs `requireMfa()`.
The MCP coverage entry is `human_only_migration` (F30).

| Route | Who | Notes |
|---|---|---|
| `GET /ticket-imports/modules` | partner-wide admin | `[{ id: 'zammad', label, optionsSchema }]` |
| `POST /ticket-imports/sources` | the principal's owner | `{ module, label, baseUrl, credentials, principalId }`. The principal must be the caller's (F27, only its owner can open a window), active, hold `tickets:write`, have no active key and no other source. The wizard creates it first through the existing `POST /partner-service-principals`. The id is generated, the token live-tested with `connect`, then sealed. Audit `ticket_import.source_created`. |
| `GET /ticket-imports/sources`, `GET …/:id` | partner-wide admin | never returns ciphertext |
| `PATCH …/:id` | the principal's owner | label, base URL, credentials (re-sealed under the same id); an origin change requires credentials; new credentials on a revoked source clear `revoked_at` and `revoked_by` |
| `POST …/:id/revoke`, `DELETE …/:id` | any partner-wide admin (narrowing) | `409 TICKET_IMPORT_RUN_ACTIVE` while a run is active |
| `POST …/:id/preflight` | partner-wide admin | synchronous: `connect` + `catalog` + S3 check (§5.11, §6.1) |
| `PUT …/:id/mappings` | the principal's owner | org map with fallback, category map, options; `409 TICKET_IMPORT_MAPPING_LOCKED` while a run is active |
| `POST …/:id/runs` | partner-wide admin | `{ kind: 'dry_run' }` or `{ kind: 'import', windowId }`. An import checks: S3 configured; the window open, of this partner, on this source's principal; every mapped org and the fallback in the window. One active run per source. |
| `GET …/:id/runs`, `GET /ticket-imports/runs/:runId`, `GET …/runs/:runId/issues` | partner-wide admin | progress and the report, polled |
| `POST /ticket-imports/runs/:runId/cancel` | any partner-wide admin | the run stops at the next ticket boundary |
| `GET …/:id/created-users`, `GET …/:id/created-contacts` | partner-wide admin | the people this source created, from the ledgers (§5.13) |
| `POST …/:id/created-contacts/remove` | any partner-wide admin | removes the created contacts still as imported (§5.13); `409 TICKET_IMPORT_RUN_ACTIVE` while a run is active |

- **Windows** are opened and closed through the existing `/migration-windows` routes, from the
  wizard, with the owner's step-up grant (F27). The worker cannot open one, and the module never
  sees one.
- **Starting an import run** needs only a partner-wide admin. The window, which only the owner can
  open, is the grant; the run just uses it.
- **Audit.** Source created, updated, revoked and deleted; mappings changed; run started,
  cancelled and finished, with counters. All are partner-level rows. The ticket writes stay
  unaudited per row, as step 1 confirmed.

### 5.8 Runs, slices and the worker

- **Queue** `ticket-import`, job `slice`. The payload is `{ runId, partnerId, seq }`, validated
  with zod in `queueSchemas.ts`. The job id is `bullmqJobId('ticket-import', runId, seq)`, with
  `attempts: 3` and exponential backoff from 10 s. Worker options are F24's long-job set. The
  worker `ticketImportWorker` (placement `global`) joins the four registration lists (F24).
- **A slice** does at most `TICKET_IMPORT_SLICE_MS` (default 5 min) of work, then persists its
  cursor and counters and enqueues slice `seq + 1`. A slice runs only while
  `ticket_import_runs.slice_seq` equals its `seq`, and it advances `slice_seq` with a
  compare-and-set in the same transaction that saves the cursor, before enqueueing. A retried
  slice whose successor already ran finds the sequence moved and exits, so a run never has two
  chains of slices writing its cursor. This is the first
  job in the repo that continues itself (F24). It is chosen over one multi-day job for three
  reasons: a deploy kills at most one slice, BullMQ's stall handling stays meaningful, and slices
  of different partners interleave.
- **Contexts.** `importTicket` and `importTicketLink` run with no context (F1). Ledger, counters
  and issues are written in a partner-scoped context (`scope: 'partner'`,
  `accessiblePartnerIds: [partnerId]`, no orgs, `userId: null`), so RLS bounds a slice to its own
  partner. Contact lookups for `ConversionContext` run read-only in a context limited to the mapped
  orgs (the window's, on an import).
  Lookups of users by email run in system context with an explicit partner predicate, as
  `assertImportAssigneeEligible` does.
- **Deferrals spend no attempt** (F22): a busy lease, a `429` from either bucket, or a source
  `Retry-After` moves the job to delayed for the indicated time (`delayJobForRateLimit`).
- **Stopping.** `409 MIGRATION_WINDOW_NOT_OPEN` stops the run (`window_closed`). Revoked
  credentials stop it (`credentials_revoked`). Twenty consecutive source failures after retries
  stop it (`source_unavailable`). A later run resumes from the ledger.
- **Per-ticket failures do not stop a run.** `MIGRATION_IMPORT_INVALID`,
  `MIGRATION_SOURCE_ID_IN_USE`, `ASSIGNEE_NOT_ELIGIBLE`, `ticket_too_large` and a source 4xx mark
  the item `failed` with its code. The next run retries it.

**The per-partner lease** (`services/ticketImport/importLease.ts`, built on the ZSET lease of
`accountingRateLimit.ts`, F22):

| Key | Cap | Members |
|---|---|---|
| `ticket-import:lease:partner:{partnerId}` | 1 | one token per holding slice, scored by expiry |
| `ticket-import:lease:global` | `TICKET_IMPORT_GLOBAL_CONCURRENCY` (default 2) | the same token |

- **Acquire** is one Lua script over both keys: remove expired members, then add the token to both
  only if both are under cap.
- **Renew** is a heartbeat every `TICKET_IMPORT_LEASE_MS / 3` (lease 60 s), one Lua script: if
  `ZSCORE` finds the token in both keys, it re-scores it in both and runs `PEXPIRE` on both keys,
  whose own TTL would otherwise lapse 60 s after acquire (the precedent sets it only there);
  otherwise it reports the lease lost.
- **Release** removes the token from both keys in a `finally`.
- **A crash** frees the lease within 60 s.
- **The global cap stays below `TICKET_IMPORT_WORKER_CONCURRENCY`** (default 3). A worker slot is
  then always free to defer a refused slice instead of blocking behind a holder.
- **Fails closed** without Redis (BullMQ needs it anyway).
- **A lost lease** stops the slice at the next ticket boundary. The lease is for fairness, not
  correctness. Two slices of one principal writing at once are already safe: the unique indexes,
  the writer's re-checks under `FOR SHARE` and `FOR NO KEY UPDATE` (F3), and one active run per
  source.

**Env settings** (registered in `system/connections/internalEnvVars.ts`, `docker-compose.yml` and
`.env.example`, as wave 1a did):

| Variable | Default | Section |
|---|---|---|
| `TICKET_IMPORT_WORKER_CONCURRENCY` | 3 | §5.8 |
| `TICKET_IMPORT_GLOBAL_CONCURRENCY` | 2 (kept below the worker concurrency) | §5.8 |
| `TICKET_IMPORT_LEASE_MS` | 60,000 | §5.8 |
| `TICKET_IMPORT_SLICE_MS` | 300,000 | §5.8 |
| `TICKET_IMPORT_SOURCE_CONCURRENCY` | 2 | §4.4, §6.2 |
| `TICKET_IMPORT_SOURCE_TIMEOUT_MS` | 30,000 | §5.6 |
| `TICKET_IMPORT_MAX_BYTES_PER_HOUR` | 2 GiB | §4.5 |
| `TICKET_IMPORT_MAX_CLOCK_SKEW_MS` | 300,000 | §5.2 |
| `TICKET_IMPORT_MAX_ISSUES_PER_RUN` | 50,000 | §5.10 |
| `TICKET_IMPORT_MAX_TICKET_BYTES` | 256 MiB | §11 |

### 5.9 Passes, the delta and what is report-only

Every import run is the same pass, and the first one is just the one where every ticket is new:

1. **Scan** (phase `scan`), one source page at a time. Upsert the page's items with `seen_version`
   and `seen_run_id`. Then, for each row:
   - **No org.** The org has no mapping and there is no fallback: `skipped`/`no_org`. This is
     decided from the list row, without loading the ticket.
   - **Unchanged.** `imported_version = seen_version` and `state = imported`: skip, with no source
     call.
   - **Otherwise** `load`, `convert` and `importTicket`. On success set `imported_version`. Links
     the conversion asked for are queued in the run cursor.
2. **Links** (phase `links`): `importTicketLink` for each queued link whose two tickets now exist
   in one org (merges, §6.6). Anything else becomes an internal note, already written by the
   conversion.
3. **Deletions** (phase `deletions`): items in state `imported` whose `seen_run_id` is not this
   run were not seen. `probe` each:
   - `present`: the ticket was skipped by an offset shift (Z2); import it now;
   - `deleted` (404): mark `deleted_in_source` and report;
   - `hidden` (403): mark `hidden_in_source` and report.

   **Nothing is ever deleted in Breeze.** A ticket deleted in the source stays, and the report
   says so.

   This phase runs only after a complete scan; a run stopped mid-scan skips it.

**A dry run** is the scan and every conversion, `parseImportedTicket` included, with no window,
no ticket writes, no downloads (declared sizes only) and no ledger writes. Its report predicts
what an import would do.

The delta pass after the freeze is this pass on a frozen source. Only changed tickets are loaded;
the rest cost one list row each. What a resumed ticket gets is step 1's behaviour: missing
comments and their files, header convergence, and the status under the Breeze-wins rule (F3).

**Report-only in v1** (the maintainer's 2026-10-14 gaps): these are counted and listed per ticket,
and no row changes.

| Source change between passes | Detected by | v1 | Later (decision 14) |
|---|---|---|---|
| comment edited, or its internal flag flipped | `commentsChangedInSource` | report | import-mode comment update, Breeze edit wins |
| comment deleted | `commentsMissingInSource` | report | soft-delete in import mode |
| requester changed | `requesterChanged` | report | re-apply under the Breeze-wins rule |
| ticket moved to another org | `orgChanged` | report | none (an org move is an admin action) |
| ticket deleted / hidden | `probe` | report | none |

A flipped internal flag matters most. A comment made internal in the source stays public in
Breeze, so the report puts these first.

### 5.10 Run report

`counters` (typed, per run): tickets `seen`, `created`, `resumed`, `unchanged`, `skipped`,
`failed`; comments `written`, `skipped`, `systemSkipped`; attachments `written`, `skipped`, `bytes`,
`alternativesIgnored`; `linksWritten`, `linksAsNotes`; `statusKept`; `contentTruncated`;
`clockClamped`; `deletedInSource`, `hiddenInSource`; `ownersUnmatched` (distinct owners) and
`requestersWithoutContact`; `usersCreated`, `contactsCreated`, `ownersNotCreated`;
`openTicketsOwnedByCreatedUsers`; `customAttributes: { name: count }`; and the dry-run predictions
(`predicted.*`, including `ownersToCreate`, `contactsToCreate` per org and
`openTicketsOwnedByCreatedUsers`).

Issue `kind`s, with at most `TICKET_IMPORT_MAX_ISSUES_PER_RUN` rows (default 50,000; counters stay
exact beyond it):

- **Skipped or failed:** `skipped_no_org`, `failed`.
- **Writer decisions:** `status_kept` (with the #8884 detail), `attachments_skipped`,
  `link_not_written`.
- **People:** `owner_unmatched` and `owner_not_created`, once per distinct source owner. The row
  holds the source user key; the wizard shows the name by reading the source's user list live.
  The people an import created are listed from the ledgers, not from issue rows (§5.13).
- **Changed in the source:** `comments_changed`, `comments_missing`, `requester_changed`,
  `org_changed`, `deleted_in_source`, `hidden_in_source`.
- **Content:** `content_truncated`.

Issue rows carry source keys, source numbers and codes, never ticket content. Filenames and names
stay inside the tickets' own internal notes, so an org's erasure leaves nothing personal in the
partner-level report.

### 5.11 The wizard

- **Where.** `apps/web/src/pages/tickets/import.astro`, reached from an "Import tickets" button in
  the ticket list header. The button shows only to partner-scope, partner-wide admins. It is not
  under `/settings`: an import is an action, and actions are not settings (F29, settings rule 2).
  The org import is the precedent, living on the Organizations page. The source connection and
  mappings exist only to serve the action, and this page is their only home. No setting is added,
  so settings rule 9 does not apply. Step and source live in the hash (`#source=<id>&step=mappings`), per the URL
  state rule.
- **Steps** (`SetupStepper`):
  1. **Connect.** Pick a module, base URL, token and label. "Create an import principal" calls
     `POST /partner-service-principals` (scope `tickets:write`, named `Import: <label>`; you
     become its owner), or reuse a keyless principal you own.
  2. **Preflight.** S3, token identity and permissions, groups with inactive or unreadable ones
     flagged, counts of orgs, users and states, attributes, clock skew.
  3. **Mappings.** Each source org to a Breeze org or "skip", one optional fallback org, groups
     to categories (default none), priorities, options. Two options are off by default (§5.13):
     "Create missing owners as disabled users" and "Create missing requester contacts", the
     second with an optional "only for tickets updated since <date>". The dry run shows how many
     of each it would create before any run can start.
  4. **Dry run.** Start it, poll every 5 s, read the report.
  5. **Window.** Open a migration window over the mapped orgs, with the end time and writes per
     hour, through `mintStepUpGrant({ operation: 'migration_window_open' })`. This is that
     operation's first web caller (F29).
  6. **Bulk run** and 7. **Delta run.** Start, follow progress, read the report.
  8. **Close the window,** and see its summary.
- **Mutations** go through `runAction` (`no-silent-mutations.test.ts`).
- **Step 1 left two pieces to this wizard** (its §5): the **Imported** chip on imported tickets
  (`migrationWindowId` set) and an imported filter on the ticket list (`#imported=1`, backed by
  `idx_tickets_migration_window`). The window list with its summaries is on this page too.

### 5.12 Alternatives rejected

- *A separate import service or CLI.* #8313 chose inside Breeze: one place to connect, map and
  watch. Import mode never becomes a public contract. A CLI stays possible later, because the
  window is a platform primitive.
- *One long-running job per import* (§5.8).
- *`reviewConcurrency.ts` as the cap.* It is per org, its TTL cannot cover a multi-hour holder,
  and it has no heartbeat (F22).
- *The ledger as a version column on `ticket_external_refs`.* Refs exist only for imported
  tickets. They cannot record skipped or failed tickets, or "seen in this pass", and every pass
  would write an org table.
- *Module-specific tables.* The framework is source-agnostic; a module's specifics are its
  `options` and its id grammar.
- *Creating contacts or users for historic people by default.* #8313 answer 3 stands as the
  default. §5.13 adds the opt-in, with its limits.
- *Creating users for comment authors, or contacts for every source customer.* Only ticket owners
  and the requesters of imported tickets are ever created; comment authors stay display-only.

### 5.13 Created people (opt-in)

Two source options, both **off by default**. Off, an import creates no user and no contact, which is
#8313 answer 3. On, they revisit that answer for imports (decisions 24 and 25). Comment authors stay
display-only either way.

**Owners as disabled users** ("Create missing owners as disabled users"):

- **Who.** A source agent who owns an imported ticket, has an email, and matches no user of the
  partner that import eligibility accepts (§6.4). One user per email, never per ticket.
- **The row.** It is inserted in the ticket's header transaction, under the window's partner
  context:
  - `partner_id` is the partner and `org_id` is NULL;
  - `status` is `'disabled'` (F32) and `disabled_reason` is `'ticket_import'`;
  - `password_hash`, `email_verified_at` and every MFA field are NULL;
  - there is **no `partner_users` row and no role**, so no access and no RBAC grant;
  - no invite, welcome or verification mail is sent, and nothing is emitted.

  This is the shape the code already gives a removed member (F32). No column is added to
  `users`: the reason says why it is disabled, and the ledger says which import made it.
- **Why it is inert** (verified on 8f240ddbe):
  - it cannot sign in, reset a password, accept an invite, or mint an SSO or CF Access session
    (F33);
  - it appears in no assignee picker and in no user list, receives no notification, and cannot be
    assigned by a live write (F34);
  - import eligibility accepts it, because it checks only partner and org (F34).
- **Email held by another tenant.** `users.email` is globally unique. The insert is
  `ON CONFLICT (email) DO NOTHING`. When nothing is inserted and no user of this partner holds the
  address, the ticket stays unassigned with the owner note, and the report says
  `owner_not_created` without saying why. The invite route hides the same fact the same way (F35).
  The absence of a created user still tells a partner-wide admin that the address is taken
  somewhere; §11 states that.
- **Ledger.** `ticket_import_user_links` (source user key → user id), written in the same
  transaction. A later pass finds the user by email anyway, so there are no duplicates. The ledger
  exists for the report: "users created by this import".
- **Audit.** One partner-level `ticket_import.user_created` row per user. Users are identities and
  security-relevant, and they are few: the agents of the desk.
- **Activation later** is the normal invite of the same email from Settings › Users (F35). The
  invite resets the row to `invited` and keeps its id, so every ticket stays assigned to the person.
- **Deleting the source** removes the ledger rows. The users stay, as ordinary disabled users.
- **Open tickets.** An open ticket assigned to a created user notifies nobody (F34). The dry run
  counts these (`openTicketsOwnedByCreatedUsers`), and the runbook reassigns them before the
  switch.

**Requesters as contacts** ("Create missing requester contacts"):

- **Who.** Only the requester of a ticket the import actually writes; never every customer in the
  source. Never a customer without an email. Optionally, only for tickets updated in the source
  since a chosen date.
- **Resolution,** in the ticket's header transaction, under the window's org context, after an
  advisory lock on (org, lower(email)). The lock is the inbound pipeline's own namespace (F36), so
  the import and live mail never create the same person twice.
  1. This import's link for (org, source user key) exists: use its contact.
  2. Exactly one contact in the target org has the email: use it, and write no link (the import
     did not create it).
  3. None: `createContact` with that name and email, `roles: []` (no portal access), and
     destination source `import`. Then write the link: `contact_external_links` with system
     `ticket-import:<sourceId>` and the source user key as external id.
  4. Several: display-only, as today.

  The link dedupes across passes and across tickets in a run; the lock dedupes concurrent writers.
  No column is added to `contacts` (F36 has no source marker): the link is the marker.
- **Side effects:** none. `createContact` emits no event and sends nothing (F36). The import
  never grants portal access; that stays the invite's job.
- **Audit.** No per-contact audit row. The link row records every creation: which org, which
  source, which source person, and when. It is exported with the org and erased with it.
  `contactsCreated` goes in the run report and in the partner-level `ticket_import.run_finished`
  audit row. A per-contact row would be the per-write audit step 1 declined (decision 1 there,
  confirmed), by the thousand. The window summary does not count contacts: it counts rows
  carrying the window id, and contacts carry none.
- **Listing and removal as a set.** The report and `GET …/created-contacts` list the contacts
  linked with this source's system. `POST …/created-contacts/remove`:
  - deletes each one through `deleteContact`, the live delete path (F37), with its live
    `contact.delete` audit row. Removal is a human action on customer data, so it keeps the live
    audit;
  - skips a contact that has gained a portal login, a role or another external link, or was
    edited since it was created, and reports how many it skipped.

  The query behind it is documented for after a source is deleted:
  `contact_external_links WHERE system = 'ticket-import:<sourceId>'`.
- **Tickets that reference a removed contact fall back to display-only. Removal is not refused.**
  `createTicket` stored the contact's name and email as the submitter snapshot (F37). The FK sets
  `requester_contact_id` to NULL on delete and keeps that snapshot, so the ticket ends exactly
  where answer 3 would have put it. Refusing removal while referenced would make the set
  unremovable, because every created contact is referenced by construction.
- **Turn it on before the bulk run.** The requester is not re-applied on resume (§5.9), so tickets
  imported while the option was off stay display-only.

## 6. The Zammad 7.2.2 module

### 6.1 Token and access

- **Dedicated user.** An active Zammad user, for example `breeze-import`, whose role grants
  `ticket.agent` and **`read`** on every group. Its token is created with permission
  `["ticket.agent"]` and an expiry after the cutover (Z11). The token cannot be truly read-only;
  `ticket.agent` can still change users and organizations (Z11). The guidance says so and
  recommends revoking the token after the cutover.
- **Inactive groups are invisible to every token** (Z1). Preflight lists every group (inactive
  ones included, Z18) and flags inactive ones as "tickets here will not be imported". If the token
  user's own group access can be read (`GET /api/v1/users/me`, [docs][z-user-me], unverified in
  7.2.2 source), groups without `read` are flagged too. The runbook says to reactivate those groups
  for the import and deactivate them afterwards.
- **Preflight calls:** groups, organizations, priorities, states (with `expand=true` for the
  state type), and one ticket page to prove read access. Users are counted by paging. Attribute
  definitions are fetched only if the token also has `admin.object` (optional; otherwise attribute
  names are discovered from ticket JSON keys during the dry run). Clock skew comes from the
  response `Date` header.

### 6.2 Reading

| Phase | Request | Cost for §1's case |
|---|---|---|
| scan | `GET /api/v1/tickets?page=N&per_page=100` (Z2); the cursor is the page number and the last id seen | ~175 per pass |
| load | `GET /api/v1/ticket_articles/by_ticket/:id` (Z5) and `GET /api/v1/tags?object=Ticket&o_id=:id` (Z18); for a merged ticket also `GET /api/v1/links?link_object=Ticket&link_object_value=:id` (Z9) | 2 per changed ticket, +1 per merged |
| load, big tickets | when `article_count` > 500 (it counts non-System articles only, so the bound is approximate): `GET /api/v1/tickets/:id?expand=true` for `article_ids`, then `GET /api/v1/ticket_articles/:id` each (Z5) | rare |
| files | `GET /api/v1/ticket_attachment/:ticket/:article/:id`, no `view` (Z6, Z8), with the article's **current** ticket id | 1 per file |
| people | `GET /api/v1/users?page=N&per_page=1000` (Z15), cached per process for 30 min | ~10 per 30 min |
| deletions | `GET /api/v1/tickets/:id` (Z10) | 1 per unseen ticket |

- **The ticket header comes from the list row** (plain attributes, Z2), so an unchanged ticket
  costs no extra request.
- **Changed default: no `GET /tickets/:id?all=true`.** It omits inline attachments (Z5), and it
  evaluates Core Workflow on every call. Its behaviour for a read-only agent is also unverified.
- **Source concurrency** is `TICKET_IMPORT_SOURCE_CONCURRENCY` (default 2). That is a
  conservative choice: Zammad has no API rate limit (Z20) and publishes no client throttling
  guidance. There is backoff on 5xx and 504, and `Retry-After` is honoured.
- **Totals for the bulk pass:** about 175 + 2 × 17,460 + 326 + at most 71,814 ≈ 107k requests.
  At concurrency 2 the source is not the bottleneck (§4.5).

### 6.3 Mapping tables

**States** (by state type, Z12; custom states follow their type):

| Zammad state type | Breeze `finalStatus` | Times | Note (internal) |
|---|---|---|---|
| `new` | `new` (open once assigned, as live) | — | — |
| `open` | `open` | — | — |
| `pending reminder` | `pending` | — | "Pending reminder in Zammad: <pending_time>" |
| `pending action` (seeded `pending close`) | `resolved` | `resolvedAt` = `updated_at` | "Zammad would have closed this at <pending_time>" |
| `closed` | `closed` | `closedAt` = `last_close_at` ?? `close_at` ?? `updated_at` | — |
| `merged` | `closed` | `closedAt` = `updated_at` | merge note (§6.6) |
| `removed` (legacy) | `closed` | `closedAt` = `updated_at` | counted in the report |

- **Breeze has no pending-until time and no auto-close** (F18). The pending time therefore lives
  in a note.
- **`pending close` maps to `resolved`,** not `pending`. In Zammad it means "done; it closes
  unless the customer replies", which is what `resolved` means in Breeze (decision 10).

**Priorities** (Z13): the wizard maps each source priority to `low | normal | high | urgent`. The
defaults are `1 low` → low, `2 normal` → normal, `3 high` → high, and anything custom → normal.

**Articles** (Z14):

| Sender | `internal` | Comment | Author kind |
|---|---|---|---|
| Agent | false | public | staff |
| Agent | true | internal note | staff |
| Customer | false | public | requester |
| Customer | true | internal note | requester |
| System | any | **skipped** by default (#8313 answer 5); option: internal note | staff, name "Zammad (system)" |

- **The author** is `origin_by_id`, else `created_by_id` (Z14), named from the users directory. The
  email is omitted when empty. User 1 is "Zammad (system)".
- **The merge marker** (a `note` from Agent, body `merged`, on a merged ticket, Z9) is skipped.
- **Article type** adds a header line. `email` gets `To:` and `Cc:` lines when they are not
  empty; Breeze has no CC list, and this keeps who was copied. `phone`, `sms`, `chat`, `fax`,
  `telegram`, `whatsapp`, `facebook …` and `twitter …` get `[<type>]`. `note` and `web` get none.

**Ticket header:**

- **Keys:** `sourceId` is the ticket `id`, `sourceNumber` its `number`, and `sourceUrl`
  `<base URL>/#ticket/zoom/<id>` (the UI path; unverified, §11).
- **Times:** `createdAt` and `updatedAt` from the ticket, in UTC.
- **Subject:** `title`, or `(no subject)` when empty.
- **Source:** `create_article_type` (Z19) `email` → `email`, `web` → `portal`, everything else →
  `manual`. No new `ticket_source` value (step-1 F15).
- **Type:** Zammad `type` (Z17) `Incident` → `incident`, `Problem` → `problem`, `Request for
  Change` → `change`. Anything else is omitted, so the live default applies.

### 6.4 People and orgs

- **Organizations.** Each `organization_id` maps through `ticket_import_org_maps`. A NULL or
  unmapped org uses the fallback row. With no fallback the ticket is `skipped`/`no_org`. Every
  target org must be in the window.
- **Groups** map to a category through `ticket_import_category_maps`, or to none (the default).
  Categories are partner-only (F17).
- **Owner.**
  - `owner_id = 1` is unassigned (Z15).
  - Otherwise the owner's email is matched case-insensitively to a user of the partner whose
    `org_id` is null or the ticket's target org, the users import eligibility accepts (F16).
    Deactivated users match too: closed Zammad tickets keep inactive owners (Z15), and import
    eligibility accepts them.
  - No match leaves the ticket unassigned, with an internal note "Owner in Zammad: <name> <email>"
    (step-1 §8). The dry-run report lists the unmatched owners (§5.10).
  - With "Create missing owners as disabled users" on, an unmatched owner with an email becomes a
    disabled user instead (§5.13), named from `firstname lastname` or the login. A user of the
    partner whose `org_id` names another org is not eligible and is never replaced: the ticket
    gets the note.
- **Requester** (`customer_id`):
  - When exactly one contact in the target org has that email (`matchContactByEmail`, F15), the
    requester is `{ contactId }`.
  - Otherwise it is display-only `{ name, email? }`. With the option off, no contact is ever
    created (#8313 answer 3).
  - With "Create missing requester contacts" on, a customer with an email and no match becomes
    `{ createContact }` (§5.13), named from `firstname lastname`. A customer without an email stays
    display-only.
  - A matched contact's portal user will see these tickets and their public comments (F15). That
    is the customer's own history, but the runbook mentions it.
- **Tags** become tags. They are trimmed to 100 characters and capped at 50 (F2); anything cut is
  counted.

### 6.5 Content and ids

- **Description** is the first article that is public and not from System, converted to text.
  Choosing a public one keeps an internal note out of the portal's description. That article is
  not imported again as a comment. When it has files, they ride on one public comment by the same
  author, "Attachments from the original message.", which mirrors inbound email (F8). A ticket with
  no such article has an empty description.
- **Bodies.** `text/html` goes through §5.4 with links, quotes and the image resolver. `text/plain`
  is normalized. An article with `body_rendering_error` (Z19) is imported with a marker and
  counted; its `.eml` is not imported in v1.
- **Inline images.** A body `img` whose `src` is `/api/v1/ticket_attachment/…/{store_id}` or
  `cid:<Content-ID>` (Z6, Z7) becomes `[image: <filename>]`. Its original (no `view`) becomes an
  attachment of that comment, marked `inline`. An external `http(s)` image, often a tracking
  pixel, is dropped. An unmatched `cid:` becomes `[image]`.
- **Files.** Every attachment except `content-alternative` parts (Z7, the `message.html` copy;
  counted as `alternativesIgnored`) is an `ImportedAttachment` with `declaredBytes` from `size`
  (a string, Z8).
- **Id grammar** (§5.2; Zammad ticket, article and store ids are global, Z8):

  | Id | Used for |
  |---|---|
  | `<ticket id>` | ticket key |
  | `article:<article id>` | a source article (`isSourceArticleId`) |
  | `article-files:<article id>` | the description's files comment |
  | `note:<ticket id>:owner:<user id>` | the historic-owner note |
  | `note:<ticket id>:pending:<state id>:<pending_time>` | the pending note |
  | `note:<ticket id>:merged:<survivor id>` | the merge note |
  | `note:<ticket id>:time:<time_unit>` | the time note |
  | `attachment:<store id>` | a file |

  A note's id includes the value it states. A changed value therefore appends a new note, and the
  old one stays as history: comments are append-only.
- **Time accounting** (#8313 constraint; F19). The total from the ticket's `time_unit` (Z16)
  becomes one internal note, "Time accounted in Zammad: <n> <unit>". The unit label is a wizard
  option, default "minutes" (unverified which unit an instance uses). It never becomes a
  `time_entries` row: entries belong to humans and feed invoicing (F19). The note can be turned
  off in the wizard.
- **Custom attributes** (Z17): v1 does not import them. Non-null values are counted by attribute
  name in the report. `tickets.custom_fields` is an intake snapshot, not a home for them (F18).

### 6.6 Merges

- **The merged ticket** is imported closed (§6.3). Its articles already moved to the survivor
  (Z9), so its own import carries its subject, requester, tags, time note and the merge note: "Merged
  into Zammad #<survivor number>." The merge note is always written.
- **The survivor's id** comes from the `parent` link (Z9), which follows chains to the final
  survivor. Every merged ticket therefore links to a ticket that is not itself a duplicate, which
  Breeze's duplicate rules require (F14).
- **The link.** When the survivor is imported in the same Breeze org, the links phase writes
  `merged duplicate_of survivor` in import mode (§5.3) at max(merged `updated_at`, survivor
  `created_at`). A cross-org survivor, or one that is skipped or failed, keeps only the note
  (`link_not_written`).
- **Retrying a link.** A merged ticket's ledger item records `imported_version` only once its link
  is written, or known impossible (§5.3 item 4). A survivor that was skipped or failed therefore
  leaves the merged ticket to be loaded again on the next pass. The resume writes nothing new,
  and the link is tried again.
- **A chain formed between passes.** If the bulk pass linked M0 `duplicate_of` M1 and M1 was
  later merged into S, the delta cannot re-point M0: Breeze refuses a duplicate of a duplicate,
  and v1 has no import-mode unlink. M1 → S is refused (`SOURCE_HAS_DUPLICATES`), and M0's link to
  S is reported as `duplicate_elsewhere`. Both are listed for a technician; the notes name the
  final survivor.
- **A merge between the bulk and delta passes** is already safe (F3): the moved articles' ids are
  imported on the merged ticket, so the survivor's resume skips them. Comments are never folded
  across tickets (#8313 answer 4).

### 6.7 Not imported in v1

Ticket links other than merges (they would cost a links call per ticket), mentions, checklists,
shared drafts, history, SLA and escalation fields (imports carry no SLA, step-1 §4.3), custom
attributes, per-entry time accountings, raw `.eml` files, and tickets in groups the token cannot
read. Each is listed in the run report.

### 6.8 Tests against recorded responses

- **Fixtures.** Recorded JSON for each endpoint in §6.2, shaped like 7.2.2: a plain mail ticket,
  an HTML mail with inline images and a `message.html` part, an agent phone ticket, internal and
  System articles, a pending close, a merged pair and a chain, a ticket without org, a customer
  without email, an oversized and an empty file, a `body_rendering_error`, and a 404/403 probe.
  They are recorded from a disposable 7.2.2 test instance seeded with invented data, never from a
  customer instance.
- **Conversion** is pure, so it is snapshot-tested per fixture. Ids are tested against the
  grammar, and times are tested in UTC.
- **The client** is tested on the SSRF modes, the never-follow-a-response-URL rule, retry and
  backoff, and pagination ending on a short page.

## 7. Cutover runbook

For §1's case. Times are indicative and use §4.5.

**A week before**

1. **Breeze.**
   - Object storage is configured, or the import refuses to start.
   - `APP_ENCRYPTION_KEY_ID` is set, so the token is row-bound (F20).
   - The 17 customer orgs exist.
   - Current agents exist as users with their Zammad emails. Former agents need nothing: this
     cutover turns on "Create missing owners as disabled users".
   - Categories exist if groups will map to them.
   - Existing contacts are imported first (the contact import on the Organizations page), so the
     import links to them instead of creating duplicates. This cutover turns on "Create missing
     requester contacts" for the rest.
2. **Zammad.** Create the `breeze-import` agent with `read` on every group (§6.1). Temporarily
   reactivate inactive groups, and write down which, for afterwards. Create its token with
   `["ticket.agent"]` and an expiry about two weeks after the cutover.
3. **Breeze `/tickets/import`.** Connect (this creates the import principal; you own it), run
   preflight and set the mappings. Turn **both** people options on (§5.13). Run a dry run and read
   the report:
   - `skipped_no_org`;
   - `predicted.ownersToCreate`, the agents that will become disabled users, and
     `owner_not_created` (an email that cannot be used);
   - `predicted.openTicketsOwnedByCreatedUsers`, to reassign after the bulk run;
   - `predicted.contactsToCreate`, per org. If it is far above the number of real customers,
     use the "updated since" filter or turn the option off;
   - requesters left display-only (several contacts share the email, or there is no email);
   - predicted oversized files;
   - custom attributes;
   - invalid tickets.

   Fix and repeat until the report is what you expect. Compare the dry run's ticket count with
   Zammad's own: a gap means tickets the token cannot see (Z1).

**Bulk, three days before**

4. Open a migration window over the mapped orgs. Make it end two days after the cutover; it covers
   both passes and stays well inside 14 days. Set `writesPerHour` to 20,000.
5. Start the bulk run. Expect about 8.5 h at 20,000/h. Zammad stays live meanwhile.
6. Read the report. Fix the causes of `failed` items, then start another run, which retries only
   what failed or changed. Check "users created" and "contacts created". Reassign open tickets
   owned by created users. If the contact set is wrong, remove it as a set and run again with the
   option changed. Spot-check tickets in Breeze. Imported tickets are already visible to
   technicians, and to matched contacts in the portal. Nothing notifies anyone (step-1 §4.5).

**Cutover day**

7. **Freeze Zammad.**
   - Stop its email channels and tell agents to stop working there.
   - Keep the API reachable for `breeze-import`.
   - Whether maintenance mode blocks API tokens is unverified, so do not rely on it.
8. **Delta run on the same source** (same principal, same window).
   - It lists about 175 pages and loads only tickets whose `updated_at` moved.
   - It appends new comments and files, converges header fields, and applies the status unless a
     Breeze change owns it.
   - It reports deletions and hidden tickets.

   Expect minutes for a day's changes.
9. **Read the delta report.** Handle by hand, in this order:
   - `comments_changed` (a flipped internal flag first);
   - `requester_changed`;
   - `status_kept`;
   - `deleted_in_source`.
10. **Switch.** Point mail to Breeze's inbound mailbox. Close the migration window: each org gets
    its `migration.window_closed`, now with attachment counts.

**After**

11. Revoke the source in Breeze (or keep it for a later re-import, #8313 answer 1). Revoke the
    Zammad token. Deactivate the groups reactivated in step 2. Keep Zammad read-only for as long as
    you need it as a reference.

## 8. Waves

Each wave is one PR against `main`, usable and testable on its own. "Cutover" marks what §7 needs.

| Wave | Contents | Tests | Cutover |
|---|---|---|---|
| W0: writer follow-ups | §5.3 items 2, 3 and 5: the requester email optional, the resume report fields, the #8884 findings. | Unit: each finding as listed (byte bound through the transaction count, first-import `statusSkipped`, the `writtenByImport` kind case, the unified reason code, the charged racing status). Integration: each report field on a real resume (requester changed, comment changed or flipped internal, comment missing, org changed). | yes |
| W1: attachments (step 2) | §4: the two migrations, the export classifications, `ImportedComment.attachments`, `importAttachments.ts` (reserve, skip-delete), the import claim in `addTicketComment`, the byte bucket, the S3 refusal, `attachmentsImported` in the summary and event, webhook docs, the shared `TicketAttachmentMeta.contentType` widened to `string`. | **Unit:** sniff to stored type; skip reasons and the note; provisional metadata never served; the side-effect scan over `importAttachments.ts`. **Integration, as `breeze_app`:** a round trip writes attached rows with no outbox, audit or event; resume skips an attached file and reuses a pending one; a crash after the put leaves a pending row that a later pass attaches and the reaper would otherwise delete; a declared-oversize file is never reserved; a transient file failure fails the ticket and keeps its pending row, and the next run attaches the file; a live comment cannot claim an import reservation and the reverse; a refusal with no S3; another org's ticket refused by RLS. **Contract:** tenant export, `eventBus.types`. | yes |
| W2: links in import mode | §5.3 item 4: `ticket_links.migration_window_id`, `addTicketLink(…, mode)`, `importTicketLink`. | Live behaviour unchanged (existing suites). Import: no event or audit, feed rows at `mode.at`, the window org check, `ALREADY_LINKED` idempotent, each known-impossible refusal mapped to `link_not_written`, `duplicate_elsewhere` on a chain formed between passes. Side-effect scan extended. Tenant export. | no (merged tickets fall back to the note) |
| W3: HTML to text | §5.4. | The defaults are byte-identical on the existing inbound fixtures. Links, `javascript:` dropped, nested quotes, image resolver, 200k clamp with marker, surrogate pair at the cut, the pathological-nesting time bound. | yes |
| W4: framework | §5.1, §5.2, §5.5–§5.10: tables and RLS, every registration, the credential writer, the SSRF client, the routes, the worker with slices and the lease, the ledger and the report, the `ticket-imports` reserved namespace, a fake module for tests, env vars (`.env.example`, `docker-compose.yml`, `internalEnvVars.ts`), locale strings. | **Routes:** owner-only create and edit, any-admin revoke, delete and cancel, no ciphertext returned, mappings locked while running, the run's window checks, S3 refusal. **Credentials:** round trip, foreign row id fails. **Lease (real Redis, `vitest.integration.config.ts`):** cap per partner and global, renew keeps both keys alive past several lease lengths, expiry after a simulated crash, release. **Worker with the fake module:** a slice continues itself; a retried slice whose successor already ran exits on `slice_seq`; a crash mid-page resumes from the ledger; a closed window stops the run; a 429 defers without spending an attempt; deletions probe. **RLS:** cross-partner forge 42501 on every table. **Contract:** `rls-coverage`, org cascade, org merge, tenant export, `orgLifecycleFoundations`, `workerRegistry`, entrypoint closure, readiness coverage, `partner-wide-write-coverage`, `mcpCoverage`, encrypted-column registry and AI-output masking. | yes |
| W4b: created people | §5.3 item 6 and §5.13: the two variants in the writer, `importPeople.ts`, `ticket_import_user_links`, the created-people routes and the contact removal, the two options and the "updated since" filter, the dry-run predictions. | **Integration, as `breeze_app`:** a created owner is disabled, has no membership, no password, no role; it cannot log in, reset or refresh (the F33 paths); it is absent from `GET /users` and the default-assignee list; a later invite of its email resurrects it with the same id and the ticket still assigned. Another tenant's email leaves the ticket unassigned with the note, and no row. A contact is created once per (org, email) across two tickets and two passes; an existing single match is reused without a link; several matches stay display-only; no email, no contact. Removal falls tickets back to the snapshot and skips an edited contact. No outbox row, no event, no mail; the side-effect scan covers `importPeople.ts`. Both options off: nothing is created. **Contract:** `rls-coverage` (the new table), `partner-wide-write-coverage`. | yes |
| W5: Zammad module | §6, with the §6.8 fixtures. | §6.8, plus an end-to-end dry run and import of the fixture set through W4's worker against a fake Zammad HTTP server. | yes |
| W6: wizard | §5.11: the page, the steps, polling, the step-up window open, the Imported chip and filter, the windows list. | Component tests per step; `no-silent-mutations`; a Playwright flow against the fake Zammad server (`data-testid` only). | yes |

Order: W0 → W1 → W4 → W4b → W5 → W6. W2 and W3 can land any time after W0, and W5 needs W3. The
cutover needs every wave but W2, and W4b because it turns both options on. Without W2, merged tickets get only their note.

## 9. Decisions to confirm in review

Decisions 24 and 25 revisit #8313 answer 3. Please read them first.

1. **Attachment types and risk.** Any type is accepted; outside JPEG/PNG/WebP/PDF a file is
   stored as `application/octet-stream` and served download-only. The cap is 10 MiB; larger files
   are skipped and listed. There is **no malware scanning**: an imported executable reaches a
   technician who opens it. Alternatives: the live allowlist only (most Zammad files would be
   dropped), or a denylist of executable extensions on top.
2. **Reserve before storing** (§4.3), so the existing reaper cleans up after a crash. The
   alternative is the inbound precedent, which leaves unreferenced objects that org erasure cannot
   find.
3. **Buffered downloads bounded at 10 MiB,** not streaming (F10). Alternative: raise the cap,
   which needs the CHECK changed and a streaming put on the ticket path.
4. **Inline images** become attachments of their comment, with a `[image: <name>]` placeholder,
   downloaded as originals. External images are dropped.
5. **One HTML converter, parametrized** (links as `text <url>`, 200k, quotes prefixed).
   Alternative: a second, import-only converter.
6. **Groups map to categories, default none.** Categories are partner-only.
7. **Orgs:** an explicit map plus one optional fallback. A ticket with no target org is skipped and
   listed.
8. **Owners matched by email** to the partner's users (deactivated included). Otherwise the ticket
   is unassigned with a note, unless decision 24's option is on.
9. **Requesters:** a contact only when exactly one matches in the target org; otherwise
   display-only, unless decision 25's option is on. The display email becomes optional. Matched contacts see their imported tickets
   in the portal.
10. **The mapping tables of §6.3.** One choice to confirm: `pending close` maps to `resolved`
    rather than `pending`. Also: System articles are skipped by default, and Customer articles
    marked internal stay internal.
11. **Merges:** closed, linked `duplicate_of` the final survivor in import mode when it is in the
    same org, and a note always. A chain formed between passes is reported, not re-linked.
12. **Delta without Elasticsearch:** the id-ordered list plus a per-source ledger. A changed
    ticket is re-read with `by_ticket` plus tags, not `GET /tickets/:id?all=true`, because
    `all=true` omits inline attachments and runs Core Workflow (Z5).
13. **Deletions in the source** are reported, never applied: 404 means deleted, 403 means hidden.
14. **Report-only in v1:** edited, flipped or deleted comments, requester changes and org changes
    between passes. Alternative: import-mode comment update and requester re-apply under the
    Breeze-wins rule.
15. **Time accounting** becomes one internal note per ticket, opt-out. It never becomes time
    entries.
16. **Tags** become tags. Custom attributes are not imported; they are counted by name.
17. **Concurrency:** a renewable per-partner ZSET lease plus a global cap, with 5-minute
    self-continuing slices.
18. **Credentials:** a partner-axis source table with row-bound encryption. Revoke clears the
    credential and keeps the source; it is not a hard delete, because resume is per principal and
    a recreated source would duplicate every ticket. Delete is a separate action.
19. **SSRF:** `strict-https` when hosted, `on-prem-http` only with an explicit self-host, and no
    URL ever taken from a response.
20. **Principal and windows:** one keyless principal per source, created by the wizard through
    the existing route, so the admin owns it. Windows are opened by the owner in the wizard, and
    the worker never opens one.
21. **Throughput:** one unit per file on the window bucket, plus a sibling per-window byte
    bucket (default 2 GiB/h).
22. **The page lives at `/tickets/import`,** not in settings: an import is an action.
23. **`attachmentsImported`** is added to the window summary and to the `migration.window_closed`
    payload. The change is additive.
24. **Revisit #8313 answer 3 for owners: create missing owners as disabled users (opt-in).**
    Answer 3 reads, verbatim: "**Historic authors:** display-only "originally by" name + email on
    the comment. No shadow users or contacts; auto-creating contacts from five years of history is
    how a desk ends up with 4,000 dead contacts." Step 1 (§8) applied it to owners as "unassigned
    with a note".
    - **The proposal.** A source option, off by default, creates each unmatched ticket owner with
      an email as a disabled, password-less, membership-less user. That is the shape Breeze already
      gives a removed member. It cannot sign in, appears in no picker and receives no
      notification (F33, F34).
    - **Why.** In an import-only cutover Breeze becomes the single source of truth. The history
      should stay attached to real people: per-agent history and reporting on assigned tickets,
      instead of thousands of unassigned tickets with a note. An admin can later activate a person
      with the normal invite, which keeps their id and their tickets (F35).
    - **Why off by default.** Answer 3 stays the product default, and an MSP opts in per source
      after reading the dry run's count.
    - **Limits.** Only owners of imported tickets, one per email, never a comment author. Never an
      email held by another tenant. Listed as "users created by this import". Deleting the
      source leaves them as ordinary disabled users.
25. **Revisit #8313 answer 3 for requesters: create missing requester contacts (opt-in).**
    - **The proposal.** A source option, off by default, creates a contact for the requester of an
      imported ticket when no contact in the target org has that email. Several matches stay
      display-only, and a customer without an email gets no contact.
    - **Why.** The same single-source-of-truth argument: the requester's history belongs on the
      contact, and so does portal access later, granted by the normal invite. Live inbound email
      already find-or-creates a contact per unknown sender (F36), so an imported requester is
      treated as if their mail had arrived live.
    - **The "4,000 dead contacts" concern, mitigated:**
      - contacts are created only for requesters of tickets actually imported, never for every
        source customer, and optionally only for tickets updated since a date;
      - they are deduped by (org, email) under the inbound lock, and across passes through a
        `contact_external_links` row;
      - the dry run shows the count per org before any run;
      - they are listable and removable as a set. Removal leaves tickets display-only, because
        the snapshot is kept (F37).
    - **No per-contact audit row.** The link row is the record of each creation, and the run's
      audit row carries the count.
    - **Off by default** keeps answer 3 as the product default.

## 10. Corrections to the step-1 spec

Step 1's §8 is binding except for these points. A one-line note in that section points here.

- **The concurrency cap.** §8 names `scriptProposals/reviewConcurrency.ts` as "a Redis per-partner
  slot". It is per org, has a 90-second TTL and no heartbeat (F22). Step 3 uses the renewable
  per-partner lease of §5.8.
- **Who opens windows.** §8 says "each module opens its window through the routes above, on a
  dedicated keyless principal it creates". Opening needs the principal's owner, an interactive
  session and a step-up grant (F27). The wizard does it, as the admin who created the principal,
  and the module never sees a window.
- **Merged tickets.** §8 says the links of #7900 are not on `main`. They are (#8675, F14). Merged
  tickets are linked `duplicate_of` in import mode (§6.6), and the note stays as the fallback.
- **Credentials.** Row-bound AAD takes effect only with `APP_ENCRYPTION_KEY_ID` set (F20).
- **Historic people.** §8's "imported unassigned, with an internal note naming them" stays the
  default. Decision 24 adds an opt-in that creates the owner as a disabled user instead.
- **Naming.** Step 1's `ImportedTicket` sketch calls the status type `TicketCoreStatus`; the code
  uses `IMPORTED_TICKET_FINAL_STATUSES` and `TicketStatus` (`importedTicket.ts:26`).

## 11. Risks

- **Malware in imported files** (§4.1, decision 1).
- **Invisible tickets.** Inactive groups, or groups the token cannot read, hide tickets from every
  call (Z1). Nothing in the API reports them. Preflight flags the groups, the runbook reactivates
  them, and the dry-run count is compared with Zammad's own.
- **Very large tickets.** `by_ticket` is unpaginated (Z5); above 500 articles the module pages
  per article. The converted ticket is held in memory, because `importTicket` takes a whole ticket
  (F2 has no comment ceiling). A ticket whose converted content passes
  `TICKET_IMPORT_MAX_TICKET_BYTES` (default 256 MiB) fails with `ticket_too_large` and is listed.
- **Zammad load.** About 107k requests for the bulk pass. Each one writes the token's
  `last_used_at` (Z11). Concurrency is 2, backoff is honoured, and the bulk runs off-hours.
- **Partial runs** are safe by construction: every write is resumable (F3), a slice crash
  repeats at most one ticket, and the ledger retries failures. Imported tickets are visible in
  Breeze while a run is still going.
- **Clock skew.** Source times ahead of Breeze fail validation (F2). Skew up to 5 min is clamped
  and counted; beyond that the ticket fails visibly. The #8884 ordering note (§5.3) covers the
  database side.
- **Created owners on open tickets** notify nobody, because a disabled user is never a recipient
  (F34). The dry run counts them and the runbook reassigns them.
- **An email taken by another tenant** cannot become a created owner (F32). Its absence tells the
  partner-wide admin running the import that the address is in use elsewhere. The report gives no
  reason, as the invite route does (F35). Each probe costs an owner-opened, step-up window.
- **Contact noise.** Even with the mitigations, a five-year history can create many contacts. The
  dry-run count, the date filter and removal as a set are the controls (§5.13).
- **Owner departure.** Only a principal's owner can open its windows, and ownership cannot be
  transferred (F27). If the admin who connected the source leaves, no new window can be opened on
  that principal, and a new principal would duplicate everything. A principal ownership transfer
  is a #8332 follow-up, out of scope here.
- **Unbound credentials.** Without `APP_ENCRYPTION_KEY_ID`, the token is sealed without AAD
  (F20).
- **Flipped visibility.** A comment made internal in Zammad after the bulk pass stays public in
  Breeze until someone acts on the report (§5.9).
- **Source changes on upgrade.** A later Zammad moves inline images to `inline_attachments` (Z6).
  The module targets 7.2.2, checks the field it reads, and fails loudly rather than dropping
  images.

**Facts not verified** (they live in the module or the runbook, not in Breeze's contracts):

- `GET /api/v1/users/me` in the 7.2.2 source;
- the `#ticket/zoom/<id>` UI path used for `sourceUrl`;
- which unit an instance's `time_unit` uses;
- whether maintenance mode blocks API tokens;
- whether a personal access token also works with `Bearer`;
- the runtime of `all=true` for a read-only agent (no longer used);
- whether any API path reads tickets of inactive groups;
- rate limits of hosted Zammad;
- any per-attachment cap beyond mail size;
- list performance at maximum page sizes.

## 12. Later (out of v1)

Comment update, delete and requester re-apply in import mode (decision 14). Ticket links other than
merges, checklists and custom attributes. Raw `.eml` for unrenderable bodies. A streaming put and a
higher cap. A principal ownership transfer. More modules (Freshdesk, Zendesk, OTRS, Autotask,
ConnectWise, HaloPSA, CSV/JSON), each one new module and no change to `ticketService`.
