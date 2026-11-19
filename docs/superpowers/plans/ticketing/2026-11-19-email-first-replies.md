---
spec_issue: LanternOps/breeze#8758
refs: [LanternOps/breeze#11294, LanternOps/breeze#8759]
spec: docs/superpowers/specs/ticketing/2026-10-14-email-first-ticketing-design.md
base: origin/main @ 4aacc0d479
status: plan-drafted, awaiting Gate B
---

# Email-first ticket replies: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each wave is one PR off a fresh `origin/main`. Read the spec section named in each wave before you start it.

**Goal:** A public technician reply reaches an email-only requester as the reply text, including through a connected Microsoft 365 mailbox. Later waves add one partner-default/org-override setting, a `{{reply_body}}` merge variable, reply attachments, and a shared-queue notice.

**Architecture:** All customer reply mail already leaves through one worker, `apps/api/src/jobs/ticketNotifyWorker.ts` (`collectRequesterEmail` → `sendEmailPayloads`). The Graph lane (`graphReplySender.ts`) gains a recipient replace that fails closed. After that, the comment body is allowed on every lane. Settings live on `partners.settings.ticketing.emailCustomer`, with an org override column on `org_ticket_settings`, read by one resolver in `@breeze/shared`. No new tables.

**Tech stack:** Hono, Drizzle (queries only), hand-written SQL migrations, BullMQ, Microsoft Graph v1.0 mail API, Astro + React islands, Vitest.

**Spec:** `docs/superpowers/specs/ticketing/2026-10-14-email-first-ticketing-design.md` (D1–D3; approved by Todd 2026-11-19). This plan adds two items that came from #11294 and were recorded on #8758 on 2026-11-14: reply attachments, and a reply-body template variable. Discussion #11626 asks for the same outcome as W1.

## Waves

| Wave | Ships | Depends on | Migration | Ships alone as |
|---|---|---|---|---|
| **W1** | Connected M365 mailbox sends the reply text: recipient replace + the `!graphMailbox` gate removed | — | none | Partners with the existing `fullMessageReply` flag get the reply text on the M365 path. No one else sees a change. |
| **W2** | "Email with customers" setting: partner default (Settings → Ticketing → Email) + org override (`OrgTicketSettingsEditor`), `resolveEmailCustomer`, the legacy flag retired | W1 | 2: column + data copy | The toggle is reachable in the UI. |
| **W3** | `{{reply_body}}` merge variable on the Public reply notice template | W1 | none | Partners with a custom template choose where the text goes. |
| **W4** | Reply attachments in the customer email, on all three lanes | W1 | none | Files on a public reply go out with the text. |
| **W5** | Queue notice on create for unassigned tickets (`queueNotifyAddresses`) | W2 | none | Shared mailbox is told about new unassigned tickets from every source. |
| **W6** | `ticket.customer_replied`: a customer reply mails the queue (unassigned) or the assignee | W5 | none (see W6 note) | Portal and email follow-ups reach staff. |

W3 and W4 can run in parallel after W1. W1 is the wave the reporters asked for.

## Global constraints

- Internal notes never reach a customer path. The worker enters customer mail only for `event.payload.isPublic && !event.payload.inbound`. Text goes out only for a live public comment on a live ticket (`!ticket.deletedAt && !comment.deletedAt && comment.isPublic`). Keep that check exactly as it is.
- Graph customer sends: To = `payload.to` only. Cc and Bcc are empty. Reply-To = the connected mailbox. No other address from the original message survives (D3).
- Missing `submitterEmail` means no customer send (already `return []`).
- `replyIncludesComment` off, or absent, means today's portal notice, on every lane.
- New partners are off: `queueNotifyAddresses: []`, `replyIncludesComment: false`.
- Queue notice and `ticket.customer_replied` mail use the platform `EmailService` lane with `purpose: 'ticket.staff_notification'`, and stamp `X-Breeze-Outbound: 1` (`BREEZE_OUTBOUND_HEADER`, `apps/api/src/services/emailDomains/outboundMarker.ts`). `Auto-Submitted` is not the loop signal.
- Import mode stays silent (`IMPORT_SIDE_EFFECTS` writes no outbox row).
- Partner-wide first: the partner default lives on `partners.settings` and the org override on the existing `org_ticket_settings` row. **No new tables.**
- Migrations: hand-written and idempotent, with no inner `BEGIN`/`COMMIT`. Name each one to sort after the newest file on `origin/main` **at implementation time** (the newest is already `2027-01-28-180000-…`; never assume today's date). Any file that writes rows starts with `SELECT set_config('breeze.scope', 'system', true);`. Run `pnpm db:check-drift` afterwards.
- Web: every mutation goes through `runAction`. Every control has a `data-testid`. Every new string is added in all 8 locales (`en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR`). One save pattern per card: the Email with customers card is a form with a page Save, because W5 adds an address list to it.
- Public repo: no customer names, domains or handles in code, tests, fixtures, docs or PR text. Use `support@example.com`.
- PRs and commits say `Refs #8758`, never a closing keyword. Each wave PR carries `Closes #<wave sub-issue>` only after Gate B registers the sub-issues.

## Registration lists (tenancy-rls.md)

| List | Change | Evidence |
|---|---|---|
| `CORE_ORG_CASCADE_DELETE_ORDER` | none: `org_ticket_settings` already listed | `apps/api/src/services/tenantCascade.ts:870` |
| `orgMergeRegistry.ts` | none: `org_ticket_settings: keep-survivor` | `apps/api/src/services/orgMergeRegistry.ts:562`. On an org merge the source org's `email_customer` override is dropped and the survivor's kept. State this in the W2 PR. |
| `CORE_TENANT_EXPORT_POLICY` | **W2: add `email_customer` to `excludedOpen`** (jsonb) | `apps/api/src/services/tenantExportPolicyRegistry.ts:753` |
| Device / ticket id lists | none: no `device_id` or `ticket_id` column added | — |
| RLS | none: the column inherits the existing `org_ticket_settings` policies | — |

`partners.settings` is an existing jsonb column. Adding a key adds no export classification.

## Review focus

1. **A follow-up from a Cc'd colleague.** The newest inbound m365 message (the one `resolveOutboundMailbox` replies to) is from someone other than `submitterEmail`. The reply must go to `submitterEmail` only. Test: W1 Task 1 `replaces createReply recipients with exactly payload.to`.
2. **Graph ignores or partly applies the recipient PATCH.** Never send in that case. Test: W1 Task 1 `deletes the draft and throws when the PATCH response still carries other recipients`.
3. **A custom Public reply notice that says "Sign in to the portal".** With the setting on, the reply text must still appear. Test: W1 Task 2 `custom template still carries the reply text before the CTA`.
4. **A reply whose attachments exceed the email budget,** or an attachment whose artifact has expired. The mail must still send with the text, and list what was left out. Test: W4 Task 2 `over-budget and expired attachments are listed by name, not attached`.
5. **A queue address that is also the connected mailbox,** with the ticket ingested from that mailbox. No second copy to that address, and no new ticket from the notice. Tests: W5 Task 2 `skips the connected mailbox when the event was ingested from it`, and W5 Task 3 `ingest drops a queue notice`.

---

## W1: connected M365 mailbox sends the reply text

Spec D3. **Gate in W1 is the existing legacy flag** `partners.settings.ticketing.inbound.fullMessageReply` (API-only today). This keeps W1 free of migrations, and it is the flag the reporting deployment already set. W2 moves the gate onto the new setting. See open question 1.

### Task 1: Graph recipient replace, failing closed

**Files:**
- Modify: `apps/api/src/services/ticketMailbox/graphReplySender.ts`
- Test: `apps/api/src/services/ticketMailbox/graphReplySender.test.ts`

**Interfaces:**
- Produces: `sendThreadedReply(t: GraphSendTarget, originalMessageId: string, html: string, opts: ThreadedReplyOptions): Promise<void>`. `ThreadedReplyOptions` gains a required `to: string`. Optional `subject?: string` is unchanged.
- Produces: `sendNewMail(t, to, subject, html)` keeps its signature and now also sets `replyTo: [{ emailAddress: { address: t.mailbox } }]`.

**Decision:** the replace applies to **every** Graph customer send (comment notice, resolved notice and autoresponse), each with its own `payload.to`. All three go through `sendThreadedReply`, and an unvalidated recipient set is wrong for all of them. For the comment and resolved notices `payload.to` is `ticket.submitterEmail`. For the autoresponse it is `event.payload.to`.

- [ ] **Step 1: Write failing tests** (fetch mocked as in the existing file):
  - `replaces createReply recipients with exactly payload.to`: the PATCH body has `toRecipients: [{emailAddress:{address:'requester@example.com'}}]`, `ccRecipients: []`, `bccRecipients: []`, and `replyTo: [{emailAddress:{address:'support@example.com'}}]`, plus `body`.
  - `deletes the draft and throws when the PATCH response still carries other recipients`: the PATCH response has `ccRecipients:[{…'colleague@example.com'}]`. Expect `DELETE …/messages/<draftId>` to be called, `/send` never to be called, and the call to reject with `/recipient/`.
  - `deletes the draft when send fails`: `/send` returns 500. Expect a best-effort DELETE of the draft, and the original error rethrown.
  - `sendNewMail sets replyTo to the mailbox`.
- [ ] **Step 2: Run and see them fail.** `cd apps/api && pnpm vitest run src/services/ticketMailbox/graphReplySender.test.ts`
- [ ] **Step 3: Implement.** The PATCH sends recipients and body in one request. Read the PATCH response JSON (`{ toRecipients, ccRecipients, bccRecipients }`). Compare the lower-cased addresses: To must be exactly `[to]`, and Cc and Bcc empty. Otherwise throw `GraphRecipientMismatchError`. Wrap everything after `createReply` in try/catch: on any error, `DELETE` the draft (swallowing its own error), then rethrow.
- [ ] **Step 4: Run and see them pass.**
- [ ] **Step 5: Update the caller.** In `ticketNotifyWorker.ts` `sendEmailPayloads`, both `sendThreadedReply` calls pass `{ to: payload.to, …(threadedReplyUsesSubject ? { subject } : {}) }`. Run `src/jobs/ticketNotifyWorker.graphFork.test.ts`. Update its expectations to the new options object. Do not delete assertions.
- [ ] **Step 6: Commit.** `feat(ticketing): pin Graph reply recipients to the requester, fail closed (Refs #8758)`

### Task 2: reply text on every lane, with-reply default copy

**Files:**
- Modify: `apps/api/src/jobs/ticketNotifyWorker.ts` (`composeLaidOutRequesterMail`, `collectRequesterEmail` lines ~526–640; delete `appendFullReplyBody` ~753)
- Modify: `packages/shared/src/utils/emailTemplates.ts` (`EMAIL_TEMPLATE_VARIANTS`, `VARIANT_DEFAULTS`)
- Test: `apps/api/src/jobs/ticketNotifyWorker.leak.test.ts`, `apps/api/src/jobs/ticketNotifyWorker.graphFork.test.ts`, `apps/api/src/services/emailTemplates/renderPartnerEmail.test.ts`

**Interfaces:**
- Produces: variant `ticket_comment_notification:with_reply`. Its defaults are heading `New reply on your ticket` and html `<p>{{cta_button}}</p>\n<p>Reply to this email to answer.</p>` (no "Sign in to the portal", no `email_only_hint`). Subject and button are inherited.
- Produces: `replyBodyHtml(content: string): string`, exported from `ticketNotifyWorker.ts` or a small sibling `ticketReplyBody.ts`. It escapes the text, turns newlines into `<br>`, and wraps it in the quoted block markup moved from `appendFullReplyBody`.
- Produces: `composeLaidOutRequesterMail(ticket, id, opts?: { replyHtml?: string })`. When `replyHtml` is set it renders with `variant: 'with_reply'` and `bodyBeforeCta: replyHtml`.

- [ ] **Step 1: Write failing tests.**
  - leak test `appends a live public comment body on the connected-mailbox path`: `resolveOutboundMailbox` is mocked to return a mailbox, `fullMessageReply: true`. The payload html contains the escaped comment, and `graphMailbox` is set.
  - leak test `flag off + connected mailbox keeps the portal notice` (html contains `Sign in to the portal`, not the comment).
  - The existing deleted, private and pre-commit-retry tests run on **both** lanes (`it.each(['platform','graph'])`).
  - renderPartnerEmail test `with_reply variant drops the sign-in copy and places bodyBeforeCta before the CTA`.
  - renderPartnerEmail test `custom template still carries the reply text before the CTA` (custom html `<p>Sign in to the portal</p>{{cta_button}}`, `bodyBeforeCta` present).
- [ ] **Step 2: Run and see them fail.** `cd apps/api && pnpm vitest run src/jobs/ticketNotifyWorker.leak.test.ts src/services/emailTemplates/renderPartnerEmail.test.ts`
- [ ] **Step 3: Implement.** Load the comment first (the same select and the same retry-on-missing). Then compose: when `fullMessageReply` is on and the comment passes the live/public check, pass `replyHtml`. Remove `&& !graphMailbox`. Rewrite the long comment above the gate to describe the recipient replace. Update the `ticket.commented` case comment (~968) and the `fullMessageReply` caveat in `packages/shared/src/validators/partnerTicketingSettings.ts:47-61`.
- [ ] **Step 4: Run the tests and see them pass,** plus `src/jobs/ticketNotifyWorker.test.ts` and the graphFork test.
- [ ] **Step 5: Typecheck.** `pnpm --filter @breeze/api exec tsc --noEmit -p .`. Check the exit code; do not pipe to `tail`. Give it a 12 GB heap: `NODE_OPTIONS=--max-old-space-size=12288`.
- [ ] **Step 6: Update the docs.** `apps/docs` ticketing page: the reply-text option now works with a connected Microsoft 365 mailbox. Commit with `feat(ticketing): send the public reply text through a connected M365 mailbox (Refs #8758)`.

**W1 PR:** label `category:ticketing`. Body: behaviour change only for partners with `fullMessageReply: true` and a connected mailbox. Recipient replace for all Graph customer mail.

---

## W2: "Email with customers" setting, partner default and org override

Spec D1. Rule 9 block for the PR: **Home** is Settings → Ticketing → Email (`EmailCustomerCard`) at partner level, plus `OrgTicketSettingsEditor` for the org. **Level** is partner default → org override, per field. **Resolver** is `resolveEmailCustomer`. **Places configured** go from 0 in the UI (the API-only legacy flag) to 2. The removal plan is the legacy copy migration plus deleting every `fullMessageReply` reader and writer.

### Task 1: shared schema and resolver

**Files:**
- Create: `packages/shared/src/validators/emailCustomerSettings.ts` (+ `.test.ts`), exported from the validators barrel
- Modify: `packages/shared/src/validators/ticketConfig.ts` (`orgTicketSettingsSchema` gains `emailCustomer`)

**Interfaces:**
- Produces: `emailCustomerSettingsSchema = z.object({ queueNotifyAddresses: z.array(z.string().trim().toLowerCase().email()).max(10).optional(), replyIncludesComment: z.boolean().optional() }).strict()`. W2 ships both keys: the address list is stored but unread until W5. Max 10 addresses (proposal; open question 3).
- Produces: `type EmailCustomerSettings = z.infer<…>` and `type ResolvedEmailCustomer = { queueNotifyAddresses: string[]; replyIncludesComment: boolean; source: { queueNotifyAddresses: 'org'|'partner'|'default'; replyIncludesComment: 'org'|'partner'|'default' } }`.
- Produces: `resolveEmailCustomer(partner: unknown, org: unknown): ResolvedEmailCustomer`, with tolerant reads (malformed input means default). A field the org sets wins. An org `queueNotifyAddresses: []` is set, meaning "off for this org", and is not inherit.
- `orgTicketSettingsSchema.emailCustomer: emailCustomerSettingsSchema.nullable().optional()`. `null` clears the override. The existing `refine` (at least one field) still passes with only `emailCustomer`.

- [ ] Steps: failing tests `org field wins`, `omitted org field inherits`, `org [] is off, not inherit`, `defaults are [] / false with source default`, `malformed partner settings resolve to defaults`. Run `pnpm --filter @breeze/shared test` (the `test-shared` CI job). Implement, see them pass, commit.

### Task 2: migrations (column + legacy copy)

**Files:**
- Create: `apps/api/migrations/<after-newest>-org-ticket-settings-email-customer.sql`: `ALTER TABLE org_ticket_settings ADD COLUMN IF NOT EXISTS email_customer jsonb;` (nullable, no default)
- Create: `apps/api/migrations/<after-previous>-email-customer-legacy-copy.sql`
- Modify: `apps/api/src/db/schema/ticketConfig.ts` (`emailCustomer: jsonb('email_customer').$type<EmailCustomerSettings | null>()`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:753` (add `email_customer` to `excludedOpen`)

The data copy starts with `SELECT set_config('breeze.scope', 'system', true);`. Then, for each partner where `settings #> '{ticketing,inbound,fullMessageReply}' = 'true'` and `settings #> '{ticketing,emailCustomer,replyIncludesComment}' IS NULL`, it builds the parent explicitly: `jsonb_set` does not create a missing `emailCustomer` object. Use `jsonb_set(settings, '{ticketing,emailCustomer}', COALESCE(settings #> '{ticketing,emailCustomer}', '{}'::jsonb) || '{"replyIncludesComment": true}')`. It leaves `inbound.fullMessageReply` in place, unread, and does not touch a partner who already set the new field. Idempotent by construction.

- [ ] Steps: a failing integration test `apps/api/src/__tests__/integration/emailCustomerLegacyCopy.integration.test.ts`. Cases: a partner with the flag ends with `replyIncludesComment: true`; a partner with `replyIncludesComment: false` is untouched; a partner with no `ticketing` key is untouched; running it twice gives the same result. The export-policy contract test fails until the registry line lands. Then write the migrations, run `pnpm db:migrate && pnpm db:check-drift`, and run `apps/api/src/db/migrationRlsScope.test.ts`. Commit.

### Task 3: API write and read paths, worker on the resolver

**Files:**
- Modify: `apps/api/src/routes/orgs.ts:1043` (`ticketing: z.object({ inbound: …, emailCustomer: emailCustomerSettingsSchema.optional() })`). Confirm the PATCH handler's one-level `ticketing` merge keeps `emailCustomer` when the Inbound card saves `inbound`, and add the test `inbound save preserves emailCustomer`.
- Modify: `apps/api/src/routes/orgTicketSettings.ts` (persist and return `emailCustomer`, plus the resolved view with its sources for the inherit control)
- Modify: `apps/api/src/services/ticketConfigService.ts:437` (**remove** `fullMessageReply`; add `emailCustomer` and the partner's resolved values)
- Modify: `apps/api/src/jobs/ticketNotifyWorker.ts` (`loadPartnerMailBits` returns raw `settings.ticketing.emailCustomer`; load the org's `org_ticket_settings.email_customer`; gate on `resolveEmailCustomer(...).replyIncludesComment`; delete the `fullMessageReply` type field and every read)
- Modify: `packages/shared/src/validators/partnerTicketingSettings.ts:61`. `ticketingInboundSettingsSchema` is non-strict (unknown keys are stripped), so **delete** `fullMessageReply`. An old client that sends it is stripped silently, not rejected.

- [ ] Steps: failing tests. `org override off beats partner on` (worker leak test). `after migration a stored inbound.fullMessageReply:true is not read`, where the partner has the legacy flag and `emailCustomer.replyIncludesComment:false`, so the portal notice is sent. Route tests for `PATCH /partners/me` and the org ticket-settings PATCH round-trip. Then `rg -n fullMessageReply apps packages -g '!*.test.*'` returns only the migration file. Commit.

### Task 4: web, partner card and org override

**Files:**
- Create: `apps/web/src/components/settings/EmailCustomerCard.tsx` (+ test), mounted in `TicketingSettingsTabs.tsx` email panel above `InboundEmailCard`, gated on `canManagePartnerTicketing`
- Modify: `apps/web/src/components/settings/OrgTicketSettingsEditor.tsx` (an "Email with customers" section with a three-state control: Inherit (shows the partner value and "from partner"), On, Off)
- Modify: `apps/web/src/components/settings/inboundEmailConfig.ts:30,89` (**remove** `fullMessageReply`, so the card stops rewriting the old key)
- Modify: the en + 7 locale files

W2 shows only the reply toggle. The address list arrives in W5 on the same card. Save goes through `runAction` with a page Save button. Test ids: `email-customer-card`, `email-customer-reply-includes-comment`, `email-customer-save`, `org-email-customer-reply-mode`.

- [ ] Steps: failing component tests (`saves emailCustomer.replyIncludesComment via PATCH /partners/me`, `org editor shows the inherited partner value`, and `inbound card save body has no fullMessageReply`). Implement. Run `pnpm --filter @breeze/web test -- src/components/settings`. `no-silent-mutations.test.ts` and `keyUsage.test.ts` must stay green. Commit.

**W2 PR:** must pass **Integration Tests** (export-policy and cascade suites run only there). Carry the Rule 9 block and the keep-survivor note.

---

## W3: `{{reply_body}}` merge variable

**Files:**
- Modify: `packages/shared/src/utils/emailTemplates.ts`: add `'reply_body'` to `EmailTemplateVarKey`, and add it **only** to `ticket_comment_notification`'s var list. Do not add it to `COMMENT_NOTIFICATION_VARS`, which `ticket_resolved` and `ticket_merged` spread. Make it a new constant `[...COMMENT_NOTIFICATION_VARS, 'reply_body']`. Change the `with_reply` variant default html to `{{reply_body}}\n<p>{{cta_button}}</p>\n<p>Reply to this email to answer.</p>`.
- Modify: `apps/api/src/services/emailTemplates/renderPartnerEmail.ts`: a `replyBodyHtml?: string` arg handled with a sentinel, like `cta_button`. `catalogVars` skips `reply_body`. In the body only, the token is swapped for a sentinel before sanitize and the sentinel for `replyBodyHtml` after. The sentinel is stripped from attribute values (reuse `stripSentinelFromAttributes`). The **subject and heading render `{{reply_body}}` as empty**. When the template has no token and `replyBodyHtml` is set, splice it before the CTA, as W1 does.
- Modify: `apps/api/src/jobs/ticketNotifyWorker.ts`: pass `replyBodyHtml` instead of `bodyBeforeCta`.
- Modify: the web template editor variable chips, if they read `varsForEmailTemplate` (verify; if so, no change needed), and the `apps/docs` email-templates page.

Gating: `reply_body` is empty unless the resolved setting is on **and** the comment passes the live/public check. A partner who places the token with the setting off gets nothing there.

- [ ] Steps: failing tests in `renderPartnerEmail.test.ts`. `places reply_body where the token sits`. `reply_body in an href renders empty`. `reply_body in the subject renders empty`. `no token + replyBodyHtml appends before CTA`. `$& in reply text stays literal` (use a function replacer). `ticket_resolved does not substitute reply_body`. Plus a leak test: `setting off + token in custom template → no comment text`. Implement, run, commit.

---

## W4: reply attachments

**Facts checked:** Graph adds an attachment to a draft with `POST /users/{mailbox}/messages/{draftId}/attachments` (a `#microsoft.graph.fileAttachment` with base64 `contentBytes`) for files **under 3 MB**. For 3–150 MB it uses `POST …/attachments/createUploadSession`, then ranged PUTs ([attachment resource](https://learn.microsoft.com/en-us/graph/api/resources/attachment?view=graph-rest-1.0), [large attachments](https://learn.microsoft.com/en-us/graph/outlook-large-attachments)). Re-check both pages at implementation time. Ticket attachments are capped at 10 MB each and 5 per comment (`packages/shared/src/constants/ticketAttachments.ts`), so the worst case is 50 MB. `SendEmailBase.attachments` exists (`apps/api/src/services/email.ts:81`), and `PartnerLaneMessage = RawEmailMessage` (`emailDomains/provider.ts:121`) carries it type-wise. **Verify** that the `ticket.customer_notification` branch of `EmailService.sendEmail` forwards `attachments` into `sendOnPartnerLane`, and fix it in this wave if not.

**Decision (proposal, open question 4):** attach real files, never links (the spec rules out customer-portal downloads). The total budget is `REPLY_ATTACHMENT_BUDGET_BYTES = 15 * 1024 * 1024`. Files are taken in `createdAt` order until the next one would exceed the budget. Anything left over, or anything that throws `AttachmentExpiredError`, is listed by filename under the reply: "Not attached: <names>. Reply to this email if you need them." Only when the resolved `replyIncludesComment` is on.

### Task 1: Graph draft attachments

**Files:** `apps/api/src/services/ticketMailbox/graphReplySender.ts` (+ test)

**Interfaces:** `ThreadedReplyOptions.attachments?: Array<{ filename: string; contentType: string; content: Buffer }>`. They are uploaded after the recipient PATCH check and before `/send`. Under 3 MB, a direct POST. Otherwise an upload session, with slices of 320 KiB × 10 (a multiple of 320 KiB). Any failure falls into the existing delete-draft path. `sendNewMail` gains the same optional parameter: for the no-inbound fallback, switch to create-draft → attach → send when attachments are present.

- [ ] Steps: failing tests `small file posts fileAttachment`, `4 MB file uses an upload session`, `attachment failure deletes the draft and never sends`. Implement, run, commit.

### Task 2: worker loads and budgets comment attachments

**Files:** `apps/api/src/jobs/ticketNotifyWorker.ts` (or a new `apps/api/src/jobs/ticketReplyAttachments.ts`, to keep the worker under control), `EmailPayloadBase.attachments`

**Interfaces:** `loadReplyAttachments(ticket: TicketRow, commentId: string): Promise<{ attached: EmailAttachment[]; omitted: string[] }>`. It selects `ticket_attachments` where `commentId = $1 AND ticketId = ticket.id`, reads `openBytes(row, { orgId: ticket.orgId })`, and buffers each stream. It runs inside the worker's existing system DB context.

- [ ] Steps: failing tests. `public reply with two PDFs attaches both on graph and platform lanes`. `over-budget and expired attachments are listed by name, not attached`. `private comment loads no attachments` (the leak test: `ticket_attachments` is never queried). `setting off loads no attachments`. Implement. `omitted` goes into the reply block HTML as escaped filenames. Run the leak, graphFork and worker tests. Commit.

---

## W5: queue notice on create

Spec D2 "Create". Resolves `queueNotifyAddresses` through `resolveEmailCustomer` (W2).

### Task 1: address list on the card and the org editor

**Files:** `EmailCustomerCard.tsx`, `OrgTicketSettingsEditor.tsx`, locales. The address list editor uses the same page Save. Test ids are `email-customer-queue-addresses` and `org-email-customer-queue-addresses`. The org control is Inherit / Custom list / Off (`[]`).

Validation (proposal, open question 2): any syntactically valid address, max 10, lower-cased and de-duplicated by the schema. The card shows a hint when an address is the connected mailbox. No verification email in this wave.

- [ ] Steps: failing component tests. Implement. Run the tests. Commit.

### Task 2: publisher branch and worker case

**Files:**
- Modify: `apps/api/src/jobs/ticketOutboxPublisher.ts` (next to `assigneeNotificationFromOutboxRow`, line 217)
- Modify: `apps/api/src/services/ticketEvents.ts` (new event `{ type: 'ticket.queue_notice'; payload: { trigger: 'created' | 'customer_replied'; source: CreatedTicketSource; ingestedFromMailbox: string | null } }`)
- Modify: `apps/api/src/jobs/ticketNotifyWorker.ts` (`collectQueueNotice`)
- Test: `ticketOutboxPublisher.test.ts`, `ticketNotifyWorker.test.ts`, `ticketEventsContract.test.ts`

**Interfaces:** `queueNoticeFromOutboxRow(row): TicketEventInput | null` returns an event for `ticket.created` with no `assigneeId`. The worker resolves the addresses itself: an empty list means no send, so the publisher stays settings-free. `ingestedFromMailbox` is the connected mailbox address when the ticket was created from an m365 or gmail ingest. Find where the creating inbound row records its mailbox, and add it to the outbox payload in the ingest path.

The notice is a hardcoded staff layout (not partner-editable; open question 5). It holds the ticket number, subject, org name, requester name and email, source, and a staff link (`/tickets/<id>` on the app URL). Use platform `EmailService`, `purpose: 'ticket.staff_notification'`, with headers `{ [BREEZE_OUTBOUND_HEADER]: '1' }`. Send one message per address, `bestEffort: true`.

- [ ] Steps: failing tests. `unassigned portal create enqueues one queue notice`. `assigned create enqueues none`. `skips the connected mailbox when the event was ingested from it` (a second address still receives one). `empty resolved list sends nothing`. `import mode writes no outbox row, so no notice`. `notice carries X-Breeze-Outbound: 1`. Implement. Run the tests plus the outbox publisher tests. Commit.

### Task 3: loop proof

- [ ] Test in `apps/api/src/services/inboundEmail/inboundEmailService.test.ts`: `ingest drops a queue notice`. A message with `X-Breeze-Outbound: 1` from the platform sender to a queue address is ignored as `outbound-marker`, and no ticket or comment is written. A device alert with `Auto-Submitted: auto-generated` still creates a ticket. This should pass with no production change. If it does not, stop and report: the spec's loop break depends on it.

---

## W6: `ticket.customer_replied`

Spec D2 "Customer reply". **Event transport:** emit it directly through `fx.emitTicketEvent`, as `ticket.commented` is, so the worker retries until the comment is visible. Not through `ticket_outbox`. This needs no change to `ticket_outbox_event_type_check`. If review wants it on the outbox (for webhooks), that is a migration extending the CHECK, following `2027-01-04-110000-ticket-merge.sql:74-81`.

**Files:**
- Modify: `apps/api/src/services/ticketEvents.ts` (`{ type: 'ticket.customer_replied'; payload: { commentId: string; assigneeId: string | null; ingestedFromMailbox: string | null } }`)
- Modify: `apps/api/src/routes/portal/tickets.ts` (`POST /tickets/:id/comments`: emit after the insert commits)
- Modify: `apps/api/src/services/inboundEmail/inboundEmailService.ts` (emit beside the existing `ticket.commented` `inbound: true` emit)
- Modify: `apps/api/src/jobs/ticketNotifyWorker.ts` (case: unassigned means `collectQueueNotice` with `trigger: 'customer_replied'`, including the same mailbox skip; assigned means staff mail to the assignee through the existing assignee-mail helper. **Never** call `collectRequesterEmail`.)
- Test: `ticketNotifyWorker.test.ts`, `ticketNotifyWorker.leak.test.ts`, the portal tickets route test, `ticketEventsContract.test.ts`

- [ ] Steps: failing tests. `portal comment on unassigned ticket mails the queue, not the requester`. `assigned ticket mails the assignee once`. `inbound reply ingested from the queue mailbox skips that address`. `internal note emits no customer_replied`. Then check every exhaustive `switch (event.type)` over `TicketEvent`: `rg -n "case 'ticket.autoresponse'" apps/api/src -g '!*.test.*'` lists the consumers that need a no-op case. Implement, run, commit.

---

## CI traps

- **Integration-only suites.** Org-cascade, export-policy and RLS contract suites fail only under **Integration Tests**, never in `test-api` or a local `pnpm test`. W2 must see that job green.
- **Stacked PRs get no CI.** Every wave branches from fresh `origin/main` after the previous wave merges. If one is stacked, run `gh workflow run CI --ref <branch>`.
- **Migration name collisions.** A newer migration merged while W2 is queued poisons the merge queue. Rename W2's files to sort after the newest file before enqueueing. Never rename a shipped one.
- **Tests that pin today's gate.** `ticketNotifyWorker.leak.test.ts` (the `fullMessageReply` describe block, line ~282) and `ticketNotifyWorker.graphFork.test.ts` assert the current `!graphMailbox` behaviour. W1 changes them deliberately. A reviewer should see the assertions inverted, not deleted.
- **Shared package.** `packages/shared` tests run in `test-shared`, not `test-api`.
- **API typecheck OOM.** Run local API `tsc` with a 12 GB heap and check the exit code. A `| tail` hides an OOM as green.
- **Locales.** A new key in `en` only fails CI. Add it to all 8, and never call `t(cond ? a : b)`.
- **Web parser drop.** If `ticketConfigApi` or the org settings fetch parses fields explicitly, add `emailCustomer` there. Fetch-mocked component tests pass even when the parser drops the field.

## Open questions for Todd

1. **W1 gate.** W1 turns on the M365 reply text only for partners with the API-only `fullMessageReply` flag. The UI toggle follows in W2. Alternative: merge W1 and W2 into one larger PR. **Recommend keeping them separate**: W1 has no migration and unblocks the reporting deployments now.
2. **Queue address validation** (spec open call). The proposal is any valid address, max 10, with no verification mail. A verification step would add a token table.
3. **Address cap.** 10 per level?
4. **Attachments over budget.** The proposal is a 15 MB total budget, with overflow and expired files listed by name and no download links (the spec rules out customer-portal downloads). Signed, expiring public download links would be a separate security-reviewed design.
5. **Queue notice template** (spec open call). The proposal is a fixed staff layout, not a partner-editable template, because it is staff mail.
6. **No-inbound fallback subject** (spec open call). The proposal keeps today's rendered template subject (`[T-…] New reply: …`), which carries the ticket token so replies thread back, rather than `RE: <subject>`.
7. **Gmail mailboxes.** A connected Gmail mailbox has no outbound lane (`resolveOutboundMailbox` is m365-only), so those partners use the platform/partner lane, where the flag already appends the text today. Out of scope unless you want a Gmail send lane.
