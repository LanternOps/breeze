---
tracking_issue: LanternOps/breeze#5650
---
# Fleet Designer W05: Scheduled Drift, Impact Counter, Documents Hand-off — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A scheduled design that follows an applied one reports drift between the approved design and the live fleet, never re-applies; the Impact scorecard counts delivered designs; when the org documents library exists, the design PDF is filed there.

**Architecture:** Drift is computed deterministically by the server, not the model: the evidence assembler loads the latest applied design's ledger for the org (`fleet_design_applied_items` + the policies/watches/rules it created) and the finaliser diffs it against the live configuration into `summary.fleetDesign.drift = { missing[], extra[], changed[] }`; the prompt also shows the approved design so the model's `retired` section reads as drift. `fleetDesignsDelivered` follows `narrativesDelivered`'s six-site treatment (shared key, daily column + CHECK, migration, rollup CTE, DTO, PDF label). The documents hand-off is conditional on `apps/api/src/db/schema/orgDocuments.ts` existing on main at execution time (deliverables W03); otherwise the task records a roadmap item and stops.

**Tech Stack:** TypeScript, Drizzle, SQL migration, Vitest, React.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-11-fleet-designer-agent-design.md` §4.4 (org_documents), §4.12 (drift), §2 "narrativesDelivered", §4.15 W05.

## Global Constraints

- Migration `2026-10-15-180400-ai-agent-impact-fleet-designs.sql`: `ALTER TABLE ai_agent_impact_daily ADD COLUMN IF NOT EXISTS fleet_designs_delivered integer NOT NULL DEFAULT 0;` + `DROP CONSTRAINT IF EXISTS … ; ADD CONSTRAINT ai_agent_impact_daily_fleet_designs_chk CHECK (fleet_designs_delivered >= 0)`. DDL only. `ai_agent_impact_daily` is an org-cascade table → export policy entry gains the column (`included`).
- A scheduled design run never applies anything (nothing in the run loop can reach the apply service; the contract test in W01 already proves the profile's reachable tools).
- Tests as in the earlier waves; whole unit suite before the PR.
- Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Branch `feature/5650-fleet-designer/wave-5655`; PR body `Closes #5655`. `get_feature_status` first.

---

## File Structure

| Path | Responsibility |
|---|---|
| `apps/api/src/services/fleetDesign/drift.ts` (+ `.test.ts`) | `loadApprovedDesign(orgId)`, `computeDrift(approved, live)` (Task 1) |
| `apps/api/src/services/aiAgents/designEvidence.ts`, `runnerPrompt.ts`, `fleetDesignReport.ts`, `runFinalizers.ts` | approved design in evidence + prompt; drift stored on the summary (Task 1) |
| `packages/shared/src/types/fleetDesign.ts`, `reportPdf/reportPdf.ts`; `apps/web/src/components/fleetDesign/FleetDesignViewer.tsx` | drift block rendering (Task 1) |
| `packages/shared/src/types/aiAgentImpact.ts:15-19`, `apps/api/src/db/schema/aiAgentImpactDaily.ts`, migration, `impactRollup.ts:282-337`, `impactQuery.ts:81,144`, `tenantExportPolicyRegistry.ts`, `apps/web/src/components/aiAgents/ImpactPage.tsx:159-194`, locales | `fleetDesignsDelivered` (Task 2) |
| `apps/api/src/services/fleetDesign/documents.ts` (+ test) or a roadmap item | org_documents hand-off (Task 3) |

---

### Task 1: Drift

**Files:**
- Create: `apps/api/src/services/fleetDesign/drift.ts`, `apps/api/src/services/fleetDesign/drift.test.ts`
- Modify: `designEvidence.ts` (`DesignEvidence.approvedDesign: ApprovedDesignSummary | null`, loaded by `loadApprovedDesign`), `runnerPrompt.ts` (render the approved design's functions/watches/rules under `## Approved design (applied <date>)` and change the `retired` guidance to *"drift: rules and watches live today that the approved design does not carry, and approved ones that are missing"* when present), `fleetDesignReport.ts` (`summary.fleetDesign.drift`), `runFinalizers.ts` (compute drift before persisting), `packages/shared/src/types/fleetDesign.ts` (`FleetDesignDrift`, `FleetDesignReportSummary.fleetDesign.drift?`), `reportPdf.ts` (a "Drift since the approved design" section rendered first when present), `FleetDesignViewer.tsx` (drift banner + table)

**Interfaces:**
```ts
export interface ApprovedDesignSummary { reportRunId: string; appliedAt: string; functions: { functionKey: string; groupId: string; policyId: string; deviceIds: string[]; watches: { watchType; name; enabled: boolean }[]; rules: { name; severity; cooldownMinutes }[] }[] }
export interface FleetDesignDrift { approvedReportRunId: string; missing: { functionKey; kind: 'watch' | 'rule' | 'assignment' | 'group_member'; name: string }[]; extra: { policyId; policyName; kind: 'watch' | 'rule'; name: string; deviceCount: number }[]; changed: { functionKey; kind; name; field: string; approved: string; live: string }[] }
export async function loadApprovedDesign(orgId: string): Promise<ApprovedDesignSummary | null>   // latest report run for the org with ≥1 `applied` ledger row of kind `policy`, not rolled back
export function computeDrift(approved: ApprovedDesignSummary, live: DesignEvidence['configuration'] & { groupMembers: Record<string, string[]> }): FleetDesignDrift
```

- [ ] **Step 1: Failing tests** — `computeDrift` fixtures: a watch disabled by hand → `changed` (`enabled: true → false`); a rule deleted → `missing`; a hand-added rule on another org policy → `extra`; a device removed from the function group → `missing group_member`; identical → all empty. `loadApprovedDesign` ignores rolled-back ledger rows and picks the newest applied run.
- [ ] **Step 2: Implement**; in `finalizeFleetDesign` pass `drift = ctx.design.evidence.approvedDesign ? computeDrift(...) : null` into `persistFleetDesignReport` (add `drift?: FleetDesignDrift | null` to its input and summary). Render: PDF section + web banner ("Drift since the design applied on <date>: N missing, N extra, N changed") with a table.
- [ ] **Step 3: Integration case** in `aiAgentFleetDesign.integration.test.ts`: apply a design (W03 services), disable one created watch by hand, run `loadDesignEvidence` + `computeDrift` → one `changed` row; then a scheduled design run persists `summary.fleetDesign.drift` and creates no ledger rows and no policies.
- [ ] **Step 4: Commit**

```bash
git add apps/api/src packages/shared/src apps/web/src
git commit -m "feat(ai): fleet design drift against the approved design"
```

### Task 2: `fleetDesignsDelivered` impact counter

**Files:**
- Modify: `packages/shared/src/types/aiAgentImpact.ts:15-19` (append `'fleetDesignsDelivered'`), `apps/api/src/db/schema/aiAgentImpactDaily.ts:35,55` (column + check), create `apps/api/migrations/2026-10-15-180400-ai-agent-impact-fleet-designs.sql`, `apps/api/src/services/impactRollup.ts:282-337` (a `designs` CTE mirroring `narratives` with `r.profile = 'design' AND r.status = 'completed' AND r.report_run_id IS NOT NULL`, joined and upserted), `impactQuery.ts:81,144`, `tenantExportPolicyRegistry.ts` (`ai_agent_impact_daily` entry), `apps/web/src/components/aiAgents/ImpactPage.tsx:169-194` (`counterMetricLabel` case) and the weight-label switch (:159-160) if a weight key exists for it, locales (`aiAgentsPage.impact.pdf.metrics.fleetDesignsDelivered`, `aiAgentsPage.impact.weightLabels.fleetDesignDelivered`)
- Tests: `impactRollup.test.ts`, `impactQuery.test.ts`, `aiAgentImpactDaily` schema test if any, `ImpactPage.test.tsx`, export-policy unit test

- [ ] **Step 1: Failing tests** — rollup upsert includes `fleet_designs_delivered = EXCLUDED.fleet_designs_delivered`; DTO totals include the key; PDF metrics table has a row for it.
- [ ] **Step 2: Implement** (six sites, per the narrative precedent; no page tile, matching `narrativesDelivered`).
- [ ] **Step 3: Run** unit tests, `pnpm db:check-drift`, the integration `impactRollup` suite if one exists, and the export-policy integration suite on the test stack.
- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types/aiAgentImpact.ts apps/api/src/db/schema/aiAgentImpactDaily.ts apps/api/migrations/2026-10-15-180400-ai-agent-impact-fleet-designs.sql apps/api/src/services/impactRollup.ts apps/api/src/services/impactQuery.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/web/src
git commit -m "feat(ai): fleetDesignsDelivered impact counter"
```

### Task 3: Org documents hand-off (conditional)

- [ ] **Step 1: Check the precondition**

Run: `test -f apps/api/src/db/schema/orgDocuments.ts && echo present || echo absent` on a branch rebased onto current `main`.

- [ ] **Step 2a (present):** Create `apps/api/src/services/fleetDesign/documents.ts` exporting `fileFleetDesignDocument({ orgId, reportRunId, userId })`: render the PDF server-side with `buildReportPdf([], { reportType: 'ai_fleet_design', … summary })` → `doc.output('arraybuffer')`, store it through the deliverables W03 document service (`createOrgDocument` — read its signature in `services/orgDocuments*.ts`) with `category: 'baseline'`, title `Fleet Design — <org> — <date>`, and attach it as deliverable evidence if a "quarterly configuration audit" deliverable exists for the org (the W02 `serviceDeliverableService` evidence API). Call it from the Fleet Design page's "File as document" button (`runAction`) and from `finalizeFleetDesign` for scheduled runs only (manual runs are filed by the technician). Tests: unit (mocks) + one integration case (document row exists, evidence linked). Commit `feat(ai): file fleet design PDFs in the org documents library`.

- [ ] **Step 2b (absent):** Call `add_roadmap_item` (feature-lifecycle) with title "Fleet Design: file the design PDF in org_documents as deliverable evidence (blocked on deliverables W03)" and note in the PR body that Task 3 was skipped for that reason. No code.

- [ ] **Step 3: PR**

Before the PR: `cd apps/api && npx vitest run`; the integration suites touched (`aiAgentFleetDesign`, `fleetDesignApply`, export policy); `pnpm db:check-drift`. `Closes #5655`. After merge: `complete_wave`, then `close_feature` once W04 has also landed.
