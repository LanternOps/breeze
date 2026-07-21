# Vulnerabilities Fleet Triage UI Implementation Plan — Part 2: Web (Tasks 8–17)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The frontend of the fleet vulnerabilities triage UI: shared Drawer primitive, API client, software-grouped work queue + CVE tab, stat cards + filter bar + hash-routed page shell, action drawers (remediate / accept-risk / mitigate / reopen / create-ticket), and e2e coverage.

**Prerequisite:** Part 1 — `2026-07-05-vulnerabilities-triage-api.md` (Tasks 1–7) must be implemented first; every endpoint and payload shape consumed here is produced there. Task numbering continues from Part 1 so cross-references like "Task 9's `fetchSoftwareGroups`" stay unambiguous across both documents.

**Architecture:** A hash-routed page island (`#software` default / `#cves`) owns shared filter state and a `refreshKey`; tables and drawers are leaf components that fetch through `lib/api/vulnerabilities.ts`. Drawers are built on `shared/Drawer.tsx`, extracted verbatim from the catalog editor drawer chrome.

**Tech Stack:** Astro + React islands + Tailwind, Vitest + jsdom + Testing Library, Playwright e2e.

**Spec:** `docs/superpowers/specs/vuln-patch/2026-07-04-vulnerabilities-triage-ui-design.md` (approved).

## Global Constraints

- **Web mutations:** always via `runAction` (`apps/web/src/lib/runAction.ts`); catch with `handleActionError(err, fallback)`. New mutating/action components are added to `TARGET_GLOBS` in `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` with the count constant bumped in the same commit (current value **58**; this plan ends at **63**: +`VulnerabilityFleetPage` Task 12, +`SoftwareGroupDrawer`/`VulnBulkActionModal` Task 13, +`CveDrawer` Task 14, +`CreateVulnTicketModal` Task 15).
- **URL state:** hash only (`#software`, `#cves`, `#software/<encodeURIComponent(groupKey)>`, `#cves/<cveId>`). Filters are transient React state — NOT query params.
- **Group key format (opaque, produced by the API):** `sw:<lower(trim(name))>|<lower(trim(coalesce(vendor,'')))>` or `os:<windows|macos|linux>`. The web treats it as an opaque string; always `encodeURIComponent` when placing it in a hash or URL path.
- **Permissions (exact strings, via `usePermissions().can(resource, action)`):** remediate = `('devices','execute')`; accept-risk & reopen = `('vulnerabilities','accept_risk')`; mitigate = `('devices','write')`; create-ticket = `('tickets','write')`. Buttons are HIDDEN when unpermitted (device-tab convention); the server re-checks.
- **E2E:** `data-testid` attributes only, never text/role/CSS selectors.
- **Component tests:** scope table assertions to `within(screen.getByTestId('responsive-table-desktop'))` (the mobile card duplicate renders in jsdom too); mock the typed API module (`../../lib/api/vulnerabilities`), not `fetch`.
- **Test commands:** `cd apps/web && pnpm vitest run <file>`; e2e: `cd e2e-tests && pnpm test -- tests/vulnerabilities.spec.ts` (needs a running seeded stack — `worktree-stack` skill).

---

### Task 8: Shared `Drawer.tsx` primitive (extracted from the catalog editor drawer)

**Files:**
- Create: `apps/web/src/components/shared/Drawer.tsx`
- Test: `apps/web/src/components/shared/Drawer.test.tsx`

**Interfaces:**
- Consumes: chrome + a11y code extracted VERBATIM from `apps/web/src/components/settings/CatalogItemEditorDrawer.tsx` (a11y block lines 177–207, portal/backdrop/panel JSX lines 437–474, `FOCUSABLE` constant lines 27–28). Class strings, inline animation styles, and behavior must be byte-identical — the CSS animations `dialog-backdrop-in` and `slide-in-from-right` are defined in the web app's global CSS and must keep matching.
- Produces: `Drawer` component with props `{ open: boolean; onClose: () => void; title: ReactNode; width?: string; dataTestId?: string; closeDisabled?: boolean; children: ReactNode }` — used by Tasks 13, 14, 17.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/shared/Drawer.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Drawer } from './Drawer';

describe('Drawer', () => {
  it('renders nothing when closed', () => {
    render(
      <Drawer open={false} onClose={() => {}} title="Details">
        <p>body</p>
      </Drawer>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders title, children, and dialog semantics when open', () => {
    render(
      <Drawer open onClose={() => {}} title="Details" dataTestId="my-drawer">
        <p>body</p>
      </Drawer>,
    );
    const panel = screen.getByTestId('my-drawer');
    expect(panel).toHaveAttribute('role', 'dialog');
    expect(panel).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('Details')).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('calls onClose on Escape and on backdrop click, but not on panel click', () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="T" dataTestId="my-drawer">
        <button type="button">inner</button>
      </Drawer>,
    );
    fireEvent.click(screen.getByText('inner'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('my-drawer-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByTestId('my-drawer'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('suppresses backdrop close when closeDisabled', () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="T" dataTestId="my-drawer" closeDisabled>
        <p>body</p>
      </Drawer>,
    );
    fireEvent.click(screen.getByTestId('my-drawer-backdrop'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('applies a custom width class and the close button works', () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="T" width="max-w-xl" dataTestId="my-drawer">
        <p>body</p>
      </Drawer>,
    );
    expect(screen.getByTestId('my-drawer').className).toContain('max-w-xl');
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && pnpm vitest run src/components/shared/Drawer.test.tsx`
Expected: FAIL — cannot resolve `./Drawer`.

- [ ] **Step 3: Implement**

Create `apps/web/src/components/shared/Drawer.tsx`. Before writing, open `apps/web/src/components/settings/CatalogItemEditorDrawer.tsx` and copy the referenced blocks verbatim (do not retype from this plan — the plan reproduces them, but the source file is the source of truth for class strings):

```tsx
import { useCallback, useEffect, useId, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// Extracted verbatim from settings/CatalogItemEditorDrawer.tsx so both drawers
// keep identical chrome, animations, and a11y behavior.
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Tailwind max-width class for the panel. */
  width?: string;
  dataTestId?: string;
  /** Blocks backdrop-click close (e.g. while a mutation is in flight). */
  closeDisabled?: boolean;
  children: ReactNode;
}

export function Drawer({
  open,
  onClose,
  title,
  width = 'max-w-md',
  dataTestId = 'drawer',
  closeDisabled = false,
  children,
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);
  const titleId = useId();

  // ---- a11y: focus, scroll-lock, escape, focus-trap -----------------------
  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement;
    const raf = requestAnimationFrame(() => {
      const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panelRef.current)?.focus();
    });
    document.body.style.overflow = 'hidden';
    return () => {
      cancelAnimationFrame(raf);
      document.body.style.overflow = '';
      if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus();
    };
  }, [open]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'Tab' && panelRef.current) {
        const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (nodes.length === 0) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last!.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first!.focus();
        }
      }
    },
    [onClose],
  );

  const handleBackdropClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget && !closeDisabled) onClose();
    },
    [onClose, closeDisabled],
  );

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="dialog-backdrop fixed inset-0 z-50 flex justify-end bg-background/80"
      style={{ animation: 'dialog-backdrop-in 150ms ease-out' }}
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
      data-testid={`${dataTestId}-backdrop`}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`drawer-panel flex h-full w-full ${width} flex-col border-l bg-card shadow-xl focus:outline-hidden`}
        style={{ animation: 'slide-in-from-right 220ms cubic-bezier(0.22, 1, 0.36, 1)' }}
        data-testid={dataTestId}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h2 id={titleId} className="min-w-0 text-base font-semibold">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
            data-testid={`${dataTestId}-close`}
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export default Drawer;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && pnpm vitest run src/components/shared/Drawer.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/shared/Drawer.tsx apps/web/src/components/shared/Drawer.test.tsx
git commit -m "feat(web): shared slide-over Drawer primitive extracted from catalog editor"
```

---

### Task 9: Web API client — new fetchers, bulk mutations, richer remediate toast

**Files:**
- Modify: `apps/web/src/lib/api/vulnerabilities.ts`
- Test: `apps/web/src/lib/api/vulnerabilities.helpers.test.ts` (new)

**Interfaces:**
- Consumes: API shapes from Tasks 3–7; existing `runAction`, `fetchWithAuth`, `JSON_HEADERS` already used in this file.
- Produces (all exported; consumed by Tasks 10–15):
  - Types: `VulnFleetFilters`, `SoftwareGroup`, `SoftwareGroupDetail`, `GroupCve`, `GroupFinding`, `FleetVulnStats`, `CveCatalogRecord`, `CveDevicesPayload`, `BulkActionResult`, `VulnTicketResult`; `FleetVulnerability` gains `epssScore: number | null`, `patchAvailable: boolean`, `statuses: string[]`; `VulnerabilityFilters` gains `kevOnly?: boolean; patchAvailable?: boolean`.
  - Reads: `fetchSoftwareGroups(filters: VulnFleetFilters): Promise<{ items: SoftwareGroup[]; hasMore: boolean }>`, `fetchSoftwareGroupDetail(groupKey: string): Promise<SoftwareGroupDetail>`, `fetchVulnStats(): Promise<FleetVulnStats>`, `fetchCveDevices(cveId: string): Promise<CveDevicesPayload>`.
  - Mutations: `bulkAcceptVulnRisk(ids: string[], payload: { reason: string; acceptedUntil: string }): Promise<BulkActionResult>`, `bulkMitigateVulns(ids: string[], payload: { note: string }): Promise<BulkActionResult>`, `createVulnTicket(ids: string[], payload: { title: string; description?: string; priority: 'low' | 'normal' | 'high' | 'urgent' }): Promise<VulnTicketResult>`.
  - Pure helpers (exported for tests): `buildVulnQuery(params: Record<string, string | boolean | undefined>): string`, `bulkSummary(verb: string, succeeded: number, skipped: Array<{ id: string; reason: string }>): string`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/api/vulnerabilities.helpers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildVulnQuery, bulkSummary } from './vulnerabilities';

describe('buildVulnQuery', () => {
  it('serializes set params, drops empty/false/undefined, and URL-encodes', () => {
    expect(
      buildVulnQuery({ status: 'open', severity: '', search: 'google chrome', kevOnly: true, patchAvailable: false }),
    ).toBe('?status=open&search=google+chrome&kevOnly=true');
  });

  it('returns empty string when nothing is set', () => {
    expect(buildVulnQuery({ severity: undefined, kevOnly: false })).toBe('');
  });
});

describe('bulkSummary', () => {
  it('reports plain success', () => {
    expect(bulkSummary('accepted', 12, [])).toBe('12 accepted');
  });

  it('appends skip count and first skip reason (partial success)', () => {
    expect(
      bulkSummary('scheduled', 12, [
        { id: 'a', reason: 'no approved patch' },
        { id: 'b', reason: 'no approved patch' },
      ]),
    ).toBe('12 scheduled, 2 skipped — no approved patch');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && pnpm vitest run src/lib/api/vulnerabilities.helpers.test.ts`
Expected: FAIL — `buildVulnQuery`/`bulkSummary` not exported.

- [ ] **Step 3: Implement**

In `apps/web/src/lib/api/vulnerabilities.ts` (read the file first; mirror its existing `fetchVulnerabilities` read helper and `remediateVuln` mutation idioms exactly — imports, `fetchWithAuth`, `JSON_HEADERS`, error handling on `!res.ok`):

1. Add the shared filter/type block:

```ts
export interface VulnFleetFilters {
  search: string;
  severity: string;   // '' = all
  status: string;     // 'open' default
  kevOnly: boolean;
  patchAvailable: boolean;
}

export interface SoftwareGroup {
  groupKey: string;
  kind: 'software' | 'os';
  name: string;
  vendor: string | null;
  versions: string[];
  deviceCount: number;
  cveCount: number;
  cveIds: string[];
  worstSeverity: string | null;
  maxRiskScore: number | null;
  kevCveCount: number;
  maxEpss: number | null;
  patchReadyFindingCount: number;
  patchReadyDeviceCount: number;
  ticketIds: string[];
}

export interface GroupCve {
  cveId: string;
  vulnerabilityId: string;
  severity: string | null;
  cvssScore: number | null;
  epssScore: number | null;
  knownExploited: boolean;
  patchAvailable: boolean;
  maxRiskScore: number | null;
}

export interface GroupFinding {
  deviceVulnerabilityId: string;
  deviceId: string;
  deviceName: string;
  orgId: string;
  orgName: string | null;
  cveId: string;
  status: string;
  patchAvailable: boolean;
  riskScore: number | null;
  detectedAt: string;
  ticketId: string | null;
}

export interface SoftwareGroupDetail {
  group: SoftwareGroup;
  cves: GroupCve[];
  findings: GroupFinding[];
}

export interface FleetVulnStats {
  criticalOpen: number;
  kevCveCount: number;
  kevDeviceCount: number;
  patchReadyFindingCount: number;
  acceptedExpiringSoon: number;
}

export interface CveCatalogRecord {
  cveId: string;
  description: string;
  references: unknown;
  cvssVersion: string | null;
  cvssVector: string | null;
  cvssScore: number | null;
  epssScore: number | null;
  knownExploited: boolean;
  patchAvailable: boolean;
  severity: string | null;
  publishedAt: string | null;
  modifiedAt: string | null;
}

export interface CveDevicesPayload {
  cve: CveCatalogRecord;
  findings: GroupFinding[];
}

export interface BulkActionResult {
  success: boolean;
  succeeded: number;
  skipped: Array<{ id: string; reason: string }>;
}

export interface VulnTicketResult {
  success: boolean;
  tickets: Array<{ ticketId: string; orgId: string; findingCount: number }>;
  skipped: Array<{ id: string; reason: string }>;
}
```

2. Extend the existing `FleetVulnerability` interface with `epssScore: number | null; patchAvailable: boolean; statuses: string[];` (keep existing fields) and `VulnerabilityFilters` with `kevOnly?: boolean; patchAvailable?: boolean;`. Thread the two new params through `fetchVulnerabilities`'s query-string building (use `buildVulnQuery` below — refactor the existing helper if one exists, keeping behavior).

3. Add the pure helpers:

```ts
export function buildVulnQuery(params: Record<string, string | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '' || value === false) continue;
    q.set(key, String(value));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

export function bulkSummary(verb: string, succeeded: number, skipped: Array<{ id: string; reason: string }>): string {
  const base = `${succeeded} ${verb}`;
  if (skipped.length === 0) return base;
  return `${base}, ${skipped.length} skipped — ${skipped[0]!.reason}`;
}
```

4. Add the read fetchers (mirror `fetchVulnerabilities`'s exact fetch/throw idiom):

```ts
export async function fetchSoftwareGroups(filters: VulnFleetFilters): Promise<{ items: SoftwareGroup[]; hasMore: boolean }> {
  const res = await fetchWithAuth(
    `/vulnerabilities/software${buildVulnQuery({
      status: filters.status,
      severity: filters.severity,
      search: filters.search,
      kevOnly: filters.kevOnly,
      patchAvailable: filters.patchAvailable,
    })}`,
  );
  if (!res.ok) throw new Error('Failed to load software groups');
  return res.json() as Promise<{ items: SoftwareGroup[]; hasMore: boolean }>;
}

export async function fetchSoftwareGroupDetail(groupKey: string): Promise<SoftwareGroupDetail> {
  const res = await fetchWithAuth(`/vulnerabilities/software/${encodeURIComponent(groupKey)}`);
  if (!res.ok) throw new Error('Failed to load software group');
  return res.json() as Promise<SoftwareGroupDetail>;
}

export async function fetchVulnStats(): Promise<FleetVulnStats> {
  const res = await fetchWithAuth('/vulnerabilities/stats');
  if (!res.ok) throw new Error('Failed to load vulnerability stats');
  return res.json() as Promise<FleetVulnStats>;
}

export async function fetchCveDevices(cveId: string): Promise<CveDevicesPayload> {
  const res = await fetchWithAuth(`/vulnerabilities/${encodeURIComponent(cveId)}/devices`);
  if (!res.ok) throw new Error('Failed to load CVE details');
  return res.json() as Promise<CveDevicesPayload>;
}
```

5. Add the mutations (all `runAction`-wrapped; this file is already in the `no-silent-mutations` targeted set):

```ts
function parseBulk(data: unknown): BulkActionResult {
  const d = data as Partial<BulkActionResult>;
  return { success: d.success ?? false, succeeded: d.succeeded ?? 0, skipped: d.skipped ?? [] };
}

export async function bulkAcceptVulnRisk(
  deviceVulnerabilityIds: string[],
  payload: { reason: string; acceptedUntil: string },
): Promise<BulkActionResult> {
  return runAction<BulkActionResult>({
    request: () =>
      fetchWithAuth('/vulnerabilities/bulk/accept-risk', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ deviceVulnerabilityIds, ...payload }),
      }),
    errorFallback: 'Failed to accept risk',
    successMessage: (d) => bulkSummary('accepted', d.succeeded, d.skipped),
    parseSuccess: parseBulk,
  });
}

export async function bulkMitigateVulns(
  deviceVulnerabilityIds: string[],
  payload: { note: string },
): Promise<BulkActionResult> {
  return runAction<BulkActionResult>({
    request: () =>
      fetchWithAuth('/vulnerabilities/bulk/mitigate', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ deviceVulnerabilityIds, ...payload }),
      }),
    errorFallback: 'Failed to mitigate',
    successMessage: (d) => bulkSummary('mitigated', d.succeeded, d.skipped),
    parseSuccess: parseBulk,
  });
}

export async function createVulnTicket(
  deviceVulnerabilityIds: string[],
  payload: { title: string; description?: string; priority: 'low' | 'normal' | 'high' | 'urgent' },
): Promise<VulnTicketResult> {
  return runAction<VulnTicketResult>({
    request: () =>
      fetchWithAuth('/vulnerabilities/tickets', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ deviceVulnerabilityIds, ...payload }),
      }),
    errorFallback: 'Failed to create ticket',
    successMessage: (d) =>
      d.tickets.length === 1 ? 'Ticket created' : `${d.tickets.length} tickets created (one per organization)`,
    parseSuccess: (data) => {
      const d = data as Partial<VulnTicketResult>;
      return { success: d.success ?? false, tickets: d.tickets ?? [], skipped: d.skipped ?? [] };
    },
  });
}
```

6. Upgrade `remediateVuln`'s `successMessage` to surface partial success (spec: "12 scheduled, 2 skipped — no approved patch"):

```ts
    successMessage: (d) => bulkSummary(`remediation${d.scheduled === 1 ? '' : 's'} scheduled`, d.scheduled, d.skipped),
```

Wait — that reads "12 remediations scheduled, 2 skipped — no approved patch" only if `bulkSummary` puts the verb after the count; with the helper as defined it renders `12 remediations scheduled, 2 skipped — no approved patch`. That is the desired copy; keep it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && pnpm vitest run src/lib/api/vulnerabilities.helpers.test.ts src/lib/__tests__/no-silent-mutations.test.ts src/components/devices/DeviceVulnerabilitiesTab.test.tsx`
Expected: PASS — helpers green; no-silent-mutations still green (this file was already targeted and all new mutations are `runAction`-wrapped); the device tab tests still pass (its mocked API module gained functions it doesn't use).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/api/vulnerabilities.ts apps/web/src/lib/api/vulnerabilities.helpers.test.ts
git commit -m "feat(web): fleet vulnerability API client — groups, stats, bulk actions, tickets"
```

---

### Task 10: `SeverityBadge` extraction + `SoftwareGroupTable` (work-queue tab)

**Files:**
- Create: `apps/web/src/components/vulnerabilities/SeverityBadge.tsx`
- Create: `apps/web/src/components/vulnerabilities/SoftwareGroupTable.tsx`
- Modify: `apps/web/src/components/vulnerabilities/VulnerabilityTable.tsx` (delete its inline `SEVERITY_BADGES`/`SeverityBadge`, import from the new file)
- Test: `apps/web/src/components/vulnerabilities/SoftwareGroupTable.test.tsx`

**Interfaces:**
- Consumes: Task 9's `fetchSoftwareGroups`, `SoftwareGroup`, `VulnFleetFilters`; `ResponsiveTable`/`DataCard`/`CardField` from `../shared/ResponsiveTable`.
- Produces:
  - `SeverityBadge({ severity }: { severity: string | null })` (named + default export).
  - `SoftwareGroupTable({ filters, refreshKey, onSelectGroup, onClearFilters }: { filters: VulnFleetFilters; refreshKey: number; onSelectGroup: (groupKey: string) => void; onClearFilters: () => void })`.
  - Testids: `software-group-row-<groupKey>` (desktop rows), `software-group-table-empty`, `software-group-table-error`, `software-group-clear-filters`, `software-group-has-more`.

- [ ] **Step 1: Extract `SeverityBadge`**

Create `apps/web/src/components/vulnerabilities/SeverityBadge.tsx` by MOVING (cut, not copy) the `SEVERITY_BADGES` map and `SeverityBadge` function from `VulnerabilityTable.tsx` lines 10–28 verbatim, adding exports:

```tsx
const SEVERITY_BADGES: Record<string, { label: string; className: string }> = {
  critical: { label: 'Critical', className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
  high: { label: 'High', className: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300' },
  medium: { label: 'Medium', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
  low: { label: 'Low', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
};

export function SeverityBadge({ severity }: { severity: string | null }) {
  const key = severity?.toLowerCase() ?? '';
  const badge = SEVERITY_BADGES[key] ?? {
    label: severity ?? 'Unknown',
    className: 'bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-300',
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${badge.className}`}>
      {badge.label}
    </span>
  );
}

export default SeverityBadge;
```

In `VulnerabilityTable.tsx`, replace the removed block with `import { SeverityBadge } from './SeverityBadge';`.

Run: `cd apps/web && pnpm vitest run src/components/vulnerabilities/`
Expected: existing `VulnerabilityTable.test.tsx` still PASSES.

- [ ] **Step 2: Write the failing `SoftwareGroupTable` tests**

Create `apps/web/src/components/vulnerabilities/SoftwareGroupTable.test.tsx` (copy the auth/API mock idioms from `DeviceVulnerabilitiesTab.test.tsx`; scope assertions to the desktop surface):

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';

vi.mock('../../lib/api/vulnerabilities', () => ({
  fetchSoftwareGroups: vi.fn(),
}));

import * as api from '../../lib/api/vulnerabilities';
import { SoftwareGroupTable } from './SoftwareGroupTable';
import type { SoftwareGroup, VulnFleetFilters } from '../../lib/api/vulnerabilities';

const FILTERS: VulnFleetFilters = { search: '', severity: '', status: 'open', kevOnly: false, patchAvailable: false };

function group(overrides: Partial<SoftwareGroup> = {}): SoftwareGroup {
  return {
    groupKey: 'sw:google chrome|google llc',
    kind: 'software',
    name: 'Google Chrome',
    vendor: 'Google LLC',
    versions: ['125.0', '126.0'],
    deviceCount: 14,
    cveCount: 6,
    cveIds: ['CVE-2026-0001'],
    worstSeverity: 'critical',
    maxRiskScore: 95,
    kevCveCount: 1,
    maxEpss: 0.9,
    patchReadyFindingCount: 12,
    patchReadyDeviceCount: 12,
    ticketIds: [],
    ...overrides,
  };
}

describe('SoftwareGroupTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.fetchSoftwareGroups).mockResolvedValue({ items: [group()], hasMore: false });
  });

  it('renders one row per group with patch readiness and KEV flag', async () => {
    render(<SoftwareGroupTable filters={FILTERS} refreshKey={0} onSelectGroup={() => {}} onClearFilters={() => {}} />);
    const desktop = within(await screen.findByTestId('responsive-table-desktop'));
    const row = desktop.getByTestId('software-group-row-sw:google chrome|google llc');
    expect(row).toHaveTextContent('Google Chrome');
    expect(row).toHaveTextContent('Google LLC');
    expect(row).toHaveTextContent('Ready · 12/14 devices');
    expect(row).toHaveTextContent('KEV');
  });

  it('invokes onSelectGroup with the groupKey on row click', async () => {
    const onSelect = vi.fn();
    render(<SoftwareGroupTable filters={FILTERS} refreshKey={0} onSelectGroup={onSelect} onClearFilters={() => {}} />);
    const desktop = within(await screen.findByTestId('responsive-table-desktop'));
    fireEvent.click(desktop.getByTestId('software-group-row-sw:google chrome|google llc'));
    expect(onSelect).toHaveBeenCalledWith('sw:google chrome|google llc');
  });

  it('refetches when filters or refreshKey change', async () => {
    const { rerender } = render(
      <SoftwareGroupTable filters={FILTERS} refreshKey={0} onSelectGroup={() => {}} onClearFilters={() => {}} />,
    );
    await screen.findByTestId('responsive-table-desktop');
    rerender(
      <SoftwareGroupTable filters={{ ...FILTERS, severity: 'critical' }} refreshKey={0} onSelectGroup={() => {}} onClearFilters={() => {}} />,
    );
    await vi.waitFor(() => expect(api.fetchSoftwareGroups).toHaveBeenCalledTimes(2));
    expect(api.fetchSoftwareGroups).toHaveBeenLastCalledWith(expect.objectContaining({ severity: 'critical' }));
  });

  it('shows the filtered-empty state with a clear-filters link', async () => {
    vi.mocked(api.fetchSoftwareGroups).mockResolvedValue({ items: [], hasMore: false });
    const onClear = vi.fn();
    render(
      <SoftwareGroupTable
        filters={{ ...FILTERS, severity: 'low' }}
        refreshKey={0}
        onSelectGroup={() => {}}
        onClearFilters={onClear}
      />,
    );
    fireEvent.click(await screen.findByTestId('software-group-clear-filters'));
    expect(onClear).toHaveBeenCalled();
  });

  it('shows the error state on fetch failure', async () => {
    vi.mocked(api.fetchSoftwareGroups).mockRejectedValue(new Error('boom'));
    render(<SoftwareGroupTable filters={FILTERS} refreshKey={0} onSelectGroup={() => {}} onClearFilters={() => {}} />);
    expect(await screen.findByTestId('software-group-table-error')).toHaveTextContent('boom');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/web && pnpm vitest run src/components/vulnerabilities/SoftwareGroupTable.test.tsx`
Expected: FAIL — cannot resolve `./SoftwareGroupTable`.

- [ ] **Step 4: Implement**

Create `apps/web/src/components/vulnerabilities/SoftwareGroupTable.tsx` (follow `VulnerabilityTable.tsx`'s structure: `useEffect` fetch with `cancelled` flag, `useMemo` table + cards, `ResponsiveTable`):

```tsx
import { useEffect, useMemo, useState } from 'react';

import { ResponsiveTable, DataCard, CardField } from '../shared/ResponsiveTable';
import { SeverityBadge } from './SeverityBadge';
import {
  fetchSoftwareGroups,
  type SoftwareGroup,
  type VulnFleetFilters,
} from '../../lib/api/vulnerabilities';

function fmtRisk(value: number | null): string {
  return value === null ? '—' : String(Math.round(value));
}

function versionRange(versions: string[]): string {
  if (versions.length === 0) return '';
  if (versions.length === 1) return versions[0]!;
  return `${versions[0]} – ${versions[versions.length - 1]}`;
}

function patchLabel(g: SoftwareGroup): string {
  return g.patchReadyFindingCount > 0 ? `Ready · ${g.patchReadyDeviceCount}/${g.deviceCount} devices` : '—';
}

const KEV_BADGE = (
  <span className="inline-flex items-center rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
    KEV
  </span>
);

export function SoftwareGroupTable({
  filters,
  refreshKey,
  onSelectGroup,
  onClearFilters,
}: {
  filters: VulnFleetFilters;
  refreshKey: number;
  onSelectGroup: (groupKey: string) => void;
  onClearFilters: () => void;
}) {
  const [items, setItems] = useState<SoftwareGroup[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchSoftwareGroups(filters)
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setHasMore(res.hasMore);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load software groups');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters, refreshKey]);

  const table = useMemo(
    () => (
      <table className="min-w-full divide-y">
        <thead className="bg-muted/40">
          <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-3">Software</th>
            <th className="px-4 py-3">Severity</th>
            <th className="px-4 py-3">Risk</th>
            <th className="px-4 py-3">CVEs</th>
            <th className="px-4 py-3">Devices</th>
            <th className="px-4 py-3">Patch</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {items.map((g) => (
            <tr
              key={g.groupKey}
              data-testid={`software-group-row-${g.groupKey}`}
              className="cursor-pointer transition hover:bg-muted/40"
              onClick={() => onSelectGroup(g.groupKey)}
            >
              <td className="px-4 py-3 text-sm">
                <div className="font-medium">{g.name}</div>
                <div className="text-xs text-muted-foreground">
                  {[g.vendor, versionRange(g.versions)].filter(Boolean).join(' · ')}
                </div>
              </td>
              <td className="px-4 py-3 text-sm">
                <span className="inline-flex items-center gap-1.5">
                  <SeverityBadge severity={g.worstSeverity} />
                  {g.kevCveCount > 0 && KEV_BADGE}
                </span>
              </td>
              <td className="px-4 py-3 text-sm tabular-nums">{fmtRisk(g.maxRiskScore)}</td>
              <td className="px-4 py-3 text-sm tabular-nums">{g.cveCount}</td>
              <td className="px-4 py-3 text-sm tabular-nums">{g.deviceCount}</td>
              <td className="px-4 py-3 text-sm">{patchLabel(g)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    ),
    [items, onSelectGroup],
  );

  const cards = useMemo(
    () =>
      items.map((g) => (
        <DataCard key={g.groupKey} onClick={() => onSelectGroup(g.groupKey)}>
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-semibold">{g.name}</span>
            <span className="inline-flex shrink-0 items-center gap-1.5">
              <SeverityBadge severity={g.worstSeverity} />
              {g.kevCveCount > 0 && KEV_BADGE}
            </span>
          </div>
          <div className="mt-3 space-y-2 border-t pt-3">
            <CardField label="Risk"><span className="text-sm tabular-nums">{fmtRisk(g.maxRiskScore)}</span></CardField>
            <CardField label="CVEs"><span className="text-sm tabular-nums">{g.cveCount}</span></CardField>
            <CardField label="Devices"><span className="text-sm tabular-nums">{g.deviceCount}</span></CardField>
            <CardField label="Patch"><span className="text-sm">{patchLabel(g)}</span></CardField>
          </div>
        </DataCard>
      )),
    [items, onSelectGroup],
  );

  if (error) {
    return (
      <div
        data-testid="software-group-table-error"
        className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300"
      >
        {error}
      </div>
    );
  }

  if (!loading && items.length === 0) {
    return (
      <div
        data-testid="software-group-table-empty"
        className="rounded-md border border-dashed px-4 py-12 text-center text-sm text-muted-foreground"
      >
        <p>No vulnerabilities match the current filters.</p>
        <button
          type="button"
          data-testid="software-group-clear-filters"
          className="mt-2 text-sm font-medium text-primary hover:underline"
          onClick={onClearFilters}
        >
          Clear filters
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <ResponsiveTable table={table} cards={cards} />
      {hasMore && (
        <p data-testid="software-group-has-more" className="text-xs text-muted-foreground">
          Showing the top 500 groups by risk — narrow the filters to see the rest.
        </p>
      )}
    </div>
  );
}

export default SoftwareGroupTable;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/web && pnpm vitest run src/components/vulnerabilities/`
Expected: PASS — new tests green, existing `VulnerabilityTable.test.tsx` green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/vulnerabilities/SeverityBadge.tsx apps/web/src/components/vulnerabilities/SoftwareGroupTable.tsx apps/web/src/components/vulnerabilities/SoftwareGroupTable.test.tsx apps/web/src/components/vulnerabilities/VulnerabilityTable.tsx
git commit -m "feat(web): software-grouped vulnerability work-queue table"
```

---

### Task 11: Extend `VulnerabilityTable` for the `#cves` tab (shared filters, EPSS/Patch/Status columns, row click)

**Files:**
- Modify: `apps/web/src/components/vulnerabilities/VulnerabilityTable.tsx`
- Test: `apps/web/src/components/vulnerabilities/VulnerabilityTable.test.tsx` (existing — update)

**Interfaces:**
- Consumes: Task 9's extended `FleetVulnerability` (`epssScore`, `patchAvailable`, `statuses`) and `VulnerabilityFilters` (`kevOnly`, `patchAvailable`); Task 10's `SeverityBadge` import (already done).
- Produces: `VulnerabilityTable({ filters, refreshKey, onSelectCve, onClearFilters }: { filters: VulnFleetFilters; refreshKey: number; onSelectCve: (cveId: string) => void; onClearFilters: () => void })`. The component's own severity `<select>` is REMOVED (the page-level filter bar owns filtering now). Testids kept: `vulnerability-row-<id>`, `vulnerability-table-empty`, `vulnerability-table-error`; new: `vulnerability-clear-filters`.

- [ ] **Step 1: Update the tests to the new contract (failing first)**

Rewrite `apps/web/src/components/vulnerabilities/VulnerabilityTable.test.tsx` to render with the new props. Keep its existing mock of `fetchVulnerabilities` and fixtures, extend fixture objects with `epssScore: 0.42, patchAvailable: true, statuses: ['open']`, and replace filter-select interactions with prop-driven assertions:

```tsx
const FILTERS: VulnFleetFilters = { search: '', severity: '', status: 'open', kevOnly: false, patchAvailable: false };

it('maps the shared filter bar onto API filters (search -> cve substring)', async () => {
  render(<VulnerabilityTable filters={{ ...FILTERS, search: '0001', severity: 'critical', kevOnly: true }} refreshKey={0} onSelectCve={() => {}} onClearFilters={() => {}} />);
  await vi.waitFor(() =>
    expect(api.fetchVulnerabilities).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'open', severity: 'critical', cve: '0001', kevOnly: true }),
    ),
  );
});

it('renders EPSS and Patch columns and fires onSelectCve on row click', async () => {
  const onSelect = vi.fn();
  render(<VulnerabilityTable filters={FILTERS} refreshKey={0} onSelectCve={onSelect} onClearFilters={() => {}} />);
  const desktop = within(await screen.findByTestId('responsive-table-desktop'));
  const row = desktop.getByTestId('vulnerability-row-v-1'); // adjust id to the existing fixture's id
  expect(row).toHaveTextContent('42.0%');  // EPSS 0.42
  expect(row).toHaveTextContent('Yes');    // patchAvailable
  fireEvent.click(row);
  expect(onSelect).toHaveBeenCalledWith('CVE-2026-0001'); // fixture's cveId
});

it('shows the Status column only when the status filter is not open', async () => {
  const { rerender } = render(<VulnerabilityTable filters={FILTERS} refreshKey={0} onSelectCve={() => {}} onClearFilters={() => {}} />);
  await screen.findByTestId('responsive-table-desktop');
  expect(screen.queryByText('Status')).toBeNull();
  rerender(<VulnerabilityTable filters={{ ...FILTERS, status: 'accepted' }} refreshKey={0} onSelectCve={() => {}} onClearFilters={() => {}} />);
  await vi.waitFor(() => expect(screen.getByText('Status')).toBeInTheDocument());
});
```

Keep/adapt the existing empty-state and error-state tests (empty state now also asserts the `vulnerability-clear-filters` button calls `onClearFilters`). Delete the old severity-select test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && pnpm vitest run src/components/vulnerabilities/VulnerabilityTable.test.tsx`
Expected: FAIL — component still has the old zero-prop signature.

- [ ] **Step 3: Implement**

Modify `VulnerabilityTable.tsx`:

1. New signature and fetch effect (replaces the `severity` state + old effect):

```tsx
export function VulnerabilityTable({
  filters,
  refreshKey,
  onSelectCve,
  onClearFilters,
}: {
  filters: VulnFleetFilters;
  refreshKey: number;
  onSelectCve: (cveId: string) => void;
  onClearFilters: () => void;
}) {
  const [items, setItems] = useState<FleetVulnerability[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const showStatusColumn = filters.status !== 'open';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const apiFilters: VulnerabilityFilters = { status: filters.status };
    if (filters.severity) apiFilters.severity = filters.severity;
    if (filters.search) apiFilters.cve = filters.search;
    if (filters.kevOnly) apiFilters.kevOnly = true;
    if (filters.patchAvailable) apiFilters.patchAvailable = true;
    fetchVulnerabilities(apiFilters)
      .then((res) => {
        if (!cancelled) setItems(res.items);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load vulnerabilities');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters, refreshKey]);
```

2. Remove the `SEVERITY_OPTIONS` constant and the whole filter `<label>` block from the JSX (the page-level filter bar replaces it).

3. Add a formatting helper and extend both the desktop table and mobile cards:

```tsx
function fmtEpss(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}
```

Desktop `<thead>` gains `<th className="px-4 py-3">EPSS</th>` and `<th className="px-4 py-3">Patch</th>` after the Risk column, and — only when `showStatusColumn` — `<th className="px-4 py-3">Status</th>` last. Rows become clickable:

```tsx
<tr
  key={v.id}
  data-testid={`vulnerability-row-${v.id}`}
  className="cursor-pointer transition hover:bg-muted/40"
  onClick={() => onSelectCve(v.cveId)}
>
```

with the matching new cells:

```tsx
<td className="px-4 py-3 text-sm tabular-nums">{fmtEpss(v.epssScore)}</td>
<td className="px-4 py-3 text-sm">{v.patchAvailable ? 'Yes' : '—'}</td>
{showStatusColumn && <td className="px-4 py-3 text-sm capitalize">{v.statuses.join(', ')}</td>}
```

Cards gain matching `CardField`s (`EPSS`, `Patch`, and `Status` when shown) and `DataCard` gets `onClick={() => onSelectCve(v.cveId)}`. The empty state adds the clear-filters button (same pattern as `SoftwareGroupTable`, testid `vulnerability-clear-filters`). Remember the `table`/`cards` `useMemo` deps must include `onSelectCve` and `showStatusColumn`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && pnpm vitest run src/components/vulnerabilities/VulnerabilityTable.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/vulnerabilities/VulnerabilityTable.tsx apps/web/src/components/vulnerabilities/VulnerabilityTable.test.tsx
git commit -m "feat(web): CVE tab — shared filters, EPSS/patch/status columns, row selection"
```

---

### Task 12: Page shell — stat cards, filter bar, hash tabs, Astro wiring

**Files:**
- Create: `apps/web/src/components/vulnerabilities/VulnFilterBar.tsx`
- Create: `apps/web/src/components/vulnerabilities/VulnerabilityFleetPage.tsx`
- Modify: `apps/web/src/pages/vulnerabilities.astro`
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (add page to `TARGET_GLOBS`, bump count 58 → 59)
- Test: `apps/web/src/components/vulnerabilities/VulnerabilityFleetPage.test.tsx`

**Interfaces:**
- Consumes: Task 9's `fetchVulnStats`, `FleetVulnStats`, `VulnFleetFilters`; Task 10's `SoftwareGroupTable`; Task 11's `VulnerabilityTable`; `SecurityStatCard` from `../security/SecurityStatCard`; lucide icons.
- Produces:
  - `VulnFilterBar({ filters, onChange }: { filters: VulnFleetFilters; onChange: (f: VulnFleetFilters) => void })` — testids `vuln-filter-search`, `vuln-filter-severity`, `vuln-filter-status`, `vuln-filter-kev`, `vuln-filter-patch`.
  - `VulnerabilityFleetPage()` — default export, the page island. Hash contract: `#software` (default) / `#cves` tabs; `#software/<encodeURIComponent(groupKey)>` and `#cves/<cveId>` select a drawer item (selection state is created HERE; the drawers render in Tasks 13–14). Exposes `refresh()` internally via a `refreshKey` counter.
  - `DEFAULT_FILTERS` export: `{ search: '', severity: '', status: 'open', kevOnly: false, patchAvailable: false }`.
  - Testids: `vuln-stat-critical`, `vuln-stat-kev`, `vuln-stat-patch-ready`, `vuln-stat-accepted-expiring`, `vuln-tab-software`, `vuln-tab-cves`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/vulnerabilities/VulnerabilityFleetPage.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../lib/api/vulnerabilities', () => ({
  fetchVulnStats: vi.fn(),
  fetchSoftwareGroups: vi.fn(),
  fetchVulnerabilities: vi.fn(),
}));

import * as api from '../../lib/api/vulnerabilities';
import VulnerabilityFleetPage from './VulnerabilityFleetPage';

describe('VulnerabilityFleetPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
    vi.mocked(api.fetchVulnStats).mockResolvedValue({
      criticalOpen: 3,
      kevCveCount: 2,
      kevDeviceCount: 5,
      patchReadyFindingCount: 12,
      acceptedExpiringSoon: 1,
    });
    vi.mocked(api.fetchSoftwareGroups).mockResolvedValue({ items: [], hasMore: false });
    vi.mocked(api.fetchVulnerabilities).mockResolvedValue({ items: [] });
  });

  it('defaults to the software tab and renders the four stat cards', async () => {
    render(<VulnerabilityFleetPage />);
    expect(await screen.findByTestId('vuln-stat-critical')).toHaveTextContent('3');
    expect(screen.getByTestId('vuln-stat-kev')).toHaveTextContent('2');
    expect(screen.getByTestId('vuln-stat-patch-ready')).toHaveTextContent('12');
    expect(screen.getByTestId('vuln-stat-accepted-expiring')).toHaveTextContent('1');
    await vi.waitFor(() => expect(api.fetchSoftwareGroups).toHaveBeenCalled());
    expect(api.fetchVulnerabilities).not.toHaveBeenCalled();
  });

  it('switches tabs via click and writes the hash', async () => {
    render(<VulnerabilityFleetPage />);
    fireEvent.click(await screen.findByTestId('vuln-tab-cves'));
    expect(window.location.hash).toBe('#cves');
    await vi.waitFor(() => expect(api.fetchVulnerabilities).toHaveBeenCalled());
  });

  it('honors a #cves deep link on mount', async () => {
    window.location.hash = '#cves';
    render(<VulnerabilityFleetPage />);
    await vi.waitFor(() => expect(api.fetchVulnerabilities).toHaveBeenCalled());
  });

  it('applies the matching filter when a stat card is clicked', async () => {
    render(<VulnerabilityFleetPage />);
    fireEvent.click(await screen.findByTestId('vuln-stat-critical'));
    await vi.waitFor(() =>
      expect(api.fetchSoftwareGroups).toHaveBeenLastCalledWith(
        expect.objectContaining({ severity: 'critical', status: 'open' }),
      ),
    );
    fireEvent.click(screen.getByTestId('vuln-stat-kev'));
    await vi.waitFor(() =>
      expect(api.fetchSoftwareGroups).toHaveBeenLastCalledWith(expect.objectContaining({ kevOnly: true })),
    );
    fireEvent.click(screen.getByTestId('vuln-stat-accepted-expiring'));
    await vi.waitFor(() =>
      expect(api.fetchSoftwareGroups).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'accepted' })),
    );
  });

  it('changes filters through the filter bar', async () => {
    render(<VulnerabilityFleetPage />);
    await screen.findByTestId('vuln-filter-severity');
    fireEvent.change(screen.getByTestId('vuln-filter-severity'), { target: { value: 'high' } });
    await vi.waitFor(() =>
      expect(api.fetchSoftwareGroups).toHaveBeenLastCalledWith(expect.objectContaining({ severity: 'high' })),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && pnpm vitest run src/components/vulnerabilities/VulnerabilityFleetPage.test.tsx`
Expected: FAIL — cannot resolve `./VulnerabilityFleetPage`.

- [ ] **Step 3: Implement the filter bar**

Create `apps/web/src/components/vulnerabilities/VulnFilterBar.tsx`:

```tsx
import type { VulnFleetFilters } from '../../lib/api/vulnerabilities';

const SEVERITY_OPTIONS = ['critical', 'high', 'medium', 'low'] as const;
const STATUS_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'mitigated', label: 'Mitigated' },
  { value: 'patched', label: 'Patched' },
  { value: 'all', label: 'All statuses' },
] as const;

const selectCls = 'rounded-md border bg-background px-2 py-1 text-sm';

export function VulnFilterBar({
  filters,
  onChange,
}: {
  filters: VulnFleetFilters;
  onChange: (f: VulnFleetFilters) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <input
        type="search"
        data-testid="vuln-filter-search"
        value={filters.search}
        onChange={(e) => onChange({ ...filters, search: e.target.value })}
        placeholder="Search software or CVE…"
        className="w-56 rounded-md border bg-background px-2 py-1 text-sm"
      />
      <label className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">Severity</span>
        <select
          data-testid="vuln-filter-severity"
          value={filters.severity}
          onChange={(e) => onChange({ ...filters, severity: e.target.value })}
          className={selectCls}
        >
          <option value="">All</option>
          {SEVERITY_OPTIONS.map((s) => (
            <option key={s} value={s}>{s[0]!.toUpperCase() + s.slice(1)}</option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">Status</span>
        <select
          data-testid="vuln-filter-status"
          value={filters.status}
          onChange={(e) => onChange({ ...filters, status: e.target.value })}
          className={selectCls}
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          data-testid="vuln-filter-kev"
          checked={filters.kevOnly}
          onChange={(e) => onChange({ ...filters, kevOnly: e.target.checked })}
          className="h-4 w-4 rounded border"
        />
        <span>KEV only</span>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          data-testid="vuln-filter-patch"
          checked={filters.patchAvailable}
          onChange={(e) => onChange({ ...filters, patchAvailable: e.target.checked })}
          className="h-4 w-4 rounded border"
        />
        <span>Patch available</span>
      </label>
    </div>
  );
}

export default VulnFilterBar;
```

- [ ] **Step 4: Implement the page shell**

Create `apps/web/src/components/vulnerabilities/VulnerabilityFleetPage.tsx` (hash pattern copied from `DeviceDetails.tsx:144-178`):

```tsx
import { useEffect, useState } from 'react';
import { AlertTriangle, Clock, ShieldAlert, Wrench } from 'lucide-react';

import SecurityStatCard from '../security/SecurityStatCard';
import { VulnFilterBar } from './VulnFilterBar';
import { SoftwareGroupTable } from './SoftwareGroupTable';
import { VulnerabilityTable } from './VulnerabilityTable';
import { fetchVulnStats, type FleetVulnStats, type VulnFleetFilters } from '../../lib/api/vulnerabilities';

type Tab = 'software' | 'cves';
const VALID_TABS: Tab[] = ['software', 'cves'];

export const DEFAULT_FILTERS: VulnFleetFilters = {
  search: '',
  severity: '',
  status: 'open',
  kevOnly: false,
  patchAvailable: false,
};

function getTabFromHash(): Tab {
  if (typeof window === 'undefined') return 'software';
  const hash = window.location.hash.replace('#', '').split('/')[0] ?? '';
  if (VALID_TABS.includes(hash as Tab)) return hash as Tab;
  return 'software';
}

function getSelectionFromHash(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const [tab, ...rest] = window.location.hash.replace('#', '').split('/');
  if (!VALID_TABS.includes(tab as Tab) || rest.length === 0) return undefined;
  // groupKey segments may themselves contain encoded slashes — rejoin.
  const raw = rest.join('/');
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

export function VulnerabilityFleetPage() {
  const [activeTab, setActiveTab] = useState<Tab>(getTabFromHash);
  const [selection, setSelection] = useState<string | undefined>(getSelectionFromHash);
  const [filters, setFilters] = useState<VulnFleetFilters>(DEFAULT_FILTERS);
  const [stats, setStats] = useState<FleetVulnStats | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const onHashChange = () => {
      setActiveTab(getTabFromHash());
      setSelection(getSelectionFromHash());
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchVulnStats()
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch(() => {
        /* stat cards are non-blocking; tables surface their own errors */
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const switchTab = (tab: Tab) => {
    window.location.hash = tab;
    setActiveTab(tab);
    setSelection(undefined);
  };

  const select = (tab: Tab, id: string) => {
    window.location.hash = `${tab}/${encodeURIComponent(id)}`;
    setActiveTab(tab);
    setSelection(id);
  };

  const closeSelection = () => {
    window.location.hash = activeTab;
    setSelection(undefined);
  };

  const refresh = () => setRefreshKey((k) => k + 1);
  const clearFilters = () => setFilters(DEFAULT_FILTERS);

  const tabCls = (tab: Tab) =>
    `border-b-2 px-3 py-2 text-sm font-medium transition ${
      activeTab === tab
        ? 'border-primary text-foreground'
        : 'border-transparent text-muted-foreground hover:text-foreground'
    }`;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-4">
        <button type="button" data-testid="vuln-stat-critical" className="text-left" onClick={() => setFilters({ ...DEFAULT_FILTERS, severity: 'critical' })}>
          <SecurityStatCard icon={AlertTriangle} label="Critical open" value={stats?.criticalOpen ?? '—'} variant="danger" />
        </button>
        <button type="button" data-testid="vuln-stat-kev" className="text-left" onClick={() => setFilters({ ...DEFAULT_FILTERS, kevOnly: true })}>
          <SecurityStatCard
            icon={ShieldAlert}
            label="KEV exposure"
            value={stats?.kevCveCount ?? '—'}
            variant="warning"
            detail={stats ? `${stats.kevDeviceCount} devices affected` : undefined}
          />
        </button>
        <button type="button" data-testid="vuln-stat-patch-ready" className="text-left" onClick={() => setFilters({ ...DEFAULT_FILTERS, patchAvailable: true })}>
          <SecurityStatCard icon={Wrench} label="Patch ready" value={stats?.patchReadyFindingCount ?? '—'} variant="success" detail="fixable right now" />
        </button>
        <button type="button" data-testid="vuln-stat-accepted-expiring" className="text-left" onClick={() => setFilters({ ...DEFAULT_FILTERS, status: 'accepted' })}>
          <SecurityStatCard icon={Clock} label="Accepted, expiring soon" value={stats?.acceptedExpiringSoon ?? '—'} detail="within 14 days" />
        </button>
      </div>

      <div className="flex items-center gap-1 border-b">
        <button type="button" data-testid="vuln-tab-software" className={tabCls('software')} onClick={() => switchTab('software')}>
          By software
        </button>
        <button type="button" data-testid="vuln-tab-cves" className={tabCls('cves')} onClick={() => switchTab('cves')}>
          By CVE
        </button>
      </div>

      <VulnFilterBar filters={filters} onChange={setFilters} />

      {activeTab === 'software' ? (
        <SoftwareGroupTable
          filters={filters}
          refreshKey={refreshKey}
          onSelectGroup={(groupKey) => select('software', groupKey)}
          onClearFilters={clearFilters}
        />
      ) : (
        <VulnerabilityTable
          filters={filters}
          refreshKey={refreshKey}
          onSelectCve={(cveId) => select('cves', cveId)}
          onClearFilters={clearFilters}
        />
      )}
      {/* Drawers mount here (Tasks 13–14): selection + activeTab decide which. */}
    </div>
  );
}

export default VulnerabilityFleetPage;
```

Note for Tasks 13–14: `selection`, `closeSelection`, and `refresh` are defined here but only consumed once the drawers mount at the marked spot. If `astro check`/tsc flags them as unused in this task's commit, add `void selection;\n  void closeSelection;` immediately above the `return` and delete those two lines in Task 13 when the drawer wiring starts using them.

- [ ] **Step 5: Update the Astro page**

Replace the island in `apps/web/src/pages/vulnerabilities.astro`:

```astro
---
import DashboardLayout from '../layouts/DashboardLayout.astro';
import VulnerabilityFleetPage from '../components/vulnerabilities/VulnerabilityFleetPage';
---

<DashboardLayout title="Vulnerabilities">
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-semibold">Vulnerabilities</h1>
      <p class="text-sm text-muted-foreground">
        Fleet-wide CVE exposure grouped into remediation actions — triage, remediate, accept, or ticket from here.
      </p>
    </div>
    <VulnerabilityFleetPage client:load />
  </div>
</DashboardLayout>
```

- [ ] **Step 6: Register in the no-silent-mutations targeted set**

In `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`: add `'src/components/vulnerabilities/VulnerabilityFleetPage.tsx',` to `TARGET_GLOBS` (keep the array's ordering convention) and change the count assertion `expect(absoluteFiles.length).toBe(58)` → `.toBe(59)`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd apps/web && pnpm vitest run src/components/vulnerabilities/ src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/vulnerabilities/VulnFilterBar.tsx apps/web/src/components/vulnerabilities/VulnerabilityFleetPage.tsx apps/web/src/components/vulnerabilities/VulnerabilityFleetPage.test.tsx apps/web/src/pages/vulnerabilities.astro apps/web/src/lib/__tests__/no-silent-mutations.test.ts
git commit -m "feat(web): vulnerabilities fleet page shell — stat cards, filter bar, hash tabs"
```

---

### Task 13: Bulk action modal + software-group drawer (remediate / accept / mitigate)

**Files:**
- Create: `apps/web/src/components/vulnerabilities/VulnBulkActionModal.tsx`
- Create: `apps/web/src/components/vulnerabilities/SoftwareGroupDrawer.tsx`
- Modify: `apps/web/src/components/vulnerabilities/VulnerabilityFleetPage.tsx` (mount the drawer)
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (add 2 files, 59 → 61)
- Test: `apps/web/src/components/vulnerabilities/SoftwareGroupDrawer.test.tsx`

**Interfaces:**
- Consumes: Task 8's `Drawer`; Task 9's `fetchSoftwareGroupDetail`, `remediateVuln`, `bulkAcceptVulnRisk`, `bulkMitigateVulns`, `SoftwareGroupDetail`; `usePermissions` from `../../lib/permissions`; `handleActionError` from `../../lib/runAction`; `SeverityBadge`.
- Produces:
  - `VulnBulkActionModal({ kind, count, busy, onCancel, onSubmit }: { kind: 'accept' | 'mitigate'; count: number; busy: boolean; onCancel: () => void; onSubmit: (payload: { reason?: string; acceptedUntil?: string; note?: string }) => void })` — testids `vuln-bulk-modal`, `vuln-bulk-text`, `vuln-bulk-until`, `vuln-bulk-submit` (reused by Task 14).
  - `SoftwareGroupDrawer({ groupKey, onClose, onActionComplete, onSelectCve }: { groupKey: string; onClose: () => void; onActionComplete: () => void; onSelectCve: (cveId: string) => void })` — testids `vuln-software-drawer`, `vuln-drawer-error`, `vuln-drawer-retry`, `vuln-finding-check-<deviceVulnerabilityId>`, `vuln-drawer-cve-<cveId>`, `vuln-action-remediate`, `vuln-action-accept`, `vuln-action-mitigate`, `vuln-ticket-chip-<ticketId>`. (The `vuln-action-ticket` button is added in Task 15.)

- [ ] **Step 1: Write the `VulnBulkActionModal` component**

Create `apps/web/src/components/vulnerabilities/VulnBulkActionModal.tsx` — same structure/classes as the device tab's `VulnActionModal` (`DeviceVulnerabilitiesTab.tsx:378-448`) with a count in the title and new testids:

```tsx
import { useState } from 'react';

const BTN =
  'inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50';

export function VulnBulkActionModal({
  kind,
  count,
  busy,
  onCancel,
  onSubmit,
}: {
  kind: 'accept' | 'mitigate';
  count: number;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (payload: { reason?: string; acceptedUntil?: string; note?: string }) => void;
}) {
  const [text, setText] = useState('');
  const [until, setUntil] = useState('');
  const isAccept = kind === 'accept';
  const canSubmit = isAccept ? text.trim().length > 0 && until.length > 0 : text.trim().length > 0;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-lg border bg-card p-5 shadow-lg" data-testid="vuln-bulk-modal">
        <h3 className="text-base font-semibold">
          {isAccept ? 'Accept risk' : 'Mark mitigated'} — {count} finding{count === 1 ? '' : 's'}
        </h3>
        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="text-muted-foreground">{isAccept ? 'Reason' : 'Mitigation note'}</span>
            <textarea
              data-testid="vuln-bulk-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
            />
          </label>
          {isAccept && (
            <label className="block text-sm">
              <span className="text-muted-foreground">Accepted until</span>
              <input
                type="date"
                data-testid="vuln-bulk-until"
                value={until}
                min={(() => {
                  const d = new Date();
                  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                })()}
                onChange={(e) => setUntil(e.target.value)}
                className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
              />
            </label>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={BTN} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            data-testid="vuln-bulk-submit"
            className={`${BTN} bg-primary text-primary-foreground hover:bg-primary/90`}
            disabled={!canSubmit || busy}
            onClick={() =>
              onSubmit(
                isAccept
                  ? { reason: text.trim(), acceptedUntil: new Date(`${until}T00:00:00Z`).toISOString() }
                  : { note: text.trim() },
              )
            }
          >
            {isAccept ? 'Accept risk' : 'Mark mitigated'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default VulnBulkActionModal;
```

Note the `z-[60]` — the modal must stack above the drawer's `z-50`.

- [ ] **Step 2: Write the failing drawer tests**

Create `apps/web/src/components/vulnerabilities/SoftwareGroupDrawer.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

type Perm = { resource: string; action: string };
const authState = vi.hoisted(() => ({ permissions: [{ resource: '*', action: '*' }] as Perm[] }));

vi.mock('../../stores/auth', () => ({
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Perm[] } }) => unknown) =>
      selector({ user: { permissions: authState.permissions } }),
    { getState: () => ({ tokens: null }) },
  ),
}));

vi.mock('../../lib/api/vulnerabilities', () => ({
  fetchSoftwareGroupDetail: vi.fn(),
  remediateVuln: vi.fn(),
  bulkAcceptVulnRisk: vi.fn(),
  bulkMitigateVulns: vi.fn(),
  createVulnTicket: vi.fn(),
}));

import * as api from '../../lib/api/vulnerabilities';
import { SoftwareGroupDrawer } from './SoftwareGroupDrawer';
import type { SoftwareGroupDetail } from '../../lib/api/vulnerabilities';

const DETAIL: SoftwareGroupDetail = {
  group: {
    groupKey: 'sw:google chrome|google llc',
    kind: 'software',
    name: 'Google Chrome',
    vendor: 'Google LLC',
    versions: ['126.0'],
    deviceCount: 2,
    cveCount: 1,
    cveIds: ['CVE-2026-0001'],
    worstSeverity: 'critical',
    maxRiskScore: 95,
    kevCveCount: 1,
    maxEpss: 0.9,
    patchReadyFindingCount: 1,
    patchReadyDeviceCount: 1,
    ticketIds: [],
  },
  cves: [
    {
      cveId: 'CVE-2026-0001',
      vulnerabilityId: 'v-1',
      severity: 'critical',
      cvssScore: 9.1,
      epssScore: 0.9,
      knownExploited: true,
      patchAvailable: true,
      maxRiskScore: 95,
    },
  ],
  findings: [
    {
      deviceVulnerabilityId: 'dv-1',
      deviceId: 'dev-1',
      deviceName: 'WS-01',
      orgId: 'org-1',
      orgName: 'Acme',
      cveId: 'CVE-2026-0001',
      status: 'open',
      patchAvailable: true,
      riskScore: 95,
      detectedAt: '2026-06-01T00:00:00.000Z',
      ticketId: null,
    },
    {
      deviceVulnerabilityId: 'dv-2',
      deviceId: 'dev-2',
      deviceName: 'WS-02',
      orgId: 'org-1',
      orgName: 'Acme',
      cveId: 'CVE-2026-0001',
      status: 'accepted',
      patchAvailable: false,
      riskScore: 90,
      detectedAt: '2026-06-01T00:00:00.000Z',
      ticketId: 't-9',
    },
  ],
};

describe('SoftwareGroupDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.permissions = [{ resource: '*', action: '*' }];
    vi.mocked(api.fetchSoftwareGroupDetail).mockResolvedValue(DETAIL);
  });

  it('renders header, CVE list, and device findings with open findings pre-selected', async () => {
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} />,
    );
    expect(await screen.findByTestId('vuln-software-drawer')).toHaveTextContent('Google Chrome');
    expect(screen.getByTestId('vuln-drawer-cve-CVE-2026-0001')).toBeInTheDocument();
    expect(screen.getByTestId('vuln-finding-check-dv-1')).toBeChecked();       // open — pre-selected
    expect(screen.getByTestId('vuln-finding-check-dv-2')).not.toBeChecked();   // accepted — not pre-selected
    expect(screen.getByTestId('vuln-ticket-chip-t-9')).toBeInTheDocument();
  });

  it('accept-risk flow: opens modal, submits selected ids, reloads and notifies', async () => {
    vi.mocked(api.bulkAcceptVulnRisk).mockResolvedValue({ success: true, succeeded: 1, skipped: [] });
    const onActionComplete = vi.fn();
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={onActionComplete} onSelectCve={() => {}} />,
    );
    fireEvent.click(await screen.findByTestId('vuln-action-accept'));
    fireEvent.change(screen.getByTestId('vuln-bulk-text'), { target: { value: 'compensating control' } });
    fireEvent.change(screen.getByTestId('vuln-bulk-until'), { target: { value: '2030-01-01' } });
    fireEvent.click(screen.getByTestId('vuln-bulk-submit'));
    await waitFor(() =>
      expect(api.bulkAcceptVulnRisk).toHaveBeenCalledWith(['dv-1'], {
        reason: 'compensating control',
        acceptedUntil: new Date('2030-01-01T00:00:00Z').toISOString(),
      }),
    );
    await waitFor(() => expect(onActionComplete).toHaveBeenCalled());
    expect(api.fetchSoftwareGroupDetail).toHaveBeenCalledTimes(2); // initial + reload
  });

  it('remediate acts on the selected findings', async () => {
    vi.mocked(api.remediateVuln).mockResolvedValue({ scheduled: 1, skipped: [] });
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} />,
    );
    fireEvent.click(await screen.findByTestId('vuln-action-remediate'));
    await waitFor(() => expect(api.remediateVuln).toHaveBeenCalledWith(['dv-1']));
  });

  it('hides permission-gated actions', async () => {
    authState.permissions = [{ resource: 'devices', action: 'read' }];
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} />,
    );
    await screen.findByTestId('vuln-software-drawer');
    expect(screen.queryByTestId('vuln-action-remediate')).toBeNull();
    expect(screen.queryByTestId('vuln-action-accept')).toBeNull();
    expect(screen.queryByTestId('vuln-action-mitigate')).toBeNull();
  });

  it('shows an inline retry on fetch failure', async () => {
    vi.mocked(api.fetchSoftwareGroupDetail).mockRejectedValueOnce(new Error('boom'));
    render(
      <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} />,
    );
    expect(await screen.findByTestId('vuln-drawer-error')).toHaveTextContent('boom');
    fireEvent.click(screen.getByTestId('vuln-drawer-retry'));
    expect(await screen.findByTestId('vuln-finding-check-dv-1')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/web && pnpm vitest run src/components/vulnerabilities/SoftwareGroupDrawer.test.tsx`
Expected: FAIL — cannot resolve `./SoftwareGroupDrawer`.

- [ ] **Step 4: Implement the drawer**

Create `apps/web/src/components/vulnerabilities/SoftwareGroupDrawer.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';

import { Drawer } from '../shared/Drawer';
import { SeverityBadge } from './SeverityBadge';
import { VulnBulkActionModal } from './VulnBulkActionModal';
import { usePermissions } from '../../lib/permissions';
import { handleActionError } from '../../lib/runAction';
import {
  bulkAcceptVulnRisk,
  bulkMitigateVulns,
  fetchSoftwareGroupDetail,
  remediateVuln,
  type SoftwareGroupDetail,
} from '../../lib/api/vulnerabilities';

const ACTION_BTN =
  'inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50';

function fmtEpss(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

export function SoftwareGroupDrawer({
  groupKey,
  onClose,
  onActionComplete,
  onSelectCve,
}: {
  groupKey: string;
  onClose: () => void;
  onActionComplete: () => void;
  onSelectCve: (cveId: string) => void;
}) {
  const [detail, setDetail] = useState<SoftwareGroupDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'remediate' | 'accept' | 'mitigate' | 'ticket' | null>(null);
  const [modal, setModal] = useState<'accept' | 'mitigate' | null>(null);

  const { can } = usePermissions();
  const canRemediate = can('devices', 'execute');
  const canAcceptRisk = can('vulnerabilities', 'accept_risk');
  const canMitigate = can('devices', 'write');

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await fetchSoftwareGroupDetail(groupKey);
      setDetail(d);
      // Open findings are the actionable ones — pre-select them (spec: all selected by default).
      setSelected(new Set(d.findings.filter((f) => f.status === 'open').map((f) => f.deviceVulnerabilityId)));
    } catch (err) {
      setDetail(null);
      setError(err instanceof Error ? err.message : 'Failed to load software group');
    }
  }, [groupKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedIds = [...selected];

  const runBulk = useCallback(
    async (kind: 'remediate' | 'accept' | 'mitigate' | 'ticket', action: () => Promise<unknown>, fallback: string) => {
      if (busy || selectedIds.length === 0) return;
      setBusy(kind);
      try {
        await action();
        setModal(null);
        await load();
        onActionComplete();
      } catch (err) {
        handleActionError(err, fallback);
      } finally {
        setBusy(null);
      }
    },
    // selectedIds is derived from `selected`; depend on the source set.
    [busy, selected, load, onActionComplete],
  );

  const title = detail ? (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate">{detail.group.name}</span>
      <SeverityBadge severity={detail.group.worstSeverity} />
      {detail.group.kevCveCount > 0 && (
        <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
          KEV
        </span>
      )}
    </span>
  ) : (
    'Software group'
  );

  return (
    <Drawer open onClose={onClose} title={title} width="max-w-xl" dataTestId="vuln-software-drawer" closeDisabled={busy !== null}>
      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {error && (
          <div
            data-testid="vuln-drawer-error"
            className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300"
          >
            <p>{error}</p>
            <button type="button" data-testid="vuln-drawer-retry" className="mt-2 text-sm font-medium underline" onClick={() => void load()}>
              Retry
            </button>
          </div>
        )}

        {detail && (
          <>
            <div className="text-sm text-muted-foreground">
              {[detail.group.vendor, `${detail.group.deviceCount} devices`, `max risk ${detail.group.maxRiskScore ?? '—'}`]
                .filter(Boolean)
                .join(' · ')}
            </div>

            {detail.group.ticketIds.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {detail.group.ticketIds.map((tid) => (
                  <a
                    key={tid}
                    href={`/tickets#${tid}`}
                    data-testid={`vuln-ticket-chip-${tid}`}
                    className="inline-flex items-center rounded-full border bg-muted/40 px-2.5 py-1 text-xs font-medium hover:bg-muted"
                  >
                    Ticket · {tid.slice(0, 8)}
                  </a>
                ))}
              </div>
            )}

            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">CVEs ({detail.cves.length})</h3>
              <ul className="mt-2 divide-y rounded-md border">
                {detail.cves.map((cve) => (
                  <li key={cve.cveId}>
                    <button
                      type="button"
                      data-testid={`vuln-drawer-cve-${cve.cveId}`}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted/40"
                      onClick={() => onSelectCve(cve.cveId)}
                    >
                      <span className="font-medium">{cve.cveId}</span>
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        <SeverityBadge severity={cve.severity} />
                        <span className="tabular-nums">CVSS {cve.cvssScore ?? '—'}</span>
                        <span className="tabular-nums">EPSS {fmtEpss(cve.epssScore)}</span>
                        {cve.knownExploited && <span className="font-semibold text-red-600">KEV</span>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Devices ({detail.findings.length} findings)
              </h3>
              <ul className="mt-2 divide-y rounded-md border">
                {detail.findings.map((f) => (
                  <li key={f.deviceVulnerabilityId} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      data-testid={`vuln-finding-check-${f.deviceVulnerabilityId}`}
                      checked={selected.has(f.deviceVulnerabilityId)}
                      onChange={() => toggle(f.deviceVulnerabilityId)}
                      className="h-4 w-4 rounded border"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{f.deviceName}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {[f.orgName, f.cveId].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span className="text-xs capitalize text-muted-foreground">{f.status}</span>
                    <span className="text-xs">{f.patchAvailable ? 'Patch' : '—'}</span>
                    {f.ticketId && (
                      <a href={`/tickets#${f.ticketId}`} data-testid={`vuln-ticket-chip-${f.ticketId}`} className="text-xs underline">
                        Ticket
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>

      {detail && (
        <div className="flex flex-wrap items-center gap-2 border-t px-5 py-3">
          <span className="mr-auto text-xs text-muted-foreground">{selectedIds.length} selected</span>
          {canRemediate && (
            <button
              type="button"
              data-testid="vuln-action-remediate"
              className={`${ACTION_BTN} bg-primary text-primary-foreground hover:bg-primary/90`}
              disabled={busy !== null || selectedIds.length === 0}
              onClick={() => void runBulk('remediate', () => remediateVuln(selectedIds), 'Failed to schedule remediation')}
            >
              Remediate
            </button>
          )}
          {canAcceptRisk && (
            <button
              type="button"
              data-testid="vuln-action-accept"
              className={ACTION_BTN}
              disabled={busy !== null || selectedIds.length === 0}
              onClick={() => setModal('accept')}
            >
              Accept risk
            </button>
          )}
          {canMitigate && (
            <button
              type="button"
              data-testid="vuln-action-mitigate"
              className={ACTION_BTN}
              disabled={busy !== null || selectedIds.length === 0}
              onClick={() => setModal('mitigate')}
            >
              Mitigate
            </button>
          )}
        </div>
      )}

      {modal && (
        <VulnBulkActionModal
          kind={modal}
          count={selectedIds.length}
          busy={busy !== null}
          onCancel={() => setModal(null)}
          onSubmit={(payload) => {
            if (modal === 'accept') {
              void runBulk(
                'accept',
                () => bulkAcceptVulnRisk(selectedIds, { reason: payload.reason ?? '', acceptedUntil: payload.acceptedUntil ?? '' }),
                'Failed to accept risk',
              );
            } else {
              void runBulk('mitigate', () => bulkMitigateVulns(selectedIds, { note: payload.note ?? '' }), 'Failed to mitigate');
            }
          }}
        />
      )}
    </Drawer>
  );
}

export default SoftwareGroupDrawer;
```

- [ ] **Step 5: Mount the drawer in the page**

In `VulnerabilityFleetPage.tsx`, add the import and replace the `{/* Drawers mount here ... */}` comment with:

```tsx
      {selection && activeTab === 'software' && (
        <SoftwareGroupDrawer
          groupKey={selection}
          onClose={closeSelection}
          onActionComplete={refresh}
          onSelectCve={(cveId) => select('cves', cveId)}
        />
      )}
```

- [ ] **Step 6: Register in the no-silent-mutations targeted set**

Add `'src/components/vulnerabilities/SoftwareGroupDrawer.tsx',` and `'src/components/vulnerabilities/VulnBulkActionModal.tsx',` to `TARGET_GLOBS`; bump the count 59 → 61.

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd apps/web && pnpm vitest run src/components/vulnerabilities/ src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/vulnerabilities/VulnBulkActionModal.tsx apps/web/src/components/vulnerabilities/SoftwareGroupDrawer.tsx apps/web/src/components/vulnerabilities/SoftwareGroupDrawer.test.tsx apps/web/src/components/vulnerabilities/VulnerabilityFleetPage.tsx apps/web/src/lib/__tests__/no-silent-mutations.test.ts
git commit -m "feat(web): software-group drawer with bulk remediate/accept/mitigate"
```

---

### Task 14: CVE drawer (details, affected devices, actions, reopen)

**Files:**
- Create: `apps/web/src/components/vulnerabilities/CveDrawer.tsx`
- Modify: `apps/web/src/components/vulnerabilities/VulnerabilityFleetPage.tsx` (mount it)
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (61 → 62)
- Test: `apps/web/src/components/vulnerabilities/CveDrawer.test.tsx`

**Interfaces:**
- Consumes: Task 8's `Drawer`; Task 9's `fetchCveDevices`, `CveDevicesPayload`, `remediateVuln`, `bulkAcceptVulnRisk`, `bulkMitigateVulns`, `reopenVuln` (existing); Task 13's `VulnBulkActionModal`; `usePermissions`, `handleActionError`, `SeverityBadge`.
- Produces: `CveDrawer({ cveId, onClose, onActionComplete }: { cveId: string; onClose: () => void; onActionComplete: () => void })` — testids `vuln-cve-drawer`, `vuln-cve-meta`, `vuln-cve-reference-<index>`, `vuln-finding-check-<id>`, `vuln-action-remediate`, `vuln-action-accept`, `vuln-action-mitigate`, `vuln-reopen-<deviceVulnerabilityId>`, `vuln-drawer-error`, `vuln-drawer-retry`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/vulnerabilities/CveDrawer.test.tsx` (same auth/API mock scaffold as Task 13's test — mock `fetchCveDevices`, `remediateVuln`, `bulkAcceptVulnRisk`, `bulkMitigateVulns`, `reopenVuln`):

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

type Perm = { resource: string; action: string };
const authState = vi.hoisted(() => ({ permissions: [{ resource: '*', action: '*' }] as Perm[] }));

vi.mock('../../stores/auth', () => ({
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Perm[] } }) => unknown) =>
      selector({ user: { permissions: authState.permissions } }),
    { getState: () => ({ tokens: null }) },
  ),
}));

vi.mock('../../lib/api/vulnerabilities', () => ({
  fetchCveDevices: vi.fn(),
  remediateVuln: vi.fn(),
  bulkAcceptVulnRisk: vi.fn(),
  bulkMitigateVulns: vi.fn(),
  reopenVuln: vi.fn(),
  createVulnTicket: vi.fn(),
}));

import * as api from '../../lib/api/vulnerabilities';
import { CveDrawer } from './CveDrawer';
import type { CveDevicesPayload } from '../../lib/api/vulnerabilities';

const PAYLOAD: CveDevicesPayload = {
  cve: {
    cveId: 'CVE-2026-0001',
    description: 'Heap overflow in the render pipeline.',
    references: ['https://example.test/advisory'],
    cvssVersion: '3.1',
    cvssVector: 'CVSS:3.1/AV:N/AC:L',
    cvssScore: 9.1,
    epssScore: 0.42,
    knownExploited: true,
    patchAvailable: true,
    severity: 'critical',
    publishedAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-02-01T00:00:00.000Z',
  },
  findings: [
    {
      deviceVulnerabilityId: 'dv-1',
      deviceId: 'dev-1',
      deviceName: 'WS-01',
      orgId: 'org-1',
      orgName: 'Acme',
      cveId: 'CVE-2026-0001',
      status: 'open',
      patchAvailable: true,
      riskScore: 95,
      detectedAt: '2026-06-01T00:00:00.000Z',
      ticketId: null,
    },
    {
      deviceVulnerabilityId: 'dv-2',
      deviceId: 'dev-2',
      deviceName: 'WS-02',
      orgId: 'org-1',
      orgName: 'Acme',
      cveId: 'CVE-2026-0001',
      status: 'accepted',
      patchAvailable: true,
      riskScore: 95,
      detectedAt: '2026-06-01T00:00:00.000Z',
      ticketId: null,
    },
  ],
};

describe('CveDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.permissions = [{ resource: '*', action: '*' }];
    vi.mocked(api.fetchCveDevices).mockResolvedValue(PAYLOAD);
  });

  it('renders CVE metadata, vector, EPSS, KEV, and reference links', async () => {
    render(<CveDrawer cveId="CVE-2026-0001" onClose={() => {}} onActionComplete={() => {}} />);
    const meta = await screen.findByTestId('vuln-cve-meta');
    expect(meta).toHaveTextContent('Heap overflow');
    expect(meta).toHaveTextContent('CVSS:3.1/AV:N/AC:L');
    expect(meta).toHaveTextContent('42.0%');
    expect(meta).toHaveTextContent('KEV');
    expect(screen.getByTestId('vuln-cve-reference-0')).toHaveAttribute('href', 'https://example.test/advisory');
  });

  it('shows Reopen only on accepted/mitigated findings and calls the API', async () => {
    vi.mocked(api.reopenVuln).mockResolvedValue(undefined as never);
    const onActionComplete = vi.fn();
    render(<CveDrawer cveId="CVE-2026-0001" onClose={() => {}} onActionComplete={onActionComplete} />);
    await screen.findByTestId('vuln-cve-drawer');
    expect(screen.queryByTestId('vuln-reopen-dv-1')).toBeNull();      // open finding
    fireEvent.click(screen.getByTestId('vuln-reopen-dv-2'));          // accepted finding
    await waitFor(() => expect(api.reopenVuln).toHaveBeenCalledWith('dv-2'));
    await waitFor(() => expect(onActionComplete).toHaveBeenCalled());
  });

  it('hides Reopen without vulnerabilities:accept_risk', async () => {
    authState.permissions = [{ resource: 'devices', action: 'read' }];
    render(<CveDrawer cveId="CVE-2026-0001" onClose={() => {}} onActionComplete={() => {}} />);
    await screen.findByTestId('vuln-cve-drawer');
    expect(screen.queryByTestId('vuln-reopen-dv-2')).toBeNull();
  });

  it('runs bulk accept-risk against the selected findings scoped to this CVE', async () => {
    vi.mocked(api.bulkAcceptVulnRisk).mockResolvedValue({ success: true, succeeded: 1, skipped: [] });
    render(<CveDrawer cveId="CVE-2026-0001" onClose={() => {}} onActionComplete={() => {}} />);
    fireEvent.click(await screen.findByTestId('vuln-action-accept'));
    fireEvent.change(screen.getByTestId('vuln-bulk-text'), { target: { value: 'ok' } });
    fireEvent.change(screen.getByTestId('vuln-bulk-until'), { target: { value: '2030-01-01' } });
    fireEvent.click(screen.getByTestId('vuln-bulk-submit'));
    await waitFor(() => expect(api.bulkAcceptVulnRisk).toHaveBeenCalledWith(['dv-1'], expect.anything()));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && pnpm vitest run src/components/vulnerabilities/CveDrawer.test.tsx`
Expected: FAIL — cannot resolve `./CveDrawer`.

- [ ] **Step 3: Implement**

Create `apps/web/src/components/vulnerabilities/CveDrawer.tsx` by COPYING `SoftwareGroupDrawer.tsx` (Task 13, same directory) as the starting point — keep its load/retry state machine, open-findings-preselected `selected` set, `runBulk` helper, action bar, and `VulnBulkActionModal` wiring intact — then apply these differences:

- Fetch: `fetchCveDevices(cveId)`; state `payload: CveDevicesPayload | null`.
- Title: `<span className="flex items-center gap-2"><span>{cveId}</span>{payload && <SeverityBadge severity={payload.cve.severity} />}</span>`.
- Metadata section (before the devices list):

```tsx
{payload && (
  <section data-testid="vuln-cve-meta" className="space-y-2 text-sm">
    <p>{payload.cve.description}</p>
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
      <dt className="text-muted-foreground">CVSS {payload.cve.cvssVersion ?? ''}</dt>
      <dd className="tabular-nums">{payload.cve.cvssScore ?? '—'}</dd>
      <dt className="text-muted-foreground">Vector</dt>
      <dd className="break-all">{payload.cve.cvssVector ?? '—'}</dd>
      <dt className="text-muted-foreground">EPSS</dt>
      <dd className="tabular-nums">{fmtEpss(payload.cve.epssScore)}</dd>
      <dt className="text-muted-foreground">Known exploited</dt>
      <dd>{payload.cve.knownExploited ? 'KEV' : 'No'}</dd>
      <dt className="text-muted-foreground">Published</dt>
      <dd>{payload.cve.publishedAt ? new Date(payload.cve.publishedAt).toLocaleDateString() : '—'}</dd>
      <dt className="text-muted-foreground">Modified</dt>
      <dd>{payload.cve.modifiedAt ? new Date(payload.cve.modifiedAt).toLocaleDateString() : '—'}</dd>
    </dl>
    {referenceUrls(payload.cve.references).length > 0 && (
      <ul className="space-y-1 text-xs">
        {referenceUrls(payload.cve.references).map((url, i) => (
          <li key={url}>
            <a data-testid={`vuln-cve-reference-${i}`} href={url} target="_blank" rel="noreferrer" className="break-all text-primary hover:underline">
              {url}
            </a>
          </li>
        ))}
      </ul>
    )}
  </section>
)}
```

with the defensive reference normalizer (the catalog stores `references` as source-dependent jsonb):

```tsx
function referenceUrls(references: unknown): string[] {
  if (!Array.isArray(references)) return [];
  return references
    .map((r) => (typeof r === 'string' ? r : typeof r === 'object' && r !== null && 'url' in r ? String((r as { url: unknown }).url) : null))
    .filter((u): u is string => typeof u === 'string' && u.startsWith('http'))
    .slice(0, 10);
}
```

- Devices list: same row markup as the group drawer minus the CVE id line, PLUS a per-finding Reopen button:

```tsx
{canAcceptRisk && (f.status === 'accepted' || f.status === 'mitigated') && (
  <button
    type="button"
    data-testid={`vuln-reopen-${f.deviceVulnerabilityId}`}
    className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
    disabled={busy !== null}
    onClick={() => void onReopen(f.deviceVulnerabilityId)}
  >
    Reopen
  </button>
)}
```

with the handler:

```tsx
const onReopen = useCallback(
  async (id: string) => {
    if (busy) return;
    setBusy('reopen');
    try {
      await reopenVuln(id);
      await load();
      onActionComplete();
    } catch (err) {
      handleActionError(err, 'Failed to reopen finding');
    } finally {
      setBusy(null);
    }
  },
  [busy, load, onActionComplete],
);
```

(`busy` union gains `'reopen'`.) Action bar identical to the group drawer (`vuln-action-remediate` / `vuln-action-accept` / `vuln-action-mitigate`, same permission gates), acting on the drawer's selected finding ids. `dataTestId="vuln-cve-drawer"`, `width="max-w-xl"`.

- [ ] **Step 4: Mount in the page + targeted set**

In `VulnerabilityFleetPage.tsx`, next to the software drawer:

```tsx
      {selection && activeTab === 'cves' && (
        <CveDrawer cveId={selection} onClose={closeSelection} onActionComplete={refresh} />
      )}
```

Add `'src/components/vulnerabilities/CveDrawer.tsx',` to `TARGET_GLOBS`; bump 61 → 62.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/web && pnpm vitest run src/components/vulnerabilities/ src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/vulnerabilities/CveDrawer.tsx apps/web/src/components/vulnerabilities/CveDrawer.test.tsx apps/web/src/components/vulnerabilities/VulnerabilityFleetPage.tsx apps/web/src/lib/__tests__/no-silent-mutations.test.ts
git commit -m "feat(web): CVE drawer with metadata, device selection, actions, and reopen"
```

---

### Task 15: Create-ticket modal + wiring into both drawers

**Files:**
- Create: `apps/web/src/components/vulnerabilities/CreateVulnTicketModal.tsx`
- Modify: `apps/web/src/components/vulnerabilities/SoftwareGroupDrawer.tsx`, `apps/web/src/components/vulnerabilities/CveDrawer.tsx`
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (62 → 63)
- Test: `apps/web/src/components/vulnerabilities/CreateVulnTicketModal.test.tsx` + extend `SoftwareGroupDrawer.test.tsx`

**Interfaces:**
- Consumes: Task 9's `createVulnTicket`, `GroupFinding`; `usePermissions` (`can('tickets', 'write')`).
- Produces: `CreateVulnTicketModal({ findings, defaultTitle, busy, onCancel, onSubmit }: { findings: GroupFinding[]; defaultTitle: string; busy: boolean; onCancel: () => void; onSubmit: (payload: { title: string; description: string; priority: 'low' | 'normal' | 'high' | 'urgent' }) => void })` — testids `vuln-ticket-modal`, `vuln-ticket-title`, `vuln-ticket-description`, `vuln-ticket-priority`, `vuln-ticket-submit`, `vuln-ticket-cross-org-note`. Both drawers gain a `vuln-action-ticket` button (visible with `tickets:write`).

- [ ] **Step 1: Write the failing modal tests**

Create `apps/web/src/components/vulnerabilities/CreateVulnTicketModal.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CreateVulnTicketModal } from './CreateVulnTicketModal';
import type { GroupFinding } from '../../lib/api/vulnerabilities';

function finding(overrides: Partial<GroupFinding> = {}): GroupFinding {
  return {
    deviceVulnerabilityId: 'dv-1',
    deviceId: 'dev-1',
    deviceName: 'WS-01',
    orgId: 'org-1',
    orgName: 'Acme',
    cveId: 'CVE-2026-0001',
    status: 'open',
    patchAvailable: true,
    riskScore: 95,
    detectedAt: '2026-06-01T00:00:00.000Z',
    ticketId: null,
    ...overrides,
  };
}

describe('CreateVulnTicketModal', () => {
  it('pre-fills the title and a description listing CVEs and devices', () => {
    render(
      <CreateVulnTicketModal
        findings={[finding(), finding({ deviceVulnerabilityId: 'dv-2', deviceId: 'dev-2', deviceName: 'WS-02', cveId: 'CVE-2026-0002' })]}
        defaultTitle="Remediate Google Chrome"
        busy={false}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByTestId('vuln-ticket-title')).toHaveValue('Remediate Google Chrome');
    const description = screen.getByTestId('vuln-ticket-description');
    expect(description).toHaveValue(expect.stringContaining('CVE-2026-0001') as unknown as string);
    expect((description as HTMLTextAreaElement).value).toContain('WS-02');
  });

  it('warns when the selection spans multiple organizations', () => {
    render(
      <CreateVulnTicketModal
        findings={[finding(), finding({ deviceVulnerabilityId: 'dv-2', orgId: 'org-2', orgName: 'Beta' })]}
        defaultTitle="T"
        busy={false}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByTestId('vuln-ticket-cross-org-note')).toHaveTextContent('2 organizations');
  });

  it('submits title/description/priority and blocks empty titles', () => {
    const onSubmit = vi.fn();
    render(<CreateVulnTicketModal findings={[finding()]} defaultTitle="T" busy={false} onCancel={() => {}} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByTestId('vuln-ticket-title'), { target: { value: '' } });
    expect(screen.getByTestId('vuln-ticket-submit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('vuln-ticket-title'), { target: { value: 'Patch it' } });
    fireEvent.change(screen.getByTestId('vuln-ticket-priority'), { target: { value: 'high' } });
    fireEvent.click(screen.getByTestId('vuln-ticket-submit'));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ title: 'Patch it', priority: 'high' }));
  });
});
```

(If the `toHaveValue(expect.stringContaining(...))` matcher combination is rejected by jest-dom, assert via `(el as HTMLTextAreaElement).value).toContain('CVE-2026-0001')` as done for WS-02.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && pnpm vitest run src/components/vulnerabilities/CreateVulnTicketModal.test.tsx`
Expected: FAIL — cannot resolve `./CreateVulnTicketModal`.

- [ ] **Step 3: Implement the modal**

Create `apps/web/src/components/vulnerabilities/CreateVulnTicketModal.tsx`:

```tsx
import { useMemo, useState } from 'react';

import type { GroupFinding } from '../../lib/api/vulnerabilities';

const BTN =
  'inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50';

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
type Priority = (typeof PRIORITIES)[number];

function buildDescription(findings: GroupFinding[]): string {
  const cves = [...new Set(findings.map((f) => f.cveId))].sort();
  const devices = [...new Set(findings.map((f) => f.deviceName))].sort();
  return [
    `CVEs (${cves.length}): ${cves.join(', ')}`,
    `Devices (${devices.length}): ${devices.join(', ')}`,
    '',
    'Created from the Breeze vulnerabilities triage queue.',
  ].join('\n');
}

export function CreateVulnTicketModal({
  findings,
  defaultTitle,
  busy,
  onCancel,
  onSubmit,
}: {
  findings: GroupFinding[];
  defaultTitle: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (payload: { title: string; description: string; priority: Priority }) => void;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const [description, setDescription] = useState(() => buildDescription(findings));
  const [priority, setPriority] = useState<Priority>('normal');

  const orgCount = useMemo(() => new Set(findings.map((f) => f.orgId)).size, [findings]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-lg border bg-card p-5 shadow-lg" data-testid="vuln-ticket-modal">
        <h3 className="text-base font-semibold">Create ticket — {findings.length} finding{findings.length === 1 ? '' : 's'}</h3>
        {orgCount > 1 && (
          <p data-testid="vuln-ticket-cross-org-note" className="mt-1 text-xs text-amber-600 dark:text-amber-400">
            Selection spans {orgCount} organizations — one ticket per organization will be created.
          </p>
        )}
        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="text-muted-foreground">Title</span>
            <input
              data-testid="vuln-ticket-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={255}
              className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">Description</span>
            <textarea
              data-testid="vuln-ticket-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={5}
              className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">Priority</span>
            <select
              data-testid="vuln-ticket-priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value as Priority)}
              className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>{p[0]!.toUpperCase() + p.slice(1)}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={BTN} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            data-testid="vuln-ticket-submit"
            className={`${BTN} bg-primary text-primary-foreground hover:bg-primary/90`}
            disabled={busy || title.trim().length === 0}
            onClick={() => onSubmit({ title: title.trim(), description, priority })}
          >
            Create ticket
          </button>
        </div>
      </div>
    </div>
  );
}

export default CreateVulnTicketModal;
```

- [ ] **Step 4: Wire into both drawers**

In `SoftwareGroupDrawer.tsx`:
- `const canCreateTicket = can('tickets', 'write');`
- state: `const [ticketModal, setTicketModal] = useState(false);`
- Action bar gains (after Mitigate):

```tsx
{canCreateTicket && (
  <button
    type="button"
    data-testid="vuln-action-ticket"
    className={ACTION_BTN}
    disabled={busy !== null || selectedIds.length === 0}
    onClick={() => setTicketModal(true)}
  >
    Create ticket
  </button>
)}
```

- Modal rendering (after `VulnBulkActionModal`):

```tsx
{ticketModal && detail && (
  <CreateVulnTicketModal
    findings={detail.findings.filter((f) => selected.has(f.deviceVulnerabilityId))}
    defaultTitle={`Remediate ${detail.group.name}`}
    busy={busy !== null}
    onCancel={() => setTicketModal(false)}
    onSubmit={(payload) => {
      setTicketModal(false);
      void runBulk('ticket', () => createVulnTicket(selectedIds, payload), 'Failed to create ticket');
    }}
  />
)}
```

(`runBulk`'s union already includes `'ticket'` from Task 13; import `createVulnTicket`.) After success, `load()` re-renders the ticket chips from the refreshed `ticketId`s.

In `CveDrawer.tsx`: identical wiring with `defaultTitle={\`Remediate ${cveId}\`}` and `findings={payload.findings.filter((f) => selected.has(f.deviceVulnerabilityId))}`.

- [ ] **Step 5: Extend the drawer test for the ticket flow**

Add to `SoftwareGroupDrawer.test.tsx`:

```tsx
it('create-ticket flow: opens prefilled modal, submits, refreshes chips', async () => {
  vi.mocked(api.createVulnTicket).mockResolvedValue({ success: true, tickets: [{ ticketId: 't-1', orgId: 'org-1', findingCount: 1 }], skipped: [] });
  const onActionComplete = vi.fn();
  render(
    <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={onActionComplete} onSelectCve={() => {}} />,
  );
  fireEvent.click(await screen.findByTestId('vuln-action-ticket'));
  expect(screen.getByTestId('vuln-ticket-title')).toHaveValue('Remediate Google Chrome');
  fireEvent.click(screen.getByTestId('vuln-ticket-submit'));
  await waitFor(() =>
    expect(api.createVulnTicket).toHaveBeenCalledWith(['dv-1'], expect.objectContaining({ title: 'Remediate Google Chrome', priority: 'normal' })),
  );
  await waitFor(() => expect(onActionComplete).toHaveBeenCalled());
});

it('hides Create ticket without tickets:write', async () => {
  authState.permissions = [
    { resource: 'devices', action: 'execute' },
    { resource: 'vulnerabilities', action: 'accept_risk' },
    { resource: 'devices', action: 'write' },
  ];
  render(
    <SoftwareGroupDrawer groupKey="sw:google chrome|google llc" onClose={() => {}} onActionComplete={() => {}} onSelectCve={() => {}} />,
  );
  await screen.findByTestId('vuln-software-drawer');
  expect(screen.queryByTestId('vuln-action-ticket')).toBeNull();
});
```

(Task 13's mock of the API module already stubs `createVulnTicket`.)

- [ ] **Step 6: Targeted set + run all web tests**

Add `'src/components/vulnerabilities/CreateVulnTicketModal.tsx',` to `TARGET_GLOBS`; bump 62 → 63.

Run: `cd apps/web && pnpm vitest run`
Expected: full web suite PASS (catches any cross-component fallout).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/vulnerabilities/CreateVulnTicketModal.tsx apps/web/src/components/vulnerabilities/CreateVulnTicketModal.test.tsx apps/web/src/components/vulnerabilities/SoftwareGroupDrawer.tsx apps/web/src/components/vulnerabilities/SoftwareGroupDrawer.test.tsx apps/web/src/components/vulnerabilities/CveDrawer.tsx apps/web/src/lib/__tests__/no-silent-mutations.test.ts
git commit -m "feat(web): create-ticket modal with cross-org split warning in vuln drawers"
```

---

### Task 16: E2E — page object, updated fleet spec, triage happy path

**Files:**
- Create: `e2e-tests/pages/VulnerabilitiesPage.ts`
- Modify: `e2e-tests/tests/vulnerabilities.spec.ts`

**Interfaces:**
- Consumes: testids from Tasks 10–15; existing fixtures (`authedPage`), seeded device `e65460f3-413c-4599-a9a6-90ee71bbc4ff` + `CVE-2025-E2E-0001` from `seed-fixtures.sql`.
- Produces: `VulnerabilitiesPage` page object; a full accept→reopen loop spec that leaves seed data as it found it.

**Prerequisite:** a running seeded stack (`worktree-stack` skill) — these tests run in the `e2e-tests` harness, not vitest.

- [ ] **Step 1: Write the page object**

Create `e2e-tests/pages/VulnerabilitiesPage.ts` (modeled on `PamPage.ts` — testid getters only):

```ts
import type { Page, Locator } from '@playwright/test';

export class VulnerabilitiesPage {
  constructor(private page: Page) {}

  goto = (hash = '') => this.page.goto(`/vulnerabilities${hash}`);

  // Stat cards
  statCritical = () => this.page.getByTestId('vuln-stat-critical');
  statKev = () => this.page.getByTestId('vuln-stat-kev');
  statPatchReady = () => this.page.getByTestId('vuln-stat-patch-ready');
  statAcceptedExpiring = () => this.page.getByTestId('vuln-stat-accepted-expiring');

  // Tabs + filters
  tabSoftware = () => this.page.getByTestId('vuln-tab-software');
  tabCves = () => this.page.getByTestId('vuln-tab-cves');
  filterStatus = () => this.page.getByTestId('vuln-filter-status');

  // Tables
  groupRows = (): Locator => this.page.locator('[data-testid^="software-group-row-"]');
  cveRows = (): Locator => this.page.locator('[data-testid^="vulnerability-row-"]');

  // Software drawer
  softwareDrawer = () => this.page.getByTestId('vuln-software-drawer');
  actionAccept = () => this.page.getByTestId('vuln-action-accept');
  actionRemediate = () => this.page.getByTestId('vuln-action-remediate');

  // Bulk modal
  bulkModal = () => this.page.getByTestId('vuln-bulk-modal');
  bulkText = () => this.page.getByTestId('vuln-bulk-text');
  bulkUntil = () => this.page.getByTestId('vuln-bulk-until');
  bulkSubmit = () => this.page.getByTestId('vuln-bulk-submit');

  // CVE drawer
  cveDrawer = () => this.page.getByTestId('vuln-cve-drawer');
  reopenButtons = (): Locator => this.page.locator('[data-testid^="vuln-reopen-"]');

  drawerClose = (drawer: 'vuln-software-drawer' | 'vuln-cve-drawer') => this.page.getByTestId(`${drawer}-close`);
}
```

- [ ] **Step 2: Update the fleet spec**

In `e2e-tests/tests/vulnerabilities.spec.ts`:

1. The existing `'fleet dashboard lists CVE rows'` test navigates to `/vulnerabilities` and asserts `[data-testid^="vulnerability-row-"]` — CVE rows now live on the `#cves` tab. Change its navigation line to:

```ts
    await authedPage.goto('/vulnerabilities#cves');
```

(Leave the rest of that test and the per-device test untouched.)

2. Add the triage loop test (accept from the software drawer, then reopen from the CVE drawer so seed state is restored for the per-device test):

```ts
  test('fleet triage: accept risk from software drawer, reopen from CVE drawer', async ({ authedPage }) => {
    const vulnPage = new VulnerabilitiesPage(authedPage);
    await vulnPage.goto();

    // Stat cards render.
    await expect(vulnPage.statCritical()).toBeVisible({ timeout: 15_000 });

    // Software work queue is the default tab; open the first group's drawer.
    await expect(vulnPage.groupRows().first()).toBeVisible({ timeout: 15_000 });
    const groupsBefore = await vulnPage.groupRows().count();
    await vulnPage.groupRows().first().click();
    await expect(vulnPage.softwareDrawer()).toBeVisible();

    // Accept risk for the pre-selected open findings.
    await vulnPage.actionAccept().click();
    await expect(vulnPage.bulkModal()).toBeVisible();
    await vulnPage.bulkText().fill('Compensating control in place (fleet e2e)');
    await vulnPage.bulkUntil().fill('2030-01-01');
    await vulnPage.bulkSubmit().click();

    // Drawer reloads; close it. The open queue shrinks (group had only open findings).
    await expect(vulnPage.bulkModal()).toBeHidden({ timeout: 15_000 });
    await vulnPage.drawerClose('vuln-software-drawer').click();
    await expect(vulnPage.groupRows()).toHaveCount(groupsBefore - 1, { timeout: 15_000 });

    // Restore: find the accepted finding on the CVE tab and reopen it.
    await vulnPage.tabCves().click();
    await vulnPage.filterStatus().selectOption('accepted');
    await expect(vulnPage.cveRows().first()).toBeVisible({ timeout: 15_000 });
    await vulnPage.cveRows().first().click();
    await expect(vulnPage.cveDrawer()).toBeVisible();
    const reopenCount = await vulnPage.reopenButtons().count();
    expect(reopenCount).toBeGreaterThan(0);
    // Reopen every accepted finding this e2e created.
    for (let i = 0; i < reopenCount; i += 1) {
      await vulnPage.reopenButtons().first().click();
      await expect(vulnPage.reopenButtons()).toHaveCount(reopenCount - i - 1, { timeout: 15_000 });
    }
  });
```

Add the import at the top: `import { VulnerabilitiesPage } from '../pages/VulnerabilitiesPage';`

**Ordering caveat:** this test mutates then restores the seeded finding. Keep it AFTER the existing `'fleet dashboard lists CVE rows'` test in the file and note that Playwright runs tests within a file serially, so the per-device accept-risk test (which itself consumes one finding) still sees its expected state.

- [ ] **Step 3: Run the e2e suite against a live stack**

Run (with the worktree stack up): `cd e2e-tests && pnpm test -- tests/vulnerabilities.spec.ts`
Expected: PASS (3 tests). If no stack is available locally, verify via CI's e2e job and say so in the commit message.

- [ ] **Step 4: Commit**

```bash
git add e2e-tests/pages/VulnerabilitiesPage.ts e2e-tests/tests/vulnerabilities.spec.ts
git commit -m "test(e2e): fleet vulnerability triage flow with page object"
```

---

### Task 17 (OPTIONAL cleanup): Refactor `CatalogItemEditorDrawer` onto shared `Drawer`

Low-risk, behavior-preserving. Skip if the schedule is tight — the spec marks it optional.

**Files:**
- Modify: `apps/web/src/components/settings/CatalogItemEditorDrawer.tsx`

**Interfaces:**
- Consumes: Task 8's `Drawer` (`closeDisabled` maps to the drawer's `saving` state).

- [ ] **Step 1: Refactor**

Replace the drawer's own chrome with the shared primitive:
- Delete its local `FOCUSABLE` constant, the a11y `useEffect`, `handleKeyDown`, `handleBackdropClick`, `panelRef`/`triggerRef`/`titleId`, the `createPortal(...)` wrapper, backdrop `<div>`, panel `<div>`, and header block.
- Wrap the remaining body in:

```tsx
<Drawer
  open={open}
  onClose={onClose}
  title={editId ? 'Edit item' : 'New item'}
  dataTestId="catalog-item-editor"
  closeDisabled={saving}
>
  {/* existing form body + footer, unchanged */}
</Drawer>
```

**Testid compatibility:** the original uses `data-testid="catalog-editor-backdrop"` and `data-testid="catalog-form-close"`, while the shared Drawer derives `catalog-item-editor-backdrop` / `catalog-item-editor-close`. Grep the web tests and e2e specs for `catalog-editor-backdrop` and `catalog-form-close`:

```bash
grep -rn "catalog-editor-backdrop\|catalog-form-close" apps/web/src e2e-tests/
```

Update every hit to the derived names in the same commit (or, if e2e churn is unwanted, extend `Drawer` with optional `backdropTestId`/`closeTestId` overrides — prefer updating the tests).

- [ ] **Step 2: Run the catalog tests**

Run: `cd apps/web && pnpm vitest run src/components/settings/`
Expected: PASS after testid updates.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/settings/CatalogItemEditorDrawer.tsx apps/web/src
git commit -m "refactor(web): CatalogItemEditorDrawer consumes shared Drawer primitive"
```

---

## Final verification (after all tasks)

- [ ] `cd apps/api && pnpm vitest run` — full API unit suite green.
- [ ] `cd apps/web && pnpm vitest run` — full web suite green (including `no-silent-mutations` at 63 and `astro check` if part of the suite).
- [ ] `pnpm db:check-drift` with a migrated local DB — no drift.
- [ ] `cd apps/web && pnpm build` — the Astro page builds (catches island/import errors `tsc` misses).
- [ ] Manual smoke via the worktree stack: `/vulnerabilities` renders stat cards + software queue; drawer opens from a row and from a `#software/<key>` deep link; accept-risk round-trips.

## Deferred / out of scope (from the spec)

- Dual-control co-sign for critical/KEV waivers; PSA ticket sync; network-device vulnerabilities (BE-16 phase 5); any change to `/security/vulnerabilities` (EDR threats page).
- MFA step-up UX for remediate: `runAction` already toasts the server's 403 message; a dedicated `friendly`-mapped step-up prompt is a follow-up if the raw message proves confusing.



