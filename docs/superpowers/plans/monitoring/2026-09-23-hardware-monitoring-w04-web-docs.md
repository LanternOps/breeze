# Hardware & RAID Monitoring — W04 Web + Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show actionable storage health on the Hardware tab and device list, with installation guidance and a real-API browser acceptance test.

**Architecture:** W01 owns collection, freshness, policy resolution and the read endpoint; these React components display its `HardwareHealthView` without deriving health. The existing device-list handler joins W01's rollup for its projection and filter, including its count query and response mapper. Small components use authenticated reads, native disclosure elements and the existing inline-pill classes.

**Tech Stack:** React, TypeScript, react-i18next, Hono, Drizzle, Zod, Vitest/jsdom, Testing Library, Astro Starlight MDX, Playwright, PostgreSQL.

**Spec:** `docs/superpowers/specs/monitoring/2026-09-23-hardware-raid-monitoring-design.md`.
**Index:** `docs/superpowers/plans/monitoring/2026-09-23-hardware-monitoring.md`.
**Wave:** W04, branch `feature/<parent#>-hardware-monitoring/wave-<sub#>`.
**Depends on:** W01 and W03. Start implementation only after both contracts exist on the working branch; W02a/W02b provide live observations but are not needed for seeded acceptance tests.

## Global Constraints

- Web: `fetchWithAuth` from `apps/web/src/stores/auth.ts`; no react-query; inline pill idiom
  (`bg-success/15 text-success border-success/30` etc.); `data-testid` on everything e2e touches;
  mutation handlers via `runAction` (only the config tab mutates).
- Files stay under ~500 lines; new code goes in new files next to the pattern it copies.
- Run the contract suites before every PR that touches tenancy:
  `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`, the integration
  config (`vitest.integration.config.ts`) for cascade / export / merge, with `pnpm test-stack up`.

W04 creates no tables, migration, route file, config feature or mutation. The existing large list files receive narrow insertions; do not split unrelated code. All commands below run from the repository root in independent shells unless a command includes `cd`. The line anchors are from the inspected pre-wave checkout and locate surrounding symbols after W01 lands.

## Review Focus

The index's five numbered review-focus lines belong to W01, W02a and W03; none is owned by W04. W04 pins its §G obligations as follows: full view and state rendering (Tasks 1–7), tenant-scoped list projection/count/filter (Task 8), opt-in column and connected fetch path (Tasks 9–10), supported-tools guidance (Task 11), real-API seeded acceptance (Task 12).

Decisions where the index leaves presentation details open:
- §D wins over spec §11.1's older response sketch: use `lastCollectedAt` and `lastReceivedAt`, never `lastSnapshotAt`.
- §D types are local to the web. The W01 draft now defines its view interfaces in API `services/hardwareHealth/view.ts` (W01 plan lines 1201–1207), with no shared view export; the actual shared barrel contains none. Import shared enum/report types promised by §B; create the three local interfaces below, not a dependency on API source.
- §G `unknown` filters an actual `health = 'unknown'` rollup. A missing rollup stays `null`, renders a dash and does not match that filter.
- §G requires the web Device field to be `Record<string, number>`. The W01 draft (Task 10) stores `{ counts, controllerNames }` in its unspecified summary JSON. Keep the API projection verbatim, normalize its `counts` into that numeric web field in Task 10, and preserve count labels without inventing a new controller schema.
- §11.1 a 404 with `error: 'no_hardware_health'` means no report yet, not proof no tools were detected. Show the no-tooling state only for an accepted `tiersRun: ['none']` report or nonempty all-unavailable sources.
- §11.1 superseding tool names are inferred only from the documented Broadcom precedence and source statuses. When the source array cannot identify the winner, say “superseded”, without fabricating a tool name.
- §13 uses unique SQL-seeded devices; no shared fixture mutation, agent token or network interception.

## File Structure

Create:

- `apps/web/src/components/devices/hardware/types.ts` — local JSON view interfaces matching index §A/§D.
- `apps/web/src/components/devices/hardware/hardwareHealth.fixtures.ts` — complete typed component/view factories for tests.
- `apps/web/src/components/devices/hardware/hardwareHealthCopy.test.ts` — real i18n resource and type fixture checks.
- `apps/web/src/components/devices/hardware/ComponentStatePill.tsx` — state/rollup pill, stale and predictive indicators.
- `apps/web/src/components/devices/hardware/ComponentStatePill.test.tsx` — behavioral tests for ComponentStatePill.
- `apps/web/src/components/devices/hardware/ControllerCard.tsx` — controller hierarchy, rebuild progress and disk facts.
- `apps/web/src/components/devices/hardware/ControllerCard.test.tsx` — behavioral tests for ControllerCard.
- `apps/web/src/components/devices/hardware/SourcesFooter.tsx` — six source statuses and installation guidance.
- `apps/web/src/components/devices/hardware/SourcesFooter.test.tsx` — behavioral tests for SourcesFooter.
- `apps/web/src/components/devices/hardware/HardwareEventsList.tsx` — collapsible transitions and event details.
- `apps/web/src/components/devices/hardware/HardwareEventsList.test.tsx` — behavioral tests for HardwareEventsList.
- `apps/web/src/components/devices/hardware/StorageHealthSection.tsx` — authenticated view loading and storage state composition.
- `apps/web/src/components/devices/hardware/StorageHealthSection.test.tsx` — behavioral tests for StorageHealthSection.
- `apps/web/src/components/devices/DeviceHardwareInventory.hardwareHealth.test.tsx` — mounted-section regression.
- `apps/web/src/components/devices/DeviceList.hardwareHealth.test.tsx` — opt-in list cells and tooltip.
- `apps/web/src/components/devices/hardware/hardwareMonitoringDocs.test.ts` — documentation/sidebar contract.
- `apps/docs/src/content/docs/features/hardware-monitoring.mdx` — customer guide.
- `e2e-tests/pages/DeviceHardwarePage.ts` — testid-only page object.
- `e2e-tests/tests/device-hardware-health.spec.ts` — isolated SQL fixture and real GET acceptance.

Modify:

- `apps/web/src/locales/en/devices.json:1` — localized `hardwareHealth` keys with namespace parity.
- `apps/web/src/locales/es-419/devices.json:1` — localized `hardwareHealth` keys with namespace parity.
- `apps/web/src/locales/pt-BR/devices.json:1` — localized `hardwareHealth` keys with namespace parity.
- `apps/web/src/locales/de-DE/devices.json:1` — localized `hardwareHealth` keys with namespace parity.
- `apps/web/src/locales/it-IT/devices.json:1` — localized `hardwareHealth` keys with namespace parity.
- `apps/web/src/locales/fr-CA/devices.json:1` — localized `hardwareHealth` keys with namespace parity.
- `apps/web/src/locales/fr-FR/devices.json:1` — localized `hardwareHealth` keys with namespace parity.
- `apps/web/src/locales/tr-TR/devices.json:1` — localized `hardwareHealth` keys with namespace parity.
- `apps/web/src/components/devices/DeviceHardwareInventory.tsx:1,286–288` — mount section after summary.
- `apps/web/src/components/devices/columnVisibility.ts:41,88` and `apps/web/src/components/devices/columnVisibility.test.ts:3–13,43` — register hidden-by-default Hardware column.
- `apps/web/src/components/devices/DeviceList.tsx:324,428,2172–2223` — optional fields, agent-only column, renderer beside reliability.
- `apps/web/src/components/devices/DevicesPage.tsx:401,624,643,707–800,885,925–979,2272` — filter, transform and shared list/grid fetch path.
- `apps/web/src/lib/devicesFetch.ts:51,120` and `apps/web/src/lib/devicesFetch.test.ts:1–12` — carry filter on every cursor request.
- `apps/api/src/routes/devices/schemas.ts:45–78` — list query validation (imported by core at line 40).
- `apps/api/src/routes/devices/core.ts:9–22,926,959–964,1049–1059,1249–1250` — projection, filter and joined count.
- `apps/api/src/routes/devices/core.list-response-shape.test.ts:90–126` — list route contract using its real query mocks.
- `apps/api/src/routes/devices/core.permissions.test.ts:268` — existing read-permission matrix.
- `apps/api/src/routes/devices.test.ts:219,916–923` — retain legacy offset pagination with the new join.
- `apps/web/src/components/devices/DevicesPage.test.tsx` — connected filter and field propagation regression.
- `apps/docs/astro.config.mjs:119–143` — feature sidebar entry.

Read-only precedents: `DeviceEffectiveConfigTab.test.tsx:115–148` (mocked auth read + awaited render), `networkDevice/health/GenericHealth.tsx:26–32` (pill classes), `stores/auth.ts:1335` (`fetchWithAuth(rawUrl: string, options: FetchWithAuthOptions = {}): Promise<Response>`), `NetworkDevicePage.ts:10–13,75–81`, `network-device-truth.spec.ts:15–18`, and `e2e-tests/README.md:3` (testid-only selectors).

### Task 1: Define view types, fixtures and translated copy

**Files:** Create `apps/web/src/components/devices/hardware/types.ts`, `apps/web/src/components/devices/hardware/hardwareHealth.fixtures.ts`, `apps/web/src/components/devices/hardware/hardwareHealthCopy.test.ts`. Modify `apps/web/src/locales/en/devices.json:1`, `apps/web/src/locales/es-419/devices.json:1`, `apps/web/src/locales/pt-BR/devices.json:1`, `apps/web/src/locales/de-DE/devices.json:1`, `apps/web/src/locales/it-IT/devices.json:1`, `apps/web/src/locales/fr-CA/devices.json:1`, `apps/web/src/locales/fr-FR/devices.json:1`, `apps/web/src/locales/tr-TR/devices.json:1`. Test: the new copy test and existing `apps/web/src/lib/i18n/localeParity.test.ts`, `apps/web/src/lib/i18n/translationCoverage.test.ts`.

**Interfaces:** Consumes §B `HardwareComponentType`, `HardwareSource`, `HardwareHealth`, `HardwareSourceReport`; produces local `HardwareComponentView`, `HardwareEventView`, `HardwareHealthView`, `component(overrides?: Partial<HardwareComponentView>): HardwareComponentView`, `view(overrides?: Partial<HardwareHealthView>): HardwareHealthView`, and `devices:hardwareHealth.*` keys. `sizeBytes` is a JSON number as in §B; timestamps are serialized strings.

- [ ] **Step 1: Write the failing copy/fixture test (3 minutes).**

```ts
// apps/web/src/components/devices/hardware/hardwareHealthCopy.test.ts
import { describe, expect, it } from 'vitest';
import i18n from 'i18next';
import { component, view } from './hardwareHealth.fixtures';

describe('hardware view contract', () => {
  it('has all persisted fields and server freshness in the local fixture', () => {
    expect(component()).toMatchObject({
      componentType: 'controller', componentKey: 'storcli:c0', fresh: true,
      stale: false, predictiveFailure: false, alertExempt: false,
      unhealthyStreak: 0, criticalStreak: 0, healthyStreak: 2,
      belowCriticalStreak: 2, predictiveStreak: 0,
    });
    expect(view().lastCollectedAt).toBe('2026-09-23T12:00:00.000Z');
    expect(view().lastReceivedAt).toBe('2026-09-23T12:00:01.000Z');
  });
  it('resolves actual English copy, with no raw key fallback', () => {
    expect(i18n.t('hardwareHealth.title', { ns: 'devices', lng: 'en' })).toBe('Storage & RAID');
    expect(i18n.t('hardwareHealth.disabled', {
      ns: 'devices', lng: 'en', policy: 'Servers',
    })).toBe('Hardware monitoring is disabled by policy Servers');
  });
});
```

- [ ] **Step 2: Run red (2 minutes).**

```bash
cd apps/web && npx vitest run src/components/devices/hardware/hardwareHealthCopy.test.ts
```

Expected failure: `Failed to resolve import "./hardwareHealth.fixtures"`. After creating the fixture, missing copy must still fail the exact string assertions until Step 4.

- [ ] **Step 3: Create the complete JSON view interfaces and factories (5 minutes).**

```ts
// apps/web/src/components/devices/hardware/types.ts
import type {
  HardwareComponentType, HardwareHealth, HardwareSource, HardwareSourceReport,
} from '@breeze/shared';
export interface HardwareComponentView {
  id: string; deviceId: string; orgId: string; componentKey: string;
  componentType: HardwareComponentType; parentKey: string | null;
  source: HardwareSource; name: string; model: string | null;
  serial: string | null; firmware: string | null; sizeBytes: number | null;
  health: HardwareHealth; state: string; stateDetail: string | null;
  progressPercent: number | null; temperatureC: number | null;
  predictiveFailure: boolean; alertExempt: boolean;
  attributes: Record<string, unknown>;
  unhealthyStreak: number; criticalStreak: number; healthyStreak: number;
  belowCriticalStreak: number; predictiveStreak: number;
  stale: boolean; staleSince: string | null;
  firstSeenAt: string; lastSeenAt: string; createdAt: string; updatedAt: string;
  fresh: boolean;
}
export interface HardwareEventView {
  id: string; deviceId: string; orgId: string; componentKey: string;
  componentType: HardwareComponentType;
  eventType: 'first_seen' | 'health_changed' | 'state_changed' | 'disk_replaced'
    | 'predictive_failure_set' | 'predictive_failure_cleared' | 'stale' | 'removed';
  fromHealth: HardwareHealth | null; toHealth: HardwareHealth | null;
  fromState: string | null; toState: string | null;
  detail: Record<string, unknown>; snapshotId: string | null;
  occurredAt: string; createdAt: string;
}
export interface HardwareHealthView {
  health: HardwareHealth; collectorHealth: HardwareHealth;
  lastReceivedAt: string | null; lastCollectedAt: string | null;
  pollIntervalMinutes: number | null; diskHealthIntervalMinutes: number | null;
  tiersRun: string[]; agentVersion: string | null;
  sources: HardwareSourceReport[];
  components: HardwareComponentView[]; events: HardwareEventView[];
  policy: { enabled: boolean; source: 'default' | 'policy'; policyName?: string } | null;
}
```

```ts
// apps/web/src/components/devices/hardware/hardwareHealth.fixtures.ts
import type { HardwareComponentView, HardwareHealthView } from './types';
export function component(overrides: Partial<HardwareComponentView> = {}): HardwareComponentView {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    deviceId: '22222222-2222-4222-8222-222222222222',
    orgId: '33333333-3333-4333-8333-333333333333',
    componentKey: 'storcli:c0', componentType: 'controller', parentKey: null,
    source: 'storcli', name: 'PERC H730P Mini', model: 'H730P', serial: 'CTRL-1',
    firmware: '1.0', sizeBytes: null, health: 'ok', state: 'ok', stateDetail: null,
    progressPercent: null, temperatureC: null, predictiveFailure: false,
    alertExempt: false, attributes: {}, unhealthyStreak: 0, criticalStreak: 0,
    healthyStreak: 2, belowCriticalStreak: 2, predictiveStreak: 0,
    stale: false, staleSince: null, fresh: true,
    firstSeenAt: '2026-09-23T12:00:01.000Z', lastSeenAt: '2026-09-23T12:00:01.000Z',
    createdAt: '2026-09-23T12:00:01.000Z', updatedAt: '2026-09-23T12:00:01.000Z',
    ...overrides,
  };
}
export function view(overrides: Partial<HardwareHealthView> = {}): HardwareHealthView {
  return {
    health: 'ok', collectorHealth: 'ok', lastCollectedAt: '2026-09-23T12:00:00.000Z',
    lastReceivedAt: '2026-09-23T12:00:01.000Z', pollIntervalMinutes: 10,
    diskHealthIntervalMinutes: 60, tiersRun: ['raid'], agentVersion: '0.117.0',
    sources: [{ source: 'storcli', status: 'ok', complete: true, toolVersion: '7.4' }],
    components: [component()], events: [], policy: { enabled: true, source: 'default' },
    ...overrides,
  };
}
```

- [ ] **Step 4: Merge the full copy table into all eight existing namespaces (5 minutes).**

Run this one-time editing command from the repository root. It preserves every existing key. Values are in locale order; raw vendor state strings remain observation data, while the surrounding labels are translated. Locale files already exist and start with their root object at line 1.

```bash
python3 - <<'PY'
import json
from pathlib import Path
locales = ['en','es-419','pt-BR','de-DE','it-IT','fr-CA','fr-FR','tr-TR']
rows = {
 'title': ['Storage & RAID','Almacenamiento y RAID','Armazenamento e RAID','Speicher & RAID','Archiviazione e RAID','Stockage et RAID','Stockage et RAID','Depolama ve RAID'],
 'hardware': ['Hardware','Equipo','Equipamento','Geräte','Dispositivi','Matériel','Matériel','Donanım'],
 'ok': ['Healthy','Saludable','Saudável','In Ordnung','Integro','Sain','Sain','Sağlıklı'],
 'warning': ['Warning','Advertencia','Aviso','Warnung','Avviso','Avertissement','Avertissement','Uyarı'],
 'critical': ['Critical','Crítico','Crítico','Kritisch','Critico','Critique','Critique','Kritik'],
 'unknown': ['Unknown','Desconocido','Desconhecido','Unbekannt','Sconosciuto','Inconnu','Inconnu','Bilinmiyor'],
 'loading': ['Loading hardware health…','Cargando estado del hardware…','Carregando integridade do hardware…','Hardwarezustand wird geladen…','Caricamento stato hardware…','Chargement de l’état du matériel…','Chargement de l’état du matériel…','Donanım durumu yükleniyor…'],
 'error': ['Unable to load hardware health.','No se pudo cargar el estado del hardware.','Não foi possível carregar a integridade do hardware.','Hardwarezustand konnte nicht geladen werden.','Impossibile caricare lo stato hardware.','Impossible de charger l’état du matériel.','Impossible de charger l’état du matériel.','Donanım durumu yüklenemedi.'],
 'retry': ['Retry','Reintentar','Tentar novamente','Erneut versuchen','Riprova','Réessayer','Réessayer','Yeniden dene'],
 'noReport': ['No hardware health report received yet.','Aún no se recibió un informe del hardware.','Nenhum relatório de hardware recebido ainda.','Noch kein Hardwarebericht empfangen.','Nessun rapporto hardware ricevuto.','Aucun rapport matériel reçu.','Aucun rapport matériel reçu.','Henüz donanım raporu alınmadı.'],
 'noTools': ['No RAID or disk-health tooling detected — probed: {{sources}}','No se detectaron herramientas de RAID o discos — probadas: {{sources}}','Nenhuma ferramenta de RAID ou discos detectada — verificadas: {{sources}}','Keine RAID- oder Laufwerksdiagnose erkannt — geprüft: {{sources}}','Nessuno strumento RAID o dischi rilevato — verificati: {{sources}}','Aucun outil RAID ou disque détecté — sondés : {{sources}}','Aucun outil RAID ou disque détecté — sondés : {{sources}}','RAID veya disk aracı algılanmadı — denenenler: {{sources}}'],
 'disabled': ['Hardware monitoring is disabled by policy {{policy}}','El monitoreo de hardware está desactivado por la política {{policy}}','O monitoramento de hardware está desativado pela política {{policy}}','Hardwareüberwachung ist durch Richtlinie {{policy}} deaktiviert','Monitoraggio hardware disabilitato dal criterio {{policy}}','La surveillance matérielle est désactivée par la politique {{policy}}','La surveillance matérielle est désactivée par la politique {{policy}}','Donanım izleme {{policy}} ilkesiyle devre dışı'],
 'collected': ['Collected {{time}}','Recopilado {{time}}','Coletado {{time}}','Erfasst {{time}}','Raccolto {{time}}','Collecté {{time}}','Collecté {{time}}','Toplandı: {{time}}'],
 'notSeen': ['Not seen since {{time}}','No visto desde {{time}}','Não visto desde {{time}}','Nicht gesehen seit {{time}}','Non rilevato da {{time}}','Non vu depuis {{time}}','Non vu depuis {{time}}','Son görülme: {{time}}'],
 'predictive': ['Predictive failure','Falla predictiva','Falha preditiva','Vorhergesagter Ausfall','Guasto previsto','Défaillance prédictive','Défaillance prédictive','Öngörülen arıza'],
 'virtualDisks': ['Virtual disks','Discos virtuales','Discos virtuais','Virtuelle Laufwerke','Dischi virtuali','Disques virtuels','Disques virtuels','Sanal diskler'],
 'physicalDisks': ['Physical disks','Discos físicos','Discos físicos','Physische Laufwerke','Dischi fisici','Disques physiques','Disques physiques','Fiziksel diskler'],
 'osDisks': ['OS-visible disks','Discos visibles para el SO','Discos visíveis ao SO','Für das Betriebssystem sichtbare Laufwerke','Dischi visibili al sistema','Disques visibles par le système','Disques visibles par le système','İşletim sisteminde görünen diskler'],
 'backed': ['Backed by RAID virtual disk','Respaldado por disco virtual RAID','Baseado em disco virtual RAID','Durch virtuelles RAID-Laufwerk bereitgestellt','Basato su disco virtuale RAID','Adossé à un disque virtuel RAID','Adossé à un disque virtuel RAID','RAID sanal diski tarafından sağlanır'],
 'enclosures': ['Enclosures: {{total}}','Gabinetes: {{total}}','Gabinetes: {{total}}','Gehäuse: {{total}}','Enclosure: {{total}}','Boîtiers : {{total}}','Boîtiers : {{total}}','Muhafazalar: {{total}}'],
 'identity': ['Model / serial / firmware','Modelo / serie / firmware','Modelo / série / firmware','Modell / Seriennummer / Firmware','Modello / seriale / firmware','Modèle / série / micrologiciel','Modèle / série / micrologiciel','Model / seri / ürün yazılımı'],
 'diskIdentity': ['Slot / model / serial / media / interface','Ranura / modelo / serie / medio / interfaz','Slot / modelo / série / mídia / interface','Steckplatz / Modell / Seriennummer / Medium / Schnittstelle','Slot / modello / seriale / supporto / interfaccia','Emplacement / modèle / série / support / interface','Emplacement / modèle / série / support / interface','Yuva / model / seri / ortam / arabirim'],
 'size': ['Size','Tamaño','Tamanho','Größe','Dimensione','Taille','Taille','Boyut'],
 'state': ['State','Estado','Estado','Status','Stato','État','État','Durum'],
 'telemetry': ['Temperature / media errors / other errors / power-on hours','Temperatura / errores de medio / otros errores / horas encendido','Temperatura / erros de mídia / outros erros / horas ligado','Temperatur / Medienfehler / andere Fehler / Betriebsstunden','Temperatura / errori supporto / altri errori / ore di utilizzo','Température / erreurs support / autres erreurs / heures de fonctionnement','Température / erreurs support / autres erreurs / heures de fonctionnement','Sıcaklık / ortam hataları / diğer hatalar / çalışma saati'],
 'progress': ['{{name}} progress','Progreso de {{name}}','Progresso de {{name}}','Fortschritt von {{name}}','Avanzamento di {{name}}','Progression de {{name}}','Progression de {{name}}','{{name}} ilerlemesi'],
 'sources': ['Sources','Fuentes','Fontes','Quellen','Origini','Sources de collecte','Sources de collecte','Kaynaklar'],
 'unavailable': ['Not installed','No instalado','Não instalado','Nicht installiert','Non installato','Non installé','Non installé','Yüklü değil'],
 'failed': ['Failing: {{error}}','Fallando: {{error}}','Falhando: {{error}}','Fehler: {{error}}','Errore: {{error}}','En échec : {{error}}','En échec : {{error}}','Hata: {{error}}'],
 'backingOff': ['Backing off until {{time}}','En espera hasta {{time}}','Em espera até {{time}}','Pause bis {{time}}','In pausa fino a {{time}}','En pause jusqu’à {{time}}','En pause jusqu’à {{time}}','{{time}} tarihine kadar beklemede'],
 'superseded': ['Superseded by {{winner}}','Reemplazado por {{winner}}','Substituído por {{winner}}','Ersetzt durch {{winner}}','Sostituito da {{winner}}','Remplacé par {{winner}}','Remplacé par {{winner}}','Yerine kullanılan {{winner}}'],
 'sourceSuperseded': ['Superseded','Reemplazado','Substituído','Ersetzt','Sostituito','Remplacé','Remplacé','Yerine başka kaynak kullanılıyor'],
 'sourceDisabled': ['Disabled','Desactivado','Desativado','Deaktiviert','Disabilitato','Désactivé','Désactivé','Devre dışı'],
 'partial': ['Partial report','Informe parcial','Relatório parcial','Teilbericht','Rapporto parziale','Rapport partiel','Rapport partiel','Kısmi rapor'],
 'docs': ['Installation guidance','Guía de instalación','Guia de instalação','Installationsanleitung','Guida all’installazione','Guide d’installation','Guide d’installation','Kurulum rehberi'],
 'events': ['Hardware events','Eventos de hardware','Eventos de hardware','Hardwareereignisse','Eventi hardware','Événements matériels','Événements matériels','Donanım olayları'],
 'noEvents': ['No hardware events recorded.','No hay eventos de hardware.','Nenhum evento de hardware registrado.','Keine Hardwareereignisse erfasst.','Nessun evento hardware registrato.','Aucun événement matériel enregistré.','Aucun événement matériel enregistré.','Donanım olayı kaydedilmedi.'],
 'noComponents': ['No storage components reported. Check source status below.','No se informaron componentes. Revise las fuentes.','Nenhum componente informado. Verifique as fontes.','Keine Speicherkomponenten gemeldet. Quellen prüfen.','Nessun componente segnalato. Verifica le origini.','Aucun composant signalé. Vérifiez les sources.','Aucun composant signalé. Vérifiez les sources.','Bileşen bildirilmedi. Kaynakları kontrol edin.'],
 'all': ['All hardware health','Todos los estados de hardware','Todos os estados de hardware','Alle Hardwarezustände','Tutti gli stati hardware','Tous les états matériels','Tous les états matériels','Tüm donanım durumları'],
}
for index, locale in enumerate(locales):
    path = Path('apps/web/src/locales') / locale / 'devices.json'
    data = json.loads(path.read_text())
    data['hardwareHealth'] = {key: values[index] for key, values in rows.items()}
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
PY
```

- [ ] **Step 5: Run green and commit (3 minutes).**

```bash
cd apps/web && npx vitest run src/components/devices/hardware/hardwareHealthCopy.test.ts src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts
```

Expected: all three files pass, including interpolation/key parity in all locales.

```bash
git add apps/web/src/components/devices/hardware/types.ts apps/web/src/components/devices/hardware/hardwareHealth.fixtures.ts apps/web/src/components/devices/hardware/hardwareHealthCopy.test.ts apps/web/src/locales/{en,es-419,pt-BR,de-DE,it-IT,fr-CA,fr-FR,tr-TR}/devices.json
git commit -m $'feat(hardware): define web view contract and localized copy\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 2: Render server-derived health and component state pills

**Files:** Create `apps/web/src/components/devices/hardware/ComponentStatePill.tsx` and `apps/web/src/components/devices/hardware/ComponentStatePill.test.tsx`. Test: `apps/web/src/components/devices/hardware/ComponentStatePill.test.tsx`.
**Interfaces:** Consumes `HardwareHealth` from §B. Produces `ComponentStatePill({ health, state?, stale?, predictiveFailure?, testId?, title? })`; does not map a state back into a health verdict.

- [ ] **Step 1: Write the failing state matrix (3 minutes).**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ComponentStatePill from './ComponentStatePill';

describe('ComponentStatePill', () => {
  it.each([
    ['ok', 'optimal', 'text-success'],
    ['critical', 'degraded', 'text-destructive'],
    ['warning', 'rebuilding', 'text-warning'],
    ['unknown', 'unknown', 'text-muted-foreground'],
  ] as const)('%s uses server health for %s', (health, state, color) => {
    render(<ComponentStatePill health={health} state={state} />);
    expect(screen.getByTestId('hardware-state-pill')).toHaveClass(color);
    expect(screen.getByTestId('hardware-state-pill')).toHaveTextContent(state);
  });
  it('greys stale evidence without rewriting its recorded state', () => {
    render(<ComponentStatePill health="critical" state="failed" stale predictiveFailure />);
    expect(screen.getByTestId('hardware-state-pill')).toHaveClass('text-muted-foreground');
    expect(screen.getByTestId('hardware-state-pill')).toHaveTextContent('failed');
    expect(screen.getByLabelText('Predictive failure')).toBeInTheDocument();
  });
  it('supports the separately named rollup pill', () => {
    render(<ComponentStatePill health="ok" testId="hardware-rollup-pill" title="2 disks" />);
    expect(screen.getByTestId('hardware-rollup-pill')).toHaveTextContent('Healthy');
    expect(screen.getByTestId('hardware-rollup-pill')).toHaveAttribute('title', '2 disks');
  });
});
```

- [ ] **Step 2: Run red (2 minutes).**

```bash
cd apps/web && npx vitest run src/components/devices/hardware/ComponentStatePill.test.tsx
```

Expected: `Failed to resolve import "./ComponentStatePill"`.

- [ ] **Step 3: Implement the pill (3 minutes).**

```tsx
import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { HardwareHealth } from '@breeze/shared';
const colors: Record<HardwareHealth, string> = {
  ok: 'bg-success/15 text-success border-success/30',
  warning: 'bg-warning/15 text-warning border-warning/30',
  critical: 'bg-destructive/15 text-destructive border-destructive/30',
  unknown: 'bg-muted/40 text-muted-foreground border-muted',
};
const labels: Record<HardwareHealth, string> = {
  ok: 'hardwareHealth.ok', warning: 'hardwareHealth.warning',
  critical: 'hardwareHealth.critical', unknown: 'hardwareHealth.unknown',
};
export default function ComponentStatePill({ health, state, stale = false,
  predictiveFailure = false, testId = 'hardware-state-pill', title,
}: { health: HardwareHealth; state?: string; stale?: boolean;
  predictiveFailure?: boolean; testId?: string; title?: string }) {
  const { t } = useTranslation('devices');
  return <span data-testid={testId} title={title}
    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${colors[stale ? 'unknown' : health]}`}>
    {state?.replaceAll('_', ' ') ?? t(/* i18n-dynamic */ labels[health])}
    {predictiveFailure && <TriangleAlert className="h-3 w-3"
      aria-label={t('hardwareHealth.predictive')} />}
  </span>;
}
```

- [ ] **Step 4: Run green and commit (2 minutes).**

```bash
cd apps/web && npx vitest run src/components/devices/hardware/ComponentStatePill.test.tsx
```

Expected: 6 tests pass.

```bash
git add apps/web/src/components/devices/hardware/ComponentStatePill.tsx apps/web/src/components/devices/hardware/ComponentStatePill.test.tsx
git commit -m $'feat(hardware): render component health pills\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 3: Show controller hierarchy and disk replacement facts

**Files:** Create `apps/web/src/components/devices/hardware/ControllerCard.tsx` and `apps/web/src/components/devices/hardware/ControllerCard.test.tsx`. Test: `apps/web/src/components/devices/hardware/ControllerCard.test.tsx`.
**Interfaces:** Consumes Task 1 `HardwareComponentView`, Task 2 pill. Produces default `ControllerCard({ controller, components })` and named `PhysicalDisksTable({ disks })` for Task 6. `parentKey` establishes hierarchy; a PD below a VD remains visible. `attributes.memberKeys` is optional membership evidence, not another row identity.

- [ ] **Step 1: Write hierarchy, progress and stale tests (4 minutes).**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ControllerCard from './ControllerCard';
import { component } from './hardwareHealth.fixtures';
const vd = component({ componentKey: 'storcli:c0:v0', parentKey: 'storcli:c0',
  name: 'VD 0', componentType: 'virtual_disk', state: 'rebuilding', health: 'warning',
  sizeBytes: 1024 ** 4, progressPercent: 42, attributes: { raidLevel: 'RAID-10' } });
const pd = component({ componentKey: 'storcli:c0:e1:s3', parentKey: vd.componentKey,
  componentType: 'physical_disk', name: 'Slot 3', model: 'Drive Model', serial: 'DISK-3',
  state: 'failed', health: 'critical', stale: true, fresh: false,
  temperatureC: 33, attributes: { slot: 3, mediaType: 'SSD', interface: 'SAS',
    mediaErrors: 0, otherErrors: 2, powerOnHours: 2000 } });
describe('ControllerCard', () => {
  it('shows hierarchy, zero counters, battery, enclosure and rebuild progress', () => {
    render(<ControllerCard controller={component()} components={[vd, pd,
      component({ componentKey: 'storcli:c0:bbu', parentKey: 'storcli:c0',
        componentType: 'cache_battery', name: 'BBU', state: 'learning' }),
      component({ componentKey: 'storcli:c0:enc1', parentKey: 'storcli:c0',
        componentType: 'enclosure', name: 'Enclosure 1' }),
    ]} />);
    expect(screen.getByTestId('hardware-controller-card')).toHaveTextContent('CTRL-1');
    expect(screen.getByText('RAID-10')).toBeInTheDocument();
    expect(screen.getByText('learning')).toBeInTheDocument();
    expect(screen.getByText('Enclosures: 1')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '42');
    expect(screen.getByText('DISK-3')).toBeInTheDocument();
    expect(screen.getByTestId(`hardware-disk-${pd.componentKey}`)).toHaveClass('opacity-60');
    expect(screen.getByText(/Not seen since/)).toBeInTheDocument();
    expect(screen.getByText('33 °C / 0 / 2 / 2000')).toBeInTheDocument();
  });
  it('renders zero percent and greys expired but non-stale rows', () => {
    render(<ControllerCard controller={component()} components={[
      { ...vd, progressPercent: 0 }, { ...pd, stale: false, fresh: false },
    ]} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '0');
    expect(screen.getByTestId(`hardware-disk-${pd.componentKey}`)).toHaveClass('opacity-60');
  });
  it('does not include disks belonging to another controller', () => {
    render(<ControllerCard controller={component()} components={[
      { ...pd, parentKey: 'storcli:c1', serial: 'OTHER' },
    ]} />);
    expect(screen.queryByText('OTHER')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run red (2 minutes).**

```bash
cd apps/web && npx vitest run src/components/devices/hardware/ControllerCard.test.tsx
```

Expected: `Failed to resolve import "./ControllerCard"`.

- [ ] **Step 3: Implement disk rows and controller card (5 minutes).**

```tsx
import { useTranslation } from 'react-i18next';
import { formatNumber } from '@/lib/i18n/format';
import { formatLastSeen } from '@/lib/formatTime';
import ComponentStatePill from './ComponentStatePill';
import type { HardwareComponentView } from './types';
const datum = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '—';
const size = (bytes: number | null): string => bytes === null ? '—'
  : `${formatNumber(bytes / 1024 ** 3, { maximumFractionDigits: 1 })} GiB`;
const expired = (c: HardwareComponentView) => c.stale || !c.fresh;
function State({ c }: { c: HardwareComponentView }) {
  const { t } = useTranslation('devices');
  return <>
    <ComponentStatePill health={c.health} state={c.state} stale={expired(c)}
      predictiveFailure={c.predictiveFailure} title={c.stateDetail ?? undefined} />
    {expired(c) && <p className="mt-1 text-xs text-muted-foreground">
      {t('hardwareHealth.notSeen', { time: formatLastSeen(c.lastSeenAt) })}
    </p>}
  </>;
}
export function PhysicalDisksTable({ disks }: { disks: HardwareComponentView[] }) {
  const { t } = useTranslation('devices');
  return <div className="overflow-x-auto"><table className="w-full text-left text-sm">
    <thead><tr className="border-b text-xs text-muted-foreground">
      <th scope="col" className="p-2">{t('hardwareHealth.diskIdentity')}</th>
      <th scope="col" className="p-2">{t('hardwareHealth.size')}</th>
      <th scope="col" className="p-2">{t('hardwareHealth.state')}</th>
      <th scope="col" className="p-2">{t('hardwareHealth.telemetry')}</th>
    </tr></thead>
    <tbody>{disks.map(c => <tr key={c.componentKey}
      data-testid={`hardware-disk-${c.componentKey}`}
      className={`border-b align-top ${expired(c) ? 'opacity-60 text-muted-foreground' : ''}`}>
      <td className="p-2"><p>{datum(c.attributes.slot)} · {c.name}</p>
        <p>{c.model ?? '—'}</p><p className="font-mono text-xs">{c.serial ?? '—'}</p>
        <p>{datum(c.attributes.mediaType)} / {datum(c.attributes.interface)}</p></td>
      <td className="p-2 whitespace-nowrap">{size(c.sizeBytes)}</td>
      <td className="p-2"><State c={c} /></td>
      <td className="p-2 whitespace-nowrap">{c.temperatureC === null ? '—' : `${c.temperatureC} °C`}
        {' / '}{datum(c.attributes.mediaErrors)}{' / '}{datum(c.attributes.otherErrors)}
        {' / '}{datum(c.attributes.powerOnHours)}</td>
    </tr>)}</tbody>
  </table></div>;
}
export default function ControllerCard({ controller, components }: {
  controller: HardwareComponentView; components: HardwareComponentView[];
}) {
  const { t } = useTranslation('devices');
  const children = components.filter(c => c.parentKey === controller.componentKey);
  const virtual = children.filter(c => c.componentType === 'virtual_disk');
  const virtualKeys = new Set(virtual.map(c => c.componentKey));
  const memberKeys = new Set(virtual.flatMap(c => Array.isArray(c.attributes.memberKeys)
    ? c.attributes.memberKeys.filter((key): key is string => typeof key === 'string') : []));
  const disks = components.filter(c => c.componentType === 'physical_disk'
    && (c.parentKey === controller.componentKey || virtualKeys.has(c.parentKey ?? '')
      || memberKeys.has(c.componentKey))
    && c.source !== 'windows_physical_disk' && c.source !== 'smartctl');
  return <article data-testid="hardware-controller-card" className="rounded-lg border p-4 space-y-4">
    <header className="flex flex-wrap items-start justify-between gap-2">
      <div><h4 className="font-semibold">{controller.name}</h4>
        <p className="text-xs text-muted-foreground">{t('hardwareHealth.identity')}</p>
        <p className="text-sm">{controller.model ?? '—'} / {controller.serial ?? '—'} / {controller.firmware ?? '—'}</p>
      </div><State c={controller} />
    </header>
    <div className="flex flex-wrap items-center gap-2">
      {children.filter(c => c.componentType === 'cache_battery').map(c =>
        <div key={c.componentKey}>{c.name} <State c={c} /></div>)}
      <span className="text-xs text-muted-foreground">{t('hardwareHealth.enclosures', {
        total: children.filter(c => c.componentType === 'enclosure').length,
      })}</span>
    </div>
    {virtual.length > 0 && <div><h5 className="mb-2 text-sm font-medium">{t('hardwareHealth.virtualDisks')}</h5>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm">
        <thead><tr><th scope="col">{t('hardwareHealth.virtualDisks')}</th><th scope="col">RAID</th>
          <th scope="col">{t('hardwareHealth.size')}</th><th scope="col">{t('hardwareHealth.state')}</th></tr></thead>
        <tbody>{virtual.map(c => <tr key={c.componentKey} className={expired(c) ? 'opacity-60' : ''}>
          <td className="py-2">{c.name}</td><td>{datum(c.attributes.raidLevel)}</td>
          <td>{size(c.sizeBytes)}</td><td><State c={c} />
            {c.progressPercent !== null && <div className="flex items-center gap-2">
              <progress data-testid={`hardware-progress-${c.componentKey}`} max={100}
                value={c.progressPercent} className="h-2 w-24 accent-warning"
                aria-label={t('hardwareHealth.progress', { name: c.name })} />
              <span>{c.progressPercent}%</span></div>}
          </td></tr>)}</tbody>
      </table></div></div>}
    {disks.length > 0 && <div><h5 className="mb-2 text-sm font-medium">{t('hardwareHealth.physicalDisks')}</h5>
      <PhysicalDisksTable disks={disks} /></div>}
  </article>;
}
```

- [ ] **Step 4: Run green and commit (2 minutes).**

```bash
cd apps/web && npx vitest run src/components/devices/hardware/ControllerCard.test.tsx
```

Expected: 3 tests pass; literal zero values remain visible.

```bash
git add apps/web/src/components/devices/hardware/ControllerCard.tsx apps/web/src/components/devices/hardware/ControllerCard.test.tsx
git commit -m $'feat(hardware): show controller and disk inventory health\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 4: Explain collector coverage and installation status

**Files:** Create `apps/web/src/components/devices/hardware/SourcesFooter.tsx` and `apps/web/src/components/devices/hardware/SourcesFooter.test.tsx`. Test: `apps/web/src/components/devices/hardware/SourcesFooter.test.tsx`.
**Interfaces:** Consumes §B `HardwareSourceReport[]` and §D `lastCollectedAt`; produces `SourcesFooter({ sources, lastCollectedAt })` and `HARDWARE_DOCS_URL` for the empty-state link. The displayed timestamp is the snapshot timestamp; no per-source timestamp field is invented.

- [ ] **Step 1: Write all six source-status tests (3 minutes).**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import SourcesFooter, { HARDWARE_DOCS_URL } from './SourcesFooter';

describe('SourcesFooter', () => {
  it('explains every source status and preserves partial-report warnings', () => {
    render(<SourcesFooter lastCollectedAt="2026-09-23T12:00:00Z" sources={[
      { source: 'storcli', status: 'ok', complete: false, toolVersion: '7.4', warnings: ['PD query truncated'] },
      { source: 'ssacli', status: 'unavailable' },
      { source: 'megacli', status: 'superseded' },
      { source: 'arcconf', status: 'failed', error: 'exit 2' },
      { source: 'omreport', status: 'backing_off', retryAt: '2026-09-23T18:00:00Z', error: 'timeout' },
      { source: 'smartctl', status: 'disabled' },
    ]} />);
    const footer = screen.getByTestId('hardware-sources-footer');
    expect(footer).toHaveTextContent('v7.4');
    expect(footer).toHaveTextContent('Partial report');
    expect(footer).toHaveTextContent('PD query truncated');
    expect(footer).toHaveTextContent('Superseded by storcli');
    expect(footer).toHaveTextContent('Failing: exit 2');
    expect(footer).toHaveTextContent('Backing off until');
    expect(footer).toHaveTextContent('timeout');
    expect(footer).toHaveTextContent('Disabled');
    expect(screen.getByRole('link', { name: 'Not installed' })).toHaveAttribute('href', HARDWARE_DOCS_URL);
  });
  it('does not claim an absent tool superseded another', () => {
    render(<SourcesFooter lastCollectedAt={null} sources={[
      { source: 'megacli', status: 'superseded' },
    ]} />);
    expect(screen.getByTestId('hardware-sources-footer')).not.toHaveTextContent('storcli');
  });
});
```

- [ ] **Step 2: Run red (2 minutes).**

```bash
cd apps/web && npx vitest run src/components/devices/hardware/SourcesFooter.test.tsx
```

Expected: `Failed to resolve import "./SourcesFooter"`.

- [ ] **Step 3: Implement the status chips (4 minutes).**

```tsx
import { useTranslation } from 'react-i18next';
import { configuredDocsOrigin } from '@/lib/docsEmbed';
import { resolvedFormattingLocale } from '@/lib/i18n/format';
import type { HardwareSourceReport } from '@breeze/shared';
export const HARDWARE_DOCS_URL = `${configuredDocsOrigin() ?? 'https://docs.breezermm.com'}/features/hardware-monitoring/`;
const timestamp = (value: string | null | undefined) => {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return new Intl.DateTimeFormat(resolvedFormattingLocale(), {
    dateStyle: 'short', timeStyle: 'short',
  }).format(new Date(value));
};
export default function SourcesFooter({ sources, lastCollectedAt }: {
  sources: HardwareSourceReport[]; lastCollectedAt: string | null;
}) {
  const { t } = useTranslation('devices');
  const order = ['storcli', 'perccli', 'megacli', 'omreport'];
  const winner = sources.find(s => order.includes(s.source)
    && !['unavailable', 'superseded', 'disabled'].includes(s.status)
    && !sources.some(other => order.includes(other.source)
      && order.indexOf(other.source) < order.indexOf(s.source)
      && !['unavailable', 'superseded', 'disabled'].includes(other.status)));
  return <footer data-testid="hardware-sources-footer" className="border-t pt-3">
    <h4 className="mb-2 text-xs font-medium">{t('hardwareHealth.sources')}</h4>
    <ul className="flex flex-wrap gap-2">{sources.map(s => {
      const label = s.status === 'ok' ? `${t('hardwareHealth.ok')} ${timestamp(lastCollectedAt)}`
        : s.status === 'failed' ? t('hardwareHealth.failed', { error: s.error ?? '—' })
        : s.status === 'backing_off' ? t('hardwareHealth.backingOff', { time: timestamp(s.retryAt) })
        : s.status === 'superseded' ? (order.includes(s.source) && winner
          && order.indexOf(winner.source) < order.indexOf(s.source)
          ? t('hardwareHealth.superseded', { winner: winner.source })
          : t('hardwareHealth.sourceSuperseded'))
        : s.status === 'disabled' ? t('hardwareHealth.sourceDisabled') : t('hardwareHealth.unavailable');
      const color = s.status === 'ok' ? 'bg-success/15 text-success border-success/30'
        : ['failed', 'backing_off'].includes(s.status) ? 'bg-warning/15 text-warning border-warning/30'
        : 'bg-muted/40 text-muted-foreground border-muted';
      return <li key={s.source} className="max-w-full text-xs">
        <span className={`inline-flex flex-wrap items-center gap-1 rounded-full border px-2 py-1 ${color}`}>
          <strong>{s.source}</strong>
          {s.status === 'unavailable' ? <a href={HARDWARE_DOCS_URL} className="underline">{label}</a> : label}
          {s.toolVersion && ` (v${s.toolVersion})`}
        </span>
        {s.status === 'ok' && s.complete === false && <p>{t('hardwareHealth.partial')}</p>}
        {s.status === 'backing_off' && s.error && <p className="break-words">{s.error}</p>}
        {s.warnings?.map((warning, index) => <p key={index} className="break-words text-muted-foreground">{warning}</p>)}
      </li>;
    })}</ul>
  </footer>;
}
```

- [ ] **Step 4: Run green and commit (2 minutes).**

```bash
cd apps/web && npx vitest run src/components/devices/hardware/SourcesFooter.test.tsx
```

Expected: 2 tests pass.

```bash
git add apps/web/src/components/devices/hardware/SourcesFooter.tsx apps/web/src/components/devices/hardware/SourcesFooter.test.tsx
git commit -m $'feat(hardware): explain collection sources and tool installation\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 5: Add the hardware event disclosure

**Files:** Create `apps/web/src/components/devices/hardware/HardwareEventsList.tsx` and `apps/web/src/components/devices/hardware/HardwareEventsList.test.tsx`. Test: `apps/web/src/components/devices/hardware/HardwareEventsList.test.tsx`.
**Interfaces:** Consumes Task 1 `HardwareEventView[]`; produces `HardwareEventsList({ events })`. The API already orders latest 50 first; preserve that order and display scalar event detail without assuming undocumented JSON keys.

- [ ] **Step 1: Write event transition and empty tests (3 minutes).**

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import HardwareEventsList from './HardwareEventsList';
import type { HardwareEventView } from './types';
const event: HardwareEventView = {
  id: '44444444-4444-4444-8444-444444444444', deviceId: '22222222-2222-4222-8222-222222222222',
  orgId: '33333333-3333-4333-8333-333333333333', componentKey: 'storcli:c0:e1:s3',
  componentType: 'physical_disk', eventType: 'state_changed',
  fromHealth: 'ok', toHealth: 'critical', fromState: 'online', toState: 'failed',
  detail: { serial: 'DISK-3' }, snapshotId: null,
  occurredAt: '2026-09-23T12:00:00Z', createdAt: '2026-09-23T12:00:01Z',
};
describe('HardwareEventsList', () => {
  it('starts collapsed and exposes the transition and scalar details', () => {
    render(<HardwareEventsList events={[event]} />);
    expect(screen.getByTestId('hardware-events-list')).not.toHaveAttribute('open');
    fireEvent.click(screen.getByTestId('hardware-events-toggle'));
    expect(screen.getByTestId('hardware-events-list')).toHaveAttribute('open');
    expect(screen.getByTestId(`hardware-event-${event.id}`)).toHaveTextContent('online → failed');
    expect(screen.getByTestId(`hardware-event-${event.id}`)).toHaveTextContent('ok → critical');
    expect(screen.getByText(/DISK-3/)).toBeInTheDocument();
  });
  it('explains an empty history', () => {
    render(<HardwareEventsList events={[]} />);
    fireEvent.click(screen.getByTestId('hardware-events-toggle'));
    expect(screen.getByText('No hardware events recorded.')).toBeVisible();
  });
});
```

- [ ] **Step 2: Run red (2 minutes).**

```bash
cd apps/web && npx vitest run src/components/devices/hardware/HardwareEventsList.test.tsx
```

Expected: `Failed to resolve import "./HardwareEventsList"`.

- [ ] **Step 3: Implement the disclosure (3 minutes).**

```tsx
import { useTranslation } from 'react-i18next';
import { formatLastSeen } from '@/lib/formatTime';
import type { HardwareEventView } from './types';
export default function HardwareEventsList({ events }: { events: HardwareEventView[] }) {
  const { t } = useTranslation('devices');
  return <details data-testid="hardware-events-list" className="border-t pt-3">
    <summary data-testid="hardware-events-toggle" className="cursor-pointer text-sm font-medium">
      {t('hardwareHealth.events')} ({events.length})
    </summary>
    {events.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">{t('hardwareHealth.noEvents')}</p>
      : <ol className="mt-3 space-y-3">{events.map(e => <li key={e.id}
        data-testid={`hardware-event-${e.id}`} className="grid gap-1 text-xs sm:grid-cols-[8rem_1fr]">
        <time dateTime={e.occurredAt} title={e.occurredAt}>{formatLastSeen(e.occurredAt)}</time>
        <div><p className="break-all font-medium">{e.componentKey}</p>
          <p>{e.eventType.replaceAll('_', ' ')} · {e.fromState ?? '—'} → {e.toState ?? '—'}</p>
          <p className="text-muted-foreground">{e.fromHealth ?? '—'} → {e.toHealth ?? '—'}</p>
          {Object.entries(e.detail).filter(([, value]) =>
            ['string', 'number', 'boolean'].includes(typeof value)).map(([key, value]) =>
            <p key={key} className="break-words">{key}: {String(value)}</p>)}
        </div>
      </li>)}</ol>}
  </details>;
}
```

- [ ] **Step 4: Run green and commit (2 minutes).**

```bash
cd apps/web && npx vitest run src/components/devices/hardware/HardwareEventsList.test.tsx
```

Expected: 2 tests pass.

```bash
git add apps/web/src/components/devices/hardware/HardwareEventsList.tsx apps/web/src/components/devices/hardware/HardwareEventsList.test.tsx
git commit -m $'feat(hardware): expose component event history\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 6: Load and compose Storage & RAID states

**Files:** Create `apps/web/src/components/devices/hardware/StorageHealthSection.tsx` and `apps/web/src/components/devices/hardware/StorageHealthSection.test.tsx`. Test: `apps/web/src/components/devices/hardware/StorageHealthSection.test.tsx`.
**Interfaces:** Consumes Task 1 view, Tasks 2–5 components, existing `fetchWithAuth(rawUrl: string, options: FetchWithAuthOptions = {}): Promise<Response>`. Produces `StorageHealthSection({ deviceId }: { deviceId: string })`; GET path is exactly `/devices/${deviceId}/hardware-health`. No synthetic health calculation or policy mutation.

- [ ] **Step 1: Write state, error and request-lifetime tests (5 minutes).**

```tsx
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '../../../stores/auth';
import StorageHealthSection from './StorageHealthSection';
import { component, view } from './hardwareHealth.fixtures';
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
beforeEach(() => vi.mocked(fetchWithAuth).mockReset());
describe('StorageHealthSection', () => {
  it.each(['ok', 'critical'] as const)('shows the %s server rollup', async health => {
    vi.mocked(fetchWithAuth).mockResolvedValue(response(view({ health })));
    render(<StorageHealthSection deviceId="device-a" />);
    expect(await screen.findByTestId('hardware-rollup-pill')).toHaveTextContent(health === 'ok' ? 'Healthy' : 'Critical');
    expect(fetchWithAuth).toHaveBeenCalledWith('/devices/device-a/hardware-health', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.getByTestId('hardware-controller-card')).toHaveTextContent('PERC H730P Mini');
    expect(screen.getByTestId('hardware-sources-footer')).toBeInTheDocument();
  });
  it('distinguishes no tooling from no report', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(response(view({ components: [], tiersRun: ['none'],
      sources: [{ source: 'storcli', status: 'unavailable' }] })));
    render(<StorageHealthSection deviceId="device-a" />);
    expect(await screen.findByTestId('hardware-empty-state')).toHaveTextContent('No RAID or disk-health tooling detected — probed: storcli');
    expect(screen.getByRole('link', { name: 'Installation guidance' })).toBeInTheDocument();
  });
  it('shows a named policy disablement while keeping recorded components', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(response(view({
      policy: { enabled: false, source: 'policy', policyName: 'Servers' },
    })));
    render(<StorageHealthSection deviceId="device-a" />);
    expect(await screen.findByTestId('hardware-empty-state')).toHaveTextContent('disabled by policy Servers');
    expect(screen.getByTestId('hardware-controller-card')).toBeInTheDocument();
  });
  it('uses fresh=false as well as stale and collapses VD-backed OS disks', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(response(view({ components: [component(),
      component({ componentType: 'physical_disk', componentKey: 'winpd:1', source: 'windows_physical_disk',
        name: 'OS disk', state: 'online', fresh: false, stale: false,
        alertExempt: true, attributes: { backedByVd: true } }),
    ] })));
    render(<StorageHealthSection deviceId="device-a" />);
    await screen.findByTestId('hardware-os-disks');
    expect(screen.getByTestId('hardware-backed-disks')).not.toHaveAttribute('open');
    fireEvent.click(screen.getByTestId('hardware-backed-toggle'));
    expect(screen.getByTestId('hardware-disk-winpd:1')).toHaveClass('opacity-60');
    expect(screen.getByText(/Not seen since/)).toBeVisible();
  });
  it('handles only the contracted 404 as an absent report', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(response({ error: 'no_hardware_health' }, 404));
    render(<StorageHealthSection deviceId="device-a" />);
    expect(await screen.findByTestId('hardware-empty-state')).toHaveTextContent('No hardware health report received yet.');
  });
  it.each([403, 404, 500])('surfaces HTTP %s and allows retry', async status => {
    vi.mocked(fetchWithAuth).mockResolvedValueOnce(response({ error: 'denied' }, status))
      .mockResolvedValueOnce(response(view()));
    render(<StorageHealthSection deviceId="device-a" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load hardware health.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('hardware-rollup-pill')).toBeInTheDocument();
  });
  it('does not treat failing empty collection as no installed tools', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(response(view({ components: [],
      sources: [{ source: 'storcli', status: 'failed', error: 'timeout' }] })));
    render(<StorageHealthSection deviceId="device-a" />);
    expect(await screen.findByTestId('hardware-empty-state')).toHaveTextContent('No storage components reported.');
    expect(screen.queryByText(/No RAID or disk-health tooling detected/)).toBeNull();
  });
  it('ignores a late response for the previous device and aborts on unmount', async () => {
    let finish!: (value: Response) => void;
    vi.mocked(fetchWithAuth).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(response(view({ health: 'critical' })));
    const result = render(<StorageHealthSection deviceId="device-a" />);
    result.rerender(<StorageHealthSection deviceId="device-b" />);
    await screen.findByTestId('hardware-rollup-pill');
    await act(async () => finish(response(view({ health: 'ok' }))));
    expect(screen.getByTestId('hardware-rollup-pill')).toHaveTextContent('Critical');
    result.unmount();
    await waitFor(() => expect(vi.mocked(fetchWithAuth).mock.calls[1][1]?.signal?.aborted).toBe(true));
  });
});
```

- [ ] **Step 2: Run red (2 minutes).**

```bash
cd apps/web && npx vitest run src/components/devices/hardware/StorageHealthSection.test.tsx
```

Expected: `Failed to resolve import "./StorageHealthSection"`.

- [ ] **Step 3: Implement the loader and composition (5 minutes).**

```tsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../../stores/auth';
import { formatLastSeen } from '@/lib/formatTime';
import ComponentStatePill from './ComponentStatePill';
import ControllerCard, { PhysicalDisksTable } from './ControllerCard';
import SourcesFooter, { HARDWARE_DOCS_URL } from './SourcesFooter';
import HardwareEventsList from './HardwareEventsList';
import type { HardwareHealthView } from './types';

type Load = { status: 'loading' | 'error' | 'absent' } | { status: 'ready'; view: HardwareHealthView };
export default function StorageHealthSection({ deviceId }: { deviceId: string }) {
  const { t } = useTranslation('devices');
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoad({ status: 'loading' });
    void (async () => {
      try {
        const response = await fetchWithAuth(`/devices/${deviceId}/hardware-health`, { signal: controller.signal });
        const body = await response.json();
        if (!active) return;
        if (response.status === 404 && body.error === 'no_hardware_health') {
          setLoad({ status: 'absent' });
          return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setLoad({ status: 'ready', view: body as HardwareHealthView });
      } catch {
        if (active) setLoad({ status: 'error' });
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [deviceId, attempt]);
  const data = load.status === 'ready' ? load.view : null;
  const disabled = data?.policy?.enabled === false || data?.tiersRun.includes('disabled');
  const controllers = data?.components.filter(c => c.componentType === 'controller') ?? [];
  const disks = data?.components.filter(c => c.componentType === 'physical_disk') ?? [];
  const osDisks = disks.filter(c => c.source === 'windows_physical_disk' || c.source === 'smartctl');
  const backed = osDisks.filter(c => c.attributes.backedByVd === true);
  const standalone = osDisks.filter(c => c.attributes.backedByVd !== true);
  const storage = data?.components.filter(c => !['collector', 'bmc'].includes(c.componentType)) ?? [];
  const noTools = data && (data.tiersRun.includes('none') || (data.sources.length > 0
    && data.sources.every(s => s.status === 'unavailable')));
  const docs = <a className="underline text-primary" href={HARDWARE_DOCS_URL}>{t('hardwareHealth.docs')}</a>;
  return <section data-testid="hardware-storage-section" className="rounded-lg border bg-card p-4 shadow-xs sm:p-6 space-y-4">
    <header className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-semibold">{t('hardwareHealth.title')}</h3>
      {data && <ComponentStatePill health={data.health} stale={Boolean(disabled)} testId="hardware-rollup-pill" />}
    </header>
    {data?.lastCollectedAt && <p className="text-xs text-muted-foreground">
      {t('hardwareHealth.collected', { time: formatLastSeen(data.lastCollectedAt) })}
    </p>}
    {load.status === 'loading' && <p role="status">{t('hardwareHealth.loading')}</p>}
    {load.status === 'error' && <div role="alert"><p>{t('hardwareHealth.error')}</p>
      <button type="button" className="mt-2 text-primary underline" onClick={() => setAttempt(n => n + 1)}>
        {t('hardwareHealth.retry')}</button></div>}
    {load.status === 'absent' && <p data-testid="hardware-empty-state">{t('hardwareHealth.noReport')} {docs}</p>}
    {data && <>
      {disabled ? <p data-testid="hardware-empty-state">{t('hardwareHealth.disabled', {
        policy: data.policy?.policyName ?? '—',
      })}</p> : storage.length === 0 && <p data-testid="hardware-empty-state">
        {noTools ? t('hardwareHealth.noTools', { sources: data.sources.map(s => s.source).join(', ') })
          : t('hardwareHealth.noComponents')} {docs}
      </p>}
      {controllers.map(c => <ControllerCard key={c.componentKey} controller={c} components={data.components} />)}
      {controllers.length === 0 && disks.some(c => !osDisks.includes(c)) &&
        <PhysicalDisksTable disks={disks.filter(c => !osDisks.includes(c))} />}
      {osDisks.length > 0 && <div data-testid="hardware-os-disks" className="space-y-2">
        <h4 className="font-medium">{t('hardwareHealth.osDisks')}</h4>
        {standalone.length > 0 && <PhysicalDisksTable disks={standalone} />}
        {backed.length > 0 && <details data-testid="hardware-backed-disks">
          <summary data-testid="hardware-backed-toggle" className="cursor-pointer text-sm text-muted-foreground">
            {t('hardwareHealth.backed')} ({backed.length})</summary>
          <PhysicalDisksTable disks={backed} />
        </details>}
      </div>}
      <SourcesFooter sources={data.sources} lastCollectedAt={data.lastCollectedAt} />
      <HardwareEventsList events={data.events} />
    </>}
  </section>;
}
```

- [ ] **Step 4: Run green and commit (2 minutes).**

```bash
cd apps/web && npx vitest run src/components/devices/hardware/StorageHealthSection.test.tsx
```

Expected: 11 tests pass, including expired evidence and late-response suppression. W05 adds `ManagementControllerCard` here; do not create it in W04.

```bash
git add apps/web/src/components/devices/hardware/StorageHealthSection.tsx apps/web/src/components/devices/hardware/StorageHealthSection.test.tsx
git commit -m $'feat(hardware): compose authenticated storage health section\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 7: Mount Storage & RAID inside hardware inventory

**Files:** Modify `apps/web/src/components/devices/DeviceHardwareInventory.tsx:4,286–288`; Create `apps/web/src/components/devices/DeviceHardwareInventory.hardwareHealth.test.tsx`. Test: `apps/web/src/components/devices/DeviceHardwareInventory.hardwareHealth.test.tsx`.
**Interfaces:** Consumes Task 6 `StorageHealthSection({ deviceId })`; preserves existing `DeviceHardwareInventory({ deviceId }: DeviceHardwareInventoryProps)` at lines 114–116.

- [ ] **Step 1: Write the failing mounted-section test (3 minutes).**

```tsx
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import DeviceHardwareInventory from './DeviceHardwareInventory';
import { view } from './hardware/hardwareHealth.fixtures';
vi.mock('./DeviceWarrantyCard', () => ({ default: () => null }));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async (url: string) => new Response(JSON.stringify(
    url.endsWith('/hardware-health') ? view() : { cpuModel: 'CPU model', disks: [], networkAdapters: [] },
  ), { status: 200 })),
}));
it('places Storage & RAID after the summary and before the disk table', async () => {
  render(<DeviceHardwareInventory deviceId="22222222-2222-4222-8222-222222222222" />);
  const section = await screen.findByTestId('hardware-storage-section');
  const cpu = screen.getByText('CPU model');
  const diskHeading = screen.getByText('Disk Drives');
  expect(cpu.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(section.compareDocumentPosition(diskHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(await screen.findByTestId('hardware-controller-card')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run red (2 minutes).**

```bash
cd apps/web && npx vitest run src/components/devices/DeviceHardwareInventory.hardwareHealth.test.tsx
```

Expected: `Unable to find an element by: [data-testid="hardware-storage-section"]`.

- [ ] **Step 3: Add the import and mounted element (2 minutes).**

```tsx
// Insert beside DeviceWarrantyCard at DeviceHardwareInventory.tsx:4.
import StorageHealthSection from './hardware/StorageHealthSection';
```

```tsx
// Insert between the summary-grid closing div at :286 and disk grid at :288.
<StorageHealthSection deviceId={deviceId} />
```

- [ ] **Step 4: Run green and commit (2 minutes).**

```bash
cd apps/web && npx vitest run src/components/devices/DeviceHardwareInventory.hardwareHealth.test.tsx src/components/devices/hardware
```

Expected: mounted-section test and all hardware component tests pass. No change to legacy disk health derivation in this task.

```bash
git add apps/web/src/components/devices/DeviceHardwareInventory.tsx apps/web/src/components/devices/DeviceHardwareInventory.hardwareHealth.test.tsx
git commit -m $'feat(devices): mount storage health in hardware inventory\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 8: Project and filter hardware health in the device-list API

**Files:** Modify `apps/api/src/routes/devices/schemas.ts:45–78`, `apps/api/src/routes/devices/core.ts:9–22,926,959–964,1049–1059,1249–1250`, `apps/api/src/routes/devices/core.list-response-shape.test.ts:90–126`, `apps/api/src/routes/devices/core.permissions.test.ts:268`, `apps/api/src/routes/devices.test.ts:219,916–923`. Test: both route tests and existing tenancy contract suites.
**Interfaces:** Consumes W01 `deviceHardwareHealth` from `../../db/schema`; produces `hardwareHealth: HardwareHealth | null` and the unchanged `deviceHardwareHealth.summary` JSON (or null) on API list rows and `hardwareHealth=warning|critical|unknown` query validation. The join is one-to-one on the health table's device primary key. No migration or new MCP coverage entry.

- [ ] **Step 1: Extend the existing query mock and add failing route assertions (5 minutes).**

Add these imports at `core.list-response-shape.test.ts:90`; add the return statement to the end of the existing `rigDeviceListRows(rows: unknown[], lanIpRows = [])` helper at line 117. Its recursive `leftJoin` is already present.

```ts
import { PgDialect } from 'drizzle-orm/pg-core';
import { eq, type SQL } from 'drizzle-orm';
import { deviceHardwareHealth, devices } from '../../db/schema';
import { authMiddleware } from '../../middleware/auth';
// Last statement inside rigDeviceListRows:
return { where, leftJoin };
```

Append inside the existing `describe('GET /devices — response shape', ...)`, which owns `app` and its beforeEach:

```ts
it.each(['warning', 'critical', 'unknown'] as const)('projects and filters hardware %s for rows and total', async health => {
  const { where, leftJoin } = rigDeviceListRows([{
    id: '11111111-1111-4111-8111-111111111111', hostname: 'hardware-host',
    hardwareHealth: health, hardwareHealthSummary: { counts: { 'physical_disk:critical': 2 }, controllerNames: ['PERC'] },
  }]);
  const countWhere = vi.fn().mockResolvedValue([{ count: 1 }]);
  const countChain: Record<string, unknown> = { where: countWhere };
  const countJoin = vi.fn().mockReturnValue(countChain);
  countChain.leftJoin = countJoin;
  vi.mocked(db.select).mockReturnValueOnce({ from: vi.fn().mockReturnValue(countChain) } as never);
  const response = await app.request(`/devices?hardwareHealth=${health}&includeTotal=true`);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.data[0]).toMatchObject({ hardwareHealth: health, hardwareHealthSummary: { counts: { 'physical_disk:critical': 2 }, controllerNames: ['PERC'] } });
  expect(body.pagination.total).toBe(1);
  expect(vi.mocked(db.select).mock.calls[1]?.[0]).toMatchObject({
    hardwareHealth: deviceHardwareHealth.health, hardwareHealthSummary: deviceHardwareHealth.summary,
  });
  expect(leftJoin.mock.calls.some(([table]) => table === deviceHardwareHealth)).toBe(true);
  expect(countJoin.mock.calls.some(([table]) => table === deviceHardwareHealth)).toBe(true);
  for (const value of [where.mock.calls[0]?.[0], countWhere.mock.calls[0]?.[0]]) {
    const query = new PgDialect().sqlToQuery(value as SQL);
    expect(query.sql).toContain('"device_hardware_health"."health"');
    expect(query.sql).not.toMatch(/coalesce/i);
    expect(query.params).toContain(health);
  }
});
it('preserves null projection when no hardware row exists', async () => {
  rigDeviceListRows([{ id: '11111111-1111-4111-8111-111111111111', hardwareHealth: null, hardwareHealthSummary: null }]);
  const response = await app.request('/devices');
  expect((await response.json()).data[0]).toMatchObject({ hardwareHealth: null, hardwareHealthSummary: null });
});
it.each(['ok', 'invalid', ''])('rejects unsupported hardware filter %s', async health => {
  const response = await app.request(`/devices?hardwareHealth=${health}`);
  expect(response.status).toBe(400);
  expect(db.select).not.toHaveBeenCalled();
});
it('rejects a cross-org hardware filter before querying', async () => {
  const response = await app.request('/devices?hardwareHealth=critical&orgId=22222222-2222-4222-8222-222222222222');
  expect(response.status).toBe(403);
  expect(db.select).not.toHaveBeenCalled();
});
it('keeps the caller organization predicate with the hardware filter', async () => {
  const orgId = '11111111-1111-4111-8111-111111111111';
  vi.mocked(authMiddleware).mockImplementationOnce(async (c, next) => {
    c.set('auth', { scope: 'organization', orgId, accessibleOrgIds: [orgId],
      canAccessOrg: (id: string) => id === orgId,
      orgCondition: (column: typeof devices.orgId) => eq(column, orgId),
    } as never);
    await next();
  });
  const { where } = rigDeviceListRows([]);
  const response = await app.request('/devices?hardwareHealth=critical');
  expect(response.status).toBe(200);
  const query = new PgDialect().sqlToQuery(where.mock.calls[0]?.[0] as SQL);
  expect(query.sql).toContain('"devices"."org_id"');
  expect(query.sql).toContain('"device_hardware_health"."health"');
  expect(query.params).toEqual(expect.arrayContaining([orgId, 'critical']));
});
it('returns an empty filtered list without dropping pagination', async () => {
  rigDeviceListRows([]);
  const response = await app.request('/devices?hardwareHealth=warning');
  expect(await response.json()).toMatchObject({ data: [], pagination: { nextCursor: null } });
});
it('does not query when authentication rejects the request', async () => {
  vi.mocked(authMiddleware).mockImplementationOnce(async c => c.json({ error: 'Unauthorized' }, 401));
  expect((await app.request('/devices?hardwareHealth=critical')).status).toBe(401);
  expect(db.select).not.toHaveBeenCalled();
});
it('does not report database failure as empty healthy inventory', async () => {
  vi.mocked(db.select).mockImplementationOnce(() => { throw new Error('database unavailable'); });
  expect((await app.request('/devices?hardwareHealth=critical')).status).toBe(500);
});
```

Add this exact entry to `core.permissions.test.ts:268`'s existing `readPaths` array. Its tests send `x-deny-devices-read` and assert 403.

```ts
'/devices?hardwareHealth=critical',
```

- [ ] **Step 2: Run red (2 minutes).**

```bash
cd apps/api && npx vitest run src/routes/devices/core.list-response-shape.test.ts src/routes/devices/core.permissions.test.ts src/routes/devices.test.ts
```

Expected new failures: missing `hardwareHealth` response property, missing hardware join and `expected 200 to be 400` for rejected filter values. W01's schema must exist before this task; a missing schema import is a dependency failure, not the intended red.

- [ ] **Step 3: Implement all five projection/filter insertion points (4 minutes).**

```ts
// schemas.ts:76, alongside role/search in listDevicesSchema:
hardwareHealth: z.enum(['warning', 'critical', 'unknown']).optional(),
```

```ts
// core.ts:13, in the existing ../../db/schema named import:
deviceHardwareHealth,
```

```ts
// core.ts:926, before query.status:
if (query.hardwareHealth) {
  conditions.push(eq(deviceHardwareHealth.health, query.hardwareHealth));
}
```

```ts
// Replace the entire count query at core.ts:960–964:
const countResult = await db
  .select({ count: sql<number>`count(*)` })
  .from(devices)
  .leftJoin(deviceHardwareHealth, eq(devices.id, deviceHardwareHealth.deviceId))
  .where(whereCondition);
total = Number(countResult[0]?.count ?? 0);
```

```ts
// Add beside reliabilityScore/reliabilityTrend in row SELECT at core.ts:1049:
hardwareHealth: deviceHardwareHealth.health,
hardwareHealthSummary: deviceHardwareHealth.summary,
// Add after the deviceReliability join at :1058, before .where:
.leftJoin(deviceHardwareHealth, eq(devices.id, deviceHardwareHealth.deviceId))
// Add beside reliabilityScore/reliabilityTrend in RESPONSE object at :1249:
hardwareHealth: d.hardwareHealth ?? null,
hardwareHealthSummary: d.hardwareHealthSummary ?? null,
```

Update the existing schema mock at `apps/api/src/routes/devices.test.ts:219` and replace its count-query mock at lines 916–923 with these exact entries. The existing offset-pagination test at line 863 already asserts `pagination.total = 2`; preserve it as a regression guard.

```ts
// Add in the ../db/schema mock beside deviceReliability:
deviceHardwareHealth: { deviceId: 'hardwareDeviceId', health: 'hardwareHealth', summary: 'hardwareHealthSummary' },
// Replace the first mockReturnValueOnce in the list-with-pagination test:
.mockReturnValueOnce({
  from: vi.fn().mockReturnValue({
    leftJoin: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([{ count: 2 }]),
    }),
  }),
} as any)
```

- [ ] **Step 4: Run green, typecheck and tenancy contracts (5 minutes to start; wait for completion).**

```bash
cd apps/api && npx vitest run src/routes/devices/core.list-response-shape.test.ts src/routes/devices/core.permissions.test.ts src/routes/devices.test.ts
```

```bash
NODE_OPTIONS=--max-old-space-size=12288 pnpm --filter @breeze/api exec tsc --noEmit
```

Check the command exit code is zero; never pipe typecheck output to `tail`. The route tests prove predicate/projection composition, not database RLS. Run the actual database contracts as well:

```bash
pnpm test-stack up
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
```

```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
```

Expected: route tests, typecheck, RLS coverage and all four integration suites pass. These are W01's unchanged registrations; a failed contract blocks the W04 PR without adding a new registration or migration here.

- [ ] **Step 5: Commit (2 minutes).**

```bash
git add apps/api/src/routes/devices/schemas.ts apps/api/src/routes/devices/core.ts apps/api/src/routes/devices/core.list-response-shape.test.ts apps/api/src/routes/devices/core.permissions.test.ts apps/api/src/routes/devices.test.ts
git commit -m $'feat(devices): project and filter hardware health rollups\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 9: Add the opt-in Hardware list column

**Files:** Modify `apps/web/src/components/devices/columnVisibility.ts:41,88`, `apps/web/src/components/devices/columnVisibility.test.ts:3–13,43`, `apps/web/src/components/devices/DeviceList.tsx:108,324,428,747,2223`; Create `apps/web/src/components/devices/DeviceList.hardwareHealth.test.tsx` in the same directory. Test: `apps/web/src/components/devices/columnVisibility.test.ts`, `apps/web/src/components/devices/DeviceList.hardwareHealth.test.tsx`.
**Interfaces:** Consumes §G `Device.hardwareHealth?: HardwareHealth | null` and `hardwareHealthSummary?: Record<string, number> | null`; produces column ID `hardwareHealth`, label `Hardware`, absent from `DEFAULT_VISIBLE_COLUMNS`. Numeric summary entries appear in the pill's native title tooltip.

- [ ] **Step 1: Add registry and real-cell tests (4 minutes).**

Import `COLUMN_LABELS` in `columnVisibility.test.ts` and append inside its outer describe:

```ts
it('registers Hardware without enabling it for existing users', () => {
  expect(COLUMN_IDS).toContain('hardwareHealth');
  expect(COLUMN_LABELS.hardwareHealth).toBe('Hardware');
  expect(DEFAULT_VISIBLE_COLUMNS).not.toContain('hardwareHealth');
  expect(readColumnVisibility().has('hardwareHealth')).toBe(false);
  writeColumnVisibility([...DEFAULT_VISIBLE_COLUMNS, 'hardwareHealth']);
  expect(readColumnVisibility().has('hardwareHealth')).toBe(true);
});
```

Create the component test, using the same org/auth stubs as `DeviceList.vpn.test.tsx:10–23`:

```tsx
import { render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import DeviceList, { type Device } from './DeviceList';
import { DEFAULT_VISIBLE_COLUMNS, writeColumnVisibility } from './columnVisibility';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null; allOrgs: boolean }) => unknown) =>
    selector({ currentOrgId: null, allOrgs: true }),
}));
vi.mock('../remote/ConnectDesktopButton', () => ({ default: () => null }));
const device: Device = {
  id: '11111111-1111-4111-8111-111111111111', deviceClass: 'agent', hostname: 'raid-host',
  os: 'linux', osVersion: '22.04', status: 'online', cpuPercent: 0, ramPercent: 0,
  lastSeen: '2026-09-23T12:00:00Z', orgId: '33333333-3333-4333-8333-333333333333', orgName: 'Acme',
  siteId: '44444444-4444-4444-8444-444444444444', siteName: 'HQ', agentVersion: '0.117.0', tags: [],
  hardwareHealth: 'critical', hardwareHealthSummary: { 'physical_disk.critical': 2 },
};
afterEach(() => window.localStorage.clear());
it('keeps the column hidden by default', () => {
  window.localStorage.clear();
  render(<DeviceList devices={[device]} />);
  expect(screen.queryByTestId(`device-${device.id}-hardware-health`)).toBeNull();
});
it.each(['ok', 'warning', 'critical', 'unknown'] as const)('shows %s with numeric summary tooltip', health => {
  writeColumnVisibility([...DEFAULT_VISIBLE_COLUMNS, 'hardwareHealth']);
  render(<DeviceList devices={[{ ...device, hardwareHealth: health }]} />);
  const cell = screen.getByTestId(`device-${device.id}-hardware-health`);
  expect(within(cell).getByTestId('hardware-state-pill')).toHaveAttribute('title', 'physical_disk.critical: 2');
});
it('renders a dash for a missing rollup', () => {
  writeColumnVisibility([...DEFAULT_VISIBLE_COLUMNS, 'hardwareHealth']);
  render(<DeviceList devices={[{ ...device, hardwareHealth: null }]} />);
  expect(screen.getByTestId(`device-${device.id}-hardware-health`)).toHaveTextContent('—');
});
```

- [ ] **Step 2: Run red (2 minutes).**

```bash
cd apps/web && npx vitest run src/components/devices/columnVisibility.test.ts src/components/devices/DeviceList.hardwareHealth.test.tsx
```

Expected: registry lacks `hardwareHealth`; explicit-column tests cannot find `device-11111111-1111-4111-8111-111111111111-hardware-health`.

- [ ] **Step 3: Register the column and implement its cell (4 minutes).**

```ts
// columnVisibility.ts:41: insert immediately after 'reliability' in COLUMN_IDS:
'hardwareHealth',
// columnVisibility.ts:88: insert immediately after reliability in COLUMN_LABELS:
hardwareHealth: 'Hardware',
// DEFAULT_VISIBLE_COLUMNS stays unchanged.
```

```tsx
// DeviceList.tsx:108: add imports:
import type { HardwareHealth } from '@breeze/shared';
import ComponentStatePill from './hardware/ComponentStatePill';
// Device type at :324: add fields after reliabilityTrend:
hardwareHealth?: HardwareHealth | null;
hardwareHealthSummary?: Record<string, number> | null;
// Agent-only column set at :428: add after "reliability":
"hardwareHealth",
// Required sortValue Record<ColumnId,...> entry at :747:
hardwareHealth: (d) => d.hardwareHealth ?? null,
// columnDefs at :2223: add between reliability and vpn:
hardwareHealth: {
  header: () => <span>{t('hardwareHealth.hardware')}</span>,
  cell: (device) => <td key="hardwareHealth" className="px-3 py-3 text-sm"
    data-testid={`device-${device.id}-hardware-health`}>
    {agentCell(device, device.hardwareHealth ? <ComponentStatePill health={device.hardwareHealth}
      title={Object.entries(device.hardwareHealthSummary ?? {})
        .filter(([, count]) => typeof count === 'number' && Number.isFinite(count))
        .map(([label, count]) => `${label}: ${count}`).join(' · ')} /> : dash)}
  </td>,
},
```

- [ ] **Step 4: Run green and commit (2 minutes).**

```bash
cd apps/web && npx vitest run src/components/devices/columnVisibility.test.ts src/components/devices/DeviceList.hardwareHealth.test.tsx
```

Expected: registry and six real-cell tests pass; existing column order/visibility tests still pass.

```bash
git add apps/web/src/components/devices/columnVisibility.ts apps/web/src/components/devices/columnVisibility.test.ts apps/web/src/components/devices/DeviceList.tsx apps/web/src/components/devices/DeviceList.hardwareHealth.test.tsx
git commit -m $'feat(devices): add optional hardware health column\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 10: Connect the fleet filter, cursor fetch and row mapper

**Files:** Modify `apps/web/src/lib/devicesFetch.ts:51–79,120–128`, `apps/web/src/lib/devicesFetch.test.ts:1–12`, `apps/web/src/components/devices/DevicesPage.tsx:401,624,643,707–800,885,925–979,2272`, `apps/web/src/components/devices/DevicesPage.test.tsx:210–224,316–365`. Test: `apps/web/src/lib/devicesFetch.test.ts`, `apps/web/src/components/devices/DevicesPage.test.tsx`.
**Interfaces:** Consumes Task 8 list filter/response and Task 9 Device fields; extends existing `FetchAllDevicesOptions` with `hardwareHealth?: 'warning' | 'critical' | 'unknown'`. Existing `fetchAllDevices(options: FetchAllDevicesOptions = {}): Promise<DevicesListResponse>` keeps its signature. Page-owned select state is local, not browser query parameters; API query parameters carry the requested server filter.

- [ ] **Step 1: Write cursor propagation and connected-page tests (5 minutes).**

Append to the existing `fetchAllDevices` describe in `devicesFetch.test.ts` (its `jsonResponse` already exists):

```ts
it('carries hardwareHealth through every cursor page', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse({
    data: [{ id: 'a' }], pagination: { nextCursor: 'page-2', total: 2 },
  })).mockResolvedValueOnce(jsonResponse({ data: [{ id: 'b' }], pagination: { nextCursor: null } }));
  await fetchAllDevices({ fetcher, hardwareHealth: 'warning' });
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (const [url] of fetcher.mock.calls) {
    expect(new URL(url, 'https://example.com').searchParams.get('hardwareHealth')).toBe('warning');
  }
});
it('omits an unselected hardware filter', async () => {
  const fetcher = vi.fn().mockResolvedValue(jsonResponse({ data: [], pagination: { nextCursor: null } }));
  await fetchAllDevices({ fetcher });
  expect(fetcher.mock.calls[0][0]).not.toContain('hardwareHealth');
});
```

In `DevicesPage.test.tsx:210`, add these fields to `StubDevice`; at its mocked `device-list` div at line 214 add the two attributes. These assertions inspect the mapped props; Task 9 independently renders the real cells.

```tsx
// Add within StubDevice:
hardwareHealth?: string | null;
hardwareHealthSummary?: Record<string, number> | null;
// Add to the mocked div:
data-hardware-health={devices.map(d => d.hardwareHealth ?? '').join(',')}
data-hardware-summary={JSON.stringify(devices.map(d => d.hardwareHealthSummary ?? null))}
```

Append this test at file scope, using existing `rawDevice`, `DEV_1`, `DEV_2`, `DEV_3`, fetcher mocks and global beforeEach:

```tsx
it('filters on the server, maps summaries and restores non-agent rows', async () => {
  const { decodeFilterFromHash } = await import('./filterUrl');
  vi.mocked(decodeFilterFromHash).mockReturnValueOnce(null);
  window.history.replaceState(null, '', window.location.pathname);
  vi.mocked(fetchAllDevices).mockResolvedValue({
    data: [{ ...rawDevice(DEV_1, 'raid-host'), hardwareHealth: 'unknown', hardwareHealthSummary: { counts: { unknown: 2 }, controllerNames: [] } },
      rawDevice(DEV_2, 'no-snapshot')], total: 2, pagesWalked: 1,
  });
  vi.mocked(fetchAllNetworkDevices).mockResolvedValue({
    data: [{ ...rawDevice(DEV_3, 'switch'), deviceClass: 'network' }], total: 1, pagesWalked: 1,
  });
  vi.mocked(fetchAllManualAssets).mockResolvedValue({
    data: [{ ...rawDevice('44444444-4444-4444-4444-444444444444', 'rack'), deviceClass: 'manual' }],
    total: 1, pagesWalked: 1,
  });
  render(<DevicesPage />);
  await waitFor(() => expect(screen.getByTestId('device-list')).toHaveAttribute('data-device-count', '4'));
  fireEvent.change(screen.getByTestId('hardware-health-filter'), { target: { value: 'unknown' } });
  await waitFor(() => expect(fetchAllDevices).toHaveBeenLastCalledWith(expect.objectContaining({ hardwareHealth: 'unknown' })));
  await waitFor(() => expect(screen.getByTestId('device-list')).toHaveAttribute('data-device-count', '1'));
  expect(screen.getByTestId('device-list')).toHaveAttribute('data-hardware-health', 'unknown');
  expect(screen.getByTestId('device-list')).toHaveAttribute('data-hardware-summary', '[{"unknown":2}]');
  expect(screen.getByTestId('device-class-segment-manual').textContent).toMatch(/0$/);
  expect(screen.getByTestId('device-class-segment-network').textContent).toMatch(/0$/);
  fireEvent.click(screen.getByLabelText('Grid view'));
  expect(await screen.findByTestId(`device-card-${DEV_1}`)).toBeTruthy();
  expect(screen.queryByTestId(`device-card-${DEV_2}`)).toBeNull();
  expect(screen.queryByTestId(`device-card-${DEV_3}`)).toBeNull();
  fireEvent.change(screen.getByTestId('hardware-health-filter'), { target: { value: '' } });
  await waitFor(() => expect(fetchAllDevices).toHaveBeenLastCalledWith(expect.objectContaining({ hardwareHealth: undefined })));
  expect(await screen.findByTestId('device-card-44444444-4444-4444-4444-444444444444')).toBeTruthy();
  expect(screen.getByTestId('device-class-segment-manual').textContent).toMatch(/1$/);
  expect(window.location.search).toBe('');
});
```

Also append the refresh/filter race regression. The existing imports already include `act`; `devices-page-refresh` is the real button at `DevicesPage.tsx:2214`.

```tsx
it('ignores a late background refresh from before the hardware filter changed', async () => {
  const { decodeFilterFromHash } = await import('./filterUrl');
  vi.mocked(decodeFilterFromHash).mockReturnValueOnce(null);
  window.history.replaceState(null, '', window.location.pathname);
  const all = { data: [rawDevice(DEV_1, 'old-host'), rawDevice(DEV_2, 'no-snapshot')], total: 2, pagesWalked: 1 };
  let finishOld!: (value: typeof all) => void;
  vi.mocked(fetchAllDevices).mockResolvedValueOnce(all)
    .mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; }))
    .mockResolvedValue({ data: [{ ...rawDevice(DEV_1, 'filtered-host'), hardwareHealth: 'unknown' }], total: 1, pagesWalked: 1 });
  render(<DevicesPage />);
  await waitFor(() => expect(screen.getByTestId('device-list')).toHaveAttribute('data-device-count', '2'));
  fireEvent.click(screen.getByTestId('devices-page-refresh'));
  await waitFor(() => expect(fetchAllDevices).toHaveBeenCalledTimes(2));
  fireEvent.change(screen.getByTestId('hardware-health-filter'), { target: { value: 'unknown' } });
  await waitFor(() => expect(screen.getByTestId('device-list')).toHaveAttribute('data-device-count', '1'));
  await act(async () => { finishOld(all); });
  expect(screen.getByTestId('device-list')).toHaveAttribute('data-hostnames', 'filtered-host');
  expect(screen.getByTestId('device-list')).toHaveAttribute('data-device-count', '1');
  expect(screen.getByTestId('devices-page-refresh')).toHaveAttribute('aria-busy', 'false');
});
```

- [ ] **Step 2: Run red (2 minutes).**

```bash
cd apps/web && npx vitest run src/lib/devicesFetch.test.ts src/components/devices/DevicesPage.test.tsx
```

Expected: `expected null to be 'warning'` for cursor query; missing `hardware-health-filter` for the page. After adding the select but before the generation guard, the late refresh test reports `old-host` instead of `filtered-host`.

- [ ] **Step 3: Implement the connected flow at each inspected anchor (5 minutes).**

```ts
// devicesFetch.ts:51: add inside FetchAllDevicesOptions:
hardwareHealth?: 'warning' | 'critical' | 'unknown';
// devicesFetch.ts:120: after const params = new URLSearchParams(), inside the page loop:
if (options.hardwareHealth) params.set('hardwareHealth', options.hardwareHealth);
```

```tsx
// DevicesPage.tsx:401: after the existing listFilters state:
const [hardwareHealth, setHardwareHealth] = useState<'' | 'warning' | 'critical' | 'unknown'>('');
// :643: inside the existing fetchAllDevices options:
hardwareHealth: hardwareHealth || undefined,
// :780: inside the transformedDevices return object, beside reliabilityScore:
hardwareHealth: d.hardwareHealth === 'ok' || d.hardwareHealth === 'warning'
  || d.hardwareHealth === 'critical' || d.hardwareHealth === 'unknown' ? d.hardwareHealth : null,
hardwareHealthSummary: asRecord(d.hardwareHealthSummary)
  ? Object.fromEntries(Object.entries(
      asRecord(asRecord(d.hardwareHealthSummary)?.counts) ?? asRecord(d.hardwareHealthSummary)!,
    ).filter((entry): entry is [string, number] =>
      typeof entry[1] === 'number' && Number.isFinite(entry[1]))) : null,
// :885: replace const allTransformed with:
const allTransformed = hardwareHealth
  ? transformedDevices.filter(d => d.hardwareHealth === hardwareHealth)
  : [...transformedDevices, ...transformedNetworkDevices, ...transformedManualAssets];
// :925: immediately before setDeviceGroups(groupsList):
if (!isCurrentDeviceFetch()) return;
// :979: replace ONLY fetchDevices' useCallback dependency list:
}, [t, hardwareHealth]);
```

Guard every completion, including the existing header refresh that deliberately has no AbortSignal. Add the ref at line 402 and the cleanup effect beside it; `useRef` is already imported at line 1. This is local request lifetime state, not another data cache.

```tsx
const deviceFetchGeneration = useRef(0);
useEffect(() => () => { deviceFetchGeneration.current += 1; }, []);
// Insert at entry to the existing fetchDevices callback at :624:
const generation = ++deviceFetchGeneration.current;
const isCurrentDeviceFetch = () => generation === deviceFetchGeneration.current && !signal?.aborted;
// Insert after its Promise.all resolves at :707, before const deviceList:
if (!isCurrentDeviceFetch()) return;
// Insert as the first line of fetchDevices' outer catch (err) at :956:
if (!isCurrentDeviceFetch()) return;
// Replace the final if (!signal?.aborted) block at :974–978:
if (isCurrentDeviceFetch()) {
  setRefreshing(false);
  setLoading(false);
}
// Replace the version-map conditional at :947, inside the nested .then:
if (isCurrentDeviceFetch() && data && typeof data === 'object' && !Array.isArray(data)) {
  setEffectiveAgentVersionByOrgId(data);
}
```

Insert this JSX immediately before `{filtersV2 ? (` at `DevicesPage.tsx:2272`, outside the table/grid split:

```tsx
<label className="flex items-center gap-2 text-sm">
  <span>{t('hardwareHealth.hardware')}</span>
  <select data-testid="hardware-health-filter" value={hardwareHealth}
    className="rounded-md border bg-background px-3 py-2"
    onChange={event => {
      const next = event.target.value;
      if (next === '' || next === 'warning' || next === 'critical' || next === 'unknown') setHardwareHealth(next);
    }}>
    <option value="">{t('hardwareHealth.all')}</option>
    <option value="warning">{t('hardwareHealth.warning')}</option>
    <option value="critical">{t('hardwareHealth.critical')}</option>
    <option value="unknown">{t('hardwareHealth.unknown')}</option>
  </select>
</label>
```

The existing fetch effect at lines 1016–1027 aborts its old request when `fetchDevices` changes; the generation guard also rejects late signal-less refreshes and their errors. Filtering the common `allTransformed` collection also keeps class counts, grid, table and advanced-filter intersection consistent. A missing rollup and network/manual assets do not masquerade as hardware `unknown`.

- [ ] **Step 4: Run green and commit (2 minutes).**

```bash
cd apps/web && npx vitest run src/lib/devicesFetch.test.ts src/components/devices/DevicesPage.test.tsx src/components/devices/DeviceList.hardwareHealth.test.tsx
```

Expected: all three files pass; cursor continuation retains the filter and clearing it restores non-agent rows.

```bash
git add apps/web/src/lib/devicesFetch.ts apps/web/src/lib/devicesFetch.test.ts apps/web/src/components/devices/DevicesPage.tsx apps/web/src/components/devices/DevicesPage.test.tsx
git commit -m $'feat(devices): connect hardware filter across fleet views\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 11: Publish the supported-tools and monitoring guide

**Files:** Create `apps/docs/src/content/docs/features/hardware-monitoring.mdx`, `apps/web/src/components/devices/hardware/hardwareMonitoringDocs.test.ts`; Modify `apps/docs/astro.config.mjs:126` within Monitoring & Alerting. Test: `apps/web/src/components/devices/hardware/hardwareMonitoringDocs.test.ts`.
**Interfaces:** Consumes W01's policy feature, W03's four built-in defaults and W02a/W02b tool contract. Produces docs slug `features/hardware-monitoring` used by Task 4. The separate `monitoring/*` sidebar is self-hosting observability and is not the destination.

- [ ] **Step 1: Write the failing documentation/sidebar contract (3 minutes).**

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
describe('hardware monitoring documentation', () => {
  it('documents sources, attachment, semantics and local configuration', () => {
    const doc = read('../../../../../docs/src/content/docs/features/hardware-monitoring.mdx');
    for (const source of ['storcli', 'perccli', 'megacli', 'ssacli', 'arcconf', 'omreport',
      'mdadm', 'zfs', 'storage_spaces', 'windows_physical_disk', 'smartctl']) expect(doc).toContain(source);
    for (const key of ['raid_array_degraded', 'physical_disk_failed', 'cache_battery_problem',
      'hardware_collector_failing', 'tool_dirs', 'fixture-only']) expect(doc).toContain(key);
    expect(doc).toContain('not attached');
    expect(doc).toContain('rebuilding is warning');
    expect(doc).toContain('unknown does not resolve');
    expect(doc).toContain('hardware_monitoring');
    expect(doc).toContain('## Install the tools');
  });
  it('registers the page inside Monitoring & Alerting', () => {
    const config = read('../../../../../docs/astro.config.mjs');
    const group = config.slice(config.indexOf("label: 'Monitoring & Alerting'"), config.indexOf("label: 'AI & Intelligence'"));
    expect(group).toContain("{ slug: 'features/hardware-monitoring' }");
  });
});
```

- [ ] **Step 2: Run red (2 minutes).**

```bash
cd apps/web && npx vitest run src/components/devices/hardware/hardwareMonitoringDocs.test.ts
```

Expected: `ENOENT` for the missing MDX and missing sidebar slug assertion.

- [ ] **Step 3: Write the full customer guide (5 minutes).**

Use the same frontmatter and `Steps`/`Aside` imports as `features/service-monitoring.mdx:1–8`. The official installation pointers below were checked while preparing this plan; choose the package matching the machine and controller, not a pinned driver version.

````mdx
---
title: Hardware & RAID Monitoring
description: See controller, array, physical disk and cache-battery health, and attach hardware monitors to configuration policies.
sidebar:
  label: Hardware & RAID
---

import { Steps, Aside } from '@astrojs/starlight/components';

## What Breeze monitors

Open a device's **Hardware** tab and find **Storage & RAID**. It shows controller identity, virtual disks and RAID level, physical disk model and serial, slot, size, temperature, error counters and rebuild progress when the source reports them. The **OS-visible disks** group separates operating-system observations; disks backed by a RAID virtual disk are collapsed beneath that note and do not create duplicate alerts.

Breeze detects installed tools and reads their output. It never downloads or bundles vendor utilities, changes controller configuration, starts a rebuild or clears a foreign configuration. Collection works on supported Windows and Linux hosts with an agent; it is capability-detected rather than restricted to devices classified as servers. macOS and agentless hypervisors are outside this feature.

The device list has an optional **Hardware** column. Enable it in the column picker for the rollup pill and component-count tooltip. The hardware filter accepts Warning, Critical or Unknown. A dash means no rollup has been received; it is distinct from an observed Unknown rollup.

## Supported tools

| Source | OS | Detection / read commands | Data | Cadence / timeout | Validation |
|---|---|---|---|---|---|
| `storcli` | Windows, Linux | `storcli64` or `storcli`; `/call show all J`, `/call/vall show all J`, `/call/eall/sall show all J`, `/call/cv show all J`, `/call/bbu show all J` | Controllers, virtual and physical disks, cache/battery, enclosures, progress | RAID; 30 seconds per command | fixture-only |
| `perccli` | Windows, Linux | `perccli64` or `perccli`; same read syntax as storcli | Same controller family data | RAID; 30 seconds | fixture-only |
| `megacli` | Windows, Linux | `MegaCli64`, `MegaCli` or `megacli`; `-AdpAllInfo -aALL`, `-LDInfo -Lall -aALL`, `-PDList -aALL`, `-AdpBbuCmd -GetBbuStatus -aALL`, `-LDPDInfo -aALL` | Controllers, virtual/physical disks, BBU and membership | RAID; 30 seconds | fixture-only |
| `ssacli` | Windows, Linux | `ssacli`, `hpssacli` or `hpacucli`; `ctrl all show status`, `ctrl all show config detail` | HPE controllers, cache/battery, logical and physical drives | RAID; 60 seconds | fixture-only |
| `arcconf` | Windows, Linux | `GETVERSION`, then `GETCONFIG` with controller number and `AL` | Controllers, logical/physical devices, battery/ZMM | RAID; 30 seconds | fixture-only |
| `omreport` | Windows, Linux | `storage controller -fmt ssv`, `storage vdisk -fmt ssv`, `storage pdisk controller=` with controller ID and `-fmt ssv`, `storage battery -fmt ssv` | Dell controllers, disks, predictive flags and batteries | RAID; 60 seconds | fixture-only |
| `mdadm` | Linux | Arrays listed in `/proc/mdstat`; `mdadm --detail` for each array | Arrays, members, recovery/resync/check progress | RAID; 15 seconds | Fixture coverage; lab validation pending |
| `zfs` | Linux | `zpool list` nonempty; `zpool list -H -o name,health,size,alloc,free`, `zpool status -pP`; JSON when supported | Pools, members, scrub/resilver progress and error counters | RAID; 30 seconds | Fixture coverage; lab validation pending |
| `storage_spaces` | Windows | Non-primordial pool; `Get-StoragePool`, `Get-VirtualDisk`, pooled `Get-PhysicalDisk` | Pools, virtual disks and member disks | RAID; 60 seconds | Fixture coverage; lab validation pending |
| `windows_physical_disk` | Windows | `Get-PhysicalDisk`, `Get-StorageReliabilityCounter` | OS-visible health, temperature, wear and counters | Disk health; 60 seconds | Fixture coverage; lab validation pending |
| `smartctl` | Windows, Linux | `--scan-open -j`, then `-a -j` per device with its detected type | SMART overall status, ATA attributes and NVMe log; enriches an unambiguous vendor disk serial | Disk health; 15 seconds per disk, 3 minutes total, at most 64 devices | Fixture coverage; lab validation pending |

<Aside type="note">
  “fixture-only” means parser behavior has been checked against samples, without a verified capture from a live deployment of that vendor source. A supported parser is not a claim of hardware lab validation. These markers change only when a real capture and its validation are recorded.
</Aside>

The Broadcom-family preference is **storcli → perccli → MegaCli**. Dell OMSA storage is used only when none of those is installed. HPE ssacli and Microchip arcconf run independently when present. The footer identifies superseded tools so installed-but-unused does not look like a failure.

Management-controller address/firmware collection through `ipmi` / `racadm` / `hponcfg` belongs to the BMC follow-on wave. This page does not claim chassis sensors, SEL ingestion or out-of-band Redfish/SNMP monitoring are available.

## Install the tools

Use the controller or server vendor's supported package for the machine's model and operating system:

- **Lenovo/Broadcom:** obtain StorCLI from the [Lenovo server guidance](https://datacentersupport.lenovo.com/us/en/products/servers/thinksystem/da240-enclosure/solutions/ht512617-how-to-collect-log-files-for-lenovo-servers-using-storcli) or the controller's [Broadcom support downloads](https://www.broadcom.com/products/storage/raid-controllers/megaraid-9580-8i8e). Use the legacy MegaCli package only for hardware requiring it.
- **Dell:** use [PERCCLI](https://www.dell.com/support/home/en-us/drivers/driversdetails?driverid=1p7r9) matched to your PERC and OS, or install OpenManage Server Administrator for `omreport`. Dell provides [OpenManage Linux installation guidance](https://linux.dell.com/repo/community/openmanage/). Breeze does not install either package.
- **HPE:** install the **SSA CLI** package containing `ssacli`, not only the graphical SSA application. Consult [HPE's SSA CLI guidance](https://www.hpe.com/jp/ja/collaterals/collateral.a50013828jpn.html) and select the appropriate OS package for your server.
- **Adaptec/Microchip:** use the [maxView / ARCCONF installation instructions](https://onlinedocs.microchip.com/oxy/GUID-A735A5E3-4456-4763-9EA6-B7AE0E5FE7E8-en-US-19/GUID-486273E7-5D76-4507-9B57-6E71242D83D8.html) for the controller family.
- **SMART:** install `smartmontools` from the OS package repository or the [upstream releases](https://github.com/smartmontools/smartmontools/releases). The executable Breeze detects is `smartctl`.
- **Linux software RAID:** install the distribution's `mdadm` package for existing md arrays; see the [Linux md documentation](https://kernel.org/doc/html/v6.7/admin-guide/md.html). For ZFS, follow [OpenZFS's distribution-specific setup](https://openzfs.github.io/openzfs-docs/Getting%20Started/index.html). Do not create an array merely to enable monitoring.
- **Windows built-ins:** Storage Spaces and physical disk collection use the existing Windows storage PowerShell cmdlets and require no vendor CLI.

Breeze searches `PATH`, known vendor installation directories and your agent-local additions. Detection is cached for one hour, so an installation may not appear immediately. The source footer links here when a tool is not installed.

## Configure collection

The configuration-policy feature **Hardware Monitoring** (`hardware_monitoring`) controls collection independently of alert attachments. It supports partner-wide policies and normal policy inheritance.

<Steps>

1. Open the configuration policy that applies to the device and select **Hardware Monitoring**.
2. Keep collection enabled, or disable it to stop probing the applicable devices.
3. Set the RAID interval: **10 minutes** by default, allowed **5–60 minutes**. Set disk health: **60 minutes** by default, allowed **15–1440 minutes**.
4. Save, then check the device's **Effective Config** and **Hardware** tabs. Without a policy setting, collection uses the enabled defaults. A policy change reaches the agent after the configuration cache and heartbeat refresh, then takes effect at the next collection gate.

</Steps>

A disabled collector preserves its previous evidence; it does not mean the disk recovered. No detected tooling produces an explicit report, normally once daily. Failed tools retain their last observations. After three failed collection cycles a tool backs off for six hours; the footer shows its error and retry time.

## Attach the four built-in monitors

These defaults are provisioned but **not attached** to policies. Collection alone does not opt devices into alerts.

| Built-in name / key | Components | Threshold | Consecutive snapshots | Predictive flag | Severity / cooldown |
|---|---|---|---|---|---|
| RAID array degraded or failed (`raid_array_degraded`) | Virtual disk, controller | Critical | 2 | Excluded | Critical / 60 minutes |
| Physical disk failed or predicted to fail (`physical_disk_failed`) | Physical disk | Critical | 2 | Included | High / 60 minutes |
| Controller cache battery problem (`cache_battery_problem`) | Cache battery | Warning | 3 | Excluded | Medium / 240 minutes |
| Hardware monitoring tool failing (`hardware_collector_failing`) | Collector | Warning | 3 | Excluded | Low / 1440 minutes |

<Steps>

1. Open **Alerts → Monitors** and locate the four hardware defaults.
2. Open the configuration policy assigned to the intended devices, select its **Monitors** tab, and attach the desired defaults.
3. Save the policy and confirm its assignment covers the organization, site, group or device you intend.
4. Inspect the device after its next collection. An array failure normally needs two RAID snapshots plus sweep time, approximately 25 minutes at the default interval. A disk-health-only signal follows the longer disk interval.

</Steps>

The editor also offers the `hardware_health` kind for custom monitors. A rebuilding-only notification can use virtual disks with Warning; it is deliberately not a built-in default.

## Understand the evidence and alerts

Alerts are **per component**: two failing disk slots produce two alerts and notifications. Recovery resolves each subject independently when auto-resolve is enabled and enough recovery snapshots have arrived. Device automation responses run at most once for the shared monitor/device incident.

A degraded virtual disk is critical; **rebuilding is warning**. A critical array alert may therefore recover after enough rebuilding observations rather than waiting for optimal. Unknown, stale, disabled or unavailable evidence is not recovery: **unknown does not resolve** an existing alert. Brief one-poll failures or recoveries do not satisfy the consecutive-snapshot threshold.

Rows absent from a complete successful source report turn stale. Rows older than three times their source tier's interval also show “not seen since”, even when the source never produced a complete report proving removal. Both are greyed in the Hardware tab. Stale component rows remain for seven days; event history is retained for 180 days, with the latest 50 shown on the tab.

SMART counters are observations, not a prediction model. Alerts use the controller's predictive-failure flag or the drive's own failed self-assessment. Breeze does not calculate “days until failure”.

## Agent-local tool directories

For tools unpacked outside standard directories, add directories to the agent configuration file. This setting is local to the agent and has no web policy control:

```yaml
hardware:
  tool_dirs:
    - 'D:\tools'
```

On Linux, a directory such as `/opt/vendor-tools` can be listed instead. Provide directories, not executable command strings. Keep the vendor package maintained using your normal software-management process.

## Related

- [Monitors](/features/monitors/)
- [Configuration policies](/features/configuration-policies/)
- [Devices](/features/devices/)
````

- [ ] **Step 4: Register the sidebar entry, run green and build (3 minutes to start).**

Insert after the service-monitoring entry at `apps/docs/astro.config.mjs:126`:

```js
{ slug: 'features/hardware-monitoring' },
```

```bash
cd apps/web && npx vitest run src/components/devices/hardware/hardwareMonitoringDocs.test.ts
```

```bash
pnpm --filter @breeze/docs check
pnpm --filter @breeze/docs build
```

Expected: 2 contract tests pass, Astro check exits zero and the docs build emits `/features/hardware-monitoring/`. Source links support installation pointers; support scope and intervals come from the approved spec, not assumptions about a vendor's current package version.

- [ ] **Step 5: Commit (2 minutes).**

```bash
git add apps/docs/src/content/docs/features/hardware-monitoring.mdx apps/docs/astro.config.mjs apps/web/src/components/devices/hardware/hardwareMonitoringDocs.test.ts
git commit -m $'docs(hardware): explain supported tools and monitor attachment\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 12: Prove the Hardware tab against isolated SQL-seeded observations

**Files:** Create `e2e-tests/pages/DeviceHardwarePage.ts` and `e2e-tests/tests/device-hardware-health.spec.ts`. Test: `e2e-tests/tests/device-hardware-health.spec.ts`.
**Interfaces:** Consumes §G testids and W01 tables. Produces `DeviceHardwarePage` using the same constructor/goto style as `NetworkDevicePage.ts:10–13`; uses `#hardware` from `DeviceDetails.tsx:912–914`. No tab testid is invented for the existing overflow tabs. SQL fixtures mirror the existing Docker/stack descriptor mechanism at `ai-script-unattended-lane.spec.ts:13–28`, serial execution and `clearRefreshState` from `network-device-truth.spec.ts:15–18`.

- [ ] **Step 1: Write the full failing browser spec, including isolated seed/cleanup (5 minutes).**

```ts
import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import { DeviceHardwarePage } from '../pages/DeviceHardwarePage';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const dirname = path.dirname(fileURLToPath(import.meta.url));
function pgContainer(): string {
  if (process.env.E2E_PG_CONTAINER) return process.env.E2E_PG_CONTAINER;
  const file = process.env.E2E_STACK_FILE ?? path.resolve(dirname, '../..', '.breeze-stack.json');
  if (existsSync(file)) {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (data.pgContainer) return data.pgContainer;
  }
  return 'breeze-postgres';
}
function sql(statement: string): void {
  execFileSync('docker', ['exec', '-i', pgContainer(), 'psql', '-U', 'breeze', '-d', 'breeze',
    '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
    encoding: 'utf8', input: `BEGIN; SELECT set_config('breeze.scope','system',true);\n${statement}\nCOMMIT;`,
  });
}
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
type Scenario = 'healthy' | 'degraded' | 'rebuilding' | 'stale' | 'no-tools' | 'disabled';
function seed(id: string, scenario: Scenario): void {
  const empty = scenario === 'no-tools' || scenario === 'disabled';
  const health = scenario === 'degraded' ? 'critical' : scenario === 'rebuilding' ? 'warning' : empty ? 'unknown' : 'ok';
  const state = scenario === 'degraded' ? 'degraded' : scenario === 'rebuilding' ? 'rebuilding' : 'optimal';
  const sources = empty ? [{ source: 'storcli', status: scenario === 'disabled' ? 'disabled' : 'unavailable' }]
    : [{ source: 'storcli', status: 'ok', complete: true, toolVersion: '7.4' },
      { source: 'megacli', status: 'superseded' }, { source: 'ssacli', status: 'unavailable' }];
  const tiers = scenario === 'disabled' ? 'disabled' : scenario === 'no-tools' ? 'none' : 'raid';
  sql(`
    INSERT INTO devices (id,org_id,site_id,agent_id,hostname,os_type,os_version,architecture,agent_version,status)
    SELECT ${literal(id)}::uuid,org_id,site_id,${literal(`e2e-hardware-${id}`)},
      ${literal(`e2e-hardware-${id}`)},'linux','test','amd64','0.117.0','offline'
    FROM devices WHERE id='e65460f3-413c-4599-a9a6-90ee71bbc4ff';
    INSERT INTO device_hardware (device_id,org_id,cpu_model)
      SELECT id,org_id,'E2E CPU' FROM devices WHERE id=${literal(id)}::uuid;
    INSERT INTO device_hardware_health (device_id,org_id,health,collector_health,summary,sources,
      last_collected_at,last_received_at,poll_interval_minutes,disk_health_interval_minutes,tiers_run)
    SELECT id,org_id,${literal(health)}::hardware_health,'ok',
      '{"counts":{"physical_disk:ok":1},"controllerNames":["E2E Controller"]}'::jsonb,${literal(JSON.stringify(sources))}::jsonb,
      now(),now(),10,60,ARRAY[${literal(tiers)}] FROM devices WHERE id=${literal(id)}::uuid;
  `);
  if (empty) return;
  sql(`
    INSERT INTO device_hardware_components
      (device_id,org_id,component_key,component_type,parent_key,source,name,model,serial,firmware,
       health,state,progress_percent,attributes,stale,stale_since,first_seen_at,last_seen_at)
    SELECT d.id,d.org_id,v.key,v.kind::hardware_component_type,v.parent,'storcli',v.name,v.model,v.serial,'1.0',
      v.health::hardware_health,v.state,v.progress,v.attrs::jsonb,v.stale,
      CASE WHEN v.stale THEN now()-interval '1 day' ELSE NULL END,now()-interval '2 days',
      CASE WHEN v.stale THEN now()-interval '1 day' ELSE now() END
    FROM devices d CROSS JOIN (VALUES
      ('storcli:c0','controller',NULL,'E2E Controller','H730P','CTRL-E2E','ok','ok',NULL::smallint,'{}',false),
      ('storcli:c0:v0','virtual_disk','storcli:c0','VD 0',NULL,NULL,${literal(health)},${literal(state)},
        ${scenario === 'rebuilding' ? '42' : 'NULL'}::smallint,'{"raidLevel":"RAID-1"}',false),
      ('storcli:c0:e1:s3','physical_disk','storcli:c0','Slot 3','Drive model','DISK-E2E','ok','online',NULL::smallint,
        '{"slot":3,"mediaType":"SSD","interface":"SAS","mediaErrors":0,"otherErrors":0}',${scenario === 'stale'})
    ) AS v(key,kind,parent,name,model,serial,health,state,progress,attrs,stale)
    WHERE d.id=${literal(id)}::uuid;
    INSERT INTO device_hardware_events
      (device_id,org_id,component_key,component_type,event_type,from_health,to_health,from_state,to_state,occurred_at)
    SELECT id,org_id,'storcli:c0:v0','virtual_disk','state_changed','ok',${literal(health)}::hardware_health,
      'optimal',${literal(state)},now() FROM devices WHERE id=${literal(id)}::uuid;
  `);
}
function cleanup(id: string): void {
  sql(`
    DELETE FROM device_hardware_events WHERE device_id=${literal(id)}::uuid;
    DELETE FROM device_hardware_components WHERE device_id=${literal(id)}::uuid;
    DELETE FROM device_hardware_health WHERE device_id=${literal(id)}::uuid;
    DELETE FROM device_hardware WHERE device_id=${literal(id)}::uuid;
    DELETE FROM devices WHERE id=${literal(id)}::uuid;
  `);
}
test.describe.configure({ mode: 'serial' });
test.beforeEach(clearRefreshState);
for (const scenario of ['healthy', 'degraded', 'rebuilding', 'stale', 'no-tools', 'disabled'] as const) {
  test(`Storage & RAID: ${scenario}`, async ({ authedPage }) => {
    const id = randomUUID();
    try {
      seed(id, scenario);
      const hardware = new DeviceHardwarePage(authedPage);
      const read = authedPage.waitForResponse(response =>
        response.url().includes(`/devices/${id}/hardware-health`) && response.request().method() === 'GET');
      await hardware.goto(id);
      expect((await read).status()).toBe(200);
      await expect(hardware.section()).toBeVisible();
      await expect(authedPage).toHaveURL(/#hardware$/);
      if (scenario === 'no-tools' || scenario === 'disabled') {
        await expect(hardware.empty()).toContainText(scenario === 'disabled'
          ? 'disabled by policy' : 'No RAID or disk-health tooling detected');
        await expect(hardware.controllers()).toHaveCount(0);
      } else {
        await expect(hardware.controllers()).toHaveCount(1);
        await expect(hardware.controllers()).toContainText('DISK-E2E');
        await expect(hardware.rollup()).toHaveText(scenario === 'degraded' ? 'Critical'
          : scenario === 'rebuilding' ? 'Warning' : 'Healthy');
        if (scenario === 'rebuilding') await expect(hardware.progress('storcli:c0:v0')).toHaveAttribute('value', '42');
        if (scenario === 'stale') {
          await expect(hardware.disk('storcli:c0:e1:s3')).toHaveClass(/opacity-60/);
          await expect(hardware.disk('storcli:c0:e1:s3')).toContainText('Not seen since');
        }
        await expect(hardware.sources()).toContainText('Superseded by storcli');
        await expect(hardware.events()).not.toHaveAttribute('open', /.*/);
        await hardware.eventsToggle().click();
        await expect(hardware.events()).toHaveAttribute('open', /.*/);
        await expect(hardware.events()).toContainText('storcli:c0:v0');
      }
      await expect(hardware.sources()).toBeVisible();
    } finally { cleanup(id); }
  });
}
```

- [ ] **Step 2: Run red against the existing e2e stack (2 minutes).**

```bash
cd e2e-tests && npx playwright test tests/device-hardware-health.spec.ts --project=chromium --workers=1
```

Expected: cannot resolve `../pages/DeviceHardwarePage`. Use the existing configured e2e stack (`E2E_STACK_FILE`/`E2E_BASE_URL` and the standard global setup); `pnpm test-stack up` is for API integration services, not a web e2e server. Do not treat a missing web server as a product test failure.

- [ ] **Step 3: Implement the complete page object (3 minutes).**

```ts
import type { Page } from '@playwright/test';
export class DeviceHardwarePage {
  constructor(private page: Page) {}
  goto = (deviceId: string) => this.page.goto(`/devices/${deviceId}#hardware`);
  section = () => this.page.getByTestId('hardware-storage-section');
  rollup = () => this.page.getByTestId('hardware-rollup-pill');
  controllers = () => this.page.getByTestId('hardware-controller-card');
  sources = () => this.page.getByTestId('hardware-sources-footer');
  events = () => this.page.getByTestId('hardware-events-list');
  eventsToggle = () => this.page.getByTestId('hardware-events-toggle');
  empty = () => this.page.getByTestId('hardware-empty-state');
  disk = (key: string) => this.page.getByTestId(`hardware-disk-${key}`);
  progress = (key: string) => this.page.getByTestId(`hardware-progress-${key}`);
}
```

- [ ] **Step 4: Run green and the complete W04 web suite (5 minutes to start).**

```bash
cd e2e-tests && npx playwright test tests/device-hardware-health.spec.ts --project=chromium --workers=1
```

Expected: six browser scenarios pass using real HTTP reads and their fixture rows are removed even on assertion failure. No locator uses CSS, text, label or role selectors.

```bash
cd apps/web && npx vitest run src/components/devices/hardware src/components/devices/DeviceHardwareInventory.hardwareHealth.test.tsx src/components/devices/columnVisibility.test.ts src/components/devices/DeviceList.hardwareHealth.test.tsx src/components/devices/DevicesPage.test.tsx src/lib/devicesFetch.test.ts src/lib/i18n/keyUsage.test.ts src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts
```

Expected: every selected file passes. Inspect the reported file count; `hardware` matches the directory intentionally. Review desktop and narrow-viewport browser traces for horizontal table scrolling, long serial/error wrapping, visible non-color state labels and keyboard-operable native disclosures. This task changes no Go files; Go collector race/vet validation belongs to W02a/W02b/W05.

- [ ] **Step 5: Commit and tear down only the stack this execution started (2 minutes).**

```bash
git add e2e-tests/pages/DeviceHardwarePage.ts e2e-tests/tests/device-hardware-health.spec.ts
git commit -m $'test(hardware): cover storage health states against real API\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
pnpm test-stack down
```

The integration stack in Task 8 is owned by this execution. Do not stop a pre-existing shared e2e stack; if the executor started a separate web stack, stop that owned stack using its recorded lifecycle command and report what remains running.

## Self-review

- Spec §11.1 is covered by Tasks 1–7: full storage hierarchy, progress, predictive indicator, stale/fresh distinction, OS grouping, source status and event disclosure.
- Spec §11.2 is covered by Tasks 8–10: hidden-by-default column, opaque numeric summary tooltip, validated API filter, count join and both response mappers.
- Spec §11.4 is covered by Task 11: tool matrix, official installation pointers, collection policy, monitor attachment, alert semantics and `tool_dirs`.
- Spec §13 web/e2e is covered by component state tests, connected page tests, route tests and Task 12's six isolated real-API browser scenarios.
- W01 retains migrations, tenancy registrations, freshness calculation, ingest, GET authorization, config feature and §11.3 AI/MCP coverage; W04 only consumes those contracts.
- W02a/W02b retain collectors, scheduling, CLI installation detection and agent release work; W03 retains monitor editor fields and per-subject alert execution.
- W05 retains §12 BMC linking and `ManagementControllerCard`; W06 retains real hardware/lab proof and changing fixture-only markers after verified captures.
- Index §D overrides the older spec response sketch; local JSON interfaces preserve every component column plus `fresh`, with the two contracted timestamp names.
- Index §G ambiguities are resolved explicitly: `unknown` excludes absent rows, W01 summary counts normalize to the contracted numeric Device field, and the fleet filter uses API parameters without browser query-state persistence.
