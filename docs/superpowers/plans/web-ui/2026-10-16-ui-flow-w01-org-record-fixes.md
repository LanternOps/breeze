---
tracking_issue: LanternOps/breeze#8985
wave: W01
---

# UI Flow W01: org record fixes, address, site columns, device crumb Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the billing address and full site info on the org record, make its Devices tab render the same data as `/devices` (rounded percents, OS, last seen, row click, its own column preset), and send a device page's "Devices" crumb to the device's own org.

**Architecture:** Four read-only `apps/web` changes, no API work. A pure `formatAddress` helper (reused by W02) feeds the header and the site list; the `/devices` row transform moves out of `DevicesPage` into a pure module both pages call; `columnVisibility.ts` takes a preset parameter instead of hard-coding its key; a pure `deviceListCrumbHref` decides the crumb/back target from the working org.

**Tech Stack:** React islands, Vitest + React Testing Library, react-i18next (8 locale dirs), zustand `orgStore`, localStorage column presets.

**Spec:** `docs/superpowers/specs/web-ui/2026-10-16-ui-flow-improvements-design.md` — "Wave A" (A1–A4). Branch `feature/8985-ui-flow/wave-<sub#>` off `main`; PR body `Closes #<sub-issue>`.

## Global Constraints

- Every new `en` locale key is added to all 8 locale dirs under `apps/web/src/locales/` (`en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR` — `lib/i18n/localeParity.test.ts:424`); **Translate them**: `lib/i18n/translationCoverage.test.ts` caps exact-English duplicates per namespace per locale, so English placeholders can fail CI; reuse sibling keys' wording where one exists.
- Interactive elements get `data-testid`.
- Aim for files under ~500 lines; `DeviceList.tsx` (3730 lines) must NOT be split in this work.
- No mutations in this work, so `runAction` is not involved; reads go through `fetchWithAuth` / the org-pinned `orgFetch`.
- Transient UI state in `window.location.hash` (`#devices`, `#sites`, `#billing` on the org record), never query params.
- Navigation never silently changes the working org; only the switcher does.
- Cross-wave names are fixed: `lib/formatAddress.ts` (`AddressParts`, `formatAddress`), `components/devices/deviceRowTransform.ts` (`toDeviceListRow(raw: ApiDeviceRow): DeviceListRow`), `components/devices/deviceListCrumbHref.ts` (`deviceListCrumbHref(currentOrgId: string | null, deviceOrgId: string): string`).
- Commands: one test file `cd apps/web && npx vitest run <path>`; typecheck `cd apps/web && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo exit=$?`; locale parity `cd apps/web && npx vitest run src/lib/i18n`; full suite `cd apps/web && npx vitest run`.

## Review Focus

1. A site `address` jsonb whose values are not strings (`createSiteSchema` is `z.record(z.string(), z.unknown())`, `packages/shared/src/validators/index.ts:137,139`) — the Address cell must show "—" or the string parts only, never `[object Object]`. → Task 3 test "ignores non-string address values".
2. A billing address with only `billingAddressCountry` set (a half-filled billing form) — the header shows `US`, not "No billing address". → Task 2 test "renders a partial address rather than the empty state".
3. A `/devices` row whose `cpuPercent` is a numeric string or `null` (device never reported) — `37.5` / `0`, never `NaN%`. → Task 4 test "coerces string and null percents".
4. A device with `orgId: ''` while the working org is some org — crumb and back go to `/devices`, never `/organizations/#devices`. → Task 7 test case 4.
5. The orgTab preset's stored list with every column hidden — falls back to the orgTab defaults, not the `/devices` defaults (`columnVisibility.ts:216-220` hard-codes `DEFAULT_VISIBLE_COLUMNS`). → Task 6 test "all-hidden falls back to the preset's defaults".

## Verified facts (re-checked on `main` 9a16b94e02, 2026-10-16)

| Fact | Where |
|---|---|
| `OrgRecordOrg` has no address fields; `GET /orgs/organizations/:id` returns the full row (`.select()`), so `billingAddress*` ride along | `orgRecordFetch.ts:38-46`; `apps/api/src/routes/orgs.ts:2312`; columns `db/schema/orgs.ts:226-231` |
| Header contact block, then `noPrimaryContact` fallback gated on `summary` | `OrgRecordHeader.tsx:115-139` |
| Org settings page selects its tab from a bare `#<key>`; `billing` is a tab; the old `/billing` URL 301s to `#billing` | `OrgSettingsPage.tsx:76,114-123,255-263`; `pages/settings/organizations/[id]/billing.astro:7` |
| `SiteList` `Site` = `{id,name,timezone,deviceCount}`; headers `:113-118`, rows `:129-134`, cards `:150-158`, `colSpan={4}` `:123` | `settings/SiteList.tsx` |
| Site jsonb shapes on the web: `address{line1,line2,city,state,postalCode,country}`, `contact{name,email,phone}` | `useSiteCrud.ts:189-200,250-258` |
| `OrgSitesTab` passes `siteCrud.sites` straight to `SiteList`; `useSiteCrud` stores the fetched rows unmapped; API spreads the full row | `OrgSitesTab.tsx:57-63`; `useSiteCrud.ts:119-124`; `routes/orgs.ts:3103-3107` |
| Agent-arm row transform; `orgName`/`siteName` left `''` and resolved later from maps | `DevicesPage.tsx:735-849`, `:951-958`; `warnedUnknownLinkGroupRoles` + `normalizeLinkGroupRole` `:73-81` (used only at `:800`) |
| API list row carries top-level `cpuPercent`/`ramPercent`, `osType`, `lastSeenAt` | `apps/api/src/routes/devices/core.ts:1480,1503,1531-1532` |
| `toPercent` rounds to one decimal and clamps 0–100; `0` for non-numeric | `lib/deviceUtils.ts:7-16` |
| `OrgDevicesTab` sets raw rows as `Device[]`, renders `<DeviceList … forceSingleOrg />` with no `onSelect`; test fixture is already transformed | `OrgDevicesTab.tsx:59-65,164`; `OrgDevicesTab.test.tsx:11-26` |
| `metricBar` prints `{percent}%`; CPU/RAM cells call it | `DeviceList.tsx:1471-1483`, `:2030,2041` |
| `DeviceCard` prints raw `cpuPercent`/`ramPercent` and thresholds on them; already imports from `@/lib/deviceUtils` | `DeviceCard.tsx:590,595-597,620,625-627`; import `:24` |
| Column helpers hard-code `COLUMN_STORAGE_KEY`; `DeviceList` calls them at state init and in toggle/move/reset | `columnVisibility.ts:118,158,208,218`; `DeviceList.tsx:79-88,880-885,1003-1039` |
| `DeviceList` props end at `forceSingleOrg`/`effectiveAgentVersionByOrgId`; row `<tr onClick={() => onSelect?.(device)}>` | `DeviceList.tsx:548-556`, `:3147-3155` |
| `DevicesPage` row select → `navigateTo('/devices/:id')` for agent rows | `DevicesPage.tsx:1161-1176`; `lib/navigation.ts:49` |
| Device page crumbs `[org] › Devices(/devices) › hostname`; `handleBack` → `/devices`; `handleBack` also used by the not-found states | `DeviceDetailPage.tsx:742-754`, `:333-335`, `:718,730` |
| `orgStore.ts` calls `registerOrgIdProvider` at import; the breadcrumb test mocks `stores/auth` with only `fetchWithAuth`; the real store runs fine under a two-name mock | `orgStore.ts:4,434`; `DeviceDetailPage.orgBreadcrumb.test.tsx:9`; precedent `settings/CatalogItemsTab.test.tsx` (`registerOrgIdProvider: vi.fn()`, real `orgStore`) |
| Pages read the working org as `useOrgStore((s) => s.currentOrgId)`; fleet view = `null` | `OrganizationRecordPage.tsx:115` |
| Non-hook code translates via `import { i18n } from '@/lib/i18n'` + `i18n.t('ns:key')` | `lib/downloadArtifact.ts:5,43`; keys `devices:devicesPage.unknownDevice/unknownSite` (`locales/en/devices.json:2482,2600-2602`) |

---

### Task 1: `formatAddress`

**Files:**
- Create: `apps/web/src/lib/formatAddress.ts`
- Test: `apps/web/src/lib/formatAddress.test.ts`

**Interfaces:**
- Produces: `export interface AddressParts { line1?: string | null; line2?: string | null; city?: string | null; region?: string | null; postalCode?: string | null; country?: string | null }`, `export function formatAddress(parts: AddressParts | null | undefined): string` (Tasks 2, 3; W02).

- [ ] **Step 1: Write the failing tests** — `describe('formatAddress')`:
  - `'joins all six parts as line1, line2 · city, region postalCode · country'`: `{line1:'1 Main St', line2:'Suite 200', city:'Springfield', region:'IL', postalCode:'62701', country:'US'}` → `'1 Main St, Suite 200 · Springfield, IL 62701 · US'`
  - `'returns an empty string for null, undefined and all-empty parts'`: `null`, `undefined`, `{}`, `{line1:'', city:null}` → `''`
  - `'skips empty parts without dangling separators'`: `{city:'Springfield', country:'US'}` → `'Springfield · US'`; `{region:'IL', postalCode:'62701'}` → `'IL 62701'`; `{line2:'Suite 2', city:'Austin'}` → `'Suite 2 · Austin'`
  - `'treats whitespace-only parts as empty'`: `{line1:'  ', city:'Austin'}` → `'Austin'`
- [ ] **Step 2: Run to see it fail** — `cd apps/web && npx vitest run src/lib/formatAddress.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `formatAddress` — trim each part (non-strings count as empty); group 1 = `[line1, line2]` joined `', '`; group 2 = `[city, region]` joined `', '`, then postalCode appended with `' '`; group 3 = country; drop empty groups; join `' · '`.
- [ ] **Step 4: Run to see it pass** — same command → 4 passed.
- [ ] **Step 5: Commit** — `git add apps/web/src/lib/formatAddress.ts apps/web/src/lib/formatAddress.test.ts && git commit -m "feat(web): formatAddress helper for org and site addresses" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 2: A1 — billing address on the org record header

**Files:**
- Modify: `apps/web/src/components/organizations/record/orgRecordFetch.ts:38-46`, `OrgRecordHeader.tsx:1-8` (imports), `:115-139` (insert after the contact block)
- Modify: `apps/web/src/locales/<8 dirs>/organizations.json` → `orgRecord.header.billingAddress: "Billing address"`, `orgRecord.header.noBillingAddress: "No billing address"`, `orgRecord.header.billingSettingsLink: "Add in Billing settings"`
- Test: `OrgRecordHeader.test.tsx`

**Interfaces:**
- Consumes: `formatAddress` (Task 1).
- Produces: `OrgRecordOrg` gains `billingAddressLine1?: string | null; billingAddressLine2?: string | null; billingAddressCity?: string | null; billingAddressRegion?: string | null; billingAddressPostalCode?: string | null; billingAddressCountry?: string | null`.

- [ ] **Step 1: Write the failing tests** (in the existing `describe('OrgRecordHeader')`; `ORG` stays address-less):
  - `'renders the billing address on its own line under the contact line'`: `renderHeader({ org: { ...ORG, billingAddressLine1:'1 Main St', billingAddressLine2:'Suite 200', billingAddressCity:'Springfield', billingAddressRegion:'IL', billingAddressPostalCode:'62701', billingAddressCountry:'US' } })` → `getByTestId('org-record-billing-address').textContent` contains `'1 Main St, Suite 200 · Springfield, IL 62701 · US'`; `queryByTestId('org-record-billing-address-link')` is null.
  - `'offers the billing settings tab when every address field is empty'`: `renderHeader()` → `getByText('No billing address')`; `getByTestId('org-record-billing-address-link').getAttribute('href')` is `'/settings/organizations/org-1#billing'`.
  - `'renders a partial address rather than the empty state'` (Review Focus 2): `billingAddressCountry:'US'` only → address testid text contains `'US'`; `queryByText('No billing address')` null.
  - `'shows the address even while the summary is still null'`: `renderHeader({ summary: null, org: {...ORG, billingAddressCity:'Austin'} })` → address testid present.
- [ ] **Step 2: Run to see it fail** — `cd apps/web && npx vitest run src/components/organizations/record/OrgRecordHeader.test.tsx` → 4 FAIL.
- [ ] **Step 3: Implement** — extend `OrgRecordOrg`; in the header compute `const address = formatAddress({ line1: org.billingAddressLine1, line2: org.billingAddressLine2, city: org.billingAddressCity, region: org.billingAddressRegion, postalCode: org.billingAddressPostalCode, country: org.billingAddressCountry })`. Render directly after the contact block (`:139`): if non-empty, `<div data-testid="org-record-billing-address" className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">` with muted `t('orgRecord.header.billingAddress')}:` label and the text; else `<p className="mt-1 text-sm text-muted-foreground">` with `t('orgRecord.header.noBillingAddress')` and `<a data-testid="org-record-billing-address-link" href={`/settings/organizations/${org.id}#billing`} className="ml-2 text-primary hover:underline">{t('orgRecord.header.billingSettingsLink')}</a>`. Not gated on `summary`. Add the three keys to all 8 locales.
- [ ] **Step 4: Run to see it pass** — same file → all green; `cd apps/web && npx vitest run src/lib/i18n` → parity passes.
- [ ] **Step 5: Commit** — `git add -A apps/web/src/components/organizations/record apps/web/src/locales && git commit -m "feat(org-record): billing address line with settings link on the header (A1)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 3: A2 — `SiteList` address and contact columns

**Files:**
- Modify: `apps/web/src/components/settings/SiteList.tsx:1-11` (import + `Site`), `:113-118` (headers), `:123` (`colSpan` 4→6), `:129-134` (rows), `:150-158` (cards)
- Modify: `apps/web/src/locales/<8 dirs>/settings.json` → `siteList.columns.address: "Address"`, `siteList.columns.contact: "Contact"`
- Test: `SiteList.test.tsx`; `apps/web/src/components/organizations/record/OrgSitesTab.test.tsx`

**Interfaces:**
- Consumes: `formatAddress` (Task 1).
- Produces: `Site` gains `address?: { line1?: unknown; line2?: unknown; city?: unknown; state?: unknown; postalCode?: unknown; country?: unknown } | null; contact?: { name?: unknown; email?: unknown; phone?: unknown } | null` (jsonb is untyped on the wire; `useSiteCrud.ts:89,247` already reads it as `Record<string,string>` and stays source-compatible).

- [ ] **Step 1: Write the failing tests** (`SiteList.test.tsx`; the table and cards both render, so use `getAllBy*`):
  - `'shows the address as line1 · city, state and the contact with a tel: link'`: site with `address:{line1:'12 Harbour Rd', line2:'Unit 4', city:'Halifax', state:'NS', postalCode:'B3H 1A1', country:'CA'}`, `contact:{name:'Pat Lee', phone:'+1 902 555 0100'}` → `getAllByText('12 Harbour Rd · Halifax, NS').length > 0`; `getAllByText('Pat Lee').length > 0`; `getAllByRole('link', { name: '+1 902 555 0100' })[0].getAttribute('href')` is `'tel:+1 902 555 0100'`.
  - `'falls back to an em dash with no address and no contact'`: `site(1)` → `getAllByText('—').length >= 2`.
  - `'ignores non-string address values'` (Review Focus 1): `address:{line1:{nested:true}, city:'Austin', state:7}` → `getAllByText('Austin').length > 0`; `queryByText(/object/)` null.
  - `OrgSitesTab.test.tsx` first case: give `SITE` an `address:{line1:'1 Pier', city:'Halifax', state:'NS'}` and assert `getAllByText('1 Pier · Halifax, NS').length > 0` — proves the row passes through the tab untouched.
- [ ] **Step 2: Run to see it fail** — `cd apps/web && npx vitest run src/components/settings/SiteList.test.tsx src/components/organizations/record/OrgSitesTab.test.tsx` → new cases FAIL.
- [ ] **Step 3: Implement** — local `str = (v: unknown) => (typeof v === 'string' ? v : null)`; `siteAddressText(site) = formatAddress({ line1: str(site.address?.line1), city: str(site.address?.city), region: str(site.address?.state) })`; column order **Name, Address, Contact, Timezone, Devices, Actions**; Address cell = text or `'—'`; Contact cell = name span + `<a href={`tel:${phone}`} data-testid={`site-${site.id}-contact-phone`}>` when phone, `'—'` when neither. Mirror both cells as `CardField`s in the cards. Add the two keys to all 8 locales.
- [ ] **Step 4: Run to see it pass** — same two files; `cd apps/web && npx vitest run src/lib/i18n`.
- [ ] **Step 5: Commit** — `git add -A apps/web/src/components/settings/SiteList.tsx apps/web/src/components/settings/SiteList.test.tsx apps/web/src/components/organizations/record/OrgSitesTab.test.tsx apps/web/src/locales && git commit -m "feat(sites): address and contact columns in SiteList (A2)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 4: A3a — extract `toDeviceListRow`

**Files:**
- Create: `apps/web/src/components/devices/deviceRowTransform.ts`
- Modify: `apps/web/src/components/devices/DevicesPage.tsx:73-81` (move `warnedUnknownLinkGroupRoles` + `normalizeLinkGroupRole` out together), `:735-849` (agent-arm map body → one call), `:52` (drop now-unused imports; tsc tells you)
- Modify: `apps/web/src/components/organizations/record/OrgDevicesTab.tsx:1-4` (imports), `:59-65` (transform on load), `:97-106` (site-name overlay)
- Test: `deviceRowTransform.test.ts`; `OrgDevicesTab.test.tsx:11-26,69` (raw fixtures)

**Interfaces:**
- Produces: `export type ApiDeviceRow = Record<string, unknown>; export type DeviceListRow = Device; export function toDeviceListRow(raw: ApiDeviceRow): DeviceListRow` — the agent-arm transform verbatim, with `stableT('devicesPage.unknownDevice')` replaced by `i18n.t('devices:devicesPage.unknownDevice')` and `normalizeLinkGroupRole` moved alongside. `orgName`/`siteName` stay `''`; callers resolve names.

- [ ] **Step 1: Write the failing tests** — `deviceRowTransform.test.ts` (`import '@/lib/i18n'`), raw fixture `RAW = { id:'d1', hostname:'acme-laptop-01', osType:'windows', osVersion:'11', status:'online', cpuPercent: 37.456789012, ramPercent: 61.04, lastSeenAt:'2026-09-01T00:00:00.000Z', orgId:'org-1', siteId:'site-1', agentVersion:'1.0.0', tags:['vip'] }`:
  - `'maps a raw /devices row to the DeviceList shape with rounded percents'`: `os === 'windows'`, `lastSeen === RAW.lastSeenAt`, `cpuPercent === 37.5`, `ramPercent === 61`, `siteName === ''`, `orgName === ''`, `pendingReboot === false`, `linkGroupRole === null`, `tags` equals `['vip']`.
  - `'prefers nested metrics and clamps to 0–100'`: `{ ...RAW, metrics: { cpuPercent: 250 }, cpuPercent: 5 }` → `100`.
  - `'coerces string and null percents'` (Review Focus 3): `cpuPercent:'37.456789012'` → `37.5`; `cpuPercent:null` → `0`.
  - `'falls back to the Unknown label when hostname is missing'`: `{ ...RAW, hostname: undefined }` → `'Unknown'`.
  - `OrgDevicesTab.test.tsx`: replace `DEVICE` (`:11-26`) with the raw shape above (`orgId: RECORD_ORG`; no `os`, `lastSeen`, `orgName`, `siteName`) and `secondDevice` (`:69`) with `{ ...DEVICE, id:'d2', hostname:'acme-desktop-02', status:'offline', siteId:'site-2' }`; in the first case add `expect(screen.getByText('37.5%')).toBeTruthy()` and `expect(screen.getAllByText('HQ').length).toBeGreaterThan(0)` (site name resolved from `/orgs/sites`; the filter `<option>` also says HQ).
- [ ] **Step 2: Run to see it fail** — `cd apps/web && npx vitest run src/components/devices/deviceRowTransform.test.ts src/components/organizations/record/OrgDevicesTab.test.tsx` → transform file missing; tab case fails on `37.5%`.
- [ ] **Step 3: Implement** — move lines `740-848` into `toDeviceListRow` as its body; `DevicesPage.tsx:735` becomes `deviceList.map((d: Record<string, unknown>) => toDeviceListRow(d))`. `OrgDevicesTab`: `setDevices(rows.map(toDeviceListRow))` (type `rows` as `ApiDeviceRow[]`); in the `filteredDevices` memo build `siteNameById` from `sites` and return rows as `{ ...d, siteName: siteNameById.get(d.siteId) ?? t('devices:devicesPage.unknownSite') }` (same label `/devices` shows, `DevicesPage.tsx:958`).
- [ ] **Step 4: Run to see it pass** — same two files, then `cd apps/web && npx vitest run src/components/devices/DevicesPage.test.tsx src/components/devices/DevicesPage.orgScope.test.tsx` (unchanged behaviour on `/devices`).
- [ ] **Step 5: Commit** — `git add -A apps/web/src/components/devices/deviceRowTransform.ts apps/web/src/components/devices/deviceRowTransform.test.ts apps/web/src/components/devices/DevicesPage.tsx apps/web/src/components/organizations/record && git commit -m "refactor(devices): extract toDeviceListRow; org Devices tab uses it (A3a)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 5: A3b — rounding inside `DeviceList.metricBar` and `DeviceCard`

**Files:**
- Modify: `apps/web/src/components/devices/DeviceList.tsx:58` (add `import { toPercent } from "@/lib/deviceUtils"`), `:1471-1483`
- Modify: `apps/web/src/components/devices/DeviceCard.tsx:24` (add `toPercent`), `:586-647` (round once, use for text and thresholds)
- Test: create `apps/web/src/components/devices/DeviceList.metricRounding.test.tsx` (copy the mock block from `DeviceList.ipColumns.test.tsx:18-26`); extend `DeviceCard.test.tsx`

- [ ] **Step 1: Write the failing tests**:
  - DeviceList `'rounds a raw float percent to one decimal in the CPU and RAM cells'`: `render(<DeviceList devices={[{ ...base, cpuPercent: 37.456789012, ramPercent: 61.04 }]} />)` → `getByText('37.5%')`, `getByText('61%')`, `queryByText('37.456789012%')` null.
  - DeviceCard `'rounds a raw float percent before printing it'`: `render(<DeviceCard device={{ ...baseDevice, cpuPercent: 37.456789012 }} />)` (fetch mock resolves `{ metrics: [] }`) → `getByText('37.5%')`.
- [ ] **Step 2: Run to see it fail** — `cd apps/web && npx vitest run src/components/devices/DeviceList.metricRounding.test.tsx src/components/devices/DeviceCard.test.tsx` → 2 FAIL.
- [ ] **Step 3: Implement** — `metricBar`: `const shown = toPercent(percent)` drives the colour thresholds, `widthPercentClass(shown)` and `{shown}%`. `DeviceCard`: `const cpu = toPercent(device.cpuPercent); const ram = toPercent(device.ramPercent);` above the JSX; use them at `:590,595-597,620,625-627`.
- [ ] **Step 4: Run to see it pass** — same command → green.
- [ ] **Step 5: Commit** — `git add -A apps/web/src/components/devices && git commit -m "fix(devices): metricBar and DeviceCard round percents defensively (A3b)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 6: A3c — row navigation and an own column preset for the org tab

**Files:**
- Modify: `apps/web/src/components/devices/columnVisibility.ts:100-118` (presets), `:137-145`, `:153-158`, `:193-208`, `:216-257` (thread a `preset` parameter)
- Modify: `apps/web/src/components/devices/DeviceList.tsx:79-88` (imports), `:548-556` (prop), `:838` (destructure with default), `:880-885,1003-1039` (pass `columnPreset` to every helper call)
- Modify: `apps/web/src/components/organizations/record/OrgDevicesTab.tsx:1-4,164`
- Test: `columnVisibility.test.ts`; `OrgDevicesTab.test.tsx`

**Interfaces:**
- Produces (`columnVisibility.ts`): `export interface ColumnPreset { storageKey: string; defaultVisible: ReadonlyArray<ColumnId> }`; `export const DEVICES_PAGE_COLUMN_PRESET: ColumnPreset = { storageKey: COLUMN_STORAGE_KEY, defaultVisible: DEFAULT_VISIBLE_COLUMNS }`; `export const ORG_TAB_COLUMN_STORAGE_KEY = 'breeze.devices.columns.orgTab'`; `export const ORG_TAB_COLUMN_PRESET: ColumnPreset = { storageKey: ORG_TAB_COLUMN_STORAGE_KEY, defaultVisible: ['hostname','site','os','status','cpu','ram','lastSeen'] }`; every exported helper gains a trailing `preset: ColumnPreset = DEVICES_PAGE_COLUMN_PRESET` parameter: `readColumnVisibility(preset?)`, `writeColumnVisibility(visible, preset?)`, `readColumnOrder(preset?)`, `writeColumnOrder(order, preset?)`, `resetColumns(preset?)`.
- Produces (`DeviceList`): prop `columnPreset?: ColumnPreset` (default `DEVICES_PAGE_COLUMN_PRESET`; read at mount like `pageSize`, `:503-506`).

- [ ] **Step 1: Write the failing tests**:
  - `columnVisibility.test.ts`, new `describe('column presets')`: `'the orgTab preset defaults to exactly hostname, site, os, status, cpu, ram, lastSeen'` (`readColumnVisibility(ORG_TAB_COLUMN_PRESET)` equals that set on empty storage); `'writes under breeze.devices.columns.orgTab and leaves breeze.devices.columns untouched'` (`writeColumnVisibility(['hostname'], ORG_TAB_COLUMN_PRESET)` → `getItem('breeze.devices.columns')` null, orgTab key set, `readColumnVisibility()` still equals `new Set(DEFAULT_VISIBLE_COLUMNS)`); `'all-hidden falls back to the preset's defaults'` (Review Focus 5: store every orgTab column `visible:false`, `readColumnVisibility(ORG_TAB_COLUMN_PRESET)` equals the orgTab set, not the `/devices` set); `'resetColumns(preset) restores the preset defaults under its own key'`.
  - `OrgDevicesTab.test.tsx` (add `vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }))` and `beforeEach(() => window.localStorage.clear())`): `'row click navigates to the device page'`: after the row renders, `fireEvent.click(screen.getByText('acme-laptop-01'))` → `expect(navigateTo).toHaveBeenCalledWith('/devices/d1')`; `'uses the embedded column preset and persists it under its own key'`: `queryByText(/^Class$/)` and `queryByText(/^Role$/)` null; `fireEvent.click(getByRole('button', { name: /columns/i }))`, `fireEvent.click(getByLabelText('OS Version'))` → `localStorage.getItem('breeze.devices.columns.orgTab')` non-null and `getItem('breeze.devices.columns')` null.
- [ ] **Step 2: Run to see it fail** — `cd apps/web && npx vitest run src/components/devices/columnVisibility.test.ts src/components/organizations/record/OrgDevicesTab.test.tsx` → new cases FAIL.
- [ ] **Step 3: Implement** — `columnVisibility.ts`: `defaultVisible(id, preset)`, `defaultColumns(preset)`, `readColumns(preset)`, `writeColumns(columns, preset)` take the preset; `readColumnVisibility`'s all-hidden fallback returns `new Set(preset.defaultVisible)`. `DeviceList`: thread `columnPreset` into the five call sites. `OrgDevicesTab`: `<DeviceList devices={filteredDevices} sites={sites} forceSingleOrg columnPreset={ORG_TAB_COLUMN_PRESET} onSelect={(d) => void navigateTo(`/devices/${d.id}`)} />` (agent rows only, so no class branch; Edit routes through `onSelect` too — accepted by the spec).
- [ ] **Step 4: Run to see it pass** — same two files, then `cd apps/web && npx vitest run src/components/devices/DeviceList.test.tsx src/components/devices/DeviceList.ipColumns.test.tsx` (default preset unchanged).
- [ ] **Step 5: Commit** — `git add -A apps/web/src/components/devices/columnVisibility.ts apps/web/src/components/devices/columnVisibility.test.ts apps/web/src/components/devices/DeviceList.tsx apps/web/src/components/organizations/record && git commit -m "feat(org-record): Devices tab rows navigate; own column preset breeze.devices.columns.orgTab (A3c)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 7: A4 — `deviceListCrumbHref` and the device page crumb/back

**Files:**
- Create: `apps/web/src/components/devices/deviceListCrumbHref.ts`
- Modify: `apps/web/src/components/devices/DeviceDetailPage.tsx:35` (imports), `:325-335` (store read + `handleBack`), `:751` (crumb href)
- Test: `deviceListCrumbHref.test.ts`; `DeviceDetailPage.orgBreadcrumb.test.tsx:9,26` + new cases

**Interfaces:**
- Produces: `export function deviceListCrumbHref(currentOrgId: string | null, deviceOrgId: string): string` — `'/devices'` when `currentOrgId === null`, when it equals `deviceOrgId`, or when `deviceOrgId === ''`; otherwise `` `/organizations/${deviceOrgId}#devices` `` (bare `#<tab>`, `orgRecordTabs.ts:106-109`).

- [ ] **Step 1: Write the failing tests**:
  - `deviceListCrumbHref.test.ts`: `(null,'org-42')` → `'/devices'`; `('org-42','org-42')` → `'/devices'`; `('org-99','org-42')` → `'/organizations/org-42#devices'`; `('org-99','')` → `'/devices'` (Review Focus 4).
  - `DeviceDetailPage.orgBreadcrumb.test.tsx`: change the auth mock to `{ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }` (`orgStore.ts:434` runs at import); change the `DeviceDetails` mock to `({ onBack }) => <button onClick={onBack}>back</button>`; `import { useOrgStore } from '@/stores/orgStore'` and in `beforeEach` `useOrgStore.setState({ currentOrgId: null, allOrgs: true } as never)`. New `describe('Devices crumb (ui-flow A4)')` using the first case's fetch payload (`orgId:'org-42'`): `'goes to /devices in fleet view'` → `findByRole('link', { name: 'Devices' })` href `'/devices'`; `'goes to /devices when the working org is the device org'` (`currentOrgId:'org-42', allOrgs:false`) → `'/devices'`; `'goes to the device org's Devices tab when the working org differs, and so does Back'` (`currentOrgId:'org-99'`) → href `'/organizations/org-42#devices'`; click `back` → `expect(navigateTo).toHaveBeenCalledWith('/organizations/org-42#devices')`.
- [ ] **Step 2: Run to see it fail** — `cd apps/web && npx vitest run src/components/devices/deviceListCrumbHref.test.ts src/components/devices/DeviceDetailPage.orgBreadcrumb.test.tsx` → FAIL.
- [ ] **Step 3: Implement** — `const currentOrgId = useOrgStore((s) => s.currentOrgId)` next to the `useRecentsStore` reads (unconditional, before the early returns); `const devicesHref = device ? deviceListCrumbHref(currentOrgId, device.orgId) : '/devices'`; `handleBack = () => void navigateTo(devicesHref)`; crumb `{ label: t("deviceDetailPage.devices"), href: devicesHref }`. The org crumb itself is unchanged (no context switch anywhere).
- [ ] **Step 4: Run to see it pass** — same command → green (both pre-existing cases included).
- [ ] **Step 5: Commit** — `git add -A apps/web/src/components/devices && git commit -m "fix(devices): Devices crumb and Back land on the device's own org (A4)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 8: Verify and open the PR

- [ ] **Step 1: Typecheck** — `cd apps/web && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo exit=$?` → `exit=0`.
- [ ] **Step 2: Locale parity** — `cd apps/web && npx vitest run src/lib/i18n` → the reported file list includes `localeParity.test.ts`, all green.
- [ ] **Step 3: Full web suite** — `cd apps/web && npx vitest run` → 0 failed.
- [ ] **Step 4: Confirm the seven commits exist on the wave branch** — `git log --oneline main..HEAD` shows Tasks 1–7.
- [ ] **Step 5: PR** — title `feat(web): org record address, site columns, Devices tab fixes, device crumb (UI flow W01)`; body: A1–A4 summary, `Closes #<sub-issue>`, `Part of #8985`, the `breeze.devices.columns.orgTab` key and the W02 dependency on `formatAddress`; end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Non-goals

- The Devices tab's 200-row cap (documented at `OrgDevicesTab.tsx:34-41`) stays.
- Hostname/org/site cells become links in W03 (`EntityLink`); here row click is the navigation.
- `Organization` in `orgStore.ts` does not gain address fields here (W02 does that for the switcher pane).
