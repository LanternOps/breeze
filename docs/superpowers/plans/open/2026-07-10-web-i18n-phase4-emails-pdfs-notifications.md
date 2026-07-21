# i18n Phase-4: Emails, PDFs & Notifications Implementation Plan

> **STATUS: FUTURE / ROADMAP.** Written 2026-07-10 against commit `237d8c56`. Prerequisites: Phases 2 and 3 substantially complete (namespace machinery, partner default language shipped, error-code seam). Re-verify all file/line claims before executing — but the central design facts were researched against real code: emails are inline-HTML template literals in `apps/api/src/services/email.ts` (973 lines, 8 core templates + ~7-9 ad-hoc composers, no locale anywhere), report PDFs render from `packages/shared/src/reportPdf/reportPdf.ts` (~90-110 inline strings, shared by web export AND `reportScheduleWorker`), billing PDFs are pdfkit in `apps/api/src/services/{invoicePdf,quotePdf}.ts`, and alert/report/billing send paths have **no user identity** (recipients are raw email strings in channel/schedule config) — so locale must resolve at user, org, partner, or channel level depending on path.

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Every artifact Breeze *emits* — transactional emails, alert notifications, report and billing PDFs — renders in the recipient's locale, so a Brazilian org's end-clients receive Portuguese invoices and password resets even though the API's internals stay English.

**Architecture:** One new resolution primitive — `resolveRecipientLocale()` — that walks user preference → org setting → partner setting → `'en'`, used by every send path with whatever identity it has. A minimal API-side i18n runtime (plain `i18next`, no React) with its own `apps/api/src/i18n/locales/` tree and the same parity-test discipline as the web. Templates become locale-parameterized: email builders take `locale`, `buildReportPdf` takes `locale` + an internal strings table, pdfkit documents take the org's locale. Content authored by users (partner-customized autoresponses, alert titles stored in DB) is explicitly NOT translated.

**Tech Stack:** i18next (plain, Node), existing email service (Resend/SMTP/Mailgun), jspdf (`reportPdf`), pdfkit (billing), BullMQ workers.

## Global Constraints

- Locales `['en','pt-BR']`; keys structured; parity enforced by test in BOTH `apps/web/src/locales` and the new `apps/api/src/i18n/locales`.
- **User-authored content is never machine-translated:** partner-customized autoresponse bodies, ticket subjects, alert titles/messages stored in DB rows, org/partner names. Only Breeze-authored framing strings are translated.
- **Fallback is always English** — a missing pt-BR key must never block an email/PDF from sending.
- Byte-identical rule from Phase 3 does NOT apply here (emails/PDFs aren't parsed by tests/AI tools the way API `error` strings are) — but update every co-located test that asserts template content.
- pt-BR fits latin-1: jspdf's built-in helvetica and pdfkit's built-in fonts render `ã ç é õ` correctly — **no font embedding needed for pt-BR**. Adding a non-latin-1 locale later (pl, tr, zh) requires font work in both PDF stacks; note it in the README, don't build it now.
- New org-level language setting follows the existing org-settings patterns (and the `z.any()` validation-gap lesson — validate the enum server-side).

## Locale resolution map (who gets whose language)

| Send path | Identity available | Locale source |
|---|---|---|
| Password reset, verification, account-locked, email-changed, account-deletion | `users` row | user preference |
| User/portal invites | invitee has no prefs yet | inviter's partner default |
| Ticket assigned / status / SLA (assignee) | `users.id` in worker | user preference |
| Ticket autoresponse (external requester) | portal contact email only | **org** language |
| Alert channel notifications (email/SMS/Slack/…) | raw strings in `notification_channels.config` | **channel** `config.locale`, fallback org |
| Scheduled report email + PDF | `config.emailRecipients` strings | **schedule** locale field, fallback org |
| Web report export (client-side jspdf) | current session | active web locale |
| Invoice / quote / contract PDFs + emails | org contact | **org** language |

---

### Task 1: Org-level language setting + `resolveRecipientLocale`

**Files:**
- Modify: org settings schema/route (org settings PATCH — follow the partner `language` pattern shipped in Phase 2 Task 1: enum-validate `['en','pt-BR']`)
- Modify: `apps/web/src/components/settings/OrgSettingsPage.tsx` (or its regional section) — org Language selector, mirroring `PartnerRegionalTab`
- Create: `apps/api/src/services/recipientLocale.ts`
- Test: `apps/api/src/services/recipientLocale.test.ts`, org route tests

**Interfaces:**
- Consumes: `users.preferences.locale` (Phase 1), `partners.settings.language` (Phase 2 Task 1), new `organizations.settings.language`.
- Produces:

```ts
export type SupportedLocale = 'en' | 'pt-BR';

export async function resolveRecipientLocale(ref: {
  userId?: string;
  orgId?: string;
  partnerId?: string;
  explicit?: unknown;            // channel/schedule config value, checked first
}): Promise<SupportedLocale>;
```

Resolution order: `explicit` (if valid) → user `preferences.locale` → org `settings.language` → partner `settings.language` → `'en'`. Every downstream task calls only this. **DB-context note:** callers in workers run outside a request — the function must work under `withSystemDbAccessContext` (workers) *and* request contexts; take plain ids, do narrow selects, no auth assumptions.

- [ ] Org setting + selector UI + validation (clone the partner pattern end-to-end, including tests)
- [ ] `resolveRecipientLocale` + table-driven tests (each fallback hop, invalid `explicit`, missing rows)
- [ ] Commit: `feat: org-level language + recipient locale resolution`

---### Task 2: API i18n runtime

**Files:**
- Create: `apps/api/src/i18n/index.ts` (plain i18next instance, `initAsync: false`, resources from `import`-ed JSON — API builds with tsup, JSON imports supported)
- Create: `apps/api/src/i18n/locales/en/{emails,pdf,notifications}.json` + pt-BR twins
- Create: `apps/api/src/i18n/localeParity.test.ts` (copy the web's parity test, pointed at this tree)
- Test: `apps/api/src/i18n/i18n.test.ts`

**Interfaces:**
- Produces: `tApi(locale: SupportedLocale, key: string, vars?: Record<string, unknown>): string` — namespaced (`emails:passwordReset.subject`), interpolation + `_one`/`_other` plurals via i18next, en fallback. A fixed instance per call via `i18next.getFixedT(locale)` — **no global language switching**, so concurrent workers can't race.

```ts
const fixed = i18next.getFixedT(locale);
export function tApi(locale: SupportedLocale, key: string, vars?: Record<string, unknown>): string {
  return i18next.getFixedT(locale)(key, vars) as string;
}
```

(Bind per call; `changeLanguage` is never called after init.)

- [ ] Runtime + tests (both locales, fallback, plural, concurrency: two interleaved `tApi` calls with different locales return correct strings)
- [ ] Commit: `feat(api): server i18n runtime with fixed-locale translation`

---

### Task 3: Transactional email templates

**Files:**
- Modify: `apps/api/src/services/email.ts` — all 8 `build*Template(params)` gain a `locale: SupportedLocale` param; subjects/bodies move to `emails.json` keys with `{{var}}` interpolation; `formatTimestamp` (hardcoded `'en-US'`, ~L937) takes the locale
- Modify: `apps/api/src/services/emailLayout.ts` — footer/support strings to keys
- Modify: the 18 send call sites to resolve + thread locale:
  - user-identified paths (`routes/auth/*`, `routes/users.ts`, `accountDeletion`) → `resolveRecipientLocale({ userId })`
  - invites (`routes/users.ts`, `orgPortalUsers.ts`, `portal/auth.ts`, `mcpInvites`) → `resolveRecipientLocale({ partnerId })` / `({ orgId })`
- Test: email.ts co-located tests updated; one snapshot-style test per template per locale (subject + a marker phrase)

**Interfaces:**
- Consumes: `tApi` (Task 2), `resolveRecipientLocale` (Task 1).
- Produces: `buildPasswordResetTemplate({ …, locale })` etc. — signature change is mechanical; TypeScript finds every caller.

- [ ] Convert the 8 core templates (subject, preheader, body paragraphs, button labels → `emails:*` keys; keep `escapeHtml` on all interpolated user content)
- [ ] Localize `formatTimestamp` (locale-aware `toLocaleString(locale === 'pt-BR' ? 'pt-BR' : 'en-US', …)`)
- [ ] Thread locale through the 18 call sites (wave-able: auth cluster, invite cluster, lifecycle cluster)
- [ ] Convert the ad-hoc composers: ticket worker emails (assignee locale), scheduled-report email framing (Task 5 threads its locale), quote/invoice/contract lifecycle emails (org locale). Autoresponse: translate only the *default* template; partner-customized overrides pass through verbatim.
- [ ] Commit per cluster: `feat(api): localize <cluster> emails`

---

### Task 4: Report PDFs (jspdf, shared package)

**Files:**
- Create: `packages/shared/src/reportPdf/strings.ts` — the ~90-110 strings as an `en`/`pt-BR` table local to the package (packages/shared must stay dependency-free of i18next; a typed record + tiny plural helper suffices)
- Modify: `packages/shared/src/reportPdf/reportPdf.ts` — `BuildOpts` gains `locale?: 'en' | 'pt-BR'`; all inline literals (`'Executive Summary'`, `'AT RISK'`, legend labels, `'Recommended actions'`, `` `${count} device${count === 1 ? '' : 's'}` `` at L850/L858…) go through the table; baked-in English plurals become `plural(locale, count, key)`
- Modify: `apps/web/src/components/reports/reportExport.ts` — pass the active web locale
- Modify: `apps/api/src/jobs/reportScheduleWorker.ts` (L221 build call) — pass schedule/org locale (Task 5)
- Test: `packages/shared/src/reportPdf/` co-located tests: string-table parity (en/pt-BR same keys), a build smoke per locale (PDF builds without throwing, text layer contains a pt-BR marker)

**Interfaces:**
- Produces: `buildReportPdf(rows, { …, locale })`; `strings.ts` exports `pdfStrings: Record<SupportedLocale, Record<PdfStringKey, string>>` and `plural(locale, count, oneKey, otherKey)`.

- [ ] String table + parity test → convert `renderGenericReport` → convert the two special covers (posture, executive summary) → thread callers → per-locale smoke
- [ ] Commit: `feat(shared): locale-parameterized report PDFs`

---

### Task 5: Scheduled reports + notification channels

**Files:**
- Modify: report-schedule config schema + UI — optional `locale` on a schedule (default: org language); `reportScheduleWorker.ts` resolves via `resolveRecipientLocale({ explicit: config.locale, orgId })` and threads it to both the PDF (Task 4) and the email framing (Task 3)
- Modify: `notification_channels.config` — optional `locale` field + validation + a dropdown in the channel editor UI
- Modify: `apps/api/src/services/notificationDispatcher.ts` + `notificationSenders/{smsSender,pushoverSender,pagerDutySender,inAppSender}.ts` — the Breeze-authored *framing* fragments only (`on ${deviceName}` connectives, the Slack `payloadTemplate` at dispatcher ~L702, severity labels) → `notifications:*` keys rendered with the channel locale
- Test: dispatcher/sender co-located tests per locale

**Interfaces:**
- Consumes: `resolveRecipientLocale({ explicit: channelConfig.locale, orgId, partnerId })`.
- Explicit non-goal: `alert.title` / `alert.message` / `payload.summary` content (DB-stored, monitor-authored English) passes through untranslated — same carve-out as Phase 3; in-app notification rows likewise store whatever was composed at write time.

- [ ] Schedule locale (config + UI + worker threading) · - [ ] Channel locale (config + UI + validation) · - [ ] Sender framing strings · - [ ] Commit per piece

---

### Task 6: Billing PDFs (pdfkit, customer-facing — highest single-artifact value)

**Files:**
- Modify: `apps/api/src/services/invoicePdf.ts` (~30-40 strings: `'INVOICE'`, `'FROM'`, `'BILL TO'`, `` `Issued: …` ``/`` `Due: …` `` at L240-268, table headers, totals labels) and `quotePdf.ts` (similar) — strings via `tApi(locale, 'pdf:invoice.…')`; dates via locale-aware formatting; currency already amount-driven (verify separator handling for pt-BR display amounts)
- Modify: their callers (invoice/quote lifecycle services + portal download routes) — `resolveRecipientLocale({ orgId })`
- Test: co-located tests per locale (text-content markers)

- [ ] Invoice → Quote → callers → tests → commit: `feat(api): localized invoice and quote PDFs`

---

## Out of scope (terminal list — "Phase 5" does not exist)

- Alert/monitor **content** strings stored in DB rows (needs structured-params redesign; only worth it if pt-BR adoption proves out).
- Docs site, marketing site, GitHub release notes.
- Agent binaries, installer UI, Helper/Viewer desktop apps (separate codebases; consent-UI strings ride the agent roadmap).
- Non-latin-1 locales' PDF font embedding (documented, not built).

## Self-Review Notes

- Every send path in the resolution map was traced in research to its identity source (users row / worker select / raw config strings); the org-level setting is the one genuinely new tenancy surface — it's a settings-blob field like the partner's, not a new table, so no RLS work.
- Type consistency: `SupportedLocale` defined in Task 1, consumed everywhere; `tApi` (Task 2) used by Tasks 3/5/6; `strings.ts` (Task 4) deliberately NOT using `tApi` (shared package stays dependency-free).
- Sequencing: Task 1 → 2 strictly first; 3, 4, 6 independent after that; 5 needs 3+4.
- Estimate: Tasks 1–2 ≈ 1 day; 3 ≈ 1–2 days; 4 ≈ 1 day; 5 ≈ 1–1.5 days; 6 ≈ ½–1 day. Total ≈ **1 week**, cleanly pausable between tasks.
