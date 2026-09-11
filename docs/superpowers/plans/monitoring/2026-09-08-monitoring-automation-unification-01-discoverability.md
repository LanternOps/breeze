---
tracking_issue: LanternOps/breeze#5287
wave_issue: LanternOps/breeze#5288
branch: feature/5287-monitoring-automation-unification/wave-5288
---

# Monitoring & Automation Unification — W01 Discoverability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Automations a left-nav home as **Jobs** (`/jobs`, with trigger-type tabs) and turn the "Network Monitor" nav entry into the **Monitoring** hub (Network + Delivery tabs), without touching the database or any API.

**Architecture:** Pure web wave. New `/jobs/*` Astro pages render the existing `AutomationsPage` / `AutomationEditPage`; the old `/automations/*` pages become 301 redirects. `AutomationsPage` gains hash tabs that drive `AutomationList`'s trigger filter as a controlled prop. A new path-based `MonitoringTabStrip` (copy of `AlertsTabStrip`) sits above the existing network `MonitoringPage` and above a new `/monitoring/delivery` page that hosts `NotificationChannelsPage`. Two nav entries change in `Sidebar.tsx`; locale keys are added to all eight locales.

**Tech Stack:** Astro pages + React islands, react-i18next (8 locales, parity test), `useHashTab` from `@/lib/useHashState`, Vitest + jsdom + Testing Library.

**Spec:** `docs/superpowers/specs/monitoring/2026-09-08-monitoring-automation-unification-design.md` (§Navigation and web, §Waves W1)

**Tracking:** feature LanternOps/breeze#5287, wave #5288. Branch `feature/5287-monitoring-automation-unification/wave-5288`.

## Global Constraints

- **No schema, no API changes.** Only `apps/web/**` and `apps/docs/**`.
- Nav item `name` must equal its English label (`Sidebar.nav.test.tsx:212` asserts `i18n.t(labelKey, { lng: 'en' }) === item.name`).
- Every new locale key exists in all 8 locale dirs (`de-DE, en, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR`) or `apps/web/src/lib/i18n/localeParity.test.ts` fails. Translations are given in each task; do not leave English in non-English files.
- Keep `nav.networkMonitor` as a key (other code may reference it); the Sidebar simply stops using it.
- `/monitoring` keeps rendering the network page in this wave. The Monitors tab arrives in W02; this wave does **not** add placeholder tabs.
- Hash state for tabs (`window.location.hash`), never query params (CLAUDE.md URL-state rule). The Monitoring strip is **path**-based (like `AlertsTabStrip`) because the network `MonitoringPage` already owns the hash for its own tabs.
- Redirects are `Astro.redirect(target, 301)` in the page frontmatter (pattern: `apps/web/src/pages/alerts/rules/index.astro`).
- Deviation from the spec recorded here: the Jobs tabs are `all | scheduled | on-demand | webhooks | event-rules` (an `all` default so nothing is hidden on first visit); `#history` is not a tab — run history stays the per-row modal.
- Every task: red test first, `pnpm --filter @breeze/web test --run <file>` (no `--` before `--run`), commit. Before the PR: `pnpm --filter @breeze/web lint`, the locale parity and Sidebar suites, and `pnpm --filter @breeze/web build`.

---

### Task 1: Sidebar — add Jobs, rename Network Monitor to Monitoring, locale keys

**Files:**
- Modify: `apps/web/src/components/layout/Sidebar.tsx:192-200` (top-level nav), `:256` (fleet-management item), `:430-433` (`pathAliases`)
- Modify: `apps/web/src/locales/{de-DE,en,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/common.json` (`nav` block)
- Test: `apps/web/src/components/layout/Sidebar.nav.test.tsx`

**Interfaces:**
- Produces: nav hrefs `/jobs` (top-level, after `/scripts`) and `/monitoring` (fleet-management, label "Monitoring"); `pathAliases['/monitoring/delivery'] = '/monitoring'`.

- [ ] **Step 1: Write the failing tests** (append to the `navSections structure` describe in `Sidebar.nav.test.tsx`)

```tsx
  it('exposes Jobs at top level right after Scripts (#5288)', () => {
    const hrefs = topLevelNav.map((i) => i.href);
    expect(hrefs.indexOf('/jobs')).toBe(hrefs.indexOf('/scripts') + 1);
    const jobs = topLevelNav.find((i) => i.href === '/jobs')!;
    expect(jobs.name).toBe('Jobs');
    expect(jobs.labelKey).toBe('nav.jobs');
    expect(jobs.requiredPermission).toEqual({ resource: 'automations', action: 'read' });
  });

  it('labels /monitoring as Monitoring, not Network Monitor (#5288)', () => {
    const item = navSections
      .find((s) => s.id === 'fleet-management')!
      .items.find((i) => i.href === '/monitoring')!;
    expect(item.name).toBe('Monitoring');
    expect(item.labelKey).toBe('nav.monitoring');
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @breeze/web test --run src/components/layout/Sidebar.nav.test.tsx`
Expected: FAIL — `indexOf('/jobs')` is `-1`; name is `'Network Monitor'`.

- [ ] **Step 3: Edit `Sidebar.tsx`**

After the `Scripts` entry in `topLevelNav` (line ~203, `href: '/scripts'`), add:

```tsx
  // #5288 — Automations finally get a nav home, as Jobs. /automations redirects here.
  { name: 'Jobs', labelKey: 'nav.jobs', href: '/jobs', icon: CalendarClock, requiredPermission: { resource: 'automations', action: 'read' } },
```

Import `CalendarClock` from `lucide-react` alongside the other icons at the top of the file.

Replace the fleet-management entry at line 256:

```tsx
      // #5288 — the Monitoring hub: Network today, Monitors (W02) and Delivery tabs.
      { name: 'Monitoring', labelKey: 'nav.monitoring', href: '/monitoring', icon: Activity, requiredPermission: { resource: 'devices', action: 'read' } },
```

Extend `pathAliases`:

```tsx
const pathAliases: Record<string, string> = {
  '/software-inventory': '/software',
  '/software-policies': '/software',
  '/monitoring/delivery': '/monitoring',
};
```

- [ ] **Step 4: Add locale keys** — in every locale's `common.json` `nav` block, next to `"networkMonitor"`:

| locale | `nav.jobs` | `nav.monitoring` |
|---|---|---|
| en | `"Jobs"` | `"Monitoring"` |
| de-DE | `"Aufträge"` | `"Überwachung"` |
| es-419 | `"Trabajos"` | `"Monitoreo"` |
| fr-CA | `"Tâches"` | `"Surveillance"` |
| fr-FR | `"Tâches"` | `"Supervision"` |
| it-IT | `"Attività"` | `"Monitoraggio"` |
| pt-BR | `"Jobs"` | `"Monitoramento"` |
| tr-TR | `"İşler"` | `"İzleme"` |

- [ ] **Step 5: Run the Sidebar suite and the parity suite**

Run: `pnpm --filter @breeze/web test --run src/components/layout/Sidebar.nav.test.tsx src/lib/i18n/localeParity.test.ts`
Expected: PASS (both). If `hrefsOf('fleet-management')` at line 101 fails, it should not — the href `/monitoring` is unchanged; if it does, you edited the href by mistake.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/layout/Sidebar.tsx apps/web/src/components/layout/Sidebar.nav.test.tsx apps/web/src/locales/*/common.json
git commit -m "feat(web): Jobs nav entry + Monitoring hub label (#5288)"
```

---

### Task 2: `/jobs` pages, `/automations` redirects, internal links, Jobs copy

**Files:**
- Create: `apps/web/src/pages/jobs/index.astro`, `apps/web/src/pages/jobs/new.astro`, `apps/web/src/pages/jobs/[id].astro`
- Modify: `apps/web/src/pages/automations/index.astro`, `apps/web/src/pages/automations/new.astro`, `apps/web/src/pages/automations/[id].astro` (become redirects)
- Modify: `apps/web/src/components/automations/AutomationsPage.tsx:255` (`navigateTo`), `:369` (`href="/automations/new"`)
- Modify: `apps/web/src/components/automations/AutomationEditPage.tsx:317` (save-success URL), `:330`, `:339` (`navigateTo('/automations')`), `:371` (breadcrumb href), `:376` (back link href)
- Modify: `apps/web/src/components/layout/NotificationCenter.tsx:147` (`case 'automation'`)
- Modify: `apps/web/src/locales/*/scripts.json` (`automationsPage.title`, `automationsPage.description`; `automationEditPage.breadcrumb.automations`)
- Test: `apps/web/src/components/automations/AutomationsPage.managed.test.tsx` (extend), `apps/web/src/components/layout/NotificationCenter.test.tsx` (extend if it exists; otherwise create the assertion in a new `NotificationCenter.targetPath.test.tsx`)

**Interfaces:**
- Produces: web routes `/jobs`, `/jobs/new`, `/jobs/:id`; every in-app link to automations points at `/jobs*`.
- Leaves alone: `FleetOrchestrationPage.tsx:86` — `{ name: 'automations', path: '/automations' }` is an **API** endpoint path, not a web route.

- [ ] **Step 1: Write the failing test** — in `AutomationsPage.managed.test.tsx` add:

```tsx
it('links "new" and row edit to /jobs, not /automations (#5288)', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValueOnce(
    new Response(JSON.stringify({ data: [{ id: 'a1', name: 'Nightly cleanup', enabled: true, triggerType: 'schedule', trigger: { type: 'schedule', cron: '0 2 * * *' }, actions: [], runCount: 0 }] }), { status: 200 })
  );
  render(<AutomationsPage />);
  const newLink = await screen.findByRole('link', { name: /new/i });
  expect(newLink).toHaveAttribute('href', '/jobs/new');
});
```

(Match the existing mock shape in that file for `fetchWithAuth` — copy how its first test builds the response.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @breeze/web test --run src/components/automations/AutomationsPage.managed.test.tsx`
Expected: FAIL — href is `/automations/new`.

- [ ] **Step 3: Create the Jobs pages**

`apps/web/src/pages/jobs/index.astro`:

```astro
---
import DashboardLayout from '../../layouts/DashboardLayout.astro';
import AutomationsPage from '../../components/automations/AutomationsPage';
---

<DashboardLayout title="Jobs">
  <AutomationsPage client:load />
</DashboardLayout>
```

`apps/web/src/pages/jobs/new.astro` and `apps/web/src/pages/jobs/[id].astro`: copy the current `automations/new.astro` and `automations/[id].astro` verbatim (same component, same props) and change only the `title` to `"New Job"` / `"Job"`.

- [ ] **Step 4: Turn the old pages into redirects**

`apps/web/src/pages/automations/index.astro`:

```astro
---
return Astro.redirect('/jobs', 301);
---
```

`apps/web/src/pages/automations/new.astro`:

```astro
---
return Astro.redirect('/jobs/new', 301);
---
```

`apps/web/src/pages/automations/[id].astro`:

```astro
---
return Astro.redirect(`/jobs/${Astro.params.id}`, 301);
---
```

- [ ] **Step 5: Repoint the internal links**

- `AutomationsPage.tsx:255` → `` void navigateTo(`/jobs/${automation.id}`); ``
- `AutomationsPage.tsx:369` → `href="/jobs/new"`
- `AutomationEditPage.tsx:317` → `` const url = isNew ? '/jobs' : `/jobs/${automationId}`; `` — **check first**: if this `url` is the API path passed to `fetchWithAuth`, leave it alone; only change it if it is used with `navigateTo`/`href`. Lines 330, 339, 371, 376 are navigation and must become `/jobs`.
- `NotificationCenter.tsx:147` → `return '/jobs';`

- [ ] **Step 6: Jobs copy** — in every locale's `scripts.json`:

| locale | `automationsPage.title` | `automationsPage.description` | `automationEditPage.breadcrumb.automations` |
|---|---|---|---|
| en | `"Jobs"` | `"Scheduled, on-demand, webhook and event-driven automations."` | `"Jobs"` |
| de-DE | `"Aufträge"` | `"Geplante, manuelle, Webhook- und ereignisgesteuerte Automatisierungen."` | `"Aufträge"` |
| es-419 | `"Trabajos"` | `"Automatizaciones programadas, bajo demanda, por webhook y por eventos."` | `"Trabajos"` |
| fr-CA | `"Tâches"` | `"Automatisations planifiées, sur demande, par webhook et par événement."` | `"Tâches"` |
| fr-FR | `"Tâches"` | `"Automatisations planifiées, à la demande, par webhook et par événement."` | `"Tâches"` |
| it-IT | `"Attività"` | `"Automazioni pianificate, su richiesta, via webhook e basate su eventi."` | `"Attività"` |
| pt-BR | `"Jobs"` | `"Automações agendadas, sob demanda, por webhook e por evento."` | `"Jobs"` |
| tr-TR | `"İşler"` | `"Zamanlanmış, isteğe bağlı, webhook ve olay tabanlı otomasyonlar."` | `"İşler"` |

Only values change; no keys are added or removed, so the parity test is unaffected.

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @breeze/web test --run src/components/automations src/components/layout/NotificationCenter`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/pages/jobs apps/web/src/pages/automations apps/web/src/components/automations/AutomationsPage.tsx apps/web/src/components/automations/AutomationEditPage.tsx apps/web/src/components/layout/NotificationCenter.tsx apps/web/src/components/automations/AutomationsPage.managed.test.tsx apps/web/src/locales/*/scripts.json
git commit -m "feat(web): /jobs pages, /automations redirects, Jobs copy (#5288)"
```

---

### Task 3: Jobs trigger tabs (hash) driving the list filter

**Files:**
- Modify: `apps/web/src/components/automations/AutomationList.tsx:62-71` (props), `:136` (state), `:189-201` (select)
- Modify: `apps/web/src/components/automations/AutomationsPage.tsx` (tab strip above the list; `useHashTab`)
- Modify: `apps/web/src/locales/*/scripts.json` (`automationsPage.tabs.*`)
- Test: `apps/web/src/components/automations/AutomationList.test.tsx` (extend), `apps/web/src/components/automations/AutomationsPage.tabs.test.tsx` (create)

**Interfaces:**
- Produces on `AutomationList`: optional controlled props `triggerFilter?: TriggerFilter` and `onTriggerFilterChange?: (value: TriggerFilter) => void` where `export type TriggerFilter = 'all' | 'schedule' | 'event' | 'webhook' | 'manual'`. When `triggerFilter` is provided the internal state is bypassed.
- Produces on `AutomationsPage`: `export const JOB_TABS = ['all', 'scheduled', 'on-demand', 'webhooks', 'event-rules'] as const; export type JobTab = typeof JOB_TABS[number];` and `export function triggerFilterForTab(tab: JobTab): TriggerFilter` mapping `all→all, scheduled→schedule, on-demand→manual, webhooks→webhook, event-rules→event`.

- [ ] **Step 1: Write the failing list test** — append to `AutomationList.test.tsx` (reuse that file's `makeAutomation`/fixture helper if it has one; otherwise build objects with the `Automation` shape from `AutomationList.tsx:36`):

```tsx
it('honours a controlled triggerFilter prop and reports select changes (#5288)', () => {
  const onChange = vi.fn();
  render(
    <AutomationList
      automations={[
        makeAutomation({ id: '1', name: 'Nightly', triggerType: 'schedule' }),
        makeAutomation({ id: '2', name: 'On alert', triggerType: 'event' }),
      ]}
      triggerFilter="event"
      onTriggerFilterChange={onChange}
    />
  );
  expect(screen.queryByText('Nightly')).toBeNull();
  expect(screen.getByText('On alert')).toBeInTheDocument();
  fireEvent.change(screen.getByDisplayValue(/event/i), { target: { value: 'schedule' } });
  expect(onChange).toHaveBeenCalledWith('schedule');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @breeze/web test --run src/components/automations/AutomationList.test.tsx`
Expected: FAIL — both rows render (prop ignored) and `onChange` is never called.

- [ ] **Step 3: Make `AutomationList` controllable**

```tsx
export type TriggerFilter = 'all' | 'schedule' | 'event' | 'webhook' | 'manual';

type AutomationListProps = {
  automations: Automation[];
  onEdit?: (automation: Automation) => void;
  onDelete?: (automation: Automation) => void;
  onRun?: (automation: Automation) => void;
  onToggle?: (automation: Automation, enabled: boolean) => void;
  onViewHistory?: (automation: Automation) => void;
  pageSize?: number;
  timezone?: string;
  /** #5288: when provided, the trigger filter is controlled by the parent (Jobs tabs). */
  triggerFilter?: TriggerFilter;
  onTriggerFilterChange?: (value: TriggerFilter) => void;
};
```

Inside the component replace the state line:

```tsx
  const [internalTriggerFilter, setInternalTriggerFilter] = useState<TriggerFilter>('all');
  const triggerFilter = controlledTriggerFilter ?? internalTriggerFilter;
  const setTriggerFilter = (value: TriggerFilter) => {
    if (onTriggerFilterChange) onTriggerFilterChange(value);
    if (controlledTriggerFilter === undefined) setInternalTriggerFilter(value);
  };
```

(destructure `triggerFilter: controlledTriggerFilter, onTriggerFilterChange` from props). In the `<select onChange>` cast: `setTriggerFilter(event.target.value as TriggerFilter); setCurrentPage(1);`.

- [ ] **Step 4: Run the list test — PASS.** Then write the failing page test `AutomationsPage.tabs.test.tsx`:

```tsx
import '@/lib/i18n';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: vi.fn() };
});
import AutomationsPage, { JOB_TABS, triggerFilterForTab } from './AutomationsPage';
import { fetchWithAuth } from '../../stores/auth';

const rows = [
  { id: '1', name: 'Nightly cleanup', enabled: true, triggerType: 'schedule', trigger: { type: 'schedule', cron: '0 2 * * *' }, actions: [], runCount: 0 },
  { id: '2', name: 'Inbound webhook', enabled: true, triggerType: 'webhook', trigger: { type: 'webhook' }, actions: [], runCount: 0 },
  { id: '3', name: 'On disk alert', enabled: true, triggerType: 'event', trigger: { type: 'event', event: 'alert.triggered' }, actions: [], runCount: 0 },
];

describe('Jobs tabs (#5288)', () => {
  beforeEach(() => {
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({ data: rows }), { status: 200 }));
  });

  it('maps every tab to a trigger filter', () => {
    expect(JOB_TABS).toEqual(['all', 'scheduled', 'on-demand', 'webhooks', 'event-rules']);
    expect(triggerFilterForTab('scheduled')).toBe('schedule');
    expect(triggerFilterForTab('on-demand')).toBe('manual');
    expect(triggerFilterForTab('webhooks')).toBe('webhook');
    expect(triggerFilterForTab('event-rules')).toBe('event');
    expect(triggerFilterForTab('all')).toBe('all');
  });

  it('#webhooks shows only webhook jobs', async () => {
    window.location.hash = '#webhooks';
    render(<AutomationsPage />);
    await waitFor(() => expect(screen.getByText('Inbound webhook')).toBeInTheDocument());
    expect(screen.queryByText('Nightly cleanup')).toBeNull();
    expect(screen.queryByText('On disk alert')).toBeNull();
    window.location.hash = '';
  });
});
```

- [ ] **Step 5: Run to verify the page test fails**

Run: `pnpm --filter @breeze/web test --run src/components/automations/AutomationsPage.tabs.test.tsx`
Expected: FAIL — `JOB_TABS` is not exported / all three rows render.

- [ ] **Step 6: Implement the tabs in `AutomationsPage.tsx`**

Near the top of the file:

```tsx
import { useHashTab } from '@/lib/useHashState';
import type { TriggerFilter } from './AutomationList';

export const JOB_TABS = ['all', 'scheduled', 'on-demand', 'webhooks', 'event-rules'] as const;
export type JobTab = typeof JOB_TABS[number];

const TAB_TO_FILTER: Record<JobTab, TriggerFilter> = {
  all: 'all',
  scheduled: 'schedule',
  'on-demand': 'manual',
  webhooks: 'webhook',
  'event-rules': 'event',
};
const FILTER_TO_TAB: Record<TriggerFilter, JobTab> = {
  all: 'all',
  schedule: 'scheduled',
  manual: 'on-demand',
  webhook: 'webhooks',
  event: 'event-rules',
};

export function triggerFilterForTab(tab: JobTab): TriggerFilter {
  return TAB_TO_FILTER[tab];
}
```

Inside the component: `const [tab, setTab] = useHashTab<JobTab>(JOB_TABS, 'all');` and a writer

```tsx
  const switchTab = (next: JobTab) => {
    window.location.hash = next;
    setTab(next);
  };
```

Render the strip between the header and the error block:

```tsx
      <nav className="flex gap-1 border-b" aria-label={t('automationsPage.tabs.ariaLabel')}>
        {JOB_TABS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => switchTab(key)}
            aria-current={tab === key ? 'page' : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === key ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          >
            {t(/* i18n-dynamic */ `automationsPage.tabs.${key}`)}
          </button>
        ))}
      </nav>
```

Pass to the list: `triggerFilter={triggerFilterForTab(tab)}` and `onTriggerFilterChange={(value) => switchTab(FILTER_TO_TAB[value])}`.

- [ ] **Step 7: Locale keys** — `automationsPage.tabs` object in every locale's `scripts.json`:

| locale | ariaLabel | all | scheduled | on-demand | webhooks | event-rules |
|---|---|---|---|---|---|---|
| en | `"Job types"` | `"All"` | `"Scheduled"` | `"On demand"` | `"Webhooks"` | `"Event rules"` |
| de-DE | `"Auftragstypen"` | `"Alle"` | `"Geplant"` | `"Manuell"` | `"Webhooks"` | `"Ereignisregeln"` |
| es-419 | `"Tipos de trabajo"` | `"Todos"` | `"Programados"` | `"Bajo demanda"` | `"Webhooks"` | `"Reglas de eventos"` |
| fr-CA | `"Types de tâches"` | `"Toutes"` | `"Planifiées"` | `"Sur demande"` | `"Webhooks"` | `"Règles d'événement"` |
| fr-FR | `"Types de tâches"` | `"Toutes"` | `"Planifiées"` | `"À la demande"` | `"Webhooks"` | `"Règles d'événement"` |
| it-IT | `"Tipi di attività"` | `"Tutte"` | `"Pianificate"` | `"Su richiesta"` | `"Webhook"` | `"Regole evento"` |
| pt-BR | `"Tipos de job"` | `"Todos"` | `"Agendados"` | `"Sob demanda"` | `"Webhooks"` | `"Regras de evento"` |
| tr-TR | `"İş türleri"` | `"Tümü"` | `"Zamanlanmış"` | `"İsteğe bağlı"` | `"Webhook'lar"` | `"Olay kuralları"` |

JSON keys are `"ariaLabel"`, `"all"`, `"scheduled"`, `"on-demand"`, `"webhooks"`, `"event-rules"`.

- [ ] **Step 8: Run the automations suites and parity**

Run: `pnpm --filter @breeze/web test --run src/components/automations src/lib/i18n/localeParity.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/automations apps/web/src/locales/*/scripts.json
git commit -m "feat(web): Jobs trigger tabs via hash state (#5288)"
```

---

### Task 4: Monitoring tab strip and the Delivery page

**Files:**
- Create: `apps/web/src/components/monitoring/MonitoringTabStrip.tsx`, `apps/web/src/components/monitoring/MonitoringTabStrip.test.tsx`
- Create: `apps/web/src/pages/monitoring/delivery.astro`
- Modify: `apps/web/src/components/monitoring/MonitoringPage.tsx` (render the strip above the `<h1>` at line 59)
- Modify: `apps/web/src/components/alerts/NotificationChannelsPage.tsx:504` (strip selection prop)
- Modify: `apps/web/src/locales/*/common.json` (`monitoringTabs` block)
- Test: `apps/web/src/components/alerts/NotificationChannelsPage.tabStrip.test.tsx` (create)

**Interfaces:**
- Produces: `MonitoringTabStrip({ currentPath?: string })` with tabs `[{ href: '/monitoring', labelKey: 'network' }, { href: '/monitoring/delivery', labelKey: 'delivery' }]`, labels from `common:monitoringTabs.*`. Active tab: `/monitoring/delivery` when `path.startsWith('/monitoring/delivery')`, else `/monitoring`.
- Produces on `NotificationChannelsPage`: prop `tabStrip?: 'alerts' | 'monitoring'` (default `'alerts'` → unchanged `/alerts/channels`; `'monitoring'` renders `MonitoringTabStrip` with `currentPath="/monitoring/delivery"`).

- [ ] **Step 1: Write the failing strip test** `MonitoringTabStrip.test.tsx`

```tsx
import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import MonitoringTabStrip from './MonitoringTabStrip';

describe('MonitoringTabStrip (#5288)', () => {
  it('renders Network and Delivery and marks the current path active', () => {
    render(<MonitoringTabStrip currentPath="/monitoring/delivery" />);
    const network = screen.getByRole('link', { name: 'Network' });
    const delivery = screen.getByRole('link', { name: 'Delivery' });
    expect(network).toHaveAttribute('href', '/monitoring');
    expect(delivery).toHaveAttribute('href', '/monitoring/delivery');
    expect(delivery).toHaveAttribute('aria-current', 'page');
    expect(network).not.toHaveAttribute('aria-current');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @breeze/web test --run src/components/monitoring/MonitoringTabStrip.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `MonitoringTabStrip.tsx`** — copy `apps/web/src/components/alerts/AlertsTabStrip.tsx` and change: the `TABS` constant, the namespace, the active-href resolver, and drop the ML-flag logic.

```tsx
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';

const TABS = [
  { href: '/monitoring', labelKey: 'network' },
  { href: '/monitoring/delivery', labelKey: 'delivery' },
] as const;

interface MonitoringTabStripProps {
  // SSR-correct current path so server and client agree on the active tab.
  currentPath?: string;
}

function useCurrentPath(initialPath: string): string {
  const [path, setPath] = useState(initialPath);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    document.addEventListener('astro:after-swap', update);
    window.addEventListener('popstate', update);
    return () => {
      document.removeEventListener('astro:after-swap', update);
      window.removeEventListener('popstate', update);
    };
  }, []);
  return path;
}

export default function MonitoringTabStrip({ currentPath = '/monitoring' }: MonitoringTabStripProps) {
  const { t } = useTranslation('common');
  const path = useCurrentPath(currentPath);
  const activeHref = useMemo(
    () => (path.startsWith('/monitoring/delivery') ? '/monitoring/delivery' : '/monitoring'),
    [path],
  );
  return (
    <nav className="flex gap-1 border-b" aria-label={t('monitoringTabs.ariaLabel')}>
      {TABS.map((tab) => (
        <a
          key={tab.href}
          href={tab.href}
          aria-current={activeHref === tab.href ? 'page' : undefined}
          className={`-mb-px border-b-2 px-3 py-2 text-sm ${activeHref === tab.href ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
        >
          {t(/* i18n-dynamic */ `monitoringTabs.${tab.labelKey}`)}
        </a>
      ))}
    </nav>
  );
}
```

Copy the exact class names `AlertsTabStrip` uses for its links so the two strips look identical.

- [ ] **Step 4: Locale keys** — `monitoringTabs` object in every locale's `common.json` (top level, next to `nav`):

| locale | ariaLabel | network | delivery |
|---|---|---|---|
| en | `"Monitoring sections"` | `"Network"` | `"Delivery"` |
| de-DE | `"Überwachungsbereiche"` | `"Netzwerk"` | `"Zustellung"` |
| es-419 | `"Secciones de monitoreo"` | `"Red"` | `"Entrega"` |
| fr-CA | `"Sections de surveillance"` | `"Réseau"` | `"Livraison"` |
| fr-FR | `"Sections de supervision"` | `"Réseau"` | `"Diffusion"` |
| it-IT | `"Sezioni di monitoraggio"` | `"Rete"` | `"Consegna"` |
| pt-BR | `"Seções de monitoramento"` | `"Rede"` | `"Entrega"` |
| tr-TR | `"İzleme bölümleri"` | `"Ağ"` | `"Teslimat"` |

- [ ] **Step 5: Run the strip test — PASS.** Then write the failing channels-page test `NotificationChannelsPage.tabStrip.test.tsx` (copy the auth/fetch mocking preamble from `NotificationChannelList.pagination.test.tsx` or `AutomationsPage.managed.test.tsx`; the page fetches channels on mount, so mock `fetchWithAuth` to resolve `{ data: [] }`):

```tsx
it('renders the Monitoring strip when tabStrip="monitoring" (#5288)', async () => {
  render(<NotificationChannelsPage tabStrip="monitoring" />);
  expect(await screen.findByRole('link', { name: 'Delivery' })).toHaveAttribute('aria-current', 'page');
  expect(screen.queryByRole('link', { name: 'Correlations' })).toBeNull();
});

it('keeps the Alerts strip by default', async () => {
  render(<NotificationChannelsPage />);
  expect(await screen.findByRole('link', { name: 'Channels' })).toBeInTheDocument();
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm --filter @breeze/web test --run src/components/alerts/NotificationChannelsPage.tabStrip.test.tsx`
Expected: FAIL — no `Delivery` link.

- [ ] **Step 7: Add the prop to `NotificationChannelsPage`**

```tsx
import MonitoringTabStrip from '../monitoring/MonitoringTabStrip';

interface NotificationChannelsPageProps {
  /** #5288: which hub the page is mounted under. */
  tabStrip?: 'alerts' | 'monitoring';
}

export default function NotificationChannelsPage({ tabStrip = 'alerts' }: NotificationChannelsPageProps) {
```

and at line 504:

```tsx
      {tabStrip === 'monitoring'
        ? <MonitoringTabStrip currentPath="/monitoring/delivery" />
        : <AlertsTabStrip currentPath="/alerts/channels" />}
```

- [ ] **Step 8: Create `apps/web/src/pages/monitoring/delivery.astro`**

```astro
---
import DashboardLayout from '../../layouts/DashboardLayout.astro';
import NotificationChannelsPage from '../../components/alerts/NotificationChannelsPage';
import Breadcrumbs from '../../components/layout/Breadcrumbs';
---

<DashboardLayout title="Monitoring">
  <Breadcrumbs client:load items={[
    { label: 'Monitoring', href: '/monitoring' },
    { label: 'Delivery' }
  ]} />
  <NotificationChannelsPage client:load tabStrip="monitoring" />
</DashboardLayout>
```

- [ ] **Step 9: Mount the strip on the network page** — in `MonitoringPage.tsx`, import `MonitoringTabStrip` and render `<MonitoringTabStrip currentPath="/monitoring" />` as the first child of the page's outer `<div className="space-y-6">` (directly above the header containing the `<h1>` at line 59). Do not touch the page's own `useHashTab` tabs.

- [ ] **Step 10: Run the affected suites**

Run: `pnpm --filter @breeze/web test --run src/components/monitoring src/components/alerts/NotificationChannelsPage src/lib/i18n/localeParity.test.ts`
Expected: PASS. If an existing `MonitoringPage` test asserts the first rendered element, update it to account for the strip.

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/components/monitoring apps/web/src/components/alerts/NotificationChannelsPage.tsx apps/web/src/components/alerts/NotificationChannelsPage.tabStrip.test.tsx apps/web/src/pages/monitoring/delivery.astro apps/web/src/locales/*/common.json
git commit -m "feat(web): Monitoring hub tab strip + Delivery page (#5288)"
```

---

### Task 5: Docs

**Files:**
- Modify: `apps/docs/src/content/docs/features/automations.mdx` (wherever it tells the reader where Automations live / links `/automations`)
- Modify: `apps/docs/src/content/docs/features/network-monitors.mdx` (nav path "Fleet Management → Network Monitor")
- Modify: any other file from `grep -rln -E "Network Monitor|/automations" apps/docs/src/content/docs` that names the nav entry (the grep on 2026-09-08 also hit `index.mdx`, `configuration-policies.mdx`, `scripts.mdx`, `maintenance-windows.mdx`, `ai.mdx`, `ai-agents.mdx`, `mcp-server.mdx`, `edr-integrations.mdx`, `unifi-integration.mdx`, `security/overview.mdx` — most mention the *feature* "automations", which is still the right word; change only navigation instructions and `/automations` URLs).

- [ ] **Step 1: Edit** — replace navigation instructions with "**Jobs** in the left nav (`/jobs`)" and "**Fleet Management → Monitoring → Network**". Add one sentence to `automations.mdx` near the top: "Automations appear in the left nav as **Jobs**. Older `/automations` links redirect."

- [ ] **Step 2: Build the docs site**

Run: `pnpm --filter @breeze/docs build`
Expected: succeeds with no broken-link warnings for `/jobs`.

- [ ] **Step 3: Commit**

```bash
git add apps/docs/src/content/docs
git commit -m "docs: Jobs nav and Monitoring hub (#5288)"
```

---

### Task 6: Verification and PR

- [ ] **Step 1: Lint and the full web suites that touch this wave**

```bash
pnpm --filter @breeze/web lint
pnpm --filter @breeze/web test --run src/components/layout src/components/automations src/components/monitoring src/components/alerts src/lib/i18n
```

Expected: lint clean, all PASS.

- [ ] **Step 2: Build the web app** (catches Astro page/redirect errors that vitest cannot)

```bash
pnpm --filter @breeze/web build
```

Expected: succeeds. Then, with a local stack (`worktree-stack` skill), confirm in a browser: `/automations` → `/jobs` (301), `/automations/<id>` → `/jobs/<id>`, `#webhooks` filters the list, `/monitoring/delivery` shows the channels page with the Monitoring strip, the sidebar highlights **Monitoring** on `/monitoring/delivery` and **Jobs** on `/jobs/new`.

- [ ] **Step 3: Open the PR**

Title: `feat(web): Jobs nav + Monitoring hub — W01 discoverability (#5287)`. Body: what changed per task, the spec path, "Closes #5288", the deviation note (Jobs tabs include `all`; no history tab). Run `/pr-review-toolkit:review-pr`, fix confirmed findings inline, then `gh pr merge <N> --squash` (merge queue; never `--admin`).
