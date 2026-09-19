---
tracking_issue: (set by feature-lifecycle after registration)
wave_issue: (set by feature-lifecycle after registration)
branch: (set by feature-lifecycle after registration)
---

# Alerting Consolidation — W05a Stop the Bleeding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the copy that lies, warn when a policy alerts twice for one condition, give the policy Monitors tab the "Create monitor" and "Recommended" affordances the 09-08 spec promised, freeze creation on the three legacy authoring surfaces, and delete the dead code and dead API fields — with no schema change.

**Architecture:** All web work hangs off the existing config-policy feature-tab props (`ConfigPolicyDetailPage.tsx` builds one `props` object per tab); this wave adds one prop, `allLinks`, so any tab can see its siblings' inline settings and compute duplicates client-side with a pure helper. Creation freezes are UI-only (buttons become notices that link to `#monitors`); the API keeps accepting edits to existing rows so nothing a tech saved becomes read-only. The routing API drops two fields the dispatcher never evaluated by making the `conditions` object strict.

**Tech Stack:** React 18 + Vitest/jsdom (`apps/web`), Hono + zod (`apps/api`), i18next with eight locale files, Astro pages.

**Spec:** `docs/superpowers/specs/monitoring/2026-09-19-alerting-consolidation-design.md` (§Problem "Copy lies", §End state "Monitors (library)" Recommended strip, "Config policy editor" Create monitor + Duplicate warning, §Removed screens rows marked W05a, §Waves W05a row, §Data model "Routing" for the dropped fields).

**Tracking:** set after feature registration (see frontmatter).

## Ordering assumptions (read first)

- No dependency on any other wave. May run in parallel with W05b on its own branch.
- W05c later replaces the freeze notices with the Needs-conversion panel and W05d deletes the
  legacy tabs; nothing here needs to be undone, only removed.
- The three prerequisite defects (#6342, #6343, #6344) are separate PRs and do not gate this wave.
- `main` at planning time: `b8dd148bd8`. Re-read any cited line range before editing; line
  numbers drift.

## Global Constraints

- **No migration, no schema change** in this wave. If a task seems to need one, stop and re-read the spec.
- **Every new i18n key gets a real translation in all eight locales** (`apps/web/src/locales/{de-DE,en,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/`). A coverage test fails on missing keys. Translations are given verbatim in Task 2; reuse them.
- **Web mutations go through `runAction`** (`apps/web/src/lib/runAction.ts`); the only new mutation here is the attach call in Task 4.
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
| `apps/web/src/components/configurationPolicies/featureTabs/types.ts` | Add `allLinks: FeatureLink[]` to the tab props type |
| `apps/web/src/components/configurationPolicies/ConfigPolicyDetailPage.tsx` (~418-433) | Pass `allLinks: featureLinks` in `props` |
| `apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.tsx` | Duplicate notice; **Create monitor** link; **Recommended** strip; attach-all built-ins |
| `apps/web/src/components/configurationPolicies/featureTabs/AlertRuleTab.tsx` (~641-662) | Duplicate notice; add buttons → freeze notice |
| `apps/web/src/components/configurationPolicies/featureTabs/MonitoringTab.tsx` (~365, 487-489) | Duplicate notice; add-watch button → freeze notice |
| `apps/web/src/components/alerts/AlertTemplateList.tsx` (~140) | "New template" → freeze notice |
| `apps/web/src/components/monitoring/MonitorEditor.tsx` (~404, 698-699) | Delete false hint; honour `?policyId=` after create (attach + return) |
| `apps/web/src/locales/*/monitoring.json` | Delete `editor.agentDeliveredHint` and the `hub` block; add `editor.attachedToPolicy` |
| `apps/web/src/locales/*/policies.json` | Add `configurationPolicies.featureTabs.{legacyFreeze,duplicate,monitorsTab.createMonitor,monitorsTab.recommended}` |
| `apps/web/src/locales/*/alerts.json` | Add `templates.frozen.{title,body,link}` |
| `apps/web/src/components/alerts/AlertRuleEditPage.tsx`, `AlertRuleEditor.tsx` (+ tests, `index.ts:26,44`) | **Delete** (no Astro page imports them) |
| `apps/web/src/pages/monitoring/{delivery,rules,network}.astro`, `pages/monitoring/monitors/{index,new,[id]}.astro` | **Delete** (redirect stubs from the reverted W01/W02 hub) |
| `apps/api/src/routes/alerts/routing.ts` (26-45) | `conditions` schemas become `.strict()` without `conditionTypes`/`deviceTags` |
| `apps/api/src/routes/alerts/routing.test.ts` | Reject payloads carrying the dropped fields |
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
  consumed by Task 2 in three tabs.

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

// Mirrors apps/api/src/services/alertConditions/utils.ts METRIC_COLUMNS, minus
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
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/types.ts` (~line 40, the props type that holds `existingLink: FeatureLink | undefined`)
- Modify: `apps/web/src/components/configurationPolicies/ConfigPolicyDetailPage.tsx` (~418-425, the `props` object)
- Modify: `apps/web/src/locales/*/policies.json` (8 files) under `configurationPolicies.featureTabs`
- Modify: `apps/web/src/locales/*/alerts.json` (8 files) add `templates.frozen`

**Interfaces:**
- Consumes: `findDuplicateConditions`, `DuplicateHit` (Task 1).
- Produces: `<DuplicateConditionNotice hits={DuplicateHit[]} />`, `<LegacyFreezeNotice policyId={string} />`, tab prop `allLinks: FeatureLink[]`.

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

Add to `types.ts`, in the shared tab props type next to `existingLink`:

```ts
  /** Every feature link on this policy — lets a tab see its siblings' inline settings (W05a duplicate warning). */
  allLinks: FeatureLink[];
```

In `ConfigPolicyDetailPage.tsx`, inside the `props = { … }` object (~418):

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

Run: `cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/notices.test.tsx src/locales`
Expected: notices 3 passed; locale coverage suite green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/configurationPolicies/featureTabs/DuplicateConditionNotice.tsx apps/web/src/components/configurationPolicies/featureTabs/LegacyFreezeNotice.tsx apps/web/src/components/configurationPolicies/featureTabs/notices.test.tsx apps/web/src/components/configurationPolicies/featureTabs/types.ts apps/web/src/components/configurationPolicies/ConfigPolicyDetailPage.tsx apps/web/src/locales
git commit -m "feat(web): duplicate-condition and legacy-freeze notices for policy tabs (+i18n, allLinks prop)"
```

---

### Task 3: Wire the duplicate warning and creation freeze into the three legacy tabs

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/AlertRuleTab.tsx` (~635-665: the two "add alert rule" buttons; render site of the list ~670)
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/MonitoringTab.tsx` (~487-489 the `onAdd={() => addWatch()}` control; the notices block ~520-570)
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.tsx` (top of the rendered card)
- Test: `apps/web/src/components/configurationPolicies/featureTabs/legacyTabs.freeze.test.tsx` (create)

**Interfaces:**
- Consumes: `allLinks` prop (Task 2), `findDuplicateConditions` (Task 1), both notices (Task 2).

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
      ? { data: [{ id: 'm-cpu', name: 'High CPU usage', kind: 'cpu', condition: { operator: 'gt', value: 90 }, severity: 'high', enabled: true, builtinKey: 'cpu_high' }] }
      : { data: [] }),
  })),
}));

import { AlertRuleTab } from './AlertRuleTab';
import { MonitoringTab } from './MonitoringTab';
import { MonitorsTab } from './MonitorsTab';

const alertRuleLink = {
  id: 'l-ar', featureType: 'alert_rule', linkedPolicyId: null,
  inlineSettings: { items: [{ name: 'Alert Rule 1', severity: 'medium', conditions: [{ type: 'metric', metric: 'cpuPercent', operator: 'gt', value: 80 }], cooldownMinutes: 15, autoResolve: false }] },
} as any;
const monitorsLink = { id: 'l-mon', featureType: 'monitors', linkedPolicyId: null, inlineSettings: { items: [{ monitorId: 'm-cpu', enabled: true }] } } as any;
const base = { policyId: 'p-1', linkedPolicyId: null, orgId: 'o-1', onSaved: vi.fn(), onDeleted: vi.fn() } as any;

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
    const monLink = { id: 'l-w', featureType: 'monitoring', linkedPolicyId: null, inlineSettings: { checkIntervalSeconds: 60, watches: [] } } as any;
    render(<MonitoringTab {...base} existingLink={monLink} allLinks={[monLink, monitorsLink]} />);
    expect(screen.getByTestId('legacy-freeze-notice')).toBeInTheDocument();
    expect(screen.queryByTestId('monitoring-add-watch')).toBeNull();
  });
  it('MonitorsTab warns about the same duplicate from its side', async () => {
    render(<MonitorsTab {...base} existingLink={monitorsLink} allLinks={[alertRuleLink, monitorsLink]} />);
    expect(await screen.findByTestId('duplicate-condition-notice')).toHaveTextContent('High CPU usage');
  });
});
```

Adjust the `base` props to the tab props type in `types.ts` (read it; add any required callback the type demands, as `vi.fn()`).

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

- **AlertRuleTab / MonitoringTab**: they have no monitor catalog. Fetch it once with the same call `MonitorsTab` makes (`fetchWithAuth('/monitor-definitions')`, read `data`), store in state `catalog`, then
  `const hits = useMemo(() => findDuplicateConditions({ attached, catalog, inlineRules, watches }), [...])`, render `<DuplicateConditionNotice hits={hits} />` above the list. In `AlertRuleTab` the own-tab source is `inlineRules` (use the tab's current in-memory `items` so unsaved edits count); in `MonitoringTab` it is `watches` (its `entries` state).
- **MonitorsTab** already holds `catalog` and `items`; pass `attached: items`.
- **Freeze**: in `AlertRuleTab` replace both add buttons (~641 and ~662) with `<LegacyFreezeNotice policyId={policyId} />` rendered once above the list; keep every per-row edit/delete control. In `MonitoringTab` remove the `onAdd` control at ~487-489 and render `<LegacyFreezeNotice policyId={policyId} />` in its place; give the removed control's former wrapper no replacement other than the notice. Leave the two existing notices (`monitoring-legacy-alert-rules-notice`, `monitoring-alerts-pointer`) in place but change the pointer's target from `#alert_rule` to `#monitors` and its copy to the `legacyFreeze.link` key.

- [ ] **Step 4: Run, expect PASS**

Run: `cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs`
Expected: new suite 4 passed; existing `AlertRuleTab.*`, `MonitoringTab.*`, `MonitorsTab.*` suites still green (update any assertion that clicked "Add alert rule" / "Add watch" to assert the freeze notice instead).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/configurationPolicies/featureTabs
git commit -m "feat(web): freeze legacy rule/watch creation and warn on duplicate conditions in policy tabs"
```

---

### Task 4: Policy Monitors tab — Create monitor, Recommended strip; editor honours `?policyId=`

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.tsx` (header actions; empty/attach area near `availableToAttach` ~124 and `handleAttach` ~126)
- Modify: `apps/web/src/components/monitoring/MonitorEditor.tsx` (~404 post-create navigation)
- Modify: `apps/web/src/locales/*/monitoring.json` add `editor.attachedToPolicy`
- Test: `apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.recommended.test.tsx` (create), `apps/web/src/components/monitoring/MonitorEditor.policyParam.test.tsx` (create)

**Interfaces:**
- Consumes: `POST /monitor-definitions/:id/attachments` with body `{ configPolicyId }` (existing; used by `DeployMonitorDialog.tsx:92`). `GET /monitor-definitions` rows carry `builtinKey` (used by `MonitorsListPage.tsx:28`).
- Produces: link target `/alerts/monitors/new?policyId=<id>`.

- [ ] **Step 1: Write the failing tests**

```tsx
// MonitorsTab.recommended.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '../../../lib/i18n';

const catalog = [
  { id: 'b1', name: 'High CPU usage', kind: 'cpu', builtinKey: 'cpu_high', severity: 'high', enabled: true },
  { id: 'b2', name: 'Disk almost full', kind: 'disk', builtinKey: 'disk_full', severity: 'critical', enabled: true },
  { id: 'c1', name: 'Custom', kind: 'memory', builtinKey: null, severity: 'high', enabled: true },
];
vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async () => ({ ok: true, json: async () => ({ data: catalog }) })),
}));
import { MonitorsTab } from './MonitorsTab';

const link = { id: 'l', featureType: 'monitors', linkedPolicyId: null, inlineSettings: { items: [] } } as any;
const base = { policyId: 'p-9', linkedPolicyId: null, orgId: 'o-1', onSaved: vi.fn(), onDeleted: vi.fn(), allLinks: [link] } as any;

describe('MonitorsTab affordances', () => {
  it('links Create monitor to the editor with the policy pre-selected', async () => {
    render(<MonitorsTab {...base} existingLink={link} />);
    const a = await screen.findByTestId('monitors-tab-create');
    expect(a).toHaveAttribute('href', '/alerts/monitors/new?policyId=p-9');
  });
  it('shows the Recommended strip when no built-in is attached and attaches them all', async () => {
    render(<MonitorsTab {...base} existingLink={link} />);
    const strip = await screen.findByTestId('monitors-tab-recommended');
    expect(strip).toHaveTextContent('Recommended monitors');
    fireEvent.click(screen.getByTestId('monitors-tab-recommended-attach'));
    await waitFor(() => expect(screen.queryByTestId('monitors-tab-recommended')).toBeNull());
    expect(screen.getByText('High CPU usage')).toBeInTheDocument();
    expect(screen.getByText('Disk almost full')).toBeInTheDocument();
    expect(screen.queryByText('Custom')).toBeNull();
  });
  it('hides the strip once any built-in is attached', async () => {
    const attachedLink = { ...link, inlineSettings: { items: [{ monitorId: 'b1', enabled: true }] } };
    render(<MonitorsTab {...base} existingLink={attachedLink} />);
    await screen.findByText('High CPU usage');
    expect(screen.queryByTestId('monitors-tab-recommended')).toBeNull();
  });
});
```

```tsx
// MonitorEditor.policyParam.test.tsx — the create path with ?policyId=
import { describe, expect, it, vi } from 'vitest';
import { attachAfterCreate } from './MonitorEditor';

describe('attachAfterCreate', () => {
  it('attaches to the policy from the query string and returns the policy URL', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => { calls.push([url, init]); return { ok: true, json: async () => ({}) } as Response; });
    const next = await attachAfterCreate('mon-1', new URLSearchParams('policyId=p-9'), fetcher);
    expect(calls[0][0]).toBe('/monitor-definitions/mon-1/attachments');
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ configPolicyId: 'p-9' });
    expect(next).toBe('/configuration-policies/p-9#monitors');
  });
  it('returns the monitor URL when no policyId is present', async () => {
    const fetcher = vi.fn();
    expect(await attachAfterCreate('mon-1', new URLSearchParams(''), fetcher)).toBe('/alerts/monitors/mon-1');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('ignores a non-UUID-shaped policyId', async () => {
    const fetcher = vi.fn();
    expect(await attachAfterCreate('mon-1', new URLSearchParams('policyId=../x'), fetcher)).toBe('/alerts/monitors/mon-1');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/MonitorsTab.recommended.test.tsx src/components/monitoring/MonitorEditor.policyParam.test.tsx`
Expected: FAIL — `monitors-tab-create` not found; `attachAfterCreate` is not exported.

- [ ] **Step 3: Implement**

`MonitorsTab.tsx` — header actions, next to the existing attach select:

```tsx
<a
  data-testid="monitors-tab-create"
  href={`/alerts/monitors/new?policyId=${encodeURIComponent(policyId)}`}
  className="inline-flex h-9 items-center rounded-md border px-3 text-sm hover:bg-muted"
>
  {t('configurationPolicies.featureTabs.monitorsTab.createMonitor')}
</a>
```

Recommended strip (render above the attachment table when `catalog.some(c => c.builtinKey)` and no attached item is a built-in):

```tsx
const builtIns = catalog.filter((c) => Boolean(c.builtinKey));
const anyBuiltInAttached = items.some((it) => builtIns.some((b) => b.id === it.monitorId));
{builtIns.length > 0 && !anyBuiltInAttached && (
  <div data-testid="monitors-tab-recommended" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed p-3 text-sm">
    <div>
      <p className="font-medium">{t('configurationPolicies.featureTabs.monitorsTab.recommended.title')}</p>
      <p className="text-muted-foreground">{t('configurationPolicies.featureTabs.monitorsTab.recommended.body')}</p>
    </div>
    <button
      type="button"
      data-testid="monitors-tab-recommended-attach"
      className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-primary-foreground"
      onClick={() => builtIns.forEach((b) => handleAttach(b.id))}
    >
      {t('configurationPolicies.featureTabs.monitorsTab.recommended.action')}
    </button>
  </div>
)}
```

`handleAttach` already appends to `items` (~126-135); attaching all four leaves the tab dirty and the existing Save persists them through the normal `monitors` inline-settings path — no new API call.

`MonitorEditor.tsx` — export a pure helper and use it at the create success site (~404):

```ts
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** After creating a monitor from a policy's Monitors tab, attach it there and go back. */
export async function attachAfterCreate(
  monitorId: string,
  search: URLSearchParams,
  fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetchWithAuth,
): Promise<string> {
  const policyId = search.get('policyId');
  if (!policyId || !UUID_RE.test(policyId)) return `/alerts/monitors/${monitorId}`;
  await runAction({
    request: () => fetcher(`/monitor-definitions/${monitorId}/attachments`, {
      method: 'POST',
      body: JSON.stringify({ configPolicyId: policyId }),
    }),
    errorFallback: i18n.t('monitoring:deploy.errors.attach'),
    successMessage: i18n.t('monitoring:editor.attachedToPolicy'),
    onUnauthorized: UNAUTHORIZED,
  });
  return `/configuration-policies/${policyId}#monitors`;
}
```

and replace `void navigateTo(\`/alerts/monitors/${savedId}\`)` on the create branch with
`void navigateTo(await attachAfterCreate(savedId, new URLSearchParams(window.location.search)))`.
(`runAction`'s test-environment behaviour: in the unit test above the `fetcher` mock returns
`ok: true`, so `runAction` resolves; if `runAction` requires a toast provider in jsdom, wrap the
call in the same test harness `DeployMonitorDialog.test.tsx` uses.) Make the test's third case
pass by validating the UUID before any request.

`monitoring.json` (8 locales) `editor.attachedToPolicy`: en "Monitor created and attached to the policy" · de-DE "Monitor erstellt und der Richtlinie zugeordnet" · es-419 "Monitor creado y adjuntado a la política" · fr-CA/fr-FR "Moniteur créé et attaché à la politique" · it-IT "Monitor creato e collegato alla policy" · pt-BR "Monitor criado e anexado à política" · tr-TR "Monitör oluşturuldu ve ilkeye bağlandı".

- [ ] **Step 4: Run, expect PASS**

Run: `cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/MonitorsTab src/components/monitoring/MonitorEditor src/locales`
Expected: all green, including the existing `MonitorEditor.test.tsx` and `MonitorsTab` suites.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.tsx apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.recommended.test.tsx apps/web/src/components/monitoring/MonitorEditor.tsx apps/web/src/components/monitoring/MonitorEditor.policyParam.test.tsx apps/web/src/locales
git commit -m "feat(web): Create monitor and Recommended built-ins on the policy Monitors tab; editor attaches via ?policyId="
```

---

### Task 5: Freeze Alert Templates creation; delete the false hint, orphaned editors, `hub.*` keys and `/monitoring/*` stubs

**Files:**
- Modify: `apps/web/src/components/alerts/AlertTemplateList.tsx` (~135-145, the "New template" button)
- Modify: `apps/web/src/components/monitoring/MonitorEditor.tsx` (~696-700, the `agentDeliveredHint` paragraph)
- Modify: `apps/web/src/locales/*/monitoring.json` — delete `editor.agentDeliveredHint` and the whole `hub` block (8 files each)
- Delete: `apps/web/src/components/alerts/AlertRuleEditPage.tsx`, `AlertRuleEditor.tsx`, `AlertRuleEditPage.ownerScope.test.tsx` and any other `AlertRuleEdit*.test.tsx`
- Modify: `apps/web/src/components/alerts/index.ts` (lines 26 and 44 — the two exports)
- Delete: `apps/web/src/pages/monitoring/delivery.astro`, `rules.astro`, `network.astro`, `pages/monitoring/monitors/index.astro`, `new.astro`, `[id].astro` (all are `return Astro.redirect(...)` stubs; `pages/monitoring/index.astro` is the real Network page — keep it)
- Test: `apps/web/src/components/alerts/AlertTemplateList.test.tsx` (extend)

- [ ] **Step 1: Write the failing test** (append to `AlertTemplateList.test.tsx`, reusing its existing render harness)

```tsx
it('shows the frozen-creation notice and no New template button', async () => {
  renderList(); // the file's existing helper
  expect(await screen.findByTestId('alert-templates-frozen')).toHaveTextContent('New alert templates are created as monitors');
  expect(screen.getByTestId('alert-templates-frozen-link')).toHaveAttribute('href', '/alerts/monitors');
  expect(screen.queryByRole('button', { name: /new template/i })).toBeNull();
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd apps/web && npx vitest run src/components/alerts/AlertTemplateList.test.tsx`
Expected: FAIL — `alert-templates-frozen` not found.

- [ ] **Step 3: Implement**

`AlertTemplateList.tsx`: replace the `navigateTo('/settings/alert-templates/new')` button with

```tsx
<div data-testid="alert-templates-frozen" role="note" className="flex flex-col gap-1 rounded-md border bg-muted/40 p-3 text-sm">
  <p className="font-medium">{t('templates.frozen.title')}</p>
  <p className="text-muted-foreground">{t('templates.frozen.body')}</p>
  <a data-testid="alert-templates-frozen-link" href="/alerts/monitors" className="text-primary hover:underline">{t('templates.frozen.link')}</a>
</div>
```

`MonitorEditor.tsx` ~698-699: delete the `<p …>{t('monitoring:editor.agentDeliveredHint')}</p>` line. If the surrounding block renders nothing else for agent-delivered kinds, delete the block.

Locales: in each of the 8 `monitoring.json` files remove the `"agentDeliveredHint"` line and the `"hub": { … }` object (lines 10-19 in `en`). Check with:

```bash
grep -rn "agentDeliveredHint\|\"hub\"" apps/web/src/locales/*/monitoring.json apps/web/src   # expect no output
```

Delete the orphaned components and their tests, remove the two exports from `components/alerts/index.ts`, then confirm nothing imports them:

```bash
git rm apps/web/src/components/alerts/AlertRuleEditPage.tsx apps/web/src/components/alerts/AlertRuleEditor.tsx apps/web/src/components/alerts/AlertRuleEditPage.ownerScope.test.tsx
grep -rn "AlertRuleEditPage\|AlertRuleEditor" apps/web/src   # expect no output
git rm apps/web/src/pages/monitoring/delivery.astro apps/web/src/pages/monitoring/rules.astro apps/web/src/pages/monitoring/network.astro apps/web/src/pages/monitoring/monitors/index.astro apps/web/src/pages/monitoring/monitors/new.astro "apps/web/src/pages/monitoring/monitors/[id].astro"
grep -rn "/monitoring/monitors\|/monitoring/rules\|/monitoring/delivery\|/monitoring/network" apps/web/src apps/docs/src   # fix any remaining link to point at /alerts/*
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd apps/web && npx vitest run src/components/alerts src/components/monitoring src/locales && npx astro check 2>&1 | tail -5`
Expected: green; `astro check` reports no new errors.

- [ ] **Step 5: Commit**

```bash
git add -A apps/web/src/components/alerts apps/web/src/components/monitoring apps/web/src/locales apps/web/src/pages/monitoring
git commit -m "chore(web): freeze alert-template creation; drop false watch hint, orphaned rule editors, hub keys and /monitoring stubs"
```

---

### Task 6: Routing API — reject the never-evaluated `conditionTypes` / `deviceTags`

**Files:**
- Modify: `apps/api/src/routes/alerts/routing.ts:26-45` (`createRoutingRuleSchema.conditions`, `updateRoutingRuleSchema.conditions`)
- Test: `apps/api/src/routes/alerts/routing.test.ts` (extend; create if absent following `routes/alerts/policies.test.ts`'s harness)

**Interfaces:**
- Produces: `conditions` accepts exactly `{ severities?, siteIds? }` (strict). W05b adds `monitorKinds` to this same object.

- [ ] **Step 1: Write the failing test**

```ts
it('rejects conditionTypes and deviceTags, which the dispatcher never evaluated', async () => {
  const res = await app.request('/alerts/routing-rules', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'Disk only', priority: 1, channelIds: [channelId],
      conditions: { severities: ['critical'], conditionTypes: ['disk'] },
    }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(JSON.stringify(body)).toMatch(/conditionTypes/);
});

it('still accepts severities and siteIds', async () => {
  const res = await app.request('/alerts/routing-rules', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: 'Crit', priority: 1, channelIds: [channelId], conditions: { severities: ['critical'], siteIds: [siteId] } }),
  });
  expect(res.status).toBe(201);
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd apps/api && npx vitest run src/routes/alerts/routing.test.ts`
Expected: first test FAIL — status 201 (unknown keys were silently stripped).

- [ ] **Step 3: Implement**

```ts
const routingConditionsSchema = z.object({
  severities: z.array(z.enum(['critical', 'high', 'medium', 'low', 'info'])).optional(),
  siteIds: z.array(z.string().guid()).optional(),
}).strict(); // conditionTypes / deviceTags were accepted but never evaluated (#W05a); W05b adds monitorKinds here

// createRoutingRuleSchema: conditions: routingConditionsSchema,
// updateRoutingRuleSchema: conditions: routingConditionsSchema.optional(),
```

Also drop `conditionTypes` from the dispatcher's local cast at `notificationDispatcher.ts:~1272-1291` (type only; no behaviour change) and from the web local type at `NotificationChannelsPage.tsx:~126-127`.

- [ ] **Step 4: Run, expect PASS**

Run: `cd apps/api && npx vitest run src/routes/alerts/routing.test.ts src/services/notificationDispatcher && cd ../web && npx vitest run src/components/alerts/NotificationChannelsPage`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/alerts/routing.ts apps/api/src/routes/alerts/routing.test.ts apps/api/src/services/notificationDispatcher.ts apps/web/src/components/alerts/NotificationChannelsPage.tsx
git commit -m "fix(api): routing-rule conditions are strict — drop never-evaluated conditionTypes/deviceTags"
```

---

### Task 7: Mark the 09-08 spec superseded; docs notices

**Files:**
- Modify: `docs/superpowers/specs/monitoring/2026-09-08-monitoring-automation-unification-design.md` (frontmatter + a banner under the H1)
- Modify: `apps/docs/src/content/docs/features/alert-templates.mdx`, `apps/docs/src/content/docs/features/service-monitoring.mdx` (one paragraph each, top of body)

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

- [ ] **Step 1: Typecheck**

```bash
cd apps/web && npx astro check 2>&1 | tail -5
cd ../api && npx tsc --noEmit -p . 2>&1 | tail -5
```
Expected: no errors.

- [ ] **Step 2: Web suites touched**

```bash
cd apps/web && npx vitest run src/components/configurationPolicies src/components/alerts src/components/monitoring src/locales src/lib/__tests__/settingsPageRegistry.test.ts src/components/layout
```
Expected: all green. `settingsPageRegistry.test.ts` still passes because the alert-templates pages are untouched in this wave.

- [ ] **Step 3: API suites touched**

```bash
cd apps/api && npx vitest run src/routes/alerts src/services/notificationDispatcher
```
Expected: green.

- [ ] **Step 4: No dead references**

```bash
grep -rn "agentDeliveredHint\|\"hub\"\|AlertRuleEditPage\|AlertRuleEditor\|/monitoring/monitors\|/monitoring/rules\|/monitoring/delivery" apps/web/src apps/api/src apps/docs/src
```
Expected: no output.

- [ ] **Step 5: Browser check (one pass)** — bring up `pnpm wt-stack up`, open a policy: Monitors tab shows Create monitor + Recommended strip; attach all → Save → strip disappears; Alerts tab shows the freeze notice and, with a CPU rule + attached High CPU monitor, the duplicate notice on both tabs; Settings → Alert Templates shows the frozen notice; `/monitoring/rules` now 404s while `/monitoring` still renders the Network page. Tear the stack down (`pnpm wt-stack down`).

- [ ] **Step 6: Open the PRs**

PR 1 (Tasks 1–5, web) and PR 2 (Tasks 6–7, API + docs), both against `main`, body `Closes #<wave-issue>` on the last one to merge, each carrying the settings-PR-template lines (this wave adds no setting; state "settings count unchanged").
