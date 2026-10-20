# Web i18n pt-BR translation gaps design

**Date:** 2026-10-19
**Status:** Proposed — for maintainer review
**Locale:** Brazilian Portuguese (`pt-BR`)
**Related:** #3859 (web i18n Phase 3)

## Objective

Translate the web console strings that still appear in English in the `pt-BR` catalog (`apps/web/src/locales/pt-BR`), without changing keys, components, or other locales.

## Current state

Measured against `upstream/main` at `7530ebcc3`.

- Key parity is complete: every locale has 0 missing and 0 extra keys relative to `en` (`localeParity.test.ts`). The remaining gap is in values, not keys.
- Of 29,468 `en` keys, 1,255 `pt-BR` values are identical to English. Most are legitimate: URLs and placeholders, product and vendor names, acronyms, and accepted loanwords (Status, Software, Backup, Webhook). Duplicate growth is already capped per namespace in `translationCoverage.test.ts`.
- The following English values are rendered in the UI (usage confirmed by searching the components):
  - **Post-patch restart prompt** (`policies.json`, `configurationPolicies.featureTabs.patchTab.*`, used by `PatchTab.tsx`): 14 keys — `rebootDelayMinutes` and its description, `rebootAllowDeferral` and its description, `rebootMaxDeferralsDescription`, `rebootDeferralMinutes` and its description, `rebootPromptText` and its description, `rebootPromptButton`, `rebootPromptBodyDescription`, `rebootPromptInvalid`, `rebootPromptTitle` ("Title"), `rebootPromptBody` ("Message").
  - **Autopay email templates** (`settings.json`, `emailTemplates.*`): about 16 keys — variables (`setup_link`, `ach_mode_text`, `payment_method`, `schedule_text`, `fee_text`, `stopped_by`, `open_invoices_text`, `expires_on`, `update_link`, `client_name`), labels (`autopay_request`, `autopay_enrolled`, `autopay_stopped`, `card_expiring`), and groups (`billingPayments`, `supportPortal`).
  - **Standalone terms:** `common.nav.payments` and `billing.partnerBillingSettingsTabs.payments` ("Payments"); `pages.titles.billingAutopay` ("Automatic payments"); `backup.backupVerificationTab.estRtoMin` and `estRpoMin` ("Est. RTO/RPO (min)").
  - **Conflict with the glossary** (`apps/web/src/locales/TERMINOLOGY.md` maps ticket to "chamado" in pt-BR, and the catalog uses "chamado" elsewhere): `common.longTail.psa.PsaTicketList.headers.ticket` ("Ticket"), `common.longTail.time.TimerWidget.ticketFallback` ("ticket"), `devices.deviceDetails.tickets` ("Tickets").
- The estimated total is about 40 keys; the exact count is settled during implementation.
- The restart-prompt and autopay-email blocks are also English in `es-419`, `fr-FR`, `de-DE`, and `it-IT` (and the autopay email block in `tr-TR`), which suggests they were added with English text only.

## Proposal

1. Translate the keys listed above in `apps/web/src/locales/pt-BR/{policies,settings,common,billing,pages,backup,devices}.json`, following `TERMINOLOGY.md`, preserving `{{placeholders}}`, and keeping the existing "você" register.
2. Do not change keys, components, or other locales. No new keys, so locale parity is unaffected, and the duplicate caps in `translationCoverage.test.ts` only gain headroom.
3. The implementation PR includes the line required by the locales README: `pt-BR strings are machine-drafted pending native review`.
4. Validate with `localeParity`, `translationCoverage`, `terminologyQuality`, and `humanizedKeyRegression`, plus `git diff --check`.

## Decisions for review

- "Site" / "Sites" (about 20 values identical to English): the glossary maps a managed site to "local", while "site" is also common usage in pt-BR. Translate or keep? Not included by default.
- "Download", "Upload", and "Menu" are correct pt-BR usage and are kept.
- Lowercase single-word values with no usage found in the components (`weekly3`, `monthly3`, `vendor2`, `name2`, `none`, `create`, `edit`, `audit`, and similar) appear to be orphaned keys. They are out of scope here and could be a separate cleanup.
- Applying the same fix to `es-419`, `fr-FR`, `de-DE`, `it-IT`, and `tr-TR` is out of scope for this document and could follow as a separate specification.

## Out of scope

The customer portal; new locales; Phase 4 emails, PDFs, and notifications; component changes; new keys; user-authored content.

## Risk

Low. Only text values in the `pt-BR` JSON files change. The change is reversible, and the blast radius is limited to the text shown to `pt-BR` users. The risk of imperfect wording is covered by the machine-drafted review line.
