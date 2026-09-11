# AI Script Authoring — W05 Close the Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface AI-authored script runs on the device activity feed, add script-proposal governance metrics to the AI Risk Dashboard, document the whole AI script-authoring feature for admins, and retire the `BREEZE_AI_SCRIPT_AUTHORING_ENABLED` flag once the feature has shipped a release.

**Architecture:** Every new read in this wave is snapshot-only — the device activity feed reads an audit-log row whose `details` were populated at dispatch time from the `script_executions` snapshot columns (`source_kind`, `approval_method`, `review_risk_tier`, `review_summary`, `proposal_id`), and the AI Risk Dashboard's new metrics endpoint aggregates `script_proposals` / `script_proposal_reviews` / `script_executions` directly. Neither path ever joins back to `script_proposals` at read time, so both survive proposal erasure (org merge, retention). A dedicated read-only proposal-detail page (new in this wave) is the only place that does read a single proposal by id, and it renders "Evidence erased" on 404 instead of breaking.

**Tech Stack:** Hono + Drizzle (API), Astro + React islands (web), Vitest (both), react-i18next, recharts, Starlight (docs).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-11-ai-script-authoring-and-review-design.md` (§4.9 "Library and device surfaces", §8 wave table row W05, §2.1)
**Roadmap (cross-wave contracts this plan consumes):** `docs/superpowers/plans/ai-mcp/2026-09-11-ai-script-authoring-roadmap.md` §3.1–§3.6 (assume W01a, W01b, W02, W03 have shipped exactly as contracted there; W04's `ai_script_policies` / `ai_script_lane_state` / `script_reviewer_evidence` are assumed to exist only for the two tasks explicitly marked "after W04" below) and §3.7 (this wave's own contract).
**Tracking:** feature `LanternOps/breeze#5612` (see `get_feature_status` for the live wave→sub-issue mapping; do not trust this doc's own wave lettering for issue numbers).

## Global Constraints

- Feature flag `BREEZE_AI_SCRIPT_AUTHORING_ENABLED` (env, default `true` since W03) gates the whole feature until Task 11 removes it. Every other task in this plan assumes it is on.
- Migrations, if any were needed, would be named to sort after the newest shipped file and re-verified against `origin/main` at push — this wave adds no migrations (no new tables or columns).
- Tenancy per CLAUDE.md: the new metrics endpoint (Tasks 4 and 6) is org-scoped exactly like the existing `/ai/admin/tool-executions` endpoint it sits beside — no new tenant-scoped table is created in this wave, so no RLS/cascade/export-policy registration is required.
- `aiGuardrails.ts` must not import the tool registry or DB schema — untouched by this wave.
- No new agent-facing payload fields; the Go agent is unchanged — untouched by this wave.
- Web mutations go through `runAction`; this wave adds no new mutation handlers (every new surface is read-only: an audit-log write from a service, two GET endpoints, and three read-only components), so `runAction` is not wired into new code, only noted here because CLAUDE.md requires the check.
- New i18n keys need real translations in all locales (`translationCoverage.test.ts`); every task below that adds a web-visible string ships the string in all 8 locale files (`en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`) in the same step.
- Tests sit beside source. Run one API file with `cd apps/api && npx vitest run <path>`; run one web file with `cd apps/web && npx vitest run <path>` (mirrors the `apps/api` trap in CLAUDE.md — never insert a bare `--` before `run`).
- Docs live under `apps/docs/src/content/docs/` (Starlight). Follow `update-breeze-docs` conventions: product language for admins, UI workflows not internal names, build-verify with `cd apps/docs && npx astro build 2>&1 | tail -10` after every docs edit.

---

## Task 1: AI-authored script executions write their own audit-log row

**Files:**
- Modify: `apps/api/src/services/scriptDispatch.ts` (import `createAuditLogAsync`; add a `SYSTEM_ACTOR_ID` constant; add the audit write inside `dispatchScriptToDevice`, immediately before its final `return` at what is today line 729)
- Modify: `apps/api/src/routes/devices/events.ts` (`actionLabels` map, around line 524)
- Test: `apps/api/src/services/scriptDispatch.aiAuditProvenance.test.ts` (new, mirrors `scriptDispatch.acknowledgement.test.ts`)

**Interfaces:**
- Consumes: `ScriptDispatchSource` with a `{ kind: 'proposal'; proposal: ScriptProposalRow; snapshot: ProposalDispatchSnapshot }` variant and `script_executions` columns `source_kind`/`approval_method`/`review_risk_tier`/`review_summary`/`proposal_id` (W01b, roadmap §3.3, §3.2); `createAuditLogAsync(params: CreateAuditLogParams): Promise<void>` from `apps/api/src/services/auditService.ts:101`; `ScriptProposalRow.authorKind: 'chat_session' | 'agent_run'` (spec §4.1).
- Produces: an `audit_logs` row with `action: 'ai.script.executed'`, `initiatedBy: 'ai'`, and `details: { executionId, commandId, proposalId, sourceKind, approvalMethod, reviewRiskTier, reviewSummary }` — consumed by Task 3 (device activity feed) purely by reading that row back; no other task queries `script_executions` directly for this data.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/scriptDispatch.aiAuditProvenance.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks mirror scriptDispatch.acknowledgement.test.ts exactly, plus a mock
// of auditService so this file can assert on the new audit write without a
// real DB.
vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./commandQueue', async () => {
  const { CommandTypes } = await import('./commandTypes');
  return { CommandTypes, queueCommand: vi.fn() };
});
vi.mock('./commandDispatch', () => ({
  claimPendingCommandForDelivery: vi.fn().mockResolvedValue(null),
  releaseClaimedCommandDelivery: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./sensitiveCommandPayload', () => ({
  encryptSensitivePayloadFields: vi.fn((_t: string, p: unknown) => p),
  decryptCommandForDelivery: vi.fn((c: unknown) => c),
  toAgentCommandFrame: vi.fn((c: { id: string; type: string; payload: unknown }) => ({
    id: c.id,
    type: c.type,
    payload: c.payload,
  })),
}));
vi.mock('../routes/agentWs', () => ({ sendCommandToAgent: vi.fn().mockReturnValue(false) }));
vi.mock('./scriptSecretDelivery', () => ({
  AGENT_UPGRADE_REQUIRED_MESSAGE: 'Agent upgrade required: mocked message',
  SECRET_GATE_UNAVAILABLE_MESSAGE: 'Secret gate unavailable: mocked message',
  secretDeliveryPreflight: vi.fn().mockResolvedValue({ ok: true }),
  failClaimedSecretCommandsForUnsupportedAgent: vi.fn((claimed: unknown[]) => Promise.resolve(claimed)),
}));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./scriptMaintenanceGate', () => ({
  checkScriptMaintenanceSuppression: vi.fn().mockResolvedValue({ suppressed: false }),
}));
vi.mock('./auditService', () => ({ createAuditLogAsync: vi.fn().mockResolvedValue(undefined) }));

import { db } from '../db';
import { queueCommand } from './commandQueue';
import { createAuditLogAsync } from './auditService';
import { dispatchScriptToDevice } from './scriptDispatch';

const device = (o = {}) =>
  ({
    id: 'device-1',
    orgId: 'org-a',
    osType: 'linux',
    status: 'online',
    agentId: null,
    hostname: 'host-1',
    siteId: 'site-1',
    customFields: {},
    ...o,
  }) as never;

const proposal = (o = {}) =>
  ({ id: 'proposal-1', orgId: 'org-a', authorKind: 'chat_session', sessionId: 'session-1', agentRunId: null, ...o }) as never;

const snapshotFor = (proposalId: string) =>
  ({
    proposalId,
    contentDigest: 'a'.repeat(64),
    language: 'powershell',
    runAs: 'system',
    timeoutSeconds: 120,
    deviceIds: ['device-1'],
    scannerVersion: '2026-09-11.1',
  }) as never;

const insertReturning = (rows: unknown[]) => ({
  values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(rows) }),
});
const selectSnapshot = (rows: unknown[]) => ({
  from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }) }),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.insert).mockReturnValue(insertReturning([{ id: 'exec-1' }]) as never);
  vi.mocked(queueCommand).mockResolvedValue({ id: 'cmd-1', payload: {} } as never);
});

describe('dispatchScriptToDevice — AI-authored audit provenance (#5022, W05)', () => {
  it('writes an ai.script.executed row from the execution snapshot, with exactly one DB read (no re-query of script_proposals)', async () => {
    vi.mocked(db.select).mockReturnValue(
      selectSnapshot([
        {
          sourceKind: 'proposal',
          approvalMethod: 'supervised_self',
          reviewRiskTier: 'low',
          reviewSummary: 'Restarts the print spooler service.',
          proposalId: 'proposal-1',
        },
      ]) as never,
    );

    const result = await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'proposal', proposal: proposal(), snapshot: snapshotFor('proposal-1') },
    } as never);

    expect(result.ok).toBe(true);
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(createAuditLogAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-a',
        actorType: 'user',
        action: 'ai.script.executed',
        resourceType: 'device',
        resourceId: 'device-1',
        resourceName: 'host-1',
        initiatedBy: 'ai',
        details: expect.objectContaining({
          proposalId: 'proposal-1',
          sourceKind: 'proposal',
          approvalMethod: 'supervised_self',
          reviewRiskTier: 'low',
          reviewSummary: 'Restarts the print spooler service.',
        }),
      }),
    );
  });

  it('uses actorType ai_agent for an autonomous agent-run proposal', async () => {
    vi.mocked(db.select).mockReturnValue(
      selectSnapshot([
        {
          sourceKind: 'proposal',
          approvalMethod: 'unattended_reviewer_gated',
          reviewRiskTier: 'low',
          reviewSummary: 'Clears the DNS cache.',
          proposalId: 'proposal-2',
        },
      ]) as never,
    );

    await dispatchScriptToDevice({
      device: device(),
      source: {
        kind: 'proposal',
        proposal: proposal({ id: 'proposal-2', authorKind: 'agent_run', sessionId: null, agentRunId: 'run-1' }),
        snapshot: snapshotFor('proposal-2'),
      },
    } as never);

    expect(createAuditLogAsync).toHaveBeenCalledWith(expect.objectContaining({ actorType: 'ai_agent' }));
  });

  it('does not write an AI audit row for an ordinary human (saved-script) dispatch', async () => {
    await dispatchScriptToDevice({
      device: device(),
      source: {
        kind: 'saved',
        script: {
          id: 'script-1', orgId: 'org-a', partnerId: null, isSystem: false, osTypes: ['linux'],
          language: 'bash', content: 'echo hi', timeoutSeconds: 60, runAs: 'system', deletedAt: null,
          acknowledgedSecurityPatterns: [],
        },
      },
    } as never);

    expect(createAuditLogAsync).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/scriptDispatch.aiAuditProvenance.test.ts`
Expected: FAIL — `createAuditLogAsync` is never called (the branch doesn't exist yet), and the module doesn't yet import it.

- [ ] **Step 3: Add the `createAuditLogAsync` import and a system-actor fallback constant**

At the top of `apps/api/src/services/scriptDispatch.ts`, alongside the existing `import { captureException } from './sentry';` (line 20):

```ts
import { createAuditLogAsync } from './auditService';
```

Near the top of the file (module scope, e.g. just above `export type ScriptDispatchSource`):

```ts
// Matches the fallback actor id commandQueue.ts uses for a non-user dispatch
// (commandQueue.ts:581) — kept as a local literal rather than importing that
// module's internal, since this file already avoids depending on commandQueue
// for anything but queueCommand/CommandTypes.
const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
```

- [ ] **Step 4: Write the audit-write branch**

Immediately before the function's final `return` statement (today `return { ok: true, commandId: command.id, executionId, delivered, deliveryOutcome, executedAt, deliverBy, ignoredParameters, runAs, targetSessionId: input.targetSessionId ?? null };`):

```ts
  // #5022 / W05: an AI-authored (proposal-backed) run writes its own audit
  // row here, reading back ONLY the snapshot columns this function just
  // wrote onto script_executions — never a live join to script_proposals, so
  // this row (and the device activity feed that reads it in Task 3) survives
  // erasure of the source proposal. Fire-and-forget like every other
  // createAuditLogAsync caller: a lost audit row must never fail the dispatch
  // that already succeeded.
  if (source.kind === 'proposal' && executionId) {
    const [snapshot] = await db
      .select({
        sourceKind: scriptExecutions.sourceKind,
        approvalMethod: scriptExecutions.approvalMethod,
        reviewRiskTier: scriptExecutions.reviewRiskTier,
        reviewSummary: scriptExecutions.reviewSummary,
        proposalId: scriptExecutions.proposalId,
      })
      .from(scriptExecutions)
      .where(eq(scriptExecutions.id, executionId))
      .limit(1);
    if (snapshot) {
      void createAuditLogAsync({
        orgId: device.orgId,
        actorType: source.proposal.authorKind === 'agent_run' ? 'ai_agent' : 'user',
        actorId: safeCreatedBy ?? safeTriggeredBy ?? SYSTEM_ACTOR_ID,
        action: 'ai.script.executed',
        resourceType: 'device',
        resourceId: device.id,
        resourceName: device.hostname,
        initiatedBy: 'ai',
        result: 'dispatched',
        details: {
          executionId,
          commandId: command.id,
          proposalId: snapshot.proposalId,
          sourceKind: snapshot.sourceKind,
          approvalMethod: snapshot.approvalMethod,
          reviewRiskTier: snapshot.reviewRiskTier,
          reviewSummary: snapshot.reviewSummary,
        },
      });
    } else {
      console.warn('[scriptDispatch] proposal-backed execution missing snapshot columns; AI audit row skipped', {
        executionId,
      });
    }
  }

```

- [ ] **Step 5: Add the device-feed label**

In `apps/api/src/routes/devices/events.ts`, add one entry to the `actionLabels` map (near the other `script.*` rows around line 479):

```ts
  'ai.script.executed': 'AI script executed',
```

No other change is needed in this file: `deriveCategory` already maps any `ai.`-prefixed action to category `'ai'` (`apps/api/src/routes/devices/events.ts:447`), and the route already returns `row.details` verbatim (`apps/api/src/routes/devices/events.ts:406`), so the new `details` fields reach the client with no route change.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/scriptDispatch.aiAuditProvenance.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 7: Run the full scriptDispatch suite to check for regressions**

Run: `cd apps/api && npx vitest run src/services/scriptDispatch.test.ts src/services/scriptDispatch.acknowledgement.test.ts src/services/scriptDispatch.maintenanceWindow.test.ts src/services/scriptDispatch.runContext.test.ts`
Expected: PASS — the new branch only runs for `source.kind === 'proposal'`, which none of these pre-existing suites construct.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/scriptDispatch.ts apps/api/src/routes/devices/events.ts apps/api/src/services/scriptDispatch.aiAuditProvenance.test.ts
git commit -m "feat(ai-scripts): audit-log AI-authored script executions with snapshot provenance (#5022)"
```

---

## Task 2: Read-only script-proposal detail page (handles erased evidence)

**Files:**
- Create: `apps/web/src/components/scripts/ScriptProposalDetail.tsx`
- Create: `apps/web/src/pages/ai-script-proposals/[proposalId].astro`
- Modify: `apps/web/src/locales/en/scripts.json` (+ the 7 other locale files) — new `scriptProposalDetail` section
- Test: `apps/web/src/components/scripts/ScriptProposalDetail.test.tsx`

**Interfaces:**
- Consumes: `GET /ai/script-proposals/:id` → `ScriptProposalDetailDto` (W03, roadmap §3.5); this task reads only `{ id, status, goal, riskTier, review }` off that DTO, where `review` is `{ summary: string; riskTier: RiskTier; recommendedAction: 'approve'|'changes'|'reject' } | null`. A 404 from this route is treated as "evidence erased", not an error.
- Produces: a stable URL `/ai-script-proposals/:proposalId` that Task 3 (device activity feed) and, per spec §4.9, the Scripts-list Provenance panel can both link to.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/scripts/ScriptProposalDetail.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
import { fetchWithAuth } from '../../stores/auth';
import ScriptProposalDetail from './ScriptProposalDetail';

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const jsonResponse = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

beforeEach(() => vi.clearAllMocks());

describe('ScriptProposalDetail', () => {
  it('renders the goal, risk tier, and review summary for a reviewed proposal', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'proposal-1',
        status: 'executed',
        goal: 'Restart the print spooler',
        riskTier: 'low',
        review: { summary: 'Restarts spooler.service via systemctl.', riskTier: 'low', recommendedAction: 'approve' },
      }),
    );

    render(<ScriptProposalDetail proposalId="proposal-1" />);

    await waitFor(() => expect(screen.getByText('Restart the print spooler')).toBeTruthy());
    expect(screen.getByText('Restarts spooler.service via systemctl.')).toBeTruthy();
  });

  it('renders "evidence erased" when the proposal 404s (source org merged/erased)', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(jsonResponse({ error: 'not found' }, 404));

    render(<ScriptProposalDetail proposalId="proposal-2" />);

    await waitFor(() => expect(screen.getByTestId('script-proposal-evidence-erased')).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/scripts/ScriptProposalDetail.test.tsx`
Expected: FAIL — `./ScriptProposalDetail` does not exist.

- [ ] **Step 3: Implement the component**

```tsx
// apps/web/src/components/scripts/ScriptProposalDetail.tsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../stores/auth';

type RiskTier = 'low' | 'medium' | 'high' | 'critical';

interface ScriptProposalDetailDto {
  id: string;
  status: string;
  goal: string;
  riskTier: RiskTier | null;
  review: { summary: string; riskTier: RiskTier; recommendedAction: 'approve' | 'changes' | 'reject' } | null;
}

const RISK_KEYS: Record<RiskTier, string> = {
  low: 'scriptProposalDetail.riskLow',
  medium: 'scriptProposalDetail.riskMedium',
  high: 'scriptProposalDetail.riskHigh',
  critical: 'scriptProposalDetail.riskCritical',
};

export default function ScriptProposalDetail({ proposalId }: { proposalId: string }) {
  const { t } = useTranslation('scripts');
  const [state, setState] = useState<'loading' | 'erased' | 'error' | 'ready'>('loading');
  const [proposal, setProposal] = useState<ScriptProposalDetailDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    fetchWithAuth(`/ai/script-proposals/${proposalId}`)
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) {
          setState('erased');
          return;
        }
        if (!res.ok) {
          setState('error');
          return;
        }
        setProposal(await res.json());
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [proposalId]);

  if (state === 'loading') {
    return <p className="text-sm text-muted-foreground">{t('scriptProposalDetail.loading')}</p>;
  }

  if (state === 'erased') {
    return (
      <div data-testid="script-proposal-evidence-erased" className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        {t('scriptProposalDetail.evidenceErased')}
      </div>
    );
  }

  if (state === 'error' || !proposal) {
    return <p className="text-sm text-destructive">{t('scriptProposalDetail.loadError')}</p>;
  }

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      <h1 className="text-lg font-semibold">{proposal.goal}</h1>
      <dl className="mt-4 space-y-2 text-sm">
        <div>
          <dt className="text-muted-foreground">{t('scriptProposalDetail.statusLabel')}</dt>
          <dd>{proposal.status}</dd>
        </div>
        {proposal.riskTier && (
          <div>
            <dt className="text-muted-foreground">{t('scriptProposalDetail.riskTierLabel')}</dt>
            <dd>{t(RISK_KEYS[proposal.riskTier])}</dd>
          </div>
        )}
        {proposal.review && (
          <div>
            <dt className="text-muted-foreground">{t('scriptProposalDetail.reviewSummaryLabel')}</dt>
            <dd>{proposal.review.summary}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
```

- [ ] **Step 4: Add the Astro route**

```astro
---
// apps/web/src/pages/ai-script-proposals/[proposalId].astro
import DashboardLayout from '../../layouts/DashboardLayout.astro';
import ScriptProposalDetail from '../../components/scripts/ScriptProposalDetail';

const { proposalId } = Astro.params;
---

<DashboardLayout title="AI Script Proposal">
  <ScriptProposalDetail proposalId={proposalId!} client:load />
</DashboardLayout>
```

- [ ] **Step 5: Add i18n keys — `en` first**

Add to `apps/web/src/locales/en/scripts.json` (new top-level section; insert alongside the other component sections, keeping the file's existing alphabetical-ish grouping):

```json
  "scriptProposalDetail": {
    "loading": "Loading…",
    "loadError": "Couldn't load this proposal.",
    "evidenceErased": "This proposal's review evidence has been erased (the source organization was merged or its data retention period ended). The script execution it produced is still visible in device history.",
    "statusLabel": "Status",
    "riskTierLabel": "Risk tier",
    "reviewSummaryLabel": "Reviewer summary",
    "riskLow": "Low",
    "riskMedium": "Medium",
    "riskHigh": "High",
    "riskCritical": "Critical"
  },
```

- [ ] **Step 6: Add the same section to the 7 other locales**

`apps/web/src/locales/de-DE/scripts.json`:
```json
  "scriptProposalDetail": {
    "loading": "Wird geladen …",
    "loadError": "Dieser Vorschlag konnte nicht geladen werden.",
    "evidenceErased": "Die Prüfnachweise dieses Vorschlags wurden gelöscht (die Quellorganisation wurde zusammengeführt oder die Aufbewahrungsfrist ist abgelaufen). Die daraus resultierende Skriptausführung ist weiterhin im Geräteverlauf sichtbar.",
    "statusLabel": "Status",
    "riskTierLabel": "Risikostufe",
    "reviewSummaryLabel": "Prüfzusammenfassung",
    "riskLow": "Niedrig",
    "riskMedium": "Mittel",
    "riskHigh": "Hoch",
    "riskCritical": "Kritisch"
  },
```

`apps/web/src/locales/es-419/scripts.json`:
```json
  "scriptProposalDetail": {
    "loading": "Cargando…",
    "loadError": "No se pudo cargar esta propuesta.",
    "evidenceErased": "La evidencia de revisión de esta propuesta fue eliminada (la organización de origen se fusionó o venció su período de retención). La ejecución del script resultante sigue visible en el historial del dispositivo.",
    "statusLabel": "Estado",
    "riskTierLabel": "Nivel de riesgo",
    "reviewSummaryLabel": "Resumen del revisor",
    "riskLow": "Bajo",
    "riskMedium": "Medio",
    "riskHigh": "Alto",
    "riskCritical": "Crítico"
  },
```

`apps/web/src/locales/fr-FR/scripts.json`:
```json
  "scriptProposalDetail": {
    "loading": "Chargement…",
    "loadError": "Impossible de charger cette proposition.",
    "evidenceErased": "Les preuves de révision de cette proposition ont été effacées (l'organisation source a été fusionnée ou sa période de conservation a expiré). L'exécution de script qui en résulte reste visible dans l'historique de l'appareil.",
    "statusLabel": "Statut",
    "riskTierLabel": "Niveau de risque",
    "reviewSummaryLabel": "Résumé du réviseur",
    "riskLow": "Faible",
    "riskMedium": "Moyen",
    "riskHigh": "Élevé",
    "riskCritical": "Critique"
  },
```

`apps/web/src/locales/fr-CA/scripts.json`:
```json
  "scriptProposalDetail": {
    "loading": "Chargement…",
    "loadError": "Impossible de charger cette proposition.",
    "evidenceErased": "Les preuves de révision de cette proposition ont été effacées (l'organisation source a été fusionnée ou sa période de conservation a pris fin). L'exécution de script qui en résulte demeure visible dans l'historique de l'appareil.",
    "statusLabel": "Statut",
    "riskTierLabel": "Niveau de risque",
    "reviewSummaryLabel": "Résumé du réviseur",
    "riskLow": "Faible",
    "riskMedium": "Moyen",
    "riskHigh": "Élevé",
    "riskCritical": "Critique"
  },
```

`apps/web/src/locales/it-IT/scripts.json`:
```json
  "scriptProposalDetail": {
    "loading": "Caricamento…",
    "loadError": "Impossibile caricare questa proposta.",
    "evidenceErased": "Le prove di revisione di questa proposta sono state cancellate (l'organizzazione di origine è stata unita o il periodo di conservazione è scaduto). L'esecuzione dello script risultante è ancora visibile nella cronologia del dispositivo.",
    "statusLabel": "Stato",
    "riskTierLabel": "Livello di rischio",
    "reviewSummaryLabel": "Riepilogo del revisore",
    "riskLow": "Basso",
    "riskMedium": "Medio",
    "riskHigh": "Alto",
    "riskCritical": "Critico"
  },
```

`apps/web/src/locales/pt-BR/scripts.json`:
```json
  "scriptProposalDetail": {
    "loading": "Carregando…",
    "loadError": "Não foi possível carregar esta proposta.",
    "evidenceErased": "As evidências de revisão desta proposta foram apagadas (a organização de origem foi mesclada ou o período de retenção expirou). A execução de script resultante ainda é visível no histórico do dispositivo.",
    "statusLabel": "Status",
    "riskTierLabel": "Nível de risco",
    "reviewSummaryLabel": "Resumo do revisor",
    "riskLow": "Baixo",
    "riskMedium": "Médio",
    "riskHigh": "Alto",
    "riskCritical": "Crítico"
  },
```

`apps/web/src/locales/tr-TR/scripts.json`:
```json
  "scriptProposalDetail": {
    "loading": "Yükleniyor…",
    "loadError": "Bu öneri yüklenemedi.",
    "evidenceErased": "Bu önerinin inceleme kanıtları silindi (kaynak organizasyon birleştirildi veya veri saklama süresi doldu). Bu öneriden doğan komut dosyası çalıştırması cihaz geçmişinde görünmeye devam ediyor.",
    "statusLabel": "Durum",
    "riskTierLabel": "Risk düzeyi",
    "reviewSummaryLabel": "İnceleme özeti",
    "riskLow": "Düşük",
    "riskMedium": "Orta",
    "riskHigh": "Yüksek",
    "riskCritical": "Kritik"
  },
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/scripts/ScriptProposalDetail.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 8: Run translation coverage**

Run: `cd apps/web && npx vitest run src/lib/i18n/translationCoverage.test.ts`
Expected: PASS — every new key has a distinct, non-English string in all 7 translated locales, so no namespace duplicate baseline needs to move.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/scripts/ScriptProposalDetail.tsx apps/web/src/components/scripts/ScriptProposalDetail.test.tsx apps/web/src/pages/ai-script-proposals apps/web/src/locales/*/scripts.json
git commit -m "feat(ai-scripts): read-only script-proposal detail page with evidence-erased state"
```

---

## Task 3: Device activity feed surfaces AI-authored script runs

**Files:**
- Modify: `apps/web/src/components/devices/DeviceActivityFeed.tsx` (`ActivityEvent` type, `ACTION_RULES`, row rendering)
- Modify: `apps/web/src/locales/en/devices.json` (+ 7 other locales) — one new key under `deviceActivityFeed`
- Test: `apps/web/src/components/devices/DeviceActivityFeed.test.tsx` (append tests)

**Interfaces:**
- Consumes: the `ai.script.executed` audit action and its `details.proposalId` from Task 1, delivered through the existing `GET /devices/:id/events` response shape (`apps/api/src/routes/devices/events.ts:388-409`, unchanged) — `initiatedBy: 'ai'` already renders the "AI" chip via the pre-existing `INITIATOR_LABELS.ai = "AI"` (`apps/web/src/components/devices/DeviceActivityFeed.tsx:107`).
- Produces: a "View proposal" link to `/ai-script-proposals/:proposalId` (Task 2's route) on every AI-authored script row.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/components/devices/DeviceActivityFeed.test.tsx` (reuses the file's existing `mockFeed` helper):

```tsx
  it('shows an AI chip and a proposal link for an AI-authored script run', async () => {
    mockFeed([
      {
        id: 'e-ai-1',
        action: 'ai.script.executed',
        message: 'AI script executed — host-1',
        result: 'dispatched',
        initiatedBy: 'ai',
        timestamp: '2026-09-11T00:00:00Z',
        actor: { type: 'user', name: 'Jane Tech', email: 'jane@example.com' },
        details: { proposalId: 'proposal-1' },
      },
    ]);
    render(<DeviceActivityFeed deviceId="dev-1" />);
    await waitFor(() => expect(screen.getByText(/AI script executed/i)).toBeTruthy());

    expect(screen.getByText('AI')).toBeTruthy();
    const link = screen.getByRole('link', { name: /view proposal/i });
    expect(link.getAttribute('href')).toBe('/ai-script-proposals/proposal-1');
  });

  it('renders no proposal link when details.proposalId is absent', async () => {
    mockFeed([
      {
        id: 'e-ai-2',
        action: 'ai.script.executed',
        message: 'AI script executed — host-1',
        result: 'dispatched',
        initiatedBy: 'ai',
        timestamp: '2026-09-11T00:00:00Z',
      },
    ]);
    render(<DeviceActivityFeed deviceId="dev-1" />);
    await waitFor(() => expect(screen.getByText(/AI script executed/i)).toBeTruthy());

    expect(screen.queryByRole('link', { name: /view proposal/i })).toBeNull();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/devices/DeviceActivityFeed.test.tsx`
Expected: FAIL — no "View proposal" link is rendered yet, and `ai.script.executed` is filtered out server-side today because it is not in `ACTION_PREFIXES` (the mocked fetch bypasses that, but the row map has no branch for `details.proposalId`).

- [ ] **Step 3: Extend `ActivityEvent` and `ACTION_RULES`**

In `apps/web/src/components/devices/DeviceActivityFeed.tsx`, extend the type (around line 26):

```ts
type ActivityEvent = {
  id: string;
  action?: string;
  message?: string;
  result?: AuditResult;
  initiatedBy?: string | null;
  timestamp?: string;
  actor?: { type?: string; name?: string; email?: string | null };
  details?: { proposalId?: string | null } | null;
};
```

Add an icon import and an `ACTION_RULES` entry (near the other rules, around line 57-79). `Sparkles` is not yet imported in this file:

```ts
import {
  Activity,
  AlertTriangle,
  Power,
  Terminal,
  Monitor,
  Download,
  Package,
  Wrench,
  Trash2,
  HardDrive,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
```

```ts
const ACTION_RULES: { prefix: string; icon: LucideIcon }[] = [
  { prefix: "device.command", icon: Power },
  { prefix: "script.", icon: Terminal },
  { prefix: "ai.script.", icon: Sparkles }, // #5022 W05 — AI-authored script runs
  { prefix: "device.remote_access", icon: Monitor },
  // ... rest unchanged
```

`ai.script.` does not start with `AUTOMATED_ACTION_PREFIX` (`"agent.command."`), so it is automatically included in `ACTION_PREFIXES` (`apps/web/src/components/devices/DeviceActivityFeed.tsx:93-97`) and requested by the server-side filter with no further change.

- [ ] **Step 4: Render the proposal link on AI-authored rows**

Inside the row `<li>` rendering (`apps/web/src/components/devices/DeviceActivityFeed.tsx`, the `visible.map((e) => { ... })` block), add the link right after the existing metadata `<p>` (after the closing `</p>` that renders `who` / `initiator` / `automated` / time / `failed`, inside the same `<div className="min-w-0 flex-1">`):

```tsx
                    {e.details?.proposalId && (
                      <a
                        href={`/ai-script-proposals/${e.details.proposalId}`}
                        className="mt-0.5 inline-block text-xs font-medium text-primary hover:underline"
                      >
                        {t("deviceActivityFeed.viewProposal")}
                      </a>
                    )}
```

- [ ] **Step 5: Add the i18n key — `en` first**

`apps/web/src/locales/en/devices.json`, inside the existing `deviceActivityFeed` object (near `"viewAllActivity2"`):

```json
    "viewProposal": "View proposal",
```

- [ ] **Step 6: Add the same key to the 7 other locales**

`de-DE`: `"viewProposal": "Vorschlag ansehen"`
`es-419`: `"viewProposal": "Ver propuesta"`
`fr-FR`: `"viewProposal": "Voir la proposition"`
`fr-CA`: `"viewProposal": "Voir la proposition"`
`it-IT`: `"viewProposal": "Visualizza proposta"`
`pt-BR`: `"viewProposal": "Ver proposta"`
`tr-TR`: `"viewProposal": "Öneriyi görüntüle"`

Insert each into the corresponding `apps/web/src/locales/<locale>/devices.json`'s `deviceActivityFeed` object, in the same position as the `en` file.

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/devices/DeviceActivityFeed.test.tsx`
Expected: PASS (all tests, including the two new ones)

- [ ] **Step 8: Run translation coverage**

Run: `cd apps/web && npx vitest run src/lib/i18n/translationCoverage.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/devices/DeviceActivityFeed.tsx apps/web/src/components/devices/DeviceActivityFeed.test.tsx apps/web/src/locales/*/devices.json
git commit -m "feat(ai-scripts): show AI-authored script runs on the device activity feed (#5022)"
```

---

## Task 4: Script-proposal metrics endpoint — proposals/day and reviewer disagreements

**Files:**
- Modify: `apps/api/src/routes/ai.ts` (new route, appended after the existing `/admin/tool-executions` handler, i.e. after today's line 1559)
- Test: `apps/api/src/routes/ai_admin.test.ts` (append a new `describe` block, mirrors the existing `GET /ai/admin/tool-executions` tests at line 518)

**Interfaces:**
- Consumes: `scriptProposals` / `scriptProposalReviews` Drizzle tables (W01b, spec §4.1, assumed exported from `apps/api/src/db/schema/scriptProposals.ts` and re-exported through the `../db/schema` barrel exactly like every other table imported in `ai.ts`); `RiskTier`/`RISK_TIERS` type from `@breeze/shared` (W01b, roadmap §3.1) — not used directly in this task but documents the `riskTier` values this endpoint's inputs carry.
- Produces: `GET /ai/admin/script-proposals-metrics?orgId=&since=&until=` → `{ scriptProposals: { perDay: {date: string; count: number}[]; reviewerDisagreements: { humanRejectedAfterApprove: number; humanApprovedAfterReject: number } } }`. Task 6 appends `unattendedRuns` and `laneState` to this same response shape once W04 lands — do not treat this shape as final.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/routes/ai_admin.test.ts` (place after the existing `describe('GET /ai/admin/tool-executions', ...)` block):

```ts
describe('GET /ai/admin/script-proposals-metrics', () => {
  it('requires access to the requested org', async () => {
    const res = await app.request('/ai/admin/script-proposals-metrics?orgId=other-org-id', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(403);
  });

  it('returns per-day proposal counts and reviewer-disagreement counts for the org', async () => {
    vi.mocked(db.select)
      // 1. perDay group-by
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            groupBy: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([
                { date: '2026-09-10', count: 3 },
                { date: '2026-09-11', count: 1 },
              ]),
            }),
          }),
        }),
      } as never);
    vi.mocked(db.execute).mockResolvedValueOnce({
      rows: [{ humanRejectedAfterApprove: '2', humanApprovedAfterReject: '1' }],
    } as never);

    const res = await app.request(`/ai/admin/script-proposals-metrics?orgId=${ORG_ID}`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scriptProposals.perDay).toEqual([
      { date: '2026-09-10', count: 3 },
      { date: '2026-09-11', count: 1 },
    ]);
    expect(body.scriptProposals.reviewerDisagreements).toEqual({
      humanRejectedAfterApprove: 2,
      humanApprovedAfterReject: 1,
    });
  });
});
```

Check the top of `apps/api/src/routes/ai_admin.test.ts` for the file's existing `ORG_ID` constant and `db` import/mock (it already mocks `../db` for the `tool-executions` tests above) — reuse them rather than redeclaring.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/ai_admin.test.ts`
Expected: FAIL — 404, the route does not exist.

- [ ] **Step 3: Add the schema imports**

In `apps/api/src/routes/ai.ts`, extend the existing schema import (today's line 41):

```ts
import { aiSessions, aiMessages, aiToolExecutions, auditLogs, organizations, devices, actionIntents, scriptProposals, scriptProposalReviews } from '../db/schema';
```

And extend the `drizzle-orm` import (today's line 42) with `sql as drizzleSql` already present — add nothing there, but add a plain `sql` import for the raw disagreement query (drizzle-orm's tagged-template `sql` used with `db.execute`, matching `apps/api/src/services/tenantCascade.ts:70-96`):

```ts
import { eq, and, desc, gte, lte, count, avg, sql as drizzleSql, sql } from 'drizzle-orm';
```

- [ ] **Step 4: Implement the route**

Append after the existing `/admin/tool-executions` handler (after its closing `);` — today's line 1559-1560):

```ts

// Small local normaliser for a raw db.execute() result across driver
// shapes — mirrors services/tenantCascade.ts:56-60's rowsFromExecute
// (not exported from there, so duplicated locally per CLAUDE.md's guidance
// that small cross-file helpers may be duplicated rather than shared).
function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

// GET /admin/script-proposals-metrics - AI Risk Dashboard script-proposal panel (W05, #5612)
aiRoutes.get(
  '/admin/script-proposals-metrics',
  requireScope('organization', 'partner', 'system'),
  requireAiRead,
  async (c) => {
    const auth = c.get('auth');
    const orgId = c.req.query('orgId') || auth.orgId;

    if (!orgId) {
      return c.json({ scriptProposals: { perDay: [], reviewerDisagreements: { humanRejectedAfterApprove: 0, humanApprovedAfterReject: 0 } } });
    }
    if (orgId !== auth.orgId && !auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    const sinceParam = c.req.query('since');
    const untilParam = c.req.query('until');
    const since = sinceParam ? new Date(sinceParam) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const until = untilParam ? new Date(untilParam) : new Date();
    if (isNaN(since.getTime())) return c.json({ error: `Invalid 'since' date: ${sinceParam}` }, 400);
    if (isNaN(until.getTime())) return c.json({ error: `Invalid 'until' date: ${untilParam}` }, 400);

    // 1. Proposals per day
    const perDayRows = await db
      .select({
        date: drizzleSql<string>`DATE(${scriptProposals.createdAt})::text`,
        count: drizzleSql<number>`COUNT(*)::int`,
      })
      .from(scriptProposals)
      .where(and(eq(scriptProposals.orgId, orgId), gte(scriptProposals.createdAt, since), lte(scriptProposals.createdAt, until)))
      .groupBy(drizzleSql`DATE(${scriptProposals.createdAt})`)
      .orderBy(drizzleSql`DATE(${scriptProposals.createdAt}) ASC`);
    const perDay = perDayRows.map((row) => ({ date: row.date, count: Number(row.count) }));

    // 2. Reviewer disagreements — a human decision that goes against the
    // latest completed model review. DISTINCT ON needs raw SQL: Drizzle's
    // query builder has no portable equivalent used elsewhere in this repo
    // (see tenantCascade.ts for the same db.execute + rowsFromExecute
    // pattern). decided_by IS NOT NULL excludes the unattended lane's
    // auto-approved proposals (decidedByUserId stays null there), which have
    // no human decision to disagree with.
    const disagreementResult = await db.execute(sql`
      WITH latest_review AS (
        SELECT DISTINCT ON (proposal_id) proposal_id, recommended_action
        FROM script_proposal_reviews
        WHERE org_id = ${orgId} AND reviewer_kind = 'model' AND status = 'completed'
        ORDER BY proposal_id, created_at DESC
      )
      SELECT
        COUNT(*) FILTER (WHERE lr.recommended_action = 'approve' AND sp.status = 'rejected') AS "humanRejectedAfterApprove",
        COUNT(*) FILTER (WHERE lr.recommended_action = 'reject' AND sp.status IN ('approved', 'executed', 'verified', 'promoted')) AS "humanApprovedAfterReject"
      FROM script_proposals sp
      JOIN latest_review lr ON lr.proposal_id = sp.id
      WHERE sp.org_id = ${orgId}
        AND sp.decided_by IS NOT NULL
        AND sp.created_at BETWEEN ${since} AND ${until}
    `);
    const [disagreementRow] = rowsFromExecute<{ humanRejectedAfterApprove: string | number; humanApprovedAfterReject: string | number }>(
      disagreementResult,
    );

    return c.json({
      scriptProposals: {
        perDay,
        reviewerDisagreements: {
          humanRejectedAfterApprove: Number(disagreementRow?.humanRejectedAfterApprove ?? 0),
          humanApprovedAfterReject: Number(disagreementRow?.humanApprovedAfterReject ?? 0),
        },
      },
    });
  }
);
```

Note: `scriptProposalReviews` is imported for documentation of the table this route reads (per the Interfaces block) even though the disagreement query itself uses a raw table name inside `sql`— keep the import; a future task refactoring this to the query builder will need it, and an unused-import lint would otherwise flag its absence from the file's own convention of importing every table it discusses in comments (see `actionIntents`, imported and used elsewhere in this same file).

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/routes/ai_admin.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/ai.ts apps/api/src/routes/ai_admin.test.ts
git commit -m "feat(ai-scripts): script-proposal metrics endpoint (per-day counts, reviewer disagreements)"
```

---

## Task 5: AI Risk Dashboard — Script Proposals panel (per-day + disagreements)

**Files:**
- Create: `apps/web/src/components/ai-risk/ScriptProposalsPanel.tsx`
- Modify: `apps/web/src/components/ai-risk/AiRiskDashboard.tsx` (new tab)
- Modify: `apps/web/src/locales/en/security.json` (+ 7 other locales)
- Test: `apps/web/src/components/ai-risk/ScriptProposalsPanel.test.tsx`

**Interfaces:**
- Consumes: `GET /ai/admin/script-proposals-metrics` (Task 4) → `{ scriptProposals: { perDay: {date,count}[]; reviewerDisagreements: {...}; unattendedRuns?: number; laneState?: 'open'|'closed'|null } }`. This task renders only `perDay` and `reviewerDisagreements`; `unattendedRuns`/`laneState` are optional on the wire until Task 6 ships, and this component renders nothing for them when absent (guarded with `data.scriptProposals.unattendedRuns !== undefined`), so it does not need to change again when Task 7 adds them — Task 7 only adds the two extra cards.
- Produces: a new `"proposals"` tab in `AiRiskDashboard`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/ai-risk/ScriptProposalsPanel.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ScriptProposalsPanel } from './ScriptProposalsPanel';
import type { ScriptProposalsMetrics } from './ScriptProposalsPanel';

const metrics = (o: Partial<ScriptProposalsMetrics> = {}): ScriptProposalsMetrics => ({
  perDay: [
    { date: '2026-09-10', count: 3 },
    { date: '2026-09-11', count: 1 },
  ],
  reviewerDisagreements: { humanRejectedAfterApprove: 2, humanApprovedAfterReject: 1 },
  ...o,
});

describe('ScriptProposalsPanel', () => {
  it('renders proposals-per-day and reviewer-disagreement counts', () => {
    render(<ScriptProposalsPanel data={metrics()} loading={false} />);
    expect(screen.getByText('2')).toBeTruthy(); // humanRejectedAfterApprove
    expect(screen.getByText('1')).toBeTruthy(); // humanApprovedAfterReject
  });

  it('renders nothing for unattended/lane fields when they are absent', () => {
    render(<ScriptProposalsPanel data={metrics()} loading={false} />);
    expect(screen.queryByTestId('script-proposals-unattended-card')).toBeNull();
    expect(screen.queryByTestId('script-proposals-lane-card')).toBeNull();
  });

  it('shows an empty state with no data', () => {
    render(<ScriptProposalsPanel data={null} loading={false} />);
    expect(screen.getByText(/no script proposals/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/ai-risk/ScriptProposalsPanel.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the panel**

```tsx
// apps/web/src/components/ai-risk/ScriptProposalsPanel.tsx
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

export interface ScriptProposalsMetrics {
  perDay: { date: string; count: number }[];
  reviewerDisagreements: { humanRejectedAfterApprove: number; humanApprovedAfterReject: number };
  unattendedRuns?: number;
  laneState?: 'open' | 'closed' | null;
}

interface Props {
  data: ScriptProposalsMetrics | null;
  loading: boolean;
}

export function ScriptProposalsPanel({ data, loading }: Props) {
  const { t } = useTranslation("security");

  if (loading || !data) {
    return (
      <div>
        <h2 className="mb-4 text-lg font-semibold">{t("aiRiskScriptProposalsPanel.title")}</h2>
        {!loading && (
          <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground shadow-xs">
            {t("aiRiskScriptProposalsPanel.noData")}
          </div>
        )}
        {loading && (
          <div className="h-56 animate-pulse rounded-lg border bg-muted/30" />
        )}
      </div>
    );
  }

  return (
    <div>
      <h2 className="mb-4 text-lg font-semibold">{t("aiRiskScriptProposalsPanel.title")}</h2>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-lg border bg-card p-4 shadow-xs">
          <h3 className="mb-3 text-sm font-medium text-muted-foreground">
            {t("aiRiskScriptProposalsPanel.proposalsPerDay")}
          </h3>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.perDay}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="date" className="fill-muted-foreground text-xs" />
                <YAxis allowDecimals={false} className="fill-muted-foreground text-xs" />
                <Tooltip />
                <Line type="monotone" dataKey="count" stroke="#3b82f6" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-4 shadow-xs">
          <h3 className="mb-3 text-sm font-medium text-muted-foreground">
            {t("aiRiskScriptProposalsPanel.reviewerDisagreements")}
          </h3>
          <dl className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">{t("aiRiskScriptProposalsPanel.humanRejectedAfterApprove")}</dt>
              <dd className="text-lg font-semibold tabular-nums">{data.reviewerDisagreements.humanRejectedAfterApprove}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">{t("aiRiskScriptProposalsPanel.humanApprovedAfterReject")}</dt>
              <dd className="text-lg font-semibold tabular-nums">{data.reviewerDisagreements.humanApprovedAfterReject}</dd>
            </div>
          </dl>
        </div>

        {data.unattendedRuns !== undefined && (
          <div data-testid="script-proposals-unattended-card" className="rounded-lg border bg-card p-4 shadow-xs">
            <h3 className="mb-3 text-sm font-medium text-muted-foreground">
              {t("aiRiskScriptProposalsPanel.unattendedRuns")}
            </h3>
            <p className="text-lg font-semibold tabular-nums">{data.unattendedRuns}</p>
          </div>
        )}

        {data.laneState !== undefined && (
          <div data-testid="script-proposals-lane-card" className="rounded-lg border bg-card p-4 shadow-xs">
            <h3 className="mb-3 text-sm font-medium text-muted-foreground">
              {t("aiRiskScriptProposalsPanel.laneState")}
            </h3>
            <p className="text-lg font-semibold">
              {data.laneState === 'open'
                ? t("aiRiskScriptProposalsPanel.laneOpen")
                : data.laneState === 'closed'
                  ? t("aiRiskScriptProposalsPanel.laneClosed")
                  : t("aiRiskScriptProposalsPanel.laneNotConfigured")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire the new tab into `AiRiskDashboard`**

In `apps/web/src/components/ai-risk/AiRiskDashboard.tsx`:

Add the import and a `scriptMetrics` fetch alongside the existing `execData`/`securityEvents` state (near line 121-122):

```tsx
import { ScriptProposalsPanel } from "./ScriptProposalsPanel";
import type { ScriptProposalsMetrics } from "./ScriptProposalsPanel";
```

```tsx
  const [scriptMetrics, setScriptMetrics] = useState<ScriptProposalsMetrics | null>(null);
```

Extend the `fetchData` `Promise.allSettled` call (today lines 129-132) to a third parallel fetch, and its handling (after the existing `secResult` handling, before `setLastUpdated`):

```tsx
      const [execResult, secResult, scriptResult] = await Promise.allSettled([
        fetchWithAuth(`/ai/admin/tool-executions?since=${since}&limit=200`),
        fetchWithAuth(`/ai/admin/security-events?since=${since}&limit=100`),
        fetchWithAuth(`/ai/admin/script-proposals-metrics?since=${since}`),
      ]);
```

```tsx
      if (scriptResult.status === "fulfilled" && scriptResult.value.ok) {
        const scriptJson = await scriptResult.value.json();
        setScriptMetrics(scriptJson.scriptProposals ?? null);
      } else {
        setScriptMetrics(null);
      }
```

Add `"proposals"` to the `Tab` union and `TABS` array (near lines 70-101):

```ts
type Tab = "guardrails" | "analytics" | "approvals" | "rate-limits" | "denials" | "proposals";
```

```ts
  {
    id: "proposals",
    labelKey: "aiRiskAiRiskDashboard.proposals",
    icon: BrainCircuit,
  },
```

(`BrainCircuit` is already imported at the top of the file for the header icon.)

Render the panel in the tab-content section (after the `denials` block, before the closing `</div>` — today around line 282):

```tsx
      {activeTab === "proposals" && <ScriptProposalsPanel data={scriptMetrics} loading={loading} />}
```

- [ ] **Step 5: Add i18n keys — `en` first**

`apps/web/src/locales/en/security.json`, add `"proposals": "Script Proposals"` to the existing `aiRiskAiRiskDashboard` object (near `"denials"`), and add a new top-level section:

```json
  "aiRiskScriptProposalsPanel": {
    "title": "Script Proposals",
    "proposalsPerDay": "Proposals per day",
    "reviewerDisagreements": "Reviewer disagreements",
    "humanRejectedAfterApprove": "Human rejected after AI approved",
    "humanApprovedAfterReject": "Human approved after AI rejected",
    "unattendedRuns": "Unattended runs",
    "laneState": "Unattended lane",
    "laneOpen": "Open (paused after repeated failed verifications)",
    "laneClosed": "Closed",
    "laneNotConfigured": "Not configured for this organization",
    "noData": "No script proposals in this time period"
  },
```

- [ ] **Step 6: Add the same sections to the 7 other locales**

`de-DE`:
```json
  "aiRiskScriptProposalsPanel": {
    "title": "Skriptvorschläge",
    "proposalsPerDay": "Vorschläge pro Tag",
    "reviewerDisagreements": "Abweichende Entscheidungen",
    "humanRejectedAfterApprove": "Mensch abgelehnt, obwohl KI zustimmte",
    "humanApprovedAfterReject": "Mensch genehmigt, obwohl KI ablehnte",
    "unattendedRuns": "Unbeaufsichtigte Ausführungen",
    "laneState": "Unbeaufsichtigter Kanal",
    "laneOpen": "Offen (nach wiederholt fehlgeschlagenen Prüfungen pausiert)",
    "laneClosed": "Geschlossen",
    "laneNotConfigured": "Für diese Organisation nicht konfiguriert",
    "noData": "Keine Skriptvorschläge in diesem Zeitraum"
  },
```
And in `aiRiskAiRiskDashboard`: `"proposals": "Skriptvorschläge"`.

`es-419`:
```json
  "aiRiskScriptProposalsPanel": {
    "title": "Propuestas de scripts",
    "proposalsPerDay": "Propuestas por día",
    "reviewerDisagreements": "Discrepancias del revisor",
    "humanRejectedAfterApprove": "Rechazo humano tras aprobación de la IA",
    "humanApprovedAfterReject": "Aprobación humana tras rechazo de la IA",
    "unattendedRuns": "Ejecuciones desatendidas",
    "laneState": "Canal desatendido",
    "laneOpen": "Abierto (pausado tras fallos repetidos de verificación)",
    "laneClosed": "Cerrado",
    "laneNotConfigured": "No configurado para esta organización",
    "noData": "No hay propuestas de scripts en este período"
  },
```
And: `"proposals": "Propuestas de scripts"`.

`fr-FR`:
```json
  "aiRiskScriptProposalsPanel": {
    "title": "Propositions de scripts",
    "proposalsPerDay": "Propositions par jour",
    "reviewerDisagreements": "Désaccords du réviseur",
    "humanRejectedAfterApprove": "Rejet humain après approbation de l'IA",
    "humanApprovedAfterReject": "Approbation humaine après rejet de l'IA",
    "unattendedRuns": "Exécutions sans surveillance",
    "laneState": "Voie sans surveillance",
    "laneOpen": "Ouverte (suspendue après des échecs de vérification répétés)",
    "laneClosed": "Fermée",
    "laneNotConfigured": "Non configurée pour cette organisation",
    "noData": "Aucune proposition de script sur cette période"
  },
```
And: `"proposals": "Propositions de scripts"`.

`fr-CA`:
```json
  "aiRiskScriptProposalsPanel": {
    "title": "Propositions de scripts",
    "proposalsPerDay": "Propositions par jour",
    "reviewerDisagreements": "Désaccords du réviseur",
    "humanRejectedAfterApprove": "Rejet humain après approbation de l'IA",
    "humanApprovedAfterReject": "Approbation humaine après rejet de l'IA",
    "unattendedRuns": "Exécutions sans supervision",
    "laneState": "Voie sans supervision",
    "laneOpen": "Ouverte (suspendue après des échecs de vérification répétés)",
    "laneClosed": "Fermée",
    "laneNotConfigured": "Non configurée pour cette organisation",
    "noData": "Aucune proposition de script pour cette période"
  },
```
And: `"proposals": "Propositions de scripts"`.

`it-IT`:
```json
  "aiRiskScriptProposalsPanel": {
    "title": "Proposte di script",
    "proposalsPerDay": "Proposte al giorno",
    "reviewerDisagreements": "Disaccordi del revisore",
    "humanRejectedAfterApprove": "Rifiuto umano dopo approvazione dell'IA",
    "humanApprovedAfterReject": "Approvazione umana dopo rifiuto dell'IA",
    "unattendedRuns": "Esecuzioni non presidiate",
    "laneState": "Corsia non presidiata",
    "laneOpen": "Aperta (sospesa dopo verifiche fallite ripetute)",
    "laneClosed": "Chiusa",
    "laneNotConfigured": "Non configurata per questa organizzazione",
    "noData": "Nessuna proposta di script in questo periodo"
  },
```
And: `"proposals": "Proposte di script"`.

`pt-BR`:
```json
  "aiRiskScriptProposalsPanel": {
    "title": "Propostas de script",
    "proposalsPerDay": "Propostas por dia",
    "reviewerDisagreements": "Divergências do revisor",
    "humanRejectedAfterApprove": "Rejeitado por humano após aprovação da IA",
    "humanApprovedAfterReject": "Aprovado por humano após rejeição da IA",
    "unattendedRuns": "Execuções não supervisionadas",
    "laneState": "Faixa não supervisionada",
    "laneOpen": "Aberta (pausada após falhas repetidas de verificação)",
    "laneClosed": "Fechada",
    "laneNotConfigured": "Não configurada para esta organização",
    "noData": "Nenhuma proposta de script neste período"
  },
```
And: `"proposals": "Propostas de script"`.

`tr-TR`:
```json
  "aiRiskScriptProposalsPanel": {
    "title": "Komut Dosyası Önerileri",
    "proposalsPerDay": "Günlük öneriler",
    "reviewerDisagreements": "İnceleyici anlaşmazlıkları",
    "humanRejectedAfterApprove": "Yapay zeka onayladıktan sonra insan reddetti",
    "humanApprovedAfterReject": "Yapay zeka reddettikten sonra insan onayladı",
    "unattendedRuns": "Gözetimsiz çalıştırmalar",
    "laneState": "Gözetimsiz şerit",
    "laneOpen": "Açık (tekrarlanan doğrulama hatalarından sonra duraklatıldı)",
    "laneClosed": "Kapalı",
    "laneNotConfigured": "Bu kuruluş için yapılandırılmadı",
    "noData": "Bu dönemde komut dosyası önerisi yok"
  },
```
And: `"proposals": "Komut Dosyası Önerileri"`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run src/components/ai-risk/ScriptProposalsPanel.test.tsx`
Expected: PASS

- [ ] **Step 8: Run translation coverage**

Run: `cd apps/web && npx vitest run src/lib/i18n/translationCoverage.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/ai-risk/ScriptProposalsPanel.tsx apps/web/src/components/ai-risk/ScriptProposalsPanel.test.tsx apps/web/src/components/ai-risk/AiRiskDashboard.tsx apps/web/src/locales/*/security.json
git commit -m "feat(ai-scripts): Script Proposals panel on the AI Risk Dashboard"
```

---

## Task 6 (AFTER W04): Metrics endpoint gains unattended-run count and lane state

**Do not start this task until W04 has merged** — it reads `ai_script_lane_state` and `script_executions.approval_method = 'unattended_reviewer_gated'`, neither of which is meaningful (the former doesn't exist as a table) before W04's `2026-10-16-110000-ai-script-policies.sql` migration lands (roadmap §5).

**Files:**
- Modify: `apps/api/src/routes/ai.ts` (extend the Task 4 handler)
- Test: `apps/api/src/routes/ai_admin.test.ts` (extend the Task 4 test block)

**Interfaces:**
- Consumes: `aiScriptLaneState` Drizzle table, PK `org_id`, column `state: 'open' | 'closed'` (W04, spec §4.1, roadmap §3.6 — file `apps/api/src/db/schema/aiScriptLaneState.ts`); `scriptExecutions.approvalMethod` (already consumed read-only by Task 1).
- Produces: extends Task 4's response with `unattendedRuns: number` and `laneState: 'open' | 'closed' | null`.

- [ ] **Step 1: Write the failing test**

Extend the `describe('GET /ai/admin/script-proposals-metrics', ...)` block from Task 4:

```ts
  it('includes unattendedRuns and laneState once the W04 lane tables exist', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            groupBy: vi.fn().mockReturnValue({ orderBy: vi.fn().mockResolvedValue([]) }),
          }),
        }),
      } as never)
      // unattendedRuns count
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ count: 4 }]) }),
      } as never)
      // laneState row
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ state: 'open' }]) }),
        }),
      } as never);
    vi.mocked(db.execute).mockResolvedValueOnce({
      rows: [{ humanRejectedAfterApprove: '0', humanApprovedAfterReject: '0' }],
    } as never);

    const res = await app.request(`/ai/admin/script-proposals-metrics?orgId=${ORG_ID}`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    const body = await res.json();
    expect(body.scriptProposals.unattendedRuns).toBe(4);
    expect(body.scriptProposals.laneState).toBe('open');
  });

  it('reports laneState null when the org has no lane-state row', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            groupBy: vi.fn().mockReturnValue({ orderBy: vi.fn().mockResolvedValue([]) }),
          }),
        }),
      } as never)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ count: 0 }]) }),
      } as never)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        }),
      } as never);
    vi.mocked(db.execute).mockResolvedValueOnce({
      rows: [{ humanRejectedAfterApprove: '0', humanApprovedAfterReject: '0' }],
    } as never);

    const res = await app.request(`/ai/admin/script-proposals-metrics?orgId=${ORG_ID}`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    const body = await res.json();
    expect(body.scriptProposals.laneState).toBeNull();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/ai_admin.test.ts`
Expected: FAIL — `unattendedRuns`/`laneState` are `undefined` in the response.

- [ ] **Step 3: Extend the schema import**

```ts
import { aiSessions, aiMessages, aiToolExecutions, auditLogs, organizations, devices, actionIntents, scriptProposals, scriptProposalReviews, scriptExecutions, aiScriptLaneState } from '../db/schema';
```

- [ ] **Step 4: Extend the handler**

Insert before the final `return c.json({ scriptProposals: { ... } })` from Task 4:

```ts
    // 3. Unattended runs in the window (W04)
    const [unattendedCountRow] = await db
      .select({ count: drizzleSql<number>`COUNT(*)::int` })
      .from(scriptExecutions)
      .where(
        and(
          eq(scriptExecutions.orgId, orgId),
          eq(scriptExecutions.approvalMethod, 'unattended_reviewer_gated'),
          gte(scriptExecutions.createdAt, since),
          lte(scriptExecutions.createdAt, until),
        ),
      );
    const unattendedRuns = Number(unattendedCountRow?.count ?? 0);

    // 4. Lane state (W04) — one row per org, PK org_id; no row means the
    // lane has never been evaluated for this org.
    const [laneRow] = await db
      .select({ state: aiScriptLaneState.state })
      .from(aiScriptLaneState)
      .where(eq(aiScriptLaneState.orgId, orgId))
      .limit(1);
    const laneState = laneRow?.state ?? null;
```

And change the final response to:

```ts
    return c.json({
      scriptProposals: {
        perDay,
        unattendedRuns,
        laneState,
        reviewerDisagreements: {
          humanRejectedAfterApprove: Number(disagreementRow?.humanRejectedAfterApprove ?? 0),
          humanApprovedAfterReject: Number(disagreementRow?.humanApprovedAfterReject ?? 0),
        },
      },
    });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/ai_admin.test.ts`
Expected: PASS (all `script-proposals-metrics` tests, including Task 4's)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/ai.ts apps/api/src/routes/ai_admin.test.ts
git commit -m "feat(ai-scripts): add unattended-run count and lane state to the script-proposal metrics endpoint"
```

---

## Task 7 (AFTER W04): Dashboard renders unattended-run and lane-state cards

**Do not start until Task 6 has shipped.** The `ScriptProposalsPanel` component built in Task 5 already renders these two cards conditionally on the fields being present (`data.unattendedRuns !== undefined`, `data.laneState !== undefined`) — this task only has to stop omitting them from the fetched data.

**Files:**
- Modify: `apps/web/src/components/ai-risk/ScriptProposalsPanel.test.tsx` (add coverage for the two cards actually rendering)

**Interfaces:**
- Consumes: `unattendedRuns`/`laneState` now present on every `GET /ai/admin/script-proposals-metrics` response (Task 6) — `AiRiskDashboard.tsx`'s existing `setScriptMetrics(scriptJson.scriptProposals ?? null)` (Task 5) requires no change, since it already forwards the whole `scriptProposals` object including any new fields.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/components/ai-risk/ScriptProposalsPanel.test.tsx`:

```tsx
  it('renders the unattended-runs and lane-state cards once the fields are present', () => {
    render(
      <ScriptProposalsPanel
        data={metrics({ unattendedRuns: 7, laneState: 'closed' })}
        loading={false}
      />,
    );
    expect(screen.getByTestId('script-proposals-unattended-card')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByTestId('script-proposals-lane-card')).toBeTruthy();
  });

  it('shows the "open" copy when the lane has paused itself', () => {
    render(<ScriptProposalsPanel data={metrics({ unattendedRuns: 0, laneState: 'open' })} loading={false} />);
    expect(screen.getByText(/paused after repeated failed verifications/i)).toBeTruthy();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/ai-risk/ScriptProposalsPanel.test.tsx`
Expected: FAIL — this exact assertion was never exercised before Task 6 shipped real data; run it now to confirm the Task-5 component already satisfies it, which is the point of this task.

- [ ] **Step 3: Confirm no production code change is needed**

Re-read `apps/web/src/components/ai-risk/ScriptProposalsPanel.tsx`'s conditional blocks (Task 5, Step 3) — they already branch on `data.unattendedRuns !== undefined` / `data.laneState !== undefined`. If the test in Step 2 is failing for any reason other than "these tests didn't exist yet" (e.g. a copy mismatch), fix the component now; otherwise no production file changes in this task.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/ai-risk/ScriptProposalsPanel.test.tsx`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ai-risk/ScriptProposalsPanel.test.tsx
git commit -m "test(ai-scripts): cover unattended-run and lane-state cards now that W04 data is live"
```

---

## Task 8: New docs page — `ai-script-authoring.mdx`

**Files:**
- Create: `apps/docs/src/content/docs/features/ai-script-authoring.mdx`
- Modify: `scripts/docs-review/mapping.json` (register the new doc against its source files)
- Modify: `packages/shared/src/utils/docsMapping.ts` (+ `docsMapping.test.ts`) — help-panel route mapping

**Interfaces:**
- Produces: the canonical admin-facing explanation of AI script authoring (three review layers, approval card, provenance, promotion, unattended lane and its policy, admin setup, FAQ) — everything Task 9's doc updates cross-link to.

- [ ] **Step 1: Write the page**

```mdx
---
title: AI Script Authoring & Review
description: How the AI assistant and background agents can write, get reviewed, and run scripts on your devices — and the controls that keep a human in the loop.
---

import { Steps, Aside, Tabs, TabItem } from '@astrojs/starlight/components';

When no existing script in your library fits, the Breeze AI assistant (in chat) and background AI agents can **write one**, get it independently reviewed, and — after a human approves it, or your organization has explicitly opted in to unattended runs — execute it on the devices you're working on.

Nothing the AI writes ever runs unless a human reads a plain-language summary of it and approves, or your partner and your organization have both opted in to the unattended lane described below and the script cleared every safety check.

---

## The three review layers

Every AI-written script goes through three checks, in order, before it can run:

<Steps>

1. **Automated scan.** The script is scanned for known-dangerous patterns (disabling security tools, deleting system files, exfiltrating credentials, and similar) before anyone — human or AI — sees it. A match on the most dangerous pattern list stops the process immediately; nothing is shown to a reviewer or an approver.

2. **Independent AI review.** A second AI model — one that never sees your conversation with the assistant, only the script itself and the devices it targets — reads the script and produces a plain-language summary, a risk tier (Low, Medium, High, or Critical), a list of findings, and a recommendation to approve, request changes, or reject.

3. **Human approval.** You see a readable approval card: what the script is for, what it does, the reviewer's summary and risk tier, and the code itself — never raw JSON. Low- and Medium-risk scripts can be approved by one qualified technician; High- and Critical-risk scripts require a second, independent approver ("four eyes").

</Steps>

## The approval card

When the assistant or an agent proposes a script, you're shown:

- **Goal and expected effect**, in the AI's own words
- **Risk tier** and the reviewer's summary
- **Findings** the reviewer flagged, with severity
- **The script itself**, exactly as it will run
- **Rollback notes**, if the AI provided any

Approving runs the exact script you read — there is no "edit and approve" option. If you want changes, choose **Request changes** with a note; the AI gets your feedback and the reviewer's findings, and proposes a revised script that goes through all three review layers again.

Some scripts also require an extra acknowledgement before you can approve: any script that matched a "strict" pattern (for example, a registry change under `HKLM`) needs the approver to hold the Scripts permission and complete a fresh multi-factor authentication check — the same requirement as approving a strict pattern on a script from your library.

## Provenance

Every script version and every execution that comes from this feature carries its origin:

- The **script library** shows an **Origin** column (Human, AI proposal, Imported, or System) and a "Reviewed" / "Edited since review" badge — editing an AI-authored script by hand clears the review badge, because what was reviewed is no longer exactly what would run.
- **Script detail** has a **Provenance panel**: who authored it, the reviewer's summary and risk tier, who approved it and how, and links to every execution.
- **Device Activity** on a device's page lists AI-authored script runs with an AI badge and a link to the originating proposal.

If the organization that produced a proposal is later merged into another organization or its data retention period ends, the proposal's own record may be erased — the script version and execution it produced remain, and the provenance panel shows "evidence erased" instead of a broken link.

## Promotion to the library

An AI-authored script is not added to your library automatically. After it has run and its author-specified verification claim has been independently confirmed (not just "the command exited 0" — an actual check, like confirming a service is running), **Save to library** becomes available on the proposal. Saving requires the Scripts permission and a fresh MFA check, exactly like creating a script by hand. From then on it's an ordinary library script, usable anywhere a library script is — including in an AI agent's autonomous "Act mode" toolkit.

## The unattended lane

For narrow, low-risk, high-confidence cases, Breeze can run an AI-authored script **without waiting for a human** — but only when every one of the following is true:

- Your **partner** (MSP) has raised the ceiling that allows the unattended lane for its organizations at all.
- **Your organization** has separately and explicitly turned the lane on. A partner-level ceiling never turns it on by itself.
- The independent reviewer rated the script **Low or Medium risk** (never higher), found it matched the stated goal, is reversible, and has an adequate verification plan.
- The script touches only a small, configurable allow-list of resource classes (for example: services, temporary files, DNS cache, printing) — never credentials, security tooling, disk, boot configuration, user/group accounts, firewall rules, or anything the scanner can't confidently classify.
- It targets exactly **one device**, has a timeout of 5 minutes or less, and (on Windows, for the resource classes that warrant it) a system restore point is captured first.
- Your organization hasn't recently had two unattended runs in a row fail their independent verification — if it has, the lane pauses itself for that organization until an administrator resets it.
- An hourly cap on unattended runs, set by your organization within your partner's ceiling, hasn't been reached.

Any script that doesn't clear every one of these goes to a human instead — there is no partial credit.

### Admin setup

<Aside type="note">
The unattended lane is off for every organization by default. Turning it on requires two separate actions.
</Aside>

1. Your **partner** administrator raises the partner-wide ceiling (maximum risk tier, allowed resource classes, hourly cap) under partner-level AI settings.
2. An **organization** administrator with the Approvals permission and a fresh MFA check turns the lane on for that organization, optionally tightening any of the partner's limits further (but never loosening them).
3. The **AI Risk Dashboard**'s Script Proposals panel shows unattended-run counts and the lane's current state (open/closed) so you can monitor it.

## FAQ

**Can the AI run any script it writes?**
No. Every AI-authored script is reviewed by an independent model and then either approved by a human or, only if your partner and your organization have both opted in, cleared through the unattended lane's fixed safety checks.

**What if I disagree with the reviewer?**
You decide. The reviewer's risk tier and recommendation are advisory to you (though they set the deterministic floor for the unattended lane) — you can approve a script the reviewer flagged as Medium risk, or reject one it recommended approving, and the AI Risk Dashboard tracks how often that happens.

**Does this replace the Script Builder AI in the editor?**
No — [Script Builder AI](/features/script-ai/) is a separate, in-editor assistant that helps you write scripts by hand and only runs a script with your explicit click. This feature is about the chat assistant and background agents authoring and running a script mid-conversation or mid-task, with independent review in between.

**Can I turn this off entirely?**
Yes — script proposing can be disabled per organization independently of the unattended lane.

## Related

- [Scripts](/features/scripts/) — the script library, execution history, and security patterns this feature builds on
- [AI Features](/features/ai/) — the assistant, its tool tiers, and the AI Risk Dashboard
- [AI Agents](/features/ai-agents/) — background agents, Act mode, and how they use this feature
- [Approval & Assurance](/features/approval-security/) — four-eyes approval and MFA step-up
```

- [ ] **Step 2: Register the doc in `mapping.json`**

Add an entry to `scripts/docs-review/mapping.json`:

```json
    {
      "pattern": "apps/api/src/services/scriptProposals/**",
      "docs": [
        "features/ai-script-authoring.mdx",
        "features/scripts.mdx",
        "features/ai.mdx"
      ]
    },
```

- [ ] **Step 3: Register the help-panel route mapping**

In `packages/shared/src/utils/docsMapping.ts`, add an entry in most-specific-first order (near the other `/ai-risk` or `/scripts` entries):

```ts
  { pattern: '/ai-script-proposals', docsPath: '/features/ai-script-authoring/', label: 'AI Script Proposal' },
```

Add a matching case to `packages/shared/src/utils/docsMapping.test.ts` (mirror the file's existing per-route test cases):

```ts
  it('maps /ai-script-proposals/:id to the AI script authoring doc', () => {
    expect(resolveDocsPath('/ai-script-proposals/abc-123')).toBe('/features/ai-script-authoring/');
  });
```

- [ ] **Step 4: Run the docsMapping test**

Run: `cd packages/shared && npx vitest run src/utils/docsMapping.test.ts`
Expected: PASS

- [ ] **Step 5: Rebuild the docs search index**

Run: `pnpm dlx tsx scripts/build-docs-index.ts`

- [ ] **Step 6: Build-verify the docs site**

Run: `cd apps/docs && npx astro build 2>&1 | tail -10`
Expected: build succeeds, no broken-link or frontmatter errors for the new page.

- [ ] **Step 7: Commit**

```bash
git add apps/docs/src/content/docs/features/ai-script-authoring.mdx scripts/docs-review/mapping.json packages/shared/src/utils/docsMapping.ts packages/shared/src/utils/docsMapping.test.ts apps/api/src/data/docsIndex.json
git commit -m "docs(ai-scripts): add the AI Script Authoring & Review feature page"
```

---

## Task 9: Update `ai.mdx`, `scripts.mdx`, `ai-agents.mdx`, `approval-security.mdx`

**Files:**
- Modify: `apps/docs/src/content/docs/features/ai.mdx`
- Modify: `apps/docs/src/content/docs/features/scripts.mdx`
- Modify: `apps/docs/src/content/docs/features/ai-agents.mdx`
- Modify: `apps/docs/src/content/docs/features/approval-security.mdx`

**Interfaces:**
- Produces: every existing doc page that references the tools, tables, or approval rules this feature touches now mentions it and links to Task 8's new page.

- [ ] **Step 1: Update `ai.mdx`'s Tier 3 tool table**

In `apps/docs/src/content/docs/features/ai.mdx` line 31 (the Tier 3 row of the tool-tier table), add the two new tools to the existing cell — change:

```
| **Tier 3** | Requires human approval before execution | `execute_command` (kill_process/start_service/stop_service/restart_service/file_read/list_services/event_logs_query), `run_script`, `disk_cleanup` (execute), ...
```

to:

```
| **Tier 3** | Requires human approval before execution | `execute_command` (kill_process/start_service/stop_service/restart_service/file_read/list_services/event_logs_query), `run_script` (including AI-authored proposals; see [AI Script Authoring & Review](/features/ai-script-authoring/)), `disk_cleanup` (execute), ...
```

Add `propose_script` and `get_script_proposal` to the **Tier 1** row (line 25 region, alongside the other read/inert tools):

```
..., `list_playbooks`, `get_playbook_history`, `get_vulnerability_report`, `get_device_vulnerabilities`, `search_documentation`, `propose_script`, `get_script_proposal`
```

Add one sentence to the "Six capabilities" intro list (near line 10-16) noting the new capability, and one short subsection right after the "AI Risk Engine" section header (before "### Tool tiers", so it reads as part of the AI Risk Engine's governed surface):

```md

### AI-authored scripts

The assistant and background agents can author a script mid-conversation, have it independently reviewed, and run it once you approve — see [AI Script Authoring & Review](/features/ai-script-authoring/) for the full walkthrough. The AI Risk Dashboard's **Script Proposals** panel tracks proposals per day, unattended runs, and how often a human's decision disagrees with the independent reviewer's recommendation.
```

- [ ] **Step 2: Update `scripts.mdx`**

In `apps/docs/src/content/docs/features/scripts.mdx`, extend the **Version history and rollback** section (line 121) with a short paragraph on provenance, and extend **Trigger Types** (line 205) with a note that AI-authored runs are marked. Add after the "### Version history and rollback" heading's existing content:

```md

Each script's detail page also shows a **Provenance panel**: whether it was written by a person, by the AI assistant (as a reviewed proposal), imported, or shipped as a system script, plus — for AI-authored scripts — the reviewer's summary, risk tier, and who approved it. The scripts list has a matching **Origin** column and filter, with a "Reviewed" / "Edited since review" badge; editing an AI-authored script by hand clears the review badge, since what was reviewed is no longer exactly what would run. See [AI Script Authoring & Review](/features/ai-script-authoring/).
```

- [ ] **Step 3: Update `ai-agents.mdx`**

In `apps/docs/src/content/docs/features/ai-agents.mdx`, extend the **Act mode** section (line 53) with a short paragraph:

```md

An agent in Act mode can also author a new script when nothing in your library fits, following the same independent review and approval flow as the chat assistant (or, if your partner and organization have both opted in, the [unattended lane](/features/ai-script-authoring/#the-unattended-lane) for narrow, low-risk cases). An agent never edits or approves its own proposal.
```

- [ ] **Step 4: Update `approval-security.mdx`**

In `apps/docs/src/content/docs/features/approval-security.mdx`, extend the **Risk tiers and assurance levels** section (line 20) with:

```md

An AI-authored script proposal's risk tier comes from its independent reviewer, floored by what the script actually touches (for example, any change to a firewall rule or a scheduled task is never rated below Medium, regardless of what the reviewer's model says). Low- and Medium-risk proposals follow the same-tech-can-approve rule above; High- and Critical-risk proposals always require four-eyes. A proposal that matched a strict security pattern additionally requires the approver to hold the Scripts permission and complete a fresh MFA check before they can approve it — see [AI Script Authoring & Review](/features/ai-script-authoring/#the-approval-card).
```

- [ ] **Step 5: Build-verify**

Run: `cd apps/docs && npx astro build 2>&1 | tail -10`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/docs/src/content/docs/features/ai.mdx apps/docs/src/content/docs/features/scripts.mdx apps/docs/src/content/docs/features/ai-agents.mdx apps/docs/src/content/docs/features/approval-security.mdx
git commit -m "docs(ai-scripts): cross-link AI script authoring from ai.mdx, scripts.mdx, ai-agents.mdx, approval-security.mdx"
```

---

## Task 10: Release-notes entry

**Files:**
- Modify: `docs/release-notes/next-release-draft.md`

**Interfaces:**
- Produces: the scratch entry `/release`'s Step 1 folds into the next GitHub Release body.

- [ ] **Step 1: Append the entry**

Add to `docs/release-notes/next-release-draft.md` (after the existing `---` under "Last release"):

```md

## AI script authoring — device activity and dashboard

- AI-authored script runs (proposed by the chat assistant or a background agent, reviewed, and approved) now appear on a device's Activity feed with an "AI" badge and a link to the originating proposal — closes #5022 for this path.
- The AI Risk Dashboard has a new **Script Proposals** panel: proposals per day, unattended-run counts, the unattended lane's open/closed state, and how often a human's approve/reject decision disagreed with the independent reviewer's recommendation.
- No new required environment variables; no migrations in this change.
```

- [ ] **Step 2: Commit**

```bash
git add docs/release-notes/next-release-draft.md
git commit -m "docs(release-notes): AI script authoring device activity and dashboard entry"
```

---

## Task 11 (ONE RELEASE AFTER W03 SHIPS): Remove the `BREEZE_AI_SCRIPT_AUTHORING_ENABLED` flag

**Do not start this task until the release that shipped W03's flag-on-by-default has gone out and been stable for at least one further release** — per CLAUDE.md's flag-removal convention and roadmap §2 ("W05 removes it"). This is deliberately the last task in this plan; do not merge it in the same PR wave as Tasks 1-10.

**Files:** determined by a repo-wide grep at execution time (the flag doesn't exist yet at plan-writing time — W01b introduces it). Known, contractually-guaranteed touch points per roadmap §2 and the precedent of the equivalent `BREEZE_AI_AGENTS_ENABLED` flag (`apps/api/src/config/env.ts:100`, `.env.example:1085`):
- `apps/api/src/config/env.ts` (or wherever W01b defines the `envFlag('BREEZE_AI_SCRIPT_AUTHORING_ENABLED', ...)` export)
- Every tool-registration gate that checks it (`propose_script` / `get_script_proposal` registration, and the `run_script { proposalId }` `feature_disabled` branch — roadmap §2)
- `.env.example` (and any per-app `.env.example` that mirrors it)
- Any test file that toggles it (mirrors `apps/api/src/config/env.policyDecideEnabled.test.ts`'s pattern for `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED`)
- This plan's own Task 8 doc page, if it documents the flag as configurable (it does not — re-check at execution time in case W03/W04 added flag documentation elsewhere, e.g. `apps/docs/src/content/docs/deploy/environment.mdx`)

**Interfaces:**
- Consumes: nothing new.
- Produces: the feature is always-on; `run_script { proposalId }` and the two authoring tools are unconditionally registered.

- [ ] **Step 1: Locate every reference**

Run: `grep -rn "BREEZE_AI_SCRIPT_AUTHORING_ENABLED" --include='*.ts' --include='*.tsx' --include='*.md' --include='*.mdx' --include='.env.example' .`

Record every file:line in the PR description before editing anything — this is the audit trail for what "removed" means here (mirrors the rigor CLAUDE.md applies to cascade-list greps).

- [ ] **Step 2: Remove the gate at each tool-registration call site**

For each `if (config.aiScriptAuthoringEnabled) { ... }` (or equivalent) guarding `propose_script` / `get_script_proposal` registration or the `run_script` `feature_disabled` check, delete the conditional and keep only the always-on branch. Update or delete any test that asserted the `feature_disabled` behavior when the flag was off (search test files from Step 1's grep).

- [ ] **Step 3: Remove the flag definition**

Delete the `envFlag('BREEZE_AI_SCRIPT_AUTHORING_ENABLED', ...)` export from `apps/api/src/config/env.ts` (or wherever it lives) and its own unit test file, if one exists (mirror: `apps/api/src/config/env.policyDecideEnabled.test.ts` would be deleted if this flag got an equivalent file).

- [ ] **Step 4: Remove from `.env.example`**

Delete the flag's line(s) and any surrounding comment block from `.env.example` (and any other `.env.example` files Step 1 found it in) — mirror how `BREEZE_AI_AGENTS_ENABLED` appears at `.env.example:1085` for the comment style to match/remove.

- [ ] **Step 5: Run the affected test suites**

Run: `cd apps/api && npx vitest run src/routes/scriptProposals.test.ts src/services/aiToolsScriptProposals.test.ts src/config/env.test.ts` (adjust file names to whatever Step 1's grep actually found — W01b/W02/W03 own the exact file names for the flag-gated tests).
Expected: PASS — every remaining test exercises the always-on behavior.

- [ ] **Step 6: Full affected-area regression**

Run: `cd apps/api && npx vitest run src/services/aiToolsScriptProposals.test.ts src/routes/ai.ts` and the web equivalent for any UI that read the flag (none identified as of this plan; re-check at execution time).
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore(ai-scripts): remove BREEZE_AI_SCRIPT_AUTHORING_ENABLED — feature always on"
```

---

## Self-Review Notes

**Spec coverage.** §4.9's three bullets are each covered: device activity → Tasks 1 and 3; `AiRiskDashboard` metrics (perDay, unattendedRuns, laneState, reviewerDisagreements) → Tasks 4-7; library provenance UI (Origin column, Provenance panel) is **out of scope for this wave** — it is explicitly assigned to W03 in the roadmap wave table ("library provenance UI" under W03), not W05; Task 9's `scripts.mdx` update documents it without re-implementing it. §8's W05 row items (device activity, dashboard metrics, docs, flag removal) are each a task. The flag-removal Global Constraint ("W05 removes it") is Task 11.

**Roadmap/spec tension resolved in this plan, flagged for the caller:** the roadmap (§3.7) says the device activity feed "reads `script_executions` snapshot columns (no proposal join)," but the actual `DeviceActivityFeed.tsx` / `GET /devices/:id/events` architecture (verified: `apps/api/src/routes/devices/events.ts`) is entirely `audit_logs`-driven with no read path onto `script_executions` at all, and its comments document a hard-won, index-specific performance architecture (a 90s-mean/13-minute-worst-case incident) that a new query arm would need to extend. This plan reconciles the two by writing the snapshot values into a **new `audit_logs` row's `details`** at dispatch time (Task 1) — literally sourced from `script_executions`' snapshot columns, with zero read-time join to `script_proposals`, and zero new query arm added to the existing feed. This satisfies the roadmap's letter ("no proposal join") without contradicting its own established read architecture. Flagging this as an inferred design decision rather than a literal transcription of §3.7, since the roadmap does not spell out the mechanism.

**Assumption flagged:** the roadmap's cross-wave contract (§3.1-§3.6) does not specify a web route/page for viewing a single proposal's detail outside of the (pending-only) approvals inbox, even though spec §4.9 implies one exists for the Scripts-list Provenance panel's "proposal link." This plan builds a minimal one in Task 2 (`/ai-script-proposals/:proposalId`) since Task 3's device-activity link needs a stable target regardless. If W03 already shipped an equivalent page under a different path, Task 2's implementer should grep `apps/web/src/pages` for an existing script-proposal route before adding a duplicate, and point Task 3's link at that instead.

**Assumption flagged:** the "human decision" side of the reviewer-disagreement metric (Task 4) is inferred as `script_proposals.decided_by IS NOT NULL`, reasoning by analogy from `action_intents.decided_by_user_id: null` on an unattended-lane grant (spec §4.6) — the spec does not state explicitly whether `script_proposals.decided_by` is left null or backfilled for an autonomously-granted proposal. If W04 sets it, Task 4/6's disagreement query would need `AND sp.decided_by <> '<system-actor-uuid>'` instead — flag this for verification against the real W04 code before Task 4 ships.

**Placeholder scan:** no "TBD"/"add error handling"/"similar to Task N" language; every step has runnable code or an exact shell command. Task 11 cannot cite exact file:line (the flag doesn't exist yet at plan-writing time) — this is treated as an investigative-but-mechanical task (grep-and-remove), consistent with it depending on wave output that postdates this plan, and it names the exact precedent flag/file (`BREEZE_AI_AGENTS_ENABLED`, `apps/api/src/config/env.ts:100`, `.env.example:1085`) as the template.

**Type/name consistency check:** `ai.script.executed` (Task 1's audit action) is used identically in Task 1's write, Task 1's `actionLabels` entry, and Task 3's `ACTION_RULES` prefix and test fixtures. `ScriptProposalsMetrics` (Task 5) matches the wire shape Task 4 produces and Task 6 extends — verified field names (`perDay`, `reviewerDisagreements.humanRejectedAfterApprove`/`humanApprovedAfterReject`, `unattendedRuns`, `laneState`) are identical across Tasks 4, 5, 6, 7. `/ai-script-proposals/:proposalId` (Task 2's route) matches the href Task 3 constructs (`/ai-script-proposals/${e.details.proposalId}`).
