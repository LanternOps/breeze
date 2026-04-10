# Partner Settings: Company Tab

**Date:** 2026-04-10
**Status:** Approved, ready for implementation plan

## Goal

Add a **Company** tab to `/settings/partner` for company identity: company name, physical address, and primary contact (name/email/phone/website). Move the existing "Contact Information" section out of the Regional tab into the new Company tab so Regional stays focused on locale and business hours.

## Scope

**In scope:**
- Editing partner/company name (surfaces `partners.name` in the settings UI for the first time)
- Adding a structured physical address (street, city, region, postal code, country)
- Moving the existing contact fields (name/email/phone/website) from Regional → Company

**Out of scope:**
- `partners.billingEmail` — intentionally left off to avoid confusion with the billing portal
- New DB columns — everything lands in the existing `partners.name` column and `partners.settings` JSONB
- API endpoint changes beyond extending the existing Zod validator

## Data Model

### Company name

Already exists as `partners.name` (varchar 255, not null). The `PATCH /orgs/partners/me` endpoint already accepts a top-level `name` field via `updatePartnerSettingsSchema`, so no route changes are required — the UI just needs to send it.

### Address (new)

New `address` field on `PartnerSettings`, stored inside the existing `partners.settings` JSONB column:

```ts
address?: {
  street1?: string;
  street2?: string;
  city?: string;
  region?: string;      // state / province / territory
  postalCode?: string;
  country?: string;     // ISO 3166-1 alpha-2 code, e.g. "US", "GB", "CA"
}
```

All fields optional. Country is stored as a 2-char ISO code; the UI renders a dropdown. The ISO list lives inline in the tab component — no new shared utility.

### Contact (unchanged)

`PartnerSettings.contact` already exists with `name`, `email`, `phone`, `website`. The type and Zod schema are unchanged. Only the UI location moves from the Regional tab to the Company tab.

## Files to Change

### 1. `packages/shared/src/types/index.ts`

Extend `PartnerSettings` (around line 553) with the new `address` field:

```ts
export interface PartnerSettings {
  // ...existing fields
  address?: {
    street1?: string;
    street2?: string;
    city?: string;
    region?: string;
    postalCode?: string;
    country?: string;
  };
  // ...rest
}
```

### 2. `apps/api/src/routes/orgs.ts`

Extend `partnerSettingsSchema` (around line 215) with a new optional `address` block:

```ts
address: z.object({
  street1: z.string().max(255).optional(),
  street2: z.string().max(255).optional(),
  city: z.string().max(255).optional(),
  region: z.string().max(255).optional(),
  postalCode: z.string().max(32).optional(),
  country: z.string().length(2).optional().or(z.literal('')),
}).optional(),
```

No other route changes needed. `PATCH /orgs/partners/me` already merges incoming `settings` with current settings and accepts top-level `name`.

### 3. `apps/web/src/components/settings/PartnerCompanyTab.tsx` (new)

Controlled tab component with three sub-sections. Purely presentational — parent owns state.

**Props:**
```ts
interface Props {
  name: string;
  address: PartnerSettings['address'];
  contact: PartnerSettings['contact'];
  onNameChange: (v: string) => void;
  onAddressChange: (v: NonNullable<PartnerSettings['address']>) => void;
  onContactChange: (v: NonNullable<PartnerSettings['contact']>) => void;
}
```

**Sub-sections:**
- **Company** — single `name` input (required indicator)
- **Address** — 2-column grid: street1 (full width), street2 (full width), city, region, postalCode, country (dropdown)
- **Contact** — 2-column grid: name, email, phone, website (moved verbatim from Regional)

Uses the same card/section styling as other tabs (see `PartnerSettingsPage.tsx` sections for reference).

ISO country list: include a reasonable subset inline (~50 common countries is fine — not all 249). Users in unlisted countries can be addressed later; no need to block on completeness.

### 4. `apps/web/src/components/settings/PartnerSettingsPage.tsx`

Modifications:

- **Tab union & list:** add `'company'` to `TabKey` type; insert `{ key: 'company', label: 'Company' }` as the **first** entry in the `TABS` array
- **Default tab:** change `useState<TabKey>('regional')` → `useState<TabKey>('company')`
- **New state:**
  ```ts
  const [companyName, setCompanyName] = useState('');
  const [address, setAddress] = useState<NonNullable<PartnerSettings['address']>>({});
  ```
- **In `fetchPartner()`:** after `setPartner(data)`, add:
  ```ts
  setCompanyName(data.name || '');
  setAddress(settings.address || {});
  ```
- **In `handleSave()`:**
  - Include `address` inside the `settings` object being sent
  - Add a top-level `name: companyName` field on the PATCH body (alongside `settings`)
- **Render changes:**
  - Remove the existing "Contact Information" `<section>` from the Regional tab (currently lines 419–458)
  - Add a new render block: `{activeTab === 'company' && <section className="rounded-lg border bg-card p-6 shadow-sm"><PartnerCompanyTab ... /></section>}` — or let the new component render its own sections directly, matching whichever pattern fits best after reading the current file
- **Import:** add `import PartnerCompanyTab from './PartnerCompanyTab';`

### 5. Tests

- **New:** `apps/web/src/components/settings/PartnerCompanyTab.test.tsx`
  - Renders with populated data
  - Fires change handlers for name, each address field, each contact field
  - Verifies country dropdown selection
- **Update:** `apps/web/src/components/settings/PartnerSettingsPage.test.tsx`
  - Update default-tab assertion (Company, not Regional)
  - Add a test that saves company name + address and verifies the PATCH body shape (`name` at top level, `address` inside `settings`)
  - Remove or update any existing assertions about contact fields living on the Regional tab

No new API tests required — the Zod extension is mechanical; existing partner-settings tests still apply. Optionally add a round-trip test case that PATCHes an address and reads it back, but this is not required.

## Tab Ordering

Final order: `Company → Regional → Security → Notifications → Event Logs → Defaults → Branding → AI Budgets`

Company is identity info, so it leads. Regional becomes purely locale + hours.

## Validation Rules

- **Company name:** required, min 1 char (matches existing `updatePartnerSettingsSchema.name`)
- **Address fields:** all optional, max 255 chars (postal 32, country exactly 2)
- **Contact fields:** unchanged from current behavior

## Migration & Backwards Compatibility

None required.

- Existing partners have no `settings.address` — the tab renders with empty fields and users fill them in as desired
- Existing `settings.contact` data continues to work unchanged; only its UI location moves
- No data migration, no schema migration, no drift concerns

## Open Questions

None.
