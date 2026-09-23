---
tracking_issue: LanternOps/breeze#6768
---

# System Page W02 (Web) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the platform-admin `/admin/system` page with a **Connections** tab (default) that renders W01's connections report and a **Deprecations** tab that hosts the report page from PR #6744, redirect the old `/settings/system/deprecations` URL, and replace #6744's sidebar entry with one "System" entry.

**Architecture:** One Astro route (`pages/admin/system.astro`) mounts a React island `SystemPage` whose initial tab comes from `Astro.url.searchParams` (the app runs `output: 'server'`, `apps/web/astro.config.mjs:62`). Tab changes update `?tab=` with `history.replaceState`. `ConnectionsTab` fetches `GET /api/v1/admin/system/connections` through `fetchWithAuth`. Pure helpers in `connectionsTypes.ts` do filtering, the secret guard and docs-URL checks, so the rules have their own unit tests. `DeprecationsTab` is #6744's `SystemDeprecationsPage` moved with `git mv`. Its strings stay in `settings.json → systemDeprecations`.

**Tech Stack:** Astro 7 (SSR, node adapter), React 19, react-i18next (namespaces per JSON file), Tailwind 4, lucide-react 1.21, Vitest 4 + @testing-library/react (jsdom).

**Spec:** `docs/superpowers/specs/platform-ci/2026-09-23-system-connections-page-design.md` (approved by Todd and the Fable quorum on 2026-09-23; the amendments are adopted). §4 "Web" is the section this plan implements. D1, D2, D4, D5, D6, D7 and D8 constrain it.

## Global Constraints

- **Start gate:** begin only after **PR #6744 and the W01 PR are both merged to `origin/main`**. This plan is written against post-#6744 main. Check the gate in Pre-flight step P2. If either PR is missing, stop and report. Do not cherry-pick either PR.
- **Worktree:** a fresh branch off current `origin/main`, e.g. `feat/system-page-w02`. Do not implement on `spec/system-connections-page`, and do not read code in any other worktree (they are stale).
- **D1 read-only:** the Connections tab has no inputs except the "show problems only" filter and the Refresh button. There is no Save or edit control. A test enforces this.
- **D2 / D8 secrets:** a var renders a value **only when `secret === false` (strict equality)**, `set === true`, and the value is a non-empty string with no URL userinfo (`://…@`). Anything else renders the `set` / `not set` pill. The client applies this rule even when the API payload wrongly includes `value`. Never show a mask or the last 4 characters.
- **D4 wording:** the tab must say that "Enabled" means configured, not that the service was contacted (`admin.systemPage.connections.enabledMeaning`).
- **D5 footnote:** the tab must say that it shows the API container's environment only (`admin.systemPage.connections.footnote`).
- **D6 access:** the page adds no client-side permission logic. The API gate (`platformAdminMiddleware`) decides. A 403 renders the platform-admin panel (same pattern as `apps/web/src/components/admin/AiKillSwitch.tsx:59-65`).
- **D7 routing:** `/admin/system` has tabs `connections` (default) and `deprecations` (`?tab=deprecations`). `/settings/system/deprecations` becomes `return Astro.redirect('/admin/system?tab=deprecations', 301);`. The sidebar has exactly one "System" entry in Administration, and it replaces #6744's "Deprecations" entry.
- **Response contract (from spec §2):** the TS type `ConnectionsReport` in Task 1 is the contract. The HTTP body is `{ data: ConnectionsReport }`, the envelope every sibling admin route uses (`c.json({ data: … })` in #6744's `routes/admin/deprecations.ts`; `body.data` in `AiKillSwitch.tsx:69`). Pre-flight P3 confirms W01 matches.
- **Group ids:** W02 localizes these `ConnectionGroup` ids: `core`, `email`, `storage-backups`, `ai`, `billing`, `microsoft-365`, `identity-sso`, `remote-access`, `agent-releases`, `observability`, `security-abuse`, `integrations`. **W01 owns the ids.** If P3 shows W01 used different ids, rename the `groups.*` keys in all 8 `admin.json` files in Task 2 to match W01 exactly. Keep the English labels in the table below. An unknown id falls back to the raw id (`defaultValue`), so a new W01 group never renders a raw i18n key.
- **Entry labels and reasons are rendered as the API sends them (English).** The spec comment "web localizes by id" is deliberately not implemented in W02. The labels are product and service names (PostgreSQL, Redis, SMTP, Sentry…). Translating ~35 proper nouns in 7 locales would only add exact-English duplicates against `translationCoverage.test.ts` baselines, and `reason` is generated text that names env vars. Record this in the PR body as a follow-up candidate.
- **Locales:** every new key goes into all 8 locales (`en`, `pt-BR`, `es-419`, `fr-FR`, `fr-CA`, `de-DE`, `it-IT`, `tr-TR`) in the same commit that adds it. Non-English values in this plan are **machine-drafted**. The PR body must say: "pt-BR, es-419, fr-FR, fr-CA, de-DE, it-IT and tr-TR strings are machine-drafted pending native review." Keep protected literals verbatim (`API`, `Breeze`, `Microsoft 365`, `{{…}}` tokens). `localeParity.test.ts:213-261` enforces this.
- **i18n gates that must stay green** (all in `apps/web/src/lib/i18n/`): `titleKeyUsage.test.ts` (every `titleKey="…"` resolves in `en/pages.json`), `localeParity.test.ts` (same keys, interpolations, protected names, no bare route paths as values, no HTML entities), `translationCoverage.test.ts` (per-namespace exact-English duplicate baselines, `:1029-1062`) and `keyUsage.test.ts` (every literal `t()` key resolves; dynamic keys need `/* i18n-dynamic */` and an existing group prefix, `:196-218`). Also `apps/web/src/lib/__tests__/settingsPageRegistry.test.ts` (redirect-only settings pages are exempt through `isRedirectOnly`, `:45-48`, `:60`) and `apps/web/src/components/layout/Sidebar.nav.test.tsx:118-128` (every Administration item is `platformAdminOnly`, and no other section has one).
- **Never put a route path as a locale value** (`localeParity.test.ts:303-345`). Inline URLs in code.
- **tsc:** run `NODE_OPTIONS=--max-old-space-size=12288 pnpm exec tsc --noEmit` in `apps/web` and check `$?` directly. **Never pipe tsc to `tail`/`head`**: a pipe hides a heap OOM as a false green.
- **Commits:** one per task. Every message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Do not push. The orchestrator opens the PR.

### English strings (authoritative; full list)

`apps/web/src/locales/en/admin.json`, under the existing root `admin` object:

| Key (`admin.systemPage.` …) | English |
|---|---|
| `title` | System |
| `description` | Deployment-wide status for platform administrators. This page is read-only. |
| `tabs.label` | System sections |
| `tabs.connections` | Connections |
| `tabs.deprecations` | Deprecations |
| `connections.enabledMeaning` | Enabled means configured. Breeze does not contact the service to check that it responds. |
| `connections.footnote` | Shows the API container's environment only. The web, portal and worker containers are not included. |
| `connections.meta` | Running version {{version}} · {{mode}} |
| `connections.deployMode.hosted` | Hosted |
| `connections.deployMode.self_host` | Self-hosted |
| `connections.refresh` | Refresh |
| `connections.loading` | Loading connection status… |
| `connections.errors.load` | Could not load connection status. |
| `connections.platformAdmin.title` | Platform admin access required |
| `connections.platformAdmin.description` | Connection status covers the whole deployment, so only platform administrators can view it. |
| `connections.summaryLabel` | Connection summary |
| `connections.problemsOnly` | Show problems only |
| `connections.noProblems` | No problems found. Every connection is enabled or disabled. |
| `connections.empty` | No connections are registered. |
| `connections.status.enabled` | Enabled |
| `connections.status.disabled` | Disabled |
| `connections.status.misconfigured` | Misconfigured |
| `connections.status.required_missing` | Required, missing |
| `connections.var.set` | set |
| `connections.var.notSet` | not set |
| `connections.var.secret` | Secret value, never shown |
| `connections.docs` | Read the docs |
| `connections.groups.core` | Core services |
| `connections.groups.email` | Email |
| `connections.groups.storage-backups` | Storage and backups |
| `connections.groups.ai` | AI |
| `connections.groups.billing` | Billing |
| `connections.groups.microsoft-365` | Microsoft 365 |
| `connections.groups.identity-sso` | Identity and SSO |
| `connections.groups.remote-access` | Remote access |
| `connections.groups.agent-releases` | Agent releases |
| `connections.groups.observability` | Observability |
| `connections.groups.security-abuse` | Security and abuse |
| `connections.groups.integrations` | Integrations |

`apps/web/src/locales/en/pages.json` → `titles.adminSystem`: "System". It replaces #6744's `titles.settingsSystemDeprecations`.
`apps/web/src/locales/en/common.json` → `nav.system`: "System". It replaces #6744's `nav.systemDeprecations`.

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `apps/web/src/components/admin/system/connectionsTypes.ts` | Create | Response types (spec §2), `isProblemStatus`, `displayableValue` (client secret guard), `filterGroups`, `safeDocsUrl` |
| `apps/web/src/components/admin/system/connectionsTypes.test.ts` | Create | Unit tests for the helpers |
| `apps/web/src/components/admin/system/ConnectionsTab.tsx` | Create | Fetch plus the summary strip, filter, grouped cards, pills, docs link, footnote, and the 403/loading/error states |
| `apps/web/src/components/admin/system/ConnectionsTab.test.tsx` | Create | Component tests |
| `apps/web/src/components/admin/system/DeprecationsTab.tsx` | Move (`git mv` from `components/settings/SystemDeprecationsPage.tsx`) | #6744 report, demoted to a tab (h2, no page padding) |
| `apps/web/src/components/admin/system/DeprecationsTab.test.tsx` | Move (`git mv` from `components/settings/SystemDeprecationsPage.test.tsx`) | #6744 tests plus a heading-level assertion |
| `apps/web/src/components/admin/system/SystemPage.tsx` | Create | Page header, tablist, URL sync, `parseSystemTab` |
| `apps/web/src/components/admin/system/SystemPage.test.tsx` | Create | Tab/URL tests |
| `apps/web/src/pages/admin/system.astro` | Create | Route; passes `initialTab` from the query string |
| `apps/web/src/pages/settings/system/deprecations.astro` | Replace | 301 redirect stub |
| `apps/web/src/lib/__tests__/systemPageRoutes.test.ts` | Create | Source-level assertions on the two `.astro` files (tests must not live under `src/pages`, where Astro would treat a `.ts` file as an endpoint) |
| `apps/web/src/components/layout/Sidebar.tsx` | Modify | Replace the Deprecations item with System (`ServerCog`) |
| `apps/web/src/components/layout/Sidebar.nav.test.tsx` | Modify | Replace #6744's Deprecations test with the System test |
| `apps/web/src/locales/*/admin.json` (8) | Modify | `admin.systemPage.*` |
| `apps/web/src/locales/*/pages.json` (8) | Modify | `titles.adminSystem` added, `titles.settingsSystemDeprecations` removed |
| `apps/web/src/locales/*/common.json` (8) | Modify | `nav.system` added, `nav.systemDeprecations` removed |
| `apps/web/src/lib/i18n/translationCoverage.test.ts` | Modify only if red | Raise the reviewed-duplicate baselines for proper nouns and cognates (Tasks 2, 4, 5) |

---

## Pre-flight (do once, before Task 1)

- [ ] **P1: Branch and install**

```bash
git fetch origin
git switch -c feat/system-page-w02 origin/main
pnpm install --frozen-lockfile
```

- [ ] **P2: Confirm that #6744 and W01 are on main**

```bash
gh pr view 6744 --json state,mergeCommit --jq '{state, sha: .mergeCommit.oid}'
test -f apps/web/src/components/settings/SystemDeprecationsPage.tsx && echo "6744 web present"
test -f apps/web/src/pages/settings/system/deprecations.astro && echo "6744 route present"
grep -n "systemDeprecations" apps/web/src/components/layout/Sidebar.tsx
grep -rn "system" apps/api/src/routes/admin/index.ts
test -f apps/api/src/system/connections/registry.ts && echo "W01 registry present"
```

Expected: state `MERGED`, all three `present` lines print, the Sidebar grep shows the `/settings/system/deprecations` item, and `routes/admin/index.ts` shows an `adminRoutes.route('/system', …)` mount. If anything is missing, **stop** and report "W02 blocked: #6744 / W01 not on main".

- [ ] **P3: Confirm the W01 contract (group ids and envelope)**

```bash
grep -n "ConnectionGroup" -A16 apps/api/src/system/connections/registry.ts | head -40
grep -rn "c.json(" apps/api/src/routes/admin/ | grep -i connection
grep -rn "buildConnectionsReport" apps/api/src --include='*.ts' -l
```

Expected: the `ConnectionGroup` union lists the 12 ids from Global Constraints, and the route returns `c.json({ data: buildConnectionsReport(process.env) }, …)`. If the ids differ, note W01's ids and use them for the `groups.*` keys in Task 2. If the route returns the bare report (no `data` envelope), change `body.data` to `body` in Task 2's `load()` and in its test fixture helper `ok()`, and note this in the PR body.

- [ ] **P4: Baseline green run of the gates this plan touches**

```bash
cd apps/web
pnpm exec vitest run src/lib/i18n src/lib/__tests__/settingsPageRegistry.test.ts src/components/layout/Sidebar.nav.test.tsx src/components/settings/SystemDeprecationsPage.test.tsx
```

Expected: all pass. If anything is red before you change it, record the failure (name and message) in your notes and the PR body. Do not fix unrelated reds.

---

### Task 1: Connections response types and pure helpers

**Files:**
- Create: `apps/web/src/components/admin/system/connectionsTypes.ts`
- Test: `apps/web/src/components/admin/system/connectionsTypes.test.ts`

**Interfaces:**
- Consumes: nothing (the shape is copied from spec §2).
- Produces (later tasks import these exact names):
  - `type ConnectionStatus = 'enabled' | 'disabled' | 'misconfigured' | 'required_missing'`
  - `const CONNECTION_STATUSES: readonly ConnectionStatus[]`
  - `interface ConnectionVarView { name: string; secret: boolean; set: boolean; value?: string }`
  - `interface ConnectionEntryView { id: string; label: string; docsUrl?: string | null; status: ConnectionStatus; reason?: string | null; vars: ConnectionVarView[] }`
  - `interface ConnectionGroupView { group: string; entries: ConnectionEntryView[] }`
  - `interface ConnectionsReport { version: string; deployMode: 'hosted' | 'self_host'; scope: 'api'; summary: Record<ConnectionStatus, number>; groups: ConnectionGroupView[] }`
  - `function isProblemStatus(status: ConnectionStatus): boolean`
  - `function displayableValue(v: ConnectionVarView): string | null`
  - `function filterGroups(groups: ConnectionGroupView[], problemsOnly: boolean): ConnectionGroupView[]`
  - `function safeDocsUrl(url: string | null | undefined): string | null`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/admin/system/connectionsTypes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  CONNECTION_STATUSES,
  displayableValue,
  filterGroups,
  isProblemStatus,
  safeDocsUrl,
  type ConnectionGroupView,
  type ConnectionVarView,
} from './connectionsTypes';

describe('isProblemStatus', () => {
  it('treats misconfigured and required_missing as problems, enabled and disabled as not', () => {
    expect(CONNECTION_STATUSES.filter(isProblemStatus)).toEqual(['misconfigured', 'required_missing']);
  });
});

describe('displayableValue (client-side D2/D8 guard)', () => {
  const base: ConnectionVarView = { name: 'X', secret: false, set: true, value: 'smtp.example.test' };

  it('returns the value only for an explicit secret:false var that is set', () => {
    expect(displayableValue(base)).toBe('smtp.example.test');
  });

  it('never returns a value for a secret var, even if the payload wrongly carries one', () => {
    expect(displayableValue({ ...base, secret: true, value: 'CANARY-secret' })).toBeNull();
  });

  it('treats a missing or non-boolean secret flag as secret (default-deny)', () => {
    const noFlag = { name: 'X', set: true, value: 'CANARY-noflag' } as unknown as ConnectionVarView;
    const truthyString = { ...base, secret: 'false' } as unknown as ConnectionVarView;
    expect(displayableValue(noFlag)).toBeNull();
    expect(displayableValue(truthyString)).toBeNull();
  });

  it('returns null when the var is not set or the value is empty or absent', () => {
    expect(displayableValue({ ...base, set: false })).toBeNull();
    expect(displayableValue({ ...base, value: '' })).toBeNull();
    expect(displayableValue({ name: 'X', secret: false, set: true })).toBeNull();
  });

  it('refuses a non-secret value that carries URL userinfo', () => {
    expect(displayableValue({ ...base, value: 'postgres://app:CANARY-pw@db:5432/breeze' })).toBeNull();
    expect(displayableValue({ ...base, value: 'https://user@host.example' })).toBeNull();
    expect(displayableValue({ ...base, value: 'https://api.example.com/path' })).toBe('https://api.example.com/path');
  });
});

describe('filterGroups', () => {
  const groups: ConnectionGroupView[] = [
    {
      group: 'core',
      entries: [
        { id: 'database', label: 'PostgreSQL', status: 'enabled', vars: [] },
        { id: 'redis', label: 'Redis', status: 'required_missing', vars: [] },
      ],
    },
    { group: 'email', entries: [{ id: 'smtp', label: 'SMTP', status: 'misconfigured', vars: [] }] },
    { group: 'observability', entries: [{ id: 'sentry', label: 'Sentry', status: 'disabled', vars: [] }] },
    { group: 'billing', entries: [] },
  ];

  it('returns every non-empty group unchanged when not filtering', () => {
    expect(filterGroups(groups, false).map((g) => g.group)).toEqual(['core', 'email', 'observability']);
    expect(filterGroups(groups, false)[0].entries).toHaveLength(2);
  });

  it('keeps only problem entries and drops groups left empty when filtering', () => {
    const filtered = filterGroups(groups, true);
    expect(filtered.map((g) => g.group)).toEqual(['core', 'email']);
    expect(filtered[0].entries.map((e) => e.id)).toEqual(['redis']);
  });
});

describe('safeDocsUrl', () => {
  it('accepts absolute https URLs', () => {
    expect(safeDocsUrl('https://docs.breezermm.com/deploy/environment/')).toBe('https://docs.breezermm.com/deploy/environment/');
  });

  it('rejects missing, relative, non-https and script URLs', () => {
    expect(safeDocsUrl(undefined)).toBeNull();
    expect(safeDocsUrl(null)).toBeNull();
    expect(safeDocsUrl('')).toBeNull();
    expect(safeDocsUrl('/deploy/environment/')).toBeNull();
    expect(safeDocsUrl('http://docs.breezermm.com/')).toBeNull();
    expect(safeDocsUrl('javascript:alert(1)')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd apps/web && pnpm exec vitest run src/components/admin/system/connectionsTypes.test.ts`
Expected: FAIL with `Failed to resolve import "./connectionsTypes"`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/components/admin/system/connectionsTypes.ts`:

```ts
/**
 * Web-side contract for GET /api/v1/admin/system/connections (W01).
 * Copied from the `buildConnectionsReport` shape in spec §2
 * (docs/superpowers/specs/platform-ci/2026-09-23-system-connections-page-design.md).
 * The route wraps it as `{ data: ConnectionsReport }`, like every admin route.
 */

export type ConnectionStatus = 'enabled' | 'disabled' | 'misconfigured' | 'required_missing';

/** Display order for the summary strip. */
export const CONNECTION_STATUSES: readonly ConnectionStatus[] = [
  'enabled',
  'disabled',
  'misconfigured',
  'required_missing',
];

export interface ConnectionVarView {
  name: string;
  secret: boolean;
  set: boolean;
  /** Only ever populated by the API for `secret: false` vars. The web re-checks anyway. */
  value?: string;
}

export interface ConnectionEntryView {
  id: string;
  label: string;
  docsUrl?: string | null;
  status: ConnectionStatus;
  /** Names vars, never values (spec invariant 4). English, rendered as sent. */
  reason?: string | null;
  vars: ConnectionVarView[];
}

export interface ConnectionGroupView {
  /** A W01 `ConnectionGroup` id, e.g. `core`, `email`, `storage-backups`. */
  group: string;
  entries: ConnectionEntryView[];
}

export interface ConnectionsReport {
  version: string;
  deployMode: 'hosted' | 'self_host';
  scope: 'api';
  summary: Record<ConnectionStatus, number>;
  groups: ConnectionGroupView[];
}

export function isProblemStatus(status: ConnectionStatus): boolean {
  return status === 'misconfigured' || status === 'required_missing';
}

// Same shape as the builder's runtime refusal (spec invariant 2): a value
// carrying URL userinfo is a credential, whatever the registry says.
const URL_USERINFO = /:\/\/[^/?#\s]*@/;

/**
 * D2/D8 on the client: the value is shown only when the API marked the var
 * `secret: false` (strict), the var is set, and the value is non-empty with
 * no URL userinfo. Every other case renders the set/not-set pill. This is
 * defense in depth — the API should never send `value` for a secret var.
 */
export function displayableValue(v: ConnectionVarView): string | null {
  if (v.secret !== false || v.set !== true) return null;
  if (typeof v.value !== 'string' || v.value.length === 0) return null;
  if (URL_USERINFO.test(v.value)) return null;
  return v.value;
}

export function filterGroups(groups: ConnectionGroupView[], problemsOnly: boolean): ConnectionGroupView[] {
  return groups
    .map((g) => (problemsOnly ? { ...g, entries: g.entries.filter((e) => isProblemStatus(e.status)) } : g))
    .filter((g) => g.entries.length > 0);
}

/** Only absolute https links are rendered; anything else (relative, http, javascript:) is dropped. */
export function safeDocsUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd apps/web && pnpm exec vitest run src/components/admin/system/connectionsTypes.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/admin/system/connectionsTypes.ts apps/web/src/components/admin/system/connectionsTypes.test.ts
git commit -m "feat(web): connections report types and secret-safe helpers (system page W02)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: ConnectionsTab component and its strings (8 locales)

**Files:**
- Create: `apps/web/src/components/admin/system/ConnectionsTab.tsx`
- Test: `apps/web/src/components/admin/system/ConnectionsTab.test.tsx`
- Modify: `apps/web/src/locales/{en,pt-BR,es-419,fr-FR,fr-CA,de-DE,it-IT,tr-TR}/admin.json` (add `admin.systemPage`)
- Modify (only if Step 6 is red): `apps/web/src/lib/i18n/translationCoverage.test.ts` (`admin.json` baselines)

**Interfaces:**
- Consumes (Task 1): `CONNECTION_STATUSES`, `displayableValue`, `filterGroups`, `safeDocsUrl`, `ConnectionEntryView`, `ConnectionStatus`, `ConnectionsReport`.
- Consumes (repo): `fetchWithAuth(url: string, options?)` from `@/stores/auth` (`apps/web/src/stores/auth.ts:1335`; relative URLs get the `/api/v1` base, as `AiKillSwitch.tsx:58` calls `'/admin/ai-kill-state'`).
- Produces: `export default function ConnectionsTab(): JSX.Element`, with no props. It adds all `admin.systemPage.*` keys, including `title`, `description` and `tabs.*`, which Task 4 uses.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/admin/system/ConnectionsTab.test.tsx`. The mock pattern mirrors `apps/web/src/components/admin/AiKillSwitch.test.tsx:1-19`.

```tsx
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import ConnectionsTab from './ConnectionsTab';

function jsonRes(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    version: '0.116.0',
    deployMode: 'self_host',
    scope: 'api',
    summary: { enabled: 2, disabled: 1, misconfigured: 1, required_missing: 0 },
    groups: [
      {
        group: 'core',
        entries: [
          {
            id: 'database',
            label: 'PostgreSQL',
            docsUrl: 'https://docs.breezermm.com/deploy/environment/',
            status: 'enabled',
            vars: [
              { name: 'DATABASE_URL', secret: true, set: true },
              { name: 'DB_POOL_SIZE', secret: false, set: true, value: '20' },
            ],
          },
          { id: 'redis', label: 'Redis', status: 'enabled', vars: [{ name: 'REDIS_URL', secret: true, set: true }] },
        ],
      },
      {
        group: 'email',
        entries: [
          {
            id: 'smtp',
            label: 'SMTP',
            status: 'misconfigured',
            reason: 'SMTP_HOST is set but SMTP_PASS is missing',
            vars: [
              { name: 'SMTP_HOST', secret: false, set: true, value: 'smtp.example.test' },
              { name: 'SMTP_PASS', secret: true, set: false },
            ],
          },
        ],
      },
      {
        group: 'observability',
        entries: [{ id: 'sentry', label: 'Sentry', status: 'disabled', vars: [{ name: 'SENTRY_DSN', secret: true, set: false }] }],
      },
    ],
    ...overrides,
  };
}

const ok = (overrides: Record<string, unknown> = {}) => jsonRes({ data: report(overrides) });

beforeEach(() => {
  fetchWithAuth.mockReset();
});

describe('ConnectionsTab', () => {
  it('reads the report from the platform-admin route', async () => {
    fetchWithAuth.mockResolvedValue(ok());
    render(<ConnectionsTab />);
    await screen.findByTestId('connections-summary');
    expect(fetchWithAuth).toHaveBeenCalledWith('/admin/system/connections');
  });

  it('shows a loading state while the request is in flight', () => {
    fetchWithAuth.mockReturnValue(new Promise(() => {}));
    render(<ConnectionsTab />);
    expect(screen.getByText('Loading connection status…')).toBeTruthy();
    expect(screen.queryByTestId('connections-summary')).toBeNull();
  });

  it('renders the summary strip: enabled and disabled always, problem counts only when non-zero', async () => {
    fetchWithAuth.mockResolvedValue(ok());
    render(<ConnectionsTab />);
    const summary = await screen.findByTestId('connections-summary');
    expect(within(summary).getByTestId('connections-summary-enabled').textContent).toBe('2 Enabled');
    expect(within(summary).getByTestId('connections-summary-disabled').textContent).toBe('1 Disabled');
    expect(within(summary).getByTestId('connections-summary-misconfigured').textContent).toBe('1 Misconfigured');
    expect(within(summary).queryByTestId('connections-summary-required_missing')).toBeNull();
  });

  it('renders cards grouped by localized section with status badge, reason and docs link', async () => {
    fetchWithAuth.mockResolvedValue(ok());
    render(<ConnectionsTab />);
    const core = await screen.findByTestId('connections-group-core');
    expect(within(core).getByRole('heading', { level: 2 }).textContent).toBe('Core services');
    expect(within(screen.getByTestId('connections-group-email')).getByRole('heading', { level: 2 }).textContent).toBe('Email');

    const smtp = screen.getByTestId('connection-card-smtp');
    expect(within(smtp).getByRole('heading', { level: 3 }).textContent).toBe('SMTP');
    expect(within(smtp).getByTestId('connection-status').textContent).toBe('Misconfigured');
    expect(within(smtp).getByTestId('connection-reason').textContent).toBe('SMTP_HOST is set but SMTP_PASS is missing');

    const db = screen.getByTestId('connection-card-database');
    const link = within(db).getByTestId('connection-docs') as HTMLAnchorElement;
    expect(link.href).toBe('https://docs.breezermm.com/deploy/environment/');
    expect(link.rel).toContain('noopener');
    expect(within(screen.getByTestId('connection-card-redis')).queryByTestId('connection-docs')).toBeNull();
  });

  it('falls back to the raw id for a group the locale does not know', async () => {
    fetchWithAuth.mockResolvedValue(
      ok({ groups: [{ group: 'brand-new-group', entries: [{ id: 'x', label: 'X', status: 'enabled', vars: [] }] }] }),
    );
    render(<ConnectionsTab />);
    const group = await screen.findByTestId('connections-group-brand-new-group');
    expect(within(group).getByRole('heading', { level: 2 }).textContent).toBe('brand-new-group');
  });

  it('renders secret vars as a set / not set pill and non-secret vars as their value', async () => {
    fetchWithAuth.mockResolvedValue(ok());
    render(<ConnectionsTab />);
    const dbUrl = await screen.findByTestId('connection-var-DATABASE_URL');
    expect(within(dbUrl).getByTestId('connection-var-pill').textContent).toContain('set');
    expect(within(dbUrl).queryByTestId('connection-var-value')).toBeNull();

    const smtpPass = screen.getByTestId('connection-var-SMTP_PASS');
    expect(within(smtpPass).getByTestId('connection-var-pill').textContent).toContain('not set');

    const smtpHost = screen.getByTestId('connection-var-SMTP_HOST');
    expect(within(smtpHost).getByTestId('connection-var-value').textContent).toBe('smtp.example.test');
    expect(within(smtpHost).queryByTestId('connection-var-pill')).toBeNull();
  });

  it('never renders a value for a secret var, even when the payload wrongly includes one', async () => {
    fetchWithAuth.mockResolvedValue(
      ok({
        groups: [
          {
            group: 'core',
            entries: [
              {
                id: 'leaky',
                label: 'Leaky',
                status: 'enabled',
                docsUrl: 'javascript:alert("CANARY-js")',
                vars: [
                  { name: 'LEAKY_TOKEN', secret: true, set: true, value: 'CANARY-secret-1' },
                  { name: 'NO_FLAG', set: true, value: 'CANARY-noflag-2' },
                  { name: 'DSN_LIKE', secret: false, set: true, value: 'postgres://app:CANARY-pw-3@db/breeze' },
                ],
              },
            ],
          },
        ],
      }),
    );
    const { container } = render(<ConnectionsTab />);
    await screen.findByTestId('connection-card-leaky');
    expect(container.innerHTML).not.toContain('CANARY');
    expect(within(screen.getByTestId('connection-var-LEAKY_TOKEN')).getByTestId('connection-var-pill').textContent).toContain('set');
    expect(screen.queryByTestId('connection-docs')).toBeNull();
  });

  it('shows only misconfigured and required-missing entries with "show problems only"', async () => {
    fetchWithAuth.mockResolvedValue(ok());
    render(<ConnectionsTab />);
    await screen.findByTestId('connection-card-database');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show problems only' }));
    expect(screen.getByTestId('connection-card-smtp')).toBeTruthy();
    expect(screen.queryByTestId('connection-card-database')).toBeNull();
    expect(screen.queryByTestId('connection-card-sentry')).toBeNull();
    expect(screen.queryByTestId('connections-group-core')).toBeNull();
    // The summary still reflects the whole deployment.
    expect(screen.getByTestId('connections-summary-enabled').textContent).toBe('2 Enabled');
  });

  it('says so when the problems filter leaves nothing', async () => {
    fetchWithAuth.mockResolvedValue(
      ok({
        summary: { enabled: 1, disabled: 0, misconfigured: 0, required_missing: 0 },
        groups: [{ group: 'core', entries: [{ id: 'database', label: 'PostgreSQL', status: 'enabled', vars: [] }] }],
      }),
    );
    render(<ConnectionsTab />);
    await screen.findByTestId('connection-card-database');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show problems only' }));
    expect(screen.getByTestId('connections-no-problems').textContent).toBe(
      'No problems found. Every connection is enabled or disabled.',
    );
  });

  it('states what "enabled" means, the API-container scope, and the running version', async () => {
    fetchWithAuth.mockResolvedValue(ok());
    render(<ConnectionsTab />);
    await screen.findByTestId('connections-summary');
    expect(screen.getByTestId('connections-enabled-meaning').textContent).toMatch(/Enabled means configured/);
    expect(screen.getByTestId('connections-footnote').textContent).toBe(
      "Shows the API container's environment only. The web, portal and worker containers are not included.",
    );
    expect(screen.getByTestId('connections-meta').textContent).toBe('Running version 0.116.0 · Self-hosted');
  });

  it('shows a platform-admin-required panel on a 403', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ error: 'platform admin access required' }, 403));
    render(<ConnectionsTab />);
    const panel = await screen.findByTestId('connections-requires-platform-admin');
    expect(panel.textContent).toContain('Platform admin access required');
    expect(screen.queryByTestId('connections-summary')).toBeNull();
    expect(screen.queryByTestId('connections-refresh')).toBeNull();
  });

  it('shows an error, not an empty page, when the request fails', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ error: 'boom' }, 500));
    render(<ConnectionsTab />);
    const error = await screen.findByTestId('connections-error');
    expect(error.textContent).toBe('Could not load connection status.');
    expect(screen.queryByTestId('connections-summary')).toBeNull();
  });

  it('refetches on Refresh', async () => {
    fetchWithAuth.mockResolvedValue(ok());
    render(<ConnectionsTab />);
    await screen.findByTestId('connections-summary');
    fireEvent.click(screen.getByTestId('connections-refresh'));
    await screen.findByTestId('connections-summary');
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('is read-only: no text inputs and no save button (D1)', async () => {
    fetchWithAuth.mockResolvedValue(ok());
    render(<ConnectionsTab />);
    await screen.findByTestId('connections-summary');
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
    // The only checkbox is the view filter.
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd apps/web && pnpm exec vitest run src/components/admin/system/ConnectionsTab.test.tsx`
Expected: FAIL with `Failed to resolve import "./ConnectionsTab"`.

- [ ] **Step 3: Add the strings to all 8 `admin.json` files**

A plain `json.load` / `json.dump(indent=2, ensure_ascii=False)` round-trip reproduces every current `admin.json`, `common.json` and `pages.json` byte for byte (checked 2026-09-23), so this script keeps the formatting. It inserts `systemPage` as the last key of the root `admin` object. If P3 found different W01 group ids, edit the `groups` dicts first so that their keys equal W01's ids.

```bash
cd apps/web && python3 - <<'PY'
import json

def groups(core, email, storage, ai, billing, identity, remote, agent, obs, security, integ):
    return {
        "core": core, "email": email, "storage-backups": storage, "ai": ai, "billing": billing,
        "microsoft-365": "Microsoft 365", "identity-sso": identity, "remote-access": remote,
        "agent-releases": agent, "observability": obs, "security-abuse": security, "integrations": integ,
    }

def page(title, description, tabs, c):
    return {"title": title, "description": description,
            "tabs": {"label": tabs[0], "connections": tabs[1], "deprecations": tabs[2]},
            "connections": c}

def conn(enabledMeaning, footnote, meta, hosted, selfHost, refresh, loading, errLoad, paTitle, paDesc,
         summaryLabel, problemsOnly, noProblems, empty, status, var, docs, grp):
    return {
        "enabledMeaning": enabledMeaning, "footnote": footnote, "meta": meta,
        "deployMode": {"hosted": hosted, "self_host": selfHost},
        "refresh": refresh, "loading": loading, "errors": {"load": errLoad},
        "platformAdmin": {"title": paTitle, "description": paDesc},
        "summaryLabel": summaryLabel, "problemsOnly": problemsOnly, "noProblems": noProblems, "empty": empty,
        "status": {"enabled": status[0], "disabled": status[1], "misconfigured": status[2], "required_missing": status[3]},
        "var": {"set": var[0], "notSet": var[1], "secret": var[2]},
        "docs": docs, "groups": grp,
    }

FR_GROUPS = dict(core="Services essentiels", storage="Stockage et sauvegardes", ai="IA", billing="Facturation",
                 identity="Identité et SSO", remote="Accès à distance", agent="Versions de l'agent",
                 obs="Observabilité", security="Sécurité et abus", integ="Intégrations")

def fr(email):
    return page("Système", "État de l'ensemble du déploiement pour les administrateurs de plateforme. Cette page est en lecture seule.",
        ("Sections du système", "Connexions", "Dépréciations"),
        conn("Activé signifie configuré. Breeze ne contacte pas le service pour vérifier qu'il répond.",
             "Affiche uniquement l'environnement du conteneur de l'API. Les conteneurs web, portail et worker ne sont pas inclus.",
             "Version en cours {{version}} · {{mode}}", "Hébergé", "Auto-hébergé", "Actualiser",
             "Chargement de l'état des connexions…", "Impossible de charger l'état des connexions.",
             "Accès administrateur de plateforme requis",
             "L'état des connexions couvre l'ensemble du déploiement ; seuls les administrateurs de plateforme peuvent le consulter.",
             "Résumé des connexions", "Afficher uniquement les problèmes",
             "Aucun problème détecté. Chaque connexion est activée ou désactivée.", "Aucune connexion enregistrée.",
             ("Activé", "Désactivé", "Mal configuré", "Requis, manquant"),
             ("défini", "non défini", "Valeur secrète, jamais affichée"), "Consulter la documentation",
             groups(email=email, **FR_GROUPS)))

SYSTEM_PAGE = {
    "en": page("System", "Deployment-wide status for platform administrators. This page is read-only.",
        ("System sections", "Connections", "Deprecations"),
        conn("Enabled means configured. Breeze does not contact the service to check that it responds.",
             "Shows the API container's environment only. The web, portal and worker containers are not included.",
             "Running version {{version}} · {{mode}}", "Hosted", "Self-hosted", "Refresh",
             "Loading connection status…", "Could not load connection status.",
             "Platform admin access required",
             "Connection status covers the whole deployment, so only platform administrators can view it.",
             "Connection summary", "Show problems only",
             "No problems found. Every connection is enabled or disabled.", "No connections are registered.",
             ("Enabled", "Disabled", "Misconfigured", "Required, missing"),
             ("set", "not set", "Secret value, never shown"), "Read the docs",
             groups("Core services", "Email", "Storage and backups", "AI", "Billing", "Identity and SSO",
                    "Remote access", "Agent releases", "Observability", "Security and abuse", "Integrations"))),
    "pt-BR": page("Sistema", "Status de toda a implantação para administradores de plataforma. Esta página é somente leitura.",
        ("Seções do sistema", "Conexões", "Descontinuações"),
        conn("Ativado significa configurado. O Breeze não contata o serviço para verificar se ele responde.",
             "Mostra apenas o ambiente do contêiner da API. Os contêineres web, portal e worker não estão incluídos.",
             "Versão em execução {{version}} · {{mode}}", "Hospedado", "Auto-hospedado", "Atualizar",
             "Carregando status das conexões…", "Não foi possível carregar o status das conexões.",
             "Acesso de administrador de plataforma necessário",
             "O status das conexões abrange toda a implantação, portanto somente administradores de plataforma podem visualizá-lo.",
             "Resumo das conexões", "Mostrar apenas problemas",
             "Nenhum problema encontrado. Todas as conexões estão ativadas ou desativadas.", "Nenhuma conexão registrada.",
             ("Ativado", "Desativado", "Configuração incorreta", "Obrigatório, ausente"),
             ("definido", "não definido", "Valor secreto, nunca exibido"), "Ler a documentação",
             groups("Serviços principais", "E-mail", "Armazenamento e backups", "IA", "Faturamento", "Identidade e SSO",
                    "Acesso remoto", "Versões do agente", "Observabilidade", "Segurança e abuso", "Integrações"))),
    "es-419": page("Sistema", "Estado de toda la implementación para administradores de plataforma. Esta página es de solo lectura.",
        ("Secciones del sistema", "Conexiones", "Obsolescencias"),
        conn("Habilitado significa configurado. Breeze no contacta al servicio para comprobar que responde.",
             "Muestra solo el entorno del contenedor de la API. No incluye los contenedores web, portal y worker.",
             "Versión en ejecución {{version}} · {{mode}}", "Alojado", "Autoalojado", "Actualizar",
             "Cargando el estado de las conexiones…", "No se pudo cargar el estado de las conexiones.",
             "Se requiere acceso de administrador de plataforma",
             "El estado de las conexiones abarca toda la implementación, por lo que solo los administradores de plataforma pueden verlo.",
             "Resumen de conexiones", "Mostrar solo problemas",
             "No se encontraron problemas. Todas las conexiones están habilitadas o deshabilitadas.", "No hay conexiones registradas.",
             ("Habilitado", "Deshabilitado", "Mal configurado", "Obligatorio, falta"),
             ("definido", "no definido", "Valor secreto, nunca se muestra"), "Leer la documentación",
             groups("Servicios principales", "Correo electrónico", "Almacenamiento y respaldos", "IA", "Facturación",
                    "Identidad y SSO", "Acceso remoto", "Versiones del agente", "Observabilidad", "Seguridad y abuso",
                    "Integraciones"))),
    "fr-FR": fr("E-mail"),
    "fr-CA": fr("Courriel"),
    "de-DE": page("System", "Bereitstellungsweiter Status für Plattformadministratoren. Diese Seite ist schreibgeschützt.",
        ("Systembereiche", "Verbindungen", "Abkündigungen"),
        conn("Aktiviert bedeutet konfiguriert. Breeze kontaktiert den Dienst nicht, um zu prüfen, ob er antwortet.",
             "Zeigt nur die Umgebung des API-Containers. Die Container für Web, Portal und Worker sind nicht enthalten.",
             "Laufende Version {{version}} · {{mode}}", "Gehostet", "Selbst gehostet", "Aktualisieren",
             "Verbindungsstatus wird geladen…", "Der Verbindungsstatus konnte nicht geladen werden.",
             "Plattform-Administratorzugriff erforderlich",
             "Der Verbindungsstatus betrifft die gesamte Bereitstellung, daher können ihn nur Plattformadministratoren einsehen.",
             "Verbindungsübersicht", "Nur Probleme anzeigen",
             "Keine Probleme gefunden. Jede Verbindung ist aktiviert oder deaktiviert.", "Keine Verbindungen registriert.",
             ("Aktiviert", "Deaktiviert", "Fehlkonfiguriert", "Erforderlich, fehlt"),
             ("gesetzt", "nicht gesetzt", "Geheimer Wert, wird nie angezeigt"), "Dokumentation lesen",
             groups("Kerndienste", "E-Mail", "Speicher und Sicherungen", "KI", "Abrechnung", "Identität und SSO",
                    "Fernzugriff", "Agent-Versionen", "Beobachtbarkeit", "Sicherheit und Missbrauch", "Integrationen"))),
    "it-IT": page("Sistema", "Stato dell'intera installazione per gli amministratori di piattaforma. Questa pagina è di sola lettura.",
        ("Sezioni di sistema", "Connessioni", "Deprecazioni"),
        conn("Abilitato significa configurato. Breeze non contatta il servizio per verificare che risponda.",
             "Mostra solo l'ambiente del container dell'API. I container web, portale e worker non sono inclusi.",
             "Versione in esecuzione {{version}} · {{mode}}", "Ospitato", "Ospitato in proprio", "Aggiorna",
             "Caricamento dello stato delle connessioni…", "Impossibile caricare lo stato delle connessioni.",
             "È richiesto l'accesso come amministratore di piattaforma",
             "Lo stato delle connessioni riguarda l'intera installazione, quindi solo gli amministratori di piattaforma possono visualizzarlo.",
             "Riepilogo delle connessioni", "Mostra solo i problemi",
             "Nessun problema trovato. Ogni connessione è abilitata o disabilitata.", "Nessuna connessione registrata.",
             ("Abilitato", "Disabilitato", "Configurato in modo errato", "Obbligatorio, mancante"),
             ("impostato", "non impostato", "Valore segreto, mai mostrato"), "Leggi la documentazione",
             groups("Servizi principali", "Posta elettronica", "Archiviazione e backup", "IA", "Fatturazione",
                    "Identità e SSO", "Accesso remoto", "Versioni dell'agente", "Osservabilità", "Sicurezza e abusi",
                    "Integrazioni"))),
    "tr-TR": page("Sistem", "Platform yöneticileri için tüm dağıtımın durumu. Bu sayfa salt okunurdur.",
        ("Sistem bölümleri", "Bağlantılar", "Kullanımdan kaldırmalar"),
        conn("Etkin, yapılandırılmış anlamına gelir. Breeze, yanıt verip vermediğini kontrol etmek için hizmete bağlanmaz.",
             "Yalnızca API kapsayıcısının ortamını gösterir. Web, portal ve worker kapsayıcıları dahil değildir.",
             "Çalışan sürüm {{version}} · {{mode}}", "Barındırılan", "Kendi sunucusunda", "Yenile",
             "Bağlantı durumu yükleniyor…", "Bağlantı durumu yüklenemedi.",
             "Platform yöneticisi erişimi gerekli",
             "Bağlantı durumu tüm dağıtımı kapsar; bu nedenle yalnızca platform yöneticileri görüntüleyebilir.",
             "Bağlantı özeti", "Yalnızca sorunları göster",
             "Sorun bulunamadı. Her bağlantı etkin veya devre dışı.", "Kayıtlı bağlantı yok.",
             ("Etkin", "Devre dışı", "Yanlış yapılandırılmış", "Gerekli, eksik"),
             ("ayarlı", "ayarlı değil", "Gizli değer, asla gösterilmez"), "Belgeleri okuyun",
             groups("Temel hizmetler", "E-posta", "Depolama ve yedeklemeler", "Yapay Zeka", "Faturalama",
                    "Kimlik ve TOA", "Uzaktan erişim", "Ajan sürümleri", "Gözlemlenebilirlik",
                    "Güvenlik ve kötüye kullanım", "Entegrasyonlar"))),
}

for locale, value in SYSTEM_PAGE.items():
    path = f"src/locales/{locale}/admin.json"
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    assert "systemPage" not in data["admin"], f"{path} already has admin.systemPage"
    data["admin"]["systemPage"] = value
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    print("updated", path)
PY
git diff --stat -- src/locales
```

Expected: 8 files updated, and each diff only adds lines inside `admin`.

- [ ] **Step 4: Write the component**

Create `apps/web/src/components/admin/system/ConnectionsTab.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Lock, RefreshCw } from 'lucide-react';
import { fetchWithAuth } from '@/stores/auth';
// Initializes the shared i18next singleton before any island renders translated text.
import '../../../lib/i18n';
import {
  CONNECTION_STATUSES,
  displayableValue,
  filterGroups,
  safeDocsUrl,
  type ConnectionEntryView,
  type ConnectionStatus,
  type ConnectionsReport,
} from './connectionsTypes';

/**
 * System → Connections (spec 2026-09-23-system-connections-page-design.md §4).
 *
 * Read-only (D1) view of which integrations the API container is configured
 * for. "Enabled" means configured, not reachable (D4). Secret vars render
 * only as a set / not set pill, never a value (D2/D8) — enforced here by
 * `displayableValue`, independent of what the API sends. Platform admins
 * only: the route sits behind platformAdminMiddleware (D6); a 403 renders
 * the platform-admin panel.
 */

const STATUS_CLASSES: Record<ConnectionStatus, string> = {
  enabled: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200',
  disabled: 'bg-muted text-muted-foreground',
  misconfigured: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
  required_missing: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
};

function ConnectionCard({ entry }: { entry: ConnectionEntryView }) {
  const { t } = useTranslation('admin');
  const docsUrl = safeDocsUrl(entry.docsUrl);
  return (
    <article data-testid={`connection-card-${entry.id}`} className="border rounded-md p-4 space-y-3">
      <header className="flex items-start justify-between gap-3">
        <h3 className="font-medium">{entry.label}</h3>
        <span
          data-testid="connection-status"
          className={`inline-block px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${STATUS_CLASSES[entry.status]}`}
        >
          {t(/* i18n-dynamic */ `admin.systemPage.connections.status.${entry.status}`)}
        </span>
      </header>
      {entry.reason && (
        <p data-testid="connection-reason" className="text-sm text-amber-900 dark:text-amber-200">
          {entry.reason}
        </p>
      )}
      {entry.vars.length > 0 && (
        <dl className="text-sm border rounded divide-y">
          {entry.vars.map((v) => {
            const value = displayableValue(v);
            return (
              <div
                key={v.name}
                data-testid={`connection-var-${v.name}`}
                className="flex items-center justify-between gap-3 px-3 py-1.5"
              >
                <dt className="font-mono text-xs break-all">{v.name}</dt>
                <dd className="text-right">
                  {value !== null ? (
                    <code data-testid="connection-var-value" className="text-xs break-all">
                      {value}
                    </code>
                  ) : (
                    <span
                      data-testid="connection-var-pill"
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs ${
                        v.set
                          ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {v.secret !== false && (
                        <>
                          <Lock className="w-3 h-3" aria-hidden="true" />
                          <span className="sr-only">{t('admin.systemPage.connections.var.secret')}</span>
                        </>
                      )}
                      {v.set === true
                        ? t('admin.systemPage.connections.var.set')
                        : t('admin.systemPage.connections.var.notSet')}
                    </span>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
      {docsUrl && (
        <a
          href={docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="connection-docs"
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          {t('admin.systemPage.connections.docs')}
          <ExternalLink className="w-3 h-3" aria-hidden="true" />
        </a>
      )}
    </article>
  );
}

export default function ConnectionsTab() {
  const { t } = useTranslation('admin');
  const [report, setReport] = useState<ConnectionsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string>();
  const [problemsOnly, setProblemsOnly] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth('/admin/system/connections');
      if (response.status === 403) {
        setForbidden(true);
        setReport(null);
        return;
      }
      if (!response.ok) throw new Error(t('admin.systemPage.connections.errors.load'));
      const body = (await response.json()) as { data: ConnectionsReport };
      setForbidden(false);
      setReport(body.data);
    } catch (err) {
      setReport(null);
      setError(err instanceof Error ? err.message : t('admin.systemPage.connections.errors.load'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => (report ? filterGroups(report.groups, problemsOnly) : []), [report, problemsOnly]);

  const statusLabel = (status: ConnectionStatus) =>
    t(/* i18n-dynamic */ `admin.systemPage.connections.status.${status}`);

  if (forbidden) {
    return (
      <div
        data-testid="connections-requires-platform-admin"
        className="border rounded-md px-6 py-8 flex items-start gap-4 bg-muted/40"
      >
        <Lock className="w-6 h-6 shrink-0 mt-0.5" aria-hidden="true" />
        <div>
          <div className="font-semibold mb-1">{t('admin.systemPage.connections.platformAdmin.title')}</div>
          <div className="text-sm text-muted-foreground">{t('admin.systemPage.connections.platformAdmin.description')}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1 text-sm text-muted-foreground max-w-3xl">
          {report && (
            <p data-testid="connections-meta" className="font-mono text-foreground">
              {t('admin.systemPage.connections.meta', {
                version: report.version,
                mode: t(/* i18n-dynamic */ `admin.systemPage.connections.deployMode.${report.deployMode}`),
              })}
            </p>
          )}
          <p data-testid="connections-enabled-meaning">{t('admin.systemPage.connections.enabledMeaning')}</p>
        </div>
        <button
          type="button"
          data-testid="connections-refresh"
          onClick={() => void load()}
          className="px-3 py-2 text-sm border rounded-md hover:bg-muted flex items-center gap-1 shrink-0"
        >
          <RefreshCw className="w-4 h-4" aria-hidden="true" /> {t('admin.systemPage.connections.refresh')}
        </button>
      </div>

      {loading ? (
        <div className="text-center py-12 text-muted-foreground">{t('admin.systemPage.connections.loading')}</div>
      ) : error ? (
        <div
          data-testid="connections-error"
          role="alert"
          className="bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-200 px-4 py-3 rounded-md"
        >
          {error}
        </div>
      ) : report ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <ul
              data-testid="connections-summary"
              aria-label={t('admin.systemPage.connections.summaryLabel')}
              className="flex flex-wrap gap-2 text-sm"
            >
              {CONNECTION_STATUSES.filter(
                (s) => s === 'enabled' || s === 'disabled' || (report.summary[s] ?? 0) > 0,
              ).map((s) => (
                <li
                  key={s}
                  data-testid={`connections-summary-${s}`}
                  className={`px-3 py-1 rounded-full ${STATUS_CLASSES[s]}`}
                >
                  <span className="font-semibold">{report.summary[s] ?? 0}</span> {statusLabel(s)}
                </li>
              ))}
            </ul>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                data-testid="connections-problems-only"
                checked={problemsOnly}
                onChange={(e) => setProblemsOnly(e.target.checked)}
              />
              {t('admin.systemPage.connections.problemsOnly')}
            </label>
          </div>

          {groups.length === 0 ? (
            problemsOnly ? (
              <p data-testid="connections-no-problems" className="text-sm text-muted-foreground">
                {t('admin.systemPage.connections.noProblems')}
              </p>
            ) : (
              <p data-testid="connections-empty" className="text-sm text-muted-foreground">
                {t('admin.systemPage.connections.empty')}
              </p>
            )
          ) : (
            groups.map((g) => (
              <section key={g.group} data-testid={`connections-group-${g.group}`} className="space-y-3">
                <h2 className="text-lg font-semibold">
                  {t(/* i18n-dynamic */ `admin.systemPage.connections.groups.${g.group}`, { defaultValue: g.group })}
                </h2>
                <div className="grid gap-3 md:grid-cols-2">
                  {g.entries.map((entry) => (
                    <ConnectionCard key={entry.id} entry={entry} />
                  ))}
                </div>
              </section>
            ))
          )}
        </>
      ) : null}

      <p data-testid="connections-footnote" className="text-xs text-muted-foreground">
        {t('admin.systemPage.connections.footnote')}
      </p>
    </div>
  );
}
```

- [ ] **Step 5: Run the component test and confirm it passes**

Run: `cd apps/web && pnpm exec vitest run src/components/admin/system/ConnectionsTab.test.tsx`
Expected: PASS (14 tests).

- [ ] **Step 6: Run the i18n gates**

Run: `cd apps/web && pnpm exec vitest run src/lib/i18n`
Expected: `localeParity`, `keyUsage` and `titleKeyUsage` pass. `translationCoverage` may report `admin.json: N exact-English duplicates exceeds baseline M` for some locales. The only intended duplicate is `groups.microsoft-365` = "Microsoft 365" (a protected product name, so it stays identical), plus `systemPage.title` = "System" in de-DE (the German noun is spelled the same). For each reported locale, open `apps/web/src/lib/i18n/translationCoverage.test.ts`, find that locale's `'admin.json': M` line (pt-BR `:20`, es-419 `:167`, fr-FR `:301`, fr-CA `:463`, de-DE `:621`, it-IT `:776`, tr-TR `:887`; line numbers as of 2026-09-23 main, so re-grep them), and set it to the reported N with this comment:

```ts
    // +1 system page W02: connections.groups.microsoft-365 is the protected
    // product name "Microsoft 365", identical in every catalog.
```

For de-DE, use `+2` and add: `admin.systemPage.title "System" is the German noun spelled identically.` If a locale reports anything beyond these, a string was copied by mistake. Fix the translation instead of raising the baseline.

Re-run: `cd apps/web && pnpm exec vitest run src/lib/i18n` → Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/admin/system/ConnectionsTab.tsx apps/web/src/components/admin/system/ConnectionsTab.test.tsx apps/web/src/locales/*/admin.json apps/web/src/lib/i18n/translationCoverage.test.ts
git commit -m "feat(web): System page Connections tab with secret-safe var pills (W02)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Move the Deprecations report into a tab component

**Files:**
- Move: `apps/web/src/components/settings/SystemDeprecationsPage.tsx` → `apps/web/src/components/admin/system/DeprecationsTab.tsx`
- Move: `apps/web/src/components/settings/SystemDeprecationsPage.test.tsx` → `apps/web/src/components/admin/system/DeprecationsTab.test.tsx`
- Temporarily modify: `apps/web/src/pages/settings/system/deprecations.astro` (import path only; Task 4 replaces it with the redirect)

**Interfaces:**
- Consumes: #6744's component unchanged in behavior. It uses the `settings` namespace keys `systemDeprecations.*`, fetches `GET /admin/deprecations`, and has the test ids `deprecations-*`.
- Produces: `export default function DeprecationsTab(): JSX.Element`, with no props. The root is `<div className="space-y-6">` (no page padding), and the title is an `<h2>`, because `SystemPage` owns the page `<h1>` and padding.

- [ ] **Step 1: Move the test and add the tab-shape assertion (red)**

```bash
git mv apps/web/src/components/settings/SystemDeprecationsPage.test.tsx apps/web/src/components/admin/system/DeprecationsTab.test.tsx
```

In `apps/web/src/components/admin/system/DeprecationsTab.test.tsx`, make these edits:

Replace
```tsx
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import SystemDeprecationsPage from './SystemDeprecationsPage';
```
with
```tsx
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import DeprecationsTab from './DeprecationsTab';
```

Replace every `<SystemDeprecationsPage />` with `<DeprecationsTab />`, and change `describe('SystemDeprecationsPage', () => {` to `describe('DeprecationsTab', () => {`. Then add this test as the last `it` inside the `describe`:

```tsx
  it('renders as a tab: an h2 title and no page-level h1 (SystemPage owns the h1)', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ data: report() }));
    render(<DeprecationsTab />);
    await screen.findByTestId('deprecations-table');
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Deprecations' })).toBeTruthy();
  });
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd apps/web && pnpm exec vitest run src/components/admin/system/DeprecationsTab.test.tsx`
Expected: FAIL with `Failed to resolve import "./DeprecationsTab"`.

- [ ] **Step 3: Move the component and demote it to a tab**

```bash
git mv apps/web/src/components/settings/SystemDeprecationsPage.tsx apps/web/src/components/admin/system/DeprecationsTab.tsx
```

In `apps/web/src/components/admin/system/DeprecationsTab.tsx`:

Replace
```tsx
// Initializes the shared i18next singleton before any island renders translated text.
import '../../lib/i18n';

/**
 * Settings → System → Deprecations (#6605 wave 2).
```
with
```tsx
// Initializes the shared i18next singleton before any island renders translated text.
import '../../../lib/i18n';

/**
 * System → Deprecations tab (#6605 wave 2; moved from Settings by the
 * system page W02, 2026-09-23-system-connections-page-design.md §4).
 * Strings stay in the `settings` namespace (`systemDeprecations.*`).
```

Replace
```tsx
export default function SystemDeprecationsPage() {
```
with
```tsx
export default function DeprecationsTab() {
```

Replace
```tsx
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t('systemDeprecations.title')}</h1>
```
with
```tsx
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">{t('systemDeprecations.title')}</h2>
```

Update the old page so that the tree compiles until Task 4 replaces it. In `apps/web/src/pages/settings/system/deprecations.astro`, replace

```astro
import SystemDeprecationsPage from '../../../components/settings/SystemDeprecationsPage';
---

<DashboardLayout titleKey="titles.settingsSystemDeprecations">
  <SystemDeprecationsPage client:load />
</DashboardLayout>
```
with
```astro
import DeprecationsTab from '../../../components/admin/system/DeprecationsTab';
---

<DashboardLayout titleKey="titles.settingsSystemDeprecations">
  <DeprecationsTab client:load />
</DashboardLayout>
```

- [ ] **Step 4: Run the tests and confirm they pass, with no stale references left**

Run:
```bash
cd apps/web && pnpm exec vitest run src/components/admin/system/DeprecationsTab.test.tsx src/lib/i18n/keyUsage.test.ts
grep -rn "SystemDeprecationsPage" src || echo "no stale references"
```
Expected: PASS (10 tests in the tab file, the 9 from #6744 plus 1 new, and keyUsage green), then `no stale references`.

- [ ] **Step 5: Commit**

```bash
git add -A apps/web/src/components/admin/system apps/web/src/components/settings apps/web/src/pages/settings/system/deprecations.astro
git commit -m "refactor(web): move the Deprecations report into a System page tab component

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: SystemPage tabs, the `/admin/system` route and the old-URL redirect

**Files:**
- Create: `apps/web/src/components/admin/system/SystemPage.tsx`
- Test: `apps/web/src/components/admin/system/SystemPage.test.tsx`
- Create: `apps/web/src/pages/admin/system.astro`
- Replace: `apps/web/src/pages/settings/system/deprecations.astro`
- Test: `apps/web/src/lib/__tests__/systemPageRoutes.test.ts`
- Modify: `apps/web/src/locales/*/pages.json` (8): add `titles.adminSystem`, remove `titles.settingsSystemDeprecations`
- Modify (only if red): `apps/web/src/lib/i18n/translationCoverage.test.ts` (de-DE `pages.json`)

**Interfaces:**
- Consumes: `ConnectionsTab` (Task 2), `DeprecationsTab` (Task 3), and the keys `admin.systemPage.title|description|tabs.label|tabs.connections|tabs.deprecations` (Task 2).
- Produces:
  - `export type SystemTab = 'connections' | 'deprecations'`
  - `export function parseSystemTab(value: string | null | undefined): SystemTab`
  - `export default function SystemPage(props: { initialTab?: SystemTab }): JSX.Element`
  - Route `/admin/system` (title key `titles.adminSystem`)

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/admin/system/SystemPage.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The tabs have their own suites; stub them so this suite tests only the
// tab shell and URL sync (and makes no network calls).
vi.mock('./ConnectionsTab', () => ({ default: () => <div data-testid="connections-tab-stub" /> }));
vi.mock('./DeprecationsTab', () => ({ default: () => <div data-testid="deprecations-tab-stub" /> }));

import SystemPage, { parseSystemTab } from './SystemPage';

beforeEach(() => {
  window.history.replaceState(null, '', '/admin/system');
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('parseSystemTab', () => {
  it('defaults to connections and accepts only known tabs', () => {
    expect(parseSystemTab(null)).toBe('connections');
    expect(parseSystemTab(undefined)).toBe('connections');
    expect(parseSystemTab('connections')).toBe('connections');
    expect(parseSystemTab('deprecations')).toBe('deprecations');
    expect(parseSystemTab('DEPRECATIONS')).toBe('connections');
    expect(parseSystemTab('<script>')).toBe('connections');
  });
});

describe('SystemPage', () => {
  it('renders the page title and opens Connections by default', () => {
    render(<SystemPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'System' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Connections' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Deprecations' }).getAttribute('aria-selected')).toBe('false');
    expect(screen.getByTestId('connections-tab-stub')).toBeTruthy();
    expect(screen.queryByTestId('deprecations-tab-stub')).toBeNull();
  });

  it('opens the tab named by the URL (?tab=deprecations via initialTab)', () => {
    window.history.replaceState(null, '', '/admin/system?tab=deprecations');
    render(<SystemPage initialTab={parseSystemTab(new URLSearchParams(window.location.search).get('tab'))} />);
    expect(screen.getByRole('tab', { name: 'Deprecations' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('deprecations-tab-stub')).toBeTruthy();
    expect(screen.queryByTestId('connections-tab-stub')).toBeNull();
  });

  it('switching tabs swaps the panel and writes the tab into the URL', () => {
    window.history.replaceState(null, '', '/admin/system?orgId=abc#top');
    render(<SystemPage />);
    fireEvent.click(screen.getByRole('tab', { name: 'Deprecations' }));
    expect(screen.getByTestId('deprecations-tab-stub')).toBeTruthy();
    expect(window.location.pathname).toBe('/admin/system');
    expect(new URLSearchParams(window.location.search).get('tab')).toBe('deprecations');
    expect(new URLSearchParams(window.location.search).get('orgId')).toBe('abc');
    expect(window.location.hash).toBe('#top');

    fireEvent.click(screen.getByRole('tab', { name: 'Connections' }));
    expect(screen.getByTestId('connections-tab-stub')).toBeTruthy();
    expect(new URLSearchParams(window.location.search).has('tab')).toBe(false);
    expect(new URLSearchParams(window.location.search).get('orgId')).toBe('abc');
  });

  it('links the tabpanel to the selected tab for assistive tech', () => {
    render(<SystemPage initialTab="deprecations" />);
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe('system-tab-deprecations');
    expect(screen.getByRole('tablist').getAttribute('aria-label')).toBe('System sections');
  });
});
```

Create `apps/web/src/lib/__tests__/systemPageRoutes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-level checks on the two .astro routes (the same approach as
// settingsPageRegistry.test.ts). They live here, not under src/pages, because
// Astro would serve a .ts file in src/pages as an endpoint.
const WEB_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('system page routes (W02)', () => {
  it('redirects the old Deprecations settings URL to the System page tab with a 301', () => {
    const src = readFileSync(join(WEB_SRC, 'pages/settings/system/deprecations.astro'), 'utf-8');
    expect(src).toContain("return Astro.redirect('/admin/system?tab=deprecations', 301);");
    expect(src).not.toMatch(/DeprecationsTab|SystemDeprecationsPage|DashboardLayout/);
  });

  it('serves /admin/system with its title key and the URL-driven initial tab', () => {
    const src = readFileSync(join(WEB_SRC, 'pages/admin/system.astro'), 'utf-8');
    expect(src).toContain('titleKey="titles.adminSystem"');
    expect(src).toContain("parseSystemTab(Astro.url.searchParams.get('tab'))");
    expect(src).toMatch(/<SystemPage client:load initialTab=\{initialTab\} \/>/);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd apps/web && pnpm exec vitest run src/components/admin/system/SystemPage.test.tsx src/lib/__tests__/systemPageRoutes.test.ts`
Expected: FAIL. SystemPage fails with `Failed to resolve import "./SystemPage"`. The routes test fails with `ENOENT … pages/admin/system.astro`, and the redirect assertion fails because the file still renders `DeprecationsTab`.

- [ ] **Step 3: Write SystemPage**

Create `apps/web/src/components/admin/system/SystemPage.tsx`:

```tsx
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
// Initializes the shared i18next singleton before any island renders translated text.
import '../../../lib/i18n';
import ConnectionsTab from './ConnectionsTab';
import DeprecationsTab from './DeprecationsTab';

/**
 * /admin/system (spec 2026-09-23-system-connections-page-design.md §4, D7).
 * Platform-admin, read-only deployment status. Tabs: Connections (default)
 * and Deprecations. The selected tab lives in `?tab=`; the Astro route parses
 * it server-side and passes `initialTab`, so SSR and hydration agree.
 */

export type SystemTab = 'connections' | 'deprecations';

const TABS: readonly SystemTab[] = ['connections', 'deprecations'];

export function parseSystemTab(value: string | null | undefined): SystemTab {
  return value === 'deprecations' ? 'deprecations' : 'connections';
}

export default function SystemPage({ initialTab = 'connections' }: { initialTab?: SystemTab }) {
  const { t } = useTranslation('admin');
  const [tab, setTab] = useState<SystemTab>(initialTab);

  const select = (next: SystemTab) => {
    setTab(next);
    const params = new URLSearchParams(window.location.search);
    if (next === 'connections') params.delete('tab');
    else params.set('tab', next);
    const query = params.toString();
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`,
    );
  };

  const tabLabel = (id: SystemTab) =>
    id === 'connections' ? t('admin.systemPage.tabs.connections') : t('admin.systemPage.tabs.deprecations');

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('admin.systemPage.title')}</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-3xl">{t('admin.systemPage.description')}</p>
      </div>

      <div role="tablist" aria-label={t('admin.systemPage.tabs.label')} className="flex gap-1 border-b">
        {TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`system-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`system-panel-${id}`}
            data-testid={`system-tab-${id}`}
            onClick={() => select(id)}
            className={`px-4 py-2 text-sm -mb-px border-b-2 ${
              tab === id
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {tabLabel(id)}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`system-panel-${tab}`} aria-labelledby={`system-tab-${tab}`}>
        {tab === 'connections' ? <ConnectionsTab /> : <DeprecationsTab />}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Write the route, the redirect and the title key**

Create `apps/web/src/pages/admin/system.astro` (follows `apps/web/src/pages/admin/ai-kill-switch.astro:1-8`):

```astro
---
import DashboardLayout from '../../layouts/DashboardLayout.astro';
import SystemPage, { parseSystemTab } from '../../components/admin/system/SystemPage';

const initialTab = parseSystemTab(Astro.url.searchParams.get('tab'));
---

<DashboardLayout titleKey="titles.adminSystem">
  <SystemPage client:load initialTab={initialTab} />
</DashboardLayout>
```

Replace the whole of `apps/web/src/pages/settings/system/deprecations.astro` with the redirect stub. The pattern matches `apps/web/src/pages/settings/ticket-checklist-templates.astro`, which `settingsPageRegistry.test.ts:45-48` exempts.

```astro
---
// Moved to the System page's Deprecations tab (system page W02, D7).
return Astro.redirect('/admin/system?tab=deprecations', 301);
---
```

Add `titles.adminSystem` and remove `titles.settingsSystemDeprecations` in all 8 `pages.json` files:

```bash
cd apps/web && python3 - <<'PY'
import json
TITLE = {"en": "System", "pt-BR": "Sistema", "es-419": "Sistema", "fr-FR": "Système", "fr-CA": "Système",
         "de-DE": "System", "it-IT": "Sistema", "tr-TR": "Sistem"}
for locale, value in TITLE.items():
    path = f"src/locales/{locale}/pages.json"
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    titles = data["titles"]
    assert titles.pop("settingsSystemDeprecations", None) is not None, f"{path}: #6744 title key missing"
    assert "adminSystem" not in titles
    # Insert next to the other admin* titles so the diff reads cleanly.
    rebuilt = {}
    for key, val in titles.items():
        rebuilt[key] = val
        if key == "adminQuarantined":
            rebuilt["adminSystem"] = value
    if "adminSystem" not in rebuilt:
        rebuilt["adminSystem"] = value
    data["titles"] = rebuilt
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    print("updated", path)
PY
grep -rn "settingsSystemDeprecations" src || echo "no stale title key"
```

Expected: 8 files updated, then `no stale title key`.

- [ ] **Step 5: Run the tests and confirm they pass**

Run:
```bash
cd apps/web && pnpm exec vitest run src/components/admin/system src/lib/__tests__/systemPageRoutes.test.ts src/lib/__tests__/settingsPageRegistry.test.ts src/lib/i18n
```
Expected: all pass. `settingsPageRegistry` treats `system/deprecations.astro` as redirect-only, and `titleKeyUsage` resolves `titles.adminSystem`. If `translationCoverage` reports de-DE `pages.json` over its baseline (de-DE `'pages.json': 14` at `translationCoverage.test.ts:713`, re-grep the line), raise it by exactly 1 and append `; +1 system page W02: titles.adminSystem "System"` to that line's comment. Any other locale going red means a mistake in its value.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/admin/system/SystemPage.tsx apps/web/src/components/admin/system/SystemPage.test.tsx apps/web/src/pages/admin/system.astro apps/web/src/pages/settings/system/deprecations.astro apps/web/src/lib/__tests__/systemPageRoutes.test.ts apps/web/src/locales/*/pages.json apps/web/src/lib/i18n/translationCoverage.test.ts
git commit -m "feat(web): /admin/system page with Connections and Deprecations tabs; redirect old URL

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Sidebar has a single "System" entry in Administration

**Files:**
- Modify: `apps/web/src/components/layout/Sidebar.tsx` (the lucide import block at `:3-67`, and the Administration items at `:399-411` plus #6744's added Deprecations item)
- Modify: `apps/web/src/components/layout/Sidebar.nav.test.tsx` (replace #6744's `lists the platform-admin-only Deprecations report…` test)
- Modify: `apps/web/src/locales/*/common.json` (8): add `nav.system`, remove `nav.systemDeprecations`
- Modify (only if red): `apps/web/src/lib/i18n/translationCoverage.test.ts` (de-DE `common.json`)

**Interfaces:**
- Consumes: the route `/admin/system` (Task 4).
- Produces: the nav item `{ name: 'System', labelKey: 'nav.system', href: '/admin/system', icon: ServerCog, platformAdminOnly: true }`.

- [ ] **Step 1: Replace the nav test (red)**

In `apps/web/src/components/layout/Sidebar.nav.test.tsx`, replace #6744's test:

```tsx
  it('lists the platform-admin-only Deprecations report, linking to /settings/system/deprecations (#6605)', () => {
    const item = section('administration').items.find((i) => i.href === '/settings/system/deprecations');
    expect(item, 'Administration section should link to /settings/system/deprecations').toBeDefined();
    expect(item?.labelKey).toBe('nav.systemDeprecations');
    expect(item?.platformAdminOnly).toBe(true);
  });
```
with
```tsx
  it('lists one platform-admin-only System entry in Administration, replacing the Deprecations entry (system page W02)', () => {
    const item = section('administration').items.find((i) => i.href === '/admin/system');
    expect(item, 'Administration section should link to /admin/system').toBeDefined();
    expect(item?.labelKey).toBe('nav.system');
    expect(item?.platformAdminOnly).toBe(true);
    const allHrefs = navSections.flatMap((s) => s.items.map((i) => i.href));
    expect(allHrefs.filter((h) => h === '/admin/system')).toHaveLength(1);
    expect(allHrefs).not.toContain('/settings/system/deprecations');
  });
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd apps/web && pnpm exec vitest run src/components/layout/Sidebar.nav.test.tsx -t "System entry"`
Expected: FAIL with `Administration section should link to /admin/system: expected undefined to be defined`.

- [ ] **Step 3: Swap the Sidebar item and the nav key**

In `apps/web/src/components/layout/Sidebar.tsx`, add `ServerCog` to the lucide import (the block ends `Power,\n} from 'lucide-react';` at `:66-67`):

```tsx
  Power,
  ServerCog,
} from 'lucide-react';
```

Replace #6744's item and its comment:

```tsx
      // #6605: Settings → System → Deprecations. The page lives under
      // /settings/system/ (it is a deployment report), but the nav entry sits
      // here because every platform-admin-only surface lives in this section
      // (Sidebar.nav.test.tsx) — the data is deployment-wide, not per tenant.
      { name: 'Deprecations', labelKey: 'nav.systemDeprecations', href: '/settings/system/deprecations', icon: CalendarClock, platformAdminOnly: true },
```
with
```tsx
      // System page (spec 2026-09-23-system-connections-page-design.md, D7):
      // deployment-wide Connections status plus the #6605 Deprecations report
      // as tabs. Replaces the standalone Deprecations entry; its old settings
      // URL now 301-redirects to the Deprecations tab.
      { name: 'System', labelKey: 'nav.system', href: '/admin/system', icon: ServerCog, platformAdminOnly: true },
```

Leave `CalendarClock` imported, because the Jobs entry still uses it (`Sidebar.tsx:215`).

Swap the nav key in all 8 `common.json` files:

```bash
cd apps/web && python3 - <<'PY'
import json
LABEL = {"en": "System", "pt-BR": "Sistema", "es-419": "Sistema", "fr-FR": "Système", "fr-CA": "Système",
         "de-DE": "System", "it-IT": "Sistema", "tr-TR": "Sistem"}
for locale, value in LABEL.items():
    path = f"src/locales/{locale}/common.json"
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    nav = data["nav"]
    rebuilt = {}
    for key, val in nav.items():
        if key == "systemDeprecations":
            rebuilt["system"] = value  # same position as the entry it replaces
            continue
        rebuilt[key] = val
    assert "system" in rebuilt, f"{path}: #6744 nav.systemDeprecations missing"
    data["nav"] = rebuilt
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    print("updated", path)
PY
grep -rn "systemDeprecations\"" src/locales/*/common.json || echo "no stale nav key"
```

Expected: 8 files updated, then `no stale nav key`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run:
```bash
cd apps/web && pnpm exec vitest run src/components/layout src/lib/__tests__/settingsPageRegistry.test.ts src/lib/i18n
```
Expected: all pass, including `keeps every AI surface together and every platform-admin surface in Administration` (`Sidebar.nav.test.tsx:118-128`) and the new System test. If `translationCoverage` reports de-DE `common.json` over baseline (`'common.json': 108` at `translationCoverage.test.ts:676`, re-grep the line), raise it by exactly 1 and append `; +1 system page W02: nav.system "System"` to that line's comment.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/layout/Sidebar.tsx apps/web/src/components/layout/Sidebar.nav.test.tsx apps/web/src/locales/*/common.json apps/web/src/lib/i18n/translationCoverage.test.ts
git commit -m "feat(web): single System entry in Administration replaces Deprecations

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Full verification (typecheck, astro check, suites) and PR-body notes

**Files:**
- No new files. Fix only what these checks surface, inside files this plan already touched.

**Interfaces:**
- Consumes: everything above.
- Produces: verification evidence for the PR body.

- [ ] **Step 1: Run every suite this plan touched**

```bash
cd apps/web && pnpm exec vitest run \
  src/components/admin/system \
  src/components/layout \
  src/lib/__tests__/settingsPageRegistry.test.ts \
  src/lib/__tests__/systemPageRoutes.test.ts \
  src/lib/i18n \
  src/locales
echo "vitest exit: $?"
```
Expected: `vitest exit: 0`. Record the file and test counts for the PR body.

- [ ] **Step 2: Typecheck (exit code checked directly, never piped)**

```bash
cd apps/web && NODE_OPTIONS=--max-old-space-size=12288 pnpm exec tsc --noEmit
echo "tsc exit: $?"
```
Expected: `tsc exit: 0`. A non-zero exit with no error lines is a heap OOM. Re-run it. Do not treat it as green.

- [ ] **Step 3: Astro check (validates the two .astro files and the `initialTab` prop type)**

```bash
cd apps/web && pnpm exec astro check
echo "astro check exit: $?"
```
Expected: `astro check exit: 0` and `0 errors`.

- [ ] **Step 4: Confirm the old component and keys are gone**

```bash
cd "$(git rev-parse --show-toplevel)"
grep -rn "SystemDeprecationsPage\|nav.systemDeprecations\|settingsSystemDeprecations\|/settings/system/deprecations" apps/web/src \
  | grep -v "pages/settings/system/deprecations.astro" \
  | grep -v "systemPageRoutes.test.ts" \
  | grep -v "Sidebar.nav.test.tsx" || echo "clean"
```
Expected: `clean`. The only remaining mentions are the redirect stub itself, the route test that asserts it, and the nav test's `not.toContain` assertion.

- [ ] **Step 5: Optional manual check on a worktree stack (recommended if one is up)**

Sign in as a platform admin and open `/admin/system`. Check that the summary strip, the grouped cards and the pills render. Check that no secret value appears anywhere on the page (compare against the stack's `.env`). Toggle "Show problems only". Click Deprecations: the URL becomes `?tab=deprecations`, and a reload keeps that tab. Open `/settings/system/deprecations` and confirm the 301 lands on the Deprecations tab. As a partner admin, `/admin/system` shows the 403 panel and the sidebar has no Administration section.

- [ ] **Step 6: Commit any fixes from Steps 1–4 (skip if there are none)**

```bash
git add -A apps/web
git commit -m "fix(web): system page W02 verification follow-ups

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Hand these PR-body lines to the orchestrator** (the orchestrator opens the PR)

- "pt-BR, es-419, fr-FR, fr-CA, de-DE, it-IT and tr-TR strings are machine-drafted pending native review."
- "Entry labels and `reason` strings render in English as the API sends them. Per-entry localization is a follow-up candidate (the labels are product names)."
- The "one concept, one home" block for the moved page: Home: `/admin/system?tab=deprecations` (was `/settings/system/deprecations`, now a 301). Level: deployment. Resolver: `buildPreflightReport` (unchanged) and `buildConnectionsReport` (W01). Places configured: 0 before, 0 after (read-only reports).
- Any `translationCoverage.test.ts` baseline bumps, each with its reason (Microsoft 365 ×7 locales; de-DE "System" ×3).
- The vitest counts, `tsc exit: 0` and `astro check exit: 0` from Steps 1–3.

---

## Self-review (against spec §4 and the decisions)

| Spec requirement | Task |
|---|---|
| `/admin/system` = `system.astro` + `SystemPage.tsx`, tabs Connections (default) / Deprecations, tab state in the URL | 4 |
| Summary strip ("23 enabled · 9 disabled · 2 misconfigured") | 2 (enabled and disabled always shown, problem counts when > 0) |
| "Show problems only" filter | 1 (`filterGroups`), 2 |
| Cards grouped by section: label, status badge, reason, key/value list, docs link | 2 |
| Secret vars as a set / not set pill, never a value (D2, D8) | 1 (`displayableValue`, strict `secret === false`, URL-userinfo refusal), 2 (canary test on the DOM) |
| Footnote "API container's environment only" (D5) | 2 |
| "Enabled" means configured (D4; spec Risks: "the page header says so") | 2 (`enabledMeaning`, shown at the top of the tab) |
| Platform admins only (D6); 403 panel | 2 (Connections), 3 (Deprecations keeps #6744's panel) |
| Deprecations page from #6744 moved into the tab | 3 |
| `/settings/system/deprecations` → 301 to `/admin/system?tab=deprecations` | 4 |
| Sidebar: single "System" entry in Administration replacing Deprecations; satisfies the platform-admin-only rule | 5 |
| Strings in all 8 locales; non-English flagged; gates named | 2, 4, 5, 6 |
| Read-only (D1) | 2 (no-textbox/no-save test), 3 (#6744's existing test kept) |
| `docsUrl` optional | 1 (`safeDocsUrl`), 2 (no link when absent or unsafe) |

Type consistency: `ConnectionsReport`, `ConnectionEntryView`, `ConnectionVarView`, `ConnectionGroupView`, `ConnectionStatus`, `CONNECTION_STATUSES`, `displayableValue`, `filterGroups`, `safeDocsUrl` (Task 1) are the exact names imported in Task 2. `DeprecationsTab` (Task 3) and `ConnectionsTab` (Task 2) are the default exports Task 4 imports. `SystemTab`/`parseSystemTab` (Task 4) are used by `system.astro` and the tests. `nav.system` / `titles.adminSystem` / `admin.systemPage.*` match between the code, the tests and the locale scripts.
