# Built-in EDR Listing UI — Ready-to-Deploy Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the built-in EDR package listings (Huntress, SentinelOne) in the Software Library read as first-class and visibly ready-to-deploy, surfacing the exact missing setup step only when one exists.

**Architecture:** Frontend-only (`apps/web`). A provider-branding map + a readiness hook (reusing existing `GET /huntress/integration`) + a presentational `BuiltinPackageDetail`. `SoftwareCatalog` fetches readiness once per present provider and passes it down to cards and the detail body; the Deploy path preselects the clicked package into `DeploymentWizard`. No backend changes.

**Tech Stack:** React (islands), TypeScript, Tailwind v4, lucide-react, Vitest + @testing-library/react (jsdom).

**Spec:** `docs/superpowers/specs/integrations/2026-07-06-builtin-edr-listing-ui-design.md`

## Global Constraints

- Frontend only — **no backend/API/migration changes**. If a needed readiness signal is missing, stop and flag it; do not add endpoints silently.
- Reads go through `fetchWithAuth` (`apps/web/src/stores/auth`). Mutations go through `runAction` (`apps/web/src/lib/runAction`) — repo `no-silent-mutations` rule. This change is read-only except the existing deploy dispatch (already wrapped).
- **No official brand marks/logos.** Providers use a tinted `ShieldCheck` lucide icon + accent, not a logo.
- Class-name composition uses `cn` from `@/lib/utils`. Theme-aware (works in light + dark).
- Test style matches `apps/web/src/components/software/SoftwareCatalog.test.tsx`: `vi.mock('../../stores/auth', ...)`, a `jsonResponse` helper, `render`/`screen`/`waitFor`.
- `IntegrationProvider = 'huntress' | 'sentinelone'` (today declared inline in `SoftwareCatalog.tsx:17`). Task 1 moves the canonical definition to `providerBranding.ts`; `SoftwareCatalog` imports it.
- **Worktree hazard:** `SoftwareCatalog.tsx` and `DeploymentWizard.tsx` may carry unrelated uncommitted WIP (installer-variables shaping) on branch `ToddHebebrand/software-deploy-UI`. Before starting, confirm those files are in a known state (committed or stashed) so edits don't collide. See "Pre-flight" below.

---

## Pre-flight (do once before Task 1)

- [ ] Confirm the working tree for `SoftwareCatalog.tsx` / `DeploymentWizard.tsx` is clean or the WIP is committed/stashed:

Run: `git -C . status --short apps/web/src/components/software/`
Expected: no `M` on `SoftwareCatalog.tsx` / `DeploymentWizard.tsx` you don't own. If there is WIP, coordinate (commit/stash) before proceeding — do not overwrite it.

- [ ] Confirm the web test command runs:

Run: `pnpm --filter @breeze/web test -- --run src/components/software/SoftwareCatalog.test.tsx`
Expected: existing suite passes (baseline green).

---

## Task 1: Provider branding map

**Files:**
- Create: `apps/web/src/components/software/providerBranding.ts`
- Test: `apps/web/src/components/software/providerBranding.test.ts`

**Interfaces:**
- Produces:
  - `type IntegrationProvider = 'huntress' | 'sentinelone'`
  - `interface ProviderBranding { label: string; icon: LucideIcon; accent: string; blurb: string; websiteUrl?: string }`
  - `function getProviderBranding(p: IntegrationProvider): ProviderBranding`
  - `function isIntegrationProvider(v: unknown): v is IntegrationProvider`

- [ ] **Step 1: Write the failing test**

```ts
// providerBranding.test.ts
import { describe, expect, it } from 'vitest';
import { getProviderBranding, isIntegrationProvider } from './providerBranding';

describe('providerBranding', () => {
  it('returns label, icon, accent, and blurb for huntress', () => {
    const b = getProviderBranding('huntress');
    expect(b.label).toBe('Huntress');
    expect(b.icon).toBeTypeOf('function'); // lucide icons are components
    expect(b.accent).toMatch(/\S/);
    expect(b.blurb.length).toBeGreaterThan(0);
  });

  it('returns branding for sentinelone', () => {
    expect(getProviderBranding('sentinelone').label).toBe('SentinelOne');
  });

  it('type-guards provider strings', () => {
    expect(isIntegrationProvider('huntress')).toBe(true);
    expect(isIntegrationProvider('nope')).toBe(false);
    expect(isIntegrationProvider(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/web test -- --run src/components/software/providerBranding.test.ts`
Expected: FAIL — cannot find module `./providerBranding`.

- [ ] **Step 3: Write minimal implementation**

```ts
// providerBranding.ts
import { ShieldCheck, type LucideIcon } from 'lucide-react';

export type IntegrationProvider = 'huntress' | 'sentinelone';

export interface ProviderBranding {
  label: string;
  icon: LucideIcon;
  /** Tailwind classes for the tinted icon tile + chip (theme-aware). NOT a logo. */
  accent: string;
  blurb: string;
  websiteUrl?: string;
}

const BRANDING: Record<IntegrationProvider, ProviderBranding> = {
  huntress: {
    label: 'Huntress',
    icon: ShieldCheck,
    accent: 'bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/40',
    blurb: 'Managed endpoint detection & response — installs the latest agent automatically.',
    websiteUrl: 'https://www.huntress.com',
  },
  sentinelone: {
    label: 'SentinelOne',
    icon: ShieldCheck,
    accent: 'bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/40',
    blurb: 'Autonomous EDR agent deployed from your uploaded installer.',
    websiteUrl: 'https://www.sentinelone.com',
  },
};

export function getProviderBranding(p: IntegrationProvider): ProviderBranding {
  return BRANDING[p];
}

export function isIntegrationProvider(v: unknown): v is IntegrationProvider {
  return v === 'huntress' || v === 'sentinelone';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/web test -- --run src/components/software/providerBranding.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/software/providerBranding.ts apps/web/src/components/software/providerBranding.test.ts
git commit -m "feat(software): provider branding map for built-in EDR listings"
```

---

## Task 2: Readiness hook (Huntress)

**Files:**
- Create: `apps/web/src/components/software/useEdrReadiness.ts`
- Test: `apps/web/src/components/software/useEdrReadiness.test.tsx`

**Interfaces:**
- Consumes: `IntegrationProvider` from Task 1; `fetchWithAuth`.
- Produces:
  - `interface ReadinessCheck { key: string; label: string; ok: boolean; detail?: string; fixHref?: string }`
  - `interface EdrReadiness { status: 'loading' | 'ready' | 'incomplete' | 'unknown'; checks: ReadinessCheck[]; mappedOrgCount?: number; firstGap?: ReadinessCheck }`
  - `function useEdrReadiness(providers: IntegrationProvider[]): Record<IntegrationProvider, EdrReadiness>`

Design notes:
- One fetch per present provider (there is one integration per partner, so the
  card grid + detail share a single fetch). Empty `providers` → no fetch.
- Huntress: `GET /huntress/integration` → `{ data: { isActive, hasAccountKey, lastSyncOrgs } | null }`.
- SentinelOne resolves to `status: 'unknown'` here; Task 6 wires it. (Keeps this
  task Huntress-only but the map shape final.)
- `fixHref` points at `/integrations` (the Integrations page hosting the Huntress card).

- [ ] **Step 1: Write the failing test**

```tsx
// useEdrReadiness.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEdrReadiness } from './useEdrReadiness';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

// Probe: renders the huntress readiness so we can assert via the DOM.
function Probe() {
  const map = useEdrReadiness(['huntress']);
  const r = map.huntress;
  return (
    <div>
      <span data-testid="status">{r.status}</span>
      <span data-testid="orgs">{r.mappedOrgCount ?? -1}</span>
      <span data-testid="gap">{r.firstGap?.key ?? 'none'}</span>
    </div>
  );
}

describe('useEdrReadiness (huntress)', () => {
  beforeEach(() => fetchMock.mockReset());

  it('reports ready when connected, account key set, and orgs mapped', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { isActive: true, hasAccountKey: true, lastSyncOrgs: 3 } }),
    );
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('orgs')).toHaveTextContent('3');
    expect(screen.getByTestId('gap')).toHaveTextContent('none');
  });

  it('reports incomplete with the account-key gap first', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { isActive: true, hasAccountKey: false, lastSyncOrgs: 3 } }),
    );
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('incomplete'));
    expect(screen.getByTestId('gap')).toHaveTextContent('accountKey');
  });

  it('reports incomplete/disconnected when data is null', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: null }));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('incomplete'));
    expect(screen.getByTestId('gap')).toHaveTextContent('connected');
  });

  it('reports unknown when the fetch fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, false));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unknown'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/web test -- --run src/components/software/useEdrReadiness.test.tsx`
Expected: FAIL — cannot find module `./useEdrReadiness`.

- [ ] **Step 3: Write minimal implementation**

```ts
// useEdrReadiness.ts
import { useEffect, useMemo, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import type { IntegrationProvider } from './providerBranding';

export interface ReadinessCheck {
  key: string;
  label: string;
  ok: boolean;
  detail?: string;
  fixHref?: string;
}

export interface EdrReadiness {
  status: 'loading' | 'ready' | 'incomplete' | 'unknown';
  checks: ReadinessCheck[];
  mappedOrgCount?: number;
  firstGap?: ReadinessCheck;
}

const LOADING: EdrReadiness = { status: 'loading', checks: [] };
const UNKNOWN: EdrReadiness = { status: 'unknown', checks: [] };
const HUNTRESS_FIX = '/integrations';

function finalize(checks: ReadinessCheck[], mappedOrgCount?: number): EdrReadiness {
  const firstGap = checks.find((c) => !c.ok);
  return {
    status: firstGap ? 'incomplete' : 'ready',
    checks,
    mappedOrgCount,
    firstGap,
  };
}

async function fetchHuntress(): Promise<EdrReadiness> {
  const res = await fetchWithAuth('/huntress/integration');
  if (!res.ok) return UNKNOWN;
  const json = (await res.json()) as {
    data?: { isActive?: boolean; hasAccountKey?: boolean; lastSyncOrgs?: number | null } | null;
  };
  const data = json.data ?? null;
  const connected = !!data && data.isActive === true;
  const accountKey = !!data?.hasAccountKey;
  const mappedOrgCount = data?.lastSyncOrgs ?? 0;
  const checks: ReadinessCheck[] = [
    { key: 'connected', label: 'Integration connected', ok: connected, fixHref: HUNTRESS_FIX },
    { key: 'accountKey', label: 'Account key configured', ok: accountKey,
      detail: accountKey ? undefined : 'Add your Huntress account key in Integrations', fixHref: HUNTRESS_FIX },
    { key: 'orgsMapped', label: 'Organizations mapped', ok: mappedOrgCount > 0,
      detail: `${mappedOrgCount} org${mappedOrgCount === 1 ? '' : 's'} mapped`, fixHref: HUNTRESS_FIX },
  ];
  return finalize(checks, mappedOrgCount);
}

export function useEdrReadiness(
  providers: IntegrationProvider[],
): Record<IntegrationProvider, EdrReadiness> {
  const key = useMemo(() => Array.from(new Set(providers)).sort().join(','), [providers]);
  const [map, setMap] = useState<Record<IntegrationProvider, EdrReadiness>>({
    huntress: LOADING,
    sentinelone: LOADING,
  });

  useEffect(() => {
    let cancelled = false;
    const wanted = key ? (key.split(',') as IntegrationProvider[]) : [];
    if (wanted.includes('huntress')) {
      setMap((m) => ({ ...m, huntress: LOADING }));
      fetchHuntress()
        .then((r) => { if (!cancelled) setMap((m) => ({ ...m, huntress: r })); })
        .catch(() => { if (!cancelled) setMap((m) => ({ ...m, huntress: UNKNOWN })); });
    }
    // sentinelone: wired in Task 6; stays 'unknown' until then.
    if (wanted.includes('sentinelone')) {
      setMap((m) => ({ ...m, sentinelone: UNKNOWN }));
    }
    return () => { cancelled = true; };
  }, [key]);

  return map;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/web test -- --run src/components/software/useEdrReadiness.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/software/useEdrReadiness.ts apps/web/src/components/software/useEdrReadiness.test.tsx
git commit -m "feat(software): EDR readiness hook (Huntress) reusing /huntress/integration"
```

---

## Task 3: BuiltinPackageDetail component

**Files:**
- Create: `apps/web/src/components/software/BuiltinPackageDetail.tsx`
- Test: `apps/web/src/components/software/BuiltinPackageDetail.test.tsx`

**Interfaces:**
- Consumes: `getProviderBranding`, `IntegrationProvider` (Task 1); `EdrReadiness`, `ReadinessCheck` (Task 2).
- Produces:
  - `interface BuiltinPackageDetailProps { name: string; provider: IntegrationProvider; readiness: EdrReadiness; onDeploy: () => void }`
  - `export default function BuiltinPackageDetail(props): JSX.Element`

Behavior (from spec):
- Header: tinted provider icon + name + blurb + "Managed built-in" chip.
- Readiness rows from `readiness.checks` (check icon when ok, alert icon when not).
- All green (`status==='ready'`): confident line `Ready to deploy to N mapped orgs`; enabled Deploy.
- Any gap (`status==='incomplete'`): one highlighted next step from `firstGap` (its `detail`, linking to `fixHref`); Deploy disabled with `title` naming the gap.
- `status==='unknown'`: "Couldn't verify setup" note; Deploy stays enabled (defer to the server's fail-fast) with a neutral title.
- `status==='loading'`: a spinner row.

- [ ] **Step 1: Write the failing test**

```tsx
// BuiltinPackageDetail.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import BuiltinPackageDetail from './BuiltinPackageDetail';
import type { EdrReadiness } from './useEdrReadiness';

const ready: EdrReadiness = {
  status: 'ready',
  mappedOrgCount: 2,
  checks: [
    { key: 'connected', label: 'Integration connected', ok: true },
    { key: 'accountKey', label: 'Account key configured', ok: true },
    { key: 'orgsMapped', label: 'Organizations mapped', ok: true, detail: '2 orgs mapped' },
  ],
};

const missingKey: EdrReadiness = {
  status: 'incomplete',
  checks: [
    { key: 'connected', label: 'Integration connected', ok: true },
    { key: 'accountKey', label: 'Account key configured', ok: false,
      detail: 'Add your Huntress account key in Integrations', fixHref: '/integrations' },
    { key: 'orgsMapped', label: 'Organizations mapped', ok: true, detail: '2 orgs mapped' },
  ],
  firstGap: { key: 'accountKey', label: 'Account key configured', ok: false,
    detail: 'Add your Huntress account key in Integrations', fixHref: '/integrations' },
};

describe('BuiltinPackageDetail', () => {
  it('shows a confident ready state and fires onDeploy', () => {
    const onDeploy = vi.fn();
    render(<BuiltinPackageDetail name="Huntress EDR Agent" provider="huntress" readiness={ready} onDeploy={onDeploy} />);
    expect(screen.getByText(/Ready to deploy to 2 mapped orgs/i)).toBeInTheDocument();
    // No prereq warnings when ready.
    expect(screen.queryByText(/account key in Integrations/i)).not.toBeInTheDocument();
    const deploy = screen.getByRole('button', { name: /^Deploy$/ });
    expect(deploy).not.toBeDisabled();
    fireEvent.click(deploy);
    expect(onDeploy).toHaveBeenCalledTimes(1);
  });

  it('surfaces exactly the one missing step and disables Deploy', () => {
    render(<BuiltinPackageDetail name="Huntress EDR Agent" provider="huntress" readiness={missingKey} onDeploy={vi.fn()} />);
    expect(screen.getByText(/Add your Huntress account key in Integrations/i)).toBeInTheDocument();
    const deploy = screen.getByRole('button', { name: /^Deploy$/ });
    expect(deploy).toBeDisabled();
    expect(deploy).toHaveAttribute('title', expect.stringMatching(/account key/i));
  });

  it('defers to the server when readiness is unknown (Deploy stays enabled)', () => {
    render(<BuiltinPackageDetail name="Huntress EDR Agent" provider="huntress"
      readiness={{ status: 'unknown', checks: [] }} onDeploy={vi.fn()} />);
    expect(screen.getByText(/Couldn.t verify setup/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Deploy$/ })).not.toBeDisabled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/web test -- --run src/components/software/BuiltinPackageDetail.test.tsx`
Expected: FAIL — cannot find module `./BuiltinPackageDetail`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// BuiltinPackageDetail.tsx
import { shield, CheckCircle2, AlertTriangle, ExternalLink, Loader2, HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getProviderBranding, type IntegrationProvider } from './providerBranding';
import type { EdrReadiness } from './useEdrReadiness';

export interface BuiltinPackageDetailProps {
  name: string;
  provider: IntegrationProvider;
  readiness: EdrReadiness;
  onDeploy: () => void;
}

export default function BuiltinPackageDetail({ name, provider, readiness, onDeploy }: BuiltinPackageDetailProps) {
  const branding = getProviderBranding(provider);
  const Icon = branding.icon;
  const ready = readiness.status === 'ready';
  const gap = readiness.firstGap;
  const disabled = readiness.status === 'incomplete';
  const deployTitle = disabled && gap ? `Resolve: ${gap.label}` : 'Deploys to mapped organizations only';

  return (
    <div className="mt-4 space-y-5">
      <div className="flex items-start gap-3">
        <div className={cn('flex h-12 w-12 items-center justify-center rounded-md border', branding.accent)}>
          <Icon className="h-6 w-6" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold">{name}</h3>
            <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium', branding.accent)}>
              Managed built-in
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{branding.blurb}</p>
          {branding.websiteUrl && (
            <a href={branding.websiteUrl} target="_blank" rel="noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              {branding.label} website <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>

      <div className="rounded-md border bg-muted/30 p-4">
        {readiness.status === 'loading' && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking setup…
          </div>
        )}
        {readiness.status === 'unknown' && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <HelpCircle className="h-4 w-4" /> Couldn&apos;t verify setup — deploy will confirm on the server.
          </div>
        )}
        {(ready || readiness.status === 'incomplete') && (
          <ul className="space-y-2">
            {readiness.checks.map((c) => (
              <li key={c.key} className="flex items-center gap-2 text-sm">
                {c.ok
                  ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  : <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />}
                <span className={cn(!c.ok && 'font-medium')}>{c.label}</span>
                {c.detail && <span className="text-xs text-muted-foreground">· {c.detail}</span>}
              </li>
            ))}
          </ul>
        )}
        {ready && (
          <p className="mt-3 text-sm font-medium text-emerald-700 dark:text-emerald-400">
            Ready to deploy{typeof readiness.mappedOrgCount === 'number' ? ` to ${readiness.mappedOrgCount} mapped org${readiness.mappedOrgCount === 1 ? '' : 's'}` : ''}.
          </p>
        )}
        {disabled && gap && (
          <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <p className="font-medium">Next step: {gap.label}</p>
            {gap.detail && <p className="mt-0.5 text-muted-foreground">{gap.detail}</p>}
            {gap.fixHref && (
              <a href={gap.fixHref} className="mt-1 inline-flex items-center gap-1 text-xs font-medium underline">
                Open Integrations <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end">
        <button
          type="button"
          disabled={disabled}
          title={deployTitle}
          onClick={onDeploy}
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Deploy
        </button>
      </div>
    </div>
  );
}
```

Note: fix the import line — use `ShieldCheck` is provided via branding, so the
component imports only `CheckCircle2, AlertTriangle, ExternalLink, Loader2, HelpCircle`
from `lucide-react` (remove the stray `shield`). Correct first line:

```tsx
import { CheckCircle2, AlertTriangle, ExternalLink, Loader2, HelpCircle } from 'lucide-react';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/web test -- --run src/components/software/BuiltinPackageDetail.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/software/BuiltinPackageDetail.tsx apps/web/src/components/software/BuiltinPackageDetail.test.tsx
git commit -m "feat(software): BuiltinPackageDetail — readiness panel + guided deploy CTA"
```

---

## Task 4: Wire SoftwareCatalog (cards, detail delegation, preselect)

**Files:**
- Modify: `apps/web/src/components/software/SoftwareCatalog.tsx`
- Modify: `apps/web/src/components/software/SoftwareCatalog.test.tsx`

**Interfaces:**
- Consumes: `getProviderBranding`, `isIntegrationProvider`, `IntegrationProvider` (Task 1); `useEdrReadiness`, `EdrReadiness` (Task 2); `BuiltinPackageDetail` (Task 3).
- Produces: a `deployPackageId: string | null` passed to `DeploymentWizard` as `preselectedCatalogId` (Task 5 consumes it).

Changes:
1. Replace the inline `type IntegrationProvider` (line 17) with an import from `./providerBranding`; keep the local `SoftwareItem` type.
2. Derive present built-in providers and call the readiness hook:
   ```tsx
   const builtinProviders = useMemo(
     () => Array.from(new Set(catalogItems.map(i => i.integrationProvider).filter(isIntegrationProvider))),
     [catalogItems],
   );
   const readinessMap = useEdrReadiness(builtinProviders);
   ```
3. Card icon: when `item.integrationProvider` is set, render the tinted provider icon tile instead of the grey `Package` box.
4. Card readiness pill: for built-in items show a pill from `readinessMap[provider].status` — `ready`→green "Ready", `incomplete`→amber "Setup needed", `loading`→"Checking…", `unknown`→ nothing (neutral).
5. Remove the Huntress "upload" cue: keep `needsInstallerUpload` for **SentinelOne only** (it already is), but for Huntress the card must show no upload text and an enabled Deploy.
6. Deploy preselect: introduce `const [deployPackageId, setDeployPackageId] = useState<string | null>(null)`. Card & detail Deploy buttons call `setDeployPackageId(item.id); setShowDeployWizard(true)`. When the wizard closes, reset to `null`.
7. Detail modal: when `selectedSoftware.integrationProvider` is set, render `<BuiltinPackageDetail name=... provider=... readiness={readinessMap[provider]} onDeploy={() => { setDeployPackageId(selectedSoftware.id); setSelectedSoftware(null); setShowDeployWizard(true); }} />` in place of the current built-in Details body (the "managed by" note + generic Deploy). Non-built-in items keep the existing Details/Delete/Deploy body.
8. Pass `preselectedCatalogId={deployPackageId ?? undefined}` to `<DeploymentWizard />`.

- [ ] **Step 1: Add failing tests to `SoftwareCatalog.test.tsx`**

Extend the existing `built-in packages` describe block. The DeploymentWizard is mocked to `null`; change the mock to a probe that echoes its `preselectedCatalogId` so we can assert preselect:

```tsx
// Replace the existing DeploymentWizard mock with a probe.
vi.mock('./DeploymentWizard', () => ({
  default: (props: { preselectedCatalogId?: string }) => (
    <div data-testid="wizard">wizard:{props.preselectedCatalogId ?? 'none'}</div>
  ),
}));
```

Add tests (huntress readiness fetch now happens — mock it as the 2nd call):

```tsx
it('shows a Ready pill and no upload cue for a ready Huntress package', async () => {
  fetchMock
    .mockResolvedValueOnce(jsonResponse({ data: [BUILTIN_ITEM] }))          // GET /software/catalog
    .mockResolvedValueOnce(jsonResponse({ data: { isActive: true, hasAccountKey: true, lastSyncOrgs: 2 } })); // GET /huntress/integration

  render(<SoftwareCatalog />);
  await waitFor(() => expect(screen.getByText('Huntress EDR Agent')).toBeInTheDocument());
  await waitFor(() => expect(screen.getByText(/^Ready$/)).toBeInTheDocument());
  expect(screen.queryByText(/Upload installer/i)).not.toBeInTheDocument();
});

it('preselects the package into the deploy wizard when Deploy is clicked', async () => {
  fetchMock
    .mockResolvedValueOnce(jsonResponse({ data: [BUILTIN_ITEM] }))
    .mockResolvedValueOnce(jsonResponse({ data: { isActive: true, hasAccountKey: true, lastSyncOrgs: 2 } }));

  render(<SoftwareCatalog />);
  await waitFor(() => expect(screen.getByText('Huntress EDR Agent')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /^Deploy$/ }));
  expect(await screen.findByTestId('wizard')).toHaveTextContent('wizard:builtin-huntress');
});

it('shows the BuiltinPackageDetail readiness panel when a built-in is opened', async () => {
  fetchMock
    .mockResolvedValueOnce(jsonResponse({ data: [BUILTIN_ITEM] }))
    .mockResolvedValueOnce(jsonResponse({ data: { isActive: true, hasAccountKey: false, lastSyncOrgs: 2 } }));

  render(<SoftwareCatalog />);
  await waitFor(() => expect(screen.getByText('Huntress EDR Agent')).toBeInTheDocument());
  fireEvent.click(screen.getByText('Huntress EDR Agent'));
  expect(await screen.findByText(/Next step: Account key configured/i)).toBeInTheDocument();
});
```

Also update the existing built-in tests that assumed the old body: the test
`hides Delete for a built-in package and shows the managed-by note` (lines 119-130)
now asserts the new panel — change its assertion from `/managed by the Huntress
integration/i` to `/Managed built-in/i`, and keep the `no Delete button` check.
The two SentinelOne tests still pass unchanged (S1 keeps the upload cue and, with
readiness `unknown` in this task, no pill).

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm --filter @breeze/web test -- --run src/components/software/SoftwareCatalog.test.tsx`
Expected: FAIL — new assertions (Ready pill, preselect, "Next step") not met; the edited managed-by test fails on old text.

- [ ] **Step 3: Implement the SoftwareCatalog changes**

Apply changes 1-8 above. Key snippets:

Import line (replace inline type at line 17):
```tsx
import { getProviderBranding, isIntegrationProvider, type IntegrationProvider } from './providerBranding';
import { useEdrReadiness } from './useEdrReadiness';
import BuiltinPackageDetail from './BuiltinPackageDetail';
```

Readiness pill helper (module scope):
```tsx
function ReadinessPill({ status }: { status: 'loading' | 'ready' | 'incomplete' | 'unknown' }) {
  if (status === 'ready')
    return <span className="inline-flex items-center rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">Ready</span>;
  if (status === 'incomplete')
    return <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">Setup needed</span>;
  if (status === 'loading')
    return <span className="text-xs text-muted-foreground">Checking…</span>;
  return null;
}
```

Card icon tile (inside the card, replacing the grey `Package` box when built-in):
```tsx
{isIntegrationProvider(item.integrationProvider) ? (() => {
  const Icon = getProviderBranding(item.integrationProvider).icon;
  return (
    <div className={cn('flex h-10 w-10 items-center justify-center rounded-md border', getProviderBranding(item.integrationProvider).accent)}>
      <Icon className="h-5 w-5" />
    </div>
  );
})() : (
  <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted">
    <Package className="h-5 w-5 text-muted-foreground" />
  </div>
)}
```

Card Deploy handler now preselects:
```tsx
onClick={event => {
  event.stopPropagation();
  setDeployPackageId(item.id);
  setShowDeployWizard(true);
}}
```

Detail modal Details tab, built-in branch:
```tsx
{selectedSoftware.integrationProvider ? (
  <BuiltinPackageDetail
    name={selectedSoftware.name}
    provider={selectedSoftware.integrationProvider}
    readiness={readinessMap[selectedSoftware.integrationProvider]}
    onDeploy={() => {
      setDeployPackageId(selectedSoftware.id);
      setSelectedSoftware(null);
      setShowDeployWizard(true);
    }}
  />
) : (
  /* existing non-built-in Details body: description + Delete + Deploy */
)}
```

Wizard mount + reset on close:
```tsx
<DeploymentWizard preselectedCatalogId={deployPackageId ?? undefined} />
// in the wizard modal close button and overlay close:
onClick={() => { setShowDeployWizard(false); setDeployPackageId(null); }}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @breeze/web test -- --run src/components/software/SoftwareCatalog.test.tsx`
Expected: PASS (all built-in + delete tests).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @breeze/web exec tsc --noEmit`
Expected: no errors.

```bash
git add apps/web/src/components/software/SoftwareCatalog.tsx apps/web/src/components/software/SoftwareCatalog.test.tsx
git commit -m "feat(software): branded, readiness-aware built-in EDR cards + preselect deploy"
```

---

## Task 5: DeploymentWizard preselect prop

**Files:**
- Modify: `apps/web/src/components/software/DeploymentWizard.tsx`
- Test: `apps/web/src/components/software/DeploymentWizard.preselect.test.tsx` (new)

**Interfaces:**
- Consumes: `preselectedCatalogId?: string` from Task 4.
- Produces: on mount, when the catalog loads and contains the preselected id, sets `selectedSoftwareId` to it and `selectedVersionId` to that package's latest (or first) version.

Changes to `DeploymentWizard.tsx`:
1. Signature: `export default function DeploymentWizard({ preselectedCatalogId }: { preselectedCatalogId?: string } = {})`.
2. After `setSoftwareOptions(normalizedCatalog)` inside `fetchData`, apply the preselect (only if nothing selected yet):
   ```tsx
   if (preselectedCatalogId) {
     const match = normalizedCatalog.find((s) => s.id === preselectedCatalogId);
     if (match) {
       setSelectedSoftwareId(match.id);
       const latest = match.versions.find((v) => v.isLatest) ?? match.versions[0];
       if (latest) setSelectedVersionId(latest.id);
     }
   }
   ```
3. Add `preselectedCatalogId` to the `fetchData` `useCallback` dependency array.

- [ ] **Step 1: Write the failing test**

```tsx
// DeploymentWizard.preselect.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeploymentWizard from './DeploymentWizard';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../filters/DeviceTargetSelector', () => ({ DeviceTargetSelector: () => null }));
const fetchMock = vi.mocked(fetchWithAuth);

const ok = (payload: unknown): Response =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function route(url: string) {
  if (url === '/software/catalog') return ok({ data: [{ id: 'cat-9', name: 'Huntress EDR Agent', vendor: 'Huntress', category: 'security' }] });
  if (url === '/software/catalog/cat-9/versions') return ok({ data: [{ id: 'ver-1', version: 'latest', isLatest: true }] });
  return ok({ data: [] }); // /devices, /orgs/sites, /device-groups
}

describe('DeploymentWizard preselect', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string) => Promise.resolve(route(url)));
  });

  it('starts with the preselected package selected', async () => {
    render(<DeploymentWizard preselectedCatalogId="cat-9" />);
    // The selected package name appears in the wizard's selection UI once loaded.
    await waitFor(() => expect(screen.getAllByText('Huntress EDR Agent').length).toBeGreaterThan(0));
    // Its latest version option is present/selected.
    await waitFor(() => expect(screen.getByText(/latest/i)).toBeInTheDocument());
  });
});
```

Note: if the wizard's step-1 markup doesn't render the version label until the
package row is expanded, assert instead that the "Select Targets" step is
reachable (the Next control is enabled) — adjust the assertion to the actual
DOM after reading the step-1 render. The invariant under test: a preselected id
results in a non-empty `selectedSoftwareId`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/web test -- --run src/components/software/DeploymentWizard.preselect.test.tsx`
Expected: FAIL — `preselectedCatalogId` prop ignored; package not selected.

- [ ] **Step 3: Implement the preselect (changes 1-3 above)**

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/web test -- --run src/components/software/DeploymentWizard.preselect.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @breeze/web exec tsc --noEmit`
Expected: no errors.

```bash
git add apps/web/src/components/software/DeploymentWizard.tsx apps/web/src/components/software/DeploymentWizard.preselect.test.tsx
git commit -m "feat(software): DeploymentWizard accepts a preselected catalog package"
```

---

## Task 6: SentinelOne readiness wiring

**Files:**
- Modify: `apps/web/src/components/software/useEdrReadiness.ts`
- Modify: `apps/web/src/components/software/useEdrReadiness.test.tsx`

**Interfaces:**
- Consumes: the S1 integration status endpoint. **Confirm the exact route + site-token field** by reading `apps/api/src/routes/sentinelOne.ts` (mirror of the Huntress status endpoint). If no `hasSiteToken`-style boolean exists, flag it — do not add a backend field silently; fall back to a two-check readiness (connected + installer uploaded) and note the gap.
- S1 needs the built-in item's `versionCount` for the "installer uploaded" check. Extend the hook signature to accept it:
  - `useEdrReadiness(providers: IntegrationProvider[], opts?: { s1VersionCount?: number }): Record<IntegrationProvider, EdrReadiness>`

S1 checks:
- `connected`: S1 integration active.
- `installerUploaded`: `(opts?.s1VersionCount ?? 0) >= 1`, fixHref = `/software` (Versions tab), detail "Upload the SentinelOne installer".
- `siteTokenConfigured`: from the S1 status endpoint (if available).

- [ ] **Step 1: Add failing S1 tests** (mirror the Huntress probe with `useEdrReadiness(['sentinelone'], { s1VersionCount })`, asserting `installerUploaded` gap when 0, ready when connected + version + site token). Show the exact route mock once confirmed from `sentinelOne.ts`.

- [ ] **Step 2: Run to verify fail.**
Run: `pnpm --filter @breeze/web test -- --run src/components/software/useEdrReadiness.test.tsx`
Expected: FAIL (S1 still `unknown`).

- [ ] **Step 3: Implement `fetchSentinelOne(opts)` and route it in the effect** (replace the `unknown` placeholder for `sentinelone`). Thread `opts.s1VersionCount` through the memo key so a version upload re-derives readiness.

- [ ] **Step 4: Run to verify pass.**
Run: `pnpm --filter @breeze/web test -- --run src/components/software/useEdrReadiness.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire `s1VersionCount` from SoftwareCatalog** — pass the S1 built-in item's `versionCount` into the hook; update the S1 SoftwareCatalog tests so the S1 card shows a Ready/Setup pill instead of only the bare upload cue. Typecheck.

```bash
git add apps/web/src/components/software/useEdrReadiness.ts apps/web/src/components/software/useEdrReadiness.test.tsx apps/web/src/components/software/SoftwareCatalog.tsx apps/web/src/components/software/SoftwareCatalog.test.tsx
git commit -m "feat(software): SentinelOne readiness (installer upload + site token)"
```

---

## Task 7: Harden pass + full suite

**Files:**
- Modify: any of the above as needed.

- [ ] **Step 1:** Manually verify (dev server) the built-in detail in **dark mode** — accent tiles, amber next-step box, emerald ready line all legible. Fix any contrast issues in `providerBranding.ts` accents / component classes.
- [ ] **Step 2:** Edge: `lastSyncOrgs: 0` → "Setup needed" pill, org-mapping gap shown as the next step (not account key if the key is set). Confirm `firstGap` ordering (connected → accountKey → orgsMapped) matches the most-blocking-first intent; adjust order if product prefers surfacing account-key before org-mapping.
- [ ] **Step 3:** Run the full software suite + typecheck + lint:

Run: `pnpm --filter @breeze/web test -- --run src/components/software`
Run: `pnpm --filter @breeze/web exec tsc --noEmit`
Run: `pnpm --filter @breeze/web lint`
Expected: all green.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A apps/web/src/components/software/
git commit -m "chore(software): harden built-in EDR listing (dark mode, edge cases)"
```

---

## Self-Review notes

- **Spec coverage:** readiness panel (Tasks 2/3), branded/intentional non-logo treatment (Tasks 1/3/4), guided deploy preselect (Tasks 4/5), hide-prereq-when-ready (Task 3 ready branch + Task 4 removing Huntress upload cue), both providers (Tasks 2/6). Covered.
- **No backend change:** all readiness from `/huntress/integration` (exists) and `/sentinelone/...` status (confirm field in Task 6; flag if missing).
- **Type consistency:** `IntegrationProvider` defined once (Task 1), imported everywhere; `EdrReadiness`/`ReadinessCheck` defined in Task 2 and consumed by Tasks 3/4; `preselectedCatalogId` produced in Task 4, consumed in Task 5.
- **Open confirm (Task 6):** exact SentinelOne status route + site-token boolean field name — read `sentinelOne.ts` before writing that test; do not invent a field.
- **Open confirm (Task 2/3):** the Integrations page route for `fixHref` is assumed `/integrations`; verify against `apps/web/src/pages` and adjust if it differs.
