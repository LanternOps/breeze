# W05 (#6228) — Partner identity: one source, letterhead overrides only when different

Part of #6223. Quorum result (binding amendments): `/Users/toddhebebrand/.claude/breeze-handoff/6223-wave2-quorum-2026-09-23.md`, section "GH W05 #6228".

## Re-verified facts (2026-09-23, current main)

- `apps/api/src/services/sellerSnapshot.ts:35-58` `buildSellerSnapshot(partner)` already
  falls back `name: partner?.billingCompanyName ?? partner?.name ?? null` — the canonical
  name resolution the quorum described is correct and needs **no change**.
- `address`/`phone`/`email`/`website` currently read ONLY the typed `billing_*` columns
  (`apps/api/src/db/schema/orgs.ts:116-125`) with no second fallback tier — they go `null`
  when the billing override is unset.
- The "company details" fallback tier lives in `partners.settings` jsonb, typed as
  `PartnerSettings.contact` (`name/email/phone/website`) and `PartnerSettings.address`
  (`street1/street2/city/region/postalCode/country`) — `packages/shared/src/types/index.ts:749-771`.
  Editable at `apps/web/src/components/settings/PartnerCompanyTab.tsx`, wired from
  `PartnerSettingsPage.tsx` (loads `data.name`/`settings.contact`/`settings.address` at
  `:298,312-316`, saves via `PATCH /orgs/partners/me` at `orgs.ts:933-`). Server write schema:
  `partnerSettingsSchema.contact`/`.address` at `apps/api/src/routes/orgs.ts:651-667`
  (route-local zod, tolerant on read only by convention, not a shared contract — this wave
  adds the shared read-side tolerant parser the quorum asked for).
- `settings` (raw jsonb) is already selected at every `buildSellerSnapshot` call site — either
  a bare `db.select().from(partners)` (`invoicePdf.ts:722`, `quoteBranding.ts:67-69`,
  `quoteLifecycle.ts:183,1211`, `invoiceService.ts:1443`) or an explicit
  `settings: partners.settings` projection (`portal/quotes.ts:65,144`). **No call site needs
  a select-list change.**
- `GET /orgs/partners/me` (`orgs.ts:897-911`, `partnerPublicColumns()` at `:467-509`) already
  returns both `name` and `settings`, so the billing letterhead card can read the same
  response `PartnerBillingSettingsPage.tsx` already fetches — no new endpoint.
- The letterhead editor fields live in `apps/web/src/components/billing/BillingDocumentsTab.tsx`
  ("Company contact" section, `:141-248`), state owned by
  `apps/web/src/components/billing/PartnerBillingSettingsPage.tsx:46-54,76-85,118-127`.
- `InheritedField` (`apps/web/src/components/shared/InheritedField.tsx`) is the existing
  "blank = inherit, placeholder shows the resolved value" control from W03 — fits the
  scalar fields (phone, website) directly.
- Seller email stays `billingEmail` only (quorum amendment 4) — `settings.contact.email` is
  a contact-person mailbox, not a billing reply-to; no fallback wired for email.

## Scope confirmation (quorum amendments 1-6)

No migration, no typed-column move, no RLS/cascade/export-policy change. Add:
1. A shared tolerant company-identity reader in `packages/shared` (field-level parsing).
2. Wire it into `buildSellerSnapshot` as the second fallback tier for phone/website/address
   (not name — already correct; not email — deliberately excluded).
3. Whitespace-only override values count as absent for every scalar field.
4. Address uses BLOCK semantics: the billing address override applies in full when ANY of
   its 6 fields is non-blank; only when ALL 6 are blank does the whole address inherit from
   company details.
5. Billing letterhead card (`BillingDocumentsTab.tsx`) becomes an override editor: shows the
   inherited value + source, clearing re-inherits, address gets an explicit "Use company
   address" reset (clears all 6 override fields in one action, since the block can't be
   partially cleared field-by-field without changing meaning).
6. Tests for precedence, blanks, partial addresses, malformed legacy JSON, freeze timing
   (snapshot is still frozen at issue/send — nothing here changes that; the fallback only
   changes what an UNFROZEN read synthesizes for drafts/legacy-null-snapshot rows).

## Design

### 1. Shared tolerant reader — `packages/shared/src/validators/companyIdentity.ts`

```ts
export interface CompanyContactDetails {
  name: string | null; email: string | null; phone: string | null; website: string | null;
}
export interface CompanyAddressDetails {
  line1: string | null; line2: string | null; city: string | null;
  region: string | null; postalCode: string | null; country: string | null;
}

function blankToNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;      // field-level: a malformed field (wrong
  const t = v.trim();                          // type, e.g. legacy non-string website)
  return t === '' ? null : t;                  // is dropped, not thrown — siblings unaffected
}

/** Reads PartnerSettings.contact tolerantly. Never throws. */
export function parseCompanyContact(raw: unknown): CompanyContactDetails { ... }
/** Reads PartnerSettings.address tolerantly. Never throws. */
export function parseCompanyAddress(raw: unknown): CompanyAddressDetails { ... }
export function isCompanyAddressBlank(a: CompanyAddressDetails): boolean { ... }
```

Exported from `packages/shared/src/index.ts` (or wherever the validators barrel is) so both
`apps/api` and `apps/web` import the identical parsing rule — the web letterhead card uses
it too, so "same as company details" preview matches what the backend will actually freeze.

### 2. `buildSellerSnapshot` (`apps/api/src/services/sellerSnapshot.ts`)

```ts
function nonBlank(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
}

export function buildSellerSnapshot(partner: PartnerContactFields | null | undefined): SellerSnapshot {
  const companyContact = parseCompanyContact((partner as { settings?: unknown } | null)?.settings &&
    (partner!.settings as Record<string, unknown>).contact);
  const companyAddress = parseCompanyAddress((partner as { settings?: unknown } | null)?.settings &&
    (partner!.settings as Record<string, unknown>).address);

  const billingAddressFields = [
    partner?.billingAddressLine1, partner?.billingAddressLine2, partner?.billingAddressCity,
    partner?.billingAddressRegion, partner?.billingAddressPostalCode, partner?.billingAddressCountry,
  ];
  const billingAddressBlank = billingAddressFields.every((f) => nonBlank(f) === null);

  const address = billingAddressBlank
    ? (isCompanyAddressBlank(companyAddress) ? { line1: null, line2: null, city: null, region: null, postalCode: null, country: null } : companyAddress)
    : {
        line1: nonBlank(partner?.billingAddressLine1), line2: nonBlank(partner?.billingAddressLine2),
        city: nonBlank(partner?.billingAddressCity), region: nonBlank(partner?.billingAddressRegion),
        postalCode: nonBlank(partner?.billingAddressPostalCode), country: nonBlank(partner?.billingAddressCountry),
      };

  return {
    name: nonBlank(partner?.billingCompanyName) ?? nonBlank(partner?.name) ?? null,
    address,
    phone: nonBlank(partner?.billingPhone) ?? companyContact.phone ?? null,
    email: nonBlank(partner?.billingEmail) ?? null,
    website: nonBlank(partner?.billingWebsite) ?? companyContact.website ?? null,
  };
}
```

`PartnerContactFields` gains `settings?: unknown`. Every current caller already selects
`settings` (see facts above), so this is additive — no caller signature changes required,
though callers using an explicit column-list select already include `settings` or need one
extra field name added if a future one doesn't (none currently missing it, confirmed above).

Freeze timing is unaffected: `buildSellerSnapshot` is only ever called at issue/send time or
as the legacy-null-snapshot synthesis fallback for reads (`invoicePdf.ts:737`,
`portal/quotes.ts:154`, `quoteBranding.ts:84`) — this wave changes what it SYNTHESIZES, not
when.

### 3. Web: letterhead card becomes an override editor

`PartnerBillingSettingsPage.tsx` already fetches `GET /orgs/partners/me`, which returns
`name` and `settings`. Parse the inherited values with the same shared helper:

```ts
const companyContact = parseCompanyContact(p.settings?.contact);
const companyAddress = parseCompanyAddress(p.settings?.address);
```

Pass these down (plus `p.name`) to `BillingDocumentsTab`, which renders:
- Company name field: unchanged (already an override-with-name-fallback in copy/help text;
  no behavior change requested for name).
- Phone / Website: swap the bare `<input>` for `InheritedField`, `inheritedValue` =
  `companyContact.phone` / `companyContact.website`, `inheritedSource` = t('...','Company
  details').
- Address block: keep the 6 raw inputs (block semantics don't fit per-field
  `InheritedField` — filling one field must not silently become a mixed
  billing+company address), but add:
  - A summary line above the block: "Same as company details" when all 6 override fields
    are blank (showing the resolved `companyAddress` read-only), else "Overriding company
    details".
  - An explicit "Use company address" button that clears all 6 override state fields
    (→ inherits again), visible only when the block is currently overriding.
- Mutation stays behind the existing `runAction`-wrapped PATCH — no new mutation surface.

### 4. Tests

- `apps/api/src/services/sellerSnapshot.test.ts`: extend for company-fallback precedence
  (blank billing phone/website falls back to settings.contact; non-blank billing phone wins;
  whitespace-only billing fields treated as blank; address block — any one billing address
  field present freezes the FULL billing address verbatim, not a mix; all billing address
  fields blank + company address present → company address used verbatim; both blank → all
  address fields null; malformed `settings` (string, array, `settings.contact` a string, one
  field wrong type) never throws and degrades field-by-field).
- `packages/shared/src/validators/companyIdentity.test.ts`: parser unit tests (malformed
  input shapes, partial objects, non-object `settings`).
- `apps/web/src/components/billing/PartnerBillingSettingsPage.test.tsx` (or new
  `BillingDocumentsTab.test.tsx` if one doesn't already exist — check first): renders
  inherited placeholder/source for phone+website, clearing an override shows the inherited
  value again, "Use company address" clears all 6 address fields.
- No change needed to invoice/quote freeze-timing tests — behavior only changes for
  NEW/unfrozen reads; add one regression assertion that an already-frozen `sellerSnapshot`
  on an issued invoice is untouched by a partner's company-details edit (should already
  hold — frozen jsonb is never re-read through `buildSellerSnapshot`).

### 5. Release note

Add to `docs/release-notes/next-release-draft.md`: partners with a blank billing letterhead
(phone/website/address) will now see their company-details values on NEW invoices/quotes;
already-issued documents with a frozen (non-null) seller snapshot are unaffected; a
legacy/null-snapshot document re-rendered after this ships may show a different address on
its live header than it did before (was previously always blank in that gap, since no
fallback existed).

## Out of scope / explicitly not touched

`invoiceService.ts` issue path beyond feeding `buildSellerSnapshot(partner)` (unchanged call
shape), `quoteAcceptService.ts`, migrations, `tenantExportPolicyRegistry.ts` — W04 owns those
concurrently.
