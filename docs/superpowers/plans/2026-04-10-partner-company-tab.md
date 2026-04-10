# Partner Company Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Company tab to `/settings/partner` for company name, physical address, and contact info — moving the existing Contact section out of Regional.

**Architecture:** New presentational tab component `PartnerCompanyTab.tsx` wired into the existing `PartnerSettingsPage.tsx`. Company name continues to use the top-level `partners.name` column (already accepted by `PATCH /orgs/partners/me`). Address is added to the existing `partners.settings` JSONB under a new `address` key. Contact type/schema are unchanged — only the UI location moves.

**Tech Stack:** TypeScript, React, Vitest + Testing Library, Hono + Zod (API), Drizzle (no schema migration needed).

**Spec:** `docs/superpowers/specs/2026-04-10-partner-company-tab-design.md`

---

## Task 1: Extend `PartnerSettings` type with `address`

**Files:**
- Modify: `packages/shared/src/types/index.ts` (around line 553)

- [ ] **Step 1: Add `address` field to `PartnerSettings` interface**

Open `packages/shared/src/types/index.ts` and find the `PartnerSettings` interface (around line 553). Add a new optional `address` field directly after the `contact` block and before `// NEW inheritable categories`:

```ts
export interface PartnerSettings {
  timezone?: string;
  dateFormat?: DateFormat;
  timeFormat?: TimeFormat;
  language?: 'en';
  businessHours?: {
    preset: BusinessHoursPreset;
    custom?: Record<string, DaySchedule>;
  };
  contact?: {
    name?: string;
    email?: string;
    phone?: string;
    website?: string;
  };
  address?: {
    street1?: string;
    street2?: string;
    city?: string;
    region?: string;
    postalCode?: string;
    country?: string;
  };
  // NEW inheritable categories
  security?: InheritableSecuritySettings;
  notifications?: InheritableNotificationSettings;
  eventLogs?: InheritableEventLogSettings;
  defaults?: InheritableDefaultSettings;
  branding?: InheritableBrandingSettings;
  aiBudgets?: InheritableAiBudgetSettings;
}
```

- [ ] **Step 2: Type-check the shared package**

Run: `pnpm --filter @breeze/shared build`
Expected: Builds successfully with no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types/index.ts
git commit -m "feat(shared): add address field to PartnerSettings type"
```

---

## Task 2: Extend `partnerSettingsSchema` Zod validator with `address`

**Files:**
- Modify: `apps/api/src/routes/orgs.ts` (around line 215–229)

- [ ] **Step 1: Add `address` block to the Zod schema**

Open `apps/api/src/routes/orgs.ts` and find `partnerSettingsSchema` (around line 215). Add a new `address` object immediately after the `contact` block and before `security`:

```ts
contact: z.object({
  name: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().optional(),
  website: z.string().optional()
}).optional(),
address: z.object({
  street1: z.string().max(255).optional(),
  street2: z.string().max(255).optional(),
  city: z.string().max(255).optional(),
  region: z.string().max(255).optional(),
  postalCode: z.string().max(32).optional(),
  country: z.string().length(2).optional().or(z.literal('')),
}).optional(),
security: z.object({
```

- [ ] **Step 2: Add a Vitest unit test for the new validator branch**

Search for an existing orgs route test file to append to. If the file exists, add these cases to the closest existing `describe` block for `PATCH /orgs/partners/me`. If no such file exists, create `apps/api/src/routes/orgs.partners.test.ts` with this content:

```ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Re-declare just enough to unit-test the address branch without pulling in the full route.
// If the test file already imports partnerSettingsSchema, use that instead.
const addressSchema = z.object({
  street1: z.string().max(255).optional(),
  street2: z.string().max(255).optional(),
  city: z.string().max(255).optional(),
  region: z.string().max(255).optional(),
  postalCode: z.string().max(32).optional(),
  country: z.string().length(2).optional().or(z.literal('')),
}).optional();

describe('partnerSettingsSchema address', () => {
  it('accepts a fully populated address', () => {
    const result = addressSchema.safeParse({
      street1: '123 Main St',
      street2: 'Suite 400',
      city: 'Denver',
      region: 'CO',
      postalCode: '80202',
      country: 'US',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty object', () => {
    expect(addressSchema.safeParse({}).success).toBe(true);
  });

  it('accepts undefined', () => {
    expect(addressSchema.safeParse(undefined).success).toBe(true);
  });

  it('rejects a country code longer than 2 characters', () => {
    const result = addressSchema.safeParse({ country: 'USA' });
    expect(result.success).toBe(false);
  });

  it('accepts an empty-string country', () => {
    expect(addressSchema.safeParse({ country: '' }).success).toBe(true);
  });

  it('rejects a street1 over 255 characters', () => {
    const result = addressSchema.safeParse({ street1: 'a'.repeat(256) });
    expect(result.success).toBe(false);
  });
});
```

Note: if the existing orgs test file imports the real `partnerSettingsSchema`, prefer testing through it (`partnerSettingsSchema.safeParse({ address: {...} })`) rather than re-declaring.

- [ ] **Step 3: Run the new tests**

Run: `pnpm --filter @breeze/api test -- orgs.partners` (or the existing file name)
Expected: All address-branch tests pass.

- [ ] **Step 4: Type-check the API**

Run: `pnpm --filter @breeze/api exec tsc --noEmit`
Expected: No new TypeScript errors introduced by the schema change. (Pre-existing errors in `agents.test.ts` and `apiKeyAuth.test.ts` are noted in CLAUDE.md and can be ignored.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/orgs.ts apps/api/src/routes/orgs.partners.test.ts
git commit -m "feat(api): accept address in partner settings schema"
```

---

## Task 3: Create `PartnerCompanyTab.tsx` component (failing test first)

**Files:**
- Create: `apps/web/src/components/settings/PartnerCompanyTab.test.tsx`
- Create: `apps/web/src/components/settings/PartnerCompanyTab.tsx`

- [ ] **Step 1: Write the failing component test**

Create `apps/web/src/components/settings/PartnerCompanyTab.test.tsx` with this content:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import PartnerCompanyTab from './PartnerCompanyTab';
import type { PartnerSettings } from '@breeze/shared';

type Address = NonNullable<PartnerSettings['address']>;
type Contact = NonNullable<PartnerSettings['contact']>;

function renderTab(overrides?: {
  name?: string;
  address?: Address;
  contact?: Contact;
}) {
  const onNameChange = vi.fn();
  const onAddressChange = vi.fn();
  const onContactChange = vi.fn();
  render(
    <PartnerCompanyTab
      name={overrides?.name ?? 'Acme MSP'}
      address={overrides?.address ?? {}}
      contact={overrides?.contact ?? {}}
      onNameChange={onNameChange}
      onAddressChange={onAddressChange}
      onContactChange={onContactChange}
    />
  );
  return { onNameChange, onAddressChange, onContactChange };
}

describe('PartnerCompanyTab', () => {
  it('renders all three sections', () => {
    renderTab();
    expect(screen.getByText('Company')).not.toBeNull();
    expect(screen.getByText('Address')).not.toBeNull();
    expect(screen.getByText('Contact')).not.toBeNull();
  });

  it('renders the current company name and fires onNameChange', () => {
    const { onNameChange } = renderTab({ name: 'Acme MSP' });
    const input = screen.getByLabelText(/company name/i) as HTMLInputElement;
    expect(input.value).toBe('Acme MSP');
    fireEvent.change(input, { target: { value: 'Acme MSP Inc.' } });
    expect(onNameChange).toHaveBeenCalledWith('Acme MSP Inc.');
  });

  it('renders address fields and fires onAddressChange when a field changes', () => {
    const { onAddressChange } = renderTab({
      address: { street1: '123 Main St', city: 'Denver', country: 'US' },
    });
    const street1 = screen.getByLabelText(/street 1/i) as HTMLInputElement;
    expect(street1.value).toBe('123 Main St');
    fireEvent.change(street1, { target: { value: '456 Oak Ave' } });
    expect(onAddressChange).toHaveBeenCalledWith(
      expect.objectContaining({ street1: '456 Oak Ave', city: 'Denver', country: 'US' })
    );
  });

  it('fires onAddressChange with a new country when the dropdown changes', () => {
    const { onAddressChange } = renderTab({ address: { country: 'US' } });
    const country = screen.getByLabelText(/country/i) as HTMLSelectElement;
    fireEvent.change(country, { target: { value: 'CA' } });
    expect(onAddressChange).toHaveBeenCalledWith(
      expect.objectContaining({ country: 'CA' })
    );
  });

  it('renders contact fields and fires onContactChange', () => {
    const { onContactChange } = renderTab({
      contact: { name: 'Jane Doe', email: 'jane@example.com' },
    });
    const email = screen.getByLabelText(/^email/i) as HTMLInputElement;
    expect(email.value).toBe('jane@example.com');
    fireEvent.change(email, { target: { value: 'jane@acme.com' } });
    expect(onContactChange).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Jane Doe', email: 'jane@acme.com' })
    );
  });
});
```

- [ ] **Step 2: Run the test — verify it fails because the component does not exist**

Run: `pnpm --filter @breeze/web test -- PartnerCompanyTab`
Expected: FAIL with "Cannot find module './PartnerCompanyTab'" or equivalent.

- [ ] **Step 3: Implement the component**

Create `apps/web/src/components/settings/PartnerCompanyTab.tsx` with this content:

```tsx
import { Building2, MapPin, User, Mail, Phone, Globe } from 'lucide-react';
import type { PartnerSettings } from '@breeze/shared';

type Address = NonNullable<PartnerSettings['address']>;
type Contact = NonNullable<PartnerSettings['contact']>;

type Props = {
  name: string;
  address: Address;
  contact: Contact;
  onNameChange: (value: string) => void;
  onAddressChange: (value: Address) => void;
  onContactChange: (value: Contact) => void;
};

// Common country list — extend later if a partner needs a country not here.
const COUNTRIES: { code: string; label: string }[] = [
  { code: '', label: '— Select country —' },
  { code: 'US', label: 'United States' },
  { code: 'CA', label: 'Canada' },
  { code: 'MX', label: 'Mexico' },
  { code: 'GB', label: 'United Kingdom' },
  { code: 'IE', label: 'Ireland' },
  { code: 'FR', label: 'France' },
  { code: 'DE', label: 'Germany' },
  { code: 'ES', label: 'Spain' },
  { code: 'IT', label: 'Italy' },
  { code: 'NL', label: 'Netherlands' },
  { code: 'BE', label: 'Belgium' },
  { code: 'CH', label: 'Switzerland' },
  { code: 'AT', label: 'Austria' },
  { code: 'SE', label: 'Sweden' },
  { code: 'NO', label: 'Norway' },
  { code: 'DK', label: 'Denmark' },
  { code: 'FI', label: 'Finland' },
  { code: 'PL', label: 'Poland' },
  { code: 'PT', label: 'Portugal' },
  { code: 'CZ', label: 'Czech Republic' },
  { code: 'GR', label: 'Greece' },
  { code: 'AU', label: 'Australia' },
  { code: 'NZ', label: 'New Zealand' },
  { code: 'JP', label: 'Japan' },
  { code: 'KR', label: 'South Korea' },
  { code: 'CN', label: 'China' },
  { code: 'HK', label: 'Hong Kong' },
  { code: 'SG', label: 'Singapore' },
  { code: 'IN', label: 'India' },
  { code: 'AE', label: 'United Arab Emirates' },
  { code: 'IL', label: 'Israel' },
  { code: 'ZA', label: 'South Africa' },
  { code: 'BR', label: 'Brazil' },
  { code: 'AR', label: 'Argentina' },
  { code: 'CL', label: 'Chile' },
  { code: 'CO', label: 'Colombia' },
];

const inputClass = 'h-10 w-full rounded-md border bg-background px-3 text-sm';

export default function PartnerCompanyTab({
  name,
  address,
  contact,
  onNameChange,
  onAddressChange,
  onContactChange,
}: Props) {
  const setAddress = (field: keyof Address, value: string) => {
    onAddressChange({ ...address, [field]: value });
  };
  const setContact = (field: keyof Contact, value: string) => {
    onContactChange({ ...contact, [field]: value });
  };

  return (
    <div className="space-y-6">
      {/* Company */}
      <section className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="mb-6 flex items-center gap-2">
          <Building2 className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Company</h2>
        </div>
        <div className="space-y-2">
          <label htmlFor="company-name" className="text-sm font-medium">
            Company Name <span className="text-destructive">*</span>
          </label>
          <input
            id="company-name"
            type="text"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="Acme MSP"
            className={inputClass}
          />
        </div>
      </section>

      {/* Address */}
      <section className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="mb-6">
          <div className="flex items-center gap-2">
            <MapPin className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">Address</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Used for branded PDFs, invoices, and email footers.
          </p>
        </div>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <label htmlFor="addr-street1" className="text-sm font-medium">Street 1</label>
            <input
              id="addr-street1"
              type="text"
              value={address.street1 || ''}
              onChange={(e) => setAddress('street1', e.target.value)}
              className={inputClass}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <label htmlFor="addr-street2" className="text-sm font-medium">Street 2</label>
            <input
              id="addr-street2"
              type="text"
              value={address.street2 || ''}
              onChange={(e) => setAddress('street2', e.target.value)}
              className={inputClass}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="addr-city" className="text-sm font-medium">City</label>
            <input
              id="addr-city"
              type="text"
              value={address.city || ''}
              onChange={(e) => setAddress('city', e.target.value)}
              className={inputClass}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="addr-region" className="text-sm font-medium">State / Region</label>
            <input
              id="addr-region"
              type="text"
              value={address.region || ''}
              onChange={(e) => setAddress('region', e.target.value)}
              className={inputClass}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="addr-postal" className="text-sm font-medium">Postal Code</label>
            <input
              id="addr-postal"
              type="text"
              value={address.postalCode || ''}
              onChange={(e) => setAddress('postalCode', e.target.value)}
              className={inputClass}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="addr-country" className="text-sm font-medium">Country</label>
            <select
              id="addr-country"
              value={address.country || ''}
              onChange={(e) => setAddress('country', e.target.value)}
              className={inputClass}
            >
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>{c.label}</option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {/* Contact */}
      <section className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="mb-6">
          <div className="flex items-center gap-2">
            <User className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">Contact</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Primary contact for your MSP.</p>
        </div>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="contact-name" className="flex items-center gap-2 text-sm font-medium">
              <User className="h-4 w-4 text-muted-foreground" /> Contact Name
            </label>
            <input
              id="contact-name"
              type="text"
              value={contact.name || ''}
              onChange={(e) => setContact('name', e.target.value)}
              placeholder="John Smith"
              className={inputClass}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="contact-email" className="flex items-center gap-2 text-sm font-medium">
              <Mail className="h-4 w-4 text-muted-foreground" /> Email
            </label>
            <input
              id="contact-email"
              type="email"
              value={contact.email || ''}
              onChange={(e) => setContact('email', e.target.value)}
              placeholder="contact@example.com"
              className={inputClass}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="contact-phone" className="flex items-center gap-2 text-sm font-medium">
              <Phone className="h-4 w-4 text-muted-foreground" /> Phone
            </label>
            <input
              id="contact-phone"
              type="tel"
              value={contact.phone || ''}
              onChange={(e) => setContact('phone', e.target.value)}
              placeholder="+1 (555) 123-4567"
              className={inputClass}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="contact-website" className="flex items-center gap-2 text-sm font-medium">
              <Globe className="h-4 w-4 text-muted-foreground" /> Website
            </label>
            <input
              id="contact-website"
              type="url"
              value={contact.website || ''}
              onChange={(e) => setContact('website', e.target.value)}
              placeholder="https://example.com"
              className={inputClass}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `pnpm --filter @breeze/web test -- PartnerCompanyTab`
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/PartnerCompanyTab.tsx apps/web/src/components/settings/PartnerCompanyTab.test.tsx
git commit -m "feat(web): add PartnerCompanyTab component"
```

---

## Task 4: Wire `PartnerCompanyTab` into `PartnerSettingsPage.tsx`

**Files:**
- Modify: `apps/web/src/components/settings/PartnerSettingsPage.tsx`

This task has several sub-edits. Make them in order.

- [ ] **Step 1: Add the import**

At the top of `apps/web/src/components/settings/PartnerSettingsPage.tsx`, alongside the other tab imports (around lines 17–22), add:

```tsx
import PartnerCompanyTab from './PartnerCompanyTab';
```

- [ ] **Step 2: Extend the `TabKey` type and `TABS` array**

Find the `TabKey` type and `TABS` array (around lines 39–59).

Change the `TabKey` type to:

```ts
type TabKey = 'company' | 'regional' | 'security' | 'notifications' | 'eventLogs' | 'defaults' | 'branding' | 'aiBudgets';
```

And change the `TABS` array so `company` is first:

```ts
const TABS: { key: TabKey; label: string }[] = [
  { key: 'company', label: 'Company' },
  { key: 'regional', label: 'Regional' },
  { key: 'security', label: 'Security' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'eventLogs', label: 'Event Logs' },
  { key: 'defaults', label: 'Defaults' },
  { key: 'branding', label: 'Branding' },
  { key: 'aiBudgets', label: 'AI Budgets' },
];
```

- [ ] **Step 3: Change the default tab**

Find the `activeTab` state declaration (around line 98) and change:

```ts
const [activeTab, setActiveTab] = useState<TabKey>('regional');
```

to:

```ts
const [activeTab, setActiveTab] = useState<TabKey>('company');
```

- [ ] **Step 4: Add new state for company name and address**

Right after the existing `contactWebsite` state line (around line 109), add:

```ts
const [companyName, setCompanyName] = useState('');
const [address, setAddress] = useState<NonNullable<PartnerSettings['address']>>({});
```

- [ ] **Step 5: Hydrate the new state in `fetchPartner`**

Inside `fetchPartner()`, after `setPartner(data);` and before `const settings = data.settings || {};` (around line 131), add:

```ts
setCompanyName(data.name || '');
```

Then right after the existing `setContactWebsite(settings.contact?.website || '');` line (around line 143), add:

```ts
setAddress(settings.address || {});
```

- [ ] **Step 6: Include `name` and `address` in the save payload**

In `handleSave()` (around lines 180–222), modify the settings object and the request body.

Replace this block (around lines 185–197):

```ts
const settings: Record<string, unknown> = {
  timezone, dateFormat, timeFormat, language: 'en',
  businessHours: {
    preset: businessHoursPreset,
    ...(businessHoursPreset === 'custom' ? { custom: customHours } : {})
  },
  contact: {
    name: contactName || undefined,
    email: contactEmail || undefined,
    phone: contactPhone || undefined,
    website: contactWebsite || undefined
  }
};
```

with:

```ts
const settings: Record<string, unknown> = {
  timezone, dateFormat, timeFormat, language: 'en',
  businessHours: {
    preset: businessHoursPreset,
    ...(businessHoursPreset === 'custom' ? { custom: customHours } : {})
  },
  contact: {
    name: contactName || undefined,
    email: contactEmail || undefined,
    phone: contactPhone || undefined,
    website: contactWebsite || undefined
  },
  address: {
    street1: address.street1 || undefined,
    street2: address.street2 || undefined,
    city: address.city || undefined,
    region: address.region || undefined,
    postalCode: address.postalCode || undefined,
    country: address.country || undefined,
  }
};
```

And replace the PATCH body line (around line 209):

```ts
body: JSON.stringify({ settings })
```

with:

```ts
body: JSON.stringify({ name: companyName, settings })
```

- [ ] **Step 7: Remove the Contact Information section from the Regional tab**

Find and delete the entire "Contact Information" `<section>` block inside the Regional tab render (around lines 419–458). It starts with:

```tsx
{/* Contact Information */}
<section className="rounded-lg border bg-card p-6 shadow-sm">
  <div className="mb-6">
    <div className="flex items-center gap-2">
      <User className="h-5 w-5 text-muted-foreground" />
      <h2 className="text-lg font-semibold">Contact Information</h2>
```

and ends with the closing `</section>` right before `<KnownGuestsSettings />`.

After deletion, the Regional tab renders: Regional Settings section, Business Hours section, then `<KnownGuestsSettings />`.

- [ ] **Step 8: Clean up now-unused imports in Regional**

With the Contact section removed, check whether `User`, `Mail`, `Phone`, `Calendar` (the ones used only in the deleted section) are still referenced elsewhere in the file. If an icon is no longer used anywhere, remove it from the `lucide-react` import at the top. Keep any that are still referenced.

Run: `pnpm --filter @breeze/web exec tsc --noEmit` to confirm no unused-import errors.

- [ ] **Step 9: Add the Company tab render block**

Immediately after the `{error && ...}` banner block and before the tab navigation (or alternatively right before the `{activeTab === 'regional' && ...}` block, whichever keeps tab blocks grouped), add:

```tsx
{activeTab === 'company' && (
  <PartnerCompanyTab
    name={companyName}
    address={address}
    contact={{
      name: contactName,
      email: contactEmail,
      phone: contactPhone,
      website: contactWebsite,
    }}
    onNameChange={setCompanyName}
    onAddressChange={setAddress}
    onContactChange={(c) => {
      setContactName(c.name || '');
      setContactEmail(c.email || '');
      setContactPhone(c.phone || '');
      setContactWebsite(c.website || '');
    }}
  />
)}
```

Note: the existing page keeps contact fields as flat `useState` strings. We pass a synthesized `Contact` object in and fan the updates back out in `onContactChange`. This avoids a larger state refactor.

- [ ] **Step 10: Type-check the web app**

Run: `pnpm --filter @breeze/web exec tsc --noEmit`
Expected: No new errors.

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/components/settings/PartnerSettingsPage.tsx
git commit -m "feat(web): wire PartnerCompanyTab into partner settings page"
```

---

## Task 5: Update `PartnerSettingsPage.test.tsx`

**Files:**
- Modify: `apps/web/src/components/settings/PartnerSettingsPage.test.tsx`

- [ ] **Step 1: Add a test for the save payload shape**

Open `apps/web/src/components/settings/PartnerSettingsPage.test.tsx`. First, add this import to the top of the file (alongside the existing `@testing-library/react` import):

```tsx
import userEvent from '@testing-library/user-event';
```

Then add this new `describe` block after the existing one (or at the end of the file):

```tsx
describe('PartnerSettingsPage Company tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStoreMock.mockReturnValue({ currentPartnerId: 'partner-1', isLoading: false } as never);
  });

  it('renders the Company tab as the default tab with the current company name', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [] }));
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        id: 'partner-1',
        name: 'Acme MSP',
        slug: 'acme',
        type: 'partner',
        plan: 'pro',
        createdAt: '2026-02-09T00:00:00.000Z',
        settings: {
          timezone: 'UTC',
          dateFormat: 'MM/DD/YYYY',
          timeFormat: '12h',
          language: 'en',
          businessHours: { preset: 'business' },
          contact: { name: 'Jane' },
          address: { city: 'Denver', country: 'US' },
        },
      })
    );

    render(<PartnerSettingsPage />);

    await screen.findByText('Partner Settings');
    // Company tab is the default, so its content should be visible.
    const nameInput = await screen.findByLabelText(/company name/i) as HTMLInputElement;
    expect(nameInput.value).toBe('Acme MSP');
    const cityInput = screen.getByLabelText(/city/i) as HTMLInputElement;
    expect(cityInput.value).toBe('Denver');
  });

  it('saves company name at the top level and address inside settings', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [] }));
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        id: 'partner-1',
        name: 'Acme MSP',
        slug: 'acme',
        type: 'partner',
        plan: 'pro',
        createdAt: '2026-02-09T00:00:00.000Z',
        settings: {
          timezone: 'UTC',
          dateFormat: 'MM/DD/YYYY',
          timeFormat: '12h',
          language: 'en',
          businessHours: { preset: 'business' },
          contact: {},
          address: {},
        },
      })
    );
    // Response to the PATCH — shape doesn't matter for the assertion.
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ id: 'partner-1', name: 'Acme MSP Inc.', settings: {} })
    );

    render(<PartnerSettingsPage />);

    const nameInput = await screen.findByLabelText(/company name/i) as HTMLInputElement;
    const user = userEvent.setup();
    await user.clear(nameInput);
    await user.type(nameInput, 'Acme MSP Inc.');

    const cityInput = screen.getByLabelText(/city/i) as HTMLInputElement;
    await user.type(cityInput, 'Denver');

    const saveBtn = screen.getByRole('button', { name: /save settings/i });
    await user.click(saveBtn);

    // Find the PATCH call (skip any GETs)
    const patchCall = fetchWithAuthMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH'
    );
    expect(patchCall).toBeDefined();
    const body = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(body.name).toBe('Acme MSP Inc.');
    expect(body.settings.address.city).toBe('Denver');
  });
});
```

- [ ] **Step 2: Remove or update any stale assertions about contact fields on Regional**

Scan the existing tests in the file for assertions that rely on the Contact Information section being rendered on the Regional tab (e.g., `getByPlaceholderText('John Smith')` in a Regional-tab context). If any exist, update them to switch to the Company tab first (`fireEvent.click(screen.getByRole('button', { name: /company/i }))` — though Company is the default, so this is rarely needed), or move the assertion into the new Company-tab describe block.

If no such assertions exist, skip this step.

- [ ] **Step 3: Run the tests**

Run: `pnpm --filter @breeze/web test -- PartnerSettingsPage`
Expected: All tests PASS, including the two new Company-tab tests.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/settings/PartnerSettingsPage.test.tsx
git commit -m "test(web): cover Company tab default state and save payload"
```

---

## Task 6: Full verification sweep

- [ ] **Step 1: Run the full web test suite**

Run: `pnpm --filter @breeze/web test`
Expected: All tests PASS.

- [ ] **Step 2: Run the full API test suite**

Run: `pnpm --filter @breeze/api test`
Expected: All tests PASS. (Pre-existing failures in `agents.test.ts` and `apiKeyAuth.test.ts` are known and can be ignored per CLAUDE.md.)

- [ ] **Step 3: Type-check the whole monorepo**

Run these in parallel:
- `pnpm --filter @breeze/shared build`
- `pnpm --filter @breeze/api exec tsc --noEmit`
- `pnpm --filter @breeze/web exec tsc --noEmit`

Expected: No new TypeScript errors.

- [ ] **Step 4: Manual smoke check (optional but recommended)**

Start dev servers (`pnpm dev`) and navigate to `/settings/partner` as a partner-scoped user. Verify:
- Company tab is the first tab and is selected by default
- Company name field shows the current partner name
- Address fields are empty for a fresh partner, populated for a partner with saved address
- Contact fields on the Company tab show the same data that used to show on Regional
- Regional tab no longer shows a Contact Information section
- Changing name + address + contact and clicking Save persists across a page refresh

No commit for this step — verification only.

---

## Notes for the Engineer

- **Context:** This is an additive change to the Breeze RMM partner settings page (`/settings/partner`). Partners are the top-level tenant in Breeze's multi-tenant hierarchy. Company identity info is being surfaced for the first time in the settings UI.
- **No DB migration** is required. The `address` field lives inside the existing `partners.settings` JSONB column.
- **Partner name** already lives on `partners.name` (top-level column). The `PATCH /orgs/partners/me` endpoint already accepts a top-level `name` field — no route or validator changes there.
- **Existing patterns** to follow when in doubt: `PartnerBrandingTab.tsx` (presentational tab component with `{ data, onChange }`-style props), `PartnerSettingsPage.test.tsx` (Vitest + RTL mocking `fetchWithAuth` and `useOrgStore`).
- **Don't use trailing slashes** in test URLs — Hono returns 404 for them (see CLAUDE.md).
- **Running a single test file:** `pnpm --filter @breeze/web test -- <pattern>` runs only matching tests in web; same pattern for `@breeze/api`.
