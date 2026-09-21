# Outbound email templates (HTML editor) + public ticket-reply notice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Design only until this plan is approved.** Do not open a PR, do not change schema, do not patch a running host, and do not bind-mount files into production. Self-hosters on v0.113.0 get this on a normal image upgrade.

**Goal:** Partners edit outbound customer emails in a real HTML editor. The first mail that uses it is the public ticket-reply notice (today a bare one-line stub). Auto-reply and resolved ticket mail move onto the same system in the same PR. Quote, invoice, and portal-invite mail follow in a second PR. Comment text still never goes in any email.

**Architecture:** One partner-level template registry. Each template is subject + heading + button label (plain) plus an HTML body authored in the existing TipTap `RichTextEditor`. On send, the server sanitizes the HTML (`sanitizeRichTextHtml`), substitutes a closed merge-var list (values HTML-escaped), wraps the result in `renderLayout`, and appends a server-built CTA button. Graph mailbox send and EmailService receive the same HTML. No new template engine.

**Tech Stack:** Existing TipTap `RichTextEditor` (`apps/web/src/components/common/RichTextEditor.tsx`), `sanitize-html` via `richTextSanitize.ts`, `renderLayout` / `renderButton`, `renderTemplate`, `portalBase()`, `PATCH /orgs/partners/me` (MFA). JSONB on `partners.settings.emailTemplates`. No new tables, no migrations, no feature flag.

**Spec:** This document. Extends shipped ticketing email work; does not fork those plans.

**Related shipped plans (do not rewrite them):**

- `docs/superpowers/plans/ticketing/2026-06-09-ticketing-phase-1a-backend.md` — stub body.
- `docs/superpowers/plans/ticketing/2026-06-13-ticketing-phase4-outbound-backend.md` — threading, inbound echo guard, leak test.
- `docs/superpowers/plans/ticketing/2026-06-25-ticket-autoreply-canned-responses.md` — jsonb copy + `renderTemplate`.
- `docs/superpowers/plans/ticketing/2026-06-29-m365-mailbox-3-outbound-reply.md` — Graph fork.

**Related open work (out of scope):** `docs/superpowers/plans/open/2026-07-10-web-i18n-phase4-emails-pdfs-notifications.md`. Customer email **defaults** stay English in code. The Settings UI is i18n. Do not add a second copy system.

## Global Constraints

- **Leak invariant (non-negotiable):** `ticket.commented` emails are TEMPLATE-ONLY. The composer must never query `ticket_comments`. Comment content must be structurally unreachable from body and subject. A design that loads `comment.content` is rejected even behind a partner toggle, including inside HTML templates. **Verified:** `apps/api/src/jobs/ticketNotifyWorker.ts:474-490` and `apps/api/src/jobs/ticketNotifyWorker.leak.test.ts`.
- **Private comments** send no requester email. **Inbound comments** send no requester email (mail loop).
- **HTML is not free-form email design.** Allowed tags are the existing rich-text subset: `p, br, strong, em, u, h3, h4, ul, ol, li, a, table…` (**verified:** `richTextSanitize.ts:9-23`). No `<script>`, no `style=`, no `javascript:` links, no images. Outer card / accent bar stay `emailLayout` constants (`#155e75`). Branding-tab colors still do not render on mail.
- **Sanitize on write and again on send.** Same pattern as quotes.
- **Merge-var values are HTML-escaped before substitution.** After substitution, sanitize again so a var cannot poison an `<a href>`.
- **CTA href is server-built** (`portalBase()` or the existing quote/invoice accept URL). Never partner-controlled. Never `javascript:`.
- **Auth / security mail is not customizable** (password reset, verify, MFA, account locked, email changed, staff invite). Those must stay platform-owned so a partner cannot phish their own users with a fake reset template.
- **No live-host patches, bind-mounts, or schema hacks.**
- **No feature flag.** Layout + button default on. Custom HTML optional (`null` = built-in default).
- **Portal URL from `portalBase()`.** Custom portal domains are not served (**verified:** `branding.mdx:157-159`).

---

## Problem

Two gaps, one product:

1. **Public technician replies** email this stub, unwrapped (**verified:** `ticketNotifyWorker.ts:484-489`):

   ```html
   <p>Your ticket has a new reply. Sign in to the portal to view it.</p>
   ```

   No layout, no portal link, no partner-editable copy. Email-only requesters (Gmail, no `portal_users` row) get a teaser they cannot use. Inbound mail no longer mints portal logins (**verified:** `portal.ts:81-85`).

2. **Other outbound customer mail** is hard-coded in `email.ts` / ticket helpers. Auto-reply has a **plain textarea**, not HTML (**verified:** `InboundEmailCard.tsx` + `autoresponseTemplate.ts`). Quotes already use TipTap for proposal **documents**, not for the email wrapper. Partners want one HTML editor for outbound templates.

## Non-goals

- Putting comment or internal-note text in email.
- Auto-reply DMARC / Authentication-Results quarantine bug.
- Convert-from-Review skipping auto-reply.
- Letting partners replace the outer `renderLayout` shell (doctype, card, accent color).
- Making Branding-tab logos/colors appear on mail.
- Custom portal domains, magic-link ticket view, or auto-inviting email-only senders.
- Customizing password reset, email verification, MFA, account locked, email-changed, or staff/deployment invites.
- A drag-and-drop email product (MJML, image blobs, per-pixel CSS).
- Live production file patches or bind-mounts.
- Schema / migrations / new tables.

---

## Current behavior (verified)

### Ticket send path

`handleTicketEvent` in `apps/api/src/jobs/ticketNotifyWorker.ts`:

1. **`ticket.commented`** (`:474-490`): if `isPublic && !inbound`, `collectRequesterEmail(event, HARD_CODED_HTML, 'New reply', commentId)`.
2. **`collectRequesterEmail`** (`:208-273`): loads the **ticket** row (not comments). Requires `submitterEmail`. Subject `` `[${label}] ${subjectPrefix}: ${ticket.subject}` ``. Sets `graphMailbox`. Threads when `commentId` is set.
3. **Send loop** (`:574-595`):
   - Graph + `originalMessageId` → `sendThreadedReply(..., html)` (body only; **subject ignored**).
   - Graph, no original → `sendNewMail(..., to, subject, html)`.
   - Else EmailService. `getEmailService()` may be null (`EMAIL_PROVIDER=auto`, no SMTP/Resend/Mailgun) → skip, no crash. Graph still sends.

**Resolved** (`:502-537`): emails requester; body may include `ticket.resolutionNote` from the ticket row (not `ticket_comments`).
**Autoresponse** (`:285-346`): `buildAutoresponseEmail`; custom copy from `settings.ticketing.inbound.autoresponseSubject/Body`; still a simple `<p>`, not `renderLayout`.
**Assignee / SLA:** tech-facing one-line HTML; not in PR1.

### Graph body

`graphReplySender.ts:21-34`: `createReply` then PATCH replaces the **whole** draft body with our html. Quoted original is already discarded. Threading is Graph conversation id.

### Layout + HTML editor that already exist

- `emailLayout.ts`: full HTML document, accent `#155e75`, no color override.
- Quotes/invoices/invites already call `renderLayout` (`quoteEmail.ts`, `email.ts`).
- TipTap editor: `apps/web/src/components/common/RichTextEditor.tsx` (quotes + agreement templates).
- Sanitizer: `sanitizeRichTextHtml` / `sanitizeRichTextHtmlWithReport` in `richTextSanitize.ts`. Links http/https only; `javascript:` and `//evil` stripped.

### Auto-reply copy today

Stored at `settings.ticketing.inbound.autoresponseSubject/Body`. Zod max 200 / 5000. `PATCH /orgs/partners/me` with MFA + `canManagePartnerWidePolicies`. `ticketing` deep-merged one level so a sibling key survives (`orgs.ts:967-977`).

### Portal URL and login

`portalBase()` (`portalUrl.ts`). Ticket page `apps/portal/src/pages/tickets/[id].astro`. `/tickets/*` protected; signed-out → `/login?next=` (`middleware.ts:14-18`). `safeNextPath` allowlists `/tickets`, rejects `javascript:` (`nextPath.ts`). Ownership after login: `submitted_by` **or** `requester_contact_id` (`ticketOwnership.ts`). Invite-only portal.

### Branding

Partner `settings.branding.primaryColor` does not feed `emailLayout`. Docs caution is correct: Branding tabs do not change customer emails. This plan does not pretend they do.

---

## Key decisions

| Decision | Choice | Why |
|---|---|---|
| Editor | Reuse TipTap `RichTextEditor` | Already in the web app; same subset as quotes. No new editor dependency. |
| HTML subset | `RICH_TEXT_ALLOWED_TAGS` only | Sanitizer + editor already agree. No scripts, styles, or images. |
| Outer shell | Always `renderLayout` + `renderButton` | Mail still looks like Breeze. Partner edits the inner body, not the chrome. |
| Storage | `partners.settings.emailTemplates.<id>` jsonb | Matches auto-reply (no table). Deep-merge **per template id** so saving one does not wipe others. |
| CTA | Server-appended button; optional `{{cta_button}}` slot | Partner cannot point the button at an evil URL. If they omit the slot, we append the button for templates that have a CTA. |
| Merge vars | Closed list per template id | Unknown `{{tokens}}` → `''`. Comment content is not a key. |
| Technician name | Not a var on customer templates | Extra identity in unauthenticated mail with no product need. |
| Portal href | Always `${portalBase()}/tickets/${ticket.id}` | Middleware supplies login `next`. Existence of a portal user only changes the email-only hint var, not the URL. |
| Email-only requesters | Login wall + “reply to this email” | No magic view token. No auto-invite. |
| Graph HTML | Same full layout document as EmailService | One snapshot. `createReply` already replaces quoted body. Custom **subject** still unused on `sendThreadedReply`. |
| Colors | `emailLayout` constants only | Sanitizer strips `style`. Branding tabs are not a real email color API. |
| Auth emails | Not in the registry | Phishing / account-takeover risk if a partner (or a stolen admin session) can rewrite reset mail. |
| Feature flag | None | Quality fix. Copy optional. |
| PRs | Two (locked) | PR1 ships first: registry + HTML editor + ticket customer mail, public-reply notice wired before auto-reply and resolved. PR2 after merge: quote, invoice, portal invite. |

---

## Template catalog

### PR1 (ship first) — HTML editor + customer ticket mail

Public-reply notice is the required fix. Wire that send path before auto-reply and resolved. Do not open PR2 until PR1 is merged.

| Id | When it sends | CTA | Merge vars (closed) |
|---|---|---|---|
| `ticket_comment_notification` | Public technician reply (`isPublic && !inbound`) | View ticket → `/portal/tickets/:id` | `ticket_number`, `ticket_subject`, `requester_name`, `requester_email`, `org_name`, `partner_name`, `portal_url`, `email_only_hint` |
| `ticket_autoresponse` | One-time ack on email-created ticket | none (reply-to-email is the action) | existing six auto-reply vars |
| `ticket_resolved` | Status → resolved | View ticket → same portal URL | comment-notification vars **plus** `resolution_note` (from `tickets.resolutionNote` only) |

**Forbidden on all three:** comment body, internal notes, `agent_name`, `current_status`, `current_priority`.

`email_only_hint` is `If you do not have a portal account, reply to this email instead.` when no active `portal_users` row for submitter email+org; otherwise `''`.

`resolution_note` is escaped text from the ticket row. Composer still must not query `ticket_comments`.

### PR2 — other customer outbound that already uses `renderLayout`

| Id | Sender today | CTA |
|---|---|---|
| `quote_send` | `buildQuoteTemplate` | existing accept URL (token URL, not login) |
| `invoice_send` | `buildInvoiceTemplate` | existing portal/pay URL |
| `portal_invite` | `buildPortalInviteTemplate` | invite/set-password URL (existing token; do not invent a new one) |

Per-send quote/invoice **note** and `emailSignature` stay as they are (appended around the template), not merged into the HTML editor.

### Never in this product

Password reset, verification, MFA enrollment notice, account locked, email changed, staff invite, deployment invite, tenant offboarding, AI budget alert.

### Later (not this plan)

Assignee, SLA, alert notification, report delivery, quote outcome, contract renewal. Registry is built so adding an id is a small follow-up.

---

## Proposed architecture

### Data

No migration. JSONB:

```ts
settings.emailTemplates: {
  [templateId: string]: {
    subject: string | null;       // max 200
    heading: string | null;       // max 200
    buttonLabel: string | null;   // max 80
    html: string | null;          // max 20_000, sanitized subset
  }
}
```

Absent / null / whitespace → code defaults. Empty save stores `null`.

**Back-compat:** if `emailTemplates.ticket_autoresponse` is null, keep using `ticketing.inbound.autoresponseSubject/Body` (plain text → escaped `<p>` + `<br>`), then the hardcoded ack. Do not auto-migrate. The new editor, on first save, writes `emailTemplates` only.

**PATCH merge:** one-level merge of `emailTemplates` by template id (same idea as `ticketing`). Saving `ticket_comment_notification` must not wipe `ticket_resolved`. Zod: `.strict()` per template object; keys must be a known template id enum.

### Render pipeline (every customizable send)

`apps/api/src/services/emailTemplates/renderPartnerEmail.ts`

```
1. Load custom row or null.
2. Subject = custom.subject?.trim() ? renderTemplate(custom.subject, vars).replace(newlines, ' ')
   : defaultSubject(id, context)
3. Heading = custom.heading?.trim() ? renderTemplate(custom.heading, escapedVars)
   : defaultHeading(id, context)
4. Inner HTML:
   a. source = custom.html?.trim() ? custom.html : defaultHtml(id)
   b. sanitizeRichTextHtml(source)          // drop script/style/js links
   c. renderTemplate(sanitized, escapedVars) // {{ticket_subject}} etc.
   d. sanitizeRichTextHtml again            // href poison after substitution
5. CTA: if template has a CTA URL, replace {{cta_button}} with renderButton(label, safeUrl);
   if the token was absent, append the button.
6. renderLayout({ title: subject, preheader, heading, body: inner, footer, brandName })
```

`safeUrl` is scheme-checked (`http:`/`https:`) and, for portal ticket links, origin-checked against `portalBase()`.

Default HTML for `ticket_comment_notification` (lock the sentence):

```html
<p>Your ticket has a new reply. Sign in to the portal to view it.</p>
<p>{{email_only_hint}}</p>
<p>{{cta_button}}</p>
```

Default subject stays `` `[${label}] New reply: ${ticketSubject}` `` when custom subject is null.

### Portal href helper

Unchanged from the previous draft: `resolveCommentNotificationPortalHref` → `{ href, hasPortalUser }`. Query `portal_users` only. Mock in worker leak tests like `resolveOutboundMailbox`.

### Worker (PR1)

- `ticket.commented`: keep `isPublic && !inbound`. Compose via `renderPartnerEmail('ticket_comment_notification', …)`. Never load comments.
- `ticket.autoresponse`: compose via `renderPartnerEmail('ticket_autoresponse', …)` with inbound-field fallback.
- `ticket.status_changed` resolved: compose via `renderPartnerEmail('ticket_resolved', …)` including escaped `resolutionNote`. Freshness guard stays.

Add `subjectOverride` on `collectRequesterEmail` so a custom subject can replace the `[label] prefix: subject` construction without touching assignee mail.

### PR2 send paths

`buildQuoteTemplate` / `buildInvoiceTemplate` / `buildPortalInviteTemplate` call the same renderer with their id and vars. Keep PDF-attached sentences and signature blocks as code around the partner HTML (or as extra vars later). Do not put payment-processor secrets in merge vars.

### API

- `partnerSettingsSchema.emailTemplates`: record of known ids.
- Writes: existing `PATCH /orgs/partners/me` (MFA + full partner access).
- Read: include `emailTemplates` on GET `/partners/me` (already returns `settings`) **and** on `getTicketConfig()` as a convenience for the ticketing UI, or a small `GET /email-templates` that reads the same jsonb. Prefer GET `/partners/me` to avoid a new route. The new Settings tab fetches `/orgs/partners/me`.
- On write, run `sanitizeRichTextHtmlWithReport` and persist the cleaned HTML. Return strip warnings in the JSON (same shape quotes use) so the UI can toast “markup removed”.

---

## UX

**Location:** Settings → Partner → **Email templates** (new tab next to Ticketing). Not stuffed onto Inbound email.

List of templates (name + “Using default” / “Custom”). Click one:

- Subject (plain input)
- Heading (plain input)
- Button label (plain; hidden when the template has no CTA)
- HTML body (`RichTextEditor`)
- Insert chips for that template’s merge vars (inserts `{{ticket_number}}` as text)
- Preview: sanitized HTML + sample vars inside a layout mock (read-only `div.prose`, not an iframe executing script)
- Save (`runAction` PATCH of that one id)
- Reset to default (saves nulls)

Inbound email card: one line + link “Edit email templates” for auto-reply, so the old textarea is not a second editor. **Remove the auto-reply textarea** once the new tab can edit `ticket_autoresponse`. Until PR1 ships the tab, do not leave two editors.

**i18n:** Settings chrome in all eight locales. Customer defaults stay English in `registry.ts`.

**Hash:** `#emailTemplates` on the partner settings page (same pattern as other tabs). Nested `#emailTemplates&template=ticket_comment_notification` optional; if hash fighting is a risk, use in-tab state only.

---

## Email-only requesters

Same as before:

1. Button → `/portal/tickets/:id`.
2. Signed-out → login with safe `next`.
3. No portal account → login form; muted `email_only_hint`; they can reply to the email.
4. Do not mint logins, invites, or magic view tokens.

---

## Security / leak analysis

| Risk | Mitigation |
|---|---|
| Comment text in email | No `ticket_comments` query. No comment merge var. Leak test table spy stays. |
| `<script>` / `onerror` in saved HTML | `sanitizeRichTextHtml` on write and send. TipTap subset only. Test a stored `<img onerror>` and `<script>` are gone in outbound html. |
| `javascript:` in partner `<a>` or in a merge var used as href | Sanitizer after substitution; CTA href is server-built, not from HTML. |
| Open redirect on portal `next` | Existing `safeNextPath`. Ticket href has no query. |
| Partner HTML replaces reset-password mail | Auth templates are not in the registry. Zod rejects unknown ids. |
| Stolen admin rewrites all customer mail | Same MFA + partner-admin gate as inbound settings. Acceptable; same as today for auto-reply. |
| `{{cta_button}}` XSS | Replaced **after** sanitize with `renderButton` output only. |
| Cross-tenant `portal_users` | Filter `org_id = ticket.orgId`. |
| Graph nested HTML | Accepted; same full document as EmailService. Follow-up if Outlook blanks. |

---

## Test plan

Keep `ticketNotifyWorker.leak.test.ts` meaningful (`ticket_comments` never queried; SECRET absent).

### PR1

1. **Registry / renderer**
   - Default comment mail: `<!doctype html>`, `#155e75`, default sentence, portal URL in the button href.
   - Custom HTML with `{{ticket_number}}` renders the number.
   - Custom HTML `<script>alert(1)</script><p>Hi {{requester_name}}</p>` → no `<script>`; name escaped if it contains `<`.
   - `{{ticket_subject}}` = `javascript:alert(1)` used in `<a href="{{ticket_subject}}">` → href stripped or not `javascript:`.
   - `{{comment}}` / `{{agent_name}}` → empty.
   - `email_only_hint` empty vs filled.
   - Null custom → exact default sentence still present (wording preserved).
   - Autoresponse fallback: inbound plain `autoresponseBody` still used when `emailTemplates.ticket_autoresponse` is null.
   - Resolved: `{{resolution_note}}` from args, SECRET from a comment row never appears; renderer does not import comments.

2. **Href helper** — same tests as before (active user, none, disabled, origin/scheme).

3. **Worker**
   - Public comment html has layout + `/tickets/` + default sentence; no SECRET.
   - Private / inbound still no send.
   - Custom `emailTemplates.ticket_comment_notification` used.
   - Graph fork receives `<!doctype html>`.
   - Comment event + null EmailService + null mailbox: no throw.
   - Resolved uses layout; still includes resolution note when set.
   - Autoresponse uses layout when sending default or custom.

4. **Settings API**
   - Zod max lengths; unknown template id 400.
   - PATCH one id preserves siblings.
   - Write sanitizes stored html.
   - MFA still required (existing partners/me tests).

5. **UI**
   - Email templates tab lists the three PR1 ids.
   - Save PATCHes only that id under `settings.emailTemplates`.
   - Insert chip puts `{{ticket_number}}` in the editor.
   - Reset saves nulls.
   - Inbound card no longer has the plain auto-reply textarea (or it is hidden and links here).

6. **Shared vars:** `variablesForContext` gains `'email_template'` **or** a per-id list on the registry (prefer registry as source of truth; UI reads the registry catalog from a small shared module or duplicates the id→vars map in shared). Put the catalog in `packages/shared` so web + api agree.

### PR2

- Quote / invoice / portal-invite send use partner html when set; defaults byte-stable when null.
- Accept/pay/invite URLs still the server URLs, not from HTML.
- Signature and per-send note still appear.

---

## Docs changes

- `features/ticketing.mdx` — public replies send a laid-out notice; reply text is never in the email; partners edit templates under Settings → Partner → Email templates. Graph vs EmailService unchanged.
- `features/portal.mdx` — link behavior + email-only fallback.
- `features/branding.mdx` — one sentence: outbound templates edit inner HTML; they do **not** change the card accent or pull Branding-tab colors.
- Self-host: `PUBLIC_PORTAL_URL` / `PUBLIC_APP_URL` for working buttons. `EMAIL_PROVIDER=auto` with no host remains a no-op on the EmailService path.

---

## File structure

**Create (PR1):**

- `packages/shared/src/utils/emailTemplates.ts` — ids, var lists, labels
- `packages/shared/src/utils/emailTemplates.test.ts`
- `apps/api/src/services/emailTemplates/renderPartnerEmail.ts`
- `apps/api/src/services/emailTemplates/renderPartnerEmail.test.ts`
- `apps/api/src/services/emailTemplates/defaults.ts` — default subject/heading/html/button per id
- `apps/api/src/services/inboundEmail/commentNotificationPortalHref.ts` (+ test)
- `apps/web/src/components/settings/EmailTemplatesTab.tsx` (+ test)
- `apps/web/src/components/settings/EmailTemplateEditor.tsx` (+ test)

**Modify (PR1):**

- `apps/api/src/jobs/ticketNotifyWorker.ts` (+ `.test.ts`, `.leak.test.ts`, `.graphFork.test.ts`)
- `apps/api/src/services/inboundEmail/autoresponseTemplate.ts` — become a thin fallback into `renderPartnerEmail`, or delete once worker calls the renderer with fallback
- `apps/api/src/routes/orgs.ts` (+ merge tests)
- `apps/web/src/components/settings/PartnerSettingsPage.tsx` — new tab
- `apps/web/src/components/settings/InboundEmailCard.tsx` — replace textarea with link
- locales (eight) `settings.json`
- docs as above

**Modify (PR2):**

- `apps/api/src/services/quoteEmail.ts`
- `apps/api/src/services/email.ts` (`buildInvoiceTemplate`, `buildPortalInviteTemplate`)
- EmailTemplatesTab catalog includes the three PR2 ids

**Do not modify:** `graphReplySender.ts`, `emailLayout.ts` accent, auth email builders, shipped SQL.

---

## Task checklist

### Task 1: Shared catalog (PR1)

**Files:** `packages/shared/src/utils/emailTemplates.ts` (+ test)

- [ ] **Failing test:** `EMAIL_TEMPLATE_IDS` is the PR1 set; `varsForEmailTemplate('ticket_comment_notification')` is the closed list; `ticket_resolved` includes `resolution_note`; none include `agent_name` or a comment key.
- [ ] **Implement** the catalog + labels for the Settings list.
- [ ] Run `cd packages/shared && npx vitest run src/utils/emailTemplates.test.ts`
- [ ] Commit `feat(shared): outbound email template catalog`

### Task 2: Renderer (PR1)

**Files:** `apps/api/src/services/emailTemplates/renderPartnerEmail.ts`, `defaults.ts`, tests

- [ ] **Failing tests** for defaults, layout wrapper, sanitizer, href poison, unknown tokens, `{{cta_button}}`, autoresponse inbound fallback, resolution note.
- [ ] **Implement** `renderPartnerEmail(id, { custom, vars, ctaUrl, ctaLabel, brandName, footer, preheader })`.
- [ ] Run `cd apps/api && npx vitest run src/services/emailTemplates/renderPartnerEmail.test.ts`
- [ ] Commit `feat(api): render partner outbound email templates`

### Task 3: Portal href (PR1)

Same helper as the previous draft. Commit `feat(api): portal href for ticket reply notices`

### Task 4: Worker wiring (PR1, notice first)

Mock the href helper in worker tests. Wire **`ticket.commented` first** and keep that path green (layout, portal URL, leak test, Graph) before touching auto-reply or resolved. Then point autoresponse and resolved at `renderPartnerEmail`. Leak test still forbids `ticket_comments`. Graph html contains `<!doctype html>`.

```
cd apps/api && npx vitest run src/jobs/ticketNotifyWorker.leak.test.ts src/jobs/ticketNotifyWorker.test.ts src/jobs/ticketNotifyWorker.graphFork.test.ts src/services/ticketEventsContract.test.ts
```

Commit `feat(api): laid-out customizable ticket customer emails`

### Task 5: Settings API (PR1)

Zod + per-id merge + sanitize on write. Test inbound-style sibling preserve. Commit `feat(api): persist partner email templates`

### Task 6: Settings UI (PR1)

Partner tab + TipTap editor + chips + preview + `runAction`. Remove inbound auto-reply textarea; link here. All eight locales. Commit `feat(web): HTML editor for outbound email templates`

### Task 7: Docs (PR1)

Ticketing, portal, branding. Commit `docs: outbound email templates`

### Task 8: Verify (PR1)

```
cd apps/api && npx vitest run src/services/emailTemplates src/services/inboundEmail/commentNotificationPortalHref.test.ts src/jobs/ticketNotifyWorker.leak.test.ts src/jobs/ticketNotifyWorker.test.ts src/jobs/ticketNotifyWorker.graphFork.test.ts src/routes/orgs.test.ts
cd packages/shared && npx vitest run src/utils/emailTemplates.test.ts
cd apps/web && npx vitest run src/components/settings/EmailTemplatesTab.tsx src/components/settings/EmailTemplateEditor.tsx src/components/settings/InboundEmailCard.test.tsx src/lib/i18n/localeParity.test.ts
```

`rg ticketComments apps/api/src/services/emailTemplates` is empty. No SQL migrations.

### Task 9: Quote / invoice / portal invite (PR2)

Wire `renderPartnerEmail` into the three builders. Defaults unchanged when custom is null. Tests: custom html appears; accept/pay/invite URL still server-built; null custom matches current wording. Commit `feat(api): customizable quote, invoice, and portal-invite emails`

### Task 10: UI catalog + docs (PR2)

Show the three extra rows in Email templates. Docs: quotes/invoices/invites. Commit `feat(web): edit quote invoice invite email templates`

---

## Open questions for Todd (LanternOps)

Implementer uses the recommended default unless Todd objects.

1. **Email-only requesters.** Recommend: login wall + reply-to-this-email. No magic view token.
2. ~~**PR2 in the same merge as PR1?**~~ **Decided (Chris):** two PRs. Ship the ticket notice first (PR1). Quote / invoice / portal invite are PR2 after PR1 merges.
3. **Tech-facing mail (assigned, SLA, alerts) in the editor?** Recommend: **not yet**. Different audience; keep the registry closed so the Settings list stays customer-facing.

No other Todd blockers. Graph threaded subject staying the conversation subject is existing behavior.

---

## Claim tags

- **Verified:** stub + guards; leak test; Graph PATCH-replaces body; `emailLayout` accent; TipTap + `richTextSanitize` subset; auto-reply storage/UI/MFA; `ticketing` one-level merge; `portalBase` + login `next`; portal ownership; inbound does not mint `portal_users`; branding docs vs code; `EMAIL_PROVIDER=auto` null service.
- **Assumed:** Outlook will render a full HTML document in Graph `createReply` (quotes already send full documents via EmailService, not Graph). Follow-up: inner table only on Graph if a host reports a blank body.
