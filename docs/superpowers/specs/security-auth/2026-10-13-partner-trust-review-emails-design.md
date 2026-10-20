# Partner Trust Review Emails — Design

**Date:** 2026-10-13
**Issue:** LanternOps/breeze#8713
**Status:** Approved 2026-10-13 (§9 defaults accepted)
**Scope:** hosted SaaS only (`PARTNER_TRUST_MODE=enforce`); self-hosted installs resolve the trust mode to `off` and never send these emails
**Builds on:** `2026-09-02-partner-trust-probation-design.md` (capability gate, `setTrustState`, trust queue, evidence card)

## 1. Problem

A partner on probation who clicks **Request review** gets a toast and nothing else. When ops promote the partner, the only signal is that the banner stops appearing and remote tools start working. Partners have waited days without knowing whether the request was seen, and have found out they were approved only by trying a remote session.

Current behaviour on `main`:

| Event | Code path | Partner notified? |
|---|---|---|
| Review requested | `POST /partner/trust/request-review` (`routes/partnerTrust.ts`) | No. An ops evidence card goes to `OPS_ALERT_EMAIL` via `sendEvidenceCard(partnerId, 'review_requested')`. |
| Promoted to trusted | `setTrustState(partnerId, 'trusted', …)` (`services/partnerTrust.ts`), reached from `tryAutoPromote`, `POST /admin/partners/:id/trust/promote`, and the evidence-card approve link (`routes/admin/trustAct.ts`) | No. `setTrustState` writes the partner row, publishes `partner-trust:changed`, and writes the audit row. |

## 2. Goals and non-goals

**Goals**

1. A partner admin who requests a review receives an email confirming the request was received.
2. Partner admins receive an email when the partner moves from probation to trusted, whichever path promoted it.
3. Neither send can fail the trust write or the HTTP request.
4. Both sends are unit-tested, including the paths that must not send.

**Non-goals**

- No partner email for any other trust transition. Partner-facing trust email is exactly: review received, and probation → trusted. This is a scope rule, not a placeholder for later work.
- No backfill. Partners already `trusted` when this ships receive nothing. Event-driven only: no migration, no script, no data change.
- No change to the ops evidence card, the trust queue, the probation banner, or the capability gate.
- No localisation. API-rendered email is English only (see §4.8).
- No "already emailed" state on the partner row. Nothing in this design assumes `trusted` is permanent; a partner that drops back to probation (#8714) and is promoted again is emailed again, because that is a genuine re-approval.

## 3. Divergences from the issue body

The issue is the brief; these four points override it.

1. **Not `services/emailTemplates/`.** That directory is the partner-customisable, customer-facing catalogue (`EmailTemplateId` in `@breeze/shared`: ticket, invoice, quote, portal invite, autopay notices). Entries there surface in the partner's Settings → Email templates UI and accept partner overrides. A notice *from Breeze to the partner* must not be partner-editable. These emails use the Breeze-branded platform idiom instead: `renderLayout` + `renderButton` + `supportFooter` from `services/email.ts` / `services/emailLayout.ts`, a hand-built `EmailTemplate`, and a platform-lane mail purpose. `services/emailDomains/statusMail.ts` is the reference implementation.
2. **No turnaround figure in the review-received email.** The copy says we received the request and will follow up by email. It does not state a turnaround, promise an outcome, or describe what is reviewed.
3. **Approval email fires only on probation → trusted.** The issue says "previous state was not trusted". This design narrows that: the email is sent when `before.trustState === 'probation'`, `next === 'trusted'`, and `partners.status === 'active'`. Restricted → trusted sends nothing. Trusted → trusted sends nothing.
4. **Both emails send only when `partnerTrustMode() === 'enforce'`.** `partnerTrustJobs.ts` runs auto-promotion in `shadow` too; in `shadow` nothing was ever blocked, so "remote access is now enabled" would be false.

## 4. Design

### 4.1 New module: `services/partnerTrustPartnerMail.ts`

One file owns both partner-facing trust emails. `services/partnerTrust.ts` imports only this module (the way it already imports `partnerTrustEvidenceCard`), so the gate's import graph stays free of transport config and `partnerTrust.test.ts` / `routes/partnerTrust.test.ts` mock it with one `vi.mock`.

Exports:

```ts
// Pure. No I/O. Unit-tested for copy.
export function buildTrustReviewReceivedTemplate(input: { partnerName: string; meetingUrl: string | null }): EmailTemplate;
export function buildTrustApprovedTemplate(input: { partnerName: string; appUrl: string | null; docsUrl: string }): EmailTemplate;

// Never throw. Return the number of recipients the mail went to (0 when skipped).
export async function sendTrustReviewReceivedEmail(input: { partnerId: string; requestedByUserId: string }): Promise<number>;
export async function sendTrustApprovedEmail(input: { partnerId: string }): Promise<number>;
```

Both senders follow the `sendSendingDomainStatusEmail` contract exactly:

1. `getEmailService()`; return 0 when email is not configured.
2. Return 0 when `partnerTrustMode() !== 'enforce'`.
3. Resolve recipients (§4.3) inside `runOutsideDbContext(() => withSystemDbAccessContext(...))`. The bare `withSystemDbAccessContext` that `statusMail.ts` uses is worker-only; `setTrustState` is also reached from admin request handlers, so the wrapper must first step outside any request context, as `buildEvidenceCard` does.
4. Return 0 when there are no recipients.
5. Build the template, then call `email.sendEmail({ to, purpose, subject, html, text })` **after** the DB context has closed, so no pooled connection is held across the transport round trip (#1105).
6. Wrap everything in `try/catch`: `console.error('[PartnerTrust] <which> email failed:', …)`, `captureException`, return 0.

### 4.2 Mail purposes

Two new entries in `MAIL_PURPOSES` (`services/emailDomains/mailPurposes.ts`), both platform lane, next to the existing `account.*` notices:

```ts
// #8713. Breeze → the partner's own admins about the partner's trust review.
// Platform lane: this is account mail to the partner's staff and must not
// depend on, or appear to come from, a partner sending domain.
'account.trust_review_received': { lane: 'platform' },
'account.trust_approved': { lane: 'platform' },
```

Two purposes rather than one so delivery history can answer "did this partner get the approval email" without parsing subjects.

Adding a purpose requires rows in both registry tests, or CI fails:

- `services/emailDomains/mailPurposes.test.ts` — the pinned classification map.
- `services/email.golden.test.ts` — asserts every registry purpose has a golden case and vice versa, for each provider.

### 4.3 Recipients

**Review received:** the requesting user plus the partner's active Partner Admins, deduplicated. The requester is included explicitly because `canManagePartnerWidePolicies` admits any partner-scope user with `partnerOrgAccess === 'all'`, which need not carry the `Partner Admin` role name.

**Approved:** the partner's active Partner Admins.

Both resolvers return an empty list unless `partners.status = 'active'`. The mail module owns this check; `setTrustState` and `readTrust` are not taught about partner status.

"Active Partner Admin" means the join used by `statusMail.ts`, `routes/auth/accountDeletion.ts` and `services/tenantOffboarding.ts` today:

```
partner_users ⋈ users ⋈ roles
WHERE partner_users.partner_id = $1
  AND roles.name = 'Partner Admin'
  AND users.status = 'active'
```

`statusMail.ts` carries a comment deferring extraction of this query until a further caller appears. This is that caller. The design extracts it:

- New `services/partnerAdminRecipients.ts` exporting `listActivePartnerAdmins(partnerId): Promise<Array<{ id: string; email: string; name: string | null }>>`, running the query in system scope via `runOutsideDbContext(() => withSystemDbAccessContext(...))`.
- Migrate the three existing call sites in a **separate, mechanical commit** with no behaviour change. `accountDeletion.ts` keeps its `excludeUserId` filter by filtering the returned list. Existing tests for those three sites are the guard. If any site cannot migrate without a behaviour change, it stays as is and its comment is updated to point at the helper.

### 4.4 Trigger: review requested

In `routes/partnerTrust.ts`, after the audit row and the existing evidence-card send:

```ts
await sendTrustReviewReceivedEmail({ partnerId, requestedByUserId: auth.user.id });
```

Placement after the `UPDATE … RETURNING` guarantees "once per accepted request": the 24-hour cooldown returns 429 before this line, and the 403 branches return before the write. The sender never throws, so no additional `try/catch` is needed at the call site; the route still returns `{ requested: true }` when the send fails.

### 4.5 Trigger: approved

In `setTrustState`, after the audit row:

```ts
if (before?.trustState === 'probation' && next === 'trusted') {
  await sendTrustApprovedEmail({ partnerId });
}
return true;
```

Why this covers every path:

| Path | `expectedFrom` | Emails? |
|---|---|---|
| `tryAutoPromote` (job, and the opportunistic call in `evaluateCapability`) | `'probation'` (CAS) | Yes. A lost CAS returns `false` before the email line. |
| `POST /admin/partners/:id/trust/promote` (`changeTrustState`) | see §4.6 | Yes, when the loaded state was probation. |
| Evidence-card approve link (`trustAct.ts`) | none | Yes, when `before` was probation. |
| Any caller with `next !== 'trusted'` | — | No. |
| Any caller where `before` is `trusted` or `restricted` | — | No. |
| Partner `status !== 'active'` | — | No (resolver returns no recipients). |

### 4.6 Admin promote becomes a compare-and-swap

`changeTrustState` in `routes/admin/trust.ts` already loads `current` before writing. It passes it through:

```ts
const landed = await setTrustState(partnerId, next, action, auth.user.id, { reason }, { expectedFrom: current.trustState });
if (!landed) return c.json({ error: 'trust state changed since the queue was loaded; refresh and retry' }, 409);
```

This removes the one path where `before` could disagree with the row actually written, so the email and the audit row's `from` always describe the same transition. The trust queue UI (`TrustQueue.tsx`) already surfaces route errors through `runAction`; the 409 toasts the message above and the operator refreshes. No web code change beyond confirming the toast reads correctly.

The evidence-card approve link in `trustAct.ts` is left as is. It consumes its token before acting and has no loaded state to CAS against. The residual race there (two operators approving the same partner from the same card within the same second) is accepted.

### 4.7 Copy

Plain English, one idea per sentence, no exclamation marks. Every interpolated value passes through `escapeHtml`. Text part built from the same lines.

**Review received** — purpose `account.trust_review_received`

- Subject: `We received your review request`
- Heading: `Review request received`
- Preheader: `We'll follow up by email.`
- Body:
  - `We received your request to review {partnerName}. We'll follow up by email once the review is complete.`
  - `You can keep using Breeze in the meantime. Remote control and script execution stay paused while the review is open.`
  - If `PARTNER_MEETING_URL` is set: button `Book a call` → that URL. (The probation banner already offers the same link.)
  - Muted: `You're receiving this because you requested the review or administer this Breeze account.`
- Footer: `supportFooter(undefined, 'Need help? Contact')`

**Approved** — purpose `account.trust_approved`

- Subject: `Your Breeze account is approved`
- Heading: `Account approved`
- Preheader: `Remote control and script execution are now enabled.`
- Body:
  - `{partnerName} has been reviewed and approved.`
  - `Remote control and script execution are now enabled. The probation limits on agent enrollment, installer links and custom sending domains are lifted.`
  - Button `Open Breeze` → `PUBLIC_APP_URL` (falling back to `DASHBOARD_URL`, same precedence as the other web deep links); omitted when neither is set.
  - `New to Breeze? Start with the getting-started guide: https://docs.breezermm.com/getting-started/quickstart/`
  - Muted: `You're receiving this because you administer this Breeze account.`
- Footer: `supportFooter(undefined, 'Need help? Contact')`

The capability list mirrors `GatedCapability` (`remote_control`, `device_execute`, `installer_distribute`, `agent_enroll`, `custom_sending_domain`) in user words. If a capability is added to the gate later, this sentence is updated with it; there is no generated list.

### 4.8 Localisation

API-rendered email has no locale layer: every platform notice (`statusMail.ts`, `aiBudgetAlertEmail.ts`, `mfaEnrollmentNotice.ts`, the auth emails) is English only, and neither `users` nor `partners` carries a locale column. The issue's "copy for all 7 locales" acceptance item applies to web UI strings and is not applicable here.

### 4.9 Failure handling

| Failure | Behaviour |
|---|---|
| Email provider not configured | Sender returns 0; trust write and request unaffected. |
| Recipient query throws | Caught inside the sender; logged + `captureException`; returns 0. |
| Transport throws (`EmailTransportError`) | Same. The existing delivery-event pipeline records the failed purpose. |
| `setTrustState` CAS lost | Returns `false` before the email line; nothing sent; nothing audited. |
| Audit write throws | Propagates as today; the email line is not reached. Trust row already written. Unchanged from current behaviour. |

Nothing retries. A missed partner email is recoverable by ops (re-send by hand); a retry loop inside a request handler or inside the trust write is not worth the coupling.

## 5. Changes by file

| File | Change |
|---|---|
| `apps/api/src/services/partnerTrustPartnerMail.ts` | New. Two template builders, two never-throw senders. |
| `apps/api/src/services/partnerTrustPartnerMail.test.ts` | New. |
| `apps/api/src/services/partnerAdminRecipients.ts` | New. `listActivePartnerAdmins`. |
| `apps/api/src/services/partnerAdminRecipients.test.ts` | New. |
| `apps/api/src/services/emailDomains/mailPurposes.ts` | Two platform-lane purposes. |
| `apps/api/src/services/emailDomains/mailPurposes.test.ts` | Pin the two purposes. |
| `apps/api/src/services/email.golden.test.ts` | Golden cases for the two purposes. |
| `apps/api/src/services/partnerTrust.ts` | Import the mail module; email line after the audit row in `setTrustState`. |
| `apps/api/src/services/partnerTrust.test.ts` | Mock the mail module; transition cases. |
| `apps/api/src/routes/partnerTrust.ts` | Send review-received after the evidence card. |
| `apps/api/src/routes/partnerTrust.test.ts` | Mock the mail module; 200 / 429 / 403 / failure cases. |
| `apps/api/src/routes/admin/trust.ts` | `expectedFrom: current.trustState`; 409 on lost CAS. |
| `apps/api/src/routes/admin/trust.test.ts` | `expectedFrom` passed; 409 case. |
| `apps/api/src/services/emailDomains/statusMail.ts`, `apps/api/src/routes/auth/accountDeletion.ts`, `apps/api/src/services/tenantOffboarding.ts` | Separate commit: use `listActivePartnerAdmins`; drop the "extract when a further caller appears" comment. |

No migration. No schema change. No new environment variable. No web change beyond the 409 toast reading correctly.

## 6. Tests

**`partnerTrustPartnerMail.test.ts`**

- Review-received template: subject and heading as in §4.7; body contains the partner name escaped; body contains no digits followed by `hour`, `day` or `business day` (negative assertion: no turnaround figure); `Book a call` present only when a meeting URL is passed.
- Approved template: subject as in §4.7; body lists remote control and script execution; `Open Breeze` button present only with an app URL; docs link present always.
- `sendTrustReviewReceivedEmail`: sends once to requester ∪ active Partner Admins, deduplicated; excludes `users.status != 'active'`; returns 0 and sends nothing when `partners.status != 'active'`, when mode is `off` or `shadow`, when email is unconfigured; a throwing transport is caught and returns 0.
- `sendTrustApprovedEmail`: same matrix minus the requester.
- The transport call happens after the DB context callback has resolved (assert call order against the mocked `withSystemDbAccessContext`).

**`partnerTrust.test.ts` — `setTrustState`**

- probation → trusted without `expectedFrom`: sends once.
- probation → trusted with `expectedFrom: 'probation'`: sends once.
- CAS lost (`writeTrust` affects 0 rows): returns `false`, no send, no audit, no publish.
- restricted → trusted: no send.
- trusted → trusted: no send.
- probation → restricted, probation → probation: no send.
- Send rejects: `setTrustState` still resolves `true`, audit row still written.
- Email line runs after `createAuditLog` (call order).

**`routes/partnerTrust.test.ts`**

- Accepted request: 200, one send with the requester's user id.
- Cooldown: 429, no send, no audit, no evidence card.
- Viewer / billing-viewer scope: 403, no send.
- Send rejects: still 200 `{ requested: true }`.

**`routes/admin/trust.test.ts`**

- Promote passes `expectedFrom` equal to the loaded state.
- `setTrustState` returning `false` yields 409.

**Registry**

- `mailPurposes.test.ts` and `email.golden.test.ts` updated; both fail if either purpose is missing.

**Recipient helper**

- `partnerAdminRecipients.test.ts`: role name filter, `users.status` filter, system-scope wrapper used.
- Existing `statusMail.test.ts`, `accountDeletion` and `tenantOffboarding` tests pass unchanged after migration.

Run: `cd apps/api && npx vitest run partnerTrust partnerAdminRecipients mailPurposes email.golden statusMail` (path filters are substring matches; see `docs/agents/testing.md` for the scoped-run traps). No contract suite is touched: no table, no tenancy shape, no cascade registration.

## 7. Operations

- Promote through the trust queue UI (`/admin/trust-queue`) or `POST /admin/partners/:id/trust/promote`. Both reach `setTrustState`, so the approval email fires. A direct SQL update does not send the email and should not be used.
- A partner that does not receive the approval email after a UI promote: check the API log for `[PartnerTrust] approved email failed`, then the delivery events for purpose `account.trust_approved`. Common causes: partner has no active user with the Partner Admin role; `partners.status` is not `active`.
- No backfill on deploy. Partners promoted before this ships are not emailed.

## 8. Rollout

Single PR, no flag. The emails are inert on self-hosted (`off`) and on hosted regions until `PARTNER_TRUST_MODE=enforce`, which is already the hosted setting. Ships with the next release; nothing to toggle on deploy.

## 9. Decisions for review

Defaults chosen are in effect unless changed.

1. **Turnaround wording.** Default: none (§3.2). Alternative: "usually within two business days" — only if ops will commit to that.
2. **Recipient-helper extraction.** Default: extract and migrate all three existing sites in a separate commit (§4.3). Alternative: add the helper, migrate only `statusMail.ts`, leave `accountDeletion.ts` and `tenantOffboarding.ts` for a follow-up.
3. **Admin promote CAS → 409.** Default: yes (§4.6). Alternative: accept the read-then-write race and leave the admin route unchanged.
4. **Review-received includes the requester.** Default: yes (§4.3). Alternative: Partner Admins only.
5. **Follow-up, not this PR:** the evidence-card approve link in `trustAct.ts` can promote a `restricted` partner without the `override` that the admin route requires. Worth its own issue.
