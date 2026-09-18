# Settings Consolidation — Wave 2 design positions (pre-quorum)

Status: **orchestrator position only — NOT a plan, NOT approved for build.** Wave 2 of the
settings consolidation (audit `docs/superpowers/specs/web-ui/2026-09-17-billing-ticketing-settings-audit.md`,
moves M16–M19) changes behaviour and adds columns, so it goes through the advisor quorum
before plans are written. Codex was at its usage limit on 2026-09-17 (resets 2026-09-19
11:38); this file is the first half of the quorum so the second half is one `codex exec`
(read-only, `xhigh`) against it. Facts below are **verified** (re-read 2026-09-17) unless
marked.

Proposed wave split (each an independently shippable PR):

| Wave | Moves | Migration | Blast radius |
|---|---|---|---|
| W03 | M17 invoice presentation snapshot + M18 draft invoice tax | yes (columns + backfill) | high — migration, customer documents |
| W04 | M16 partner identity: one source | none proposed | medium — customer documents |
| W05 | M19 org payment-terms override | yes (one column) | medium — due dates |

M15 is #4628 (its own feature). M20 (partner portal template) is optional and unscheduled.

**Sequencing.** None of Wave 2 is on the critical path `#6164 W01 → #4628 W02 → #4547 block
hours (p1)`. W03 and block-hours overage billing both touch the invoice issue path
(`invoiceService.ts`), so W03–W05 are scheduled **after #4547** and must be re-read against
the code as it stands then.

## W03 — M17 invoice presentation snapshot

Facts:
- Quotes freeze `{theme,pageSize}` into `quotes.presentation_snapshot` jsonb at send
  (`quoteLifecycle.ts:364-366`); every reader does `snap?.theme ?? partner.documentTheme`.
- Invoices have no such column. `routes/invoicesPublic.ts:165-166` and the in-app preview
  (`routes/invoices/invoices.ts:64-72`, which passes `presentationSnapshot: null` on purpose)
  read the partner's live theme.
- `services/invoicePdf.ts` contains no `theme` / `pageSize` reference at all — the stored
  invoice PDF is not themed. So today's restyling affects the **public web view and the
  in-app preview, not the PDF artifact**. This narrows the audit's finding 21.
- `quotes.presentation_snapshot` sits in `excludedOpen` in the export policy (every jsonb
  must), so a quote's frozen theme is absent from tenant exports.

Position: **two typed nullable columns on `invoices` — `document_theme varchar(32)`,
`document_page_size varchar(8)` — not a jsonb twin of the quote column.**
- NULL = not yet issued → readers fall through to the partner's live value (drafts should
  preview the current theme). Stamped in the issue transaction beside `taxRate`/`terms`.
- One resolver, `resolveInvoicePresentation(invoice, partner)`, used by the public route, the
  in-app preview and (later) the PDF; `resolveQuoteBranding` stops being called with a forged
  `presentationSnapshot: null`.
- Typed columns go in the export policy's `included` bucket, are constrained by the same
  `resolveThemeId` allowlist, and follow audit rule M14 (no new untyped blobs). Cost: the
  quote and invoice snapshots have different shapes. Converting quotes to typed columns is a
  separate, optional follow-up — not in this wave.
- Backfill: every invoice with `status <> 'draft'` gets its partner's **current** theme and
  page size (that is what it renders as today, so nothing visibly changes). Migration elects
  system scope first, reports the row count via `RAISE WARNING`, is idempotent
  (`WHERE document_theme IS NULL`), and batches by `ctid` if either region's invoice count
  warrants it (NOT CHECKED: prod row counts — Todd reads them; prod SSH is blocked for agents).
- Registration: `invoices` is already in `CORE_ORG_CASCADE_DELETE_ORDER`; the new columns must
  be classified in `CORE_TENANT_EXPORT_POLICY` (`included`). No new table, no RLS change.

Open for the quorum: (a) typed columns vs jsonb parity with quotes; (b) whether credit notes /
recurring-invoice children inherit the parent's snapshot or stamp their own at issue.

## W03 — M18 draft invoice tax

- Draft invoices resolve tax org-only (`invoiceService.ts` `effectiveRateForOrg`, partnerRate
  hard-coded null, "partner default applied authoritatively at issue"); draft quotes resolve
  org → partner. A draft invoice converted from a quote shows different tax from its quote.
- Position: the draft path calls the shared resolver W02/M12 introduces (org row in request
  context, `partners.default_tax_rate` via `readWithPartnerAxisVisibility`). Issue still
  re-resolves and snapshots — the stamped rate is unchanged; only the draft's displayed
  estimate changes. Needs a test that a draft created before and issued after a partner rate
  change stamps the rate current at issue.

## W04 — M16 partner identity

Facts:
- `services/sellerSnapshot.ts buildSellerSnapshot` is already the single seller resolver and
  already falls back `billingCompanyName ?? partner.name`. Address, phone and website have no
  fallback. The snapshot is frozen into `invoices.seller_snapshot` / `quotes.seller_snapshot`.
- Company details (address, contact phone/website) live in the `partners.settings` jsonb
  (`PartnerCompanyTab.tsx`, `PartnerSettings['address']`, `contact`).

Position: **no migration. Extend `buildSellerSnapshot` to fall back to the company details,
and make the Billing letterhead card an override editor.**
- Name / phone / website: per-field fallback. Address: **block-level** fallback — if any
  `billing_address_*` is set the billing address is used whole; mixing line 1 of one address
  with the city of another is never right.
- Existing `billing_*` values are left alone (no data rewrite): where they equal the company
  values the card says "same as company details"; clearing a field re-inherits.
- Issued documents are unaffected (frozen snapshots). New documents for a partner whose
  letterhead was blank gain an address — that is the intended behaviour change and needs a
  What's New line.
- Open for the quorum: whether company identity should first move out of the untyped
  `partners.settings` blob into typed columns (bigger, separable) — position: no, W02/M14
  gives the blob a zod contract and that is enough for a fallback read.

## W05 — M19 org payment-terms override

Facts:
- Due date is computed in **two** places from `partners.invoice_terms_days`:
  `invoiceService.ts:1305` (issue) and `quoteAcceptService.ts:251` (quote-accept →
  invoice). No org level exists.

Position: `organizations.invoice_terms_days integer NULL` (CHECK 0–365), NULL = inherit.
- One resolver `resolveInvoiceTermsDays(org, partner)` = `org ?? partner ?? 30`, adopted by
  both paths above (and any contract auto-issue path — NOT CHECKED).
- `organizations` is shape 2 (id-keyed), already RLS-covered and already in the org cascade;
  the new column must be classified `included` in `CORE_TENANT_EXPORT_POLICY` — the
  export-policy contract fires on a new column. Org merge: the surviving org keeps its own
  value (NOT CHECKED: whether the merge copies org billing columns today).
- UI: org settings → Billing tab, through the `InheritedField` from W02 ("Net 30 — partner
  default"). Validator in `packages/shared`.
- Not added: payment terms on contracts or per-invoice override beyond the existing editable
  due date.
