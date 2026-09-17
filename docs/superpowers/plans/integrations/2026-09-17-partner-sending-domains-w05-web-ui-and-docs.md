---
tracking_issue: LanternOps/breeze#__PARENT__
---
# Partner Sending Domains W05: Web UI and Docs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Plan amendments

Deviations from the spec or from what the upstream plans left behind. Every one
was verified by reading the file cited. Items 1 and 2 were upstream gaps and are
now **RESOLVED** upstream — they are kept, struck through in substance, so the
contract they fixed is visible to the reviewer; the rest are UI decisions
recorded so nobody re-litigates them mid-task.

1. **RESOLVED upstream — `SenderIdentityDto.domain` and `.fromAddress` are now
   populated.** The gap was that W03's `toIdentityDto` mapped only
   `id, stream, sendingDomainId, localPart, displayName, replyTo, updatedAt` and
   cast with `as SenderIdentityDto`, over a query that never joined the domain,
   so neither declared field could be produced. W03 Task 6 now takes
   `toIdentityDto(row, domain)` against a joined `partner_sending_domains` and
   fills both. **What this wave still does, deliberately:** the rendered address
   comes from `fromAddressFor()` in `domainView.ts`, which composes
   `identity.localPart` with the domain row in the SAME response. That is not a
   workaround — the preview has to track the local part and domain the partner is
   editing right now, which no server field can know before the save. The wire
   value is the authority once saved; the form's preview is the authority while
   editing.
2. **RESOLVED upstream — `SendingDomainDto` now carries `statusChangedAt`.**
   The gap was that spec §10's `failed` row says "Retry (inside the window)"
   while the DTO exposed only `createdAt`, `verifiedAt` and `lastCheckedAt`, so
   the client had nothing to measure the 72 h against. W02 Task 3 now declares
   `statusChangedAt: string` (ISO, from a `NOT NULL` column) and W03 Task 6's
   `toDomainDto` fills it. **This wave therefore honours the window:**
   `isInsideRetryWindow(domain, nowMs)` in `domainView.ts` gates the "Try again"
   button, and an expired row shows the failure reason and Remove only. The
   server stays the authority — the 72 h is enforced in `requestDomainCheck`, so
   a click that races the boundary still surfaces the server's error through
   `runAction` like any other failure.
3. **Spec §10 "unsupported → tab hidden" and spec §5.1 "the settings tab
   explains `provider_key_send_only`" contradict each other**, because W03
   returns `supported: false` for both cases (plan lines 3078–3090). They are
   distinguishable by `capability.provider`: `null` for "no provider configured
   on this instance", the provider id for "configured but its key cannot manage
   domains". **Binding rule for this wave: the tab is hidden if and only if the
   `GET` 404s or `capability.provider === null`.** A non-null provider with
   `supported: false` renders the locked card with the
   `provider_key_send_only` explanation.
4. **Spec §10 restricts the DNS records table and "Check now" to `pending`.**
   This wave renders the records table whenever
   `capability.verifiesByDns && domain.dnsRecords.length > 0` (so a verified
   domain can still show what it published, all rows green) and renders
   "Check now" for `pending | verified | at_risk`. A re-check of a verified
   domain is what a partner reaches for after re-publishing a record, the route
   allows it, and it is rate-limited 1/min/domain server-side. This is a
   superset of §10, never a subtraction, and it is what makes the E2E
   deterministic (the button does not appear and disappear with poll timing).
5. **Spec §10 "not eligible → link to the trust page" has no target.** There is
   no partner-facing trust page in `apps/web/src/pages/**` (only
   `pages/admin/trust*`, which is platform-admin). The partner-facing trust
   surface is `TrustProbationBanner`, already mounted for this route at
   `apps/web/src/layouts/DashboardLayout.astro:58`. The locked card therefore
   renders a **"Show verification status"** button that calls
   `dispatchTrustDenied` (`apps/web/src/lib/trustProbation.ts:43`) — the same
   handoff `runAction` performs on a 403 — and falls back to an error toast
   when nothing handles it. No new page, no dead link.
6. **W03's "Assumed from W02" block is stale about
   `normalizeSendingDomain`.** It records
   `normalizeSendingDomain(input: string): string | null` (W03 plan line 97),
   but W02 Task 3 — the wave that defines it — ships
   `{ ok: true; domain: string } | { ok: false; reason: SendingDomainRejection }`
   (W02 plan lines 1003–1005, 1016–1055). **This wave consumes W02's shape**,
   which is the defining one.
7. **`fetchWithAuth` auto-injects `?orgId=`** (`apps/web/src/stores/auth.ts:1335–1343`).
   `/partner/sending-domains` is partner-axis and ignores the parameter, so it
   is harmless — but every call in this wave passes `skipOrgIdInjection: true`
   anyway, so the request URL does not change when the user switches the org
   picker and the E2E `page.route` / `waitForResponse` matchers stay exact.
8. **`SettingsSectionNav` has no `data-testid` on its anchors**
   (`apps/web/src/components/settings/SettingsSectionNav.tsx:73-80`), and
   `e2e-tests/README.md:3` makes `data-testid` the only permitted selector. Task
   10 adds one derived id, `settings-nav-tab-<hash>`, which serves Partner
   Settings and Organization Settings alike.

---

**Goal:** Ship the partner-facing surface for custom sender addresses and the
operator-facing documentation. A trusted partner on an instance with
`EMAIL_DOMAINS_PROVIDER` set can add a domain, copy its DNS records, watch it
verify, choose a sender address per mail stream, send a test message, and remove
the domain — every state of spec §10, in both the DNS (`resend`/`fake`) and the
operator-attested (`static`) variants. A self-hoster reading `apps/docs` can see
the three setups side by side and pick one. With `EMAIL_DOMAINS_PROVIDER` unset —
still the default everywhere — the tab does not appear and nothing changes.

**Architecture:** One typed client module (`lib/api/sendingDomains.ts`) owns
every call to the seven routes of spec §7; each mutation is lexically wrapped in
`runAction` there, so no caller can issue a silent mutation and the
`no-silent-mutations` AST guard is satisfied at the wrapper. One pure view-model
module (`components/settings/sendingDomains/domainView.ts`) turns a
`SendingDomainsListResponse` into the decisions the UI makes — which lock copy,
which failure copy, which record is missing, what the From address is, how fast
to poll — so those decisions are unit-tested without rendering. Five small
presentational components under `components/settings/sendingDomains/` render the
add form, the DNS table, the status banners, the identities form and the test
send. `PartnerSendingDomainTab.tsx` is the only stateful piece: it fetches,
polls, and hands data down. `PartnerSettingsPage.tsx` fetches the capability
best-effort and hides the tab when the instance has no provider.

**Tech Stack:** React 19 islands under Astro, `react-i18next` (namespace
`settings`, 8 shipped locales), Tailwind utility classes copied from the
neighbouring settings cards, Vitest + jsdom + `@testing-library/react`,
Playwright (`data-testid` only) against a `wt-stack` dev stack running the
`fake` provider, Astro Starlight for `apps/docs`.

**Spec:** `docs/superpowers/specs/integrations/2026-09-17-partner-sending-domains-design.md`
— §4.2 (subdomain recommendation and its three reasons), §4.4 (identity rules
and the "where replies go" requirement), §8.3 (Reply-To precedence), §8.5
(no-inbound-configured warning), §10 (the state table this wave implements),
§11 (env var table for the docs page), §13 (the 2-minute provisioning delay
notice, the `static` relay-refusal text), §14 (the E2E bullet and the lab
check), §15 row W05, §16.1 (rollout steps), §16.2 (self-hosted docs bullets).
Plan index: `docs/superpowers/plans/integrations/2026-09-17-partner-sending-domains.md`.

## Global Constraints

Binding for every task. Do not relax one without changing the plan index in the
same PR.

- **UI state lives in `window.location.hash`, never a query parameter.** The new
  tab is reached at `/settings/partner#sending-domains` through the existing
  `HASH_TO_TAB` mechanism (`PartnerSettingsPage.tsx:135-139`). No `?tab=`.
- **Every POST / PUT / DELETE goes through `runAction`**
  (`apps/web/src/lib/runAction.ts`), wrapped lexically inside
  `lib/api/sendingDomains.ts`. Callers use the CLAUDE.md catch pattern:
  `if (err instanceof ActionError && err.status === 401) return;` then
  `if (!(err instanceof ActionError)) showToast({ type: 'error', … })`. The
  repo's `handleActionError(err, fallback)` helper implements exactly that and
  is what this wave calls. **Nothing is added to `runActionAllowlist.ts`.**
- **Every interactive element carries a `data-testid`**, and every E2E query is
  by `data-testid` — no text, role, label or CSS selectors
  (`e2e-tests/README.md:3`, "a hard rule, not a guideline"). Naming scheme:
  `sending-domains-<element>[-<modifier>]` for singletons,
  `sending-domain-row-<domainId>` and `sending-domain-record-<index>` for rows,
  `sending-identity-<stream>-<element>` for the per-stream identity controls.
- **Real translations in every shipped locale.** Eight locales:
  `en, pt-BR, es-419, fr-FR, fr-CA, de-DE, it-IT, tr-TR`. A key that exists in
  `en` and not in the other seven fails
  `apps/web/src/lib/i18n/localeParity.test.ts:457`; a value byte-identical to
  English counts against `translationCoverage.test.ts:990`'s per-namespace
  baseline. Interpolation is `{{name}}` only — single braces are a protected
  literal, not interpolation. Technical literals (`DNS`, `SPF`, `DKIM`,
  `Breeze`, `Reply-To`, `mail.yourcompany.com`, `postmaster`, `abuse`,
  `mailer-daemon`) keep the same occurrence count in every locale.
- **The partner never types a full From address.** The identity form takes a
  local part and a domain chosen from the partner's verified domains; the
  address is composed for display only (spec §4.4).
- **The tab is hidden when the feature is unsupported** — and per plan amendment
  3 that means exactly: the `GET` 404s, or `capability.provider === null`.
- **Branch `feature/__PARENT__-partner-sending-domains/wave-__W05__`; the PR
  body contains `Closes #__W05__`.** `get_feature_status` before starting.
- **Web test command form:** `cd apps/web && npx vitest run <path>`. Never
  `pnpm --filter <pkg> test -- --run <path>` — pnpm forwards the literal `--`,
  vitest swallows `--run`, and the whole suite runs in watch mode. A trailing
  slash on a path filter silently skips sibling files, so list paths explicitly.
- **Commit after every task** with the trailer
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **Rigor is low-ceremony but red-first** (index: "W01 and W05 are wide but
  low-risk: red first, typecheck, affected tests"). Write the failing assertion,
  run it, watch it fail, then implement. No plan/review/subagent ceremony.

---

## File Structure

| Path | Responsibility | Task |
|---|---|---|
| `apps/web/src/locales/{en,pt-BR,es-419,fr-FR,fr-CA,de-DE,it-IT,tr-TR}/settings.json` | `partnerSendingDomains.*` + `partnerSettingsPage.tabs.sendingDomains.*` | 1 |
| `apps/web/src/lib/api/sendingDomains.ts` (+ `.test.ts`) | typed client for the seven routes; every mutation inside `runAction` | 2 |
| `apps/web/src/components/settings/sendingDomains/domainView.ts` (+ `.test.ts`) | pure view-model: lock/failure copy keys, unhealthy record, From address, poll interval, error-code map | 3 |
| `apps/web/src/components/settings/sendingDomains/AddDomainForm.tsx` (+ `.test.ts`) | add-domain form, shared-normaliser validation, subdomain recommendation | 4 |
| `apps/web/src/components/settings/sendingDomains/DnsRecordsTable.tsx` (+ `.test.ts`) | records table, per-record status, copy buttons, 72 h note | 5 |
| `apps/web/src/components/settings/sendingDomains/DomainStatusPanel.tsx` (+ `.test.ts`) | per-domain card: badge, banners, Check now, Retry, Remove, `lastSendError`, `static` note | 6 |
| `apps/web/src/components/settings/sendingDomains/SenderIdentitiesForm.tsx` (+ `.test.ts`) | three streams, suggested local parts, where-replies-go text, save/clear | 7 |
| `apps/web/src/components/settings/sendingDomains/TestSendControl.tsx` (+ `.test.ts`) | test send button + last result | 8 |
| `apps/web/src/components/settings/PartnerSendingDomainTab.tsx` (+ `.test.tsx`) | fetch, poll, capability gating, composition | 9 |
| `apps/web/src/components/settings/PartnerSettingsPage.tsx` | tab registration in the communications group, capability fetch, render | 10 |
| `apps/web/src/components/settings/SettingsSectionNav.tsx` | `data-testid="settings-nav-tab-<hash>"` on the rail anchors | 10 |
| `apps/web/src/components/settings/PartnerSettingsPage.sendingDomains.test.tsx` | page-level mount test | 10 |
| `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` | two `TARGET_GLOBS` entries + the count | 11 |
| `e2e-tests/pages/PartnerSendingDomainsPage.ts` | Playwright page object | 12 |
| `e2e-tests/tests/partner-sending-domains.spec.ts` | Playwright spec | 12 |
| `scripts/dev/wt-stack/env.ts` | `EMAIL_DOMAINS_PROVIDER: 'fake'` for the dev/E2E stack | 12 |
| `.github/workflows/ci.yml` | `EMAIL_DOMAINS_PROVIDER=fake` in the `portal-dev-e2e` `.env`, spec added to the run list | 12 |
| `apps/docs/src/content/docs/deploy/custom-sender-addresses.mdx` | the operator + partner documentation page | 13 |
| `apps/docs/src/content/docs/deploy/environment.mdx` | cross-link at the end of `## Email` | 13 |

`apps/docs/astro.config.mjs` is **not** edited: the Deployment sidebar is
`autogenerate: { directory: 'deploy' }` (`astro.config.mjs:31-34`), so a new
`.mdx` in that directory is the entire sidebar change.

---

## Task 1: Translations for all eight locales

Everything the UI says, in one place, before any component exists. Doing i18n
first means each later component's test can assert real English copy.

**Files:**
- Modify: `apps/web/src/locales/en/settings.json` — add the `partnerSendingDomains` object, and `sendingDomains` inside `partnerSettingsPage.tabs`
- Modify: `apps/web/src/locales/pt-BR/settings.json` — same keys, Brazilian Portuguese
- Modify: `apps/web/src/locales/es-419/settings.json` — same keys, Latin-American Spanish
- Modify: `apps/web/src/locales/fr-FR/settings.json` — same keys, French (France)
- Modify: `apps/web/src/locales/fr-CA/settings.json` — same keys, French (Canada)
- Modify: `apps/web/src/locales/de-DE/settings.json` — same keys, German
- Modify: `apps/web/src/locales/it-IT/settings.json` — same keys, Italian
- Modify: `apps/web/src/locales/tr-TR/settings.json` — same keys, Turkish

**Interfaces:**
- Produces: the `settings:partnerSendingDomains.*` key group and
  `settings:partnerSettingsPage.tabs.sendingDomains.{label,description}`.
- Consumes: nothing. Components in Tasks 4–10 consume these keys.

- [ ] **Step 1: Watch parity fail**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web
npx vitest run src/lib/i18n/localeParity.test.ts
```
Expected: PASS (nothing added yet). This is the baseline — note the run is
green so a failure after Step 2 is attributable.

- [ ] **Step 2: Add the English keys only, and watch parity go red**

In `apps/web/src/locales/en/settings.json`, add `"sendingDomains"` to the
`partnerSettingsPage.tabs` object, immediately after the `"ticketing"` entry:

```json
      "sendingDomains": { "label": "Sender Addresses", "description": "Send email from your own domain" },
```

and add this new top-level section (alphabetical placement is not enforced;
put it immediately after the existing `"partnerSettingsPage"` object):

```json
  "partnerSendingDomains": {
    "title": "Custom sender addresses",
    "description": "Send customer-facing email from your own domain instead of the standard Breeze address.",
    "loadFailed": "We could not load your sending domains.",
    "staticNote": "Sending domains on this server are managed by its mail configuration; SPF and DKIM for them are set up outside Breeze.",
    "staticNotAllowed": "Ask your Breeze administrator to allow this domain.",
    "staticVerifyHint": "This domain becomes usable once your mail server accepts a test message sent from it.",
    "lockedTitle": "Custom sender addresses are not available yet",
    "lockedProbation": "Your account is still being verified. Custom sender addresses unlock once that finishes.",
    "lockedRestricted": "Your account is restricted, so custom sender addresses are unavailable.",
    "lockedNotAllowlisted": "Custom sender addresses are still rolling out and are not switched on for your account yet.",
    "lockedPartnerInactive": "Your account is not active, so custom sender addresses are unavailable.",
    "lockedProviderKeySendOnly": "The email key on this server can send mail but cannot manage domains. Ask your Breeze administrator for a key with full access.",
    "lockedShowVerification": "Show verification status",
    "addTitle": "Add a sending domain",
    "addLabel": "Domain name",
    "addPlaceholder": "mail.yourcompany.com",
    "addSubmit": "Add domain",
    "addInvalid": "Enter a domain such as mail.yourcompany.com.",
    "added": "Domain added. Preparing DNS records.",
    "recommendTitle": "We recommend a dedicated subdomain",
    "recommendReason1": "It keeps the sending reputation of your Breeze mail separate from the rest of your mail.",
    "recommendReason2": "A root domain already verified with our email provider somewhere else cannot be added here — we never take a domain away from another account.",
    "recommendReason3": "Some mail filters flag an outside sender using the recipient's own domain, even when DKIM passes. A subdomain avoids that exact-match rule, which matters most for internal teams whose customers are colleagues.",
    "statusProvisioning": "Preparing DNS records…",
    "statusPending": "Waiting for DNS",
    "statusVerified": "Verified",
    "statusAtRisk": "Needs attention",
    "statusFailed": "Failed",
    "statusSuspended": "Suspended",
    "statusRemoving": "Removing…",
    "provisioningSlow": "This is taking longer than usual. We keep retrying — you can leave this page and come back.",
    "recordsTitle": "Publish these DNS records",
    "recordsNote": "DNS changes can take up to 72 hours to reach us, and we keep checking. If the records are still not visible by then, the domain is marked as failed and you can try again.",
    "recordsType": "Record type",
    "recordsHost": "Host label",
    "recordsFqdn": "Full name",
    "recordsValue": "Value",
    "recordsPriority": "Priority",
    "recordsCopied": "Copied to the clipboard",
    "checkNow": "Check now",
    "checkStarted": "Checking DNS now.",
    "atRiskBanner": "We can no longer see the {{type}} record at {{fqdn}}. Mail still goes out from this domain, but publish that record again within 72 hours or the domain fails.",
    "failedProviderConflict": "This domain may already be registered with Breeze or with our email provider. Use a dedicated subdomain, or contact support.",
    "failedProviderRejected": "Our email provider refused this domain.",
    "failedQuotaExhausted": "This Breeze server has reached its domain limit with the email provider. Contact support.",
    "failedDnsNotDetected": "We could not find the DNS records within 72 hours.",
    "failedDnsRemoved": "The DNS records were removed.",
    "failedUnknown": "Verification did not finish.",
    "retry": "Try again",
    "removeConfirm": "Remove {{domain}}? Email for it goes back to the standard Breeze sender.",
    "removeConfirmUnmanaged": "Remove {{domain}} from Breeze? The domain stays in your email provider account — Breeze never deletes a domain it did not create.",
    "removeStarted": "Removing the domain.",
    "suspendedNotice": "Breeze suspended this domain. Contact support.",
    "lastSendError": "Last delivery problem: {{error}}",
    "identitiesTitle": "Sender addresses",
    "identitiesDescription": "Choose the address each kind of email is sent from. Anything you leave empty keeps the standard Breeze sender.",
    "identitiesNoDomain": "Verify a domain first, then choose sender addresses.",
    "streamSupportName": "Customer support",
    "streamBillingName": "Billing",
    "streamGeneralName": "General notifications",
    "streamSupportMail": "Ticket updates to customers, portal invitations and portal password resets.",
    "streamBillingMail": "Quotes and invoices.",
    "streamGeneralMail": "Scheduled report deliveries.",
    "repliesSupport": "Ticket email sets Reply-To to {{inbound}}, so a customer's reply lands back on the ticket. Portal invitations and password resets set no Reply-To, so those replies go to the address below.",
    "repliesSupportNoInbound": "This server has no inbound email address, so replies to ticket email go to the address below. Make it a mailbox someone reads, or an alias that forwards into Breeze.",
    "repliesBilling": "Quotes and invoices set Reply-To to your billing email, so replies go there.",
    "repliesGeneral": "Nothing here sets its own Reply-To, so replies go to the address below — or to the Reply-To you set.",
    "repliesMailboxHint": "People and auto-responders sometimes answer the From address, so make each one a real mailbox or an alias.",
    "identityDomain": "Verified domain",
    "identityLocalPart": "Address",
    "identityDisplayName": "Display name",
    "identityDisplayNamePlaceholder": "Acme Support",
    "identityReplyTo": "Reply-To address (optional)",
    "identityFrom": "Sends from {{address}}",
    "identityClear": "Use the standard sender",
    "identitySaved": "Sender address saved.",
    "identityCleared": "Back on the standard Breeze sender.",
    "identityLocalPartInvalid": "Use letters, numbers, dots, dashes, plus signs and underscores, and do not start or end with punctuation.",
    "identityLocalPartReserved": "postmaster, abuse and mailer-daemon are reserved.",
    "identityDisplayNameInvalid": "A display name cannot contain an email address or a link.",
    "identityReplyToInvalid": "Enter a complete email address.",
    "testTitle": "Send a test email",
    "testDescription": "We send one message from this domain to your own sign-in address.",
    "testSubmit": "Send test email",
    "testQueued": "Test email queued.",
    "testPending": "Test email in progress…",
    "testLastSent": "Last test sent {{when}}.",
    "testLastFailed": "Last test failed {{when}}: {{error}}",
    "errorDomainUnavailable": "This domain may already be registered with Breeze or with our email provider. Use a dedicated subdomain, or contact support.",
    "errorDomainLimitReached": "You can hold at most {{max}} sending domains. Remove one first.",
    "errorRateLimited": "Too many attempts. Wait a moment and try again.",
    "errorNotFound": "That domain is no longer there. Refresh the page.",
    "errorDomainNotSendable": "That domain is not verified yet, so it cannot be a sender address.",
    "errorUnsupported": "Custom sender addresses are not switched on for this server.",
    "errorAddFailed": "Could not add the domain.",
    "errorCheckFailed": "Could not start a DNS check.",
    "errorRemoveFailed": "Could not remove the domain.",
    "errorIdentityFailed": "Could not save the sender address.",
    "errorTestFailed": "Could not send the test email."
  },
```

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web
npx vitest run src/lib/i18n/localeParity.test.ts
```
Expected: **FAIL** — `namespace settings` key-set mismatch for all seven
non-English locales, naming the `partnerSendingDomains.*` keys and
`partnerSettingsPage.tabs.sendingDomains.*`.

- [ ] **Step 3: pt-BR**

Add to `apps/web/src/locales/pt-BR/settings.json`, in the same two places:

```json
      "sendingDomains": { "label": "Endereços de envio", "description": "Envie e-mails do seu próprio domínio" },
```

```json
  "partnerSendingDomains": {
    "title": "Endereços de remetente personalizados",
    "description": "Envie e-mails para clientes a partir do seu próprio domínio, em vez do endereço padrão do Breeze.",
    "loadFailed": "Não foi possível carregar seus domínios de envio.",
    "staticNote": "Os domínios de envio deste servidor são controlados pela configuração de e-mail dele; SPF e DKIM para eles são definidos fora do Breeze.",
    "staticNotAllowed": "Peça ao administrador do Breeze para liberar este domínio.",
    "staticVerifyHint": "Este domínio passa a funcionar assim que o seu servidor de e-mail aceitar uma mensagem de teste enviada por ele.",
    "lockedTitle": "Endereços de remetente personalizados ainda não estão disponíveis",
    "lockedProbation": "Sua conta ainda está em verificação. Os endereços de remetente personalizados serão liberados quando ela terminar.",
    "lockedRestricted": "Sua conta está restrita, então os endereços de remetente personalizados não estão disponíveis.",
    "lockedNotAllowlisted": "Os endereços de remetente personalizados ainda estão em liberação gradual e não foram ativados para sua conta.",
    "lockedPartnerInactive": "Sua conta não está ativa, então os endereços de remetente personalizados não estão disponíveis.",
    "lockedProviderKeySendOnly": "A chave de e-mail deste servidor consegue enviar mensagens, mas não gerenciar domínios. Peça ao administrador do Breeze uma chave com acesso total.",
    "lockedShowVerification": "Ver situação da verificação",
    "addTitle": "Adicionar um domínio de envio",
    "addLabel": "Nome do domínio",
    "addPlaceholder": "mail.yourcompany.com",
    "addInvalid": "Informe um domínio como mail.yourcompany.com.",
    "addSubmit": "Adicionar domínio",
    "added": "Domínio adicionado. Preparando os registros DNS.",
    "recommendTitle": "Recomendamos um subdomínio dedicado",
    "recommendReason1": "Ele mantém a reputação de envio do seu e-mail do Breeze separada do restante do seu e-mail.",
    "recommendReason2": "Um domínio raiz já verificado em outro lugar com nosso provedor de e-mail não pode ser adicionado aqui — nunca tiramos um domínio de outra conta.",
    "recommendReason3": "Alguns filtros marcam um remetente externo que usa o próprio domínio do destinatário, mesmo quando o DKIM passa. Um subdomínio evita essa regra de correspondência exata, o que importa sobretudo para equipes internas cujos clientes são colegas.",
    "statusProvisioning": "Preparando os registros DNS…",
    "statusPending": "Aguardando o DNS",
    "statusVerified": "Verificado",
    "statusAtRisk": "Precisa de atenção",
    "statusFailed": "Falhou",
    "statusSuspended": "Suspenso",
    "statusRemoving": "Removendo…",
    "provisioningSlow": "Isso está demorando mais que o normal. Continuamos tentando — você pode sair desta página e voltar depois.",
    "recordsTitle": "Publique estes registros DNS",
    "recordsNote": "Alterações de DNS podem levar até 72 horas para chegar até nós, e continuamos verificando. Se os registros ainda não estiverem visíveis até lá, o domínio é marcado como falho e você pode tentar de novo.",
    "recordsType": "Tipo de registro",
    "recordsHost": "Rótulo do host",
    "recordsFqdn": "Nome completo",
    "recordsValue": "Valor",
    "recordsPriority": "Prioridade",
    "recordsCopied": "Copiado para a área de transferência",
    "checkNow": "Verificar agora",
    "checkStarted": "Verificando o DNS agora.",
    "atRiskBanner": "Não encontramos mais o registro {{type}} em {{fqdn}}. O e-mail continua saindo deste domínio, mas publique esse registro de novo em até 72 horas ou o domínio falha.",
    "failedProviderConflict": "Este domínio talvez já esteja registrado no Breeze ou no nosso provedor de e-mail. Use um subdomínio dedicado ou fale com o suporte.",
    "failedProviderRejected": "Nosso provedor de e-mail recusou este domínio.",
    "failedQuotaExhausted": "Este servidor Breeze atingiu o limite de domínios no provedor de e-mail. Fale com o suporte.",
    "failedDnsNotDetected": "Não encontramos os registros DNS em 72 horas.",
    "failedDnsRemoved": "Os registros DNS foram removidos.",
    "failedUnknown": "A verificação não foi concluída.",
    "retry": "Tentar de novo",
    "removeConfirm": "Remover {{domain}}? O e-mail dele volta para o remetente padrão do Breeze.",
    "removeConfirmUnmanaged": "Remover {{domain}} do Breeze? O domínio continua na conta do seu provedor de e-mail — o Breeze nunca apaga um domínio que não criou.",
    "removeStarted": "Removendo o domínio.",
    "suspendedNotice": "O Breeze suspendeu este domínio. Fale com o suporte.",
    "lastSendError": "Último problema de entrega: {{error}}",
    "identitiesTitle": "Endereços de remetente",
    "identitiesDescription": "Escolha de qual endereço cada tipo de e-mail sai. O que você deixar vazio continua no remetente padrão do Breeze.",
    "identitiesNoDomain": "Verifique um domínio primeiro e depois escolha os endereços de remetente.",
    "streamSupportName": "Suporte ao cliente",
    "streamBillingName": "Cobrança",
    "streamGeneralName": "Notificações gerais",
    "streamSupportMail": "Atualizações de chamados para clientes, convites do portal e redefinições de senha do portal.",
    "streamBillingMail": "Orçamentos e faturas.",
    "streamGeneralMail": "Entregas de relatórios agendados.",
    "repliesSupport": "O e-mail de chamados define Reply-To como {{inbound}}, então a resposta do cliente volta para o chamado. Convites do portal e redefinições de senha não definem Reply-To, então essas respostas vão para o endereço abaixo.",
    "repliesSupportNoInbound": "Este servidor não tem endereço de e-mail de entrada, então as respostas ao e-mail de chamados vão para o endereço abaixo. Use uma caixa que alguém leia, ou um alias que encaminhe para o Breeze.",
    "repliesBilling": "Orçamentos e faturas definem Reply-To como seu e-mail de cobrança, então as respostas vão para lá.",
    "repliesGeneral": "Nada aqui define o próprio Reply-To, então as respostas vão para o endereço abaixo — ou para o Reply-To que você definir.",
    "repliesMailboxHint": "Pessoas e respostas automáticas às vezes respondem ao endereço do remetente, então use uma caixa real ou um alias em cada um.",
    "identityDomain": "Domínio verificado",
    "identityLocalPart": "Endereço",
    "identityDisplayName": "Nome exibido",
    "identityDisplayNamePlaceholder": "Acme Support",
    "identityReplyTo": "Endereço de Reply-To (opcional)",
    "identityFrom": "Envia de {{address}}",
    "identityClear": "Usar o remetente padrão",
    "identitySaved": "Endereço de remetente salvo.",
    "identityCleared": "De volta ao remetente padrão do Breeze.",
    "identityLocalPartInvalid": "Use letras, números, pontos, hifens, sinais de mais e sublinhados, e não comece nem termine com pontuação.",
    "identityLocalPartReserved": "postmaster, abuse e mailer-daemon são reservados.",
    "identityDisplayNameInvalid": "O nome exibido não pode conter um endereço de e-mail nem um link.",
    "identityReplyToInvalid": "Informe um endereço de e-mail completo.",
    "testTitle": "Enviar um e-mail de teste",
    "testDescription": "Enviamos uma mensagem deste domínio para o seu próprio endereço de acesso.",
    "testSubmit": "Enviar e-mail de teste",
    "testQueued": "E-mail de teste na fila.",
    "testPending": "E-mail de teste em andamento…",
    "testLastSent": "Último teste enviado em {{when}}.",
    "testLastFailed": "Último teste falhou em {{when}}: {{error}}",
    "errorDomainUnavailable": "Este domínio talvez já esteja registrado no Breeze ou no nosso provedor de e-mail. Use um subdomínio dedicado ou fale com o suporte.",
    "errorDomainLimitReached": "Você pode ter no máximo {{max}} domínios de envio. Remova um primeiro.",
    "errorRateLimited": "Tentativas demais. Espere um momento e tente de novo.",
    "errorNotFound": "Esse domínio não existe mais. Atualize a página.",
    "errorDomainNotSendable": "Esse domínio ainda não foi verificado, então não pode ser um endereço de remetente.",
    "errorUnsupported": "Os endereços de remetente personalizados não estão ativados neste servidor.",
    "errorAddFailed": "Não foi possível adicionar o domínio.",
    "errorCheckFailed": "Não foi possível iniciar a verificação de DNS.",
    "errorRemoveFailed": "Não foi possível remover o domínio.",
    "errorIdentityFailed": "Não foi possível salvar o endereço de remetente.",
    "errorTestFailed": "Não foi possível enviar o e-mail de teste."
  },
```

- [ ] **Step 4: es-419**

```json
      "sendingDomains": { "label": "Direcciones de envío", "description": "Envía correos desde tu propio dominio" },
```

```json
  "partnerSendingDomains": {
    "title": "Direcciones de remitente propias",
    "description": "Envía el correo dirigido a clientes desde tu propio dominio en lugar de la dirección estándar de Breeze.",
    "loadFailed": "No pudimos cargar tus dominios de envío.",
    "staticNote": "Los dominios de envío de este servidor los controla su configuración de correo; SPF y DKIM para ellos se definen fuera de Breeze.",
    "staticNotAllowed": "Pídele al administrador de Breeze que habilite este dominio.",
    "staticVerifyHint": "Este dominio queda utilizable en cuanto tu servidor de correo acepte un mensaje de prueba enviado desde él.",
    "lockedTitle": "Las direcciones de remitente propias aún no están disponibles",
    "lockedProbation": "Tu cuenta todavía está en verificación. Las direcciones de remitente propias se habilitan cuando termine.",
    "lockedRestricted": "Tu cuenta está restringida, así que las direcciones de remitente propias no están disponibles.",
    "lockedNotAllowlisted": "Las direcciones de remitente propias se están habilitando por etapas y aún no están activas en tu cuenta.",
    "lockedPartnerInactive": "Tu cuenta no está activa, así que las direcciones de remitente propias no están disponibles.",
    "lockedProviderKeySendOnly": "La clave de correo de este servidor puede enviar mensajes, pero no administrar dominios. Pídele al administrador de Breeze una clave con acceso total.",
    "lockedShowVerification": "Ver el estado de verificación",
    "addTitle": "Agregar un dominio de envío",
    "addLabel": "Nombre de dominio",
    "addPlaceholder": "mail.yourcompany.com",
    "addInvalid": "Escribe un dominio como mail.yourcompany.com.",
    "addSubmit": "Agregar dominio",
    "added": "Dominio agregado. Preparando los registros DNS.",
    "recommendTitle": "Recomendamos un subdominio dedicado",
    "recommendReason1": "Mantiene la reputación de envío de tu correo de Breeze separada del resto de tu correo.",
    "recommendReason2": "Un dominio raíz ya verificado en otra parte con nuestro proveedor de correo no se puede agregar aquí; nunca le quitamos un dominio a otra cuenta.",
    "recommendReason3": "Algunos filtros marcan a un remitente externo que usa el propio dominio del destinatario, incluso cuando DKIM pasa. Un subdominio evita esa regla de coincidencia exacta, algo que importa sobre todo en equipos internos cuyos clientes son colegas.",
    "statusProvisioning": "Preparando los registros DNS…",
    "statusPending": "Esperando el DNS",
    "statusVerified": "Verificado",
    "statusAtRisk": "Requiere atención",
    "statusFailed": "Falló",
    "statusSuspended": "Suspendido",
    "statusRemoving": "Quitando…",
    "provisioningSlow": "Está tardando más de lo normal. Seguimos reintentando: puedes salir de esta página y volver después.",
    "recordsTitle": "Publica estos registros DNS",
    "recordsNote": "Los cambios de DNS pueden tardar hasta 72 horas en llegarnos, y seguimos revisando. Si para entonces los registros siguen sin verse, el dominio se marca como fallido y puedes intentarlo otra vez.",
    "recordsType": "Tipo de registro",
    "recordsHost": "Etiqueta de host",
    "recordsFqdn": "Nombre completo",
    "recordsValue": "Valor",
    "recordsPriority": "Prioridad",
    "recordsCopied": "Copiado al portapapeles",
    "checkNow": "Revisar ahora",
    "checkStarted": "Revisando el DNS ahora.",
    "atRiskBanner": "Ya no vemos el registro {{type}} en {{fqdn}}. El correo sigue saliendo de este dominio, pero vuelve a publicar ese registro dentro de 72 horas o el dominio falla.",
    "failedProviderConflict": "Puede que este dominio ya esté registrado en Breeze o en nuestro proveedor de correo. Usa un subdominio dedicado o escribe al soporte.",
    "failedProviderRejected": "Nuestro proveedor de correo rechazó este dominio.",
    "failedQuotaExhausted": "Este servidor Breeze llegó a su límite de dominios en el proveedor de correo. Escribe al soporte.",
    "failedDnsNotDetected": "No encontramos los registros DNS en 72 horas.",
    "failedDnsRemoved": "Se quitaron los registros DNS.",
    "failedUnknown": "La verificación no se completó.",
    "retry": "Intentar otra vez",
    "removeConfirm": "¿Quitar {{domain}}? Su correo vuelve al remitente estándar de Breeze.",
    "removeConfirmUnmanaged": "¿Quitar {{domain}} de Breeze? El dominio se queda en la cuenta de tu proveedor de correo: Breeze nunca borra un dominio que no creó.",
    "removeStarted": "Quitando el dominio.",
    "suspendedNotice": "Breeze suspendió este dominio. Escribe al soporte.",
    "lastSendError": "Último problema de entrega: {{error}}",
    "identitiesTitle": "Direcciones de remitente",
    "identitiesDescription": "Elige desde qué dirección sale cada tipo de correo. Lo que dejes vacío se queda con el remitente estándar de Breeze.",
    "identitiesNoDomain": "Verifica un dominio primero y después elige las direcciones de remitente.",
    "streamSupportName": "Soporte al cliente",
    "streamBillingName": "Facturación",
    "streamGeneralName": "Notificaciones generales",
    "streamSupportMail": "Avisos de tickets a clientes, invitaciones al portal y restablecimientos de contraseña del portal.",
    "streamBillingMail": "Cotizaciones y facturas.",
    "streamGeneralMail": "Envíos de informes programados.",
    "repliesSupport": "El correo de tickets fija Reply-To en {{inbound}}, así que la respuesta del cliente vuelve al ticket. Las invitaciones al portal y los restablecimientos de contraseña no fijan Reply-To, así que esas respuestas van a la dirección de abajo.",
    "repliesSupportNoInbound": "Este servidor no tiene dirección de correo entrante, así que las respuestas al correo de tickets van a la dirección de abajo. Que sea un buzón que alguien lea, o un alias que reenvíe a Breeze.",
    "repliesBilling": "Las cotizaciones y facturas fijan Reply-To en tu correo de facturación, así que las respuestas van ahí.",
    "repliesGeneral": "Nada de aquí fija su propio Reply-To, así que las respuestas van a la dirección de abajo, o al Reply-To que definas.",
    "repliesMailboxHint": "Las personas y las respuestas automáticas a veces contestan a la dirección del remitente, así que usa un buzón real o un alias en cada una.",
    "identityDomain": "Dominio verificado",
    "identityLocalPart": "Dirección",
    "identityDisplayName": "Nombre visible",
    "identityDisplayNamePlaceholder": "Acme Support",
    "identityReplyTo": "Dirección de Reply-To (opcional)",
    "identityFrom": "Envía desde {{address}}",
    "identityClear": "Usar el remitente estándar",
    "identitySaved": "Dirección de remitente guardada.",
    "identityCleared": "De vuelta al remitente estándar de Breeze.",
    "identityLocalPartInvalid": "Usa letras, números, puntos, guiones, signos de más y guiones bajos, y no empieces ni termines con un signo de puntuación.",
    "identityLocalPartReserved": "postmaster, abuse y mailer-daemon están reservados.",
    "identityDisplayNameInvalid": "Un nombre visible no puede contener una dirección de correo ni un enlace.",
    "identityReplyToInvalid": "Escribe una dirección de correo completa.",
    "testTitle": "Enviar un correo de prueba",
    "testDescription": "Enviamos un mensaje desde este dominio a tu propia dirección de inicio de sesión.",
    "testSubmit": "Enviar correo de prueba",
    "testQueued": "Correo de prueba en cola.",
    "testPending": "Correo de prueba en curso…",
    "testLastSent": "Última prueba enviada el {{when}}.",
    "testLastFailed": "La última prueba falló el {{when}}: {{error}}",
    "errorDomainUnavailable": "Puede que este dominio ya esté registrado en Breeze o en nuestro proveedor de correo. Usa un subdominio dedicado o escribe al soporte.",
    "errorDomainLimitReached": "Puedes tener como máximo {{max}} dominios de envío. Quita uno primero.",
    "errorRateLimited": "Demasiados intentos. Espera un momento e inténtalo otra vez.",
    "errorNotFound": "Ese dominio ya no está. Actualiza la página.",
    "errorDomainNotSendable": "Ese dominio aún no está verificado, así que no puede ser una dirección de remitente.",
    "errorUnsupported": "Las direcciones de remitente propias no están activadas en este servidor.",
    "errorAddFailed": "No se pudo agregar el dominio.",
    "errorCheckFailed": "No se pudo iniciar la revisión de DNS.",
    "errorRemoveFailed": "No se pudo quitar el dominio.",
    "errorIdentityFailed": "No se pudo guardar la dirección de remitente.",
    "errorTestFailed": "No se pudo enviar el correo de prueba."
  },
```

- [ ] **Step 5: fr-FR**

```json
      "sendingDomains": { "label": "Adresses d'expédition", "description": "Envoyez vos e-mails depuis votre propre domaine" },
```

```json
  "partnerSendingDomains": {
    "title": "Adresses d'expéditeur personnalisées",
    "description": "Envoyez les e-mails destinés aux clients depuis votre propre domaine plutôt que depuis l'adresse Breeze standard.",
    "loadFailed": "Impossible de charger vos domaines d'expédition.",
    "staticNote": "Les domaines d'expédition de ce serveur dépendent de sa configuration de messagerie ; SPF et DKIM pour ces domaines se règlent en dehors de Breeze.",
    "staticNotAllowed": "Demandez à votre administrateur Breeze d'autoriser ce domaine.",
    "staticVerifyHint": "Ce domaine devient utilisable dès que votre serveur de messagerie accepte un message de test envoyé depuis celui-ci.",
    "lockedTitle": "Les adresses d'expéditeur personnalisées ne sont pas encore disponibles",
    "lockedProbation": "Votre compte est encore en cours de vérification. Les adresses d'expéditeur personnalisées seront débloquées à la fin.",
    "lockedRestricted": "Votre compte est restreint, les adresses d'expéditeur personnalisées ne sont donc pas disponibles.",
    "lockedNotAllowlisted": "Les adresses d'expéditeur personnalisées sont déployées progressivement et ne sont pas encore activées sur votre compte.",
    "lockedPartnerInactive": "Votre compte n'est pas actif, les adresses d'expéditeur personnalisées ne sont donc pas disponibles.",
    "lockedProviderKeySendOnly": "La clé de messagerie de ce serveur peut envoyer des messages mais pas gérer des domaines. Demandez à votre administrateur Breeze une clé avec un accès complet.",
    "lockedShowVerification": "Afficher l'état de la vérification",
    "addTitle": "Ajouter un domaine d'expédition",
    "addLabel": "Nom de domaine",
    "addPlaceholder": "mail.yourcompany.com",
    "addInvalid": "Saisissez un domaine tel que mail.yourcompany.com.",
    "addSubmit": "Ajouter le domaine",
    "added": "Domaine ajouté. Préparation des enregistrements DNS.",
    "recommendTitle": "Nous conseillons un sous-domaine dédié",
    "recommendReason1": "Il garde la réputation d'envoi de vos e-mails Breeze séparée du reste de votre messagerie.",
    "recommendReason2": "Un domaine racine déjà vérifié ailleurs chez notre fournisseur d'e-mail ne peut pas être ajouté ici : nous ne retirons jamais un domaine à un autre compte.",
    "recommendReason3": "Certains filtres signalent un expéditeur externe qui utilise le domaine du destinataire, même quand DKIM passe. Un sous-domaine évite cette règle de correspondance exacte, ce qui compte surtout pour les équipes internes dont les clients sont des collègues.",
    "statusProvisioning": "Préparation des enregistrements DNS…",
    "statusPending": "En attente du DNS",
    "statusVerified": "Vérifié",
    "statusAtRisk": "À surveiller",
    "statusFailed": "Échec",
    "statusSuspended": "Suspendu",
    "statusRemoving": "Suppression…",
    "provisioningSlow": "C'est plus long que d'habitude. Nous continuons d'essayer : vous pouvez quitter cette page et revenir plus tard.",
    "recordsTitle": "Publiez ces enregistrements DNS",
    "recordsNote": "Les modifications DNS peuvent mettre jusqu'à 72 heures à nous parvenir, et nous continuons de vérifier. Si les enregistrements restent invisibles passé ce délai, le domaine est marqué en échec et vous pouvez réessayer.",
    "recordsType": "Type d'enregistrement",
    "recordsHost": "Libellé d'hôte",
    "recordsFqdn": "Nom complet",
    "recordsValue": "Valeur",
    "recordsPriority": "Priorité",
    "recordsCopied": "Copié dans le presse-papiers",
    "checkNow": "Vérifier maintenant",
    "checkStarted": "Vérification du DNS en cours.",
    "atRiskBanner": "Nous ne voyons plus l'enregistrement {{type}} sur {{fqdn}}. Les e-mails partent toujours de ce domaine, mais republiez cet enregistrement sous 72 heures, sinon le domaine tombe en échec.",
    "failedProviderConflict": "Ce domaine est peut-être déjà enregistré chez Breeze ou chez notre fournisseur d'e-mail. Utilisez un sous-domaine dédié ou contactez le support.",
    "failedProviderRejected": "Notre fournisseur d'e-mail a refusé ce domaine.",
    "failedQuotaExhausted": "Ce serveur Breeze a atteint sa limite de domaines chez le fournisseur d'e-mail. Contactez le support.",
    "failedDnsNotDetected": "Nous n'avons pas trouvé les enregistrements DNS en 72 heures.",
    "failedDnsRemoved": "Les enregistrements DNS ont été supprimés.",
    "failedUnknown": "La vérification n'a pas abouti.",
    "retry": "Réessayer",
    "removeConfirm": "Supprimer {{domain}} ? Ses e-mails repassent sur l'expéditeur Breeze standard.",
    "removeConfirmUnmanaged": "Retirer {{domain}} de Breeze ? Le domaine reste dans le compte de votre fournisseur d'e-mail : Breeze ne supprime jamais un domaine qu'il n'a pas créé.",
    "removeStarted": "Suppression du domaine en cours.",
    "suspendedNotice": "Breeze a suspendu ce domaine. Contactez le support.",
    "lastSendError": "Dernier problème de remise : {{error}}",
    "identitiesTitle": "Adresses d'expéditeur",
    "identitiesDescription": "Choisissez l'adresse d'où part chaque type d'e-mail. Ce que vous laissez vide reste sur l'expéditeur Breeze standard.",
    "identitiesNoDomain": "Vérifiez d'abord un domaine, puis choisissez les adresses d'expéditeur.",
    "streamSupportName": "Assistance client",
    "streamBillingName": "Facturation",
    "streamGeneralName": "Notifications générales",
    "streamSupportMail": "Mises à jour de tickets aux clients, invitations au portail et réinitialisations de mot de passe du portail.",
    "streamBillingMail": "Devis et factures.",
    "streamGeneralMail": "Envois de rapports planifiés.",
    "repliesSupport": "Les e-mails de tickets définissent Reply-To sur {{inbound}}, donc la réponse d'un client revient sur le ticket. Les invitations au portail et les réinitialisations de mot de passe ne définissent pas de Reply-To : ces réponses partent vers l'adresse ci-dessous.",
    "repliesSupportNoInbound": "Ce serveur n'a pas d'adresse de réception, donc les réponses aux e-mails de tickets vont à l'adresse ci-dessous. Choisissez une boîte que quelqu'un lit, ou un alias qui réachemine vers Breeze.",
    "repliesBilling": "Les devis et les factures définissent Reply-To sur votre e-mail de facturation, les réponses y arrivent donc.",
    "repliesGeneral": "Rien ici ne définit son propre Reply-To : les réponses vont à l'adresse ci-dessous, ou au Reply-To que vous indiquez.",
    "repliesMailboxHint": "Les gens et les réponses automatiques répondent parfois à l'adresse d'expéditeur : faites de chacune une vraie boîte ou un alias.",
    "identityDomain": "Domaine vérifié",
    "identityLocalPart": "Adresse",
    "identityDisplayName": "Nom affiché",
    "identityDisplayNamePlaceholder": "Acme Support",
    "identityReplyTo": "Adresse Reply-To (facultatif)",
    "identityFrom": "Envoie depuis {{address}}",
    "identityClear": "Utiliser l'expéditeur standard",
    "identitySaved": "Adresse d'expéditeur enregistrée.",
    "identityCleared": "Retour à l'expéditeur Breeze standard.",
    "identityLocalPartInvalid": "Utilisez des lettres, des chiffres, des points, des tirets, des plus et des tirets bas, sans commencer ni finir par un signe de ponctuation.",
    "identityLocalPartReserved": "postmaster, abuse et mailer-daemon sont réservés.",
    "identityDisplayNameInvalid": "Un nom affiché ne peut pas contenir une adresse e-mail ni un lien.",
    "identityReplyToInvalid": "Saisissez une adresse e-mail complète.",
    "testTitle": "Envoyer un e-mail de test",
    "testDescription": "Nous envoyons un message depuis ce domaine vers votre propre adresse de connexion.",
    "testSubmit": "Envoyer l'e-mail de test",
    "testQueued": "E-mail de test mis en file.",
    "testPending": "E-mail de test en cours…",
    "testLastSent": "Dernier test envoyé le {{when}}.",
    "testLastFailed": "Dernier test en échec le {{when}} : {{error}}",
    "errorDomainUnavailable": "Ce domaine est peut-être déjà enregistré chez Breeze ou chez notre fournisseur d'e-mail. Utilisez un sous-domaine dédié ou contactez le support.",
    "errorDomainLimitReached": "Vous pouvez détenir au maximum {{max}} domaines d'expédition. Supprimez-en un d'abord.",
    "errorRateLimited": "Trop de tentatives. Patientez un instant et réessayez.",
    "errorNotFound": "Ce domaine n'existe plus. Actualisez la page.",
    "errorDomainNotSendable": "Ce domaine n'est pas encore vérifié, il ne peut donc pas servir d'adresse d'expéditeur.",
    "errorUnsupported": "Les adresses d'expéditeur personnalisées ne sont pas activées sur ce serveur.",
    "errorAddFailed": "Impossible d'ajouter le domaine.",
    "errorCheckFailed": "Impossible de lancer la vérification DNS.",
    "errorRemoveFailed": "Impossible de supprimer le domaine.",
    "errorIdentityFailed": "Impossible d'enregistrer l'adresse d'expéditeur.",
    "errorTestFailed": "Impossible d'envoyer l'e-mail de test."
  },
```

- [ ] **Step 6: fr-CA**

Same keys; Canadian French differs from fr-FR in the wording noted below (it is
not a copy — `translationCoverage` compares each locale against English, and
`localeParity` compares key sets, but a reviewer will read both files).

```json
      "sendingDomains": { "label": "Adresses d'envoi", "description": "Envoyez vos courriels à partir de votre propre domaine" },
```

```json
  "partnerSendingDomains": {
    "title": "Adresses d'expéditeur personnalisées",
    "description": "Envoyez les courriels destinés aux clients à partir de votre propre domaine plutôt que de l'adresse Breeze standard.",
    "loadFailed": "Impossible de charger vos domaines d'envoi.",
    "staticNote": "Les domaines d'envoi de ce serveur relèvent de sa configuration de messagerie; SPF et DKIM pour ces domaines se configurent en dehors de Breeze.",
    "staticNotAllowed": "Demandez à votre administrateur Breeze d'autoriser ce domaine.",
    "staticVerifyHint": "Ce domaine devient utilisable dès que votre serveur de messagerie accepte un message d'essai envoyé à partir de celui-ci.",
    "lockedTitle": "Les adresses d'expéditeur personnalisées ne sont pas encore offertes",
    "lockedProbation": "Votre compte est encore en vérification. Les adresses d'expéditeur personnalisées seront débloquées une fois celle-ci terminée.",
    "lockedRestricted": "Votre compte est restreint; les adresses d'expéditeur personnalisées ne sont donc pas offertes.",
    "lockedNotAllowlisted": "Les adresses d'expéditeur personnalisées sont déployées par étapes et ne sont pas encore activées pour votre compte.",
    "lockedPartnerInactive": "Votre compte n'est pas actif; les adresses d'expéditeur personnalisées ne sont donc pas offertes.",
    "lockedProviderKeySendOnly": "La clé de messagerie de ce serveur peut envoyer des messages, mais pas gérer de domaines. Demandez à votre administrateur Breeze une clé avec accès complet.",
    "lockedShowVerification": "Voir l'état de la vérification",
    "addTitle": "Ajouter un domaine d'envoi",
    "addLabel": "Nom de domaine",
    "addPlaceholder": "mail.yourcompany.com",
    "addInvalid": "Entrez un domaine comme mail.yourcompany.com.",
    "addSubmit": "Ajouter le domaine",
    "added": "Domaine ajouté. Préparation des enregistrements DNS.",
    "recommendTitle": "Nous recommandons un sous-domaine dédié",
    "recommendReason1": "Il garde la réputation d'envoi de vos courriels Breeze à part du reste de votre messagerie.",
    "recommendReason2": "Un domaine racine déjà vérifié ailleurs chez notre fournisseur de courriel ne peut pas être ajouté ici : nous ne retirons jamais un domaine à un autre compte.",
    "recommendReason3": "Certains filtres signalent un expéditeur externe qui se sert du domaine du destinataire, même quand DKIM passe. Un sous-domaine contourne cette règle de correspondance exacte, ce qui compte surtout pour les équipes internes dont les clients sont des collègues.",
    "statusProvisioning": "Préparation des enregistrements DNS…",
    "statusPending": "En attente du DNS",
    "statusVerified": "Vérifié",
    "statusAtRisk": "À surveiller",
    "statusFailed": "Échec",
    "statusSuspended": "Suspendu",
    "statusRemoving": "Retrait…",
    "provisioningSlow": "C'est plus long qu'à l'habitude. Nous continuons d'essayer : vous pouvez quitter cette page et revenir plus tard.",
    "recordsTitle": "Publiez ces enregistrements DNS",
    "recordsNote": "Les changements DNS peuvent prendre jusqu'à 72 heures avant de nous parvenir, et nous continuons de vérifier. Si les enregistrements demeurent invisibles après ce délai, le domaine passe en échec et vous pouvez réessayer.",
    "recordsType": "Type d'enregistrement",
    "recordsHost": "Libellé d'hôte",
    "recordsFqdn": "Nom complet",
    "recordsValue": "Valeur",
    "recordsPriority": "Priorité",
    "recordsCopied": "Copié dans le presse-papiers",
    "checkNow": "Vérifier maintenant",
    "checkStarted": "Vérification du DNS en cours.",
    "atRiskBanner": "Nous ne voyons plus l'enregistrement {{type}} à {{fqdn}}. Les courriels partent encore de ce domaine, mais republiez cet enregistrement d'ici 72 heures, sinon le domaine passe en échec.",
    "failedProviderConflict": "Ce domaine est peut-être déjà inscrit chez Breeze ou chez notre fournisseur de courriel. Servez-vous d'un sous-domaine dédié ou écrivez au soutien technique.",
    "failedProviderRejected": "Notre fournisseur de courriel a refusé ce domaine.",
    "failedQuotaExhausted": "Ce serveur Breeze a atteint sa limite de domaines chez le fournisseur de courriel. Écrivez au soutien technique.",
    "failedDnsNotDetected": "Nous n'avons pas trouvé les enregistrements DNS en 72 heures.",
    "failedDnsRemoved": "Les enregistrements DNS ont été retirés.",
    "failedUnknown": "La vérification ne s'est pas terminée.",
    "retry": "Réessayer",
    "removeConfirm": "Retirer {{domain}}? Ses courriels reviennent à l'expéditeur Breeze standard.",
    "removeConfirmUnmanaged": "Retirer {{domain}} de Breeze? Le domaine demeure dans le compte de votre fournisseur de courriel : Breeze ne supprime jamais un domaine qu'il n'a pas créé.",
    "removeStarted": "Retrait du domaine en cours.",
    "suspendedNotice": "Breeze a suspendu ce domaine. Écrivez au soutien technique.",
    "lastSendError": "Dernier problème de livraison : {{error}}",
    "identitiesTitle": "Adresses d'expéditeur",
    "identitiesDescription": "Choisissez l'adresse d'où part chaque type de courriel. Ce que vous laissez vide demeure sur l'expéditeur Breeze standard.",
    "identitiesNoDomain": "Vérifiez d'abord un domaine, puis choisissez les adresses d'expéditeur.",
    "streamSupportName": "Soutien à la clientèle",
    "streamBillingName": "Facturation",
    "streamGeneralName": "Notifications générales",
    "streamSupportMail": "Mises à jour de billets aux clients, invitations au portail et réinitialisations de mot de passe du portail.",
    "streamBillingMail": "Soumissions et factures.",
    "streamGeneralMail": "Envois de rapports planifiés.",
    "repliesSupport": "Le courriel de billets fixe Reply-To à {{inbound}}, de sorte que la réponse d'un client revient au billet. Les invitations au portail et les réinitialisations de mot de passe ne fixent pas de Reply-To : ces réponses vont à l'adresse ci-dessous.",
    "repliesSupportNoInbound": "Ce serveur n'a pas d'adresse de réception, alors les réponses au courriel de billets vont à l'adresse ci-dessous. Prenez une boîte que quelqu'un lit, ou un alias qui réachemine vers Breeze.",
    "repliesBilling": "Les soumissions et les factures fixent Reply-To à votre courriel de facturation; les réponses s'y rendent donc.",
    "repliesGeneral": "Rien ici ne fixe son propre Reply-To : les réponses vont à l'adresse ci-dessous, ou au Reply-To que vous indiquez.",
    "repliesMailboxHint": "Les gens et les réponses automatiques répondent parfois à l'adresse d'expéditeur : faites de chacune une vraie boîte ou un alias.",
    "identityDomain": "Domaine vérifié",
    "identityLocalPart": "Adresse",
    "identityDisplayName": "Nom affiché",
    "identityDisplayNamePlaceholder": "Acme Support",
    "identityReplyTo": "Adresse Reply-To (facultatif)",
    "identityFrom": "Envoie à partir de {{address}}",
    "identityClear": "Utiliser l'expéditeur standard",
    "identitySaved": "Adresse d'expéditeur enregistrée.",
    "identityCleared": "Retour à l'expéditeur Breeze standard.",
    "identityLocalPartInvalid": "Servez-vous de lettres, de chiffres, de points, de traits d'union, de plus et de traits soulignés, sans commencer ni terminer par un signe de ponctuation.",
    "identityLocalPartReserved": "postmaster, abuse et mailer-daemon sont réservés.",
    "identityDisplayNameInvalid": "Un nom affiché ne peut pas contenir d'adresse courriel ni de lien.",
    "identityReplyToInvalid": "Entrez une adresse courriel complète.",
    "testTitle": "Envoyer un courriel d'essai",
    "testDescription": "Nous envoyons un message à partir de ce domaine vers votre propre adresse de connexion.",
    "testSubmit": "Envoyer le courriel d'essai",
    "testQueued": "Courriel d'essai mis en file.",
    "testPending": "Courriel d'essai en cours…",
    "testLastSent": "Dernier essai envoyé le {{when}}.",
    "testLastFailed": "Dernier essai en échec le {{when}} : {{error}}",
    "errorDomainUnavailable": "Ce domaine est peut-être déjà inscrit chez Breeze ou chez notre fournisseur de courriel. Servez-vous d'un sous-domaine dédié ou écrivez au soutien technique.",
    "errorDomainLimitReached": "Vous pouvez détenir au plus {{max}} domaines d'envoi. Retirez-en un d'abord.",
    "errorRateLimited": "Trop de tentatives. Attendez un moment et réessayez.",
    "errorNotFound": "Ce domaine n'existe plus. Actualisez la page.",
    "errorDomainNotSendable": "Ce domaine n'est pas encore vérifié; il ne peut donc pas servir d'adresse d'expéditeur.",
    "errorUnsupported": "Les adresses d'expéditeur personnalisées ne sont pas activées sur ce serveur.",
    "errorAddFailed": "Impossible d'ajouter le domaine.",
    "errorCheckFailed": "Impossible de lancer la vérification DNS.",
    "errorRemoveFailed": "Impossible de retirer le domaine.",
    "errorIdentityFailed": "Impossible d'enregistrer l'adresse d'expéditeur.",
    "errorTestFailed": "Impossible d'envoyer le courriel d'essai."
  },
```

- [ ] **Step 7: de-DE**

```json
      "sendingDomains": { "label": "Absenderadressen", "description": "E-Mails von Ihrer eigenen Domain senden" },
```

```json
  "partnerSendingDomains": {
    "title": "Eigene Absenderadressen",
    "description": "Versenden Sie kundengerichtete E-Mails von Ihrer eigenen Domain statt von der Standardadresse von Breeze.",
    "loadFailed": "Ihre Versanddomains konnten nicht geladen werden.",
    "staticNote": "Versanddomains auf diesem Server steuert dessen Mail-Konfiguration; SPF und DKIM dafür werden außerhalb von Breeze eingerichtet.",
    "staticNotAllowed": "Bitten Sie Ihre Breeze-Administration, diese Domain freizugeben.",
    "staticVerifyHint": "Diese Domain ist nutzbar, sobald Ihr Mailserver eine von ihr gesendete Testnachricht annimmt.",
    "lockedTitle": "Eigene Absenderadressen stehen noch nicht bereit",
    "lockedProbation": "Ihr Konto wird noch geprüft. Eigene Absenderadressen werden freigeschaltet, sobald das abgeschlossen ist.",
    "lockedRestricted": "Ihr Konto ist eingeschränkt, daher stehen eigene Absenderadressen nicht bereit.",
    "lockedNotAllowlisted": "Eigene Absenderadressen werden schrittweise ausgerollt und sind für Ihr Konto noch nicht freigeschaltet.",
    "lockedPartnerInactive": "Ihr Konto ist nicht aktiv, daher stehen eigene Absenderadressen nicht bereit.",
    "lockedProviderKeySendOnly": "Der Mail-Schlüssel dieses Servers kann Nachrichten senden, aber keine Domains verwalten. Bitten Sie Ihre Breeze-Administration um einen Schlüssel mit vollem Zugriff.",
    "lockedShowVerification": "Prüfstatus anzeigen",
    "addTitle": "Versanddomain hinzufügen",
    "addLabel": "Domainname",
    "addPlaceholder": "mail.yourcompany.com",
    "addInvalid": "Geben Sie eine Domain wie mail.yourcompany.com ein.",
    "addSubmit": "Domain hinzufügen",
    "added": "Domain hinzugefügt. DNS-Einträge werden vorbereitet.",
    "recommendTitle": "Wir empfehlen eine eigene Subdomain",
    "recommendReason1": "Sie hält den Versandruf Ihrer Breeze-Mails getrennt vom Rest Ihrer Mail.",
    "recommendReason2": "Eine Root-Domain, die anderswo bei unserem E-Mail-Anbieter bereits verifiziert ist, lässt sich hier nicht hinzufügen — wir nehmen niemals einem anderen Konto eine Domain weg.",
    "recommendReason3": "Manche Mailfilter markieren einen externen Absender, der die eigene Domain des Empfängers verwendet, selbst wenn DKIM besteht. Eine Subdomain umgeht diese Regel der exakten Übereinstimmung, was vor allem für interne Teams zählt, deren Kunden Kolleginnen und Kollegen sind.",
    "statusProvisioning": "DNS-Einträge werden vorbereitet…",
    "statusPending": "Warten auf DNS",
    "statusVerified": "Verifiziert",
    "statusAtRisk": "Benötigt Aufmerksamkeit",
    "statusFailed": "Fehlgeschlagen",
    "statusSuspended": "Ausgesetzt",
    "statusRemoving": "Wird entfernt…",
    "provisioningSlow": "Das dauert länger als üblich. Wir versuchen es weiter — Sie können diese Seite verlassen und später zurückkommen.",
    "recordsTitle": "Veröffentlichen Sie diese DNS-Einträge",
    "recordsNote": "DNS-Änderungen können bis zu 72 Stunden brauchen, bis sie bei uns ankommen, und wir prüfen laufend weiter. Sind die Einträge bis dahin nicht sichtbar, gilt die Domain als fehlgeschlagen und Sie können es erneut versuchen.",
    "recordsType": "Eintragstyp",
    "recordsHost": "Host-Bezeichnung",
    "recordsFqdn": "Vollständiger Name",
    "recordsValue": "Wert",
    "recordsPriority": "Priorität",
    "recordsCopied": "In die Zwischenablage kopiert",
    "checkNow": "Jetzt prüfen",
    "checkStarted": "DNS wird jetzt geprüft.",
    "atRiskBanner": "Wir sehen den {{type}}-Eintrag unter {{fqdn}} nicht mehr. Mail geht weiter von dieser Domain hinaus, veröffentlichen Sie den Eintrag aber innerhalb von 72 Stunden erneut, sonst schlägt die Domain fehl.",
    "failedProviderConflict": "Diese Domain ist womöglich bereits bei Breeze oder bei unserem E-Mail-Anbieter registriert. Verwenden Sie eine eigene Subdomain oder wenden Sie sich an den Support.",
    "failedProviderRejected": "Unser E-Mail-Anbieter hat diese Domain abgelehnt.",
    "failedQuotaExhausted": "Dieser Breeze-Server hat sein Domain-Limit beim E-Mail-Anbieter erreicht. Wenden Sie sich an den Support.",
    "failedDnsNotDetected": "Wir haben die DNS-Einträge innerhalb von 72 Stunden nicht gefunden.",
    "failedDnsRemoved": "Die DNS-Einträge wurden entfernt.",
    "failedUnknown": "Die Prüfung wurde nicht abgeschlossen.",
    "retry": "Erneut versuchen",
    "removeConfirm": "{{domain}} entfernen? Mail dafür geht wieder über den Standardabsender von Breeze.",
    "removeConfirmUnmanaged": "{{domain}} aus Breeze entfernen? Die Domain bleibt im Konto Ihres E-Mail-Anbieters — Breeze löscht nie eine Domain, die es nicht selbst angelegt hat.",
    "removeStarted": "Die Domain wird entfernt.",
    "suspendedNotice": "Breeze hat diese Domain ausgesetzt. Wenden Sie sich an den Support.",
    "lastSendError": "Letztes Zustellproblem: {{error}}",
    "identitiesTitle": "Absenderadressen",
    "identitiesDescription": "Legen Sie fest, von welcher Adresse jede Art von E-Mail ausgeht. Was Sie leer lassen, bleibt beim Standardabsender von Breeze.",
    "identitiesNoDomain": "Verifizieren Sie zuerst eine Domain und wählen Sie dann Absenderadressen.",
    "streamSupportName": "Kundensupport",
    "streamBillingName": "Abrechnung",
    "streamGeneralName": "Allgemeine Benachrichtigungen",
    "streamSupportMail": "Ticket-Updates an Kunden, Portal-Einladungen und Portal-Passwortzurücksetzungen.",
    "streamBillingMail": "Angebote und Rechnungen.",
    "streamGeneralMail": "Zustellungen geplanter Berichte.",
    "repliesSupport": "Ticket-Mail setzt Reply-To auf {{inbound}}, sodass die Antwort eines Kunden wieder am Ticket landet. Portal-Einladungen und Passwortzurücksetzungen setzen kein Reply-To, ihre Antworten gehen also an die Adresse unten.",
    "repliesSupportNoInbound": "Dieser Server hat keine Eingangsadresse, daher gehen Antworten auf Ticket-Mail an die Adresse unten. Nehmen Sie ein Postfach, das jemand liest, oder einen Alias, der nach Breeze weiterleitet.",
    "repliesBilling": "Angebote und Rechnungen setzen Reply-To auf Ihre Abrechnungsadresse, Antworten gehen also dorthin.",
    "repliesGeneral": "Hier setzt nichts ein eigenes Reply-To, Antworten gehen also an die Adresse unten — oder an das Reply-To, das Sie festlegen.",
    "repliesMailboxHint": "Menschen und automatische Antworten antworten manchmal an die Absenderadresse, machen Sie daraus also je ein echtes Postfach oder einen Alias.",
    "identityDomain": "Verifizierte Domain",
    "identityLocalPart": "Adresse",
    "identityDisplayName": "Anzeigename",
    "identityDisplayNamePlaceholder": "Acme Support",
    "identityReplyTo": "Reply-To-Adresse (optional)",
    "identityFrom": "Sendet von {{address}}",
    "identityClear": "Standardabsender verwenden",
    "identitySaved": "Absenderadresse gespeichert.",
    "identityCleared": "Zurück beim Standardabsender von Breeze.",
    "identityLocalPartInvalid": "Verwenden Sie Buchstaben, Ziffern, Punkte, Bindestriche, Pluszeichen und Unterstriche, und beginnen oder enden Sie nicht mit einem Satzzeichen.",
    "identityLocalPartReserved": "postmaster, abuse und mailer-daemon sind reserviert.",
    "identityDisplayNameInvalid": "Ein Anzeigename darf keine E-Mail-Adresse und keinen Link enthalten.",
    "identityReplyToInvalid": "Geben Sie eine vollständige E-Mail-Adresse ein.",
    "testTitle": "Test-E-Mail senden",
    "testDescription": "Wir senden eine Nachricht von dieser Domain an Ihre eigene Anmeldeadresse.",
    "testSubmit": "Test-E-Mail senden",
    "testQueued": "Test-E-Mail eingereiht.",
    "testPending": "Test-E-Mail läuft…",
    "testLastSent": "Letzter Test gesendet am {{when}}.",
    "testLastFailed": "Letzter Test fehlgeschlagen am {{when}}: {{error}}",
    "errorDomainUnavailable": "Diese Domain ist womöglich bereits bei Breeze oder bei unserem E-Mail-Anbieter registriert. Verwenden Sie eine eigene Subdomain oder wenden Sie sich an den Support.",
    "errorDomainLimitReached": "Sie können höchstens {{max}} Versanddomains halten. Entfernen Sie zuerst eine.",
    "errorRateLimited": "Zu viele Versuche. Warten Sie einen Moment und versuchen Sie es erneut.",
    "errorNotFound": "Diese Domain gibt es nicht mehr. Laden Sie die Seite neu.",
    "errorDomainNotSendable": "Diese Domain ist noch nicht verifiziert und kann daher keine Absenderadresse sein.",
    "errorUnsupported": "Eigene Absenderadressen sind auf diesem Server nicht eingeschaltet.",
    "errorAddFailed": "Die Domain konnte nicht hinzugefügt werden.",
    "errorCheckFailed": "Die DNS-Prüfung konnte nicht gestartet werden.",
    "errorRemoveFailed": "Die Domain konnte nicht entfernt werden.",
    "errorIdentityFailed": "Die Absenderadresse konnte nicht gespeichert werden.",
    "errorTestFailed": "Die Test-E-Mail konnte nicht gesendet werden."
  },
```

- [ ] **Step 8: it-IT**

```json
      "sendingDomains": { "label": "Indirizzi mittente", "description": "Invia email dal tuo dominio" },
```

```json
  "partnerSendingDomains": {
    "title": "Indirizzi mittente personalizzati",
    "description": "Invia le email dirette ai clienti dal tuo dominio invece che dall'indirizzo standard di Breeze.",
    "loadFailed": "Non è stato possibile caricare i tuoi domini di invio.",
    "staticNote": "I domini di invio di questo server dipendono dalla sua configurazione di posta; SPF e DKIM per quei domini si impostano fuori da Breeze.",
    "staticNotAllowed": "Chiedi all'amministratore Breeze di autorizzare questo dominio.",
    "staticVerifyHint": "Questo dominio diventa utilizzabile appena il tuo server di posta accetta un messaggio di prova inviato da esso.",
    "lockedTitle": "Gli indirizzi mittente personalizzati non sono ancora disponibili",
    "lockedProbation": "Il tuo account è ancora in verifica. Gli indirizzi mittente personalizzati si sbloccano al termine.",
    "lockedRestricted": "Il tuo account è limitato, quindi gli indirizzi mittente personalizzati non sono disponibili.",
    "lockedNotAllowlisted": "Gli indirizzi mittente personalizzati sono in rilascio graduale e non sono ancora attivi sul tuo account.",
    "lockedPartnerInactive": "Il tuo account non è attivo, quindi gli indirizzi mittente personalizzati non sono disponibili.",
    "lockedProviderKeySendOnly": "La chiave di posta di questo server può inviare messaggi ma non gestire domini. Chiedi all'amministratore Breeze una chiave con accesso completo.",
    "lockedShowVerification": "Mostra lo stato della verifica",
    "addTitle": "Aggiungi un dominio di invio",
    "addLabel": "Nome dominio",
    "addPlaceholder": "mail.yourcompany.com",
    "addInvalid": "Inserisci un dominio come mail.yourcompany.com.",
    "addSubmit": "Aggiungi dominio",
    "added": "Dominio aggiunto. Preparazione dei record DNS.",
    "recommendTitle": "Consigliamo un sottodominio dedicato",
    "recommendReason1": "Tiene la reputazione di invio della posta Breeze separata dal resto della tua posta.",
    "recommendReason2": "Un dominio radice già verificato altrove presso il nostro fornitore di posta non può essere aggiunto qui: non togliamo mai un dominio a un altro account.",
    "recommendReason3": "Alcuni filtri segnalano un mittente esterno che usa il dominio del destinatario, anche quando DKIM passa. Un sottodominio evita quella regola di corrispondenza esatta, cosa che conta soprattutto per i team interni i cui clienti sono colleghi.",
    "statusProvisioning": "Preparazione dei record DNS…",
    "statusPending": "In attesa del DNS",
    "statusVerified": "Verificato",
    "statusAtRisk": "Richiede attenzione",
    "statusFailed": "Non riuscito",
    "statusSuspended": "Sospeso",
    "statusRemoving": "Rimozione…",
    "provisioningSlow": "Sta impiegando più del solito. Continuiamo a riprovare: puoi lasciare questa pagina e tornare più tardi.",
    "recordsTitle": "Pubblica questi record DNS",
    "recordsNote": "Le modifiche DNS possono impiegare fino a 72 ore ad arrivare da noi, e noi continuiamo a controllare. Se a quel punto i record non sono ancora visibili, il dominio viene segnato come non riuscito e puoi riprovare.",
    "recordsType": "Tipo di record",
    "recordsHost": "Etichetta host",
    "recordsFqdn": "Nome completo",
    "recordsValue": "Valore",
    "recordsPriority": "Priorità",
    "recordsCopied": "Copiato negli appunti",
    "checkNow": "Controlla adesso",
    "checkStarted": "Controllo del DNS in corso.",
    "atRiskBanner": "Non vediamo più il record {{type}} su {{fqdn}}. La posta continua a partire da questo dominio, ma ripubblica quel record entro 72 ore o il dominio fallisce.",
    "failedProviderConflict": "Questo dominio potrebbe essere già registrato su Breeze o presso il nostro fornitore di posta. Usa un sottodominio dedicato oppure scrivi all'assistenza.",
    "failedProviderRejected": "Il nostro fornitore di posta ha rifiutato questo dominio.",
    "failedQuotaExhausted": "Questo server Breeze ha raggiunto il limite di domini presso il fornitore di posta. Scrivi all'assistenza.",
    "failedDnsNotDetected": "Non abbiamo trovato i record DNS entro 72 ore.",
    "failedDnsRemoved": "I record DNS sono stati rimossi.",
    "failedUnknown": "La verifica non si è conclusa.",
    "retry": "Riprova",
    "removeConfirm": "Rimuovere {{domain}}? La sua posta torna al mittente standard di Breeze.",
    "removeConfirmUnmanaged": "Rimuovere {{domain}} da Breeze? Il dominio resta nell'account del tuo fornitore di posta: Breeze non elimina mai un dominio che non ha creato.",
    "removeStarted": "Rimozione del dominio in corso.",
    "suspendedNotice": "Breeze ha sospeso questo dominio. Scrivi all'assistenza.",
    "lastSendError": "Ultimo problema di consegna: {{error}}",
    "identitiesTitle": "Indirizzi mittente",
    "identitiesDescription": "Scegli da quale indirizzo parte ogni tipo di email. Quello che lasci vuoto resta sul mittente standard di Breeze.",
    "identitiesNoDomain": "Verifica prima un dominio, poi scegli gli indirizzi mittente.",
    "streamSupportName": "Assistenza clienti",
    "streamBillingName": "Fatturazione",
    "streamGeneralName": "Notifiche generali",
    "streamSupportMail": "Aggiornamenti dei ticket ai clienti, inviti al portale e reimpostazioni password del portale.",
    "streamBillingMail": "Preventivi e fatture.",
    "streamGeneralMail": "Invii di report pianificati.",
    "repliesSupport": "La posta dei ticket imposta Reply-To su {{inbound}}, così la risposta di un cliente torna sul ticket. Gli inviti al portale e le reimpostazioni password non impostano Reply-To, quindi quelle risposte vanno all'indirizzo qui sotto.",
    "repliesSupportNoInbound": "Questo server non ha un indirizzo di posta in entrata, quindi le risposte alla posta dei ticket vanno all'indirizzo qui sotto. Usa una casella che qualcuno legge, o un alias che inoltra dentro Breeze.",
    "repliesBilling": "Preventivi e fatture impostano Reply-To sulla tua email di fatturazione, quindi le risposte arrivano lì.",
    "repliesGeneral": "Qui nulla imposta un proprio Reply-To, quindi le risposte vanno all'indirizzo qui sotto, o al Reply-To che imposti.",
    "repliesMailboxHint": "Le persone e i risponditori automatici a volte rispondono all'indirizzo del mittente, quindi rendi ciascuno una casella vera o un alias.",
    "identityDomain": "Dominio verificato",
    "identityLocalPart": "Indirizzo",
    "identityDisplayName": "Nome visualizzato",
    "identityDisplayNamePlaceholder": "Acme Support",
    "identityReplyTo": "Indirizzo Reply-To (facoltativo)",
    "identityFrom": "Invia da {{address}}",
    "identityClear": "Usa il mittente standard",
    "identitySaved": "Indirizzo mittente salvato.",
    "identityCleared": "Di nuovo sul mittente standard di Breeze.",
    "identityLocalPartInvalid": "Usa lettere, numeri, punti, trattini, segni più e trattini bassi, e non iniziare né finire con un segno di punteggiatura.",
    "identityLocalPartReserved": "postmaster, abuse e mailer-daemon sono riservati.",
    "identityDisplayNameInvalid": "Un nome visualizzato non può contenere un indirizzo email né un link.",
    "identityReplyToInvalid": "Inserisci un indirizzo email completo.",
    "testTitle": "Invia un'email di prova",
    "testDescription": "Inviamo un messaggio da questo dominio al tuo indirizzo di accesso.",
    "testSubmit": "Invia email di prova",
    "testQueued": "Email di prova in coda.",
    "testPending": "Email di prova in corso…",
    "testLastSent": "Ultima prova inviata il {{when}}.",
    "testLastFailed": "Ultima prova non riuscita il {{when}}: {{error}}",
    "errorDomainUnavailable": "Questo dominio potrebbe essere già registrato su Breeze o presso il nostro fornitore di posta. Usa un sottodominio dedicato oppure scrivi all'assistenza.",
    "errorDomainLimitReached": "Puoi avere al massimo {{max}} domini di invio. Rimuovine uno prima.",
    "errorRateLimited": "Troppi tentativi. Aspetta un momento e riprova.",
    "errorNotFound": "Quel dominio non c'è più. Aggiorna la pagina.",
    "errorDomainNotSendable": "Quel dominio non è ancora verificato, quindi non può essere un indirizzo mittente.",
    "errorUnsupported": "Gli indirizzi mittente personalizzati non sono attivi su questo server.",
    "errorAddFailed": "Non è stato possibile aggiungere il dominio.",
    "errorCheckFailed": "Non è stato possibile avviare il controllo DNS.",
    "errorRemoveFailed": "Non è stato possibile rimuovere il dominio.",
    "errorIdentityFailed": "Non è stato possibile salvare l'indirizzo mittente.",
    "errorTestFailed": "Non è stato possibile inviare l'email di prova."
  },
```

- [ ] **Step 9: tr-TR**

```json
      "sendingDomains": { "label": "Gönderen adresleri", "description": "E-postaları kendi alan adınızdan gönderin" },
```

```json
  "partnerSendingDomains": {
    "title": "Özel gönderen adresleri",
    "description": "Müşterilere giden e-postaları Breeze'in standart adresi yerine kendi alan adınızdan gönderin.",
    "loadFailed": "Gönderim alan adlarınız yüklenemedi.",
    "staticNote": "Bu sunucudaki gönderim alan adlarını sunucunun posta yapılandırması yönetir; bunlar için SPF ve DKIM Breeze dışında kurulur.",
    "staticNotAllowed": "Bu alan adına izin vermesi için Breeze yöneticinize başvurun.",
    "staticVerifyHint": "Bu alan adı, posta sunucunuz ondan gönderilen bir deneme iletisini kabul ettiği anda kullanılabilir olur.",
    "lockedTitle": "Özel gönderen adresleri henüz kullanılamıyor",
    "lockedProbation": "Hesabınız hâlâ doğrulanıyor. Özel gönderen adresleri doğrulama bitince açılır.",
    "lockedRestricted": "Hesabınız kısıtlı olduğundan özel gönderen adresleri kullanılamıyor.",
    "lockedNotAllowlisted": "Özel gönderen adresleri aşamalı olarak açılıyor ve hesabınızda henüz etkin değil.",
    "lockedPartnerInactive": "Hesabınız etkin olmadığından özel gönderen adresleri kullanılamıyor.",
    "lockedProviderKeySendOnly": "Bu sunucudaki posta anahtarı ileti gönderebilir ama alan adı yönetemez. Breeze yöneticinizden tam erişimli bir anahtar isteyin.",
    "lockedShowVerification": "Doğrulama durumunu göster",
    "addTitle": "Gönderim alan adı ekle",
    "addLabel": "Alan adı",
    "addPlaceholder": "mail.yourcompany.com",
    "addInvalid": "mail.yourcompany.com gibi bir alan adı girin.",
    "addSubmit": "Alan adı ekle",
    "added": "Alan adı eklendi. DNS kayıtları hazırlanıyor.",
    "recommendTitle": "Ayrı bir alt alan adı öneriyoruz",
    "recommendReason1": "Breeze postanızın gönderim itibarını diğer postalarınızdan ayrı tutar.",
    "recommendReason2": "Başka bir yerde e-posta sağlayıcımızda zaten doğrulanmış bir kök alan adı buraya eklenemez — başka bir hesaptan asla alan adı almayız.",
    "recommendReason3": "Bazı posta filtreleri, DKIM geçse bile alıcının kendi alan adını kullanan dış gönderenleri işaretler. Alt alan adı bu birebir eşleşme kuralını aşar; bu da müşterileri kendi çalışma arkadaşları olan iç ekipler için en çok önem taşır.",
    "statusProvisioning": "DNS kayıtları hazırlanıyor…",
    "statusPending": "DNS bekleniyor",
    "statusVerified": "Doğrulandı",
    "statusAtRisk": "İlgi gerekiyor",
    "statusFailed": "Başarısız",
    "statusSuspended": "Askıya alındı",
    "statusRemoving": "Kaldırılıyor…",
    "provisioningSlow": "Bu her zamankinden uzun sürüyor. Denemeyi sürdürüyoruz — bu sayfadan ayrılıp sonra geri dönebilirsiniz.",
    "recordsTitle": "Bu DNS kayıtlarını yayımlayın",
    "recordsNote": "DNS değişikliklerinin bize ulaşması 72 saati bulabilir ve biz denetlemeyi sürdürürüz. Kayıtlar o süre sonunda hâlâ görünmüyorsa alan adı başarısız olarak işaretlenir ve yeniden deneyebilirsiniz.",
    "recordsType": "Kayıt türü",
    "recordsHost": "Ana bilgisayar etiketi",
    "recordsFqdn": "Tam ad",
    "recordsValue": "Değer",
    "recordsPriority": "Öncelik",
    "recordsCopied": "Panoya kopyalandı",
    "checkNow": "Şimdi denetle",
    "checkStarted": "DNS şimdi denetleniyor.",
    "atRiskBanner": "{{fqdn}} adresindeki {{type}} kaydını artık göremiyoruz. Posta bu alan adından çıkmayı sürdürüyor, ancak o kaydı 72 saat içinde yeniden yayımlayın, yoksa alan adı başarısız olur.",
    "failedProviderConflict": "Bu alan adı Breeze'de veya e-posta sağlayıcımızda kayıtlı olabilir. Ayrı bir alt alan adı kullanın ya da destek ekibine yazın.",
    "failedProviderRejected": "E-posta sağlayıcımız bu alan adını reddetti.",
    "failedQuotaExhausted": "Bu Breeze sunucusu e-posta sağlayıcısındaki alan adı sınırına ulaştı. Destek ekibine yazın.",
    "failedDnsNotDetected": "DNS kayıtlarını 72 saat içinde bulamadık.",
    "failedDnsRemoved": "DNS kayıtları kaldırıldı.",
    "failedUnknown": "Doğrulama tamamlanmadı.",
    "retry": "Yeniden dene",
    "removeConfirm": "{{domain}} kaldırılsın mı? Bu alan adının postası Breeze'in standart göndereni üzerinden gider.",
    "removeConfirmUnmanaged": "{{domain}} Breeze'den kaldırılsın mı? Alan adı e-posta sağlayıcısı hesabınızda kalır — Breeze kendi oluşturmadığı bir alan adını asla silmez.",
    "removeStarted": "Alan adı kaldırılıyor.",
    "suspendedNotice": "Breeze bu alan adını askıya aldı. Destek ekibine yazın.",
    "lastSendError": "Son teslim sorunu: {{error}}",
    "identitiesTitle": "Gönderen adresleri",
    "identitiesDescription": "Her e-posta türünün hangi adresten çıkacağını seçin. Boş bıraktığınız tür Breeze'in standart göndereninde kalır.",
    "identitiesNoDomain": "Önce bir alan adı doğrulayın, sonra gönderen adreslerini seçin.",
    "streamSupportName": "Müşteri desteği",
    "streamBillingName": "Faturalama",
    "streamGeneralName": "Genel bildirimler",
    "streamSupportMail": "Müşterilere giden talep güncellemeleri, portal davetleri ve portal parola sıfırlamaları.",
    "streamBillingMail": "Teklifler ve faturalar.",
    "streamGeneralMail": "Zamanlanmış rapor gönderimleri.",
    "repliesSupport": "Talep postası Reply-To alanını {{inbound}} olarak ayarlar, böylece müşterinin yanıtı talebe geri döner. Portal davetleri ve parola sıfırlamaları Reply-To ayarlamaz, dolayısıyla o yanıtlar aşağıdaki adrese gider.",
    "repliesSupportNoInbound": "Bu sunucunun gelen posta adresi yok, bu yüzden talep postasına gelen yanıtlar aşağıdaki adrese gider. Birinin okuduğu bir posta kutusu ya da Breeze'e ileten bir takma ad kullanın.",
    "repliesBilling": "Teklifler ve faturalar Reply-To alanını faturalama e-postanız olarak ayarlar, yanıtlar oraya gider.",
    "repliesGeneral": "Burada hiçbiri kendi Reply-To alanını ayarlamaz; yanıtlar aşağıdaki adrese ya da belirlediğiniz Reply-To adresine gider.",
    "repliesMailboxHint": "İnsanlar ve otomatik yanıtlayıcılar bazen gönderen adresine yanıt verir, bu yüzden her birini gerçek bir posta kutusu ya da takma ad yapın.",
    "identityDomain": "Doğrulanmış alan adı",
    "identityLocalPart": "Adres",
    "identityDisplayName": "Görünen ad",
    "identityDisplayNamePlaceholder": "Acme Support",
    "identityReplyTo": "Reply-To adresi (isteğe bağlı)",
    "identityFrom": "{{address}} adresinden gönderir",
    "identityClear": "Standart göndereni kullan",
    "identitySaved": "Gönderen adresi kaydedildi.",
    "identityCleared": "Breeze'in standart gönderenine dönüldü.",
    "identityLocalPartInvalid": "Harf, rakam, nokta, tire, artı ve alt çizgi kullanın; noktalama işaretiyle başlamayın ya da bitirmeyin.",
    "identityLocalPartReserved": "postmaster, abuse ve mailer-daemon ayrılmıştır.",
    "identityDisplayNameInvalid": "Görünen ad bir e-posta adresi ya da bağlantı içeremez.",
    "identityReplyToInvalid": "Eksiksiz bir e-posta adresi girin.",
    "testTitle": "Deneme e-postası gönder",
    "testDescription": "Bu alan adından kendi oturum açma adresinize tek bir ileti göndeririz.",
    "testSubmit": "Deneme e-postası gönder",
    "testQueued": "Deneme e-postası kuyruğa alındı.",
    "testPending": "Deneme e-postası sürüyor…",
    "testLastSent": "Son deneme {{when}} tarihinde gönderildi.",
    "testLastFailed": "Son deneme {{when}} tarihinde başarısız oldu: {{error}}",
    "errorDomainUnavailable": "Bu alan adı Breeze'de veya e-posta sağlayıcımızda kayıtlı olabilir. Ayrı bir alt alan adı kullanın ya da destek ekibine yazın.",
    "errorDomainLimitReached": "En fazla {{max}} gönderim alan adı tutabilirsiniz. Önce birini kaldırın.",
    "errorRateLimited": "Çok fazla deneme. Biraz bekleyip yeniden deneyin.",
    "errorNotFound": "O alan adı artık yok. Sayfayı yenileyin.",
    "errorDomainNotSendable": "O alan adı henüz doğrulanmadı, bu yüzden gönderen adresi olamaz.",
    "errorUnsupported": "Bu sunucuda özel gönderen adresleri etkin değil.",
    "errorAddFailed": "Alan adı eklenemedi.",
    "errorCheckFailed": "DNS denetimi başlatılamadı.",
    "errorRemoveFailed": "Alan adı kaldırılamadı.",
    "errorIdentityFailed": "Gönderen adresi kaydedilemedi.",
    "errorTestFailed": "Deneme e-postası gönderilemedi."
  },
```

- [ ] **Step 10: Run the whole i18n suite green**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web
npx vitest run src/lib/i18n
```
Expected: all PASS.

If `translationCoverage.test.ts` fails on
`does not exceed reviewed namespace duplicate baselines`, the cause is one of
the two values that are deliberately identical in every locale:
`addPlaceholder` (`mail.yourcompany.com`) and `identityDisplayNamePlaceholder`
(`Acme Support`) — both are sample values, and localising them would break
`localeParity.test.ts:513`'s protected-literal occurrence count. Raise the
`settings` baseline for the affected locale by the exact number reported, with
this comment above the number, matching the file's existing style:

```ts
    // +2 (partner sending domains W05): `addPlaceholder` and
    // `identityDisplayNamePlaceholder` are sample values — a domain example and
    // a sample display name. Localising them would change the protected-literal
    // occurrence count that localeParity.test.ts:513 pins against English.
```

- [ ] **Step 11: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/web/src/locales
git commit -m "i18n(web): custom sender address strings in all eight locales

The full partnerSendingDomains key group plus the partner settings tab label,
translated for pt-BR, es-419, fr-FR, fr-CA, de-DE, it-IT and tr-TR. Technical
literals (DNS, SPF, DKIM, Reply-To, Breeze, the sample domain and the reserved
local parts) keep the English occurrence count that localeParity pins.

pt-BR strings are machine-drafted pending native review
es-419, fr-FR, fr-CA, de-DE, and it-IT strings are machine-drafted pending native review
tr-TR strings are machine-drafted pending native review

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 2: Typed API client for the seven routes

**Files:**
- Create: `apps/web/src/lib/api/sendingDomains.ts`
- Create: `apps/web/src/lib/api/sendingDomains.test.ts`

**Interfaces:**
- Consumes: `fetchWithAuth` (`apps/web/src/stores/auth.ts:1335`), `runAction` /
  `ActionError` (`apps/web/src/lib/runAction.ts:78`), `i18n`
  (`apps/web/src/lib/i18n`), and from `@breeze/shared` (W02 Task 3):
  `SendingDomainDto`, `SenderIdentityDto`, `SendingDomainsListResponse`,
  `PartnerMailStreamValue`.
- Produces:
  ```ts
  export const SENDING_DOMAINS_PATH = '/partner/sending-domains';
  export type SendingDomainsFetch =
    | { supported: true; data: SendingDomainsListResponse }
    | { supported: false };
  export function fetchSendingDomains(): Promise<SendingDomainsFetch>;
  export function sendingDomainFriendlyError(maxDomains: number): (code: string) => string | undefined;
  export function createSendingDomain(i: { domain: string; maxDomains: number; onUnauthorized: () => void }): Promise<SendingDomainDto>;
  export function requestSendingDomainCheck(i: { domainId: string; maxDomains: number; onUnauthorized: () => void }): Promise<SendingDomainDto>;
  export function removeSendingDomain(i: { domainId: string; maxDomains: number; onUnauthorized: () => void }): Promise<void>;
  export function upsertSenderIdentity(i: { stream: PartnerMailStreamValue; sendingDomainId: string; localPart: string; displayName: string | null; replyTo: string | null; maxDomains: number; onUnauthorized: () => void }): Promise<SenderIdentityDto>;
  export function deleteSenderIdentity(i: { stream: PartnerMailStreamValue; maxDomains: number; onUnauthorized: () => void }): Promise<void>;
  export function sendSendingDomainTest(i: { domainId: string; maxDomains: number; onUnauthorized: () => void }): Promise<void>;
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/api/sendingDomains.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../../components/shared/Toast', () => ({ showToast: vi.fn() }));

import { showToast } from '../../components/shared/Toast';
import {
  SENDING_DOMAINS_PATH,
  createSendingDomain,
  deleteSenderIdentity,
  fetchSendingDomains,
  removeSendingDomain,
  requestSendingDomainCheck,
  sendSendingDomainTest,
  sendingDomainFriendlyError,
  upsertSenderIdentity,
} from './sendingDomains';

const showToastMock = vi.mocked(showToast);

function res(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

const DOMAIN_ID = '33333333-3333-4333-8333-333333333333';
const onUnauthorized = vi.fn();
const base = { maxDomains: 3, onUnauthorized };

beforeEach(() => {
  fetchWithAuth.mockReset();
  onUnauthorized.mockReset();
});

describe('fetchSendingDomains', () => {
  it('never lets fetchWithAuth inject the ambient orgId — this is a partner-axis surface', async () => {
    fetchWithAuth.mockResolvedValue(res({ capability: { supported: true, provider: 'fake', verifiesByDns: true, eligible: true, maxDomains: 3 }, domains: [], identities: [] }));
    await fetchSendingDomains();
    expect(fetchWithAuth).toHaveBeenCalledWith(SENDING_DOMAINS_PATH, { skipOrgIdInjection: true });
  });

  it('reports an unconfigured instance as unsupported rather than throwing', async () => {
    fetchWithAuth.mockResolvedValue(res({ error: 'sending_domains_unsupported' }, 404));
    expect(await fetchSendingDomains()).toEqual({ supported: false });
  });

  it('throws on any other non-ok status so the tab can show its load-failed state', async () => {
    fetchWithAuth.mockResolvedValue(res({ error: 'boom' }, 500));
    await expect(fetchSendingDomains()).rejects.toThrow();
  });
});

describe('sendingDomainFriendlyError', () => {
  it.each([
    ['domain_unavailable', 'This domain may already be registered with Breeze or with our email provider. Use a dedicated subdomain, or contact support.'],
    ['rate_limited', 'Too many attempts. Wait a moment and try again.'],
    ['not_found', 'That domain is no longer there. Refresh the page.'],
    ['domain_not_sendable', 'That domain is not verified yet, so it cannot be a sender address.'],
    ['sending_domains_unsupported', 'Custom sender addresses are not switched on for this server.'],
  ])('maps %s', (code, copy) => {
    expect(sendingDomainFriendlyError(3)(code)).toBe(copy);
  });

  it('interpolates the cap into domain_limit_reached', () => {
    expect(sendingDomainFriendlyError(5)('domain_limit_reached')).toBe(
      'You can hold at most 5 sending domains. Remove one first.',
    );
  });

  it('returns undefined for an unknown code so runAction keeps the server prose', () => {
    expect(sendingDomainFriendlyError(3)('something_else')).toBeUndefined();
  });
});

describe('mutations', () => {
  it('POSTs the domain and toasts success', async () => {
    fetchWithAuth.mockResolvedValue(res({ id: DOMAIN_ID, domain: 'mail.acme.test', status: 'provisioning' }, 201));
    const created = await createSendingDomain({ ...base, domain: 'mail.acme.test' });
    expect(created.id).toBe(DOMAIN_ID);
    expect(fetchWithAuth).toHaveBeenCalledWith(SENDING_DOMAINS_PATH, {
      method: 'POST',
      body: JSON.stringify({ domain: 'mail.acme.test' }),
      skipOrgIdInjection: true,
    });
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', message: 'Domain added. Preparing DNS records.' }),
    );
  });

  it('surfaces a 409 domain_unavailable as our copy, not the raw token', async () => {
    fetchWithAuth.mockResolvedValue(res({ error: 'domain_unavailable', message: 'server prose' }, 409));
    await expect(createSendingDomain({ ...base, domain: 'acme.test' })).rejects.toThrow();
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        message: 'This domain may already be registered with Breeze or with our email provider. Use a dedicated subdomain, or contact support.',
      }),
    );
  });

  it('calls onUnauthorized and shows no toast on 401', async () => {
    fetchWithAuth.mockResolvedValue(res({}, 401));
    await expect(createSendingDomain({ ...base, domain: 'acme.test' })).rejects.toThrow();
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('POSTs a check to /:id/check', async () => {
    fetchWithAuth.mockResolvedValue(res({ id: DOMAIN_ID, status: 'pending' }, 202));
    await requestSendingDomainCheck({ ...base, domainId: DOMAIN_ID });
    expect(fetchWithAuth).toHaveBeenCalledWith(`${SENDING_DOMAINS_PATH}/${DOMAIN_ID}/check`, {
      method: 'POST',
      skipOrgIdInjection: true,
    });
  });

  it('DELETEs the domain', async () => {
    fetchWithAuth.mockResolvedValue(res({ status: 'removing' }, 202));
    await removeSendingDomain({ ...base, domainId: DOMAIN_ID });
    expect(fetchWithAuth).toHaveBeenCalledWith(`${SENDING_DOMAINS_PATH}/${DOMAIN_ID}`, {
      method: 'DELETE',
      skipOrgIdInjection: true,
    });
  });

  it('PUTs an identity with the stream in the path and never in the body', async () => {
    fetchWithAuth.mockResolvedValue(res({ id: 'i-1', stream: 'support', localPart: 'support' }));
    await upsertSenderIdentity({
      ...base, stream: 'support', sendingDomainId: DOMAIN_ID,
      localPart: 'support', displayName: 'Acme Support', replyTo: null,
    });
    const [url, init] = fetchWithAuth.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe(`${SENDING_DOMAINS_PATH}/identities/support`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({
      sendingDomainId: DOMAIN_ID, localPart: 'support', displayName: 'Acme Support', replyTo: null,
    });
  });

  it('treats the 204 from a cleared identity as success, not a failure', async () => {
    fetchWithAuth.mockResolvedValue({
      ok: true, status: 204, json: async () => { throw new Error('no body'); },
    } as unknown as Response);
    await expect(deleteSenderIdentity({ ...base, stream: 'billing' })).resolves.toBeUndefined();
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', message: 'Back on the standard Breeze sender.' }),
    );
  });

  it('POSTs a test send', async () => {
    fetchWithAuth.mockResolvedValue(res({ status: 'queued' }, 202));
    await sendSendingDomainTest({ ...base, domainId: DOMAIN_ID });
    expect(fetchWithAuth).toHaveBeenCalledWith(`${SENDING_DOMAINS_PATH}/${DOMAIN_ID}/test`, {
      method: 'POST',
      skipOrgIdInjection: true,
    });
  });

  it('maps the test-send 429 to the rate-limit copy', async () => {
    fetchWithAuth.mockResolvedValue(res({ error: 'rate_limited', message: 'Too many test sends.' }, 429));
    await expect(sendSendingDomainTest({ ...base, domainId: DOMAIN_ID })).rejects.toThrow();
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'Too many attempts. Wait a moment and try again.' }),
    );
  });
});
```

Run: `cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web && npx vitest run src/lib/api/sendingDomains.test.ts`
Expected: FAIL — `Cannot find module './sendingDomains'`.

- [ ] **Step 2: Implement the client**

Create `apps/web/src/lib/api/sendingDomains.ts`:

```ts
import type {
  PartnerMailStreamValue,
  SenderIdentityDto,
  SendingDomainDto,
  SendingDomainsListResponse,
} from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { i18n } from '../i18n';
import { runAction } from '../runAction';

/**
 * The seven partner routes of the sending-domains spec (§7). Every mutation is
 * wrapped in `runAction` HERE rather than at the call sites, so a component can
 * never issue a silent mutation through this module — which is also what
 * satisfies apps/web/src/lib/__tests__/no-silent-mutations.test.ts for callers
 * (`isMutatingApiWrapper` only flags a caller when the wrapper's own
 * fetchWithAuth is unwrapped).
 */
export const SENDING_DOMAINS_PATH = '/partner/sending-domains';

/**
 * fetchWithAuth injects the ambient `?orgId=` by default
 * (stores/auth.ts:1335-1343). This surface is partner-axis: the parameter means
 * nothing to the route and would make the request URL change with the org
 * picker, which the E2E response matchers would then have to tolerate. Opt out
 * on every call.
 */
const NO_ORG = { skipOrgIdInjection: true } as const;

export type SendingDomainsFetch =
  | { supported: true; data: SendingDomainsListResponse }
  | { supported: false };

/**
 * Read. A 404 is not an error here: with EMAIL_DOMAINS_PROVIDER unset every
 * route answers `404 sending_domains_unsupported` before any auth-specific gate,
 * which is how the caller learns to hide the tab.
 */
export async function fetchSendingDomains(): Promise<SendingDomainsFetch> {
  const response = await fetchWithAuth(SENDING_DOMAINS_PATH, NO_ORG);
  if (response.status === 404) return { supported: false };
  if (!response.ok) throw new Error(`sending_domains_fetch_failed_${response.status}`);
  return { supported: true, data: (await response.json()) as SendingDomainsListResponse };
}

/**
 * Machine error token -> partner-facing copy. runAction calls this with
 * `body.code ?? body.error`; these routes emit a bare `error` token, so the
 * token is what arrives. Returning undefined leaves the server's own prose.
 */
export function sendingDomainFriendlyError(maxDomains: number): (code: string) => string | undefined {
  return (code: string): string | undefined => {
    switch (code) {
      case 'domain_unavailable':
        return i18n.t('settings:partnerSendingDomains.errorDomainUnavailable');
      case 'domain_limit_reached':
        return i18n.t('settings:partnerSendingDomains.errorDomainLimitReached', { max: maxDomains });
      case 'rate_limited':
        return i18n.t('settings:partnerSendingDomains.errorRateLimited');
      case 'not_found':
        return i18n.t('settings:partnerSendingDomains.errorNotFound');
      case 'domain_not_sendable':
        return i18n.t('settings:partnerSendingDomains.errorDomainNotSendable');
      case 'domain_invalid':
        return i18n.t('settings:partnerSendingDomains.addInvalid');
      case 'sending_domains_unsupported':
        return i18n.t('settings:partnerSendingDomains.errorUnsupported');
      default:
        return undefined;
    }
  };
}

interface MutationBase {
  maxDomains: number;
  onUnauthorized: () => void;
}

export async function createSendingDomain(
  input: MutationBase & { domain: string },
): Promise<SendingDomainDto> {
  return runAction<SendingDomainDto>({
    request: () =>
      fetchWithAuth(SENDING_DOMAINS_PATH, {
        method: 'POST',
        body: JSON.stringify({ domain: input.domain }),
        ...NO_ORG,
      }),
    successMessage: i18n.t('settings:partnerSendingDomains.added'),
    errorFallback: i18n.t('settings:partnerSendingDomains.errorAddFailed'),
    friendly: sendingDomainFriendlyError(input.maxDomains),
    onUnauthorized: input.onUnauthorized,
  });
}

export async function requestSendingDomainCheck(
  input: MutationBase & { domainId: string },
): Promise<SendingDomainDto> {
  return runAction<SendingDomainDto>({
    request: () =>
      fetchWithAuth(`${SENDING_DOMAINS_PATH}/${input.domainId}/check`, { method: 'POST', ...NO_ORG }),
    successMessage: i18n.t('settings:partnerSendingDomains.checkStarted'),
    errorFallback: i18n.t('settings:partnerSendingDomains.errorCheckFailed'),
    friendly: sendingDomainFriendlyError(input.maxDomains),
    onUnauthorized: input.onUnauthorized,
  });
}

export async function removeSendingDomain(input: MutationBase & { domainId: string }): Promise<void> {
  await runAction({
    request: () =>
      fetchWithAuth(`${SENDING_DOMAINS_PATH}/${input.domainId}`, { method: 'DELETE', ...NO_ORG }),
    successMessage: i18n.t('settings:partnerSendingDomains.removeStarted'),
    errorFallback: i18n.t('settings:partnerSendingDomains.errorRemoveFailed'),
    friendly: sendingDomainFriendlyError(input.maxDomains),
    onUnauthorized: input.onUnauthorized,
  });
}

export async function upsertSenderIdentity(
  input: MutationBase & {
    stream: PartnerMailStreamValue;
    sendingDomainId: string;
    localPart: string;
    displayName: string | null;
    replyTo: string | null;
  },
): Promise<SenderIdentityDto> {
  return runAction<SenderIdentityDto>({
    request: () =>
      // `stream` is a path parameter, never a body field (W03's
      // upsertSenderIdentitySchema is .strict() and rejects it in the body).
      fetchWithAuth(`${SENDING_DOMAINS_PATH}/identities/${input.stream}`, {
        method: 'PUT',
        body: JSON.stringify({
          sendingDomainId: input.sendingDomainId,
          localPart: input.localPart,
          displayName: input.displayName,
          replyTo: input.replyTo,
        }),
        ...NO_ORG,
      }),
    successMessage: i18n.t('settings:partnerSendingDomains.identitySaved'),
    errorFallback: i18n.t('settings:partnerSendingDomains.errorIdentityFailed'),
    friendly: sendingDomainFriendlyError(input.maxDomains),
    onUnauthorized: input.onUnauthorized,
  });
}

export async function deleteSenderIdentity(
  input: MutationBase & { stream: PartnerMailStreamValue },
): Promise<void> {
  // The route answers 204 with no body. runAction's `response.json()` rejects,
  // is caught to `null`, and `isApiFailure(null, 204)` is false — so this is a
  // success path, not a silent failure.
  await runAction({
    request: () =>
      fetchWithAuth(`${SENDING_DOMAINS_PATH}/identities/${input.stream}`, { method: 'DELETE', ...NO_ORG }),
    successMessage: i18n.t('settings:partnerSendingDomains.identityCleared'),
    errorFallback: i18n.t('settings:partnerSendingDomains.errorIdentityFailed'),
    friendly: sendingDomainFriendlyError(input.maxDomains),
    onUnauthorized: input.onUnauthorized,
  });
}

export async function sendSendingDomainTest(
  input: MutationBase & { domainId: string },
): Promise<void> {
  // The recipient is always the calling user's own address, taken from the auth
  // context server-side. There is deliberately no body.
  await runAction({
    request: () =>
      fetchWithAuth(`${SENDING_DOMAINS_PATH}/${input.domainId}/test`, { method: 'POST', ...NO_ORG }),
    successMessage: i18n.t('settings:partnerSendingDomains.testQueued'),
    errorFallback: i18n.t('settings:partnerSendingDomains.errorTestFailed'),
    friendly: sendingDomainFriendlyError(input.maxDomains),
    onUnauthorized: input.onUnauthorized,
  });
}
```

- [ ] **Step 3: Run green and commit**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web
npx vitest run src/lib/api/sendingDomains.test.ts
```
Expected: all PASS.

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/web/src/lib/api/sendingDomains.ts apps/web/src/lib/api/sendingDomains.test.ts
git commit -m "feat(web): typed client for the partner sending-domain routes

One module owns all seven routes of spec §7. Every mutation is lexically wrapped
in runAction inside the module, so no component can issue a silent mutation and
callers stay clean for the no-silent-mutations AST guard. Error tokens map to
partner-facing copy; orgId injection is opted out because the surface is
partner-axis.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 3: Pure view model (`domainView.ts`)

Every decision the UI makes about a domain, as pure functions, so the states of
spec §10 are unit-tested without rendering anything.

**Files:**
- Create: `apps/web/src/components/settings/sendingDomains/domainView.ts`
- Create: `apps/web/src/components/settings/sendingDomains/domainView.test.ts`

**Interfaces:**
- Consumes: `SendingDomainDto`, `SendingDomainDnsRecordDto`,
  `SenderIdentityDto`, `SendingDomainsCapabilityDto`, `PartnerMailStreamValue`
  from `@breeze/shared` (W02 Task 3).
- Produces:
  ```ts
  export const SENDING_DOMAIN_STREAMS: readonly PartnerMailStreamValue[];
  export const SUGGESTED_LOCAL_PARTS: Record<PartnerMailStreamValue, string>;
  export const PROVISIONING_SLOW_AFTER_MS = 120_000;
  export const RETRY_WINDOW_MS = 259_200_000;
  export const POLL_PROVISIONING_MS = 2_000;
  export const POLL_PENDING_MS = 15_000;
  export function isTabVisible(capability: SendingDomainsCapabilityDto | null): boolean;
  export function lockedCopySuffix(capability: SendingDomainsCapabilityDto): string;
  export function isTrustLock(capability: SendingDomainsCapabilityDto): boolean;
  export function failureCopySuffix(domain: SendingDomainDto): string;
  export function firstUnhealthyRecord(domain: SendingDomainDto): SendingDomainDnsRecordDto | null;
  export function sendableDomains(domains: SendingDomainDto[]): SendingDomainDto[];
  export function fromAddressFor(identity: { localPart: string; sendingDomainId: string }, domains: SendingDomainDto[]): string | null;
  export function pollIntervalMs(domains: SendingDomainDto[]): number | null;
  export function isProvisioningSlow(domain: SendingDomainDto, nowMs: number): boolean;
  export function isInsideRetryWindow(domain: SendingDomainDto, nowMs: number): boolean;
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/settings/sendingDomains/domainView.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { SendingDomainDto, SendingDomainsCapabilityDto } from '@breeze/shared';
import {
  POLL_PENDING_MS,
  POLL_PROVISIONING_MS,
  PROVISIONING_SLOW_AFTER_MS,
  RETRY_WINDOW_MS,
  SUGGESTED_LOCAL_PARTS,
  failureCopySuffix,
  firstUnhealthyRecord,
  fromAddressFor,
  isInsideRetryWindow,
  isProvisioningSlow,
  isTabVisible,
  isTrustLock,
  lockedCopySuffix,
  pollIntervalMs,
  sendableDomains,
} from './domainView';

const CAPABILITY: SendingDomainsCapabilityDto = {
  supported: true, provider: 'fake', verifiesByDns: true, eligible: true, maxDomains: 3,
};

function domain(over: Partial<SendingDomainDto> = {}): SendingDomainDto {
  return {
    id: 'd-1', domain: 'mail.acme.test', provider: 'fake', status: 'verified', statusReason: null,
    dnsRecords: [], verifiedAt: null, lastCheckedAt: null, lastTestAt: null, lastTestStatus: null,
    lastTestError: null, lastSendError: null, lastSendErrorAt: null, providerManaged: true,
    createdAt: '2026-09-17T12:00:00.000Z', statusChangedAt: '2026-09-17T12:00:00.000Z',
    ...over,
  };
}

describe('isTabVisible', () => {
  it('hides the tab when the fetch found no capability at all (the route 404d)', () => {
    expect(isTabVisible(null)).toBe(false);
  });

  it('hides the tab when this instance has no provider configured', () => {
    expect(isTabVisible({ ...CAPABILITY, supported: false, provider: null })).toBe(false);
  });

  it('SHOWS the tab when a provider is configured but its key cannot manage domains', () => {
    // spec §5.1: the settings tab explains provider_key_send_only. Hiding the
    // tab here would leave the operator with nothing to read.
    expect(isTabVisible({
      ...CAPABILITY, supported: false, eligible: false, reason: 'provider_key_send_only',
    })).toBe(true);
  });

  it('shows the tab for an eligible partner', () => {
    expect(isTabVisible(CAPABILITY)).toBe(true);
  });
});

describe('lockedCopySuffix', () => {
  it.each([
    ['provider_key_send_only', 'lockedProviderKeySendOnly'],
    ['partner_inactive', 'lockedPartnerInactive'],
    ['not_allowlisted', 'lockedNotAllowlisted'],
    ['probation_default_deny', 'lockedProbation'],
    ['restricted', 'lockedRestricted'],
  ])('maps %s', (reason, suffix) => {
    expect(lockedCopySuffix({ ...CAPABILITY, eligible: false, reason })).toBe(suffix);
  });

  it('falls back to the probation copy for an unrecognised trust reason', () => {
    expect(lockedCopySuffix({ ...CAPABILITY, eligible: false, reason: 'something_new' })).toBe('lockedProbation');
  });

  it('falls back to the probation copy when the server sent no reason at all', () => {
    expect(lockedCopySuffix({ ...CAPABILITY, eligible: false })).toBe('lockedProbation');
  });
});

describe('isTrustLock', () => {
  it('is true only for the two trust-derived reasons, which the banner can explain', () => {
    expect(isTrustLock({ ...CAPABILITY, eligible: false, reason: 'probation_default_deny' })).toBe(true);
    expect(isTrustLock({ ...CAPABILITY, eligible: false, reason: 'restricted' })).toBe(true);
    expect(isTrustLock({ ...CAPABILITY, eligible: false, reason: 'not_allowlisted' })).toBe(false);
    expect(isTrustLock({ ...CAPABILITY, eligible: false, reason: 'provider_key_send_only' })).toBe(false);
    expect(isTrustLock(CAPABILITY)).toBe(false);
  });
});

describe('failureCopySuffix', () => {
  it.each([
    ['provider_conflict', 'failedProviderConflict'],
    ['quota_exhausted', 'failedQuotaExhausted'],
    ['dns_not_detected', 'failedDnsNotDetected'],
    ['dns_removed', 'failedDnsRemoved'],
    ['abuse_auto', 'failedUnknown'],
  ] as const)('maps %s', (reason, suffix) => {
    expect(failureCopySuffix(domain({ status: 'failed', statusReason: reason }))).toBe(suffix);
  });

  it('tells a static-mode rejection to ask the instance administrator', () => {
    expect(failureCopySuffix(domain({ provider: 'static', status: 'failed', statusReason: 'provider_rejected' })))
      .toBe('staticNotAllowed');
  });

  it('blames the provider when a DNS-mode domain is rejected', () => {
    expect(failureCopySuffix(domain({ provider: 'resend', status: 'failed', statusReason: 'provider_rejected' })))
      .toBe('failedProviderRejected');
  });

  it('falls back when the reason is missing', () => {
    expect(failureCopySuffix(domain({ status: 'failed', statusReason: null }))).toBe('failedUnknown');
  });
});

describe('firstUnhealthyRecord', () => {
  const dkim = { purpose: 'dkim', type: 'CNAME', host: 'resend._domainkey', fqdn: 'resend._domainkey.mail.acme.test', value: 'x', status: 'verified' } as const;
  const spf = { purpose: 'spf', type: 'TXT', host: 'send', fqdn: 'send.mail.acme.test', value: 'v=spf1', status: 'failed' } as const;

  it('names the record the at-risk banner must mention', () => {
    expect(firstUnhealthyRecord(domain({ status: 'at_risk', dnsRecords: [dkim, spf] }))?.fqdn)
      .toBe('send.mail.acme.test');
  });

  it('returns null when everything is verified', () => {
    expect(firstUnhealthyRecord(domain({ dnsRecords: [dkim] }))).toBeNull();
  });

  it('returns null when there are no records at all (static mode)', () => {
    expect(firstUnhealthyRecord(domain({ provider: 'static', dnsRecords: [] }))).toBeNull();
  });
});

describe('sendableDomains', () => {
  it('offers only verified and at-risk domains as identity targets', () => {
    const list = [
      domain({ id: 'a', status: 'verified' }),
      domain({ id: 'b', status: 'at_risk' }),
      domain({ id: 'c', status: 'pending' }),
      domain({ id: 'd', status: 'suspended' }),
      domain({ id: 'e', status: 'removing' }),
    ];
    expect(sendableDomains(list).map((d) => d.id)).toEqual(['a', 'b']);
  });
});

describe('fromAddressFor', () => {
  it('composes the address from the local part and the domain row', () => {
    expect(fromAddressFor({ localPart: 'support', sendingDomainId: 'd-1' }, [domain()]))
      .toBe('support@mail.acme.test');
  });

  it('returns null when the identity points at a domain the response did not carry', () => {
    // The saved identity carries its own `fromAddress` from the API, but the
    // form previews the values being EDITED, which no server field can know.
    expect(fromAddressFor({ localPart: 'support', sendingDomainId: 'gone' }, [domain()])).toBeNull();
  });
});

describe('pollIntervalMs', () => {
  it('polls fast while a domain is provisioning', () => {
    expect(pollIntervalMs([domain({ status: 'provisioning' }), domain({ status: 'pending' })]))
      .toBe(POLL_PROVISIONING_MS);
  });

  it('polls slowly while a domain waits for DNS', () => {
    expect(pollIntervalMs([domain({ status: 'pending' })])).toBe(POLL_PENDING_MS);
  });

  it('polls slowly while a domain is being removed', () => {
    expect(pollIntervalMs([domain({ status: 'removing' })])).toBe(POLL_PENDING_MS);
  });

  it('polls slowly while a test send is in flight', () => {
    expect(pollIntervalMs([domain({ status: 'verified', lastTestStatus: 'pending' })])).toBe(POLL_PENDING_MS);
  });

  it('stops polling once everything has settled', () => {
    expect(pollIntervalMs([domain({ status: 'verified' }), domain({ status: 'failed' })])).toBeNull();
  });

  it('stops polling when there are no domains at all', () => {
    expect(pollIntervalMs([])).toBeNull();
  });
});

describe('isProvisioningSlow', () => {
  const created = Date.parse('2026-09-17T12:00:00.000Z');

  it('is quiet for the first two minutes', () => {
    expect(isProvisioningSlow(domain({ status: 'provisioning' }), created + PROVISIONING_SLOW_AFTER_MS - 1)).toBe(false);
  });

  it('warns after two minutes', () => {
    expect(isProvisioningSlow(domain({ status: 'provisioning' }), created + PROVISIONING_SLOW_AFTER_MS + 1)).toBe(true);
  });

  it('never warns for a domain that is not provisioning', () => {
    expect(isProvisioningSlow(domain({ status: 'pending' }), created + 10 * PROVISIONING_SLOW_AFTER_MS)).toBe(false);
  });
});

describe('isInsideRetryWindow', () => {
  const failedAt = Date.parse('2026-09-17T12:00:00.000Z');
  const failed = domain({ status: 'failed', statusReason: 'dns_not_detected', statusChangedAt: '2026-09-17T12:00:00.000Z' });

  it('offers a retry while the failed row still holds its DNS records', () => {
    expect(isInsideRetryWindow(failed, failedAt + RETRY_WINDOW_MS - 60_000)).toBe(true);
  });

  it('stops offering a retry once the 72-hour window has passed', () => {
    // The worker auto-removes a failed row 72 h after it failed, so a retry
    // past that point can only race the removal.
    expect(isInsideRetryWindow(failed, failedAt + RETRY_WINDOW_MS + 60_000)).toBe(false);
  });

  it('is false for any status other than failed', () => {
    expect(isInsideRetryWindow(domain({ status: 'pending' }), failedAt + 1_000)).toBe(false);
  });

  it('errs toward offering the retry when the timestamp is unreadable', () => {
    expect(isInsideRetryWindow({ ...failed, statusChangedAt: 'not-a-date' }, failedAt)).toBe(true);
  });
});

describe('SUGGESTED_LOCAL_PARTS', () => {
  it('matches the spec §3.2 stream table', () => {
    expect(SUGGESTED_LOCAL_PARTS).toEqual({ support: 'support', billing: 'billing', general: 'notifications' });
  });
});
```

Run: `cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web && npx vitest run src/components/settings/sendingDomains/domainView.test.ts`
Expected: FAIL — `Cannot find module './domainView'`.

- [ ] **Step 2: Implement**

Create `apps/web/src/components/settings/sendingDomains/domainView.ts`:

```ts
import type {
  PartnerMailStreamValue,
  SenderIdentityDto,
  SendingDomainDnsRecordDto,
  SendingDomainDto,
  SendingDomainsCapabilityDto,
} from '@breeze/shared';

/**
 * Pure view model for the custom sender-address tab. Everything the UI decides
 * about a domain lives here so the states of spec §10 can be tested without
 * rendering, and so the components stay presentational.
 *
 * All of these return an i18n key SUFFIX under `partnerSendingDomains.`, never a
 * full key: the components interpolate the group prefix, which keeps
 * apps/web/src/lib/i18n/keyUsage.test.ts able to prove the group exists.
 */

export const SENDING_DOMAIN_STREAMS: readonly PartnerMailStreamValue[] = ['support', 'billing', 'general'];

/** Spec §3.2's "suggested local part" column. */
export const SUGGESTED_LOCAL_PARTS: Record<PartnerMailStreamValue, string> = {
  support: 'support',
  billing: 'billing',
  general: 'notifications',
};

/** Spec §13: show the delay notice once provisioning has run for two minutes. */
export const PROVISIONING_SLOW_AFTER_MS = 120_000;
/**
 * Spec §4.3 / §6.1: the worker moves a `failed` row to `removing` 72 h after it
 * failed, and that is exactly the window in which "Try again" keeps the same DNS
 * records. 72 h in ms.
 */
export const RETRY_WINDOW_MS = 72 * 60 * 60 * 1_000;
/** Spec §10: `provisioning` polls every 2 s. */
export const POLL_PROVISIONING_MS = 2_000;
/** Spec §10: `pending` auto-refreshes every 15 s. */
export const POLL_PENDING_MS = 15_000;

/**
 * The tab is hidden if and only if this INSTANCE has no provider — either the
 * route 404'd (capability null) or the capability reports no provider. A
 * configured provider whose key cannot manage domains still shows the tab, with
 * the locked card explaining why (spec §5.1 against spec §10's "unsupported"
 * row; see the plan amendments).
 */
export function isTabVisible(capability: SendingDomainsCapabilityDto | null): boolean {
  return capability !== null && capability.provider !== null;
}

/** Which locked-card copy the capability's reason calls for. */
export function lockedCopySuffix(capability: SendingDomainsCapabilityDto): string {
  switch (capability.reason) {
    case 'provider_key_send_only':
      return 'lockedProviderKeySendOnly';
    case 'partner_inactive':
      return 'lockedPartnerInactive';
    case 'not_allowlisted':
      return 'lockedNotAllowlisted';
    case 'restricted':
      return 'lockedRestricted';
    default:
      // Every remaining case is the trust evaluator's own reason string
      // (probation_default_deny today). "Still being verified" is the accurate
      // and least alarming default for an unrecognised one.
      return 'lockedProbation';
  }
}

/**
 * Only a trust-derived lock can be explained by TrustProbationBanner, which is
 * where the checklist and "Request review" live. An allowlist or key problem is
 * nothing that banner knows about.
 */
export function isTrustLock(capability: SendingDomainsCapabilityDto): boolean {
  if (capability.eligible) return false;
  return capability.reason === 'restricted' || capability.reason === 'probation_default_deny';
}

/** Which failure copy a `failed` row calls for. */
export function failureCopySuffix(domain: SendingDomainDto): string {
  switch (domain.statusReason) {
    case 'provider_conflict':
      return 'failedProviderConflict';
    case 'provider_rejected':
      // In `static` mode a rejection means the operator has not listed the
      // domain in EMAIL_DOMAINS_STATIC_ALLOWED, which the partner cannot fix.
      return domain.provider === 'static' ? 'staticNotAllowed' : 'failedProviderRejected';
    case 'quota_exhausted':
      return 'failedQuotaExhausted';
    case 'dns_not_detected':
      return 'failedDnsNotDetected';
    case 'dns_removed':
      return 'failedDnsRemoved';
    default:
      return 'failedUnknown';
  }
}

/** The record the at-risk banner must name (spec §10). */
export function firstUnhealthyRecord(domain: SendingDomainDto): SendingDomainDnsRecordDto | null {
  return domain.dnsRecords.find((record) => record.status !== 'verified') ?? null;
}

/** Spec §7: an identity's domain must be the caller's and `verified` or `at_risk`. */
export function sendableDomains(domains: SendingDomainDto[]): SendingDomainDto[] {
  return domains.filter((d) => d.status === 'verified' || d.status === 'at_risk');
}

/**
 * The exact From address a stream will send with, composed from a local part and
 * the domain row in the SAME response.
 *
 * A saved identity also carries its own `fromAddress` from the API, and that is
 * the authority for what the server will actually send with. This function is
 * for the FORM: it previews the local part and domain the partner is editing
 * right now, which no server field can know before the save.
 */
export function fromAddressFor(
  identity: Pick<SenderIdentityDto, 'localPart' | 'sendingDomainId'>,
  domains: SendingDomainDto[],
): string | null {
  const match = domains.find((d) => d.id === identity.sendingDomainId);
  return match ? `${identity.localPart}@${match.domain}` : null;
}

/** How fast to re-read, or null to stop entirely. */
export function pollIntervalMs(domains: SendingDomainDto[]): number | null {
  if (domains.some((d) => d.status === 'provisioning')) return POLL_PROVISIONING_MS;
  const waiting = domains.some(
    (d) => d.status === 'pending' || d.status === 'removing' || d.lastTestStatus === 'pending',
  );
  return waiting ? POLL_PENDING_MS : null;
}

/** Spec §13's "delay notice after 2 min" while the provider is unreachable. */
export function isProvisioningSlow(domain: SendingDomainDto, nowMs: number): boolean {
  if (domain.status !== 'provisioning') return false;
  const created = Date.parse(domain.createdAt);
  if (Number.isNaN(created)) return false;
  return nowMs - created > PROVISIONING_SLOW_AFTER_MS;
}

/**
 * Spec §10's `failed` row: "Retry (inside the window)". The window runs from the
 * moment the row failed — `statusChangedAt` — for 72 h, after which the worker
 * expires the row to `removing` and the same DNS records are gone.
 *
 * The SERVER is the authority: `requestDomainCheck` enforces the window too, so
 * a click that races the boundary surfaces the server's error like any other
 * failure. This only decides whether the button is worth offering, which is why
 * an unparseable timestamp errs toward showing it rather than hiding the one
 * action left on a broken domain.
 */
export function isInsideRetryWindow(domain: SendingDomainDto, nowMs: number): boolean {
  if (domain.status !== 'failed') return false;
  const failedAt = Date.parse(domain.statusChangedAt);
  if (Number.isNaN(failedAt)) return true;
  return nowMs - failedAt < RETRY_WINDOW_MS;
}
```

- [ ] **Step 3: Run green and commit**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web
npx vitest run src/components/settings/sendingDomains/domainView.test.ts
```
Expected: all PASS.

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/web/src/components/settings/sendingDomains/domainView.ts apps/web/src/components/settings/sendingDomains/domainView.test.ts
git commit -m "feat(web): pure view model for the sending-domain states

Every decision the tab makes — tab visibility, locked copy, failure copy, the
missing record, sendable domains, the From address, the poll interval, the
two-minute provisioning notice, the 72-hour retry window — as pure functions, so
spec §10's state table is tested without rendering. The From address is composed
from the domain row in the same response because the form has to preview the
values being edited, which the saved identity's own fromAddress cannot know.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 4: `AddDomainForm`

**Files:**
- Create: `apps/web/src/components/settings/sendingDomains/AddDomainForm.tsx`
- Create: `apps/web/src/components/settings/sendingDomains/AddDomainForm.test.tsx`

**Interfaces:**
- Consumes: `normalizeSendingDomain` from `@breeze/shared` (W02 Task 3 — returns
  `{ ok: true; domain } | { ok: false; reason }`), `useTranslation('settings')`.
- Produces:
  ```tsx
  export interface AddDomainFormProps {
    disabled: boolean;
    /** Show the subdomain recommendation — the empty state of spec §10. */
    showRecommendation: boolean;
    onAdd: (domain: string) => void | Promise<void>;
  }
  export default function AddDomainForm(props: AddDomainFormProps): JSX.Element;
  ```
- testids: `sending-domains-add-form`, `sending-domains-add-input`,
  `sending-domains-add-submit`, `sending-domains-add-error`,
  `sending-domains-recommendation`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/settings/sendingDomains/AddDomainForm.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AddDomainForm from './AddDomainForm';

describe('AddDomainForm', () => {
  it('shows the subdomain recommendation and all three reasons in the empty state', () => {
    render(<AddDomainForm disabled={false} showRecommendation onAdd={vi.fn()} />);
    const block = screen.getByTestId('sending-domains-recommendation');
    expect(block.textContent).toContain('We recommend a dedicated subdomain');
    expect(block.textContent).toContain('sending reputation');
    expect(block.textContent).toContain('never take a domain away from another account');
    expect(block.textContent).toContain('exact-match rule');
  });

  it('hides the recommendation once the partner already has a domain', () => {
    render(<AddDomainForm disabled={false} showRecommendation={false} onAdd={vi.fn()} />);
    expect(screen.queryByTestId('sending-domains-recommendation')).toBeNull();
  });

  it('normalises with the shared validator before calling onAdd', async () => {
    const onAdd = vi.fn();
    const user = userEvent.setup();
    render(<AddDomainForm disabled={false} showRecommendation={false} onAdd={onAdd} />);

    await user.type(screen.getByTestId('sending-domains-add-input'), '  MAIL.Acme.COM. ');
    await user.click(screen.getByTestId('sending-domains-add-submit'));

    expect(onAdd).toHaveBeenCalledWith('mail.acme.com');
  });

  it('refuses a structurally invalid domain client-side and never calls onAdd', async () => {
    const onAdd = vi.fn();
    const user = userEvent.setup();
    render(<AddDomainForm disabled={false} showRecommendation={false} onAdd={onAdd} />);

    await user.type(screen.getByTestId('sending-domains-add-input'), 'https://acme.com');
    await user.click(screen.getByTestId('sending-domains-add-submit'));

    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByTestId('sending-domains-add-error').textContent)
      .toBe('Enter a domain such as mail.yourcompany.com.');
  });

  it('clears the inline error once the field is edited again', async () => {
    const user = userEvent.setup();
    render(<AddDomainForm disabled={false} showRecommendation={false} onAdd={vi.fn()} />);

    await user.type(screen.getByTestId('sending-domains-add-input'), 'localhost');
    await user.click(screen.getByTestId('sending-domains-add-submit'));
    expect(screen.getByTestId('sending-domains-add-error')).not.toBeNull();

    await user.type(screen.getByTestId('sending-domains-add-input'), '.example');
    expect(screen.queryByTestId('sending-domains-add-error')).toBeNull();
  });

  it('disables the input and the button while the tab is busy', () => {
    render(<AddDomainForm disabled showRecommendation={false} onAdd={vi.fn()} />);
    expect((screen.getByTestId('sending-domains-add-input') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('sending-domains-add-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('empties the field after a successful add', async () => {
    const user = userEvent.setup();
    render(<AddDomainForm disabled={false} showRecommendation={false} onAdd={vi.fn()} />);
    const input = screen.getByTestId('sending-domains-add-input') as HTMLInputElement;

    await user.type(input, 'mail.acme.test');
    await user.click(screen.getByTestId('sending-domains-add-submit'));

    expect(input.value).toBe('');
  });
});
```

Run: `cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web && npx vitest run src/components/settings/sendingDomains/AddDomainForm.test.tsx`
Expected: FAIL — `Cannot find module './AddDomainForm'`.

- [ ] **Step 2: Implement**

Create `apps/web/src/components/settings/sendingDomains/AddDomainForm.tsx`:

```tsx
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { normalizeSendingDomain } from '@breeze/shared';
import '@/lib/i18n';

export interface AddDomainFormProps {
  disabled: boolean;
  /** The empty state of spec §10: the form plus the subdomain recommendation. */
  showRecommendation: boolean;
  onAdd: (domain: string) => void | Promise<void>;
}

/**
 * Add-domain form. Validation uses the SHARED normaliser (spec §4.1) so the
 * field and the API agree character for character — the same function the route
 * runs through `createSendingDomainSchema`. Policy rejections (platform domains,
 * consumer providers, public suffixes, the operator denylist) are server-side
 * only and arrive as a toast.
 */
export default function AddDomainForm({ disabled, showRecommendation, onAdd }: AddDomainFormProps) {
  const { t } = useTranslation('settings');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const normalized = normalizeSendingDomain(value);
    if (!normalized.ok) {
      setError(t('partnerSendingDomains.addInvalid'));
      return;
    }
    setError(null);
    setValue('');
    void onAdd(normalized.domain);
  };

  return (
    <section className="rounded-lg border p-4" data-testid="sending-domains-add">
      <h3 className="mb-1 text-sm font-semibold">{t('partnerSendingDomains.addTitle')}</h3>

      <form className="mt-2 flex flex-wrap items-start gap-2" onSubmit={submit} data-testid="sending-domains-add-form">
        <div className="min-w-0 flex-1">
          <label className="text-xs font-medium" htmlFor="sending-domains-add-input">
            {t('partnerSendingDomains.addLabel')}
          </label>
          <input
            id="sending-domains-add-input"
            type="text"
            value={value}
            disabled={disabled}
            onChange={(e) => { setValue(e.target.value); if (error) setError(null); }}
            placeholder={t('partnerSendingDomains.addPlaceholder')}
            className="mt-0.5 block w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            data-testid="sending-domains-add-input"
          />
        </div>
        <button
          type="submit"
          disabled={disabled}
          className="mt-5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          data-testid="sending-domains-add-submit"
        >
          {t('partnerSendingDomains.addSubmit')}
        </button>
      </form>

      {error && (
        <p className="mt-1.5 text-xs text-destructive" data-testid="sending-domains-add-error">
          {error}
        </p>
      )}

      {showRecommendation && (
        <div className="mt-4 rounded-md border bg-muted/20 p-3" data-testid="sending-domains-recommendation">
          <p className="text-xs font-medium">{t('partnerSendingDomains.recommendTitle')}</p>
          <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
            <li>{t('partnerSendingDomains.recommendReason1')}</li>
            <li>{t('partnerSendingDomains.recommendReason2')}</li>
            <li>{t('partnerSendingDomains.recommendReason3')}</li>
          </ul>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 3: Run green and commit**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web
npx vitest run src/components/settings/sendingDomains/AddDomainForm.test.tsx
```
Expected: all PASS.

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/web/src/components/settings/sendingDomains/AddDomainForm.tsx apps/web/src/components/settings/sendingDomains/AddDomainForm.test.tsx
git commit -m "feat(web): add-domain form with the shared normaliser and subdomain advice

Client validation runs the same normalizeSendingDomain the API runs, so the
field and the route agree character for character. The empty state carries spec
§4.2's recommendation and its three reasons.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 5: `DnsRecordsTable`

**Files:**
- Create: `apps/web/src/components/settings/sendingDomains/DnsRecordsTable.tsx`
- Create: `apps/web/src/components/settings/sendingDomains/DnsRecordsTable.test.tsx`

**Interfaces:**
- Consumes: `SendingDomainDnsRecordDto` from `@breeze/shared`, `showToast`
  (`apps/web/src/components/shared/Toast`), `useTranslation('settings')`.
- Produces:
  ```tsx
  export interface DnsRecordsTableProps {
    records: SendingDomainDnsRecordDto[];
    /** Suppresses the 72-hour note once the domain is verified. */
    showPendingNote: boolean;
  }
  export default function DnsRecordsTable(props: DnsRecordsTableProps): JSX.Element | null;
  ```
- testids: `sending-domains-records`, `sending-domains-records-note`,
  `sending-domain-record-<index>`, `sending-domain-record-<index>-status`,
  `sending-domain-record-<index>-copy`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/settings/sendingDomains/DnsRecordsTable.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SendingDomainDnsRecordDto } from '@breeze/shared';

vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
import { showToast } from '../../shared/Toast';
import DnsRecordsTable from './DnsRecordsTable';

const showToastMock = vi.mocked(showToast);

const RECORDS: SendingDomainDnsRecordDto[] = [
  { purpose: 'dkim', type: 'CNAME', host: 'resend._domainkey', fqdn: 'resend._domainkey.mail.acme.test', value: 'dkim.example', ttl: 'Auto', status: 'verified' },
  { purpose: 'spf', type: 'TXT', host: 'send', fqdn: 'send.mail.acme.test', value: 'v=spf1 include:example ~all', ttl: 'Auto', status: 'pending' },
  { purpose: 'return_path_mx', type: 'MX', host: 'send', fqdn: 'send.mail.acme.test', value: 'feedback.example', priority: 10, ttl: 'Auto', status: 'failed' },
];

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe('DnsRecordsTable', () => {
  it('renders nothing when the provider publishes no records (static mode)', () => {
    const { container } = render(<DnsRecordsTable records={[]} showPendingNote />);
    expect(container.firstChild).toBeNull();
  });

  it('renders every column of spec §10 for every record', () => {
    render(<DnsRecordsTable records={RECORDS} showPendingNote />);
    const table = screen.getByTestId('sending-domains-records');
    for (const header of ['Record type', 'Host label', 'Full name', 'Value', 'Priority', 'Status']) {
      expect(table.textContent).toContain(header);
    }
    const mx = screen.getByTestId('sending-domain-record-2');
    expect(mx.textContent).toContain('MX');
    expect(mx.textContent).toContain('send');
    expect(mx.textContent).toContain('send.mail.acme.test');
    expect(mx.textContent).toContain('feedback.example');
    expect(mx.textContent).toContain('10');
  });

  it('shows a per-record status', () => {
    render(<DnsRecordsTable records={RECORDS} showPendingNote />);
    expect(screen.getByTestId('sending-domain-record-0-status').textContent).toBe('Verified');
    expect(screen.getByTestId('sending-domain-record-1-status').textContent).toBe('Pending');
    expect(screen.getByTestId('sending-domain-record-2-status').textContent).toBe('Failed');
  });

  it('copies a record value and says so', async () => {
    const user = userEvent.setup();
    render(<DnsRecordsTable records={RECORDS} showPendingNote />);

    await user.click(screen.getByTestId('sending-domain-record-1-copy'));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('v=spf1 include:example ~all');
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', message: 'Copied to the clipboard' }),
    );
  });

  it('carries the 72-hour note while the domain is still waiting', () => {
    render(<DnsRecordsTable records={RECORDS} showPendingNote />);
    expect(screen.getByTestId('sending-domains-records-note').textContent).toContain('72 hours');
  });

  it('drops the 72-hour note once the domain is verified', () => {
    render(<DnsRecordsTable records={RECORDS} showPendingNote={false} />);
    expect(screen.queryByTestId('sending-domains-records-note')).toBeNull();
  });
});
```

Run: `cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web && npx vitest run src/components/settings/sendingDomains/DnsRecordsTable.test.tsx`
Expected: FAIL — `Cannot find module './DnsRecordsTable'`.

- [ ] **Step 2: Implement**

Create `apps/web/src/components/settings/sendingDomains/DnsRecordsTable.tsx`:

```tsx
import { useTranslation } from 'react-i18next';
import type { SendingDomainDnsRecordDto } from '@breeze/shared';
import { showToast } from '../../shared/Toast';
import '@/lib/i18n';

export interface DnsRecordsTableProps {
  records: SendingDomainDnsRecordDto[];
  /** Spec §10: the "DNS can take up to 72 hours" note belongs to the wait. */
  showPendingNote: boolean;
}

const RECORD_STATUS_CLASS: Record<SendingDomainDnsRecordDto['status'], string> = {
  verified: 'text-emerald-600',
  pending: 'text-muted-foreground',
  failed: 'text-amber-600',
};

/**
 * What the partner must publish. `fqdn` is computed by the adapter, so the table
 * shows both the provider's relative label (what most DNS panels want) and the
 * full name that has to resolve — copying the wrong one is the usual reason a
 * domain never verifies.
 */
export default function DnsRecordsTable({ records, showPendingNote }: DnsRecordsTableProps) {
  const { t } = useTranslation('settings');
  if (records.length === 0) return null;

  const copy = (value: string) => {
    void navigator.clipboard?.writeText(value);
    showToast({ type: 'success', message: t('partnerSendingDomains.recordsCopied') });
  };

  return (
    <div className="mt-3">
      <p className="text-xs font-medium">{t('partnerSendingDomains.recordsTitle')}</p>
      <div className="mt-1.5 overflow-x-auto">
        <table className="w-full min-w-[40rem] text-left text-xs" data-testid="sending-domains-records">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 pr-3 font-medium">{t('partnerSendingDomains.recordsType')}</th>
              <th className="py-1 pr-3 font-medium">{t('partnerSendingDomains.recordsHost')}</th>
              <th className="py-1 pr-3 font-medium">{t('partnerSendingDomains.recordsFqdn')}</th>
              <th className="py-1 pr-3 font-medium">{t('partnerSendingDomains.recordsValue')}</th>
              <th className="py-1 pr-3 font-medium">{t('partnerSendingDomains.recordsPriority')}</th>
              <th className="py-1 pr-3 font-medium">{t('common:labels.status')}</th>
              <th className="py-1 font-medium" />
            </tr>
          </thead>
          <tbody>
            {records.map((record, index) => (
              <tr key={`${record.type}-${record.fqdn}-${index}`} className="border-t align-top" data-testid={`sending-domain-record-${index}`}>
                <td className="py-1.5 pr-3 font-mono">{record.type}</td>
                <td className="py-1.5 pr-3 font-mono break-all">{record.host}</td>
                <td className="py-1.5 pr-3 font-mono break-all">{record.fqdn}</td>
                <td className="py-1.5 pr-3 font-mono break-all">{record.value}</td>
                <td className="py-1.5 pr-3 font-mono">{record.priority ?? ''}</td>
                <td className={`py-1.5 pr-3 ${RECORD_STATUS_CLASS[record.status]}`} data-testid={`sending-domain-record-${index}-status`}>
                  {record.status === 'verified'
                    ? t('partnerSendingDomains.statusVerified')
                    : record.status === 'failed'
                      ? t('partnerSendingDomains.statusFailed')
                      : t('common:states.pending')}
                </td>
                <td className="py-1.5">
                  <button
                    type="button"
                    onClick={() => copy(record.value)}
                    className="rounded-md border px-2 py-1 text-xs"
                    data-testid={`sending-domain-record-${index}-copy`}
                  >
                    {t('common:actions.copy')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {showPendingNote && (
        <p className="mt-1.5 text-xs text-muted-foreground" data-testid="sending-domains-records-note">
          {t('partnerSendingDomains.recordsNote')}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Run green and commit**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web
npx vitest run src/components/settings/sendingDomains/DnsRecordsTable.test.tsx
```
Expected: all PASS.

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/web/src/components/settings/sendingDomains/DnsRecordsTable.tsx apps/web/src/components/settings/sendingDomains/DnsRecordsTable.test.tsx
git commit -m "feat(web): DNS records table for a pending sending domain

Type, host label, full name, value, priority and a per-record status, with a copy
button per row and the 72-hour note while the domain is still waiting. Renders
nothing at all in static mode, where the provider publishes no records.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 6: `DomainStatusPanel`

One card per domain: the badge, every banner of spec §10, the records table, and
the actions. This is where most of the state table lives.

**Files:**
- Create: `apps/web/src/components/settings/sendingDomains/DomainStatusPanel.tsx`
- Create: `apps/web/src/components/settings/sendingDomains/DomainStatusPanel.test.tsx`

**Interfaces:**
- Consumes: `SendingDomainDto` from `@breeze/shared`; `DnsRecordsTable`
  (Task 5); `failureCopySuffix`, `firstUnhealthyRecord`, `isProvisioningSlow`,
  `isInsideRetryWindow` (Task 3); `useTranslation('settings')`.
- Produces:
  ```tsx
  export interface DomainStatusPanelProps {
    domain: SendingDomainDto;
    /** capability.verifiesByDns — false in `static` mode: no records, no Check now. */
    verifiesByDns: boolean;
    busy: boolean;
    /** Clock for the two-minute provisioning notice; the tab advances it on each poll. */
    nowMs: number;
    onCheckNow: (domainId: string) => void;
    onRemove: (domain: SendingDomainDto) => void;
    /** The test-send control, rendered for a sendable domain. */
    children?: React.ReactNode;
  }
  export default function DomainStatusPanel(props: DomainStatusPanelProps): JSX.Element;
  ```
- testids: `sending-domain-row-<id>`, `sending-domain-<id>-name`,
  `sending-domain-<id>-status`, `sending-domain-<id>-check`,
  `sending-domain-<id>-retry`, `sending-domain-<id>-remove`,
  `sending-domain-<id>-provisioning`, `sending-domain-<id>-provisioning-slow`,
  `sending-domain-<id>-at-risk`, `sending-domain-<id>-failed`,
  `sending-domain-<id>-suspended`, `sending-domain-<id>-send-error`,
  `sending-domain-<id>-static-hint`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/settings/sendingDomains/DomainStatusPanel.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SendingDomainDto } from '@breeze/shared';
import DomainStatusPanel from './DomainStatusPanel';

vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));

const CREATED = '2026-09-17T12:00:00.000Z';
const CREATED_MS = Date.parse(CREATED);

function domain(over: Partial<SendingDomainDto> = {}): SendingDomainDto {
  return {
    id: 'd-1', domain: 'mail.acme.test', provider: 'fake', status: 'verified', statusReason: null,
    dnsRecords: [], verifiedAt: null, lastCheckedAt: null, lastTestAt: null, lastTestStatus: null,
    lastTestError: null, lastSendError: null, lastSendErrorAt: null, providerManaged: true,
    createdAt: CREATED, statusChangedAt: CREATED,
    ...over,
  };
}

const RECORDS: SendingDomainDto['dnsRecords'] = [
  { purpose: 'dkim', type: 'CNAME', host: 'resend._domainkey', fqdn: 'resend._domainkey.mail.acme.test', value: 'dkim.example', status: 'pending' },
];

function renderPanel(d: SendingDomainDto, over: Partial<React.ComponentProps<typeof DomainStatusPanel>> = {}) {
  return render(
    <DomainStatusPanel
      domain={d}
      verifiesByDns
      busy={false}
      nowMs={CREATED_MS}
      onCheckNow={vi.fn()}
      onRemove={vi.fn()}
      {...over}
    />,
  );
}

describe('DomainStatusPanel — provisioning', () => {
  it('says it is preparing records and offers no Check now', () => {
    renderPanel(domain({ status: 'provisioning' }));
    expect(screen.getByTestId('sending-domain-d-1-provisioning').textContent).toBe('Preparing DNS records…');
    expect(screen.queryByTestId('sending-domain-d-1-check')).toBeNull();
  });

  it('stays quiet for the first two minutes', () => {
    renderPanel(domain({ status: 'provisioning' }), { nowMs: CREATED_MS + 119_000 });
    expect(screen.queryByTestId('sending-domain-d-1-provisioning-slow')).toBeNull();
  });

  it('shows the delay notice after two minutes', () => {
    renderPanel(domain({ status: 'provisioning' }), { nowMs: CREATED_MS + 121_000 });
    expect(screen.getByTestId('sending-domain-d-1-provisioning-slow').textContent)
      .toContain('taking longer than usual');
  });
});

describe('DomainStatusPanel — pending', () => {
  it('shows the records table and Check now', async () => {
    const onCheckNow = vi.fn();
    const user = userEvent.setup();
    renderPanel(domain({ status: 'pending', dnsRecords: RECORDS }), { onCheckNow });

    expect(screen.getByTestId('sending-domains-records')).not.toBeNull();
    expect(screen.getByTestId('sending-domains-records-note')).not.toBeNull();

    await user.click(screen.getByTestId('sending-domain-d-1-check'));
    expect(onCheckNow).toHaveBeenCalledWith('d-1');
  });
});

describe('DomainStatusPanel — static mode', () => {
  it('shows no records table, no Check now, and the verify-by-test hint', () => {
    renderPanel(domain({ provider: 'static', status: 'pending' }), { verifiesByDns: false });
    expect(screen.queryByTestId('sending-domains-records')).toBeNull();
    expect(screen.queryByTestId('sending-domain-d-1-check')).toBeNull();
    expect(screen.getByTestId('sending-domain-d-1-static-hint').textContent)
      .toContain('accepts a test message');
  });

  it('tells the partner to ask the administrator when the operator has not listed the domain', () => {
    renderPanel(domain({ provider: 'static', status: 'failed', statusReason: 'provider_rejected' }), { verifiesByDns: false });
    expect(screen.getByTestId('sending-domain-d-1-failed').textContent)
      .toBe('Ask your Breeze administrator to allow this domain.');
  });
});

describe('DomainStatusPanel — verified and at risk', () => {
  it('renders the child test-send control for a verified domain and keeps Check now', () => {
    renderPanel(domain({ status: 'verified', dnsRecords: [{ ...RECORDS[0], status: 'verified' }] }), {
      children: <div data-testid="stub-test-send" />,
    });
    expect(screen.getByTestId('stub-test-send')).not.toBeNull();
    expect(screen.getByTestId('sending-domain-d-1-check')).not.toBeNull();
    // The 72-hour wait note belongs to the wait, not to a verified domain.
    expect(screen.queryByTestId('sending-domains-records-note')).toBeNull();
  });

  it('names the missing record in the at-risk banner', () => {
    renderPanel(domain({
      status: 'at_risk',
      dnsRecords: [
        { purpose: 'dkim', type: 'CNAME', host: 'resend._domainkey', fqdn: 'resend._domainkey.mail.acme.test', value: 'x', status: 'verified' },
        { purpose: 'spf', type: 'TXT', host: 'send', fqdn: 'send.mail.acme.test', value: 'v=spf1', status: 'failed' },
      ],
    }));
    const banner = screen.getByTestId('sending-domain-d-1-at-risk');
    expect(banner.textContent).toContain('TXT');
    expect(banner.textContent).toContain('send.mail.acme.test');
    expect(banner.textContent).toContain('Mail still goes out');
  });
});

describe('DomainStatusPanel — failed, suspended, removing', () => {
  it('explains a failure and offers both Try again and Remove', async () => {
    const onCheckNow = vi.fn();
    const onRemove = vi.fn();
    const user = userEvent.setup();
    const d = domain({ status: 'failed', statusReason: 'dns_not_detected' });
    renderPanel(d, { onCheckNow, onRemove });

    expect(screen.getByTestId('sending-domain-d-1-failed').textContent)
      .toBe('We could not find the DNS records within 72 hours.');

    await user.click(screen.getByTestId('sending-domain-d-1-retry'));
    expect(onCheckNow).toHaveBeenCalledWith('d-1');

    await user.click(screen.getByTestId('sending-domain-d-1-remove'));
    expect(onRemove).toHaveBeenCalledWith(d);
  });

  it('drops Try again once the 72-hour retry window has passed, keeping Remove', () => {
    // Past the window the worker is about to expire the row and a retry can no
    // longer keep the same DNS records, so offering it would be a lie.
    renderPanel(domain({ status: 'failed', statusReason: 'dns_not_detected' }), {
      nowMs: CREATED_MS + 73 * 60 * 60 * 1_000,
    });
    expect(screen.queryByTestId('sending-domain-d-1-retry')).toBeNull();
    expect(screen.getByTestId('sending-domain-d-1-failed')).not.toBeNull();
    expect(screen.getByTestId('sending-domain-d-1-remove')).not.toBeNull();
  });

  it('offers no action at all on a suspended domain', () => {
    renderPanel(domain({ status: 'suspended', statusReason: 'platform_suspended' }));
    expect(screen.getByTestId('sending-domain-d-1-suspended').textContent)
      .toBe('Breeze suspended this domain. Contact support.');
    expect(screen.queryByTestId('sending-domain-d-1-check')).toBeNull();
    expect(screen.queryByTestId('sending-domain-d-1-retry')).toBeNull();
    expect(screen.queryByTestId('sending-domain-d-1-remove')).toBeNull();
  });

  it('disables the row while it is being removed', () => {
    renderPanel(domain({ status: 'removing' }));
    expect(screen.getByTestId('sending-domain-row-d-1').getAttribute('aria-busy')).toBe('true');
    expect(screen.getByTestId('sending-domain-d-1-status').textContent).toBe('Removing…');
    expect(screen.queryByTestId('sending-domain-d-1-remove')).toBeNull();
  });

  it('disables the actions while the tab is busy', () => {
    renderPanel(domain({ status: 'pending', dnsRecords: RECORDS }), { busy: true });
    expect((screen.getByTestId('sending-domain-d-1-check') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('sending-domain-d-1-remove') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('DomainStatusPanel — lastSendError', () => {
  it('shows the most recent delivery refusal whatever the status is', () => {
    renderPanel(domain({ status: 'verified', lastSendError: '550 5.7.60 sender not allowed' }));
    expect(screen.getByTestId('sending-domain-d-1-send-error').textContent)
      .toBe('Last delivery problem: 550 5.7.60 sender not allowed');
  });

  it('shows nothing when there has been no refusal', () => {
    renderPanel(domain({ status: 'verified' }));
    expect(screen.queryByTestId('sending-domain-d-1-send-error')).toBeNull();
  });
});
```

Run: `cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web && npx vitest run src/components/settings/sendingDomains/DomainStatusPanel.test.tsx`
Expected: FAIL — `Cannot find module './DomainStatusPanel'`.

- [ ] **Step 2: Implement**

Create `apps/web/src/components/settings/sendingDomains/DomainStatusPanel.tsx`:

```tsx
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { SendingDomainDto } from '@breeze/shared';
import DnsRecordsTable from './DnsRecordsTable';
import { failureCopySuffix, firstUnhealthyRecord, isInsideRetryWindow, isProvisioningSlow } from './domainView';
import '@/lib/i18n';

export interface DomainStatusPanelProps {
  domain: SendingDomainDto;
  /** capability.verifiesByDns — false in `static` mode: no records, no Check now. */
  verifiesByDns: boolean;
  busy: boolean;
  /** Clock for the two-minute provisioning notice; the tab advances it per poll. */
  nowMs: number;
  onCheckNow: (domainId: string) => void;
  onRemove: (domain: SendingDomainDto) => void;
  children?: ReactNode;
}

const STATUS_SUFFIX: Record<SendingDomainDto['status'], string> = {
  provisioning: 'statusProvisioning',
  pending: 'statusPending',
  verified: 'statusVerified',
  at_risk: 'statusAtRisk',
  failed: 'statusFailed',
  suspended: 'statusSuspended',
  removing: 'statusRemoving',
};

const STATUS_CLASS: Record<SendingDomainDto['status'], string> = {
  provisioning: 'border-muted text-muted-foreground',
  pending: 'border-muted text-muted-foreground',
  verified: 'border-emerald-500/40 text-emerald-600',
  at_risk: 'border-amber-500/40 text-amber-600',
  failed: 'border-destructive/40 text-destructive',
  suspended: 'border-destructive/40 text-destructive',
  removing: 'border-muted text-muted-foreground',
};

/**
 * One domain, every state of spec §10.
 *
 * Two deliberate supersets of that table, both additive (see the plan
 * amendments): the records table is shown whenever the provider published
 * records — a verified domain can still show what it published, all rows green,
 * minus the 72-hour wait note — and "Check now" is offered on `verified` and
 * `at_risk` as well as `pending`, which is what a partner reaches for right
 * after re-publishing a record.
 */
export default function DomainStatusPanel({
  domain, verifiesByDns, busy, nowMs, onCheckNow, onRemove, children,
}: DomainStatusPanelProps) {
  const { t } = useTranslation('settings');

  const removing = domain.status === 'removing';
  const suspended = domain.status === 'suspended';
  const sendable = domain.status === 'verified' || domain.status === 'at_risk';
  const canCheck = verifiesByDns && (domain.status === 'pending' || sendable);
  // Spec §10: Retry only INSIDE the 72 h window, which is the window in which a
  // retry keeps the same DNS records. Past it the row is about to be expired by
  // the worker and Remove is the only thing left worth offering.
  const canRetry = isInsideRetryWindow(domain, nowMs);
  const canRemove = !suspended && !removing;
  const unhealthy = firstUnhealthyRecord(domain);

  return (
    <section
      className={`rounded-lg border p-4 ${removing ? 'opacity-60' : ''}`}
      aria-busy={removing || undefined}
      data-testid={`sending-domain-row-${domain.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-sm font-medium break-all" data-testid={`sending-domain-${domain.id}-name`}>
          {domain.domain}
        </p>
        <span
          className={`rounded-full border px-2 py-0.5 text-xs ${STATUS_CLASS[domain.status]}`}
          data-testid={`sending-domain-${domain.id}-status`}
        >
          {t(/* i18n-dynamic */ `partnerSendingDomains.${STATUS_SUFFIX[domain.status]}`)}
        </span>
      </div>

      {domain.status === 'provisioning' && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid={`sending-domain-${domain.id}-provisioning`}>
          {t('partnerSendingDomains.statusProvisioning')}
        </p>
      )}
      {isProvisioningSlow(domain, nowMs) && (
        <p className="mt-1.5 text-xs text-amber-600" data-testid={`sending-domain-${domain.id}-provisioning-slow`}>
          {t('partnerSendingDomains.provisioningSlow')}
        </p>
      )}

      {!verifiesByDns && domain.status === 'pending' && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid={`sending-domain-${domain.id}-static-hint`}>
          {t('partnerSendingDomains.staticVerifyHint')}
        </p>
      )}

      {verifiesByDns && (
        <DnsRecordsTable records={domain.dnsRecords} showPendingNote={domain.status === 'pending'} />
      )}

      {domain.status === 'at_risk' && (
        <p
          className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
          data-testid={`sending-domain-${domain.id}-at-risk`}
        >
          {t('partnerSendingDomains.atRiskBanner', {
            type: unhealthy?.type ?? '',
            fqdn: unhealthy?.fqdn ?? domain.domain,
          })}
        </p>
      )}

      {domain.status === 'failed' && (
        <p className="mt-3 text-xs text-destructive" data-testid={`sending-domain-${domain.id}-failed`}>
          {t(/* i18n-dynamic */ `partnerSendingDomains.${failureCopySuffix(domain)}`)}
        </p>
      )}

      {suspended && (
        <p className="mt-3 text-xs text-destructive" data-testid={`sending-domain-${domain.id}-suspended`}>
          {t('partnerSendingDomains.suspendedNotice')}
        </p>
      )}

      {domain.lastSendError && (
        <p className="mt-2 text-xs text-amber-600" data-testid={`sending-domain-${domain.id}-send-error`}>
          {t('partnerSendingDomains.lastSendError', { error: domain.lastSendError })}
        </p>
      )}

      {sendable && children}

      {(canCheck || canRetry || canRemove) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {canCheck && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onCheckNow(domain.id)}
              className="rounded-md border px-2.5 py-1.5 text-sm disabled:opacity-50"
              data-testid={`sending-domain-${domain.id}-check`}
            >
              {t('partnerSendingDomains.checkNow')}
            </button>
          )}
          {canRetry && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onCheckNow(domain.id)}
              className="rounded-md border px-2.5 py-1.5 text-sm disabled:opacity-50"
              data-testid={`sending-domain-${domain.id}-retry`}
            >
              {t('partnerSendingDomains.retry')}
            </button>
          )}
          {canRemove && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onRemove(domain)}
              className="rounded-md border px-2.5 py-1.5 text-sm text-destructive disabled:opacity-50"
              data-testid={`sending-domain-${domain.id}-remove`}
            >
              {t('common:actions.remove')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 3: Run green and commit**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web
npx vitest run src/components/settings/sendingDomains/DomainStatusPanel.test.tsx
```
Expected: all PASS.

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/web/src/components/settings/sendingDomains/DomainStatusPanel.tsx apps/web/src/components/settings/sendingDomains/DomainStatusPanel.test.tsx
git commit -m "feat(web): per-domain status card for every state of the spec §10 table

Badge, provisioning notice with the two-minute delay warning, the records table,
the at-risk banner naming the missing record, the failure reason, the suspended
notice, the disabled removing row, and the last delivery refusal. Static mode
drops the records and Check now and explains that a test send is what verifies.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 7: `SenderIdentitiesForm`

**Files:**
- Create: `apps/web/src/components/settings/sendingDomains/SenderIdentitiesForm.tsx`
- Create: `apps/web/src/components/settings/sendingDomains/SenderIdentitiesForm.test.tsx`

**Interfaces:**
- Consumes: `senderLocalPartSchema`, `senderDisplayNameSchema`,
  `SendingDomainDto`, `SenderIdentityDto`, `PartnerMailStreamValue` from
  `@breeze/shared` (W02 Task 3); `SENDING_DOMAIN_STREAMS`,
  `SUGGESTED_LOCAL_PARTS`, `sendableDomains`, `fromAddressFor` (Task 3).
- Produces:
  ```tsx
  export interface SenderIdentitiesFormProps {
    domains: SendingDomainDto[];
    identities: SenderIdentityDto[];
    /** From GET /ticket-config: whether this instance has an inbound address, and which. */
    inbound: { configured: boolean; address: string | null };
    busy: boolean;
    onSave: (input: {
      stream: PartnerMailStreamValue; sendingDomainId: string;
      localPart: string; displayName: string | null; replyTo: string | null;
    }) => void | Promise<void>;
    onClear: (stream: PartnerMailStreamValue) => void | Promise<void>;
  }
  export default function SenderIdentitiesForm(props: SenderIdentitiesFormProps): JSX.Element;
  ```
- testids: `sending-domains-identities`, `sending-domains-identities-empty`,
  and per stream `sending-identity-<stream>`, `-domain`, `-localpart`,
  `-displayname`, `-replyto`, `-save`, `-clear`, `-from`, `-replies`, `-error`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/settings/sendingDomains/SenderIdentitiesForm.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SenderIdentityDto, SendingDomainDto } from '@breeze/shared';
import SenderIdentitiesForm from './SenderIdentitiesForm';

function domain(over: Partial<SendingDomainDto> = {}): SendingDomainDto {
  return {
    id: 'd-1', domain: 'mail.acme.test', provider: 'fake', status: 'verified', statusReason: null,
    dnsRecords: [], verifiedAt: null, lastCheckedAt: null, lastTestAt: null, lastTestStatus: null,
    lastTestError: null, lastSendError: null, lastSendErrorAt: null, providerManaged: true,
    createdAt: '2026-09-17T12:00:00.000Z', statusChangedAt: '2026-09-17T12:00:00.000Z',
    ...over,
  };
}

function identity(over: Partial<SenderIdentityDto> = {}): SenderIdentityDto {
  return {
    id: 'i-1', stream: 'support', sendingDomainId: 'd-1', domain: 'mail.acme.test', localPart: 'help',
    displayName: 'Acme Help', replyTo: null, fromAddress: 'help@mail.acme.test',
    updatedAt: '2026-09-17T12:00:00.000Z',
    ...over,
  };
}

const INBOUND = { configured: true, address: 'acme@tickets.example.com' };

function renderForm(over: Partial<React.ComponentProps<typeof SenderIdentitiesForm>> = {}) {
  return render(
    <SenderIdentitiesForm
      domains={[domain()]}
      identities={[]}
      inbound={INBOUND}
      busy={false}
      onSave={vi.fn()}
      onClear={vi.fn()}
      {...over}
    />,
  );
}

describe('SenderIdentitiesForm', () => {
  it('tells the partner to verify a domain first when none is sendable', () => {
    renderForm({ domains: [domain({ status: 'pending' })] });
    expect(screen.getByTestId('sending-domains-identities-empty').textContent)
      .toBe('Verify a domain first, then choose sender addresses.');
    expect(screen.queryByTestId('sending-identity-support')).toBeNull();
  });

  it('renders all three streams with their suggested local parts', () => {
    renderForm();
    for (const [stream, suggested] of [['support', 'support'], ['billing', 'billing'], ['general', 'notifications']] as const) {
      expect((screen.getByTestId(`sending-identity-${stream}-localpart`) as HTMLInputElement).value).toBe(suggested);
    }
  });

  it('seeds a configured stream from its saved identity', () => {
    renderForm({ identities: [identity()] });
    expect((screen.getByTestId('sending-identity-support-localpart') as HTMLInputElement).value).toBe('help');
    expect((screen.getByTestId('sending-identity-support-displayname') as HTMLInputElement).value).toBe('Acme Help');
  });

  it('shows the exact From address the stream will send with', () => {
    renderForm({ identities: [identity()] });
    expect(screen.getByTestId('sending-identity-support-from').textContent)
      .toBe('Sends from help@mail.acme.test');
  });

  it('states where replies go for each stream', () => {
    renderForm();
    expect(screen.getByTestId('sending-identity-support-replies').textContent)
      .toContain('acme@tickets.example.com');
    expect(screen.getByTestId('sending-identity-billing-replies').textContent)
      .toContain('Reply-To to your billing email');
    expect(screen.getByTestId('sending-identity-general-replies').textContent)
      .toContain("Nothing here sets its own Reply-To");
  });

  it('warns on the support stream when this instance has no inbound address', () => {
    renderForm({ inbound: { configured: false, address: null } });
    expect(screen.getByTestId('sending-identity-support-replies').textContent)
      .toContain('no inbound email address');
    expect(screen.getByTestId('sending-identity-support-replies').textContent)
      .toContain('a mailbox someone reads');
  });

  it('saves a stream with the composed values, never a full From address', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    renderForm({ onSave });

    await user.clear(screen.getByTestId('sending-identity-billing-localpart'));
    await user.type(screen.getByTestId('sending-identity-billing-localpart'), 'Invoices');
    await user.type(screen.getByTestId('sending-identity-billing-displayname'), 'Acme Billing');
    await user.click(screen.getByTestId('sending-identity-billing-save'));

    expect(onSave).toHaveBeenCalledWith({
      stream: 'billing', sendingDomainId: 'd-1', localPart: 'invoices',
      displayName: 'Acme Billing', replyTo: null,
    });
  });

  it('refuses a reserved local part client-side', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    renderForm({ onSave });

    await user.clear(screen.getByTestId('sending-identity-support-localpart'));
    await user.type(screen.getByTestId('sending-identity-support-localpart'), 'postmaster');
    await user.click(screen.getByTestId('sending-identity-support-save'));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId('sending-identity-support-error').textContent)
      .toBe('postmaster, abuse and mailer-daemon are reserved.');
  });

  it('refuses a malformed local part client-side', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    renderForm({ onSave });

    await user.clear(screen.getByTestId('sending-identity-support-localpart'));
    await user.type(screen.getByTestId('sending-identity-support-localpart'), '.nope.');
    await user.click(screen.getByTestId('sending-identity-support-save'));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId('sending-identity-support-error').textContent)
      .toContain('Use letters, numbers, dots');
  });

  it('refuses a display name that carries an address', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    renderForm({ onSave });

    await user.type(screen.getByTestId('sending-identity-support-displayname'), 'Acme billing@acme.test');
    await user.click(screen.getByTestId('sending-identity-support-save'));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId('sending-identity-support-error').textContent)
      .toBe('A display name cannot contain an email address or a link.');
  });

  it('refuses an incomplete Reply-To address', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    renderForm({ onSave });

    await user.type(screen.getByTestId('sending-identity-support-replyto'), 'nope');
    await user.click(screen.getByTestId('sending-identity-support-save'));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId('sending-identity-support-error').textContent)
      .toBe('Enter a complete email address.');
  });

  it('offers Clear only on a stream that is actually configured', async () => {
    const onClear = vi.fn();
    const user = userEvent.setup();
    renderForm({ identities: [identity()], onClear });

    expect(screen.queryByTestId('sending-identity-billing-clear')).toBeNull();
    await user.click(screen.getByTestId('sending-identity-support-clear'));
    expect(onClear).toHaveBeenCalledWith('support');
  });

  it('disables every control while the tab is busy', () => {
    renderForm({ busy: true });
    expect((screen.getByTestId('sending-identity-support-save') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('sending-identity-support-localpart') as HTMLInputElement).disabled).toBe(true);
  });
});
```

Run: `cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web && npx vitest run src/components/settings/sendingDomains/SenderIdentitiesForm.test.tsx`
Expected: FAIL — `Cannot find module './SenderIdentitiesForm'`.

- [ ] **Step 2: Implement**

Create `apps/web/src/components/settings/sendingDomains/SenderIdentitiesForm.tsx`:

```tsx
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  senderDisplayNameSchema,
  senderLocalPartSchema,
  type PartnerMailStreamValue,
  type SenderIdentityDto,
  type SendingDomainDto,
} from '@breeze/shared';
import {
  SENDING_DOMAIN_STREAMS,
  SUGGESTED_LOCAL_PARTS,
  fromAddressFor,
  sendableDomains,
} from './domainView';
import '@/lib/i18n';

export interface SenderIdentitiesFormProps {
  domains: SendingDomainDto[];
  identities: SenderIdentityDto[];
  /** From GET /ticket-config — drives the §8.5 no-inbound warning. */
  inbound: { configured: boolean; address: string | null };
  busy: boolean;
  onSave: (input: {
    stream: PartnerMailStreamValue;
    sendingDomainId: string;
    localPart: string;
    displayName: string | null;
    replyTo: string | null;
  }) => void | Promise<void>;
  onClear: (stream: PartnerMailStreamValue) => void | Promise<void>;
}

const STREAM_NAME_SUFFIX: Record<PartnerMailStreamValue, string> = {
  support: 'streamSupportName',
  billing: 'streamBillingName',
  general: 'streamGeneralName',
};

const STREAM_MAIL_SUFFIX: Record<PartnerMailStreamValue, string> = {
  support: 'streamSupportMail',
  billing: 'streamBillingMail',
  general: 'streamGeneralMail',
};

/** A complete address, deliberately looser than the RFC and identical to what the route's zod `.email()` accepts in practice. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

interface StreamRowProps extends Pick<SenderIdentitiesFormProps, 'busy' | 'inbound' | 'onSave' | 'onClear'> {
  stream: PartnerMailStreamValue;
  targets: SendingDomainDto[];
  existing: SenderIdentityDto | undefined;
}

function StreamRow({ stream, targets, existing, inbound, busy, onSave, onClear }: StreamRowProps) {
  const { t } = useTranslation('settings');
  const [sendingDomainId, setSendingDomainId] = useState(existing?.sendingDomainId ?? targets[0]!.id);
  const [localPart, setLocalPart] = useState(existing?.localPart ?? SUGGESTED_LOCAL_PARTS[stream]);
  const [displayName, setDisplayName] = useState(existing?.displayName ?? '');
  const [replyTo, setReplyTo] = useState(existing?.replyTo ?? '');
  const [error, setError] = useState<string | null>(null);

  // The From address is COMPOSED here: the partner never types a full address
  // (spec §4.4). A saved identity carries its own `fromAddress` from the API,
  // but this preview has to follow the local part and domain being EDITED.
  const preview = fromAddressFor({ localPart, sendingDomainId }, targets);

  const repliesSuffix =
    stream === 'support'
      ? (inbound.configured ? 'repliesSupport' : 'repliesSupportNoInbound')
      : stream === 'billing'
        ? 'repliesBilling'
        : 'repliesGeneral';

  const save = () => {
    const parsedLocal = senderLocalPartSchema.safeParse(localPart);
    if (!parsedLocal.success) {
      const reserved = parsedLocal.error.issues.some((issue) => issue.message === 'local_part_reserved');
      setError(t(reserved
        ? 'partnerSendingDomains.identityLocalPartReserved'
        : 'partnerSendingDomains.identityLocalPartInvalid'));
      return;
    }
    const trimmedName = displayName.trim();
    if (trimmedName.length > 0 && !senderDisplayNameSchema.safeParse(trimmedName).success) {
      setError(t('partnerSendingDomains.identityDisplayNameInvalid'));
      return;
    }
    const trimmedReplyTo = replyTo.trim();
    if (trimmedReplyTo.length > 0 && !EMAIL_RE.test(trimmedReplyTo)) {
      setError(t('partnerSendingDomains.identityReplyToInvalid'));
      return;
    }
    setError(null);
    void onSave({
      stream,
      sendingDomainId,
      localPart: parsedLocal.data,
      displayName: trimmedName.length > 0 ? trimmedName : null,
      replyTo: trimmedReplyTo.length > 0 ? trimmedReplyTo : null,
    });
  };

  return (
    <div className="mt-4 rounded-md border bg-muted/20 p-3" data-testid={`sending-identity-${stream}`}>
      <p className="text-sm font-medium">
        {t(/* i18n-dynamic */ `partnerSendingDomains.${STREAM_NAME_SUFFIX[stream]}`)}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {t(/* i18n-dynamic */ `partnerSendingDomains.${STREAM_MAIL_SUFFIX[stream]}`)}
      </p>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div>
          <label className="text-xs font-medium" htmlFor={`sending-identity-${stream}-localpart`}>
            {t('partnerSendingDomains.identityLocalPart')}
          </label>
          <input
            id={`sending-identity-${stream}-localpart`}
            type="text"
            value={localPart}
            disabled={busy}
            onChange={(e) => { setLocalPart(e.target.value); if (error) setError(null); }}
            className="mt-0.5 block w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            data-testid={`sending-identity-${stream}-localpart`}
          />
        </div>
        <div>
          <label className="text-xs font-medium" htmlFor={`sending-identity-${stream}-domain`}>
            {t('partnerSendingDomains.identityDomain')}
          </label>
          <select
            id={`sending-identity-${stream}-domain`}
            value={sendingDomainId}
            disabled={busy}
            onChange={(e) => setSendingDomainId(e.target.value)}
            className="mt-0.5 block w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            data-testid={`sending-identity-${stream}-domain`}
          >
            {targets.map((d) => (
              <option key={d.id} value={d.id}>{d.domain}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs font-medium" htmlFor={`sending-identity-${stream}-displayname`}>
            {t('partnerSendingDomains.identityDisplayName')}
          </label>
          <input
            id={`sending-identity-${stream}-displayname`}
            type="text"
            value={displayName}
            disabled={busy}
            onChange={(e) => { setDisplayName(e.target.value); if (error) setError(null); }}
            placeholder={t('partnerSendingDomains.identityDisplayNamePlaceholder')}
            className="mt-0.5 block w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            data-testid={`sending-identity-${stream}-displayname`}
          />
        </div>
        <div>
          <label className="text-xs font-medium" htmlFor={`sending-identity-${stream}-replyto`}>
            {t('partnerSendingDomains.identityReplyTo')}
          </label>
          <input
            id={`sending-identity-${stream}-replyto`}
            type="text"
            value={replyTo}
            disabled={busy}
            onChange={(e) => { setReplyTo(e.target.value); if (error) setError(null); }}
            className="mt-0.5 block w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            data-testid={`sending-identity-${stream}-replyto`}
          />
        </div>
      </div>

      {preview && (
        <p className="mt-2 font-mono text-xs" data-testid={`sending-identity-${stream}-from`}>
          {t('partnerSendingDomains.identityFrom', { address: preview })}
        </p>
      )}

      <p className="mt-1.5 text-xs text-muted-foreground" data-testid={`sending-identity-${stream}-replies`}>
        {t(/* i18n-dynamic */ `partnerSendingDomains.${repliesSuffix}`, { inbound: inbound.address ?? '' })}
      </p>

      {error && (
        <p className="mt-1.5 text-xs text-destructive" data-testid={`sending-identity-${stream}-error`}>
          {error}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={save}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          data-testid={`sending-identity-${stream}-save`}
        >
          {t('common:actions.save')}
        </button>
        {existing && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void onClear(stream)}
            className="rounded-md border px-2.5 py-1.5 text-sm disabled:opacity-50"
            data-testid={`sending-identity-${stream}-clear`}
          >
            {t('partnerSendingDomains.identityClear')}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * One block per mail stream (spec §3.2). A stream with no row sends from the
 * platform sender and there is no implicit fallback between streams, so each
 * block is independent — and each states where replies actually go, following
 * the §8.3 precedence (call site, then the identity's Reply-To, then none).
 */
export default function SenderIdentitiesForm({
  domains, identities, inbound, busy, onSave, onClear,
}: SenderIdentitiesFormProps) {
  const { t } = useTranslation('settings');
  const targets = sendableDomains(domains);

  return (
    <section className="rounded-lg border p-4" data-testid="sending-domains-identities">
      <h3 className="mb-1 text-sm font-semibold">{t('partnerSendingDomains.identitiesTitle')}</h3>
      <p className="text-xs text-muted-foreground">{t('partnerSendingDomains.identitiesDescription')}</p>

      {targets.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground" data-testid="sending-domains-identities-empty">
          {t('partnerSendingDomains.identitiesNoDomain')}
        </p>
      ) : (
        <>
          <p className="mt-2 text-xs text-muted-foreground">{t('partnerSendingDomains.repliesMailboxHint')}</p>
          {SENDING_DOMAIN_STREAMS.map((stream) => {
            const existing = identities.find((i) => i.stream === stream);
            return (
              <StreamRow
                // Remount when the saved identity changes so the inputs re-seed
                // from the server's normalised values after a save.
                key={`${stream}-${existing?.updatedAt ?? 'none'}`}
                stream={stream}
                targets={targets}
                existing={existing}
                inbound={inbound}
                busy={busy}
                onSave={onSave}
                onClear={onClear}
              />
            );
          })}
        </>
      )}
    </section>
  );
}
```

- [ ] **Step 3: Run green and commit**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web
npx vitest run src/components/settings/sendingDomains/SenderIdentitiesForm.test.tsx
```
Expected: all PASS.

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/web/src/components/settings/sendingDomains/SenderIdentitiesForm.tsx apps/web/src/components/settings/sendingDomains/SenderIdentitiesForm.test.tsx
git commit -m "feat(web): per-stream sender identities with where-replies-go copy

Support, billing and general, each seeded with the spec §3.2 suggested local
part, validated with the shared identity schemas, and each stating where replies
land under the §8.3 precedence — including the §8.5 warning when this instance
has no inbound address at all. The partner picks a local part and a verified
domain; the From address is composed for display only.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 8: `TestSendControl`

**Files:**
- Create: `apps/web/src/components/settings/sendingDomains/TestSendControl.tsx`
- Create: `apps/web/src/components/settings/sendingDomains/TestSendControl.test.tsx`

**Interfaces:**
- Consumes: `SendingDomainDto` from `@breeze/shared`, `i18n` (`@/lib/i18n`) for
  the resolved-locale date format, `useTranslation('settings')`.
- Produces:
  ```tsx
  export interface TestSendControlProps {
    domain: SendingDomainDto;
    busy: boolean;
    onSend: (domainId: string) => void | Promise<void>;
  }
  export default function TestSendControl(props: TestSendControlProps): JSX.Element;
  ```
- testids: `sending-domain-<id>-test`, `sending-domain-<id>-test-submit`,
  `sending-domain-<id>-test-result`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/settings/sendingDomains/TestSendControl.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SendingDomainDto } from '@breeze/shared';
import TestSendControl from './TestSendControl';

function domain(over: Partial<SendingDomainDto> = {}): SendingDomainDto {
  return {
    id: 'd-1', domain: 'mail.acme.test', provider: 'fake', status: 'verified', statusReason: null,
    dnsRecords: [], verifiedAt: null, lastCheckedAt: null, lastTestAt: null, lastTestStatus: null,
    lastTestError: null, lastSendError: null, lastSendErrorAt: null, providerManaged: true,
    createdAt: '2026-09-17T12:00:00.000Z', statusChangedAt: '2026-09-17T12:00:00.000Z',
    ...over,
  };
}

describe('TestSendControl', () => {
  it('explains what the test does and sends on click', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<TestSendControl domain={domain()} busy={false} onSend={onSend} />);

    expect(screen.getByTestId('sending-domain-d-1-test').textContent)
      .toContain('to your own sign-in address');

    await user.click(screen.getByTestId('sending-domain-d-1-test-submit'));
    expect(onSend).toHaveBeenCalledWith('d-1');
  });

  it('shows no result line before the first test', () => {
    render(<TestSendControl domain={domain()} busy={false} onSend={vi.fn()} />);
    expect(screen.queryByTestId('sending-domain-d-1-test-result')).toBeNull();
  });

  it('reports an in-flight test and disables the button', () => {
    render(<TestSendControl domain={domain({ lastTestStatus: 'pending' })} busy={false} onSend={vi.fn()} />);
    expect(screen.getByTestId('sending-domain-d-1-test-result').textContent).toBe('Test email in progress…');
    expect((screen.getByTestId('sending-domain-d-1-test-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('reports a sent test with its timestamp', () => {
    render(<TestSendControl
      domain={domain({ lastTestStatus: 'sent', lastTestAt: '2026-09-17T12:30:00.000Z' })}
      busy={false}
      onSend={vi.fn()}
    />);
    expect(screen.getByTestId('sending-domain-d-1-test-result').textContent).toContain('Last test sent');
  });

  it('reports a failed test with the relay error verbatim', () => {
    render(<TestSendControl
      domain={domain({ lastTestStatus: 'failed', lastTestAt: '2026-09-17T12:30:00.000Z', lastTestError: '553 sender rejected' })}
      busy={false}
      onSend={vi.fn()}
    />);
    const result = screen.getByTestId('sending-domain-d-1-test-result');
    expect(result.textContent).toContain('Last test failed');
    expect(result.textContent).toContain('553 sender rejected');
  });

  it('disables the button while the tab is busy', () => {
    render(<TestSendControl domain={domain()} busy onSend={vi.fn()} />);
    expect((screen.getByTestId('sending-domain-d-1-test-submit') as HTMLButtonElement).disabled).toBe(true);
  });
});
```

Run: `cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web && npx vitest run src/components/settings/sendingDomains/TestSendControl.test.tsx`
Expected: FAIL — `Cannot find module './TestSendControl'`.

- [ ] **Step 2: Implement**

Create `apps/web/src/components/settings/sendingDomains/TestSendControl.tsx`:

```tsx
import { useTranslation } from 'react-i18next';
import type { SendingDomainDto } from '@breeze/shared';
import { i18n } from '@/lib/i18n';
import '@/lib/i18n';

export interface TestSendControlProps {
  domain: SendingDomainDto;
  busy: boolean;
  onSend: (domainId: string) => void | Promise<void>;
}

/**
 * One real message from this domain to the calling user's own address. In
 * `static` mode an accepted test send is what verifies the domain (spec §5.1),
 * and a relay refusal is shown verbatim so the operator can fix SendAs rights
 * or the relay's allowed senders.
 */
export default function TestSendControl({ domain, busy, onSend }: TestSendControlProps) {
  const { t } = useTranslation('settings');
  const pending = domain.lastTestStatus === 'pending';
  // Resolved-locale formatting, not a hard-coded pattern
  // (apps/web/src/lib/i18n/extractionQuality.test.ts:189).
  const when = domain.lastTestAt ? new Date(domain.lastTestAt).toLocaleString(i18n.language) : '';

  return (
    <div className="mt-3 rounded-md border bg-muted/20 p-3" data-testid={`sending-domain-${domain.id}-test`}>
      <p className="text-xs font-medium">{t('partnerSendingDomains.testTitle')}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{t('partnerSendingDomains.testDescription')}</p>

      <button
        type="button"
        disabled={busy || pending}
        onClick={() => void onSend(domain.id)}
        className="mt-2 rounded-md border px-2.5 py-1.5 text-sm disabled:opacity-50"
        data-testid={`sending-domain-${domain.id}-test-submit`}
      >
        {t('partnerSendingDomains.testSubmit')}
      </button>

      {domain.lastTestStatus && (
        <p
          className={`mt-1.5 text-xs ${domain.lastTestStatus === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}
          data-testid={`sending-domain-${domain.id}-test-result`}
        >
          {pending && t('partnerSendingDomains.testPending')}
          {domain.lastTestStatus === 'sent' && t('partnerSendingDomains.testLastSent', { when })}
          {domain.lastTestStatus === 'failed'
            && t('partnerSendingDomains.testLastFailed', { when, error: domain.lastTestError ?? '' })}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Run green and commit**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web
npx vitest run src/components/settings/sendingDomains/TestSendControl.test.tsx
```
Expected: all PASS.

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/web/src/components/settings/sendingDomains/TestSendControl.tsx apps/web/src/components/settings/sendingDomains/TestSendControl.test.tsx
git commit -m "feat(web): test-send control with the last test result

One message from the domain to the caller's own sign-in address, with the
in-flight, sent and failed results rendered inline — the relay's refusal text
verbatim, which is what a static-mode operator needs to fix SendAs rights.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 9: `PartnerSendingDomainTab` — fetch, poll, compose

**Files:**
- Create: `apps/web/src/components/settings/PartnerSendingDomainTab.tsx`
- Create: `apps/web/src/components/settings/PartnerSendingDomainTab.test.tsx`

**Interfaces:**
- Consumes: the whole client of Task 2; `domainView` (Task 3);
  `AddDomainForm` (4), `DomainStatusPanel` (6), `SenderIdentitiesForm` (7),
  `TestSendControl` (8); `fetchWithAuth` (for the best-effort `/ticket-config`
  read); `handleActionError` (`apps/web/src/lib/runAction.ts:196`);
  `dispatchTrustDenied` (`apps/web/src/lib/trustProbation.ts:43`); `showToast`;
  `navigateTo` + `loginPathWithNext`.
- Produces: `export default function PartnerSendingDomainTab(): JSX.Element | null`.
- testids: `partner-sending-domains-tab`, `sending-domains-loading`,
  `sending-domains-error`, `sending-domains-retry`, `sending-domains-static-note`,
  `sending-domains-locked`, `sending-domains-locked-reason`,
  `sending-domains-locked-trust`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/settings/PartnerSendingDomainTab.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SendingDomainDto, SendingDomainsCapabilityDto, SendingDomainsListResponse } from '@breeze/shared';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../lib/authScope', () => ({ loginPathWithNext: () => '/login' }));

const api = vi.hoisted(() => ({
  fetchSendingDomains: vi.fn(),
  createSendingDomain: vi.fn(),
  requestSendingDomainCheck: vi.fn(),
  removeSendingDomain: vi.fn(),
  upsertSenderIdentity: vi.fn(),
  deleteSenderIdentity: vi.fn(),
  sendSendingDomainTest: vi.fn(),
}));
vi.mock('../../lib/api/sendingDomains', () => api);

const trust = vi.hoisted(() => ({ dispatchTrustDenied: vi.fn(() => true) }));
vi.mock('../../lib/trustProbation', () => trust);

import { showToast } from '../shared/Toast';
import PartnerSendingDomainTab from './PartnerSendingDomainTab';

const showToastMock = vi.mocked(showToast);

const CAPABILITY: SendingDomainsCapabilityDto = {
  supported: true, provider: 'fake', verifiesByDns: true, eligible: true, maxDomains: 3,
};

function domain(over: Partial<SendingDomainDto> = {}): SendingDomainDto {
  return {
    id: 'd-1', domain: 'mail.acme.test', provider: 'fake', status: 'verified', statusReason: null,
    dnsRecords: [], verifiedAt: null, lastCheckedAt: null, lastTestAt: null, lastTestStatus: null,
    lastTestError: null, lastSendError: null, lastSendErrorAt: null, providerManaged: true,
    createdAt: new Date().toISOString(), statusChangedAt: new Date().toISOString(),
    ...over,
  };
}

function payload(over: Partial<SendingDomainsListResponse> = {}): SendingDomainsListResponse {
  return { capability: CAPABILITY, domains: [], identities: [], ...over };
}

function primeTicketConfig() {
  fetchWithAuth.mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({ data: { inbound: { domainConfigured: true, address: 'acme@tickets.example.com' } } }),
  } as unknown as Response);
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  for (const fn of Object.values(api)) (fn as ReturnType<typeof vi.fn>).mockReset();
  trust.dispatchTrustDenied.mockReturnValue(true);
  primeTicketConfig();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PartnerSendingDomainTab — load', () => {
  it('shows a loading state, then the empty state with the add form', async () => {
    api.fetchSendingDomains.mockResolvedValue({ supported: true, data: payload() });
    render(<PartnerSendingDomainTab />);

    expect(screen.getByTestId('sending-domains-loading')).not.toBeNull();
    expect(await screen.findByTestId('sending-domains-add-form')).not.toBeNull();
    expect(screen.getByTestId('sending-domains-recommendation')).not.toBeNull();
  });

  it('offers a retry when the read fails', async () => {
    api.fetchSendingDomains.mockRejectedValueOnce(new Error('boom'));
    api.fetchSendingDomains.mockResolvedValue({ supported: true, data: payload() });
    const user = userEvent.setup();
    render(<PartnerSendingDomainTab />);

    expect((await screen.findByTestId('sending-domains-error')).textContent)
      .toContain('We could not load your sending domains.');
    await user.click(screen.getByTestId('sending-domains-retry'));
    expect(await screen.findByTestId('sending-domains-add-form')).not.toBeNull();
  });

  it('renders nothing when the instance turns out to have no provider', async () => {
    api.fetchSendingDomains.mockResolvedValue({ supported: false });
    const { container } = render(<PartnerSendingDomainTab />);
    await waitFor(() => expect(screen.queryByTestId('sending-domains-loading')).toBeNull());
    expect(container.querySelector('[data-testid="partner-sending-domains-tab"]')).toBeNull();
  });
});

describe('PartnerSendingDomainTab — not eligible', () => {
  it('locks the card with the reason and hands verification to the trust banner', async () => {
    api.fetchSendingDomains.mockResolvedValue({
      supported: true,
      data: payload({ capability: { ...CAPABILITY, eligible: false, reason: 'probation_default_deny' } }),
    });
    const user = userEvent.setup();
    render(<PartnerSendingDomainTab />);

    expect((await screen.findByTestId('sending-domains-locked-reason')).textContent)
      .toBe('Your account is still being verified. Custom sender addresses unlock once that finishes.');
    expect(screen.queryByTestId('sending-domains-add-form')).toBeNull();

    await user.click(screen.getByTestId('sending-domains-locked-trust'));
    expect(trust.dispatchTrustDenied).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'TRUST_PROBATION', capability: 'custom_sending_domain' }),
    );
  });

  it('explains a send-only provider key and offers no trust handoff', async () => {
    api.fetchSendingDomains.mockResolvedValue({
      supported: true,
      data: payload({ capability: { ...CAPABILITY, supported: false, eligible: false, reason: 'provider_key_send_only' } }),
    });
    render(<PartnerSendingDomainTab />);

    expect((await screen.findByTestId('sending-domains-locked-reason')).textContent)
      .toContain('cannot manage domains');
    expect(screen.queryByTestId('sending-domains-locked-trust')).toBeNull();
  });
});

describe('PartnerSendingDomainTab — static mode', () => {
  it('carries the static note and hides the DNS machinery', async () => {
    api.fetchSendingDomains.mockResolvedValue({
      supported: true,
      data: payload({
        capability: { ...CAPABILITY, provider: 'static', verifiesByDns: false },
        domains: [domain({ provider: 'static', status: 'pending' })],
      }),
    });
    render(<PartnerSendingDomainTab />);

    expect((await screen.findByTestId('sending-domains-static-note')).textContent)
      .toContain('set up outside Breeze');
    expect(screen.queryByTestId('sending-domains-records')).toBeNull();
    expect(screen.queryByTestId('sending-domain-d-1-check')).toBeNull();
  });
});

describe('PartnerSendingDomainTab — mutations', () => {
  it('adds a domain and re-reads', async () => {
    api.fetchSendingDomains.mockResolvedValue({ supported: true, data: payload() });
    api.createSendingDomain.mockResolvedValue(domain({ status: 'provisioning' }));
    const user = userEvent.setup();
    render(<PartnerSendingDomainTab />);

    await user.type(await screen.findByTestId('sending-domains-add-input'), 'mail.acme.test');
    await user.click(screen.getByTestId('sending-domains-add-submit'));

    await waitFor(() => expect(api.createSendingDomain).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'mail.acme.test', maxDomains: 3 }),
    ));
    await waitFor(() => expect(api.fetchSendingDomains).toHaveBeenCalledTimes(2));
  });

  it('surfaces a mutation failure as a toast and stays usable', async () => {
    api.fetchSendingDomains.mockResolvedValue({ supported: true, data: payload() });
    api.createSendingDomain.mockRejectedValue(new Error('network down'));
    const user = userEvent.setup();
    render(<PartnerSendingDomainTab />);

    await user.type(await screen.findByTestId('sending-domains-add-input'), 'mail.acme.test');
    await user.click(screen.getByTestId('sending-domains-add-submit'));

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'Could not add the domain.' }),
    ));
    expect((screen.getByTestId('sending-domains-add-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('confirms before removing, and says the provider domain is kept when Breeze did not create it', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    api.fetchSendingDomains.mockResolvedValue({
      supported: true, data: payload({ domains: [domain({ providerManaged: false })] }),
    });
    api.removeSendingDomain.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<PartnerSendingDomainTab />);

    await user.click(await screen.findByTestId('sending-domain-d-1-remove'));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('never deletes a domain it did not create'));
    expect(api.removeSendingDomain).toHaveBeenCalledWith(expect.objectContaining({ domainId: 'd-1' }));
    confirm.mockRestore();
  });

  it('does not remove when the confirmation is declined', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    api.fetchSendingDomains.mockResolvedValue({ supported: true, data: payload({ domains: [domain()] }) });
    const user = userEvent.setup();
    render(<PartnerSendingDomainTab />);

    await user.click(await screen.findByTestId('sending-domain-d-1-remove'));

    expect(api.removeSendingDomain).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('saves an identity through the client', async () => {
    api.fetchSendingDomains.mockResolvedValue({ supported: true, data: payload({ domains: [domain()] }) });
    api.upsertSenderIdentity.mockResolvedValue({ id: 'i-1' });
    const user = userEvent.setup();
    render(<PartnerSendingDomainTab />);

    await user.click(await screen.findByTestId('sending-identity-support-save'));

    await waitFor(() => expect(api.upsertSenderIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ stream: 'support', sendingDomainId: 'd-1', localPart: 'support' }),
    ));
  });

  it('sends a test from a verified domain', async () => {
    api.fetchSendingDomains.mockResolvedValue({ supported: true, data: payload({ domains: [domain()] }) });
    api.sendSendingDomainTest.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<PartnerSendingDomainTab />);

    await user.click(await screen.findByTestId('sending-domain-d-1-test-submit'));

    await waitFor(() => expect(api.sendSendingDomainTest).toHaveBeenCalledWith(
      expect.objectContaining({ domainId: 'd-1' }),
    ));
  });
});

describe('PartnerSendingDomainTab — polling', () => {
  it('re-reads every 2 seconds while a domain is provisioning', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.fetchSendingDomains.mockResolvedValue({
      supported: true, data: payload({ domains: [domain({ status: 'provisioning' })] }),
    });
    render(<PartnerSendingDomainTab />);

    await waitFor(() => expect(api.fetchSendingDomains).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(api.fetchSendingDomains).toHaveBeenCalledTimes(2);
  });

  it('re-reads every 15 seconds while a domain waits for DNS', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.fetchSendingDomains.mockResolvedValue({
      supported: true, data: payload({ domains: [domain({ status: 'pending' })] }),
    });
    render(<PartnerSendingDomainTab />);

    await waitFor(() => expect(api.fetchSendingDomains).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(14_000); });
    expect(api.fetchSendingDomains).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(api.fetchSendingDomains).toHaveBeenCalledTimes(2);
  });

  it('never polls once everything has settled', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.fetchSendingDomains.mockResolvedValue({ supported: true, data: payload({ domains: [domain()] }) });
    render(<PartnerSendingDomainTab />);

    await waitFor(() => expect(api.fetchSendingDomains).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(api.fetchSendingDomains).toHaveBeenCalledTimes(1);
  });

  it('stops polling on unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.fetchSendingDomains.mockResolvedValue({
      supported: true, data: payload({ domains: [domain({ status: 'provisioning' })] }),
    });
    const { unmount } = render(<PartnerSendingDomainTab />);

    await waitFor(() => expect(api.fetchSendingDomains).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(api.fetchSendingDomains).toHaveBeenCalledTimes(1);
  });

  it('stops polling while the browser tab is hidden and resumes when it comes back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.fetchSendingDomains.mockResolvedValue({
      supported: true, data: payload({ domains: [domain({ status: 'provisioning' })] }),
    });
    render(<PartnerSendingDomainTab />);
    await waitFor(() => expect(api.fetchSendingDomains).toHaveBeenCalledTimes(1));

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(api.fetchSendingDomains).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(api.fetchSendingDomains).toHaveBeenCalledTimes(2);
  });
});
```

Run: `cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web && npx vitest run src/components/settings/PartnerSendingDomainTab.test.tsx`
Expected: FAIL — `Cannot find module './PartnerSendingDomainTab'`.

- [ ] **Step 2: Implement**

Create `apps/web/src/components/settings/PartnerSendingDomainTab.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  PartnerMailStreamValue,
  SendingDomainDto,
  SendingDomainsListResponse,
} from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { handleActionError } from '../../lib/runAction';
import { dispatchTrustDenied } from '../../lib/trustProbation';
import { showToast } from '../shared/Toast';
import {
  createSendingDomain,
  deleteSenderIdentity,
  fetchSendingDomains,
  removeSendingDomain,
  requestSendingDomainCheck,
  sendSendingDomainTest,
  upsertSenderIdentity,
} from '../../lib/api/sendingDomains';
import AddDomainForm from './sendingDomains/AddDomainForm';
import DomainStatusPanel from './sendingDomains/DomainStatusPanel';
import SenderIdentitiesForm from './sendingDomains/SenderIdentitiesForm';
import TestSendControl from './sendingDomains/TestSendControl';
import { isTabVisible, isTrustLock, lockedCopySuffix, pollIntervalMs } from './sendingDomains/domainView';
import '@/lib/i18n';

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

interface InboundState {
  configured: boolean;
  address: string | null;
}

/**
 * Custom sender addresses (spec §10). Self-saving: every control persists
 * itself, so the Partner Settings page's global Save button does not apply.
 *
 * The tab owns the only state in this feature — the list, the poll timer and a
 * single `busy` flag — and hands plain data to the presentational children.
 * Polling follows spec §10: 2 s while provisioning, 15 s while waiting for DNS
 * (or while a removal or test send is in flight), nothing once everything has
 * settled. It stops on unmount and while the browser tab is hidden, so a
 * forgotten tab never holds a 2-second loop open.
 */
export default function PartnerSendingDomainTab() {
  const { t } = useTranslation('settings');
  const [data, setData] = useState<SendingDomainsListResponse | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [inbound, setInbound] = useState<InboundState>({ configured: false, address: null });

  const load = useCallback(async (showSpinner: boolean) => {
    if (showSpinner) setLoading(true);
    try {
      const result = await fetchSendingDomains();
      setNowMs(Date.now());
      if (!result.supported) {
        setUnsupported(true);
        setData(null);
      } else {
        setUnsupported(false);
        setData(result.data);
      }
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
    // Best-effort: the inbound address decides which "where replies go" copy the
    // support stream gets (spec §8.5). A failure just means the conservative
    // no-inbound wording, never a broken tab.
    fetchWithAuth('/ticket-config')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('ticket config unavailable'))))
      .then((body: { data?: { inbound?: { domainConfigured?: boolean; address?: string | null } } }) => {
        const cfg = body.data?.inbound;
        setInbound({ configured: cfg?.domainConfigured === true, address: cfg?.address ?? null });
      })
      .catch(() => setInbound({ configured: false, address: null }));
  }, [load]);

  // One timer per data version. `load` replaces `data`, which re-runs this
  // effect and re-arms — so there is never more than one timer in flight.
  useEffect(() => {
    if (!data) return;
    const interval = pollIntervalMs(data.domains);
    if (interval === null) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const arm = () => {
      if (cancelled || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        if (cancelled || document.visibilityState === 'hidden') return;
        void load(false);
      }, interval);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') arm();
    };

    arm();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [data, load]);

  const maxDomains = data?.capability.maxDomains ?? 0;

  const run = useCallback(
    async (action: () => Promise<unknown>, fallbackKey: string) => {
      setBusy(true);
      try {
        await action();
        await load(false);
      } catch (err) {
        // 401 is the auth redirect's business; a non-ActionError has not been
        // toasted yet; an ActionError already has (lib/runAction.ts:196).
        handleActionError(err, t(/* i18n-dynamic */ `partnerSendingDomains.${fallbackKey}`));
      } finally {
        setBusy(false);
      }
    },
    [load, t],
  );

  const handleAdd = (domain: string) =>
    run(() => createSendingDomain({ domain, maxDomains, onUnauthorized: UNAUTHORIZED }), 'errorAddFailed');

  const handleCheck = (domainId: string) =>
    run(() => requestSendingDomainCheck({ domainId, maxDomains, onUnauthorized: UNAUTHORIZED }), 'errorCheckFailed');

  const handleRemove = (domain: SendingDomainDto) => {
    const message = domain.providerManaged
      ? t('partnerSendingDomains.removeConfirm', { domain: domain.domain })
      : t('partnerSendingDomains.removeConfirmUnmanaged', { domain: domain.domain });
    if (!window.confirm(message)) return Promise.resolve();
    return run(
      () => removeSendingDomain({ domainId: domain.id, maxDomains, onUnauthorized: UNAUTHORIZED }),
      'errorRemoveFailed',
    );
  };

  const handleSaveIdentity = (input: {
    stream: PartnerMailStreamValue; sendingDomainId: string;
    localPart: string; displayName: string | null; replyTo: string | null;
  }) => run(() => upsertSenderIdentity({ ...input, maxDomains, onUnauthorized: UNAUTHORIZED }), 'errorIdentityFailed');

  const handleClearIdentity = (stream: PartnerMailStreamValue) =>
    run(() => deleteSenderIdentity({ stream, maxDomains, onUnauthorized: UNAUTHORIZED }), 'errorIdentityFailed');

  const handleTest = (domainId: string) =>
    run(() => sendSendingDomainTest({ domainId, maxDomains, onUnauthorized: UNAUTHORIZED }), 'errorTestFailed');

  if (loading) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="sending-domains-loading">
        {t('common:states.loading')}
      </p>
    );
  }

  if (loadFailed) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="sending-domains-error">
        {t('partnerSendingDomains.loadFailed')}{' '}
        <button
          type="button"
          onClick={() => void load(true)}
          className="underline hover:text-foreground"
          data-testid="sending-domains-retry"
        >
          {t('common:actions.retry')}
        </button>
      </p>
    );
  }

  // Defensive: the page already hides the tab when the instance has no provider.
  if (unsupported || !data || !isTabVisible(data.capability)) return null;

  const { capability, domains, identities } = data;
  const trustLock = isTrustLock(capability);

  const showVerification = () => {
    const handled = dispatchTrustDenied({
      error: capability.reason === 'restricted' ? 'TRUST_RESTRICTED' : 'TRUST_PROBATION',
      capability: 'custom_sending_domain',
      reason: capability.reason ?? 'probation_default_deny',
      reviewRequested: false,
      meetingUrl: null,
    });
    if (!handled) {
      showToast({
        type: 'error',
        message: t(/* i18n-dynamic */ `partnerSendingDomains.${lockedCopySuffix(capability)}`),
      });
    }
  };

  return (
    <div className="max-w-3xl space-y-4" data-testid="partner-sending-domains-tab">
      <section className="rounded-lg border p-4">
        <h2 className="mb-1 text-sm font-semibold">{t('partnerSendingDomains.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('partnerSendingDomains.description')}</p>
        {!capability.verifiesByDns && (
          <p className="mt-2 text-xs text-muted-foreground" data-testid="sending-domains-static-note">
            {t('partnerSendingDomains.staticNote')}
          </p>
        )}
      </section>

      {!capability.eligible ? (
        <section className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4" data-testid="sending-domains-locked">
          <p className="text-sm font-semibold">{t('partnerSendingDomains.lockedTitle')}</p>
          <p className="mt-1 text-xs" data-testid="sending-domains-locked-reason">
            {t(/* i18n-dynamic */ `partnerSendingDomains.${lockedCopySuffix(capability)}`)}
          </p>
          {trustLock && (
            <button
              type="button"
              onClick={showVerification}
              className="mt-3 rounded-md border px-2.5 py-1.5 text-sm"
              data-testid="sending-domains-locked-trust"
            >
              {t('partnerSendingDomains.lockedShowVerification')}
            </button>
          )}
        </section>
      ) : (
        <>
          <AddDomainForm
            disabled={busy || domains.length >= capability.maxDomains}
            showRecommendation={domains.length === 0}
            onAdd={handleAdd}
          />

          {domains.map((d) => (
            <DomainStatusPanel
              key={d.id}
              domain={d}
              verifiesByDns={capability.verifiesByDns}
              busy={busy}
              nowMs={nowMs}
              onCheckNow={handleCheck}
              onRemove={handleRemove}
            >
              <TestSendControl domain={d} busy={busy} onSend={handleTest} />
            </DomainStatusPanel>
          ))}

          <SenderIdentitiesForm
            domains={domains}
            identities={identities}
            inbound={inbound}
            busy={busy}
            onSave={handleSaveIdentity}
            onClear={handleClearIdentity}
          />
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Run green and commit**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web
npx vitest run src/components/settings/PartnerSendingDomainTab.test.tsx src/components/settings/sendingDomains
```
Expected: all PASS.

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/web/src/components/settings/PartnerSendingDomainTab.tsx apps/web/src/components/settings/PartnerSendingDomainTab.test.tsx
git commit -m "feat(web): custom sender address tab — fetch, poll and compose

The one stateful piece: it reads the list, polls at 2 s while provisioning and
15 s while waiting for DNS, stops on unmount and while the browser tab is hidden,
and routes every mutation through the typed client. A locked card explains an
ineligible partner and hands trust denials to the banner that already knows how
to explain them.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 10: MOUNT — register the tab in Partner Settings

**This is the last task that builds UI.** Without it every component of Tasks
4–9 exists, compiles, and is unreachable: nothing renders
`PartnerSendingDomainTab`, and `/settings/partner#sending-domains` falls back to
the Company tab.

**Files:**
- Modify: `apps/web/src/components/settings/PartnerSettingsPage.tsx`
  - the `lucide-react` import list (`:2-18`) gains `AtSign`
  - a new import of `PartnerSendingDomainTab` beside the other tab imports (`:32`)
  - the `@breeze/shared` type import block (`:38-53`) gains `SendingDomainsCapabilityDto`
  - new imports of `fetchSendingDomains` and `isTabVisible`
  - `TabKey` (`:61`) gains `'sendingDomains'`
  - the **communications** group of `TAB_GROUPS` (`:112-120`) gains the tab, after `ticketing`
  - `SnapshotKey` (`:158`) excludes `'sendingDomains'` — it is self-saving
  - new `sendingDomainsCapability` / `sendingDomainsChecked` state beside `pinnableVersions` (`:224`)
  - a best-effort capability read in `fetchPartner`, after the `/agent-versions/pinnable` block (`:329-332`)
  - a `visibleGroups` memo and a bounce effect
  - the nav render (`:574-582`) uses `visibleGroups`
  - a render branch after the ticketing branch (`:694-701`)
- Modify: `apps/web/src/components/settings/SettingsSectionNav.tsx` — a
  `data-testid` on the rail anchor (`:73-80`)
- Create: `apps/web/src/components/settings/PartnerSettingsPage.sendingDomains.test.tsx`

**Interfaces:**
- Consumes: `PartnerSendingDomainTab` (Task 9), `fetchSendingDomains` (Task 2),
  `isTabVisible` (Task 3), `SendingDomainsCapabilityDto` (`@breeze/shared`).
- Produces: the tab at `/settings/partner#sending-domains`, hidden when the
  instance has no provider; `data-testid="settings-nav-tab-<hash>"` on every
  Partner-Settings and Organization-Settings rail anchor.

- [ ] **Step 1: Write the failing page test**

Create `apps/web/src/components/settings/PartnerSettingsPage.sendingDomains.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import PartnerSettingsPage from './PartnerSettingsPage';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../lib/authScope', () => ({
  getJwtClaims: vi.fn(() => ({ scope: 'partner', orgId: null, partnerId: 'partner-1' })),
  loginPathWithNext: () => '/login',
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('./TicketingSettingsTabs', () => ({ default: () => <div data-testid="stub-ticketing-settings-tabs" /> }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const useOrgStoreMock = vi.mocked(useOrgStore);

const PARTNER = {
  id: 'partner-1', name: 'Acme MSP', slug: 'acme', type: 'partner', plan: 'pro',
  createdAt: '2026-02-09T00:00:00.000Z',
  settings: { timezone: 'UTC', dateFormat: 'MM/DD/YYYY', timeFormat: '12h', language: 'en', businessHours: { preset: 'business' }, contact: {} },
};

const DOMAIN = {
  id: 'd-1', domain: 'mail.acme.test', provider: 'fake', status: 'pending', statusReason: null,
  dnsRecords: [{ purpose: 'dkim', type: 'CNAME', host: 'resend._domainkey', fqdn: 'resend._domainkey.mail.acme.test', value: 'dkim.example', status: 'pending' }],
  verifiedAt: null, lastCheckedAt: null, lastTestAt: null, lastTestStatus: null, lastTestError: null,
  lastSendError: null, lastSendErrorAt: null, providerManaged: true, createdAt: '2026-09-17T12:00:00.000Z',
  statusChangedAt: '2026-09-17T12:00:00.000Z',
};

const VERIFIED_DOMAIN = { ...DOMAIN, status: 'verified', dnsRecords: [{ ...DOMAIN.dnsRecords[0], status: 'verified' }] };

function json(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

function route(sendingDomains: unknown, status = 200) {
  fetchWithAuthMock.mockImplementation((url: string) => {
    if (url === '/orgs/partners/me') return Promise.resolve(json(PARTNER));
    if (url === '/partner/sending-domains') return Promise.resolve(json(sendingDomains, status));
    if (url === '/ticket-config') {
      return Promise.resolve(json({ data: { inbound: { domainConfigured: true, address: 'acme@tickets.example.com' } } }));
    }
    return Promise.resolve(json({ data: [] }));
  });
}

beforeEach(() => {
  fetchWithAuthMock.mockReset();
  window.location.hash = '';
  useOrgStoreMock.mockReturnValue({ currentPartnerId: 'partner-1', isLoading: false, adoptPartnerId: vi.fn() } as never);
});

describe('PartnerSettingsPage — sending domains tab', () => {
  it('hides the tab when this instance has no provider configured', async () => {
    route({ error: 'sending_domains_unsupported' }, 404);
    render(<PartnerSettingsPage />);

    await screen.findByTestId('settings-nav-tab-company');
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith('/partner/sending-domains', expect.anything()));
    expect(screen.queryByTestId('settings-nav-tab-sending-domains')).toBeNull();
  });

  it('shows the tab in the communications group when a provider is configured', async () => {
    route({ capability: { supported: true, provider: 'fake', verifiesByDns: true, eligible: true, maxDomains: 3 }, domains: [], identities: [] });
    render(<PartnerSettingsPage />);

    const link = await screen.findByTestId('settings-nav-tab-sending-domains');
    expect(link.getAttribute('href')).toBe('#sending-domains');
    // Communications group: it sits with Notifications, Ticketing and the AI tabs.
    const group = link.closest('div')!;
    expect(group.textContent).toContain('Communications');
  });

  it('mounts the tab from the URL hash and renders every child module', async () => {
    window.location.hash = '#sending-domains';
    route({
      capability: { supported: true, provider: 'fake', verifiesByDns: true, eligible: true, maxDomains: 3 },
      domains: [VERIFIED_DOMAIN],
      identities: [],
    });
    render(<PartnerSettingsPage />);

    // The tab itself...
    expect(await screen.findByTestId('partner-sending-domains-tab')).not.toBeNull();
    // ...and one testid from each child module it must compose.
    expect(await screen.findByTestId('sending-domains-add-form')).not.toBeNull();       // AddDomainForm
    expect(screen.getByTestId('sending-domain-row-d-1')).not.toBeNull();                 // DomainStatusPanel
    expect(screen.getByTestId('sending-domains-records')).not.toBeNull();                // DnsRecordsTable
    expect(screen.getByTestId('sending-domain-d-1-test')).not.toBeNull();                // TestSendControl
    expect(screen.getByTestId('sending-domains-identities')).not.toBeNull();             // SenderIdentitiesForm
  });

  it('is self-saving: the page shows no global Save button on this tab', async () => {
    window.location.hash = '#sending-domains';
    route({ capability: { supported: true, provider: 'fake', verifiesByDns: true, eligible: true, maxDomains: 3 }, domains: [], identities: [] });
    render(<PartnerSettingsPage />);

    await screen.findByTestId('partner-sending-domains-tab');
    expect(screen.queryByRole('button', { name: /save settings/i })).toBeNull();
  });

  it('falls back to the Company tab when the hash names a tab this instance hides', async () => {
    window.location.hash = '#sending-domains';
    route({ error: 'sending_domains_unsupported' }, 404);
    render(<PartnerSettingsPage />);

    await waitFor(() => expect(screen.queryByTestId('partner-sending-domains-tab')).toBeNull());
    expect(await screen.findByRole('button', { name: /save settings/i })).not.toBeNull();
  });
});
```

Run: `cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web && npx vitest run src/components/settings/PartnerSettingsPage.sendingDomains.test.tsx`
Expected: FAIL — no `settings-nav-tab-company` testid exists yet.

- [ ] **Step 2: Add the nav testid**

In `apps/web/src/components/settings/SettingsSectionNav.tsx`, on the rail anchor
(`:73`), add one attribute after `aria-label`:

```tsx
                      data-testid={`settings-nav-tab-${item.hash}`}
```

so the element reads:

```tsx
                    <a
                      href={`#${item.hash}`}
                      aria-current={isActive ? 'page' : undefined}
                      aria-label={item.dirty ? t('settingsSectionNav.unsavedChanges', { label: item.label }) : item.label}
                      data-testid={`settings-nav-tab-${item.hash}`}
                      onClick={e => {
```

It is derived from `item.hash`, so Partner Settings and Organization Settings
both get one and neither needs a hard-coded list. `e2e-tests/README.md` permits
no other selector, so this is what makes the nav reachable at all.

- [ ] **Step 3: Register the tab**

In `apps/web/src/components/settings/PartnerSettingsPage.tsx`:

Add `AtSign,` as the first entry of the `lucide-react` import list (`:2-18`,
alphabetical — before `Bell`):

```tsx
import {
  AtSign,
  Bell,
```

Add the tab import after the `PartnerRemoteAccessTab` import (`:32`):

```tsx
import PartnerSendingDomainTab from './PartnerSendingDomainTab';
```

Add `SendingDomainsCapabilityDto` to the existing `@breeze/shared` type import
block (`:38-53`), after `IpAllowlistStatus`:

```tsx
  IpAllowlistStatus,
  SendingDomainsCapabilityDto
} from '@breeze/shared';
```

Add two value imports after the `runAction` import (`:56`):

```tsx
import { fetchSendingDomains } from '@/lib/api/sendingDomains';
import { isTabVisible } from './sendingDomains/domainView';
```

Widen `TabKey` (`:61`):

```tsx
type TabKey = 'company' | 'regional' | 'security' | 'notifications' | 'eventLogs' | 'defaults' | 'branding' | 'loginBranding' | 'aiBudgets' | 'aiProvider' | 'remoteAccess' | 'ticketing' | 'sendingDomains';
```

Add the tab to the **communications** group (`:112-120`), immediately after the
`ticketing` entry — it belongs beside the ticketing tab that holds
`InboundEmailCard`, which is the inbound half of the same subject:

```tsx
      { key: 'sendingDomains', hash: 'sending-domains', label: 'partnerSettingsPage.tabs.sendingDomains.label', description: 'partnerSettingsPage.tabs.sendingDomains.description', icon: AtSign, selfSaving: true },
```

Exclude it from dirty tracking (`:158`) — it persists its own changes, exactly
like Ticketing and the AI provider tab:

```tsx
type SnapshotKey = Exclude<TabKey, 'ticketing' | 'loginBranding' | 'aiProvider' | 'sendingDomains'>;
```

Add state beside `pinnableVersions` (`:224`):

```tsx
  // Capability only: the tab does its own full read. `checked` distinguishes
  // "not fetched yet" from "fetched and this instance has no provider", so a
  // deep link to #sending-domains does not bounce to Company mid-flight.
  const [sendingDomainsCapability, setSendingDomainsCapability] = useState<SendingDomainsCapabilityDto | null>(null);
  const [sendingDomainsChecked, setSendingDomainsChecked] = useState(false);
```

Add the best-effort read in `fetchPartner`, immediately after the
`/agent-versions/pinnable` block (`:329-332`):

```tsx
      // Best-effort: decides whether the Sender Addresses tab appears at all.
      // A 404 means EMAIL_DOMAINS_PROVIDER is unset on this instance — the
      // default everywhere — and the tab stays hidden.
      fetchSendingDomains()
        .then((result) => setSendingDomainsCapability(result.supported ? result.data.capability : null))
        .catch(() => setSendingDomainsCapability(null))
        .finally(() => setSendingDomainsChecked(true));
```

Add the visibility memo and the bounce effect immediately after the
`navigateToTab` definition (`:378-382`):

```tsx
  const sendingDomainsVisible = isTabVisible(sendingDomainsCapability);

  // TAB_GROUPS stays a module constant so HASH_TO_TAB keeps resolving
  // `#sending-domains`; visibility is applied to the rendered nav only.
  const visibleGroups = useMemo(
    () => TAB_GROUPS.map(group => ({
      ...group,
      tabs: group.tabs.filter(tab => tab.key !== 'sendingDomains' || sendingDomainsVisible),
    })),
    [sendingDomainsVisible]
  );

  // A bookmark to a tab this instance hides falls back to Company — but only
  // once the capability read has actually settled.
  useEffect(() => {
    if (sendingDomainsChecked && !sendingDomainsVisible && activeTab === 'sendingDomains') {
      setActiveTab('company');
    }
  }, [sendingDomainsChecked, sendingDomainsVisible, activeTab]);
```

Point the nav at the filtered groups (`:575`):

```tsx
          groups={visibleGroups.map(group => ({
```

And render the tab, after the ticketing branch (`:694-701`) and before the
closing `</div>`:

```tsx
          {/* Custom sender addresses: partner sending domains, DNS records,
              per-stream sender identities and the test send. Self-contained
              with its own load/save, so the top-level "Save Settings" button
              does not apply here. */}
          {activeTab === 'sendingDomains' && sendingDomainsVisible && <PartnerSendingDomainTab />}
```

- [ ] **Step 4: Run the page tests green**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web
npx vitest run src/components/settings/PartnerSettingsPage.sendingDomains.test.tsx src/components/settings/PartnerSettingsPage.test.tsx src/components/settings/SettingsSectionNav
pnpm exec astro check
```
Expected: both suites PASS and `astro check` reports no errors. If the existing
`PartnerSettingsPage.test.tsx` fails on an unrouted `/partner/sending-domains`
call, its `fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [] }))`
default already answers it — the capability read is `.catch`-guarded, so a
malformed body only leaves the tab hidden.

- [ ] **Step 5: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/web/src/components/settings/PartnerSettingsPage.tsx apps/web/src/components/settings/SettingsSectionNav.tsx apps/web/src/components/settings/PartnerSettingsPage.sendingDomains.test.tsx
git commit -m "feat(web): mount the Sender Addresses tab in Partner Settings

Registered in the communications group beside Ticketing, deep-linked through the
existing window.location.hash mechanism, and hidden whenever the capability read
404s or reports no provider — the default on every instance that has not set
EMAIL_DOMAINS_PROVIDER. The settings rail anchors gain a derived data-testid so
E2E can reach them at all.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 11: Register the new files with the silent-mutation guard

**Files:**
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`
  - two entries appended to `TARGET_GLOBS`, immediately before the closing `];`
    that follows `'src/components/settings/ProfilePage.tsx'` (`:334-335`)
  - the count assertion (`:675`) 143 → 145, with a comment in the existing style
- **Not** modified: `apps/web/src/lib/runActionAllowlist.ts`. Nothing here needs
  an allowlist entry: every mutation is lexically inside `runAction` in the
  client module, which is what `isMutatingApiWrapper`
  (`no-silent-mutations.test.ts:424-449`) checks before it flags a caller.

**Interfaces:**
- Consumes: the files created in Tasks 2 and 9.
- Produces: nothing importable.

- [ ] **Step 1: Watch the count assertion fail**

Append to `TARGET_GLOBS`:

```ts
  // Partner sending domains W05: the client module holds every mutation for the
  // custom-sender-address surface (add / check / remove / identity upsert and
  // clear / test send), each already wrapped in runAction. Guarding the file is
  // about the NEXT mutation — a bare fetchWithAuth added beside them would
  // silently fail on the surface that decides what address a partner's
  // customers see mail from, and would also un-guard every caller, because
  // isMutatingApiWrapper only clears a caller while the wrapper stays wrapped.
  'src/lib/api/sendingDomains.ts',
  // The tab itself has no fetchWithAuth today — it goes through the client
  // above — and is listed so a future direct mutation cannot be added here
  // without CI noticing. TARGET_GLOBS is a literal file list, not directory-wide.
  'src/components/settings/PartnerSendingDomainTab.tsx',
```

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web
npx vitest run src/lib/__tests__/no-silent-mutations.test.ts
```
Expected: FAIL on `expected 145 to be 143` in the guarded-file-count test.

- [ ] **Step 2: Bump the count**

At `:675`, append to the running comment and change the number:

```ts
    // #4050 adds settings/ProfilePage.tsx (account security): 142 → 143.
    // Partner sending domains W05 adds lib/api/sendingDomains.ts and
    // settings/PartnerSendingDomainTab.tsx: 143 → 145.
    expect(absoluteFiles.length).toBe(145);
```

- [ ] **Step 3: Run green and commit**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web
npx vitest run src/lib/__tests__/no-silent-mutations.test.ts
```
Expected: all PASS, including the per-file
`src/lib/api/sendingDomains.ts: every mutating fetchWithAuth is wrapped by
runAction or explicitly exempt`.

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/web/src/lib/__tests__/no-silent-mutations.test.ts
git commit -m "test(web): guard the sending-domain client against silent mutations

Both new files join TARGET_GLOBS. No runActionAllowlist entry is needed — every
mutation is lexically inside runAction in the client module, which is also what
keeps its callers clear of the guard.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 12: E2E — page object, spec, and the `fake` provider in the stack

**How `EMAIL_DOMAINS_PROVIDER=fake` reaches the API and the worker.** W02 Task 5
already did the plumbing that makes the variable *possible*: it declared the key
in `apps/api/src/config/validate.ts`, documented it in `.env.example` and
`deploy/.env.example`, and mapped it in the `x-api-env: &api-env` anchor of both
`docker-compose.yml` and `deploy/docker-compose.prod.yml`. That anchor is merged
by the `api` service **and** the `worker` service, which is the only mechanism
that reaches both containers — Compose interpolates only what the anchor names,
so a value in `.env` alone is inert. **W05 adds nothing to those four files.**
What is left is choosing the value in the two places that start an E2E stack:
`scripts/dev/wt-stack/env.ts` for a local run, and the `portal-dev-e2e` job's
`.env` heredoc for CI. The dev stack runs one `api` container with
`BREEZE_ROLE=all` (there is no separate `worker` container locally or in CI), so
the same process serves the routes and runs the `sending-domains` worker.

**Files:**
- Create: `e2e-tests/pages/PartnerSendingDomainsPage.ts`
- Create: `e2e-tests/tests/partner-sending-domains.spec.ts`
- Modify: `scripts/dev/wt-stack/env.ts` — one entry in `DEV_ENV`, after
  `MFA_FORCE_FOR_PARTNER_ADMIN: 'false',` (`:40`)
- Modify: `.github/workflows/ci.yml` — one line in the `portal-dev-e2e` job's
  "Create .env for the dev stack" heredoc, after `MFA_FORCE_FOR_PARTNER_ADMIN=false`
  (`~:3427`); and the spec appended to the "Run the portal hydration specs"
  command (`:3511`)

**Interfaces:**
- Consumes: `BasePage` (`e2e-tests/pages/BasePage.ts`), `waitForAppReady`
  (`e2e-tests/pages/hydration.ts`), the `authedPage` fixture
  (`e2e-tests/fixtures.ts:12`), `clearRefreshState`
  (`e2e-tests/test-helpers.ts:29`), and the `fake` adapter's deterministic
  domain names (W02 Task 8): `*.verify.test` verifies, `*.fail.test` fails,
  `conflict.test` conflicts, `preexisting.*` is adopted already verified.
- Produces: `export class PartnerSendingDomainsPage extends BasePage`.

Two facts the executor should not re-derive:
- `authedPage` **is** the partner-scoped session (`admin@breeze.local`, the
  seeded `Partner Admin`). There is no second partner fixture.
- The write routes carry `requireMfa()`. That passes here because
  `MFA_FORCE_FOR_PARTNER_ADMIN=false` makes the effective MFA policy
  non-required for that admin, so login mints `mfa: true`
  (`routes/auth/login.ts:632`). Both stacks already pin that variable; do not
  remove it.

- [ ] **Step 1: Set the provider for the local dev stack**

In `scripts/dev/wt-stack/env.ts`, add to `DEV_ENV` immediately after
`MFA_FORCE_FOR_PARTNER_ADMIN: 'false',`:

```ts
  // Partner sending domains W05. `fake` is the deterministic adapter: it makes
  // no external calls, verifies `*.verify.test` on the first check, fails
  // `*.fail.test`, and hands a send to the platform transport so Mailpit shows
  // the custom From. config/validate.ts refuses it in production, and the
  // settings tab is hidden whenever this is unset — which is why the E2E spec
  // needs it. .env.stack is passed LAST to compose, so this wins over a stale
  // root .env, and docker-compose.yml's x-api-env anchor (added in W02) is what
  // carries it into the api and worker containers.
  EMAIL_DOMAINS_PROVIDER: 'fake',
```

- [ ] **Step 2: Write the page object**

Create `e2e-tests/pages/PartnerSendingDomainsPage.ts`:

```ts
import { BasePage } from './BasePage';
import { waitForAppReady } from './hydration';

/**
 * `/settings/partner#sending-domains` — custom sender addresses.
 *
 * Navigation is by URL fragment rather than by clicking the rail, because the
 * tab state of this page lives in `window.location.hash`; `navTab()` is here so
 * a test can still assert the tab is (or is not) offered in the nav.
 *
 * Every locator is a `data-testid` — e2e-tests/README.md makes that the only
 * permitted selector.
 */
export class PartnerSendingDomainsPage extends BasePage {
  url = '/settings/partner#sending-domains';

  root = () => this.page.getByTestId('partner-sending-domains-tab');
  navTab = () => this.page.getByTestId('settings-nav-tab-sending-domains');

  addInput = () => this.page.getByTestId('sending-domains-add-input');
  addSubmit = () => this.page.getByTestId('sending-domains-add-submit');
  recommendation = () => this.page.getByTestId('sending-domains-recommendation');
  records = () => this.page.getByTestId('sending-domains-records');
  recordCopy = (index: number) => this.page.getByTestId(`sending-domain-record-${index}-copy`);

  lockedCard = () => this.page.getByTestId('sending-domains-locked');
  lockedReason = () => this.page.getByTestId('sending-domains-locked-reason');

  domainRow = (id: string) => this.page.getByTestId(`sending-domain-row-${id}`);
  domainStatus = (id: string) => this.page.getByTestId(`sending-domain-${id}-status`);
  checkNow = (id: string) => this.page.getByTestId(`sending-domain-${id}-check`);
  retry = (id: string) => this.page.getByTestId(`sending-domain-${id}-retry`);
  remove = (id: string) => this.page.getByTestId(`sending-domain-${id}-remove`);
  failedReason = (id: string) => this.page.getByTestId(`sending-domain-${id}-failed`);
  testSubmit = (id: string) => this.page.getByTestId(`sending-domain-${id}-test-submit`);
  testResult = (id: string) => this.page.getByTestId(`sending-domain-${id}-test-result`);

  identityLocalPart = (stream: string) => this.page.getByTestId(`sending-identity-${stream}-localpart`);
  identityDomain = (stream: string) => this.page.getByTestId(`sending-identity-${stream}-domain`);
  identitySave = (stream: string) => this.page.getByTestId(`sending-identity-${stream}-save`);
  identityFrom = (stream: string) => this.page.getByTestId(`sending-identity-${stream}-from`);
  identityClear = (stream: string) => this.page.getByTestId(`sending-identity-${stream}-clear`);

  async goto() {
    await this.page.goto(this.url);
    await this.waitUntilReady();
  }

  /**
   * Astro SSRs this island, so the tab's testid is present and "actionable"
   * before React attaches its handlers — a fill or click in that window is
   * silently swallowed. Wait for a hydrated root every time.
   */
  async waitUntilReady() {
    await waitForAppReady(this.page, 'partner-sending-domains-tab');
  }

  /** Add a domain and return the created row's id, read from the POST response. */
  async addDomain(domain: string): Promise<string> {
    await this.addInput().fill(domain);
    const [response] = await Promise.all([
      this.page.waitForResponse(
        (r) => r.request().method() === 'POST'
          && new URL(r.url()).pathname.endsWith('/partner/sending-domains'),
      ),
      this.addSubmit().click(),
    ]);
    const body = (await response.json()) as { id: string };
    return body.id;
  }
}
```

- [ ] **Step 3: Write the spec**

Create `e2e-tests/tests/partner-sending-domains.spec.ts`:

```ts
import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import { PartnerSendingDomainsPage } from '../pages/PartnerSendingDomainsPage';

/**
 * Partner sending domains W05 — the browser slice of spec §14's E2E bullet.
 *
 * Runs against the `fake` email-domain provider (EMAIL_DOMAINS_PROVIDER=fake in
 * the dev stack), whose behaviour is keyed on the DOMAIN NAME, so no seeding is
 * needed: `*.verify.test` verifies on the first check and `*.fail.test` fails.
 * Each test mints a unique label so re-running against a live stack cannot trip
 * the `UNIQUE (domain)` constraint.
 *
 * What only a browser proves here: that the tab is reachable from the URL hash
 * at all, that the DNS records the API returns actually render, and that the
 * add → verify → configure → test → remove loop survives the polling that
 * refreshes the page underneath each step.
 */
test.describe.configure({ mode: 'serial' });
test.beforeEach(clearRefreshState);

function uniqueDomain(suffix: string): string {
  return `w04-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}.${suffix}`;
}

test.describe('Partner sending domains', () => {
  test('add, verify, configure a sender address, test send and remove', async ({ authedPage }) => {
    const page = new PartnerSendingDomainsPage(authedPage);
    const domain = uniqueDomain('verify.test');
    let domainId = '';

    await test.step('1. The tab is offered and opens on its own hash', async () => {
      await page.goto();
      await expect(page.navTab()).toBeVisible();
      await expect(page.recommendation()).toBeVisible();
    });

    await test.step('2. Adding the domain creates a row', async () => {
      domainId = await page.addDomain(domain);
      await expect(page.domainRow(domainId)).toBeVisible();
    });

    await test.step('3. The DNS records appear', async () => {
      await expect(page.records()).toBeVisible({ timeout: 30_000 });
      await page.recordCopy(0).click();
    });

    await test.step('4. Check now drives it to verified', async () => {
      await expect(page.checkNow(domainId)).toBeVisible({ timeout: 30_000 });
      await Promise.all([
        authedPage.waitForResponse(
          (r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(`/${domainId}/check`),
        ),
        page.checkNow(domainId).click(),
      ]);
      await expect(page.domainStatus(domainId)).toHaveText('Verified', { timeout: 30_000 });
    });

    await test.step('5. The support stream takes an address on that domain', async () => {
      await page.identityLocalPart('support').fill('helpdesk');
      await page.identityDomain('support').selectOption(domainId);
      const [putResponse] = await Promise.all([
        authedPage.waitForResponse(
          (r) => r.request().method() === 'PUT' && new URL(r.url()).pathname.endsWith('/identities/support'),
        ),
        page.identitySave('support').click(),
      ]);
      expect(putResponse.ok()).toBe(true);

      await authedPage.reload();
      await page.waitUntilReady();
      await expect(page.identityFrom('support')).toContainText(`helpdesk@${domain}`);
      await expect(page.identityClear('support')).toBeVisible();
    });

    await test.step('6. A test send is accepted and recorded on the row', async () => {
      const [testResponse] = await Promise.all([
        authedPage.waitForResponse(
          (r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(`/${domainId}/test`),
        ),
        page.testSubmit(domainId).click(),
      ]);
      expect(testResponse.status()).toBe(202);

      // The worker writes last_test_* asynchronously; a reload is deterministic
      // where waiting on the 15 s poll is not.
      await expect(async () => {
        await authedPage.reload();
        await page.waitUntilReady();
        await expect(page.testResult(domainId)).toBeVisible();
      }).toPass({ timeout: 60_000 });
    });

    await test.step('7. Removing it takes the row away', async () => {
      authedPage.once('dialog', (dialog) => void dialog.accept());
      await Promise.all([
        authedPage.waitForResponse(
          (r) => r.request().method() === 'DELETE' && new URL(r.url()).pathname.endsWith(`/${domainId}`),
        ),
        page.remove(domainId).click(),
      ]);
      await expect(async () => {
        await authedPage.reload();
        await page.waitUntilReady();
        await expect(page.domainRow(domainId)).toHaveCount(0);
      }).toPass({ timeout: 60_000 });
    });
  });

  test('a domain the provider rejects explains itself and offers Try again and Remove', async ({ authedPage }) => {
    const page = new PartnerSendingDomainsPage(authedPage);
    await page.goto();

    const domainId = await page.addDomain(uniqueDomain('fail.test'));

    await expect(page.failedReason(domainId)).toBeVisible({ timeout: 60_000 });
    await expect(page.retry(domainId)).toBeVisible();
    await expect(page.remove(domainId)).toBeVisible();

    authedPage.once('dialog', (dialog) => void dialog.accept());
    await Promise.all([
      authedPage.waitForResponse(
        (r) => r.request().method() === 'DELETE' && new URL(r.url()).pathname.endsWith(`/${domainId}`),
      ),
      page.remove(domainId).click(),
    ]);
  });

  test('an ineligible partner sees a locked card and no add form', async ({ authedPage }) => {
    // Trust mode is `off` on a self-hosted stack, so ineligibility cannot be
    // produced by seeding — the capability is rewritten on the wire instead.
    // Everything downstream of `eligible: false` is real UI.
    await authedPage.route('**/partner/sending-domains*', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      const body = await response.json();
      body.capability = { ...body.capability, eligible: false, reason: 'probation_default_deny' };
      body.domains = [];
      body.identities = [];
      await route.fulfill({ response, json: body });
    });

    const page = new PartnerSendingDomainsPage(authedPage);
    await page.goto();

    await expect(page.lockedCard()).toBeVisible();
    await expect(page.lockedReason()).toContainText('still being verified');
    await expect(page.addSubmit()).toHaveCount(0);
  });
});
```

- [ ] **Step 4: Wire CI**

In `.github/workflows/ci.yml`, in the `portal-dev-e2e` job's
"Create .env for the dev stack" heredoc, after
`MFA_FORCE_FOR_PARTNER_ADMIN=false`:

```
          # tests/partner-sending-domains.spec.ts needs a sending-domain
          # provider; `fake` is deterministic and makes no external calls.
          # Redundant with wt-stack's .env.stack, which is passed last, but this
          # job spells such keys out by convention.
          EMAIL_DOMAINS_PROVIDER=fake
```

and append the spec to the run command (`:3511`):

```
        run: ./e2e-tests/node_modules/.bin/tsx scripts/dev/wt-stack/cli.ts test -- tests/multi-currency.spec.ts tests/portal-visibility.spec.ts tests/ai-agents.spec.ts tests/partner-sending-domains.spec.ts
```

Note for the reviewer, to be repeated in the PR body: `portal-dev-e2e` carries
`continue-on-error: true` (ci.yml:3358) and is not in `ci-success`'s `needs`, so
this spec cannot fail the build. It is signal, not a gate.

- [ ] **Step 5: Run it against a real stack**

`e2e-tests/README.md:117` — "Don't merge a spec that hasn't been verified
against a running stack."

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
pnpm wt-stack up
pnpm wt-stack test -- tests/partner-sending-domains.spec.ts
pnpm wt-stack down
```
Expected: three tests PASS. Tear the stack down — nothing reaps it for you.

- [ ] **Step 6: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add e2e-tests/pages/PartnerSendingDomainsPage.ts e2e-tests/tests/partner-sending-domains.spec.ts scripts/dev/wt-stack/env.ts .github/workflows/ci.yml
git commit -m "test(e2e): partner sending domains against the fake provider

Add, verify, configure the support stream, test send and remove, plus the
provider-rejection path and the not-eligible locked card. The dev stack and the
portal-dev-e2e job set EMAIL_DOMAINS_PROVIDER=fake; the compose mapping that
carries it into the api and worker containers already shipped in W02.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 13: Documentation — `apps/docs` page and the cross-link

**Files:**
- Create: `apps/docs/src/content/docs/deploy/custom-sender-addresses.mdx`
- Modify: `apps/docs/src/content/docs/deploy/environment.mdx` — one cross-link
  line at the end of the `## Email` table (`:152`, immediately before
  `## SMS (Twilio)` at `:153`)
- **Not** modified: `apps/docs/astro.config.mjs`. The Deployment sidebar is
  `autogenerate: { directory: 'deploy' }` (`:31-34`), so dropping the file into
  that directory *is* the sidebar change. Ordering comes from `sidebar.order` in
  the frontmatter.

**Interfaces:**
- Consumes: `Aside`, `Steps`, `Tabs`, `TabItem` from
  `@astrojs/starlight/components` — the four components every deploy page uses,
  imported on line 9 exactly as `production.mdx:9` does.
- Produces: the page at `/deploy/custom-sender-addresses/`.

Nothing in CI validates internal links or sidebar coverage — `astro check` only
type-checks frontmatter against `docsSchema()` and the component imports. Read
the cross-link back once by eye.

- [ ] **Step 1: Write the page**

Create `apps/docs/src/content/docs/deploy/custom-sender-addresses.mdx`:

````mdx
---
title: Custom sender addresses
description: "Send Breeze RMM email from your own domain: one address via EMAIL_FROM, per-stream addresses on any relay, or the DNS wizard with a domain API."
sidebar:
  order: 3
  label: Custom Sender Addresses
---

import { Aside, Steps, Tabs, TabItem } from '@astrojs/starlight/components';

Out of the box, every email Breeze sends leaves from one address: whatever you
set as `EMAIL_FROM`. That is fine for a single-tenant install, but it means a
ticket update, an invoice and a password reset all arrive from the same mailbox,
and on a multi-partner server they all arrive from yours.

Custom sender addresses let a partner send customer-facing mail from a domain
they control, with a different address per kind of mail — `support@` for ticket
updates, `billing@` for quotes and invoices. This page is about the mail Breeze
**sends**. It has nothing to do with `TICKETS_INBOUND_DOMAIN`, which is the
address Breeze **receives** on, or with `MAILGUN_DOMAIN`.

<Aside>
  This is entirely opt-in. Upgrading changes nothing: the release adds three
  empty tables, no new environment variable is required, the background worker
  is not registered, the settings tab is hidden, and every email is byte for byte
  what it was before. Nothing below happens until you set
  `EMAIL_DOMAINS_PROVIDER`.
</Aside>

## Which setup you want

| | One address | Per-stream addresses | DNS wizard |
|---|---|---|---|
| `EMAIL_DOMAINS_PROVIDER` | unset | `static` | `resend` |
| Works on | any transport | any transport — SMTP relay, Mailgun, Resend | Resend only |
| Who proves the domain | you, by setting `EMAIL_FROM` | you, by listing it and sending a test | the partner, by publishing DNS records |
| Addresses you get | one, for everything | one per mail stream | one per mail stream |
| Extra setup | none | your relay must already be allowed to send as those addresses | a Resend key that can manage domains |
| Suits | a single-tenant install | most self-hosters | a server with several partners, or one that wants Breeze to check DNS |

## One address for everything

This is what you already have. `EMAIL_FROM` is the sender for every message, and
you can give it a display name:

```bash
EMAIL_FROM="Acme IT <support@acme.com>"
```

Nothing else on this page applies. Skip to [Environment
Variables](/deploy/environment/) if that is all you wanted.

## Per-stream addresses on any relay

Set `EMAIL_DOMAINS_PROVIDER=static` when you relay through SMTP, Microsoft 365,
Postfix, Amazon SES SMTP or Mailgun — anywhere Breeze has no domain API to ask.
You tell Breeze which domains this server's mail relay is allowed to send as,
and Breeze takes you at your word.

<Aside type="caution" title="The precondition, in one sentence">
  Your relay must already be allowed to send as those addresses — Microsoft 365
  SendAs rights, a Postfix sender map, the relay's own verified domains — with
  SPF and DKIM for the domain already in place.
</Aside>

**Listing a domain does not authorise it.** `EMAIL_DOMAINS_STATIC_ALLOWED` is
your statement that the relay will accept those senders; Breeze cannot check it,
and it does not publish, sign or verify anything on your behalf. SPF and DKIM for
those domains are part of your mail setup, not part of Breeze.

<Steps>

1. **List the domains, then restart.**

   ```bash
   EMAIL_DOMAINS_PROVIDER=static
   EMAIL_DOMAINS_STATIC_ALLOWED=acme.com
   ```

   On a server with more than one partner, bind each entry to the partner that
   may claim it, by slug:

   ```bash
   EMAIL_DOMAINS_STATIC_ALLOWED=acme.com:acme,northwind.example:northwind
   ```

   An unbound entry can be claimed by any partner on the server, which is the
   right behaviour for a single-partner install and the wrong one for a shared
   server. A partner who tries to add a domain you have not listed is told to ask
   their Breeze administrator.

2. **Add the domain in the interface.**

   Partner Settings, under Communications, now has a **Sender Addresses** tab.
   Add the domain there. It sits in "Waiting for DNS" until the next step —
   there are no DNS records to publish in this mode.

3. **Send the test email, which is what verifies it.**

   The test sends one real message from the domain to your own sign-in address.
   If your relay accepts it, the domain becomes verified and usable. If the relay
   refuses the sender, the domain stays unverified and the relay's refusal is
   shown verbatim, which is almost always a missing SendAs right or a sender map
   that does not cover the address.

4. **Choose the addresses.**

   Set the local part for each stream you care about. A stream you leave alone
   keeps sending from `EMAIL_FROM`; there is no implicit fallback between
   streams, so what you configure is exactly what changes.

</Steps>

If your relay later stops accepting the sender — a SendAs right is revoked, say —
the message is not lost: it goes out from `EMAIL_FROM` instead, and the refusal
appears on the domain so you can fix it.

## The DNS wizard

Set `EMAIL_DOMAINS_PROVIDER=resend` when your Breeze server sends through Resend
and you want Breeze to create the domain, show the records to publish, and check
them for you. This is what hosted Breeze runs.

<Steps>

1. **Use a key that can manage domains.**

   ```bash
   EMAIL_DOMAINS_PROVIDER=resend
   EMAIL_DOMAINS_RESEND_API_KEY=re_...
   EMAIL_DOMAINS_REGION=us-east-1
   ```

   It must be a `full_access` key. A sending-only key can send mail but cannot
   create or check a domain, and Breeze will say so in the settings tab rather
   than failing every attempt. One account for both the platform sender and
   partner domains is fine on a self-hosted server — see the trade-off below.

2. **Add the domain in Partner Settings.**

   Breeze creates it at the provider and shows the DKIM, SPF and return-path
   records to publish, each with the exact name that has to resolve.

3. **Publish the records and wait.**

   Breeze re-checks on its own — every two minutes at first, then less often —
   and you can force a check from the tab. DNS changes can take up to 72 hours to
   become visible.

</Steps>

**A domain that is already verified in your Resend account is adopted, not
recreated.** It shows as verified immediately, and Breeze will never delete it —
removing it from Breeze drops the local record and leaves your provider account
untouched. That matters because the domain you are most likely to add is the one
your `EMAIL_FROM` already uses.

## Environment variables

Every one of these is optional, and none is ever required by an upgrade.
Validation only ever complains about a contradiction you introduced — `resend`
with no key, or `fake` in production.

| Variable | Default | Description |
|---|---|---|
| `EMAIL_DOMAINS_PROVIDER` | unset | `resend`, `static` or `fake`. Unset means the feature is off: the settings tab is hidden and the routes answer 404. `fake` is a deterministic test double, refused in production |
| `EMAIL_DOMAINS_STATIC_ALLOWED` | empty | `static` only. Comma-separated `domain` or `domain:partner-slug`. Your statement that this server's relay may send as these domains |
| `EMAIL_DOMAINS_RESEND_API_KEY` | — | `resend` only, required. A `full_access` key; a sending-only key cannot manage domains |
| `EMAIL_DOMAINS_RESEND_SENDING_KEY` | falls back to the key above | Optional sending-only key of the same account, so the send path never holds the management key |
| `EMAIL_DOMAINS_REGION` | `us-east-1` | Region for newly created domains: `us-east-1`, `eu-west-1`, `sa-east-1`, `ap-northeast-1` |
| `EMAIL_DOMAINS_MAX_PER_PARTNER` | `3` | How many sending domains one partner may hold |
| `EMAIL_DOMAINS_DAILY_SEND_CAP` | unlimited when self-hosted | Messages per partner per UTC day on the custom-domain lane. `0` is unlimited. Over the cap, mail goes out from `EMAIL_FROM` as it would today |
| `EMAIL_DOMAINS_PARTNER_ALLOWLIST` | empty | Comma-separated partner ids. Empty means every eligible partner |
| `EMAIL_DOMAINS_DENYLIST` | empty | Extra domains nobody on this server may add |
| `EMAIL_DOMAINS_WEBHOOK_SECRET` | — | Delivery-webhook signing secret. Unset leaves the endpoint inert, which is the right setting behind NAT or a VPN |

## Mapping the variables into your containers

If you run the compose file that ships with Breeze, the upgrade brings the
mapping with it and there is nothing to do. If you maintain your own compose
file, a value in `.env` alone is inert — Compose only interpolates what the
service block names. Add these to the environment of both your `api` service and,
if you run one, your `worker` service:

```yaml
  EMAIL_DOMAINS_PROVIDER: ${EMAIL_DOMAINS_PROVIDER:-}
  EMAIL_DOMAINS_STATIC_ALLOWED: ${EMAIL_DOMAINS_STATIC_ALLOWED:-}
  EMAIL_DOMAINS_RESEND_API_KEY: ${EMAIL_DOMAINS_RESEND_API_KEY:-}
  EMAIL_DOMAINS_RESEND_SENDING_KEY: ${EMAIL_DOMAINS_RESEND_SENDING_KEY:-}
  EMAIL_DOMAINS_REGION: ${EMAIL_DOMAINS_REGION:-}
  EMAIL_DOMAINS_MAX_PER_PARTNER: ${EMAIL_DOMAINS_MAX_PER_PARTNER:-}
  EMAIL_DOMAINS_DAILY_SEND_CAP: ${EMAIL_DOMAINS_DAILY_SEND_CAP:-}
  EMAIL_DOMAINS_PARTNER_ALLOWLIST: ${EMAIL_DOMAINS_PARTNER_ALLOWLIST:-}
  EMAIL_DOMAINS_DENYLIST: ${EMAIL_DOMAINS_DENYLIST:-}
  EMAIL_DOMAINS_WEBHOOK_SECRET: ${EMAIL_DOMAINS_WEBHOOK_SECRET:-}
```

The domain worker runs wherever your background jobs run, so if you have split
the worker into its own container the same block has to reach it too.

## What sharing one Resend account trades away

Hosted Breeze keeps partner-domain mail in a **separate** Resend account from the
mail that carries password resets and security notices, and refuses to start if
the two keys match. Self-hosted, you may point
`EMAIL_DOMAINS_RESEND_API_KEY` at the same account as `RESEND_API_KEY`, and
Breeze logs one informational line when you do.

What you give up is isolation of reputation. Resend enforces its bounce and spam
limits **account-wide**: if mail from a partner's domain draws enough complaints
to pause the account, it pauses password resets and account-recovery mail with
it. On a single-partner server that is usually an acceptable trade, since it is
all your own mail either way. On a server with several partners it is not — one
partner's list hygiene can lock everyone else out of their own account. Use a
second Resend account there.

## What your technicians will see

The **Sender Addresses** tab lives in Partner Settings, under Communications,
next to Ticketing. Three things on it are worth explaining once.

**A dedicated subdomain is better than the root domain.** Both work, and the tab
says so, but `mail.acme.com` keeps the sending reputation of Breeze mail separate
from the rest of the company's mail; a root domain already verified with the
email provider somewhere else cannot be added at all, because Breeze never takes
a domain away from another account; and some mail filters flag an outside sender
that uses the recipient's own domain even when DKIM passes, which matters most
for internal teams whose customers are colleagues.

**The DNS records are shown with the exact name that has to resolve.** DKIM lives
under `resend._domainkey`, and SPF and the return path under `send`, so none of
them collide with the mail the domain already handles. The most common reason a
domain never verifies is pasting the short label where the provider wanted the
full name, which is why both are on screen.

**Replies do not always go where the From address does.** Ticket email sets
Reply-To to the Breeze inbound address, so a customer's reply lands back on the
ticket. Quotes and invoices set Reply-To to the partner's billing email. Portal
invitations, password resets and scheduled reports set no Reply-To at all, so a
reply goes to the address chosen in the tab. Make each address a real mailbox or
an alias: people and auto-responders answer the From address regardless of what
Reply-To says. On a server with no inbound address configured at all, that is
true of ticket email too, and the tab warns about it.

## Related

- [Environment Variables](/deploy/environment/)
- [Inbound email-to-ticket](/deploy/environment/#inbound-email-to-ticket-mailgun)
````

- [ ] **Step 2: Link it from the environment page**

In `apps/docs/src/content/docs/deploy/environment.mdx`, after the last row of
the `## Email` table (`:152`) and before `## SMS (Twilio)` (`:153`), insert a
blank line and:

```mdx
Sending customer-facing mail from a partner's own domain, rather than from
`EMAIL_FROM`, is set up separately — see [Custom sender
addresses](/deploy/custom-sender-addresses/) for the `EMAIL_DOMAINS_*` variables
and the three ways to configure them.
```

- [ ] **Step 3: Check and build the docs**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
pnpm --filter @breeze/docs check
pnpm --filter @breeze/docs build
```
Expected: both PASS. Then open the built page once and confirm the cross-link
resolves — nothing in CI checks internal links.

- [ ] **Step 4: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/docs/src/content/docs/deploy/custom-sender-addresses.mdx apps/docs/src/content/docs/deploy/environment.mdx
git commit -m "docs(deploy): custom sender addresses

The three setups side by side — one address via EMAIL_FROM, per-stream addresses
on any relay via static, and the DNS wizard via resend — with the precondition
for static stated plainly, the full EMAIL_DOMAINS_* table, the compose mapping
for operators on their own compose file, the multi-partner slug binding, and what
sharing one Resend account between the two lanes trades away.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 14: Release-notes callout (ready to paste at cut time)

Release notes are written when the release is cut, not here, so this task
**adds no file**. It records the text so the person cutting the release does not
have to reconstruct it, and so the reviewer can check it against §16.2.

**Files:**
- None. This block is copied into the GitHub Release body's self-hoster section
  by the `release` skill when the release that contains W05 is cut.

- [ ] **Step 1: Record the block in the PR body**

Paste this into the PR description under a `## Release notes` heading, so it
travels with the change and the release author finds it by searching the merged
PRs in the range:

```markdown
### Custom sender addresses (optional, off by default)

**Upgrading is a no-op.** This release adds three empty tables. No new
environment variable is required, no existing one changes meaning, the domain
worker is not registered, the new settings tab is hidden, and every email is
byte for byte what it was before. Nothing changes until you opt in.

If you want per-stream sender addresses — `support@` for ticket updates,
`billing@` for quotes and invoices — instead of one `EMAIL_FROM` for everything,
there are two ways in:

- **On SMTP, Microsoft 365, Postfix or Mailgun:** set
  `EMAIL_DOMAINS_PROVIDER=static` and `EMAIL_DOMAINS_STATIC_ALLOWED=yourdomain.com`,
  restart, add the domain in Partner Settings → Sender Addresses, and send the
  test email that verifies it. Your relay must already be allowed to send as
  those addresses, with SPF and DKIM for the domain already in place — listing a
  domain here does not authorise it.
- **On Resend:** set `EMAIL_DOMAINS_PROVIDER=resend` and
  `EMAIL_DOMAINS_RESEND_API_KEY` to a `full_access` key (a sending-only key
  cannot manage domains). A domain already verified in your account is adopted,
  shows as verified at once, and is never deleted by Breeze.

New optional variables, all unset by default: `EMAIL_DOMAINS_PROVIDER`,
`EMAIL_DOMAINS_STATIC_ALLOWED`, `EMAIL_DOMAINS_RESEND_API_KEY`,
`EMAIL_DOMAINS_RESEND_SENDING_KEY`, `EMAIL_DOMAINS_REGION`,
`EMAIL_DOMAINS_MAX_PER_PARTNER`, `EMAIL_DOMAINS_DAILY_SEND_CAP`,
`EMAIL_DOMAINS_PARTNER_ALLOWLIST`, `EMAIL_DOMAINS_DENYLIST`,
`EMAIL_DOMAINS_WEBHOOK_SECRET`.

If you maintain your own compose file rather than the one that ships with
Breeze, the variables need mapping into the `api` (and `worker`) service
environment — a value in `.env` alone is inert. The lines to add are in
[Custom sender addresses](https://docs.breezermm.com/deploy/custom-sender-addresses/).
```

---

## Task 15: Verification

The last task. Nothing new is written here; everything is run.

**Files:**
- None.

- [ ] **Step 1: Type-check the web app**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web
pnpm exec astro check
```
Expected: 0 errors, 0 warnings from the new files. This is the exact command
CI's `typecheck` job runs (`.github/workflows/ci.yml:305-307`); there is no
`typecheck` script in `apps/web/package.json`.

- [ ] **Step 2: Run every test file this wave created or touched**

Run, as one command so the file count is visible:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web
npx vitest run \
  src/lib/api/sendingDomains.test.ts \
  src/components/settings/sendingDomains/domainView.test.ts \
  src/components/settings/sendingDomains/AddDomainForm.test.tsx \
  src/components/settings/sendingDomains/DnsRecordsTable.test.tsx \
  src/components/settings/sendingDomains/DomainStatusPanel.test.tsx \
  src/components/settings/sendingDomains/SenderIdentitiesForm.test.tsx \
  src/components/settings/sendingDomains/TestSendControl.test.tsx \
  src/components/settings/PartnerSendingDomainTab.test.tsx \
  src/components/settings/PartnerSettingsPage.sendingDomains.test.tsx \
  src/components/settings/PartnerSettingsPage.test.tsx
```
Expected: **10 test files**, all PASS. Check the reported file count — vitest's
path filter is a plain substring match, so a typo silently runs fewer files than
you listed rather than erroring.

- [ ] **Step 3: Run the two contract suites this wave has to satisfy, by path**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web
npx vitest run src/lib/__tests__/no-silent-mutations.test.ts
npx vitest run src/lib/i18n
```
Expected: both PASS. The second covers `localeParity`, `translationCoverage`,
`keyUsage`, `extractionQuality` and `terminologyQuality` — the suite that fails
on a missing locale key, an English copy over the budget, a `t()` key that does
not resolve, a glued `{t('x')}{value}` adjacency, or a hard-coded date format.

- [ ] **Step 4: Run the full web unit suite**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
pnpm --filter=@breeze/web test --run
```
Expected: PASS. This is CI's `Test Web` job verbatim
(`.github/workflows/ci.yml:698`). Note the missing `--` — `pnpm --filter … test
-- --run` forwards the literal token, vitest swallows `--run`, and the run never
exits watch mode.

- [ ] **Step 5: Check and build the docs**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
pnpm --filter @breeze/docs check
pnpm --filter @breeze/docs build
```
Expected: both PASS. These are the two run steps of CI's `docs-check` job
(`.github/workflows/ci.yml:169-173`).

- [ ] **Step 6: Run the E2E spec against a live stack**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
pnpm wt-stack up
pnpm wt-stack test -- tests/partner-sending-domains.spec.ts
pnpm wt-stack down
```
Expected: three tests PASS, then the stack is gone. Confirm nothing is left
behind — `pnpm wt-stack down` can silently no-op from the wrong worktree or
branch:
```bash
docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'
```
Expected: no project from this worktree still running.

- [ ] **Step 7: Open the PR**

Branch `feature/__PARENT__-partner-sending-domains/wave-__W05__`, PR body
contains `Closes #__W05__`, the release-notes block from Task 14 under a
`## Release notes` heading, and a line stating that `portal-dev-e2e` is
non-blocking so the new spec is signal rather than a gate. `get_feature_status`
and `complete_wave` per the feature-lifecycle skill.

---

## Operator rollout checklist — NOT a Codex task

Everything below is done by a human against real infrastructure, after this
wave's PR has merged. It is recorded here because spec §16.1 and §14 are part of
what W05 delivers, and because the first three steps are what turn the feature on
for the first hosted partner. **No task above depends on any of it, and an
implementing agent must not attempt any of it.**

- [ ] **§16.1 step 1 — create the partner-lane provider accounts.** One Resend
  team per region (US, and EU created in `eu-west-1`), Pro plan, a `full_access`
  API key each. Add `EMAIL_DOMAINS_PROVIDER`, `EMAIL_DOMAINS_RESEND_API_KEY`,
  `EMAIL_DOMAINS_REGION` and the caps to `/opt/breeze/.env` on **both**
  droplets, **and** map every one of them in the `api` (and `worker`) service
  `environment:` block of `/opt/breeze/docker-compose.yml`. A value in `.env`
  alone is inert. The hosted rule is enforced at boot: the partner-lane key must
  differ from `RESEND_API_KEY`, and `static` is refused when `IS_HOSTED=true`.

- [ ] **§16.1 step 2 — merge W01 through W05 with the provider still unset.**
  Nothing changes for any tenant: the tab is hidden, the routes 404, the worker
  is not registered, and W01's golden test is the proof that no rendered email
  moved.

- [ ] **§16.1 step 3 — turn it on for one partner.** Confirm
  `PARTNER_TRUST_MODE=enforce` on both regions. Set `EMAIL_DOMAINS_PROVIDER` and
  an `EMAIL_DOMAINS_PARTNER_ALLOWLIST` containing OliveTech only. Verify with
  the version-parity enumeration from CLAUDE.md that both regions are actually
  running the release that contains W05 — `/health` cannot see a service that
  was never rolled.

- [ ] **§14 lab check — before any other partner is enabled.** On a
  LanternOps-owned subdomain, on the hosted partner-lane account:
  - add the domain through the tab, publish the records, watch it verify;
  - send a real customer-facing message and confirm `dkim=pass` with `header.d`
    equal to the partner domain, and a DMARC pass, at **both** Gmail and
    Microsoft 365;
  - reply to a ticket notification from the customer side and confirm the reply
    lands on the ticket;
  - delete the DKIM record and drill the whole degradation path:
    `verified` → `at_risk` (amber banner naming the record, mail still flowing)
    → `failed` → mail falling back to `EMAIL_FROM` with nothing lost.

- [ ] **Self-hosted smoke, `static` mode.** On a non-production self-hosted rig,
  set `EMAIL_DOMAINS_PROVIDER=static` and `EMAIL_DOMAINS_STATIC_ALLOWED` to a
  domain the relay may send as, add it, send the test that verifies it, set the
  `support` address, and confirm a ticket notification arrives from it. Then
  remove the domain from `EMAIL_DOMAINS_STATIC_ALLOWED`, restart, and confirm the
  row moves to failed and mail falls back to `EMAIL_FROM` rather than being lost.

---

## Self-review

Every row of the spec §10 state table, every §16.2 documentation bullet, and the
three blanket rules at the foot of §10, mapped to the task that delivers it and
the test that proves it.

### Spec §10 — web UI state table

| §10 row | Task | Proof |
|---|---|---|
| unsupported → tab hidden | 9, 10 | `domainView.test.ts` "hides the tab when this instance has no provider configured"; `PartnerSettingsPage.sendingDomains.test.tsx` "hides the tab when this instance has no provider configured" and "falls back to the Company tab when the hash names a tab this instance hides" |
| `static` mode — no DNS table, no Check now | 6, 9 | `DomainStatusPanel.test.tsx` "shows no records table, no Check now, and the verify-by-test hint"; `PartnerSendingDomainTab.test.tsx` "carries the static note and hides the DNS machinery" |
| `static` mode — "Send a test email to verify" | 6, 8 | `DomainStatusPanel.test.tsx` static hint; `TestSendControl.test.tsx` "explains what the test does and sends on click" |
| `static` mode — the note about SPF/DKIM outside Breeze | 9 | `PartnerSendingDomainTab.test.tsx` static note assertion on `sending-domains-static-note` |
| `static` mode — "Ask your Breeze administrator to allow this domain." | 3, 6 | `domainView.test.ts` "tells a static-mode rejection to ask the instance administrator"; `DomainStatusPanel.test.tsx` same, rendered |
| not eligible — locked card with the reason | 3, 9 | `domainView.test.ts` `lockedCopySuffix` table; `PartnerSendingDomainTab.test.tsx` "locks the card with the reason…" and "explains a send-only provider key…" |
| not eligible — link to the trust surface | 9 | `PartnerSendingDomainTab.test.tsx` asserts `dispatchTrustDenied` is called with `capability: 'custom_sending_domain'` (plan amendment 5: there is no trust *page*; the mounted `TrustProbationBanner` is the surface) |
| empty — form plus the subdomain recommendation and its three §4.2 reasons | 4 | `AddDomainForm.test.tsx` "shows the subdomain recommendation and all three reasons in the empty state" |
| `provisioning` — "Preparing DNS records…", polls every 2 s | 3, 6, 9 | `domainView.test.ts` "polls fast while a domain is provisioning"; `DomainStatusPanel.test.tsx` provisioning copy; `PartnerSendingDomainTab.test.tsx` "re-reads every 2 seconds while a domain is provisioning" |
| `provisioning` — §13 delay notice after 2 min | 3, 6 | `domainView.test.ts` `isProvisioningSlow` boundary cases; `DomainStatusPanel.test.tsx` "stays quiet for the first two minutes" / "shows the delay notice after two minutes" |
| `pending` — records table with Type, Host, FQDN, Value, Priority, per-record status | 5 | `DnsRecordsTable.test.tsx` "renders every column of spec §10 for every record" and "shows a per-record status" |
| `pending` — copy buttons | 5 | `DnsRecordsTable.test.tsx` "copies a record value and says so" |
| `pending` — "Check now" | 6 | `DomainStatusPanel.test.tsx` "shows the records table and Check now" |
| `pending` — auto-refresh every 15 s | 3, 9 | `domainView.test.ts` "polls slowly while a domain waits for DNS"; `PartnerSendingDomainTab.test.tsx` "re-reads every 15 seconds while a domain waits for DNS" |
| `pending` — the 72 h note | 5 | `DnsRecordsTable.test.tsx` "carries the 72-hour note while the domain is still waiting" |
| `verified` — stream identities form with suggested local parts | 7 | `SenderIdentitiesForm.test.tsx` "renders all three streams with their suggested local parts" |
| `verified` — where-replies-go text per stream (§8.3 precedence, §4.4 mailbox guidance) | 7 | `SenderIdentitiesForm.test.tsx` "states where replies go for each stream" and the mailbox hint rendered above the streams |
| `verified` — §8.5 no-inbound-configured warning | 7, 9 | `SenderIdentitiesForm.test.tsx` "warns on the support stream when this instance has no inbound address"; the tab's best-effort `/ticket-config` read supplies it |
| `verified` — test send plus last test result | 8 | `TestSendControl.test.tsx` in-flight, sent and failed result cases |
| `at_risk` — amber banner naming the missing record | 3, 6 | `domainView.test.ts` `firstUnhealthyRecord`; `DomainStatusPanel.test.tsx` "names the missing record in the at-risk banner" |
| `failed` — reason from `statusReason` | 3, 6 | `domainView.test.ts` `failureCopySuffix` table; `DomainStatusPanel.test.tsx` "explains a failure and offers both Try again and Remove" |
| `failed` — Retry inside the window, and Remove | 3, 6 | `domainView.test.ts` `isInsideRetryWindow` — inside, outside, non-failed and unparseable cases; `DomainStatusPanel.test.tsx` "explains a failure and offers both Try again and Remove" plus "drops Try again once the 72-hour retry window has passed, keeping Remove". The window is measured from `statusChangedAt`; the server re-enforces it, so a click racing the boundary still surfaces the server error |
| `suspended` — contact support, no actions | 6 | `DomainStatusPanel.test.tsx` "offers no action at all on a suspended domain" |
| `removing` — disabled row | 6 | `DomainStatusPanel.test.tsx` "disables the row while it is being removed" |
| `lastSendError` display | 6 | `DomainStatusPanel.test.tsx` "shows the most recent delivery refusal whatever the status is" |
| "All mutations go through `runAction`" | 2, 11 | `sendingDomains.test.ts` toast and 401 assertions; `no-silent-mutations.test.ts` per-file check on the two new `TARGET_GLOBS` entries, with no allowlist entry |
| "New i18n keys get real translations in every shipped locale" | 1 | `localeParity.test.ts` (key sets, interpolation tokens, protected literals) and `translationCoverage.test.ts` (English-copy budget) across all eight locales |
| "Every interactive element has a `data-testid`" | 4–10 | every component test queries by `data-testid` only, as does the whole E2E spec |

### Other spec sections this wave owns

| Requirement | Task | Proof |
|---|---|---|
| §4.1 client-side validation uses the shared normaliser | 4 | `AddDomainForm.test.tsx` "normalises with the shared validator before calling onAdd" and "refuses a structurally invalid domain client-side" |
| §4.4 identity rules; the partner never types a full From address | 7 | `SenderIdentitiesForm.test.tsx` reserved / malformed local part, display-name spoof, Reply-To cases; the From address is composed and shown, never typed |
| §7 error codes map to specific copy (`409 domain_unavailable`, caps, rate limits) | 2 | `sendingDomains.test.ts` `sendingDomainFriendlyError` table and the 409 / 429 toast assertions |
| `provider_rejected` surfaces correctly in both modes | 3, 6 | `domainView.test.ts` static vs DNS branch; `DomainStatusPanel.test.tsx` both cases |
| Polling stops on unmount and when the tab is hidden | 9 | `PartnerSendingDomainTab.test.tsx` "stops polling on unmount" and "stops polling while the browser tab is hidden and resumes when it comes back" |
| UI state in `window.location.hash`, not a query param | 10 | `PartnerSettingsPage.sendingDomains.test.tsx` "mounts the tab from the URL hash…"; the tab reuses the page's existing `HASH_TO_TAB` mechanism |
| §14 E2E bullet — add → records → check → verified → configure `support` → test send → remove, plus not-eligible | 12 | `e2e-tests/tests/partner-sending-domains.spec.ts` test 1 and test 3 |
| §14 E2E — a `*.fail.test` path | 12 | same spec, test 2 |
| §16.1 rollout steps 1–3 and the §14 lab check | — | the operator checklist above, deliberately not a task |

### Spec §16.2 — self-hosted documentation bullets

| §16.2 bullet | Task | Where it lands |
|---|---|---|
| "Upgrading is a no-op" — three empty tables, no required variable, worker not registered, tab hidden, every email unchanged | 13, 14 | the `Aside` under the page intro, and the first paragraph of the release-notes block |
| Opting in on SMTP or Mailgun (`static`): set the two variables, restart, add the domain, send the test that verifies it, set `support` and `billing` | 13 | "Per-stream addresses on any relay", the four `Steps` |
| The precondition in one sentence — the relay must already be allowed to send as those addresses, with SPF/DKIM in place | 13 | the `Aside type="caution" title="The precondition, in one sentence"` |
| Opting in on Resend: a `full_access` key is needed, a sending-only key cannot manage domains, one account for both lanes is fine, a pre-existing domain is adopted and never deleted | 13 | "The DNS wizard", steps 1 and 3 plus the adoption paragraph |
| The docs page itself: under the deploy docs, linked from `deploy/environment.mdx`, three setups side by side, compose mapping lines | 13 | `deploy/custom-sender-addresses.mdx`; "Which setup you want"; "Mapping the variables into your containers"; the cross-link inserted at the end of `## Email` |
| Multi-partner instances: bind each `static` entry with `domain:partner-slug`; an unbound entry can be claimed by any partner | 13 | "Per-stream addresses on any relay", step 1 |
| §5.1 "listing a domain does not authorise it" | 13 | the bolded sentence directly under the precondition aside |
| §11 environment variable table | 13 | "Environment variables" |
| §2 what sharing one key trades away | 13 | "What sharing one Resend account trades away" |
| Partner-facing help: DNS records, the subdomain recommendation, where replies go | 13 | "What your technicians will see", three paragraphs |
| The release-notes / GitHub Release self-hoster callout | 14 | the ready-to-paste block, carried in the PR body to the release author |
