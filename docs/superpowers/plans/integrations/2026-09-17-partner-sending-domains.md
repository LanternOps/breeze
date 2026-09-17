---
tracking_issue: LanternOps/breeze#__PARENT__
---
# Partner sending domains — Plan Index

**Spec:** `docs/superpowers/specs/integrations/2026-09-17-partner-sending-domains-design.md`
(approved by Todd 2026-09-17 as written; D1–D7 resolved per the §12
recommendations). The amendments below are applied by these plans.

One plan document per wave. Each wave is one PR on its own branch
`feature/__PARENT__-partner-sending-domains/wave-<sub-issue#>` with
`Closes #<sub-issue#>` in the PR body. State lives on GitHub
(feature-lifecycle); the wave issue is the source of truth for status, never
this index. `get_feature_status` before starting any wave.

| Wave | Plan | Depends on |
|---|---|---|
| W01 (#__W01__) | [Sender contract: `MAIL_PURPOSES` registry, required `purpose` on `sendEmail`, raw `from` removed, every send site classified, `resolveSender` (platform lane only), `deliverRaw`, golden test](2026-09-17-partner-sending-domains-w01-sender-contract.md) | — |
| W02a (#__W02A__) | [Foundation A: migration (three tables, RLS, release guard), Drizzle schema, allowlist registrations, shared validators, env + boot validation, `EmailDomainProvider` with `resend` / `static` / `fake` adapters, `custom_sending_domain` capability](2026-09-17-partner-sending-domains-w02a-data-model-and-adapters.md) | W01 (`deliverRaw`) |
| W02b (#__W02B__) | [Foundation B: domain service, `sending-domains` worker and cadence, partner and admin routes, release hooks in `cascadeDeletePartner` / `finalizePartnerOffboarding`, audit, status-transition mail, drift report](2026-09-17-partner-sending-domains-w02b-service-worker-routes.md) | W02a |
| W03 (#__W03__) | [Partner lane: partner branch of `resolveSender`, partner-lane send with fallback semantics, daily cap, `X-Breeze-Outbound` and loop prevention](2026-09-17-partner-sending-domains-w03-partner-lane.md) | W01, W02b |
| W04 (#__W04__) | [Web UI and docs: settings tab (DNS and `static` variants), identities, test send, i18n, E2E, `apps/docs` page, self-hosting guide](2026-09-17-partner-sending-domains-w04-web-ui-and-docs.md) | W02b (UI), W03 (end-to-end) |
| W05 (#__W05__) | [Feedback and abuse: delivery webhooks, daily stats, automatic suspension, abuse signals, evidence-card entry, admin metrics](2026-09-17-partner-sending-domains-w05-delivery-feedback-and-abuse.md) | W03 |

W01 → W02a → W02b → W03 are serial. W04 may start once W02b has merged (its
E2E needs W03). W05 starts after W03. Hosted stays dark (provider unset) through
W03; W04 enables allow-listed partners; W05 is the hosted GA gate (spec §15, §16).

## Spec amendments these plans apply

1. **W02 is split into W02a and W02b.** The spec's W02 (three tables + RLS +
   three adapters + worker + two route files + cascade hooks) is too large for
   one review round on a tenancy surface. W02a is data model, config and
   adapters; W02b is everything that calls them. Both land dark.
2. **W01 and W02 are not parallel.** The spec (§15) calls them file-disjoint,
   but the `static` and `fake` adapters and the `test-send` job hand a message
   with a custom From to the platform transport, and W01 removes `from` from
   `SendEmailParams`. W01 therefore adds the one sanctioned raw entry point,
   `EmailService.deliverRaw`, and W02a consumes it. Serial order, no rebase
   hazard.
3. **`PartnerLaneSendError` is carried by a class.** The spec types the error as
   a union and says `send` "throws" it. Adapters throw
   `PartnerLaneSendFailure extends Error` whose `.error` is the spec's union.
4. **`partnerName` travels with the send.** The `partner_display_name` fallback
   (`"<Partner> via Breeze" <EMAIL_FROM>`) needs the partner's name, and W01
   must not add a database read. The two call sites already hold the name and
   pass it; see `SendEmailParams` below.
5. **`sending_domain.test` is a tag value, not a registry entry.** The test send
   bypasses `sendEmail` (§6.1), and the registry asserts every purpose has a
   send site. `staff.sending_domain_status` is added to the registry by W02b,
   together with its send site.
6. **Existing behaviour pinned, not fixed:** the Mailgun branch of `sendEmail`
   drops `cc` today (`services/email.ts:275-284`). W01's golden test records
   that as-is; fixing it is a separate issue, not part of a byte-identical wave.

## Migration slots reserved

Newest committed migration on `origin/main` (`5104a31e7`, 2026-09-17) is
`2026-10-17-140000-snmp-metrics-instance-width.sql`. Open plan branches hold
slots through `2026-10-19-100100`. These plans take the `2026-10-20-10` block.

| File | Wave |
|---|---|
| `2026-10-20-100000-partner-sending-domains.sql` | W02a |
| `2026-10-20-100100-partner-sending-daily-stats.sql` | W05 |

Every executor re-checks `ls apps/api/migrations/*.sql | sort | tail -1` before
committing and renames upward if main has moved past these names. W01, W02b,
W03 and W04 need no migration.

## Cross-wave names that must not drift

Later waves consume these verbatim. A wave that needs a different shape changes
this index in the same PR.

### Defined in W01

`apps/api/src/services/emailDomains/mailPurposes.ts`

```ts
export type PartnerMailStream = 'support' | 'billing' | 'general';
export type MailPurposePolicy =
  | { lane: 'platform' }
  | { lane: 'partner'; stream: PartnerMailStream; fallbackFrom: 'default' | 'partner_display_name' };
export const MAIL_PURPOSES = { /* one entry per row of spec §8.2 */ } as const satisfies Record<string, MailPurposePolicy>;
export type MailPurpose = keyof typeof MAIL_PURPOSES;
export type PartnerLaneMailPurpose = { [K in MailPurpose]: (typeof MAIL_PURPOSES)[K] extends { lane: 'partner' } ? K : never }[MailPurpose];
export type PlatformMailPurpose = Exclude<MailPurpose, PartnerLaneMailPurpose>;
export function mailPurposePolicy(purpose: MailPurpose): MailPurposePolicy;
```

`apps/api/src/services/emailDomains/senderResolution.ts`

```ts
export type PlatformLaneReason =
  | 'platform_purpose' | 'no_partner' | 'lane_unconfigured'      // W01
  | 'not_allowlisted' | 'partner_ineligible' | 'no_identity'     // W03
  | 'domain_not_sendable' | 'over_cap';                          // W03
export type ResolvedSender =
  | { lane: 'platform'; from: string; reason: PlatformLaneReason }
  | { lane: 'partner'; from: string; replyTo: string | null; partnerId: string;
      domainId: string; domain: string; stream: PartnerMailStream };
export interface ResolveSenderInput {
  purpose: MailPurpose;
  partnerId: string | null;
  partnerName?: string | null;
  defaultFrom: string;              // EmailService's configured EMAIL_FROM
}
export function resolveSender(input: ResolveSenderInput): Promise<ResolvedSender>;
export function platformFallbackFrom(purpose: MailPurpose, defaultFrom: string, partnerName?: string | null): string;
```

`apps/api/src/services/email.ts`

```ts
interface SendEmailBase { to; cc?; subject; html; text?; replyTo?; headers?; attachments? }   // today's fields minus `from`
export type SendEmailParams = SendEmailBase & (
  | { purpose: PlatformMailPurpose; partnerId?: never; partnerName?: never }
  | { purpose: PartnerLaneMailPurpose; partnerId: string | null; partnerName?: string | null }
);
export interface RawEmailMessage extends SendEmailBase { from: string }
class EmailService {
  sendEmail(params: SendEmailParams): Promise<void>;
  /** @internal Only `services/emailDomains/**` may call this; enforced by a source-scan test. */
  deliverRaw(message: RawEmailMessage): Promise<void>;
}
```

### Defined in W02a

- Drizzle, `apps/api/src/db/schema/emailSendingDomains.ts`: `partnerSendingDomains`,
  `partnerSenderIdentities`, `emailProviderDomainReleases`. Column names exactly
  as spec §3.1–§3.3 (snake_case in SQL, camelCase in Drizzle).
- Constants, `packages/shared/src/validators/sendingDomains.ts`:
  `SENDING_DOMAIN_STATUSES`, `SENDING_DOMAIN_STATUS_REASONS`,
  `PARTNER_MAIL_STREAMS`, `normalizeSendingDomain`, `senderLocalPartSchema`,
  `senderDisplayNameSchema`, `createSendingDomainSchema`,
  `upsertSenderIdentitySchema`. DTO types in
  `packages/shared/src/types/sendingDomains.ts`: `SendingDomainDto`,
  `SenderIdentityDto`, `SendingDomainsCapabilityDto`,
  `SendingDomainsListResponse`, `SendingDomainDnsRecordDto`.
- `apps/api/src/services/emailDomains/provider.ts`: the spec §5 types verbatim
  (`SendingDomainStatus`, `ProviderDnsRecord`, `ProviderDomain`,
  `PartnerLaneSendError`, `EmailDomainProvider`) plus
  `PartnerLaneMessage = RawEmailMessage` and
  `class PartnerLaneSendFailure extends Error { readonly error: PartnerLaneSendError }`.
- `apps/api/src/services/emailDomains/config.ts`: `getEmailDomainsConfig()`
  (parsed `EMAIL_DOMAINS_*`), `isPartnerLaneConfigured()`.
- `apps/api/src/services/emailDomains/providerRegistry.ts`:
  `getEmailDomainProvider(): EmailDomainProvider | null`,
  `resetEmailDomainProviderForTests()`.
- Adapters: `services/emailDomains/adapters/{resend,static,fake}.ts` exporting
  `createResendDomainProvider`, `createStaticDomainProvider`,
  `createFakeDomainProvider`.
- `GatedCapability` gains `'custom_sending_domain'` (`services/partnerTrust.ts`).

### Defined in W02b

- `apps/api/src/services/emailDomains/sendingDomainService.ts`:
  `listSendingDomains`, `createSendingDomain`, `requestDomainCheck`,
  `requestDomainRemoval`, `upsertSenderIdentity`, `deleteSenderIdentity`,
  `suspendSendingDomain`, `unsuspendSendingDomain`, `forceReleaseSendingDomain`,
  `getSendingDomainsCapability`.
- `apps/api/src/services/emailDomains/domainRelease.ts`:
  `releaseSendingDomainsForPartner(partnerId: string): Promise<number>`.
- `apps/api/src/services/emailDomains/domainSync.ts`: `syncSendingDomain(domainId, opts?)`,
  `nextCheckDelayMs(status, checkAttempts)`.
- `apps/api/src/jobs/sendingDomainsWorker.ts`: queue name `sending-domains`;
  `enqueueSyncDomain(domainId: string, opts?: { lastSendError?: string }): Promise<void>`,
  `enqueueTestSend(domainId: string, userId: string): Promise<void>`,
  `initializeSendingDomainsWorker()`, `shutdownSendingDomainsWorker()`.
- Routes: `apps/api/src/routes/partnerSendingDomains.ts` exporting
  `partnerSendingDomainsRoutes`, mounted at `/partner/sending-domains`;
  `apps/api/src/routes/admin/sendingDomains.ts` exporting
  `adminSendingDomainsRoutes`.
- Registry entry `'staff.sending_domain_status': { lane: 'platform' }`.

### Defined in W03

- `apps/api/src/services/emailDomains/partnerLaneSend.ts`: `sendOnPartnerLane`.
- `apps/api/src/services/emailDomains/sendCap.ts`:
  `tryCountPartnerLaneSend(partnerId: string): Promise<boolean>`.
- `BREEZE_OUTBOUND_HEADER = 'X-Breeze-Outbound'`
  (`services/emailDomains/outboundMarker.ts`), consumed by
  `services/inboundEmail/loopPrevention.ts`.
- Provider tags on every partner-lane message: `partner_id`, `domain_id`,
  `stream`, `purpose` (W05 attributes webhook events by them).

### Defined in W05

- Table `partner_sending_daily_stats`, Drizzle `partnerSendingDailyStats`
  (same schema file). Webhook route `POST /webhooks/email-provider/resend`.
  `services/emailDomains/autoSuspend.ts`: `evaluateAutoSuspension`.

## Rules every wave inherits

- Rigor is **high** for W02a, W02b, W03 and W05 (tenancy, partner cascade, send
  path, public webhook): red first on every task, contract suites
  (`vitest.config.rls.ts`, `vitest.integration.config.ts`) before the PR, one
  independent review round. W01 and W04 are wide but low-risk: red first,
  typecheck, affected tests.
- Test commands: `cd apps/api && npx vitest run <path>` (never
  `pnpm --filter … test -- --run`); integration suites need
  `pnpm test-stack up` and are torn down with `pnpm test-stack down`.
- Partner-axis tables return zero rows to org-scoped and portal contexts. Any
  read from those contexts goes through `readWithPartnerAxisVisibility`
  (`apps/api/src/db/partnerAxisRead.ts`) and is proven by an integration test
  on real Postgres; a mocked DB cannot see the zero-row failure.
- No route handler calls the provider. Routes write intent rows; the worker
  calls out.
- Never delete a provider domain with `provider_managed = false`.
- No new env var is ever required by an upgrade; `requireIf` is keyed on
  `EMAIL_DOMAINS_PROVIDER`, never on `EMAIL_PROVIDER`.
- Every UI wave ends with an explicit mount task naming the page; every route
  wave has a task that registers the route in `apps/api/src/index.ts` and a
  test that reaches it through the app.
- Commit after every task with the trailer
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Deferred (roadmap, recorded when the feature is registered)

SES adapter with per-partner SES tenants and the regional cutover; Breeze-issued
TXT ownership challenge before provider create (D6 alternative); a `staff`
stream for alert and staff mail (D5); plan gating of custom domains (D1);
branded inbound domains (Model B) and its mirror cross-partner check (§3.4); a
Mailgun domain-API adapter; a resolver cache; extending the
`"<Partner> via Breeze"` display name to more purposes on hosted; dropping the
system-context escape in `resolveSender` once #2822 lands a read-only
partner-axis RLS branch; Mailgun `cc` being dropped by `sendEmail`.
