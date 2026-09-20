---
tracking_issue: LanternOps/breeze#6367
wave_issue: (set by feature-lifecycle after registration)
branch: (set by feature-lifecycle after registration)
---

# Alerting Consolidation — W05a Stop the Bleeding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the copy that lies, warn when a policy alerts twice for one condition, give the policy Monitors tab the "Create monitor" and "Recommended" affordances the 09-08 spec promised, freeze creation on the three legacy authoring surfaces, and delete the dead code and dead API fields — with no schema change.

**Architecture:** All web work hangs off the existing config-policy feature-tab props (`ConfigPolicyDetailPage.tsx` builds one `props` object per tab); this wave adds one prop, `allLinks`, so any tab can see its siblings' inline settings and compute duplicates client-side with a pure helper. Creation freezes are UI-only (buttons become notices that link to `#monitors`); the API keeps accepting edits to existing rows so nothing a tech saved becomes read-only. The routing API drops two fields the dispatcher never evaluated by making the `conditions` object strict.

**Tech Stack:** React 18 + Vitest/jsdom (`apps/web`), Hono + zod (`apps/api`), i18next with eight locale files, Astro pages.

**Spec:** `docs/superpowers/specs/monitoring/2026-09-19-alerting-consolidation-design.md` (§Problem "Copy lies", §End state "Config policy editor" Create monitor + Recommended + Duplicate warning, §Removed screens rows marked W05a, §Waves W05a row, §Data model "Routing" for the dropped fields).

**Tracking:** set after feature registration (see frontmatter).

## Ordering assumptions (read first)

- No dependency on any other wave. May run in parallel with W05b on its own branch.
- PR 1 contains Tasks 1–5 (web and the obsolete redirect-doc correction); PR 2 contains Tasks 6–7 (API + docs). Task 8 verifies each PR before submission.
- W05a owns only the policy Recommended strip (Task 4). W05c2 owns the separate library strip: partner built-ins unattached anywhere, deployment-status detection, and a policy attachment picker. W05c2 must not treat this policy-local strip as the library implementation.
- D17 is binding: policy preselection uses `#policy=<uuid>`. Editor tab changes preserve that hash state (Task 4); query parameters are not used for transient UI state.
- W05c later replaces the freeze notices with the Needs-conversion panel and W05d deletes the
  legacy tabs; nothing here needs to be undone, only removed.
- The three prerequisite defects (#6342, #6343, #6344) are separate PRs and do not gate this wave.
- `main` at planning time: `b8dd148bd8`. Re-read any cited line range before editing; line
  numbers drift.

## Global Constraints

- **No migration, no schema change** in this wave. If a task seems to need one, stop and re-read the spec.
- **Hash-only transient UI state** per `CLAUDE.md` URL-state rule: preserve policy preselection when switching editor tabs.
- **Every new i18n key gets a real translation in all eight locales** (`apps/web/src/locales/{de-DE,en,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/`). A coverage test fails on missing keys. Translations are given verbatim in Tasks 2 and 4; reuse them.
- **Web mutations go through `runAction`** (`CLAUDE.md:131–141`, `apps/web/src/lib/runAction.ts`); Task 4 routes both the new attachment call and the existing feature Save used by Recommended through it.
- Tests live next to their source (`Foo.tsx` → `Foo.test.tsx`). Run one file with `cd apps/web && npx vitest run <path>`; never `pnpm --filter … test -- --run`.
- `data-testid` on every new interactive element and notice (the repo's e2e convention).
- Commit after every task; conventional-commit subjects with scope `web`, `api`, or `docs`.

## File Structure (what changes where)

| File | Change |
|---|---|
| `apps/web/src/components/configurationPolicies/featureTabs/duplicateConditions.ts` | **Create.** Pure helper: which attached monitors duplicate an inline rule or watch |
| `apps/web/src/components/configurationPolicies/featureTabs/duplicateConditions.test.ts` | **Create.** Unit tests for the helper |
| `apps/web/src/components/configurationPolicies/featureTabs/DuplicateConditionNotice.tsx` | **Create.** Notice rendered by three tabs |
| `apps/web/src/components/configurationPolicies/featureTabs/LegacyFreezeNotice.tsx` | **Create.** "New rules are created as monitors" notice with a link to `#monitors` |
| `apps/web/src/components/configurationPolicies/featureTabs/types.ts` | Add `allLinks?: FeatureLink[]` to the tab props type |
| `apps/web/src/components/configurationPolicies/ConfigPolicyDetailPage.tsx` (422–430) | Pass `allLinks: featureLinks` in `props` |
| `apps/web/src/components/configurationPolicies/featureTabs/useFeatureLink.ts` (16–55), `useFeatureLink.test.ts` | Route the Save path used by Recommended through runAction; preserve inline errors and test response failures |
| `apps/web/src/components/configurationPolicies/featureTabs/notices.test.tsx` | Notice rendering and policy-link regressions |
| `apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.tsx` | Duplicate notice; **Create monitor** link; **Recommended** strip; attach-all built-ins |
| `apps/web/src/components/configurationPolicies/featureTabs/AlertRuleTab.tsx` (634–665) | Duplicate notice; add buttons → freeze notice |
| `apps/web/src/components/configurationPolicies/featureTabs/MonitoringTab.tsx` (209–272, 365–371, 487–490) | Duplicate notice; add-watch button → freeze notice |
| `apps/web/src/components/alerts/AlertTemplateList.tsx` (137–148), `AlertTemplateList.test.tsx` (62–72) | Replace create action/assertion with freeze notice; retain edit navigation |
| `apps/web/src/pages/settings/alert-templates/[id].astro` (5–9), `apps/web/src/components/alerts/AlertTemplateEditor.tsx` (379–381) | Redirect `new` to Monitors; guard direct editor creation without affecting existing IDs |
| `apps/web/src/components/alerts/AlertTemplateEditor.create.test.tsx` | Replace creation tests with freeze and route regressions |
| `apps/web/src/components/monitoring/MonitorEditor.tsx` (141–148, 360–363, 402–406, 698–700) | Delete false hint; preserve `#policy=<uuid>` across tabs and attach after create |
| `apps/web/src/components/monitoring/MonitorEditor.policyHash.test.tsx`, `MonitorEditor.test.tsx` | Hash parsing/preservation, valid UUID attachment, error and create integration regressions |
| `apps/web/src/components/configurationPolicies/featureTabs/legacyTabs.freeze.test.tsx`, `MonitorsTab.recommended.test.tsx` | Real catalog mapping, rendered Add-button absence, Recommended behavior |
| `apps/web/src/components/configurationPolicies/featureTabs/AlertRuleTab.test.tsx`, `MonitoringTab.test.tsx` | Seed existing rows in edit tests; update obsolete Add-button/hash assertions |
| `apps/web/src/locales/*/monitoring.json` | Delete `editor.agentDeliveredHint` and the `hub` block; add `editor.attachedToPolicy` |
| `apps/web/src/locales/*/policies.json` | Add `configurationPolicies.featureTabs.{legacyFreeze,duplicate,monitorsTab.createMonitor,monitorsTab.recommended}` |
| `apps/web/src/locales/*/alerts.json` | Add `templates.frozen.{title,body,link}` |
| `apps/web/src/components/alerts/AlertRuleEditPage.tsx`, `AlertRuleEditor.tsx` (+ tests, `index.ts:26,44`) | **Delete** (no Astro page imports them) |
| `apps/web/src/pages/monitoring/{delivery,rules,network}.astro`, `pages/monitoring/monitors/{index,new,[id]}.astro` | **Delete** (redirect stubs from the reverted W01/W02 hub) |
| `apps/api/src/routes/alerts/routing.ts` (26-45) | `conditions` schemas become `.strict()` without `conditionTypes`/`deviceTags` |
| `apps/api/src/routes/alerts/routing.siteScope.test.ts` | Reject dropped fields on POST/PATCH using existing site-scoped fixtures |
| `apps/api/src/services/notificationDispatcher.ts` (1272–1277), `apps/web/src/components/alerts/NotificationChannelsPage.tsx` (125–128) | Remove dead condition fields from local types |
| `apps/web/src/lib/runActionAllowlist.ts` (26) | Remove deleted AlertRuleEditor from migration backlog |
| `apps/docs/src/content/docs/features/monitors.mdx` (49) | Remove obsolete promise that deleted monitor stubs redirect |
| `docs/superpowers/specs/monitoring/2026-09-08-monitoring-automation-unification-design.md` | Frontmatter `status: superseded` + banner |
| `apps/docs/src/content/docs/features/alert-templates.mdx`, `service-monitoring.mdx` | One-paragraph notice: creation frozen, conversion next release |

---

### Task 1: Duplicate-condition helper

**Files:**
- Create: `apps/web/src/components/configurationPolicies/featureTabs/duplicateConditions.ts`
- Test: `apps/web/src/components/configurationPolicies/featureTabs/duplicateConditions.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DuplicateHit { monitorId: string; monitorName: string; legacyLabel: string; source: 'alert_rule' | 'monitoring' }
  export function findDuplicateConditions(input: DuplicateInput): DuplicateHit[]
  ```
  consumed by Task 3 in three tabs; Task 2 consumes the hit type.

- [ ] **Step 1: Write the failing test**

```ts
// duplicateConditions.test.ts
import { describe, expect, it } from 'vitest';
import { findDuplicateConditions } from './duplicateConditions';

const catalog = [
  { id: 'm-cpu', name: 'High CPU usage', kind: 'cpu', condition: { operator: 'gt', value: 90 } },
  { id: 'm-off', name: 'Device offline', kind: 'offline', condition: { durationMinutes: 15 } },
  { id: 'm-svc', name: 'Spooler stopped', kind: 'service', condition: { serviceName: 'Spooler' } },
  { id: 'm-dis', name: 'Disk almost full', kind: 'disk', condition: { operator: 'gt', value: 90 } },
];

describe('findDuplicateConditions', () => {
  it('flags an inline metric rule whose metric maps to an attached monitor kind', () => {
    const hits = findDuplicateConditions({
      attached: [{ monitorId: 'm-cpu', enabled: true }],
      catalog,
      inlineRules: [{ name: 'Alert Rule 1', conditions: [{ type: 'metric', metric: 'cpuPercent', operator: 'gt', value: 80 }] }],
      watches: [],
    });
    expect(hits).toEqual([{ monitorId: 'm-cpu', monitorName: 'High CPU usage', legacyLabel: 'Alert Rule 1', source: 'alert_rule' }]);
  });

  it('accepts the legacy threshold/status aliases', () => {
    const hits = findDuplicateConditions({
      attached: [{ monitorId: 'm-cpu', enabled: true }, { monitorId: 'm-off', enabled: true }],
      catalog,
      inlineRules: [
        { name: 'CPU', conditions: [{ type: 'threshold', metric: 'cpu', operator: 'gt', value: 80 }] },
        { name: 'Offline', conditions: [{ type: 'status', duration: 10 }] },
      ],
      watches: [],
    });
    expect(hits.map((h) => h.monitorId)).toEqual(['m-cpu', 'm-off']);
  });

  it('ignores disabled attachments and monitors not in the catalog', () => {
    const hits = findDuplicateConditions({
      attached: [{ monitorId: 'm-cpu', enabled: false }, { monitorId: 'ghost', enabled: true }],
      catalog,
      inlineRules: [{ name: 'CPU', conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 80 }] }],
      watches: [],
    });
    expect(hits).toEqual([]);
  });

  it('matches a service watch to a service monitor by name, case-insensitively', () => {
    const hits = findDuplicateConditions({
      attached: [{ monitorId: 'm-svc', enabled: true }],
      catalog,
      inlineRules: [],
      watches: [{ watchType: 'service', name: 'spooler', enabled: true }],
    });
    expect(hits).toEqual([{ monitorId: 'm-svc', monitorName: 'Spooler stopped', legacyLabel: 'spooler', source: 'monitoring' }]);
  });

  it('does not match a disabled watch or a different service', () => {
    const hits = findDuplicateConditions({
      attached: [{ monitorId: 'm-svc', enabled: true }],
      catalog,
      inlineRules: [],
      watches: [{ watchType: 'service', name: 'Spooler', enabled: false }, { watchType: 'service', name: 'W32Time', enabled: true }],
    });
    expect(hits).toEqual([]);
  });

  it('reports one hit per legacy row even when the rule has several conditions', () => {
    const hits = findDuplicateConditions({
      attached: [{ monitorId: 'm-cpu', enabled: true }, { monitorId: 'm-dis', enabled: true }],
      catalog,
      inlineRules: [{ name: 'Both', conditions: [
        { type: 'metric', metric: 'cpu', operator: 'gt', value: 80 },
        { type: 'metric', metric: 'disk', operator: 'gt', value: 80 },
      ] }],
      watches: [],
    });
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.legacyLabel === 'Both')).toBe(true);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/duplicateConditions.test.ts`
Expected: FAIL — `Failed to resolve import "./duplicateConditions"`.

- [ ] **Step 3: Implement**

```ts
// duplicateConditions.ts
// Pure, client-side detection of "this policy alerts twice for one condition":
// an attached, enabled monitor of kind K next to an inline alert rule whose
// condition maps to K, or a service/process watch with the same name as a
// service/process monitor. Transitional (W05a → W05c): the conversion panel
// replaces it.

export interface DuplicateHit {
  monitorId: string;
  monitorName: string;
  legacyLabel: string;
  source: 'alert_rule' | 'monitoring';
}

export interface DuplicateInput {
  attached: Array<{ monitorId: string; enabled?: boolean }>;
  catalog: Array<{ id: string; name: string; kind: string; condition?: Record<string, unknown> | null }>;
  inlineRules: Array<{ name?: string; conditions?: Array<Record<string, unknown>> | null }>;
  watches: Array<{ watchType?: string; name?: string; enabled?: boolean }>;
}

// Mirrors apps/api/src/services/alertConditions/utils.ts METRIC_NAME_MAP (line 13), minus
// processCount/processes (no monitor kind exists for them).
const METRIC_TO_KIND: Record<string, string> = {
  cpu: 'cpu', cpuPercent: 'cpu',
  ram: 'memory', ramPercent: 'memory', memory: 'memory',
  disk: 'disk', diskPercent: 'disk',
};

function kindOfInlineCondition(c: Record<string, unknown>): string | null {
  const type = typeof c.type === 'string' ? c.type : '';
  if (type === 'metric' || type === 'threshold') {
    const metric = typeof c.metric === 'string' ? c.metric : '';
    return METRIC_TO_KIND[metric] ?? null;
  }
  if (type === 'offline' || type === 'status') return 'offline';
  if (type === 'event_log') return 'event_log';
  return null;
}

export function findDuplicateConditions(input: DuplicateInput): DuplicateHit[] {
  const byId = new Map(input.catalog.map((c) => [c.id, c]));
  const active = input.attached
    .filter((a) => a.enabled !== false)
    .map((a) => byId.get(a.monitorId))
    .filter((c): c is NonNullable<typeof c> => Boolean(c));

  const hits: DuplicateHit[] = [];
  const seen = new Set<string>();
  const push = (hit: DuplicateHit) => {
    const key = `${hit.source}:${hit.legacyLabel}:${hit.monitorId}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push(hit);
  };

  for (const rule of input.inlineRules) {
    const label = rule.name?.trim() || 'Alert rule';
    for (const cond of rule.conditions ?? []) {
      const kind = kindOfInlineCondition(cond);
      if (!kind) continue;
      for (const m of active) {
        if (m.kind === kind) push({ monitorId: m.id, monitorName: m.name, legacyLabel: label, source: 'alert_rule' });
      }
    }
  }

  for (const w of input.watches) {
    if (w.enabled === false) continue;
    const wt = w.watchType === 'service' || w.watchType === 'process' ? w.watchType : null;
    const name = w.name?.trim().toLowerCase();
    if (!wt || !name) continue;
    for (const m of active) {
      if (m.kind !== wt) continue;
      const target = wt === 'service' ? m.condition?.serviceName : m.condition?.processName;
      if (typeof target === 'string' && target.trim().toLowerCase() === name) {
        push({ monitorId: m.id, monitorName: m.name, legacyLabel: w.name!.trim(), source: 'monitoring' });
      }
    }
  }
  return hits;
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/duplicateConditions.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/configurationPolicies/featureTabs/duplicateConditions.ts apps/web/src/components/configurationPolicies/featureTabs/duplicateConditions.test.ts
git commit -m "feat(web): pure duplicate-condition detector for policy monitors vs legacy rules"
```

---

### Task 2: Notices, i18n keys, and the `allLinks` prop

**Files:**
- Create: `apps/web/src/components/configurationPolicies/featureTabs/DuplicateConditionNotice.tsx`
- Create: `apps/web/src/components/configurationPolicies/featureTabs/LegacyFreezeNotice.tsx`
- Create: `apps/web/src/components/configurationPolicies/featureTabs/notices.test.tsx`
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/types.ts` (38–53, `FeatureTabProps`)
- Modify: `apps/web/src/components/configurationPolicies/ConfigPolicyDetailPage.tsx` (422–430, the `props` object)
- Modify: `apps/web/src/locales/*/policies.json` (8 files) under `configurationPolicies.featureTabs`
- Modify: `apps/web/src/locales/*/alerts.json` (8 files) add `templates.frozen`

**Interfaces:**
- Consumes: `findDuplicateConditions`, `DuplicateHit` (Task 1).
- Produces: `<DuplicateConditionNotice hits={DuplicateHit[]} />`, `<LegacyFreezeNotice policyId={string} />`, tab prop `allLinks?: FeatureLink[]`.

- [ ] **Step 1: Write the failing tests**

```tsx
// notices.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '../../../lib/i18n';
import { DuplicateConditionNotice } from './DuplicateConditionNotice';
import { LegacyFreezeNotice } from './LegacyFreezeNotice';

describe('DuplicateConditionNotice', () => {
  it('renders nothing without hits', () => {
    const { container } = render(<DuplicateConditionNotice hits={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('lists each duplicated pair', () => {
    render(<DuplicateConditionNotice hits={[
      { monitorId: 'a', monitorName: 'High CPU usage', legacyLabel: 'Alert Rule 1', source: 'alert_rule' },
      { monitorId: 'b', monitorName: 'Spooler stopped', legacyLabel: 'Spooler', source: 'monitoring' },
    ]} />);
    const el = screen.getByTestId('duplicate-condition-notice');
    expect(el).toHaveTextContent('Devices in this policy will alert twice');
    expect(el).toHaveTextContent('Alert Rule 1 ↔ High CPU usage');
    expect(el).toHaveTextContent('Spooler ↔ Spooler stopped');
  });
});

describe('LegacyFreezeNotice', () => {
  it('links to the Monitors tab of the same policy', () => {
    render(<LegacyFreezeNotice policyId="p-1" />);
    const link = screen.getByTestId('legacy-freeze-link');
    expect(link).toHaveAttribute('href', '/configuration-policies/p-1#monitors');
    expect(screen.getByTestId('legacy-freeze-notice')).toHaveTextContent('New rules are created as monitors');
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/notices.test.tsx`
Expected: FAIL — cannot resolve `./DuplicateConditionNotice`.

- [ ] **Step 3: Implement the components**

```tsx
// DuplicateConditionNotice.tsx
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DuplicateHit } from './duplicateConditions';

export function DuplicateConditionNotice({ hits }: { hits: DuplicateHit[] }) {
  const { t } = useTranslation('policies');
  if (hits.length === 0) return null;
  const names = hits.map((h) => `${h.legacyLabel} ↔ ${h.monitorName}`).join(' · ');
  return (
    <div
      data-testid="duplicate-condition-notice"
      role="status"
      className="mb-4 flex gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div>
        <p className="font-medium">{t('configurationPolicies.featureTabs.duplicate.title')}</p>
        <p>{t('configurationPolicies.featureTabs.duplicate.body', { names })}</p>
      </div>
    </div>
  );
}
```

```tsx
// LegacyFreezeNotice.tsx
import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function LegacyFreezeNotice({ policyId }: { policyId: string }) {
  const { t } = useTranslation('policies');
  return (
    <div
      data-testid="legacy-freeze-notice"
      role="note"
      className="mb-4 flex gap-3 rounded-md border bg-muted/40 p-3 text-sm"
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <div>
        <p className="font-medium">{t('configurationPolicies.featureTabs.legacyFreeze.title')}</p>
        <p className="text-muted-foreground">{t('configurationPolicies.featureTabs.legacyFreeze.body')}</p>
        <a
          data-testid="legacy-freeze-link"
          className="mt-1 inline-block text-primary underline-offset-2 hover:underline"
          href={`/configuration-policies/${policyId}#monitors`}
        >
          {t('configurationPolicies.featureTabs.legacyFreeze.link')}
        </a>
      </div>
    </div>
  );
}
```

Add to `types.ts`, in the shared tab props type next to `existingLink`. It is optional for compatibility with unrelated tabs and existing fixtures; the policy page always supplies it and the three consuming tabs destructure `allLinks = []`:

```ts
  /** Every feature link on this policy — lets a tab see its siblings' inline settings (W05a duplicate warning). */
  allLinks?: FeatureLink[];
```

In `ConfigPolicyDetailPage.tsx`, inside the `props = { … }` object (422–430):

```ts
      allLinks: featureLinks,
```

- [ ] **Step 4: Add the i18n keys — all eight locales**

`policies.json` → under `configurationPolicies.featureTabs` add `legacyFreeze`, `duplicate`, and under the existing `monitorsTab` block add `createMonitor` and `recommended`:

| locale | legacyFreeze.title | legacyFreeze.body | legacyFreeze.link |
|---|---|---|---|
| en | New rules are created as monitors | Existing rules stay editable here and convert to monitors in the next release. | Open the Monitors tab |
| de-DE | Neue Regeln werden als Monitore erstellt | Bestehende Regeln bleiben hier bearbeitbar und werden im nächsten Release in Monitore umgewandelt. | Monitore-Tab öffnen |
| es-419 | Las reglas nuevas se crean como monitores | Las reglas existentes siguen siendo editables aquí y se convertirán en monitores en la próxima versión. | Abrir la pestaña Monitores |
| fr-CA | Les nouvelles règles sont créées sous forme de moniteurs | Les règles existantes restent modifiables ici et seront converties en moniteurs dans la prochaine version. | Ouvrir l'onglet Moniteurs |
| fr-FR | Les nouvelles règles sont créées sous forme de moniteurs | Les règles existantes restent modifiables ici et seront converties en moniteurs dans la prochaine version. | Ouvrir l'onglet Moniteurs |
| it-IT | Le nuove regole vengono create come monitor | Le regole esistenti restano modificabili qui e verranno convertite in monitor nella prossima versione. | Apri la scheda Monitor |
| pt-BR | Novas regras são criadas como monitores | As regras existentes continuam editáveis aqui e serão convertidas em monitores na próxima versão. | Abrir a aba Monitores |
| tr-TR | Yeni kurallar monitör olarak oluşturulur | Mevcut kurallar burada düzenlenebilir kalır ve bir sonraki sürümde monitörlere dönüştürülür. | Monitörler sekmesini aç |

| locale | duplicate.title | duplicate.body (keep `{{names}}`) |
|---|---|---|
| en | Devices in this policy will alert twice | These conditions exist both as an attached monitor and as a legacy rule or watch: {{names}} |
| de-DE | Geräte in dieser Richtlinie melden doppelt | Diese Bedingungen existieren sowohl als angehängter Monitor als auch als Alt-Regel oder -Überwachung: {{names}} |
| es-419 | Los dispositivos de esta política alertarán dos veces | Estas condiciones existen como monitor adjunto y también como regla o vigilancia heredada: {{names}} |
| fr-CA | Les appareils de cette politique alerteront deux fois | Ces conditions existent à la fois comme moniteur attaché et comme règle ou surveillance héritée : {{names}} |
| fr-FR | Les appareils de cette politique alerteront deux fois | Ces conditions existent à la fois comme moniteur attaché et comme règle ou surveillance héritée : {{names}} |
| it-IT | I dispositivi di questa policy genereranno avvisi doppi | Queste condizioni esistono sia come monitor collegato sia come regola o controllo legacy: {{names}} |
| pt-BR | Os dispositivos desta política alertarão duas vezes | Estas condições existem como monitor anexado e também como regra ou vigilância legada: {{names}} |
| tr-TR | Bu ilkedeki cihazlar iki kez uyarı verecek | Bu koşullar hem bağlı bir monitör hem de eski bir kural veya izleme olarak mevcut: {{names}} |

| locale | monitorsTab.createMonitor | monitorsTab.recommended.title | monitorsTab.recommended.body | monitorsTab.recommended.action |
|---|---|---|---|---|
| en | Create monitor | Recommended monitors | Breeze ships built-in CPU, memory, disk and patch-compliance monitors. None are attached to this policy yet. | Attach all built-in monitors |
| de-DE | Monitor erstellen | Empfohlene Monitore | Breeze liefert integrierte Monitore für CPU, Arbeitsspeicher, Datenträger und Patch-Compliance. Keiner ist dieser Richtlinie bisher zugeordnet. | Alle integrierten Monitore anhängen |
| es-419 | Crear monitor | Monitores recomendados | Breeze incluye monitores integrados de CPU, memoria, disco y cumplimiento de parches. Ninguno está adjunto a esta política todavía. | Adjuntar todos los monitores integrados |
| fr-CA | Créer un moniteur | Moniteurs recommandés | Breeze fournit des moniteurs intégrés pour le processeur, la mémoire, le disque et la conformité des correctifs. Aucun n'est encore attaché à cette politique. | Attacher tous les moniteurs intégrés |
| fr-FR | Créer un moniteur | Moniteurs recommandés | Breeze fournit des moniteurs intégrés pour le processeur, la mémoire, le disque et la conformité des correctifs. Aucun n'est encore attaché à cette politique. | Attacher tous les moniteurs intégrés |
| it-IT | Crea monitor | Monitor consigliati | Breeze include monitor integrati per CPU, memoria, disco e conformità delle patch. Nessuno è ancora collegato a questa policy. | Collega tutti i monitor integrati |
| pt-BR | Criar monitor | Monitores recomendados | O Breeze inclui monitores integrados de CPU, memória, disco e conformidade de patches. Nenhum está anexado a esta política ainda. | Anexar todos os monitores integrados |
| tr-TR | Monitör oluştur | Önerilen monitörler | Breeze; CPU, bellek, disk ve yama uyumluluğu için yerleşik monitörler sunar. Bu ilkeye henüz hiçbiri bağlı değil. | Tüm yerleşik monitörleri bağla |

`alerts.json` → add `templates.frozen`:

| locale | title | body | link |
|---|---|---|---|
| en | New alert templates are created as monitors | Existing templates stay editable here and convert in the next release. | Open Monitors |
| de-DE | Neue Alarmvorlagen werden als Monitore erstellt | Bestehende Vorlagen bleiben hier bearbeitbar und werden im nächsten Release umgewandelt. | Monitore öffnen |
| es-419 | Las plantillas de alerta nuevas se crean como monitores | Las plantillas existentes siguen siendo editables aquí y se convertirán en la próxima versión. | Abrir Monitores |
| fr-CA | Les nouveaux modèles d'alerte sont créés sous forme de moniteurs | Les modèles existants restent modifiables ici et seront convertis dans la prochaine version. | Ouvrir les moniteurs |
| fr-FR | Les nouveaux modèles d'alerte sont créés sous forme de moniteurs | Les modèles existants restent modifiables ici et seront convertis dans la prochaine version. | Ouvrir les moniteurs |
| it-IT | I nuovi modelli di avviso vengono creati come monitor | I modelli esistenti restano modificabili qui e verranno convertiti nella prossima versione. | Apri Monitor |
| pt-BR | Novos modelos de alerta são criados como monitores | Os modelos existentes continuam editáveis aqui e serão convertidos na próxima versão. | Abrir Monitores |
| tr-TR | Yeni uyarı şablonları monitör olarak oluşturulur | Mevcut şablonlar burada düzenlenebilir kalır ve bir sonraki sürümde dönüştürülür. | Monitörleri aç |

- [ ] **Step 5: Run, expect PASS** (component tests and the locale coverage test)

Run: `cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/notices.test.tsx src/locales src/lib/i18n/localeParity.test.ts`
Expected: notices 3 passed; locale coverage suite green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/configurationPolicies/featureTabs/DuplicateConditionNotice.tsx apps/web/src/components/configurationPolicies/featureTabs/LegacyFreezeNotice.tsx apps/web/src/components/configurationPolicies/featureTabs/notices.test.tsx apps/web/src/components/configurationPolicies/featureTabs/types.ts apps/web/src/components/configurationPolicies/ConfigPolicyDetailPage.tsx apps/web/src/locales
git commit -m "feat(web): duplicate-condition and legacy-freeze notices for policy tabs (+i18n, allLinks prop)"
```

---

### Task 3: Wire the duplicate warning and creation freeze into the three legacy tabs

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/AlertRuleTab.tsx` (634–665: both add buttons; 669–670: item list)
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/MonitoringTab.tsx` (209–272: section contract/button; 365–371: addWatch; 487–490: caller; 520–577: notices)
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.tsx` (11–17: catalog type; 94–101: mapper; 216–230: shell)
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/AlertRuleTab.test.tsx` (45–50: addFirstRule; 268–329, 351–360, 1034–1036: empty fixtures)
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/MonitoringTab.test.tsx` (193–195, 252–267, 289–302, 397–404: obsolete creation/navigation assertions)
- Test: `apps/web/src/components/configurationPolicies/featureTabs/legacyTabs.freeze.test.tsx` (create)

**Interfaces:**
- Consumes: optional `allLinks` prop (Task 2), `findDuplicateConditions(input: DuplicateInput)` (Task 1), both notices (Task 2).
- Produces: catalog rows retaining `builtinKey: string | null` and `condition: Record<string, unknown> | null`; Task 4 consumes these fields. `MonitoringSection` has no Add action contract after this task.

- [ ] **Step 1: Write the failing test**

```tsx
// legacyTabs.freeze.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '../../../lib/i18n';

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async (url: string) => ({
    ok: true,
    json: async () => (url.startsWith('/monitor-definitions')
      ? { data: [
          { id: 'm-cpu', name: 'High CPU usage', kind: 'cpu', condition: { operator: 'gt', value: 90 }, severity: 'high', enabled: true, builtinKey: 'cpu_high' },
          { id: 'm-svc', name: 'Spooler stopped', kind: 'service', condition: { serviceName: 'Spooler' }, severity: 'high', enabled: true, builtinKey: null },
        ] }
      : { data: [] }),
  })),
}));

import AlertRuleTab from './AlertRuleTab';
import MonitoringTab from './MonitoringTab';
import MonitorsTab from './MonitorsTab';

const alertRuleLink = {
  id: 'l-ar', featureType: 'alert_rule', featurePolicyId: null,
  inlineSettings: { items: [{ name: 'Alert Rule 1', severity: 'medium', conditions: [{ type: 'metric', metric: 'cpuPercent', operator: 'gt', value: 80 }], cooldownMinutes: 15, autoResolve: false }] },
} as any;
const monitorsLink = { id: 'l-mon', featureType: 'monitors', featurePolicyId: null, inlineSettings: { items: [{ monitorId: 'm-cpu', enabled: true }] } } as any;
const base = { policyId: 'p-1', linkedPolicyId: null, orgId: 'o-1', onLinkChanged: vi.fn() } as any;

describe('legacy tabs after W05a', () => {
  it('AlertRuleTab shows the freeze notice instead of an add button', () => {
    render(<AlertRuleTab {...base} existingLink={alertRuleLink} allLinks={[alertRuleLink, monitorsLink]} />);
    expect(screen.getByTestId('legacy-freeze-notice')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add alert rule/i })).toBeNull();
  });
  it('AlertRuleTab warns about the CPU duplicate', async () => {
    render(<AlertRuleTab {...base} existingLink={alertRuleLink} allLinks={[alertRuleLink, monitorsLink]} />);
    expect(await screen.findByTestId('duplicate-condition-notice')).toHaveTextContent('Alert Rule 1 ↔ High CPU usage');
  });
  it('MonitoringTab shows the freeze notice and no add-watch control', () => {
    const monLink = { id: 'l-w', featureType: 'monitoring', featurePolicyId: null, inlineSettings: { checkIntervalSeconds: 60, watches: [] } } as any;
    render(<MonitoringTab {...base} existingLink={monLink} allLinks={[monLink, monitorsLink]} />);
    expect(screen.getByTestId('legacy-freeze-notice')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Add Watch$/i })).toBeNull();
  });
  it('MonitorsTab warns about the same duplicate from its side', async () => {
    render(<MonitorsTab {...base} existingLink={monitorsLink} allLinks={[alertRuleLink, monitorsLink]} />);
    expect(await screen.findByTestId('duplicate-condition-notice')).toHaveTextContent('High CPU usage');
  });
});
```

The tabs are default exports and the real callback is `onLinkChanged`. Mock the catalog HTTP response, not the mapper, so these tests cover data retained by the real mapping path.

Include this regression in the new freeze suite's failing-test step; its mock above includes the service row:

```tsx
it('retains the service condition through the actual MonitorsTab catalog mapper', async () => {
  const watches = { id: 'l-watch', featureType: 'monitoring' as const, featurePolicyId: null,
    inlineSettings: { watches: [{ watchType: 'service', name: 'spooler', enabled: true }] } };
  const attached = { ...monitorsLink, inlineSettings: { items: [{ monitorId: 'm-svc', enabled: true }] } };
  render(<MonitorsTab {...base} existingLink={attached} allLinks={[attached, watches]} />);
  expect(await screen.findByTestId('duplicate-condition-notice')).toHaveTextContent('spooler ↔ Spooler stopped');
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/legacyTabs.freeze.test.tsx`
Expected: FAIL — freeze notice not found; add button still rendered.

- [ ] **Step 3: Implement**

In all three tabs, derive the sibling data once:

```ts
import { findDuplicateConditions } from './duplicateConditions';
import { DuplicateConditionNotice } from './DuplicateConditionNotice';
import { LegacyFreezeNotice } from './LegacyFreezeNotice';

const linkOf = (type: string) => allLinks.find((l) => l.featureType === type);
const inlineRules = (linkOf('alert_rule')?.inlineSettings as { items?: Array<{ name?: string; conditions?: Array<Record<string, unknown>> }> } | undefined)?.items ?? [];
const watches = (linkOf('monitoring')?.inlineSettings as { watches?: Array<{ watchType?: string; name?: string; enabled?: boolean }> } | undefined)?.watches ?? [];
const attached = (linkOf('monitors')?.inlineSettings as { items?: Array<{ monitorId: string; enabled?: boolean }> } | undefined)?.items ?? [];
```

The three tabs destructure `allLinks = []`. Keep the existing catalog fetch in `MonitorsTab`;
extend its actual type and `rows.map` result (do not construct a second catalog just for tests):

```ts
// Add to MonitorCatalogEntry at MonitorsTab.tsx:11–17.
  builtinKey: string | null;
  condition: Record<string, unknown> | null;
// Add to the rows.map result at MonitorsTab.tsx:94–101.
  builtinKey: typeof r.builtinKey === 'string' ? r.builtinKey : null,
  condition: r.condition && typeof r.condition === 'object' && !Array.isArray(r.condition)
    ? r.condition as Record<string, unknown>
    : null,
```

In `AlertRuleTab` and `MonitoringTab`, import `DuplicateInput` alongside the helper and add this
catalog effect using their existing `useState`, `useEffect`, and `fetchWithAuth` imports (add
`fetchWithAuth` from `../../../stores/auth` in `AlertRuleTab` if not already imported):

```ts
const [catalog, setCatalog] = useState<DuplicateInput['catalog']>([]);
useEffect(() => {
  let cancelled = false;
  void (async () => {
    try {
      const res = await fetchWithAuth('/monitor-definitions');
      if (!res.ok) return;
      const json = await res.json();
      if (!cancelled) setCatalog(Array.isArray(json?.data) ? json.data : []);
    } catch { /* The duplicate warning is advisory; monitoring keeps running. */ }
  })();
  return () => { cancelled = true; };
}, []);
```

Use the real in-memory state (`settings.watches`, not a nonexistent `entries`):

```tsx
// AlertRuleTab, above the item list:
<LegacyFreezeNotice policyId={policyId} />
<DuplicateConditionNotice hits={findDuplicateConditions({ attached, catalog, inlineRules: items, watches })} />
// MonitoringTab, above MonitoringSection:
<LegacyFreezeNotice policyId={policyId} />
<DuplicateConditionNotice hits={findDuplicateConditions({ attached, catalog, inlineRules, watches: settings.watches })} />
// MonitorsTab, inside FeatureTabShell before attachment controls:
<DuplicateConditionNotice hits={findDuplicateConditions({ attached: items, catalog, inlineRules, watches })} />
```

Delete both `AlertRuleTab` add buttons (634–643, 655–664) and its now-unused `addItem` function.
In `MonitoringTab`, remove `onAdd` and `addLabel` from the `MonitoringSection` destructuring,
type, and caller; delete the entire button at 261–272 and `addWatch` at 365–371. Keep
`defaultWatch`, which `readSettings` still uses. Remove the now-unused `Plus` import. The
remaining section props type is (use it for the existing function; retain its disclosure implementation):

```tsx
type MonitoringSectionProps = {
  icon: ReactNode;
  title: string;
  count: number;
  description: string;
  defaultOpen?: boolean;
  children: ReactNode;
};
```

Keep both legacy notices. Change their navigation helper and link copy together:

```ts
const MONITORS_TAB: FeatureType = 'monitors';
function goToMonitorsTab() {
  if (typeof window === 'undefined') return;
  window.location.hash = MONITORS_TAB;
}
```

Both notice buttons use `onClick={goToMonitorsTab}` and
`i18n.t('policies:configurationPolicies.featureTabs.legacyFreeze.link')`. Replace the pointer
paragraph's leading text with `legacyFreeze.body`; the legacy-row count notice retains its
historical explanation. Change its empty-watch hint to `legacyFreeze.body` too.

Preserve the existing editor regressions instead of deleting tests that used Add to set up rows.
In `AlertRuleTab.test.tsx`, introduce this fixture, substitute it for the empty `existingLink`
in each test that calls `addFirstRule` (including the `renderEmpty` helper, renamed
`renderEditableRule`), and replace `addFirstRule()` with `openExistingRule()`:

```tsx
const editableRuleLink = {
  id: 'link-1', featureType: 'alert_rule' as const, featurePolicyId: null,
  inlineSettings: { items: [{ name: 'Existing CPU rule', severity: 'medium',
    conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 80, durationMinutes: 5 }],
    cooldownMinutes: 15, autoResolve: false }] },
};
function openExistingRule() {
  fireEvent.click(screen.getByText('Existing CPU rule'));
}
```

In `MonitoringTab.test.tsx`, replace the nested-Add keyboard test with the actual rendered
control regression; change both pointer expectations to `#monitors`:

```tsx
it('keeps the disclosure usable with no Add Watch action', () => {
  renderTab();
  expect(screen.queryByRole('button', { name: /^Add Watch$/i })).toBeNull();
  const header = sectionHeader('Service & Process Watches');
  fireEvent.keyDown(header, { key: 'Enter' });
  expect(header).toHaveAttribute('aria-expanded', 'true');
});
```

Replace the no-rationale test's Add setup with a stored watch, retaining its assertion:

```tsx
render(<MonitoringTab policyId="policy-1" linkedPolicyId={null} onLinkChanged={vi.fn()}
  existingLink={{ ...linkWithRationale, inlineSettings: {
    ...linkWithRationale.inlineSettings,
    watches: linkWithRationale.inlineSettings.watches.map((watch) => ({ ...watch, rationale: null })),
  } }} />);
fireEvent.click(screen.getByText('nginx'));
expect(screen.getByTestId('watch-rationale-0')).toHaveTextContent('No rationale recorded.');
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs`
Expected: new suite 5 passed; existing `AlertRuleTab.*`, `MonitoringTab.*`, `MonitorsTab.*` suites still green (existing-row edit tests remain covered with seeded fixtures).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/configurationPolicies/featureTabs
git commit -m "feat(web): freeze legacy rule/watch creation and warn on duplicate conditions in policy tabs"
```

---

### Task 4: Policy Monitors tab — Create monitor, Recommended strip; editor preserves `#policy=<uuid>`

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.tsx` (59: translation binding; 123–130: attachment helpers; 232–270: attachment controls)
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/useFeatureLink.ts` (16–55: save callback)
- Create: `apps/web/src/components/configurationPolicies/featureTabs/useFeatureLink.test.ts`
- Modify: `apps/web/src/components/monitoring/MonitorEditor.tsx` (39: i18n import; 141–148: tab parser; 360–363: tab switch; 402–406: create navigation)
- Modify: `apps/web/src/locales/*/monitoring.json` (all eight locales) add `editor.attachedToPolicy`
- Create: `apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.recommended.test.tsx`
- Create: `apps/web/src/components/monitoring/MonitorEditor.policyHash.test.tsx`
- Test: `apps/web/src/components/monitoring/MonitorEditor.test.tsx` (1–79: existing render/fetch/toast harness)

**Interfaces:**
- Consumes: Task 3's real catalog mapper, preserving `builtinKey` and `condition`; existing `POST /monitor-definitions/:id/attachments` body `{ configPolicyId }` (`DeployMonitorDialog.tsx:92–95`).
- Produces: `/alerts/monitors/new#policy=<uuid>`; `attachAfterCreate(monitorId: string, hash: string, fetcher?: (url: string, init?: RequestInit) => Promise<Response>): Promise<string>`; `editorHashForTab(hash: string, tab: EditorTab): string`; exported `tabFromHash(hash: string): EditorTab | undefined` for regression coverage.
- Policy-local Recommended means none of the catalog's built-ins is attached to this policy. W05c2 implements the separate library deployment-status query and policy picker; no library completion is claimed here.

- [ ] **Step 1: Write the failing tests**

```tsx
// MonitorsTab.recommended.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '../../../lib/i18n';
import MonitorsTab from './MonitorsTab';
import type { FeatureLink, FeatureTabProps } from './types';

const { fetchMock, saveMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), saveMock: vi.fn() }));
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: fetchMock }));
vi.mock('./useFeatureLink', () => ({ useFeatureLink: () => ({
  save: saveMock, remove: vi.fn(), saving: false, error: undefined, clearError: vi.fn(),
}) }));
const POLICY = '10000000-0000-4000-8000-000000000009';
const CPU = '20000000-0000-4000-8000-000000000001';
const DISK = '20000000-0000-4000-8000-000000000002';
const CUSTOM = '20000000-0000-4000-8000-000000000003';
const catalog = [
  { id: CPU, name: 'High CPU usage', kind: 'cpu', builtinKey: 'cpu_high', condition: { value: 90 }, severity: 'high', enabled: true },
  { id: DISK, name: 'Disk almost full', kind: 'disk', builtinKey: 'disk_full', condition: { value: 90 }, severity: 'critical', enabled: true },
  { id: CUSTOM, name: 'Custom', kind: 'memory', builtinKey: null, condition: { value: 90 }, severity: 'high', enabled: true },
];
const link: FeatureLink = { id: 'l', featureType: 'monitors', featurePolicyId: null, inlineSettings: { items: [] } };
const base: FeatureTabProps = { policyId: POLICY, existingLink: link, linkedPolicyId: null,
  onLinkChanged: vi.fn(), allLinks: [link] };

function renderTab(existingLink = link) {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: catalog }) });
  saveMock.mockResolvedValue(link);
  return render(<MonitorsTab {...base} existingLink={existingLink} />);
}

describe('MonitorsTab policy affordances', () => {
  it('links Create monitor with hash-based policy preselection', async () => {
    renderTab();
    expect(await screen.findByTestId('monitors-tab-create')).toHaveAttribute('href', `/alerts/monitors/new#policy=${POLICY}`);
  });
  it('uses the real mapper to find built-ins, attaches all locally, then saves', async () => {
    renderTab();
    expect(await screen.findByTestId('monitors-tab-recommended')).toHaveTextContent('Recommended monitors');
    fireEvent.click(screen.getByTestId('monitors-tab-recommended-attach'));
    expect(screen.queryByTestId('monitors-tab-recommended')).toBeNull();
    expect(screen.getByTestId(`monitors-tab-item-${CPU}`)).toHaveTextContent('High CPU usage');
    expect(screen.getByTestId(`monitors-tab-item-${DISK}`)).toHaveTextContent('Disk almost full');
    expect(screen.queryByTestId(`monitors-tab-item-${CUSTOM}`)).toBeNull();
    expect(saveMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith('l', expect.objectContaining({
      featureType: 'monitors', inlineSettings: { items: [
        { monitorId: CPU, enabled: true, overrides: undefined, sortOrder: 0 },
        { monitorId: DISK, enabled: true, overrides: undefined, sortOrder: 1 },
      ] },
    })));
  });
  it('hides Recommended once any built-in is attached', async () => {
    renderTab({ ...link, inlineSettings: { items: [{ monitorId: CPU, enabled: true }] } });
    await screen.findByText('High CPU usage');
    expect(screen.queryByTestId('monitors-tab-recommended')).toBeNull();
  });
});
```

```tsx
// MonitorEditor.policyHash.test.tsx — real runAction; mock only toast/navigation.
import { describe, expect, it, vi } from 'vitest';
import { attachAfterCreate, editorHashForTab, tabFromHash } from './MonitorEditor';
import { showToast } from '../shared/Toast';
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const POLICY = '10000000-0000-4000-8000-000000000009';
const MONITOR = '20000000-0000-4000-8000-000000000001';

describe('policy hash preselection', () => {
  it('attaches using a valid UUID and returns the policy URL', async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }));
    expect(await attachAfterCreate(MONITOR, `#policy=${POLICY}`, fetcher)).toBe(`/configuration-policies/${POLICY}#monitors`);
    expect(fetcher).toHaveBeenCalledWith(`/monitor-definitions/${MONITOR}/attachments`, {
      method: 'POST', body: JSON.stringify({ configPolicyId: POLICY }),
    });
  });
  it.each(['', '#activity', '#policy=../x'])('does not attach for absent/invalid policy in %s', async (hash) => {
    const fetcher = vi.fn();
    expect(await attachAfterCreate(MONITOR, hash, fetcher)).toBe(`/alerts/monitors/${MONITOR}`);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('preserves policy when switching tabs and reads legacy bare tab hashes', async () => {
    const hash = editorHashForTab(`#policy=${POLICY}`, 'activity');
    expect(new URLSearchParams(hash.slice(1)).get('policy')).toBe(POLICY);
    expect(tabFromHash(hash)).toBe('activity');
    expect(tabFromHash('#activity')).toBe('activity');
    expect(tabFromHash('settings')).toBe('settings');
    expect(tabFromHash(`#policy=${POLICY}`)).toBe('settings');
    const settingsHash = editorHashForTab(hash, 'settings');
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
    expect(await attachAfterCreate(MONITOR, settingsHash, fetcher)).toBe(`/configuration-policies/${POLICY}#monitors`);
  });
  it('surfaces failed attachments through runAction without returning a success URL', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'Denied' }), { status: 403 }));
    await expect(attachAfterCreate(MONITOR, `#policy=${POLICY}`, fetcher)).rejects.toMatchObject({ status: 403 });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});
```

Append these integration cases inside the existing `MonitorEditor.test.tsx` describe, using its
real `defaultFetchImpl`, `json`, `MONITOR_M1_FIXTURE`, `fetchMock`, and `navMock`:

```tsx
it('creates and attaches to the policy selected in the hash', async () => {
  const policyId = '10000000-0000-4000-8000-000000000009';
  const id = '20000000-0000-4000-8000-000000000001';
  window.history.replaceState(null, '', `/alerts/monitors/new#policy=${policyId}`);
  fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
    if (input === '/monitor-definitions' && init?.method === 'POST') return json({ data: { id } }, true, 201);
    if (input === `/monitor-definitions/${id}/attachments`) return json({ data: {} });
    return defaultFetchImpl(input);
  });
  try {
    render(<MonitorEditor />);
    fireEvent.change(await screen.findByTestId('monitor-editor-name'), { target: { value: 'CPU high' } });
    fireEvent.click(screen.getByTestId('monitor-editor-save'));
    await waitFor(() => expect(navMock).toHaveBeenCalledWith(`/configuration-policies/${policyId}#monitors`));
    expect(fetchMock).toHaveBeenCalledWith(`/monitor-definitions/${id}/attachments`, {
      method: 'POST', body: JSON.stringify({ configPolicyId: policyId }),
    });
  } finally { window.history.replaceState(null, '', '/'); }
});

it('preserves the policy hash through actual editor tab clicks', async () => {
  const policyId = '10000000-0000-4000-8000-000000000009';
  window.history.replaceState(null, '', `/alerts/monitors/m1#policy=${policyId}`);
  fetchMock.mockImplementation(async (input: string) => input === '/monitor-definitions/m1'
    ? json({ data: MONITOR_M1_FIXTURE }) : defaultFetchImpl(input));
  try {
    render(<MonitorEditor monitorId="m1" />);
    await screen.findByTestId('monitor-editor-tab-activity');
    fireEvent.click(screen.getByTestId('monitor-editor-tab-activity'));
    expect(new URLSearchParams(window.location.hash.slice(1)).get('policy')).toBe(policyId);
    fireEvent.click(screen.getByTestId('monitor-editor-tab-settings'));
    expect(new URLSearchParams(window.location.hash.slice(1)).get('policy')).toBe(policyId);
  } finally { window.history.replaceState(null, '', '/'); }
});
```

Add a hook regression for the real feature Save used by the Recommended flow:

```ts
// useFeatureLink.test.ts
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useFeatureLink } from './useFeatureLink';
import { fetchWithAuth } from '../../../stores/auth';
import { showToast } from '../../shared/Toast';
import { navigateTo } from '@/lib/navigation';
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const POLICY = '10000000-0000-4000-8000-000000000009';
const LINK = '30000000-0000-4000-8000-000000000001';
const payload = { featureType: 'monitors' as const, featurePolicyId: null,
  inlineSettings: { items: [{ monitorId: '20000000-0000-4000-8000-000000000001', enabled: true }] } };

describe('feature Save action feedback', () => {
  it.each([null, LINK])('shows success for Save with existing link %s', async (existingId) => {
    const row = { id: LINK, ...payload };
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify(row), { status: 200 }));
    const { result } = renderHook(() => useFeatureLink(POLICY));
    await act(async () => { expect(await result.current.save(existingId, payload)).toEqual(row); });
    expect(fetchWithAuth).toHaveBeenCalledWith(existingId
      ? `/configuration-policies/${POLICY}/features/${LINK}` : `/configuration-policies/${POLICY}/features`,
    expect.objectContaining({ method: existingId ? 'PATCH' : 'POST' }));
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });
  it.each([200, 403])('surfaces a failed body at HTTP %s and retains inline error', async (status) => {
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({ success: false, error: 'Denied' }), { status }));
    const { result } = renderHook(() => useFeatureLink(POLICY));
    await act(async () => { expect(await result.current.save(LINK, payload)).toBeNull(); });
    expect(result.current.error).toBeTruthy();
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });
  it('redirects on 401 without an extra toast', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response('{}', { status: 401 }));
    const { result } = renderHook(() => useFeatureLink(POLICY));
    await act(async () => { expect(await result.current.save(LINK, payload)).toBeNull(); });
    expect(navigateTo).toHaveBeenCalledWith('/login', { replace: true });
    expect(showToast).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/MonitorsTab.recommended.test.tsx src/components/monitoring/MonitorEditor.policyHash.test.tsx src/components/monitoring/MonitorEditor.test.tsx src/components/configurationPolicies/featureTabs/useFeatureLink.test.ts`
Expected: missing Create/Recommended controls and helper exports; create integration navigates to the monitor instead of attaching; tab clicks lose `policy`; feature Save emits no success toast and treats HTTP-200 failure bodies as success.

- [ ] **Step 3: Implement**

Bind `const { t } = useTranslation('policies')` in `MonitorsTab` (replace the current unbound
hook at 59). Task 3 already retained `builtinKey` and `condition` in the catalog type/mapper.
Add the following link next to the attachment picker:

```tsx
<a data-testid="monitors-tab-create"
  href={`/alerts/monitors/new#policy=${encodeURIComponent(policyId)}`}
  className="inline-flex h-9 items-center rounded-md border px-3 text-sm hover:bg-muted">
  {t('configurationPolicies.featureTabs.monitorsTab.createMonitor')}
</a>
```

Derive built-ins and update local attachment state in one functional update:

```ts
const builtIns = catalog.filter((c) => Boolean(c.builtinKey));
const anyBuiltInAttached = items.some((item) => builtIns.some((b) => b.id === item.monitorId));
const attachBuiltIns = () => setItems((previous) => {
  const attached = new Set(previous.map((item) => item.monitorId));
  return [...previous, ...builtIns.filter((b) => !attached.has(b.id))
    .map((b) => ({ monitorId: b.id, enabled: true }))];
});
```

Render above the attachment list:

```tsx
{!catalogLoading && !catalogError && builtIns.length > 0 && !anyBuiltInAttached && (
  <div data-testid="monitors-tab-recommended" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed p-3 text-sm">
    <div>
      <p className="font-medium">{t('configurationPolicies.featureTabs.monitorsTab.recommended.title')}</p>
      <p className="text-muted-foreground">{t('configurationPolicies.featureTabs.monitorsTab.recommended.body')}</p>
    </div>
    <button type="button" data-testid="monitors-tab-recommended-attach"
      className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-primary-foreground"
      onClick={attachBuiltIns}>
      {t('configurationPolicies.featureTabs.monitorsTab.recommended.action')}
    </button>
  </div>
)}
```

Attaching built-ins only changes the draft. Update the real `useFeatureLink.save` path used by
Save, preserving its request body construction (including the POST/PATCH `featurePolicyId`
difference) and its return shape. Add these imports:

```ts
import { runAction, ActionError } from '@/lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { i18n } from '@/lib/i18n';
```

Replace its request/response section (36–47) and catch (48–50), keeping the existing finally:

```ts
return await runAction<FeatureLink>({
  request: () => fetchWithAuth(url, { method, body: JSON.stringify(body) }),
  errorFallback: i18n.t('common:states.error'),
  successMessage: i18n.t('common:states.saved'),
  onUnauthorized: () => void navigateTo('/login', { replace: true }),
});
// Existing catch block:
} catch (err) {
  if (err instanceof ActionError && err.status === 401) return null;
  // runAction already toasted request/API failures; preserve the shell's inline error.
  setError(err instanceof Error ? err.message : i18n.t('common:states.error'));
  return null;
}
```

Both `common.states` keys already exist in all eight locales. Keep `extractApiError`, which the
unchanged remove callback still uses. The post-create attachment request below also uses
`runAction`. In `MonitorEditor`, replace the side-effect-only i18n import
with `import { i18n } from '../../lib/i18n'`, replace `tabFromHash`, and add:

```ts
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function editorHashParams(hash: string): URLSearchParams {
  const raw = hash.replace(/^#/, '');
  const first = raw.split('/')[0];
  if (!raw.includes('=') && (first === 'settings' || first === 'activity')) {
    return new URLSearchParams({ tab: first });
  }
  return new URLSearchParams(raw);
}
export function tabFromHash(hash: string): EditorTab | undefined {
  const params = editorHashParams(hash);
  const tab = params.get('tab');
  if (tab === 'settings' || tab === 'activity') return tab;
  return params.has('policy') ? 'settings' : undefined;
}
export function editorHashForTab(hash: string, tab: EditorTab): string {
  const params = editorHashParams(hash);
  if (!params.has('policy')) return `#${tab}`;
  params.set('tab', tab);
  return `#${params.toString()}`;
}
export async function attachAfterCreate(
  monitorId: string,
  hash: string,
  fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetchWithAuth,
): Promise<string> {
  const policyId = editorHashParams(hash).get('policy');
  if (!policyId || !UUID_RE.test(policyId)) return `/alerts/monitors/${monitorId}`;
  await runAction({
    request: () => fetcher(`/monitor-definitions/${monitorId}/attachments`, {
      method: 'POST', body: JSON.stringify({ configPolicyId: policyId }),
    }),
    errorFallback: i18n.t('monitoring:deploy.errors.attach'),
    successMessage: i18n.t('monitoring:editor.attachedToPolicy'),
    onUnauthorized: UNAUTHORIZED,
  });
  return `/configuration-policies/${policyId}#monitors`;
}
```

Keep `useHashState` for SSR-safe reads. Replace the two existing call sites:

```ts
const switchTab = (tab: EditorTab) => {
  window.location.hash = editorHashForTab(window.location.hash, tab);
  setHashTab(tab);
};
// Inside onSubmit, after deriving savedId, replace its isNew branch:
if (isNew && savedId) {
  void navigateTo(await attachAfterCreate(savedId, window.location.hash));
} else {
  void fetchMonitor();
}
```

The existing catch handles `ActionError` (401 redirects; other failures are already toasted).
Do not redirect to the policy if attachment fails.

`monitoring.json` (8 locales) `editor.attachedToPolicy`: en "Monitor created and attached to the policy" · de-DE "Monitor erstellt und der Richtlinie zugeordnet" · es-419 "Monitor creado y adjuntado a la política" · fr-CA/fr-FR "Moniteur créé et attaché à la politique" · it-IT "Monitor creato e collegato alla policy" · pt-BR "Monitor criado e anexado à política" · tr-TR "Monitör oluşturuldu ve ilkeye bağlandı".

- [ ] **Step 4: Run, expect PASS**

Run: `cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/MonitorsTab src/components/monitoring/MonitorEditor src/components/configurationPolicies/featureTabs/useFeatureLink.test.ts src/lib/i18n/localeParity.test.ts`
Expected: new and existing suites green; no missing locale keys.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.tsx apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.recommended.test.tsx apps/web/src/components/configurationPolicies/featureTabs/useFeatureLink.ts apps/web/src/components/configurationPolicies/featureTabs/useFeatureLink.test.ts apps/web/src/components/monitoring/MonitorEditor.tsx apps/web/src/components/monitoring/MonitorEditor.policyHash.test.tsx apps/web/src/components/monitoring/MonitorEditor.test.tsx apps/web/src/locales
git commit -m "feat(web): policy monitor creation and recommendations with hash preselection"
```

---

### Task 5: Freeze Alert Templates creation; delete the false hint, orphaned editors, `hub.*` keys and `/monitoring/*` stubs

**Files:**
- Modify: `apps/web/src/components/alerts/AlertTemplateList.tsx` (137–148: create button)
- Modify: `apps/web/src/pages/settings/alert-templates/[id].astro` (5–9: parameter and editor mount)
- Modify: `apps/web/src/components/alerts/AlertTemplateEditor.tsx` (379–381: exported editor)
- Modify: `apps/web/src/components/alerts/AlertTemplateEditor.create.test.tsx` (38–128: replace obsolete create suite)
- Modify: `apps/web/src/lib/runActionAllowlist.ts` (26: deleted editor backlog entry)
- Modify: `apps/docs/src/content/docs/features/monitors.mdx` (49: obsolete redirect claim)
- Modify: `apps/web/src/components/monitoring/MonitorEditor.tsx` (698–700, the `agentDeliveredHint` block)
- Modify: `apps/web/src/locales/*/monitoring.json` — delete `editor.agentDeliveredHint` and the whole `hub` block (8 files each)
- Delete: `apps/web/src/components/alerts/AlertRuleEditPage.tsx`, `AlertRuleEditor.tsx`, `AlertRuleEditPage.ownerScope.test.tsx` (the sole matching test)
- Modify: `apps/web/src/components/alerts/index.ts` (lines 26 and 44 — the two exports)
- Delete: `apps/web/src/pages/monitoring/delivery.astro`, `rules.astro`, `network.astro`, `pages/monitoring/monitors/index.astro`, `new.astro`, `[id].astro` (all are `return Astro.redirect(...)` stubs; `pages/monitoring/index.astro` is the real Network page — keep it)
- Test: `apps/web/src/components/alerts/AlertTemplateList.test.tsx` (extend)

**Interfaces:**
- Consumes: `templates.frozen.{title,body,link}` translations from Task 2.
- Produces: `/settings/alert-templates/new` redirects to `/alerts/monitors` (302 during the freeze); direct `<AlertTemplateEditor templateId="new" />` renders the freeze notice with no creation controls or requests. Existing template IDs retain their editor.

- [ ] **Step 1: Write the failing tests**

Replace the existing `navigates to the create and edit routes` test (62–72) in
`AlertTemplateList.test.tsx`; its real `beforeEach` already mocks list loading:

```tsx
it('keeps existing-template editing while removing creation navigation', async () => {
  render(<AlertTemplateList />);
  await screen.findByTestId('alert-template-list');
  expect(screen.queryByTestId('alert-template-create')).toBeNull();
  fireEvent.click(screen.getByTestId('alert-template-edit-t-org'));
  expect(navMock).toHaveBeenCalledWith('/settings/alert-templates/t-org');
});
```

Append to the same describe:

```tsx
it('shows the frozen-creation notice and no New template button', async () => {
  render(<AlertTemplateList />);
  expect(await screen.findByTestId('alert-templates-frozen')).toHaveTextContent('New alert templates are created as monitors');
  expect(screen.getByTestId('alert-templates-frozen-link')).toHaveAttribute('href', '/alerts/monitors');
  expect(screen.queryByRole('button', { name: /new template/i })).toBeNull();
});
```

Replace the obsolete create-mode tests in `AlertTemplateEditor.create.test.tsx` with this complete
suite. Existing edit/managed-template tests in `AlertTemplateEditor.managed.test.tsx` remain.
The route test executes the actual Astro frontmatter with an Astro stub, including its early return:

```tsx
import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AlertTemplateEditor from './AlertTemplateEditor';
import { fetchWithAuth } from '../../stores/auth';
import '../../lib/i18n';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);

beforeEach(() => vi.clearAllMocks());
describe('template creation freeze', () => {
  it('freezes a direct new-editor mount before fetching or rendering a form', () => {
    render(<AlertTemplateEditor templateId="new" />);
    expect(screen.getByTestId('alert-template-editor-frozen')).toHaveTextContent('New alert templates are created as monitors');
    expect(screen.getByTestId('alert-template-editor-frozen-link')).toHaveAttribute('href', '/alerts/monitors');
    expect(screen.queryByRole('button', { name: /create template/i })).toBeNull();
    expect(screen.queryByTestId('template-availability')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['new', '10000000-0000-4000-8000-000000000009'])('guards the actual dynamic page for %s', (id) => {
    const source = readFileSync(new URL('../../pages/settings/alert-templates/[id].astro', import.meta.url), 'utf8');
    const frontmatter = source.split('---')[1]!.replace(/^import .*;\r?$/gm, '');
    const redirect = vi.fn(() => 'redirect-response');
    const result = new Function('Astro', frontmatter)({ params: { id }, redirect });
    if (id === 'new') {
      expect(redirect).toHaveBeenCalledWith('/alerts/monitors', 302);
      expect(result).toBe('redirect-response');
    } else {
      expect(redirect).not.toHaveBeenCalled();
      expect(source).toContain('<AlertTemplateEditor templateId={id} client:load />');
    }
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd apps/web && npx vitest run src/components/alerts/AlertTemplateList.test.tsx src/components/alerts/AlertTemplateEditor.create.test.tsx src/components/alerts/AlertTemplateEditor.managed.test.tsx`
Expected: FAIL — freeze notices absent, the `new` route does not redirect, and direct creation still renders. Existing-template tests remain green.

- [ ] **Step 3: Implement**

`AlertTemplateList.tsx`: replace the `navigateTo('/settings/alert-templates/new')` button with

```tsx
<div data-testid="alert-templates-frozen" role="note" className="flex flex-col gap-1 rounded-md border bg-muted/40 p-3 text-sm">
  <p className="font-medium">{t('templates.frozen.title')}</p>
  <p className="text-muted-foreground">{t('templates.frozen.body')}</p>
  <a data-testid="alert-templates-frozen-link" href="/alerts/monitors" className="text-primary hover:underline">{t('templates.frozen.link')}</a>
</div>
```

`pages/settings/alert-templates/[id].astro`, immediately after reading `Astro.params`:

```astro
const { id } = Astro.params;
if (id === 'new') return Astro.redirect('/alerts/monitors', 302);
```

Guard direct mounts too. Rename the old exported function to
`function ExistingAlertTemplateEditor({ templateId }: AlertTemplateEditorProps)` and insert
this wrapper above it. The old component's hooks and existing-ID save logic remain unchanged;
the new branch cannot mount them or reach its POST path:

```tsx
export default function AlertTemplateEditor(props: AlertTemplateEditorProps) {
  const { t } = useTranslation('alerts');
  if (props.templateId === 'new') {
    return (
      <div data-testid="alert-template-editor-frozen" role="note" className="rounded-md border bg-muted/40 p-3 text-sm">
        <p className="font-medium">{t('templates.frozen.title')}</p>
        <p>{t('templates.frozen.body')}</p>
        <a data-testid="alert-template-editor-frozen-link" href="/alerts/monitors" className="text-primary hover:underline">
          {t('templates.frozen.link')}
        </a>
      </div>
    );
  }
  return <ExistingAlertTemplateEditor {...props} />;
}
```

`MonitorEditor.tsx` 698–700: delete the `<p …>{t('monitoring:editor.agentDeliveredHint')}</p>` line. If the surrounding block renders nothing else for agent-delivered kinds, delete the block.

Locales: in each of the 8 `monitoring.json` files remove the `"agentDeliveredHint"` key and the whole `"hub"` object. Check with:

```bash
rg -n 'agentDeliveredHint|"hub"' apps/web/src/locales/*/monitoring.json   # expect no output
```

Delete the orphaned components and their test; remove the two exports from
`components/alerts/index.ts` and the `AlertRuleEditor.tsx` backlog entry from
`lib/runActionAllowlist.ts:26`. Delete the obsolete parenthetical redirect promise at
`apps/docs/src/content/docs/features/monitors.mdx:49`. Confirm no executable import/export
references remain (historical comments may still name the old editor):

```bash
git rm apps/web/src/components/alerts/AlertRuleEditPage.tsx apps/web/src/components/alerts/AlertRuleEditor.tsx apps/web/src/components/alerts/AlertRuleEditPage.ownerScope.test.tsx
rg -n "^(import|export).*AlertRule(EditPage|Editor)" apps/web/src   # expect no output
git rm apps/web/src/pages/monitoring/delivery.astro apps/web/src/pages/monitoring/rules.astro apps/web/src/pages/monitoring/network.astro apps/web/src/pages/monitoring/monitors/index.astro apps/web/src/pages/monitoring/monitors/new.astro "apps/web/src/pages/monitoring/monitors/[id].astro"
rg -n '(href=|navigateTo\().*/monitoring/(monitors|rules|delivery|network)' apps/web/src   # expect no executable links
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd apps/web && npx vitest run src/components/alerts src/components/monitoring src/locales src/lib/i18n/localeParity.test.ts && npx astro check 2>&1 | tail -5`
Expected: green; `astro check` reports no new errors.

- [ ] **Step 5: Commit**

```bash
git add -A apps/web/src/components/alerts apps/web/src/components/monitoring apps/web/src/locales apps/web/src/pages/monitoring apps/web/src/pages/settings/alert-templates apps/web/src/lib/runActionAllowlist.ts apps/docs/src/content/docs/features/monitors.mdx
git commit -m "chore(web): freeze alert-template creation; drop false watch hint, orphaned rule editors, hub keys and /monitoring stubs"
```

---

### Task 6: Routing API — reject the never-evaluated `conditionTypes` / `deviceTags`

**Files:**
- Modify: `apps/api/src/routes/alerts/routing.ts:26-45` (`createRoutingRuleSchema.conditions`, `updateRoutingRuleSchema.conditions`)
- Test: `apps/api/src/routes/alerts/routing.siteScope.test.ts` (4–10: hoisted mocks; 71–99: UUIDs, app factory and auth setup)
- Modify: `apps/api/src/services/notificationDispatcher.ts` (1272–1277: local conditions cast)
- Modify: `apps/web/src/components/alerts/NotificationChannelsPage.tsx` (125–128: conditions type)

**Interfaces:**
- Produces: `conditions` accepts exactly `{ severities?, siteIds? }` (strict). W05b adds `monitorKinds` to this same object.

- [ ] **Step 1: Write the failing test**

Append inside the existing `notification routing site authorization` describe; use its real
`app()`, `createBody`, `existingRule`, UUID constants, queued selects and mutation spies:

```ts
it.each([
  ['POST', 'conditionTypes'], ['POST', 'deviceTags'],
  ['PATCH', 'conditionTypes'], ['PATCH', 'deviceTags'],
] as const)('rejects %s conditions.%s before querying or writing', async (method, field) => {
  if (method === 'PATCH') selectQueue.push([existingRule([ALLOWED_SITE])], [{ id: ALLOWED_SITE }], [{ id: ALLOWED_SITE }]);
  else selectQueue.push([{ id: ALLOWED_SITE }]);
  const conditions = { severities: ['critical'], siteIds: [ALLOWED_SITE], [field]: ['disk'] };
  const res = await app().request(method === 'POST' ? '/alerts/routing-rules' : `/alerts/routing-rules/${RULE_ID}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(method === 'POST' ? { ...createBody([ALLOWED_SITE]), conditions } : { conditions }),
  });
  expect(res.status).toBe(400);
  expect(JSON.stringify(await res.json())).toContain(field);
  expect(db.select).not.toHaveBeenCalled();
  expect(db.insert).not.toHaveBeenCalled();
  expect(db.update).not.toHaveBeenCalled();
});
it.each(['POST', 'PATCH'] as const)('accepts supported conditions on %s', async (method) => {
  if (method === 'PATCH') selectQueue.push([existingRule([ALLOWED_SITE])], [{ id: ALLOWED_SITE }], [{ id: ALLOWED_SITE }]);
  else selectQueue.push([{ id: ALLOWED_SITE }]);
  const conditions = { severities: ['critical'], siteIds: [ALLOWED_SITE] };
  const res = await app().request(method === 'POST' ? '/alerts/routing-rules' : `/alerts/routing-rules/${RULE_ID}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(method === 'POST' ? { ...createBody([ALLOWED_SITE]), conditions } : { conditions }),
  });
  expect(res.status).toBe(method === 'POST' ? 201 : 200);
  expect(method === 'POST' ? insertValuesMock : updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ conditions }));
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd apps/api && npx vitest run src/routes/alerts/routing.siteScope.test.ts`
Expected: four rejection cases FAIL — actual status 201/200 because both fields are currently accepted. Supported-field and existing cross-site isolation cases pass.

- [ ] **Step 3: Implement**

```ts
const routingConditionsSchema = z.object({
  severities: z.array(z.enum(['critical', 'high', 'medium', 'low', 'info'])).optional(),
  siteIds: z.array(z.string().guid()).optional(),
}).strict(); // conditionTypes / deviceTags were accepted but never evaluated (#W05a); W05b adds monitorKinds here

// createRoutingRuleSchema: conditions: routingConditionsSchema,
// updateRoutingRuleSchema: conditions: routingConditionsSchema.optional(),
```

Drop both `conditionTypes` and `deviceTags` from the dispatcher's local cast at `notificationDispatcher.ts:1272–1277` (type only; no behavior change); drop `conditionTypes` from the web local type at `NotificationChannelsPage.tsx:125–128`.

- [ ] **Step 4: Run, expect PASS**

Run: `cd apps/api && npx vitest run src/routes/alerts/routing.siteScope.test.ts src/services/notificationDispatcher && cd ../web && npx vitest run src/components/alerts/NotificationChannelsPage`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/alerts/routing.ts apps/api/src/routes/alerts/routing.siteScope.test.ts apps/api/src/services/notificationDispatcher.ts apps/web/src/components/alerts/NotificationChannelsPage.tsx
git commit -m "fix(api): routing-rule conditions are strict — drop never-evaluated conditionTypes/deviceTags"
```

---

### Task 7: Mark the 09-08 spec superseded; docs notices

**Files:**
- Modify: `docs/superpowers/specs/monitoring/2026-09-08-monitoring-automation-unification-design.md` (3: status; 9: H1)
- Modify: `apps/docs/src/content/docs/features/alert-templates.mdx`, `apps/docs/src/content/docs/features/service-monitoring.mdx` (8–10: after the imports, before body content)

**Interfaces:**
- Consumes: approved consolidation spec and W05a UI freeze.
- Produces: explicit supersession of D1/W5 and documentation of canonical monitor creation.

- [ ] **Step 1: Edit the 09-08 spec**

Frontmatter: `status: approved` → `status: superseded (D1 and W5 retirement) — see 2026-09-19-alerting-consolidation-design.md`. Under `# Monitoring & Automation unification` add:

```markdown
> **Superseded 2026-09-19.** Decision D1 ("Alerts stays the inbox; Monitoring is a separate domain") and the deferred "W5 — retirement decisions" are replaced by
> [`2026-09-19-alerting-consolidation-design.md`](./2026-09-19-alerting-consolidation-design.md): Alerts is one domain with three facets, monitors are the only authoring surface, and every legacy surface is converted and removed. §Navigation below describes a hub that #5710 reverted; the current IA is in the new spec.
```

- [ ] **Step 2: Docs notices**

Top of `alert-templates.mdx` body:

```mdx
:::note[Creation is frozen]
New alert templates are no longer created here. Author a **Monitor** under **Alerts → Monitors** instead. Existing templates stay editable and are converted to monitors in the next release.
:::
```

Top of `service-monitoring.mdx` body:

```mdx
:::note[Creation is frozen]
New service and process watches are created as **Monitors** (kind *Service* or *Process*) under **Alerts → Monitors** and attached to a policy on its **Monitors** tab. Existing watches stay editable here and are converted in the next release.
:::
```

- [ ] **Step 3: Verify docs build**

Run: `cd apps/docs && npx astro check 2>&1 | tail -3 && npx astro build 2>&1 | tail -3`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/monitoring/2026-09-08-monitoring-automation-unification-design.md apps/docs/src/content/docs/features/alert-templates.mdx apps/docs/src/content/docs/features/service-monitoring.mdx
git commit -m "docs: mark the 09-08 unification spec superseded; freeze notices on alert-templates and service-monitoring pages"
```

---

### Task 8: Verification pass

**Files:**
- Verify all task inventories above; no new implementation files.
- Test: `apps/web/src/lib/i18n/localeParity.test.ts`, `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`, `apps/web/src/lib/__tests__/settingsPageRegistry.test.ts` and suites below.

**Interfaces:**
- Consumes: Tasks 1–7; W05a has no migration or RLS changes.
- Produces: two independently verified PRs, with the W05c2 library-strip handoff explicit.

- [ ] **Step 1: Typecheck**

```bash
cd apps/web && npx astro check 2>&1 | tail -5
cd ../api && npx tsc --noEmit -p . 2>&1 | tail -5
```
Expected: no errors.

- [ ] **Step 2: Web suites touched**

```bash
cd apps/web && npx vitest run src/components/configurationPolicies src/components/alerts src/components/monitoring src/locales src/lib/i18n/localeParity.test.ts src/lib/__tests__/settingsPageRegistry.test.ts src/lib/__tests__/no-silent-mutations.test.ts src/components/layout
```
Expected: all green. `settingsPageRegistry.test.ts` still passes because the alert-templates index remains registered; only the dynamic `new` branch redirects.

- [ ] **Step 3: API suites touched**

```bash
cd apps/api && npx vitest run src/routes/alerts src/services/notificationDispatcher
```
Expected: green.

- [ ] **Step 4: No dead references**

```bash
rg -n 'agentDeliveredHint|"hub"' apps/web/src/locales/*/monitoring.json
rg -n '^(import|export).*AlertRule(EditPage|Editor)' apps/web/src
rg -n '(href=|navigateTo\().*/monitoring/(monitors|rules|delivery|network)' apps/web/src
```
Expected: no output from these targeted executable-reference/key checks. Historical upgrade notes and comments are not executable links.

- [ ] **Step 5: Browser check (one pass)** — bring up `pnpm wt-stack up`, open a policy: Monitors tab shows Create monitor + Recommended strip; attach all → Save → strip disappears; Alerts tab shows the freeze notice and, with a CPU rule + attached High CPU monitor, the duplicate notice on both tabs; Settings → Alert Templates shows the frozen notice; direct `/settings/alert-templates/new` redirects to Monitors while an existing template ID stays editable; policy Create monitor preserves `#policy` and attaches after Save; `/monitoring/rules` now 404s while `/monitoring` still renders the Network page. Tear the stack down (`pnpm wt-stack down`).

- [ ] **Step 6: Open the PRs**

PR 1 (Tasks 1–5, web + redirect-doc correction) and PR 2 (Tasks 6–7, API + docs), both against `main`, body `Closes #<wave-issue>` on the last one to merge, each carrying the settings-PR-template lines (this wave adds no setting; state "settings count unchanged").

## Open questions

None for W05a. D17 settles policy preselection; the separate library Recommended strip belongs to W05c2.
