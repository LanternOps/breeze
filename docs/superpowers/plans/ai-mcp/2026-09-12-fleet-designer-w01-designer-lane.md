---
tracking_issue: LanternOps/breeze#5650
---
# Fleet Designer W01: The Designer Lane — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A technician (or a quarterly schedule) runs a Fleet Design for one organization and gets a stored, PDF-renderable report with eight fixed sections; nothing on the fleet changes.

**Architecture:** A fourth `ai_agents` kind `designer`, a fifth run profile `design`, and a third schedule kind `design`, all on the narrative lane's pattern: the system assembles a bounded evidence bundle (`designEvidence.ts`) before the model runs, the model has a small read-only drill-down floor (`designProfile.ts`) plus one outcome tool `submit_fleet_design` that validates the section contract inside the tool (so the model retries a bad payload), and `finalizeFleetDesign` persists one `reports` definition per org plus one `report_runs` artifact per run (`fleetDesignReport.ts`), linked through `ai_agent_runs.report_run_id`. Manual runs start through a new `POST /ai/fleet-design/runs`; scheduled runs fan out from the existing sweep scheduler. The web gets the `designer` kind card (modes `off|act` only), a run-detail section, the reports-list entry, and a PDF render arm.

**Tech Stack:** TypeScript, Hono, Drizzle, BullMQ, Claude Agent SDK MCP tools, Zod, jsPDF (`packages/shared/reportPdf`), Vitest, React + Astro + react-i18next (8 locales).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-11-fleet-designer-agent-design.md` §4.1–4.4, §4.10 (run trigger, list, detail), §4.12, §4.13, §4.14, and the amendments listed in `docs/superpowers/plans/ai-mcp/2026-09-12-fleet-designer.md` ("Spec amendments"), which Task 0 folds into the spec.

## Global Constraints

- Tests: `cd apps/api && npx vitest run <path>`; shared: `cd packages/shared && npx vitest run <path>`; web: `cd apps/web && npx vitest run <path>` plus `src/lib/i18n/localeParity.test.ts`, `src/lib/i18n/translationCoverage.test.ts`, `src/lib/__tests__/no-silent-mutations.test.ts`, `src/components/layout/Sidebar.nav.test.tsx`. Add `--pool=threads --maxWorkers=2` when a dev stack is running. Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`; web `npx astro check`; `pnpm lint` in every touched package. Before the PR: `cd apps/api && npx vitest run` (the whole unit suite — fixer touched-file sweeps miss Test API contracts).
- Two migrations, idempotent, no inner `BEGIN`/`COMMIT`, DDL only (no `breeze.scope` election needed): `2026-10-15-180000-report-type-ai-fleet-design.sql` containing ONLY `ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'ai_fleet_design';`, then `2026-10-15-180100-ai-agents-fleet-designer.sql` for everything else. The enum label is uncommitted until the first file's transaction commits, so nothing in file B may be in file A. Re-check `ls apps/api/migrations/*.sql | sort | tail -1` before every commit; rename upward if main moved past.
- Column adds on org-cascade tables fire the export-policy contract; this wave adds no columns (CHECK widenings and one partial index only).
- Policy snapshot `AI_AGENT_POLICY_SNAPSHOT_VERSION` 9 → 10 (`maxConcurrentDesignRuns`, `maxDesignRunsPerDay`, `designBudgetCentsPerRun`, `designMaxTurns`); every read site tolerates 1–10 via `?? AI_AGENT_LIMIT_DEFAULTS.x`; every new limit gets a 4-line entry in the `runService.ts:38-131` enforcement inventory.
- No `'design'` / `isDesignProfile` / `DESIGN_` literal inside `aiGuardrails.ts`, `executionLedger.ts`, `policyDecide.ts`, `actRevalidation.ts` (`verdictProfile.contract.test.ts` extended). `STREAK_NEUTRAL_PROFILES` in `agentCircuit.ts` has NO compile-time guard — Task 5 adds the member by hand and tests it.
- Design runs are device-less and read-only. The floor is `DESIGN_TOOL_ALLOWLIST` + `submit_fleet_design`; `maxActionsPerRun` is 0; no intents, no fix-watch. Success is circuit-neutral; genuine runner failures still increment.
- Evidence loaders (D6 of the narrative plan applies verbatim): every statement predicates its primary AND joined tenant-bearing tables by `orgId`; system context bypasses RLS; per-loader failure isolation via the `settled()` idiom; the byte ceiling is enforced over the entire UTF-8 serialized bundle. Never project alert messages, ticket bodies, script contents (only names, tags, purpose, first 200 chars of `description`), backup error logs, or raw jsonb. Sanitize operator-authored names with the `sanitizeSweepText` idiom (≤ 256 chars, `\p{C}` stripped).
- Report rows written by the system stamp `execution_scope_principal_kind = 'system'`, `requested_by_kind = 'system'`, user ids NULL — through `persistedSystemSiteScopeValues(systemReportAuthority(orgId))`, exactly as `narrativeReport.ts` does.
- Model output contract: `submit_fleet_design` takes `FleetDesignSubmission`; every section key appears exactly once; `rationale` is required (min 1 char) on every watch and rule; `functionKey` must be in `DEVICE_FUNCTION_KEYS` or match `custom:[a-z0-9-]{2,40}` with a `label`; every `deviceIds` entry must be in the evidence bundle's device id set; a device may appear in at most one `functions` entry; `confidence` in `functions` ≥ `FLEET_DESIGN_CONFIDENCE_THRESHOLD`, below it belongs in `unsure`. `baseline` is server-computed; the model submits only `baseline.notes`.
- DTO rule: additive nullable field `AiAgentRunDetailDto.fleetDesign` → no `AI_AGENT_RUN_DTO_SCHEMA_VERSION` bump.
- Web mutations go through `runAction` with an inline request thunk. New i18n keys in all 8 locales (`apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/`), real translations.
- Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Branch `feature/5650-fleet-designer/wave-5651`; PR body `Closes #5651`. `get_feature_status` before starting.

---

## File Structure

| Path | Responsibility |
|---|---|
| spec §4.1, 4.2, 4.3, 4.8, 4.9, 4.10, 4.12, 4.13 (modify) | Amendments (Task 0). |
| `packages/shared/src/validators/deviceFunctions.ts` (+ `.test.ts`) | `DEVICE_FUNCTION_KEYS` SSOT, `isDeviceFunctionKey`, `parseFunctionKey` (Task 1). |
| `packages/shared/src/types/fleetDesign.ts`, `validators/fleetDesign.ts` (+ `.test.ts`), barrels | Section keys/titles, thresholds, `FleetDesignSubmission`/`FleetDesignOutcome`/`FleetDesignReportSummary`/`AiAgentRunFleetDesignDto`, `fleetDesignSubmissionSchema`, `fleetDesignOutcomeFromSubmission`, `renderFleetDesignMarkdown` (Task 1). |
| `packages/shared/src/types/aiAgents.ts`, `validators/aiAgents.ts`, `types/aiAgentSchedules.ts`, `validators/aiAgentSchedules.ts`, `types/aiAgentRuns.ts` | Kind, profile, schedule kind, limits v10, mode rule, `isMonthlyOrRarerLiteralCron`, DTO field (Task 2). |
| `apps/api/migrations/2026-10-15-180000-…`, `…-180100-…` | Enum add; CHECK widenings; `reports_ai_fleet_design_org_uniq` (Task 3). |
| `apps/api/src/db/schema/reports.ts` (modify); `apps/api/src/services/orgMergeCustomExecutors.ts` (modify) | Enum value; third reports dedupe pass (Task 4). |
| `apps/api/src/services/aiAgents/designProfile.ts` (new), `runService.ts`, `agentCircuit.ts`, `agentToolCatalog.ts`, `scheduleService.ts`, `routes/aiAgents.ts` (mode rule), contract tests | Profile floor + limits; window-based admission caps; circuit; presets; schedule kind → agent kind; designer modes (Task 5). |
| `apps/api/src/services/aiAgents/designEvidence.ts` (+ `.test.ts`) | Bounded evidence bundle (Task 6). |
| `apps/api/src/services/aiAgents/outcomeTools.ts`, `runLoopTypes.ts`, `runLoop.ts`, `runnerPrompt.ts` | `submit_fleet_design`, run context, floor wiring, prompt (Task 7). |
| `apps/api/src/services/aiAgents/fleetDesignReport.ts` (new), `runFinalizers.ts`, `reportGenerationService.ts`, `routes/reports/schemas.ts`, `jobs/reportScheduleWorker.ts` | Persistence; stored-artifact-only plumbing (Task 8). |
| `apps/api/src/services/aiAgents/runTrace.ts`, `runFinishedNotify.ts`, `routes/aiAgents.ts` | Projection; notification (Task 9). |
| `apps/api/src/jobs/aiAgentSweepScheduler.ts`, `services/aiAgents/scheduleService.ts`, `routes/aiAgentSchedules.ts` | `design` schedule fan-out (Task 10). |
| `packages/shared/src/reportPdf/reportPdf.ts` | `ai_fleet_design` label + render arm (Task 11). |
| `apps/api/src/routes/fleetDesign.ts` (+ `.test.ts`), `apps/api/src/index.ts` | `POST /ai/fleet-design/runs`, `GET /ai/fleet-design`, `GET /ai/fleet-design/:reportRunId` (Task 12). |
| `apps/api/src/__tests__/integration/aiAgentFleetDesign.integration.test.ts` | Persist → rows → link → erasure; schedule fan-out (Task 13). |
| Web: `PurposeStep.tsx`, `ModeChoice.tsx`, `AiAgentForm.tsx`, `CapabilityPicker.tsx`, `AiAgentSchedulesSection.tsx`, `RunsListPage.tsx`, `RunDetailPage.tsx`, `ReportsList.tsx`, `ReportBuilder.tsx`, locales | Kind card, modes, always-on note, schedule kind, badges, detail section, reports entry (Task 14). |

---

### Task 0: Spec amendments

**Files:**
- Modify: `docs/superpowers/specs/ai-mcp/2026-09-11-fleet-designer-agent-design.md`

- [ ] **Step 1: Apply the amendments**

Edit the spec in place:
- §4.1 "Manual trigger": replace the sentence with: *Manual trigger: `POST /ai/fleet-design/runs` with `{ orgId, siteId? }` (the existing `POST /ai/agents/:id/runs` body is `{ deviceId }` only and stays that way); the route resolves the org's effective `designer` agent and calls `createAndEnqueueAgentRun` with `profile: 'design'`.* Add: *A `design` schedule must target a partner-wide `designer` agent (`scheduleService.assertPartnerWideScheduledAgent`); sweep and narrative keep requiring `triage`.* Replace `maxDesignRunsPerDay` wording with *enforced at admission rule 6b over a 24-hour window (`profileCaps` gains `windowMs`)*.
- §4.2 "Outcome tool": replace "fails the run on a contract violation, like `submit_narrative`" with *validates structurally AND referentially inside the tool and throws, so the model retries within its turn budget (there is no run-level contract-violation code); a run that ends without a valid submission completes with `error_code = 'design_missing'` and no report.*
- §4.3 item 3: replace `templateId | inlineConditions` with *`conditions: AlertRuleCondition[]` (the `alertRuleItemSchema` shape; `config_policy_alert_rules` is inline-only). `sourceTemplateId?` cites an `alert_templates` row for provenance. `action` and `paging` are advisory fields rendered in the report and appended to the stored `rationale` at apply time; alert rules have no binding column for them (roadmap).* Item 7: *thresholds are frozen defaults (`FLEET_DESIGN_PRECURSOR_THRESHOLDS`) snapshotted into the report; partner tuning is a roadmap item.* Add after the list: *The `baseline` numbers are computed by the evidence assembler; the model submits `baseline.notes` only.*
- §4.4: replace "source schedule id when scheduled" with *one definition per org, keyed by `(org_id) WHERE type = 'ai_fleet_design'` (partial unique index); `source_ai_agent_schedule_id` is set when the first run was scheduled.*
- §4.5: add *The `DEVICE_FUNCTION_KEYS` SSOT lands in W01 because the section contract validates against it.*
- §4.8: replace "Idempotent per `(reportRunId, itemRef)`" sentence with *Idempotency and rollback state live in `fleet_design_applied_items` (W03), not in `report_runs.result`.* Replace "with a priority below any manually created policy" with *at priority 100 with NULL role and OS filters; a device-group assignment out-ranks site, organization and partner assignments for the same feature type regardless of priority, so the apply preview lists every policy the new one would displace and the technician approves each displacement.*
- §4.9: replace the chunking paragraph with *v1: the evidence assembler takes at most `DESIGN_EVIDENCE_MAX_DEVICES` (2,000) devices; a manual run may be scoped to one site (`siteId`); devices beyond the bound are listed in `unsure` as not assessed. Multi-chunk assembly is deferred (§7).*
- §4.12: `budget_exhausted` → `budget_exceeded`.
- §4.13: replace the first sentence of the second bullet with *Contract violations are thrown inside `submit_fleet_design` and retried by the model; a run that never submits validly gets `design_missing`.*
- §5 status line: *Advisor quorum convened 2026-09-12 (Codex gpt-6-astra xhigh): D1 agree with amendments (ledger table, before-images); D3 agree with amendments (displacement preview, NULL filters, persisted group ids); D4 agree with amendments (`repoint` merge policy, `(run_id, org_id)` FK, `CHECK (confidence BETWEEN 0 AND 1)`, NULL confidence for manual rows, user attribution).*
- §4.11: `leave-for-erasure` → `repoint`.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/ai-mcp/2026-09-11-fleet-designer-agent-design.md
git commit -m "docs(ai): fleet designer spec amendments from plan verification and quorum"
```

### Task 1: Shared contract — device function SSOT, section types, validator, markdown

**Files:**
- Create: `packages/shared/src/validators/deviceFunctions.ts`, `packages/shared/src/validators/deviceFunctions.test.ts`
- Create: `packages/shared/src/types/fleetDesign.ts`, `packages/shared/src/validators/fleetDesign.ts`, `packages/shared/src/validators/fleetDesign.test.ts`
- Modify: `packages/shared/src/types/index.ts` (add `export * from './fleetDesign';` after the `./orgNarrativeReport` line at :811), `packages/shared/src/validators/index.ts` (add `export * from './deviceFunctions';` after `./deviceRoles` at :37 and `export * from './fleetDesign';` after `./orgNarrative` at :1154)

**Interfaces:**
- Produces: `DEVICE_FUNCTION_KEYS`, `DeviceFunctionKey`, `isDeviceFunctionKey(key)`, `parseFunctionKey(key): { kind: 'known', key } | { kind: 'custom', slug } | null`; `FLEET_DESIGN_SECTION_KEYS`, `FLEET_DESIGN_SECTION_TITLES`, `FLEET_DESIGN_CONFIDENCE_THRESHOLD`, `FLEET_DESIGN_PRECURSOR_THRESHOLDS`, `FLEET_DESIGN_SCHEMA_VERSION`; types `FleetDesignSubmission`, `FleetDesignOutcome`, `FleetDesignBaselineNumbers`, `FleetDesignReportSummary`, `AiAgentRunFleetDesignDto`, `FleetDesignFunctionEntry`, `FleetDesignMonitoringEntry`, `FleetDesignWatch`, `FleetDesignRule`, `FleetDesignRetiredItem`, `FleetDesignAutomationEntry`, `FleetDesignLegacyItem`, `FleetDesignRoleCorrection`; `fleetDesignSubmissionSchema`, `fleetDesignOutcomeFromSubmission(submission, refs)`, `renderFleetDesignMarkdown(outcome)`.

- [ ] **Step 1: Write the failing tests**

`packages/shared/src/validators/deviceFunctions.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { DEVICE_FUNCTION_KEYS, isDeviceFunctionKey, parseFunctionKey } from './deviceFunctions';

describe('device function SSOT', () => {
  it('lists the v1 functions with unknown last', () => {
    expect(DEVICE_FUNCTION_KEYS[0]).toBe('domain_controller');
    expect(DEVICE_FUNCTION_KEYS[DEVICE_FUNCTION_KEYS.length - 1]).toBe('unknown');
    expect(new Set(DEVICE_FUNCTION_KEYS).size).toBe(DEVICE_FUNCTION_KEYS.length);
  });
  it('accepts known keys and custom slugs, rejects the rest', () => {
    expect(isDeviceFunctionKey('file_server')).toBe(true);
    expect(isDeviceFunctionKey('custom:pos-terminal')).toBe(false);
    expect(parseFunctionKey('file_server')).toEqual({ kind: 'known', key: 'file_server' });
    expect(parseFunctionKey('custom:pos-terminal')).toEqual({ kind: 'custom', slug: 'pos-terminal' });
    expect(parseFunctionKey('custom:P')).toBeNull();
    expect(parseFunctionKey('custom:has space')).toBeNull();
    expect(parseFunctionKey('nonsense')).toBeNull();
  });
});
```

`packages/shared/src/validators/fleetDesign.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  fleetDesignSubmissionSchema,
  fleetDesignOutcomeFromSubmission,
  renderFleetDesignMarkdown,
} from './fleetDesign';
import { FLEET_DESIGN_SECTION_KEYS, FLEET_DESIGN_CONFIDENCE_THRESHOLD } from '../types/fleetDesign';

const D1 = '11111111-1111-4111-8111-111111111111';
const D2 = '22222222-2222-4222-8222-222222222222';

function validSubmission() {
  return {
    found: {
      summary: ['12 devices across 2 sites.'],
      findings: [{ title: 'Shared local admin on 4 workstations', deviceCount: 4, evidence: ['posture:localAdmin'] }],
    },
    functions: [
      { functionKey: 'file_server', deviceIds: [D1], confidence: 0.9, evidence: ['SMB listener; 2 TB data volume'] },
    ],
    monitoring: [
      {
        functionKey: 'file_server',
        watches: [{ watchType: 'service', name: 'LanmanServer', alertOnStop: true, autoRestart: true, rationale: 'SMB is the function.' }],
        alertRules: [{
          name: 'File server disk over 85%', severity: 'high',
          conditions: [{ type: 'metric', metric: 'disk_usage', operator: 'gt', threshold: 85, durationMinutes: 15 }],
          cooldownMinutes: 60, rationale: 'Data volume growth is the failure mode.', action: 'none', paging: 'business_hours',
        }],
      },
    ],
    retired: [],
    automation: [{ functionKey: 'file_server', playbooks: [{ builtInName: 'Restart stopped service' }], scripts: [] }],
    legacy: [],
    baseline: { notes: ['Alert rate is dominated by disk warnings.'] },
    unsure: {
      lowConfidenceFunctions: [{ functionKey: 'kiosk', deviceIds: [D2], confidence: 0.4, evidence: ['single logon user'] }],
      unreachableDevices: [], needsHuman: [], roleCorrections: [],
    },
  };
}

const refs = {
  deviceIds: new Set([D1, D2]),
  baseline: { alertsPer100EndpointsPerMonth: 42, ticketsPerMonth: 7, precursors: [{ condition: 'disk_used_over_threshold', deviceCount: 3 }] },
  generatedAt: '2026-09-12T00:00:00.000Z',
};

describe('fleetDesignSubmissionSchema', () => {
  it('accepts a valid submission', () => {
    expect(fleetDesignSubmissionSchema.safeParse(validSubmission()).success).toBe(true);
  });
  it('rejects a watch without a rationale, naming the path', () => {
    const s = validSubmission();
    (s.monitoring[0]!.watches[0] as { rationale?: string }).rationale = '';
    const r = fleetDesignSubmissionSchema.safeParse(s);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error!.issues[0]!.path)).toContain('rationale');
  });
  it('rejects a function below the confidence threshold', () => {
    const s = validSubmission();
    s.functions[0]!.confidence = FLEET_DESIGN_CONFIDENCE_THRESHOLD - 0.01;
    expect(fleetDesignSubmissionSchema.safeParse(s).success).toBe(false);
  });
  it('rejects an unknown function key and accepts a labelled custom key', () => {
    const s = validSubmission();
    s.functions[0]!.functionKey = 'toaster';
    expect(fleetDesignSubmissionSchema.safeParse(s).success).toBe(false);
    const c = validSubmission();
    c.functions[0]!.functionKey = 'custom:pos-terminal';
    expect(fleetDesignSubmissionSchema.safeParse(c).success).toBe(false); // label missing
    (c.functions[0] as { label?: string }).label = 'POS terminal';
    expect(fleetDesignSubmissionSchema.safeParse(c).success).toBe(true);
  });
  it('rejects a device in two functions', () => {
    const s = validSubmission();
    s.functions.push({ functionKey: 'print_server', deviceIds: [D1], confidence: 0.8, evidence: ['spooler'] });
    expect(fleetDesignSubmissionSchema.safeParse(s).success).toBe(false);
  });
});

describe('fleetDesignOutcomeFromSubmission', () => {
  it('rejects a device id that is not in the evidence', () => {
    const s = validSubmission();
    s.functions[0]!.deviceIds = ['33333333-3333-4333-8333-333333333333'];
    expect(() => fleetDesignOutcomeFromSubmission(s, refs)).toThrow(/functions\[0\]\.deviceIds\[0\]/);
  });
  it('builds the outcome with every section exactly once, item refs, thresholds and baseline numbers', () => {
    const o = fleetDesignOutcomeFromSubmission(validSubmission(), refs);
    expect(o.schemaVersion).toBe(1);
    expect(Object.keys(o.sections)).toEqual([...FLEET_DESIGN_SECTION_KEYS]);
    expect(o.sections.functions[0]!.itemRef).toBe('functions:file_server');
    expect(o.sections.monitoring[0]!.watches[0]!.itemRef).toBe('monitoring:file_server:watch:0');
    expect(o.sections.monitoring[0]!.alertRules[0]!.itemRef).toBe('monitoring:file_server:rule:0');
    expect(o.sections.baseline.numbers.alertsPer100EndpointsPerMonth).toBe(42);
    expect(o.thresholds.confidence).toBe(FLEET_DESIGN_CONFIDENCE_THRESHOLD);
    expect(o.markdown).toContain('## What was found');
  });
});

describe('renderFleetDesignMarkdown', () => {
  it('renders eight headings in order and no raw markup from the model', () => {
    const s = validSubmission();
    s.found.summary = ['# not a heading'];
    const md = renderFleetDesignMarkdown(fleetDesignOutcomeFromSubmission(s, refs));
    const headings = md.split('\n').filter((l) => l.startsWith('## '));
    expect(headings).toHaveLength(8);
    expect(md).not.toContain('\n# not');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/shared && npx vitest run src/validators/deviceFunctions.test.ts src/validators/fleetDesign.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the SSOT**

`packages/shared/src/validators/deviceFunctions.ts`:
```ts
/**
 * Device FUNCTION — what a device is for — a second axis beside the coarse,
 * billable `device_role` (validators/deviceRoles.ts). The Fleet Designer
 * infers it; a technician may set it by hand. Expected to grow; append,
 * never reorder, and keep `unknown` last.
 */
export const DEVICE_FUNCTION_KEYS = [
  'domain_controller', 'file_server', 'print_server', 'hypervisor', 'database_server',
  'line_of_business_workstation', 'finance_workstation', 'executive_workstation',
  'shared_workstation', 'conference_room', 'kiosk', 'core_switch', 'edge_firewall',
  'backup_target', 'unknown',
] as const;
export type DeviceFunctionKey = (typeof DEVICE_FUNCTION_KEYS)[number];

export const DEVICE_FUNCTION_LABELS: Readonly<Record<DeviceFunctionKey, string>> = Object.freeze({
  domain_controller: 'Domain controller', file_server: 'File server', print_server: 'Print server',
  hypervisor: 'Hypervisor', database_server: 'Database server',
  line_of_business_workstation: 'Line-of-business workstation', finance_workstation: 'Finance workstation',
  executive_workstation: 'Executive workstation', shared_workstation: 'Shared workstation',
  conference_room: 'Conference room', kiosk: 'Kiosk', core_switch: 'Core switch',
  edge_firewall: 'Edge firewall', backup_target: 'Backup target', unknown: 'Unknown',
});

const CUSTOM_SLUG = /^custom:([a-z0-9][a-z0-9-]{1,39})$/;

export function isDeviceFunctionKey(key: string): key is DeviceFunctionKey {
  return (DEVICE_FUNCTION_KEYS as readonly string[]).includes(key);
}

export function parseFunctionKey(
  key: string,
): { kind: 'known'; key: DeviceFunctionKey } | { kind: 'custom'; slug: string } | null {
  if (isDeviceFunctionKey(key)) return { kind: 'known', key };
  const m = CUSTOM_SLUG.exec(key);
  return m ? { kind: 'custom', slug: m[1]! } : null;
}
```

- [ ] **Step 4: Write the types**

`packages/shared/src/types/fleetDesign.ts`:
```ts
import type { DeviceFunctionKey } from '../validators/deviceFunctions';

export const FLEET_DESIGN_SCHEMA_VERSION = 1 as const;

export const FLEET_DESIGN_SECTION_KEYS = [
  'found', 'functions', 'monitoring', 'retired', 'automation', 'legacy', 'baseline', 'unsure',
] as const;
export type FleetDesignSectionKey = (typeof FLEET_DESIGN_SECTION_KEYS)[number];

export const FLEET_DESIGN_SECTION_TITLES: Readonly<Record<FleetDesignSectionKey, string>> = Object.freeze({
  found: 'What was found', functions: 'What each device is for', monitoring: 'What to watch, and why',
  retired: 'What is not carried forward', automation: 'Automation', legacy: 'Legacy script inventory',
  baseline: 'Baseline and precursors', unsure: 'What the designer is unsure about',
});

export const FLEET_DESIGN_CONFIDENCE_THRESHOLD = 0.6;
export const FLEET_DESIGN_PRECURSOR_THRESHOLDS = Object.freeze({
  diskUsedPercent: 80, rebootPendingDays: 7, patchAgeDays: 30, certificateDays: 30, serviceRestartsPer30d: 2,
});
export type FleetDesignThresholds = { confidence: number; precursors: typeof FLEET_DESIGN_PRECURSOR_THRESHOLDS };

export const FLEET_DESIGN_TEXT_MAX_CHARS = 400;
export const FLEET_DESIGN_LIST_MAX = 200;
export const FLEET_DESIGN_DEVICE_IDS_MAX = 2000;

export type FleetDesignPrecursorCondition =
  | 'disk_used_over_threshold' | 'reboot_pending_over_threshold' | 'patch_age_over_threshold'
  | 'certificate_expiring' | 'backup_missed' | 'service_restarted_over_threshold';

export interface FleetDesignBaselineNumbers {
  alertsPer100EndpointsPerMonth: number | null;
  ticketsPerMonth: number | null;
  precursors: { condition: FleetDesignPrecursorCondition; deviceCount: number | null }[];
}

export interface FleetDesignFunctionEntry {
  functionKey: DeviceFunctionKey | `custom:${string}`;
  label?: string;
  deviceIds: string[];
  confidence: number;
  evidence: string[];
  /** Server-assigned: `functions:<functionKey>`. */
  itemRef?: string;
}
export interface FleetDesignWatch {
  watchType: 'service' | 'process';
  name: string;
  alertOnStop: boolean;
  autoRestart: boolean;
  rationale: string;
  itemRef?: string;
}
export interface FleetDesignRule {
  name: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  conditions: unknown[];          // alertRuleConditionSchema items; typed loosely here, validated in the validator
  cooldownMinutes: number;
  rationale: string;
  action: 'none' | { kind: 'playbook'; ref: string } | { kind: 'script'; ref: string };
  paging: 'none' | 'business_hours' | 'always';
  sourceTemplateId?: string;
  itemRef?: string;
}
export interface FleetDesignMonitoringEntry { functionKey: string; watches: FleetDesignWatch[]; alertRules: FleetDesignRule[] }
export interface FleetDesignRetiredItem {
  kind: 'watch' | 'rule';
  policyId: string;
  policyName: string;
  itemName: string;
  reason: string;
  itemRef?: string;
}
export interface FleetDesignAutomationEntry {
  functionKey: string;
  playbooks: ({ builtInName: string } | { custom: { name: string; description: string; steps: string[]; triggeredBy: string } })[];
  scripts: { name: string; purpose: string; osTypes: ('windows' | 'macos' | 'linux')[]; language: 'powershell' | 'bash' | 'python' | 'cmd'; content: string; itemRef?: string }[];
}
export interface FleetDesignLegacyItem {
  scriptId: string;
  scriptName: string;
  intent: string;
  bucket: 'obsolete' | 'covered' | 'needed';
  coveredBy?: string;
  notes: string;
  itemRef?: string;
}
export interface FleetDesignRoleCorrection {
  deviceId: string;
  currentRole: string;
  proposedRole: string;
  evidence: string[];
  billingRelevant: true;
  itemRef?: string;
}

/** What the model submits through `submit_fleet_design`. */
export interface FleetDesignSubmission {
  found: { summary: string[]; findings: { title: string; deviceCount: number; evidence: string[] }[] };
  functions: FleetDesignFunctionEntry[];
  monitoring: FleetDesignMonitoringEntry[];
  retired: FleetDesignRetiredItem[];
  automation: FleetDesignAutomationEntry[];
  legacy: FleetDesignLegacyItem[];
  baseline: { notes: string[] };
  unsure: {
    lowConfidenceFunctions: FleetDesignFunctionEntry[];
    unreachableDevices: string[];
    needsHuman: string[];
    roleCorrections: FleetDesignRoleCorrection[];
  };
}

/** Server-built from a validated submission — what the run stores and the report renders. */
export interface FleetDesignOutcome {
  schemaVersion: typeof FLEET_DESIGN_SCHEMA_VERSION;
  sections: Omit<FleetDesignSubmission, 'baseline'> & { baseline: { notes: string[]; numbers: FleetDesignBaselineNumbers } };
  thresholds: FleetDesignThresholds;
  generatedAt: string;
  markdown: string;
}

/** `report_runs.result.summary.fleetDesign`. Every field optional (persisted jsonb, old snapshots must render). */
export interface FleetDesignReportSummary {
  fleetDesign?: {
    schemaVersion?: number;
    outcome?: FleetDesignOutcome;
    orgName?: string;
    partnerName?: string;
    siteName?: string | null;
    generatedAt?: string;
    runId?: string;
    agentName?: string;
    evidenceTruncated?: boolean;
    devicesNotAssessed?: number;
  };
}

/** Safe projection for `GET /ai/agents/runs/:runId` and the Fleet Design page. */
export interface AiAgentRunFleetDesignDto {
  reportRunId: string | null;
  reportId: string | null;
  downloadPath: string | null;
  generatedAt: string | null;
  functionCount: number;
  watchCount: number;
  ruleCount: number;
  evidenceTruncated: boolean;
}
```

- [ ] **Step 5: Write the validator**

`packages/shared/src/validators/fleetDesign.ts`:
```ts
import { z } from 'zod';
import { alertRuleConditionSchema } from './index';
import { parseFunctionKey } from './deviceFunctions';
import {
  FLEET_DESIGN_CONFIDENCE_THRESHOLD, FLEET_DESIGN_DEVICE_IDS_MAX, FLEET_DESIGN_LIST_MAX,
  FLEET_DESIGN_PRECURSOR_THRESHOLDS, FLEET_DESIGN_SCHEMA_VERSION, FLEET_DESIGN_SECTION_KEYS,
  FLEET_DESIGN_SECTION_TITLES, FLEET_DESIGN_TEXT_MAX_CHARS,
  type FleetDesignBaselineNumbers, type FleetDesignOutcome, type FleetDesignSubmission,
} from '../types/fleetDesign';

const CONTROL = /\p{C}/gu;
export function fleetDesignText(max = FLEET_DESIGN_TEXT_MAX_CHARS) {
  return z.string().trim().min(1).max(max).transform((s) => s.replace(CONTROL, '').replace(/\s+/g, ' '));
}
const textList = (max = 50) => z.array(fleetDesignText()).max(max);
const uuid = z.string().uuid();
const functionKey = z.string().max(48).refine((k) => parseFunctionKey(k) !== null, { message: 'unknown function key' });

const functionEntry = z.object({
  functionKey,
  label: fleetDesignText(80).optional(),
  deviceIds: z.array(uuid).min(1).max(FLEET_DESIGN_DEVICE_IDS_MAX),
  confidence: z.number().min(0).max(1),
  evidence: textList(20).min(1),
}).strict().superRefine((v, ctx) => {
  const parsed = parseFunctionKey(v.functionKey);
  if (parsed?.kind === 'custom' && !v.label) ctx.addIssue({ code: 'custom', path: ['label'], message: 'a custom function needs a label' });
});

const watch = z.object({
  watchType: z.enum(['service', 'process']),
  name: z.string().trim().min(1).max(255),
  alertOnStop: z.boolean(),
  autoRestart: z.boolean(),
  rationale: fleetDesignText(),
}).strict();

const rule = z.object({
  name: z.string().trim().min(1).max(200),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  conditions: z.array(alertRuleConditionSchema).min(1).max(10),
  cooldownMinutes: z.number().int().min(1).max(1440),
  rationale: fleetDesignText(),
  action: z.union([z.literal('none'), z.object({ kind: z.enum(['playbook', 'script']), ref: z.string().min(1).max(200) }).strict()]),
  paging: z.enum(['none', 'business_hours', 'always']),
  sourceTemplateId: uuid.optional(),
}).strict();

export const fleetDesignSubmissionSchema = z.object({
  found: z.object({
    summary: textList(30).min(1),
    findings: z.array(z.object({ title: fleetDesignText(160), deviceCount: z.number().int().min(0), evidence: textList(10) }).strict()).max(FLEET_DESIGN_LIST_MAX),
  }).strict(),
  functions: z.array(functionEntry).max(FLEET_DESIGN_LIST_MAX),
  monitoring: z.array(z.object({ functionKey, watches: z.array(watch).max(50), alertRules: z.array(rule).max(50) }).strict()).max(FLEET_DESIGN_LIST_MAX),
  retired: z.array(z.object({
    kind: z.enum(['watch', 'rule']), policyId: uuid, policyName: fleetDesignText(255), itemName: fleetDesignText(255), reason: fleetDesignText(),
  }).strict()).max(FLEET_DESIGN_LIST_MAX),
  automation: z.array(z.object({
    functionKey,
    playbooks: z.array(z.union([
      z.object({ builtInName: fleetDesignText(255) }).strict(),
      z.object({ custom: z.object({ name: fleetDesignText(255), description: fleetDesignText(2000), steps: textList(20).min(1), triggeredBy: fleetDesignText(200) }).strict() }).strict(),
    ])).max(20),
    scripts: z.array(z.object({
      name: fleetDesignText(255), purpose: fleetDesignText(2000),
      osTypes: z.array(z.enum(['windows', 'macos', 'linux'])).min(1),
      language: z.enum(['powershell', 'bash', 'python', 'cmd']),
      content: z.string().min(1).max(65_536),
    }).strict()).max(20),
  }).strict()).max(FLEET_DESIGN_LIST_MAX),
  legacy: z.array(z.object({
    scriptId: uuid, scriptName: fleetDesignText(255), intent: fleetDesignText(), bucket: z.enum(['obsolete', 'covered', 'needed']),
    coveredBy: fleetDesignText(255).optional(), notes: fleetDesignText(1000),
  }).strict()).max(2000),
  baseline: z.object({ notes: textList(30) }).strict(),
  unsure: z.object({
    lowConfidenceFunctions: z.array(functionEntry).max(FLEET_DESIGN_LIST_MAX),
    unreachableDevices: z.array(uuid).max(FLEET_DESIGN_DEVICE_IDS_MAX),
    needsHuman: textList(50),
    roleCorrections: z.array(z.object({
      deviceId: uuid, currentRole: z.string().max(30), proposedRole: z.string().max(30), evidence: textList(10).min(1), billingRelevant: z.literal(true),
    }).strict()).max(FLEET_DESIGN_LIST_MAX),
  }).strict(),
}).strict().superRefine((v, ctx) => {
  v.functions.forEach((f, i) => {
    if (f.confidence < FLEET_DESIGN_CONFIDENCE_THRESHOLD) {
      ctx.addIssue({ code: 'custom', path: ['functions', i, 'confidence'], message: `below the ${FLEET_DESIGN_CONFIDENCE_THRESHOLD} threshold — put it in unsure.lowConfidenceFunctions` });
    }
  });
  const seen = new Map<string, number>();
  v.functions.forEach((f, i) => f.deviceIds.forEach((d, j) => {
    const prev = seen.get(d);
    if (prev !== undefined) ctx.addIssue({ code: 'custom', path: ['functions', i, 'deviceIds', j], message: `device already assigned in functions[${prev}]` });
    else seen.set(d, i);
  }));
  const keys = new Set<string>();
  v.functions.forEach((f, i) => {
    if (keys.has(f.functionKey)) ctx.addIssue({ code: 'custom', path: ['functions', i, 'functionKey'], message: 'duplicate function key' });
    keys.add(f.functionKey);
  });
  v.monitoring.forEach((m, i) => {
    if (!keys.has(m.functionKey)) ctx.addIssue({ code: 'custom', path: ['monitoring', i, 'functionKey'], message: 'monitoring names a function that is not in functions' });
  });
});

export interface FleetDesignOutcomeRefs {
  deviceIds: ReadonlySet<string>;
  baseline: FleetDesignBaselineNumbers;
  generatedAt: string;
}

export class FleetDesignReferenceError extends Error {
  constructor(readonly path: string, message: string) { super(`${path}: ${message}`); this.name = 'FleetDesignReferenceError'; }
}

export function fleetDesignOutcomeFromSubmission(submission: FleetDesignSubmission, refs: FleetDesignOutcomeRefs): FleetDesignOutcome {
  const checkDevices = (ids: string[], path: string) => ids.forEach((d, j) => {
    if (!refs.deviceIds.has(d)) throw new FleetDesignReferenceError(`${path}[${j}]`, 'device id is not in this organization\'s evidence');
  });
  submission.functions.forEach((f, i) => checkDevices(f.deviceIds, `functions[${i}].deviceIds`));
  submission.unsure.lowConfidenceFunctions.forEach((f, i) => checkDevices(f.deviceIds, `unsure.lowConfidenceFunctions[${i}].deviceIds`));
  checkDevices(submission.unsure.unreachableDevices, 'unsure.unreachableDevices');
  submission.unsure.roleCorrections.forEach((r, i) => checkDevices([r.deviceId], `unsure.roleCorrections[${i}].deviceId`));

  const sections: FleetDesignOutcome['sections'] = {
    found: submission.found,
    functions: submission.functions.map((f) => ({ ...f, itemRef: `functions:${f.functionKey}` })),
    monitoring: submission.monitoring.map((m) => ({
      functionKey: m.functionKey,
      watches: m.watches.map((w, n) => ({ ...w, itemRef: `monitoring:${m.functionKey}:watch:${n}` })),
      alertRules: m.alertRules.map((r, n) => ({ ...r, itemRef: `monitoring:${m.functionKey}:rule:${n}` })),
    })),
    retired: submission.retired.map((r, n) => ({ ...r, itemRef: `retired:${n}` })),
    automation: submission.automation.map((a) => ({
      ...a, scripts: a.scripts.map((s, n) => ({ ...s, itemRef: `automation:${a.functionKey}:script:${n}` })),
    })),
    legacy: submission.legacy.map((l) => ({ ...l, itemRef: `legacy:${l.scriptId}` })),
    baseline: { notes: submission.baseline.notes, numbers: refs.baseline },
    unsure: { ...submission.unsure, roleCorrections: submission.unsure.roleCorrections.map((r) => ({ ...r, itemRef: `roleCorrections:${r.deviceId}` })) },
  };
  const outcome: FleetDesignOutcome = {
    schemaVersion: FLEET_DESIGN_SCHEMA_VERSION,
    sections,
    thresholds: { confidence: FLEET_DESIGN_CONFIDENCE_THRESHOLD, precursors: FLEET_DESIGN_PRECURSOR_THRESHOLDS },
    generatedAt: refs.generatedAt,
    markdown: '',
  };
  outcome.markdown = renderFleetDesignMarkdown(outcome);
  return outcome;
}

const line = (s: string) => s.replace(/[#*_>`\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
const bullet = (s: string) => `- ${line(s)}`;

export function renderFleetDesignMarkdown(o: FleetDesignOutcome): string {
  const s = o.sections;
  const out: string[] = [];
  for (const key of FLEET_DESIGN_SECTION_KEYS) {
    out.push(`## ${FLEET_DESIGN_SECTION_TITLES[key]}`, '');
    switch (key) {
      case 'found':
        out.push(...s.found.summary.map(bullet));
        for (const f of s.found.findings) out.push(bullet(`${f.title} (${f.deviceCount} devices)`));
        break;
      case 'functions':
        for (const f of s.functions) out.push(bullet(`${f.label ?? f.functionKey}: ${f.deviceIds.length} devices, confidence ${f.confidence.toFixed(2)} — ${f.evidence.join('; ')}`));
        break;
      case 'monitoring':
        for (const m of s.monitoring) {
          out.push(`### ${line(m.functionKey)}`);
          for (const w of m.watches) out.push(bullet(`Watch ${w.watchType} ${w.name}${w.autoRestart ? ', auto-restart' : ''} — ${w.rationale}`));
          for (const r of m.alertRules) out.push(bullet(`Rule ${r.name} [${r.severity}], cooldown ${r.cooldownMinutes} min, paging ${r.paging} — ${r.rationale}`));
        }
        break;
      case 'retired':
        out.push(...(s.retired.length ? s.retired.map((r) => bullet(`${r.kind} ${r.itemName} in ${r.policyName} — ${r.reason}`)) : ['- Nothing retired.']));
        break;
      case 'automation':
        for (const a of s.automation) {
          for (const p of a.playbooks) out.push(bullet('builtInName' in p ? `${a.functionKey}: built-in playbook ${p.builtInName}` : `${a.functionKey}: custom playbook ${p.custom.name} — ${p.custom.description}`));
          for (const sc of a.scripts) out.push(bullet(`${a.functionKey}: script ${sc.name} (${sc.language}, ${sc.osTypes.join('/')}) — ${sc.purpose}`));
        }
        if (!s.automation.length) out.push('- No automation proposed.');
        break;
      case 'legacy':
        out.push(...(s.legacy.length ? s.legacy.map((l) => bullet(`${l.scriptName}: ${l.bucket}${l.coveredBy ? ` (covered by ${l.coveredBy})` : ''} — ${l.intent}`)) : ['- No legacy scripts were present.']));
        break;
      case 'baseline': {
        const n = s.baseline.numbers;
        out.push(bullet(`Alerts per 100 endpoints per month: ${n.alertsPer100EndpointsPerMonth ?? 'not measured'}`));
        out.push(bullet(`Tickets per month: ${n.ticketsPerMonth ?? 'not measured'}`));
        for (const p of n.precursors) out.push(bullet(`${p.condition}: ${p.deviceCount ?? 'not measured'}`));
        out.push(...s.baseline.notes.map(bullet));
        break;
      }
      case 'unsure':
        for (const f of s.unsure.lowConfidenceFunctions) out.push(bullet(`Low confidence ${f.label ?? f.functionKey}: ${f.deviceIds.length} devices at ${f.confidence.toFixed(2)}`));
        if (s.unsure.unreachableDevices.length) out.push(bullet(`${s.unsure.unreachableDevices.length} devices unreachable`));
        out.push(...s.unsure.needsHuman.map(bullet));
        for (const r of s.unsure.roleCorrections) out.push(bullet(`Role correction (billing-relevant): ${r.currentRole} → ${r.proposedRole} — ${r.evidence.join('; ')}`));
        if (!s.unsure.lowConfidenceFunctions.length && !s.unsure.unreachableDevices.length && !s.unsure.needsHuman.length && !s.unsure.roleCorrections.length) out.push('- Nothing flagged.');
        break;
    }
    out.push('');
  }
  return out.join('\n');
}
```

Note: `alertRuleConditionSchema` is defined in `validators/index.ts`, which will also re-export this module — a circular import. Move `metricConditionSchema`, `offlineConditionSchema`, `eventLogConditionSchema` and `alertRuleConditionSchema` (`validators/index.ts` ~:1000-1023) into a new `packages/shared/src/validators/alertRuleConditions.ts`, re-export them from `index.ts` where they were, and import from that file here.

- [ ] **Step 6: Run the tests; they pass**

Run: `cd packages/shared && npx vitest run src/validators/deviceFunctions.test.ts src/validators/fleetDesign.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS, 0 type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): device function SSOT and fleet design section contract"
```

### Task 2: Shared — kind, profile, schedule kind, limits v10, mode rule, cron rule, DTO field

**Files:**
- Modify: `packages/shared/src/types/aiAgents.ts:1-2` (kinds), `:94-97` + `:122-153` (limits + defaults), `:433-437` (snapshot version), `:761-762` (profiles), `:597` (presets DTO type is `Record<AiAgentKind, string[]>` — no change needed)
- Modify: `packages/shared/src/validators/aiAgents.ts:58-65` (limits), `:195` + `:219` (mode), `:207-212` (create schema)
- Modify: `packages/shared/src/types/aiAgentSchedules.ts:48-49`, `packages/shared/src/validators/aiAgentSchedules.ts:62-70` + `:130-175`
- Modify: `packages/shared/src/types/aiAgentRuns.ts:568-575` (add `fleetDesign`)
- Test: `packages/shared/src/validators/aiAgents.test.ts`, `packages/shared/src/validators/aiAgentSchedules.test.ts` (extend)

**Interfaces:**
- Produces: `AI_AGENT_KINDS` includes `'designer'`; `AI_AGENT_RUN_PROFILES` includes `'design'`; `AI_AGENT_SCHEDULE_KINDS` includes `'design'`; `AiAgentLimits.maxConcurrentDesignRuns | maxDesignRunsPerDay | designBudgetCentsPerRun | designMaxTurns`; `AI_AGENT_POLICY_SNAPSHOT_VERSION = 10`; `DESIGNER_ALLOWED_MODES: readonly AiAgentMode[] = ['off','act']`; `allowedModesForKind(kind): readonly AiAgentMode[]`; `isMonthlyOrRarerLiteralCron(pattern): boolean`; `AiAgentRunDetailDto.fleetDesign: AiAgentRunFleetDesignDto | null`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/validators/aiAgents.test.ts`:
```ts
describe('designer kind', () => {
  it('is a create-able kind whose modes exclude shadow', () => {
    expect(AI_AGENT_KINDS).toContain('designer');
    expect(allowedModesForKind('designer')).toEqual(['off', 'act']);
    expect(allowedModesForKind('triage')).toEqual(['off', 'shadow', 'act']);
    const base = { name: 'Designer', kind: 'designer', ownerScope: 'partner' };
    expect(createAiAgentSchema.safeParse({ ...base, mode: 'shadow' }).success).toBe(false);
    expect(createAiAgentSchema.safeParse({ ...base, mode: 'act' }).success).toBe(true);
  });
  it('bounds the design limits', () => {
    expect(aiAgentLimitsSchema.safeParse({ ...AI_AGENT_LIMIT_DEFAULTS, maxDesignRunsPerDay: 25 }).success).toBe(false);
    expect(aiAgentLimitsSchema.safeParse({ ...AI_AGENT_LIMIT_DEFAULTS, designBudgetCentsPerRun: 24 }).success).toBe(false);
    expect(aiAgentLimitsSchema.safeParse(AI_AGENT_LIMIT_DEFAULTS).success).toBe(true);
    expect(AI_AGENT_POLICY_SNAPSHOT_VERSION).toBe(10);
  });
});
```
(Import `allowedModesForKind`, `AI_AGENT_LIMIT_DEFAULTS`, `AI_AGENT_POLICY_SNAPSHOT_VERSION`, `AI_AGENT_KINDS` from `../types/aiAgents`; find the limits schema's export name at `validators/aiAgents.ts:40-70` — it is the object that holds `maxConcurrentNarrativeRuns` — and use it. If `createAiAgentSchema` needs more required fields than `name/kind/ownerScope/mode`, copy them from an existing passing case in the same test file.)

Append to `packages/shared/src/validators/aiAgentSchedules.test.ts`:
```ts
describe('design schedule kind', () => {
  it('accepts a quarterly literal cron and rejects weekly/daily ones', () => {
    expect(isMonthlyOrRarerLiteralCron('0 6 1 1,4,7,10 *')).toBe(true);
    expect(isMonthlyOrRarerLiteralCron('0 6 1 * *')).toBe(true);
    expect(isMonthlyOrRarerLiteralCron('0 6 1 */3 *')).toBe(true);
    expect(isMonthlyOrRarerLiteralCron('0 7 * * 1')).toBe(false);
    expect(isMonthlyOrRarerLiteralCron('0 6 29 * *')).toBe(false);
    expect(isMonthlyOrRarerLiteralCron('*/5 6 1 * *')).toBe(false);
  });
  it('a design baseline sweeps nothing and must be monthly or rarer', () => {
    const base = { ownerScope: 'partner', kind: 'design', agentId: '11111111-1111-4111-8111-111111111111', timezone: 'UTC', enabled: true };
    expect(createAiAgentScheduleSchema.safeParse({ ...base, cron: '0 6 1 1,4,7,10 *' }).success).toBe(true);
    expect(createAiAgentScheduleSchema.safeParse({ ...base, cron: '0 7 * * 1' }).success).toBe(false);
    expect(createAiAgentScheduleSchema.safeParse({ ...base, cron: '0 6 1 * *', sweepKinds: ['disk_pressure'] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/shared && npx vitest run src/validators/aiAgents.test.ts src/validators/aiAgentSchedules.test.ts`
Expected: FAIL (`designer` not in kinds; `allowedModesForKind`/`isMonthlyOrRarerLiteralCron` undefined).

- [ ] **Step 3: Implement**

`packages/shared/src/types/aiAgents.ts`:
```ts
export const AI_AGENT_KINDS = ['triage', 'patch', 'helpdesk', 'designer'] as const;
// after AI_AGENT_MODES (:4-5):
/** The Fleet Designer never produces intents, so `shadow` has nothing to shadow. */
export const DESIGNER_ALLOWED_MODES: readonly AiAgentMode[] = ['off', 'act'] as const;
export function allowedModesForKind(kind: AiAgentKind): readonly AiAgentMode[] {
  return kind === 'designer' ? DESIGNER_ALLOWED_MODES : AI_AGENT_MODES;
}
```
In `AiAgentLimits` after `narrativeMaxTurns` (:97):
```ts
  /** Fleet Designer (W01) — design-profile admission caps, counted on their own
   *  (`profileCaps`, window 24 h), and the per-run budget/turn substitutes
   *  applied by `designLimits()` (designProfile.ts). Snapshot v10. */
  maxConcurrentDesignRuns: number;
  maxDesignRunsPerDay: number;
  designBudgetCentsPerRun: number;
  designMaxTurns: number;
```
In `AI_AGENT_LIMIT_DEFAULTS` after the narrative block (:153):
```ts
  maxConcurrentDesignRuns: 1,
  maxDesignRunsPerDay: 4,
  designBudgetCentsPerRun: 300,
  designMaxTurns: 60,
```
`AI_AGENT_POLICY_SNAPSHOT_VERSION = 10 as const;` and extend the `schemaVersion` union at :437 with `| 10`; copy the v7 tolerance comment at :410-416 for v10.
`export const AI_AGENT_RUN_PROFILES = ['full', 'verdict', 'sweep', 'narrative', 'triage', 'design'] as const;`

`packages/shared/src/validators/aiAgents.ts` after :65:
```ts
  // Fleet Designer (W01) — one design run is a long read-only turn budget
  // over a whole org; the per-day cap is the cost ceiling a partner sets.
  maxConcurrentDesignRuns: z.number().int().min(1).max(4),
  maxDesignRunsPerDay: z.number().int().min(1).max(24),
  designBudgetCentsPerRun: z.number().int().min(25).max(2000),
  designMaxTurns: z.number().int().min(8).max(120),
```
`createAiAgentSchema` (:207-212): chain `.superRefine((v, ctx) => { if (!allowedModesForKind(v.kind).includes(v.mode)) ctx.addIssue({ code: 'custom', path: ['mode'], message: `mode ${v.mode} is not available for a ${v.kind} agent` }); })`. `updateAiAgentSchema` has no `kind`; the route enforces it (Task 5 Step 6).

`packages/shared/src/types/aiAgentSchedules.ts:48`: `export const AI_AGENT_SCHEDULE_KINDS = ['sweep', 'narrative', 'design'] as const;`

`packages/shared/src/validators/aiAgentSchedules.ts` after `isWeeklyLiteralCron` (:70):
```ts
/**
 * Fleet Designer (W01): a design schedule fires at most once a month —
 * literal minute and hour, literal day-of-month 1-28, month `*` / `*\/N` /
 * comma list of literal months, and `*` day-of-week. Default `0 6 1 1,4,7,10 *`.
 */
export const DESIGN_DEFAULT_CRON = '0 6 1 1,4,7,10 *';
export function isMonthlyOrRarerLiteralCron(pattern: string): boolean {
  const fields = pattern.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  if (!LITERAL_INT.test(minute) || Number(minute) > 59) return false;
  if (!LITERAL_INT.test(hour) || Number(hour) > 23) return false;
  if (!LITERAL_INT.test(dom) || Number(dom) < 1 || Number(dom) > 28) return false;
  const monthOk = month === '*' || /^\*\/([1-9]|1[0-2])$/.test(month)
    || month.split(',').every((m) => LITERAL_INT.test(m) && Number(m) >= 1 && Number(m) <= 12);
  return monthOk && dow === '*';
}
```
In `createPartnerScheduleSchema`'s `superRefine` (:150+), add before the `// kind === 'sweep'` comment:
```ts
  if (value.kind === 'design') {
    if (value.sweepKinds.length > 0) ctx.addIssue({ code: 'custom', path: ['sweepKinds'], message: 'a design schedule evaluates no sweep kinds — sweepKinds must be omitted or empty' });
    if (!isMonthlyOrRarerLiteralCron(value.cron)) ctx.addIssue({ code: 'custom', path: ['cron'], message: 'a design schedule fires at most once a month — literal minute, hour and day-of-month 1-28, month `*`, `*/N` or a list of months, `*` day-of-week' });
    return;
  }
```

`packages/shared/src/types/aiAgentRuns.ts` after `narrative` (:575):
```ts
  /** Fleet Designer (W01) — additive nullable; null for every non-design run. */
  fleetDesign: AiAgentRunFleetDesignDto | null;
```
(import the type from `./fleetDesign`).

- [ ] **Step 4: Run the tests; they pass. Typecheck shared and api.**

Run: `cd packages/shared && npx vitest run src/validators/aiAgents.test.ts src/validators/aiAgentSchedules.test.ts && npx tsc --noEmit -p tsconfig.json; cd ../../apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json 2>&1 | head -40`
Expected: shared PASS; api tsc reports errors exactly at the `never` guards — `runService.ts profileCaps`, `outcomeTools.ts outcomeToolsForProfile`, `agentToolCatalog.ts AGENT_KIND_PRESETS` (missing `designer`), and every `Record<AiAgentKind, …>`/`Record<AiAgentRunProfile, …>` literal. Those are Task 5/7's worklist; note them in the commit message.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): designer kind, design profile and schedule kind, limits v10"
```

### Task 3: Migrations

**Files:**
- Create: `apps/api/migrations/2026-10-15-180000-report-type-ai-fleet-design.sql`
- Create: `apps/api/migrations/2026-10-15-180100-ai-agents-fleet-designer.sql`

**Interfaces:**
- Produces: enum label `ai_fleet_design`; `ai_agents_kind_chk` admits `designer`; `ai_agent_runs_profile_chk` admits `design`; `ai_agent_schedules_kind_chk` + `ai_agent_schedules_kind_kinds_chk` admit `design`; `reports_ai_fleet_design_org_uniq`.

- [ ] **Step 1: Write file A (enum only)**

```sql
-- Fleet Designer W01 (spec §4.4): the report type the design lane persists.
-- Enum add ONLY, in its own file: a label added by ALTER TYPE cannot be used
-- until the transaction that added it commits (precedent:
-- 2026-09-24-a-report-type-ai-org-narrative.sql). Idempotent.
ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'ai_fleet_design';
```

- [ ] **Step 2: Write file B**

```sql
-- Fleet Designer W01 (spec §4.1, §4.4). DDL only — no rows written, no
-- breeze.scope election. Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps).

-- 1. ai_agents.kind admits 'designer' ---------------------------------------
ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS ai_agents_kind_chk;
ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_kind_chk
  CHECK (kind IN ('triage', 'patch', 'helpdesk', 'designer'));

-- 2. ai_agent_runs.profile admits 'design' ----------------------------------
ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_profile_chk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_profile_chk
  CHECK (profile IN ('full', 'verdict', 'sweep', 'narrative', 'triage', 'design'));

-- 3. ai_agent_schedules.kind admits 'design'; a design schedule sweeps nothing
ALTER TABLE ai_agent_schedules DROP CONSTRAINT IF EXISTS ai_agent_schedules_kind_chk;
ALTER TABLE ai_agent_schedules ADD CONSTRAINT ai_agent_schedules_kind_chk
  CHECK (kind IN ('sweep', 'narrative', 'design'));
ALTER TABLE ai_agent_schedules DROP CONSTRAINT IF EXISTS ai_agent_schedules_kind_kinds_chk;
ALTER TABLE ai_agent_schedules ADD CONSTRAINT ai_agent_schedules_kind_kinds_chk CHECK (
  (kind IN ('narrative', 'design') AND cardinality(sweep_kinds) = 0)
  OR (kind = 'sweep' AND (org_id IS NOT NULL OR cardinality(sweep_kinds) > 0))
);

-- 4. One Fleet Design definition per organization ---------------------------
-- Manual design runs have no schedule, so the definition cannot be keyed on
-- source_ai_agent_schedule_id like the narrative's. Keyed on the type instead;
-- the org-merge reports executor dedupes on the same predicate (Task 4).
CREATE UNIQUE INDEX IF NOT EXISTS reports_ai_fleet_design_org_uniq
  ON reports (org_id) WHERE type = 'ai_fleet_design';
```

- [ ] **Step 3: Verify naming and RLS-scope guards**

Run: `scripts/check-migration-naming.sh --staged` (after `git add`), then `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`
Expected: both PASS (DDL only; no new baseline entries).

- [ ] **Step 4: Apply against a live DB and check drift**

Run: `pnpm test-stack up` (if not already), `export DATABASE_URL=<from .env.test>; pnpm db:migrate && pnpm db:check-drift` after Task 4's schema edit. If check-drift flags the partial index, add it to `apps/api/src/db/schema/reports.ts` (Task 4).

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-10-15-180000-report-type-ai-fleet-design.sql apps/api/migrations/2026-10-15-180100-ai-agents-fleet-designer.sql
git commit -m "feat(db): fleet designer kind, design profile and schedule kind, ai_fleet_design report type"
```

### Task 4: Drizzle enum value and the org-merge reports pass

**Files:**
- Modify: `apps/api/src/db/schema/reports.ts:22-33` (enum), `:86-94` (indexes)
- Modify: `apps/api/src/services/orgMergeCustomExecutors.ts:1022-1026` (keys) and the `reports` executor (~:1094-1120)
- Test: `apps/api/src/services/orgMergeCustomExecutors.test.ts` (extend, if it exists; else the integration suite `orgMergeRegistry.integration.test.ts` covers executors — add the case there)

- [ ] **Step 1: Schema**

Add `'ai_fleet_design'` after `'ai_org_narrative'` in `reportTypeEnum`. In the `reports` table's index block add:
```ts
  aiFleetDesignOrgUniq: uniqueIndex('reports_ai_fleet_design_org_uniq')
    .on(table.orgId)
    .where(sql`${table.type} = 'ai_fleet_design'`),
```

- [ ] **Step 2: Merge pass — failing test first**

In the executor's test file (create `apps/api/src/services/orgMergeCustomExecutors.reports.test.ts` if no unit test exists; it may mock `run`/`db.execute` the way sibling executor tests do):
```ts
it('dedupes ai_fleet_design definitions by type when both orgs have one', async () => {
  // arrange: loser and survivor each own one reports row with type ai_fleet_design
  // act: CUSTOM_EXECUTORS.reports(loser, survivor)
  // assert: the statements include a rehome keyed on `type` guarded by
  //         s.type = 'ai_fleet_design' AND t.type = 'ai_fleet_design', and the note mentions "Fleet Design"
});
```
Run: `cd apps/api && npx vitest run src/services/orgMergeCustomExecutors.reports.test.ts` → FAIL.

- [ ] **Step 3: Implement the third pass**

After `PORTAL_REPORT_WHERE_BOTH` (:1026):
```ts
// Mirrors reports_ai_fleet_design_org_uniq (org_id) WHERE type = 'ai_fleet_design'
// (Fleet Designer W01): one design definition per org, keyed on the type.
const FLEET_DESIGN_REPORT_KEY = ['type'] as const;
const FLEET_DESIGN_REPORT_WHERE_BOTH = sql`s.type = 'ai_fleet_design' AND t.type = 'ai_fleet_design'`;
```
In the `reports` executor, after the `portal` call and before `buildRepoint('reports', …)`:
```ts
  const fleetDesign = await rehomeReportChildrenThenDelete(loser, survivor, FLEET_DESIGN_REPORT_KEY, FLEET_DESIGN_REPORT_WHERE_BOTH);
```
Add to the `notes` block:
```ts
  if (fleetDesign.dropped > 0) {
    notes.push(`reports: dropped ${fleetDesign.dropped} duplicate Fleet Design report definition from the merged-away org and re-homed its children onto the survivor's definition (report_runs: ${fleetDesign.reportRunsRehomed}; report_schedule_recipients: ${fleetDesign.recipientsDeduplicated} deduplicated, ${fleetDesign.recipientsRehomed} re-homed)`);
  }
```
and fold `fleetDesign.dropped` into the returned `dropped` total the way `portal.dropped` is. Update the `reports` note in `orgMergeRegistry.ts:472` to mention the third pass.

- [ ] **Step 4: Run tests, drift check, commit**

Run: `cd apps/api && npx vitest run src/services/orgMergeCustomExecutors src/services/orgMergeRegistry.test.ts && pnpm db:check-drift`
Expected: PASS, no drift.

```bash
git add apps/api/src/db/schema/reports.ts apps/api/src/services/orgMergeCustomExecutors.ts apps/api/src/services/orgMergeCustomExecutors.reports.test.ts apps/api/src/services/orgMergeRegistry.ts
git commit -m "feat(api): ai_fleet_design report type with per-org definition and merge dedupe"
```

### Task 5: Profile module, admission, circuit, presets, schedule-kind guard, designer modes

**Files:**
- Create: `apps/api/src/services/aiAgents/designProfile.ts`, `apps/api/src/services/aiAgents/designProfile.test.ts`
- Modify: `apps/api/src/services/aiAgents/runService.ts:38-131` (inventory), `:688-741` (`profileCaps`), `:1010-1025` (rule 6b), `AgentRunSkipReason` (~:262+)
- Modify: `apps/api/src/services/aiAgents/agentCircuit.ts:127-129`, `agentCircuit.test.ts`
- Modify: `apps/api/src/services/aiAgents/agentToolCatalog.ts:288-304`, `:416-420`; `agentToolCatalog.contract.test.ts`; `verdictProfile.contract.test.ts:18-53`
- Modify: `apps/api/src/services/aiAgents/scheduleService.ts:46-66` (codes), `:320-347` (`assertPartnerWideTriageAgent`), its call site(s)
- Modify: `apps/api/src/routes/aiAgents.ts` (`POST /` and `PATCH /:id`)

**Interfaces:**
- Produces: `DESIGN_TOOL_ALLOWLIST`, `DESIGN_OUTCOME_TOOL_NAME = 'submit_fleet_design'`, `isDesignProfile(run)`, `designLimits(limits)`, `designToolAllowlist(agentAllowlist)`; skip reasons `'max_concurrent_design_runs' | 'design_rate'`; `ScheduleValidationCode` gains `'agent_kind_not_designer'`; `assertPartnerWideScheduledAgent(agentId, partnerId, kind)`.

- [ ] **Step 1: Failing tests**

`apps/api/src/services/aiAgents/designProfile.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { AI_AGENT_LIMIT_DEFAULTS, type AiAgentLimits } from '@breeze/shared';
import { DESIGN_TOOL_ALLOWLIST, designLimits, designToolAllowlist, isDesignProfile } from './designProfile';
import { buildAgentToolCatalog } from './agentToolCatalog';

describe('design profile', () => {
  it('detects the profile', () => {
    expect(isDesignProfile({ profile: 'design' })).toBe(true);
    expect(isDesignProfile({ profile: 'narrative' })).toBe(false);
  });
  it('substitutes design budget and turns and zeroes actions', () => {
    const l = designLimits({ ...AI_AGENT_LIMIT_DEFAULTS, designBudgetCentsPerRun: 500, designMaxTurns: 20 } as AiAgentLimits);
    expect(l.maxBudgetCentsPerRun).toBe(500);
    expect(l.maxTurnsPerRun).toBe(20);
    expect(l.maxActionsPerRun).toBe(0);
    const legacy = designLimits({ ...AI_AGENT_LIMIT_DEFAULTS, designMaxTurns: undefined } as unknown as AiAgentLimits);
    expect(legacy.maxTurnsPerRun).toBe(AI_AGENT_LIMIT_DEFAULTS.designMaxTurns);
  });
  it('is a floor: ignores the agent allowlist, ends with the outcome tool', () => {
    const list = designToolAllowlist(['run_script']);
    expect(list).not.toContain('run_script');
    expect(list[list.length - 1]).toBe('submit_fleet_design');
    expect(list.slice(0, -1)).toEqual([...DESIGN_TOOL_ALLOWLIST]);
  });
  it('every floor tool is a read-only catalog tool (spec §4.12)', () => {
    const catalog = buildAgentToolCatalog();
    const byName = new Map(catalog.tools.map((t) => [t.name, t]));
    for (const name of DESIGN_TOOL_ALLOWLIST) {
      const tool = byName.get(name);
      expect(tool, `${name} is not a catalog tool`).toBeDefined();
      expect(tool!.readOnly, `${name} must be read-only`).toBe(true);
    }
  });
});
```
In `agentCircuit.test.ts`, add a row to the existing profile table test: `['design', 'completed', null, 'needs_attention', 'neutral']` (match the file's own `it.each` shape). In `verdictProfile.contract.test.ts:18-53` add three assertions: `expect(src).not.toMatch(/['"]design['"]/); expect(src).not.toMatch(/isDesignProfile\(/); expect(src).not.toMatch(/DESIGN_/);`. In `runService.test.ts`, extend the `profileCaps` test (grep `max_concurrent_narrative_runs` in that file for the shape) with a `design` case asserting `windowMs: 86_400_000`, `maxPerWindow: 4`, `concurrentSkip: 'max_concurrent_design_runs'`, `rateSkip: 'design_rate'`. In `agentToolCatalog.contract.test.ts` add:
```ts
it('the designer preset is empty: it reaches reads by the guardrail rule and one outcome tool', () => {
  expect(AGENT_KIND_PRESETS.designer).toEqual([]);
  expect(buildAgentToolCatalog().presets.designer).toEqual([]);
});
```
In `scheduleService.test.ts` (grep `agent_kind_not_triage` for the fixture shape) add: a `design` create against a partner-wide `triage` agent → `agent_kind_not_designer`; a `sweep` create against a partner-wide `designer` agent → `agent_kind_not_triage`.
In `routes/aiAgents.test.ts` add: `PATCH /:id` on a `designer` agent with `{ mode: 'shadow' }` → 400 `{ error: 'mode_not_allowed_for_kind' }`.

Run: `cd apps/api && npx vitest run src/services/aiAgents/designProfile.test.ts src/services/aiAgents/agentCircuit.test.ts src/services/aiAgents/verdictProfile.contract.test.ts src/services/aiAgents/runService.test.ts src/services/aiAgents/agentToolCatalog.contract.test.ts src/services/aiAgents/scheduleService.test.ts src/routes/aiAgents.test.ts` → FAIL.

- [ ] **Step 2: `designProfile.ts`**

```ts
import { AI_AGENT_LIMIT_DEFAULTS, type AiAgentLimits, type AiAgentRunProfile } from '@breeze/shared';

/**
 * Fleet Designer (W01). The read-only drill-down floor a design run gets so
 * the model can check a function guess against one device — the evidence
 * bundle cannot carry every device's detail (spec §4.2, D6). Every name is a
 * tier-1 / read-only tier-2 catalog tool (designProfile.test.ts asserts it).
 * Floor, not intersection: the agent's own allowlist is ignored, like
 * narrativeToolAllowlist / sweepToolAllowlist.
 */
export const DESIGN_TOOL_ALLOWLIST = [
  'get_device_details', 'get_device_context', 'search_logs', 'get_script_details',
  'get_configuration_policy', 'get_playbook_history',
] as const;

export const DESIGN_OUTCOME_TOOL_NAME = 'submit_fleet_design';

export function isDesignProfile(run: { profile: AiAgentRunProfile }): boolean {
  return run.profile === 'design';
}

export function designLimits(limits: AiAgentLimits): AiAgentLimits {
  return {
    ...limits,
    maxTurnsPerRun: limits.designMaxTurns ?? AI_AGENT_LIMIT_DEFAULTS.designMaxTurns,
    maxBudgetCentsPerRun: limits.designBudgetCentsPerRun ?? AI_AGENT_LIMIT_DEFAULTS.designBudgetCentsPerRun,
    maxActionsPerRun: 0,
  };
}

export function designToolAllowlist(_agentAllowlist: string[]): string[] {
  return [...DESIGN_TOOL_ALLOWLIST, DESIGN_OUTCOME_TOOL_NAME];
}
```
If a name in `DESIGN_TOOL_ALLOWLIST` is not `readOnly` in the catalog (the test tells you), drop it and record the reason in the file docstring; do not widen.

- [ ] **Step 3: Admission with a window**

In `runService.ts` change `profileCaps`'s return type to `{ maxConcurrent: number; maxPerWindow: number; windowMs: number; concurrentSkip: AgentRunSkipReason; rateSkip: AgentRunSkipReason }`. Every existing arm gets `windowMs: 3_600_000` and `maxPerWindow` in place of `maxPerHour`. Add:
```ts
    case 'design':
      return {
        maxConcurrent: limits.maxConcurrentDesignRuns ?? AI_AGENT_LIMIT_DEFAULTS.maxConcurrentDesignRuns,
        maxPerWindow: limits.maxDesignRunsPerDay ?? AI_AGENT_LIMIT_DEFAULTS.maxDesignRunsPerDay,
        windowMs: 86_400_000,
        concurrentSkip: 'max_concurrent_design_runs',
        rateSkip: 'design_rate',
      };
```
At rule 6b (:1010-1025) replace `new Date(now - 3_600_000)` with `new Date(now - caps.windowMs)` and `caps.maxPerHour` with `caps.maxPerWindow`. Add `| 'max_concurrent_design_runs' | 'design_rate'` to `AgentRunSkipReason` with the same "not published" comment as the narrative pair. Add four inventory entries (:100-131 style) for the design limits. Also in the manual-trigger branch of admission: a `design` run must have `deviceId === null` and `kind === 'designer'`; add `if (profile === 'design' && (kind !== 'designer' || deviceId !== null)) return skip('ownership_mismatch');` next to the existing kind/ownership checks (~:1060-1075) so nothing but the designer can be admitted on this profile.

- [ ] **Step 4: Circuit and presets**

`agentCircuit.ts:127-129`: add `'design'` to `STREAK_NEUTRAL_PROFILES` and a paragraph to the docstring at :163-172 (design runs read and submit a report; their outcome says nothing about remediation).
`agentToolCatalog.ts:288-304`: add `designer: [],` with the comment `// Fleet Designer: reads by the guardrail rule, one outcome tool — never a mutating operation.`; `:416-420`: add `designer: [...AGENT_KIND_PRESETS.designer],`.

- [ ] **Step 5: Schedule-kind guard**

In `scheduleService.ts`: add `'agent_kind_not_designer'` to `ScheduleValidationCode` (:46-66). Rename `assertPartnerWideTriageAgent` to `assertPartnerWideScheduledAgent(agentId: string, partnerId: string, kind: AiAgentScheduleKind)` and replace the kind check with:
```ts
  const required = kind === 'design' ? 'designer' : 'triage';
  if (agent.kind !== required) {
    throw new ScheduleValidationError(
      required === 'designer' ? 'agent_kind_not_designer' : 'agent_kind_not_triage',
      required === 'designer' ? 'A design schedule must target a designer agent' : 'Only a triage agent can be scheduled',
    );
  }
```
Update the call site(s) (grep `assertPartnerWideTriageAgent`) to pass the create body's `kind`. Extend `assertValidCron` with `if (kind === 'design' && !isMonthlyOrRarerLiteralCron(cron)) throw new ScheduleValidationError('invalid_cron_for_kind', 'a design schedule fires at most once a month …')` and `assertPartnerKindsForScheduleKind` so `design` behaves like `narrative` (sweepKinds must be empty). In `routes/aiAgentSchedules.ts` map the new code to 400 wherever `agent_kind_not_triage` is mapped.

- [ ] **Step 6: Designer modes at the routes**

In `routes/aiAgents.ts` `PATCH /:id`: after loading the existing agent and before the update, `if (body.mode !== undefined && !allowedModesForKind(agent.kind).includes(body.mode)) return c.json({ error: 'mode_not_allowed_for_kind' }, 400);`. `POST /` is covered by the shared schema's superRefine (Task 2) — add a route test that `{ kind: 'designer', mode: 'shadow' }` returns 400 with the zod issue at `mode`.

- [ ] **Step 7: Run, typecheck, commit**

Run the Step 1 test list plus `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json` in `apps/api`. Expected: PASS; tsc now fails only in `outcomeTools.ts` (Task 7).

```bash
git add apps/api/src/services/aiAgents apps/api/src/routes/aiAgents.ts apps/api/src/routes/aiAgentSchedules.ts
git commit -m "feat(api): design profile floor and limits, windowed admission caps, designer schedule guard"
```

### Task 6: Evidence bundle

**Files:**
- Create: `apps/api/src/services/aiAgents/designEvidence.ts`, `apps/api/src/services/aiAgents/designEvidence.test.ts`

**Interfaces:**
- Produces: `DESIGN_EVIDENCE_HARD_LIMIT_BYTES = 192 * 1024`, `DESIGN_EVIDENCE_MAX_DEVICES = 2000`, `DESIGN_EVIDENCE_BOUNDS` (per-section caps), `interface DesignEvidence`, `type RawDesignEvidence`, `assembleDesignEvidence(raw, opts?): DesignEvidence`, `loadDesignEvidence(orgId, opts: { siteId?: string | null }): Promise<DesignEvidence>`, `designBaselineNumbers(evidence): FleetDesignBaselineNumbers`.
- Consumes: `FLEET_DESIGN_PRECURSOR_THRESHOLDS`, `sanitizeSweepText` (`sweepEvidence.ts`), `settled` idiom (`narrativeContext.ts:1148-1153` — copy it, it is module-private), `getManagementPostureSummary` (`managementPostureReport.ts:192`), `MANAGEMENT_POSTURE_CATEGORIES` (`routes/agents/schemas.ts:607`), `listReliabilityDevices` (`reliabilityScoring.ts:1641`), `fetchFleetFindingRows` + `computeStats` (`vulnerabilityFleetQueries.ts:25`, `vulnerabilityFleetAggregation.ts:173`), `getSecurityPostureTrend` (`securityPosture.ts:1077`), `listFeatureLinks` (`configurationPolicy.ts:1697`), `listAssignmentsForTarget` (`:2051`).

- [ ] **Step 1: Failing assembler tests**

`designEvidence.test.ts` (pure, no DB):
```ts
import { describe, expect, it } from 'vitest';
import { FLEET_DESIGN_PRECURSOR_THRESHOLDS } from '@breeze/shared';
import { DESIGN_EVIDENCE_HARD_LIMIT_BYTES, DESIGN_EVIDENCE_MAX_DEVICES, assembleDesignEvidence, designBaselineNumbers, type RawDesignEvidence } from './designEvidence';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
function raw(overrides: Partial<RawDesignEvidence> = {}): RawDesignEvidence {
  return {
    org: { name: 'Acme', partnerName: 'MSP', timezone: 'UTC', siteName: null },
    devices: [{ id: uuid(1), hostname: 'FS01', displayName: null, osType: 'windows', osVersion: '2022', role: 'server', roleSource: 'auto', lastSeenAt: '2026-09-11T00:00:00Z', status: 'online', siteName: 'HQ', groupNames: ['Servers'], tags: ['file'], customFields: { rack: 'A1' }, pendingReboot: false, reliabilityScore: 92 }],
    devicesTotal: 1,
    software: [], services: [], network: { assets: [], topology: [], baselines: 0, openChanges: [] },
    posture: [], health: { reliabilityWorst: [], fleetFindings: [], vulnerability: null, patching: null, backups: null, cis: null },
    configuration: { policies: [], assignments: [], alertTemplates: [] },
    automation: { playbooks: [], scripts: [] },
    logs: [], window: { start: '2026-06-13', end: '2026-09-11' },
    counts: { alerts90d: 0, tickets90d: 0, endpoints: 1 },
    precursors: { diskOver: 0, rebootPending: 0, rebootPendingOver: 0, patchAgeOver: 0, certificateExpiring: null, backupMissed: 0, serviceRestartsOver: 0 },
    unavailable: [],
    ...overrides,
  };
}

describe('assembleDesignEvidence', () => {
  it('projects display fields only and never a jsonb blob', () => {
    const e = assembleDesignEvidence(raw());
    expect(e.devices[0]).not.toHaveProperty('managementPosture');
    expect(JSON.stringify(e)).not.toContain('customFields":{');
    expect(e.devices[0]!.customFields).toBe('rack=A1');
  });
  it('caps devices at the bound and reports the rest as not assessed', () => {
    const many = Array.from({ length: DESIGN_EVIDENCE_MAX_DEVICES + 5 }, (_, i) => ({ ...raw().devices[0]!, id: uuid(i + 1), hostname: `D${i}` }));
    const e = assembleDesignEvidence(raw({ devices: many, devicesTotal: many.length }));
    expect(e.devices).toHaveLength(DESIGN_EVIDENCE_MAX_DEVICES);
    expect(e.devicesNotAssessed).toBe(5);
    expect(e.deviceIds.size).toBe(DESIGN_EVIDENCE_MAX_DEVICES);
  });
  it('trims software, then services, then network, then logs before devices to meet the byte ceiling', () => {
    const big = raw({
      software: Array.from({ length: 500 }, (_, i) => ({ name: `App ${i} ${'x'.repeat(200)}`, vendor: 'V', versions: 3, deviceCount: 2 })),
      logs: Array.from({ length: 500 }, (_, i) => ({ eventId: String(i), source: 'S'.repeat(200), level: 'error', count: 9, deviceCount: 3 })),
    });
    const e = assembleDesignEvidence(big, { limitBytes: 32 * 1024 });
    expect(Buffer.byteLength(JSON.stringify(e), 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(e.truncated).toBe(true);
    expect(e.devices).toHaveLength(1);
  });
  it('computes baseline numbers with the frozen thresholds', () => {
    const e = assembleDesignEvidence(raw({ counts: { alerts90d: 126, tickets90d: 21, endpoints: 100 }, precursors: { ...raw().precursors, diskOver: 4, certificateExpiring: null } }));
    const n = designBaselineNumbers(e);
    expect(n.alertsPer100EndpointsPerMonth).toBe(42);
    expect(n.ticketsPerMonth).toBe(7);
    expect(n.precursors.find((p) => p.condition === 'disk_used_over_threshold')?.deviceCount).toBe(4);
    expect(n.precursors.find((p) => p.condition === 'certificate_expiring')?.deviceCount).toBeNull();
    expect(e.thresholds).toEqual(FLEET_DESIGN_PRECURSOR_THRESHOLDS);
  });
  it('marks a failed loader as unavailable rather than inventing zeros', () => {
    const e = assembleDesignEvidence(raw({ unavailable: ['software'] }));
    expect(e.unavailable).toEqual(['software']);
  });
});
```
Run → FAIL.

- [ ] **Step 2: Implement `designEvidence.ts`**

Shape (write it in full; every loader is a private `async function loadX(orgId, siteId, window)` wrapped in `settled`, run sequentially under the caller's system context exactly like `loadNarrativeContext`):
```ts
export const DESIGN_EVIDENCE_HARD_LIMIT_BYTES = 192 * 1024;
export const DESIGN_EVIDENCE_MAX_DEVICES = 2000;
export const DESIGN_EVIDENCE_BOUNDS = Object.freeze({
  software: 500, services: 2000, networkAssets: 2000, topology: 2000, openChanges: 200,
  reliabilityWorst: 50, fleetFindings: 200, policies: 100, alertTemplates: 200, playbooks: 200, scripts: 1000, logs: 500,
});

export interface DesignEvidenceDevice {
  id: string; hostname: string; osType: string; osVersion: string | null; role: string; roleSource: string;
  lastSeenAt: string | null; status: string; siteName: string | null; groupNames: string[]; tags: string[];
  customFields: string; pendingReboot: boolean; reliabilityScore: number | null;
}
export interface DesignEvidence {
  org: { name: string; partnerName: string; timezone: string; siteName: string | null };
  window: { start: string; end: string };
  devices: DesignEvidenceDevice[];
  deviceIds: ReadonlySet<string>;
  devicesTotal: number;
  devicesNotAssessed: number;
  software: { name: string; vendor: string | null; versions: number; deviceCount: number }[];
  services: { deviceId: string; watchType: string; name: string; status: string; restarts30d: number }[];
  network: { assets: { ip: string; type: string; hostname: string | null; openPorts: number[]; linkedDeviceId: string | null }[]; topology: { source: string; target: string; connectionType: string | null }[]; baselines: number; openChanges: { eventType: string; detectedAt: string }[] };
  posture: { category: string; product: string; managedCount: number; staleCount: number }[];
  health: { reliabilityWorst: { deviceId: string; score: number; trend: string | null }[]; fleetFindings: { kind: string; title: string; deviceCount: number }[]; vulnerability: { critical: number; high: number; devicesAffected: number } | null; patching: { patchScore: number | null; devicesPending: number; pendingPatches: number } | null; backups: { ok: number; failed: number; missed: number; devicesFailed: number } | null; cis: { devicesAssessed: number; avgScore: number | null } | null };
  configuration: { policies: { id: string; name: string; status: string; ownerScope: 'organization' | 'partner'; watches: { name: string; watchType: string; enabled: boolean }[]; rules: { name: string; severity: string; cooldownMinutes: number }[] }[]; assignments: { policyId: string; level: string; targetId: string; priority: number; roleFilter: string[] | null }[]; alertTemplates: { id: string; name: string; category: string | null; severity: string; isBuiltIn: boolean }[] };
  automation: { playbooks: { id: string; name: string; isBuiltIn: boolean; category: string | null }[]; scripts: { id: string; name: string; language: string; osTypes: string[]; tags: string[]; legacyImport: boolean; description: string }[] };
  logs: { eventId: string; source: string; level: string; count: number; deviceCount: number }[];
  counts: { alerts90d: number; tickets90d: number; endpoints: number };
  precursors: { diskOver: number; rebootPending: number; rebootPendingOver: number; patchAgeOver: number; certificateExpiring: number | null; backupMissed: number; serviceRestartsOver: number };
  thresholds: typeof FLEET_DESIGN_PRECURSOR_THRESHOLDS;
  unavailable: string[];
  truncated: boolean;
}
export type RawDesignEvidence = Omit<DesignEvidence, 'deviceIds' | 'devicesNotAssessed' | 'thresholds' | 'truncated'> & { devices: (Omit<DesignEvidenceDevice, 'customFields'> & { displayName: string | null; customFields: Record<string, unknown> | null })[] };
```
`assembleDesignEvidence(raw, opts = {})`: sanitize every string with `sanitizeSweepText(s, 256)`; `customFields` → `Object.entries(cf ?? {}).slice(0, 8).map(([k, v]) => `${k}=${String(v).slice(0, 40)}`).join(', ')`; slice each list to its bound; `devices = raw.devices.slice(0, DESIGN_EVIDENCE_MAX_DEVICES)`, `devicesNotAssessed = raw.devicesTotal - devices.length`; `deviceIds = new Set(devices.map(d => d.id))`; then the trim loop over the serialized object in the order software → services → network.assets → network.topology → logs → posture → automation.scripts → configuration.policies, dropping the last element of the largest of the current victim list until under `opts.limitBytes ?? DESIGN_EVIDENCE_HARD_LIMIT_BYTES`; devices are never trimmed by bytes (the device bound is the only device cap); set `truncated = true` whenever anything was dropped.

`designBaselineNumbers(e)`: `alertsPer100EndpointsPerMonth = e.counts.endpoints > 0 ? Math.round((e.counts.alerts90d / 3) / e.counts.endpoints * 100) : null`; `ticketsPerMonth = Math.round(e.counts.tickets90d / 3)`; precursors in the fixed order `disk_used_over_threshold, reboot_pending_over_threshold, patch_age_over_threshold, certificate_expiring, backup_missed, service_restarted_over_threshold` mapping `e.precursors` (null stays null).

`loadDesignEvidence(orgId, { siteId })` loaders (all `WHERE org_id = $org` and, when `siteId`, `AND site_id = $site` on `devices`; every join re-predicates `org_id`):
- `loadDevices`: `devices` LEFT JOIN `sites` (name) LEFT JOIN `device_reliability` (score), plus `string_agg` of group names via `device_group_memberships` JOIN `device_groups` (both org-pinned); exclude `is_ephemeral`, `status = 'decommissioned'`; `ORDER BY last_seen_at DESC NULLS LAST LIMIT DESIGN_EVIDENCE_MAX_DEVICES + 1`; `devicesTotal` from a separate `count(*)`.
- `loadSoftware`: the aggregate from `routes/softwareInventory.ts:304-317` restricted to org (+site through the devices join), `ORDER BY device_count DESC LIMIT 500`.
- `loadServices`: `DISTINCT ON (device_id, watch_type, name)` over `service_process_check_results` (as `sweepEvidence.ts:371`), all statuses, latest per watch, `LIMIT 2000`; `restarts30d` from a second grouped query `count(*) FILTER (WHERE auto_restart_attempted)` over 30 days.
- `loadNetwork`: `discovered_assets` (ip, asset_type, hostname, `open_ports` reduced to a number[] of ports, `linked_device_id`) LIMIT 2000; `network_topology` LIMIT 2000; `count(*)` of `network_baselines`; unacknowledged `network_change_events` LIMIT 200.
- `loadPosture`: for each `MANAGEMENT_POSTURE_CATEGORIES` entry, `getManagementPostureSummary({ category, stalenessDays: 14, scope: eq(devices.orgId, orgId) })`, flattening `totals`/`orgs[0]` into `{ category, product, managedCount, staleCount }` rows.
- `loadHealth`: `listReliabilityDevices({ orgId, siteIds: siteId ? [siteId] : undefined, limit: 50, sortBy: 'score', sortDir: 'asc' })` (adapt to the filter's real field names); `fleet_findings` open rows grouped by kind (direct query, org-pinned); `computeStats(await fetchFleetFindingRows({ status: 'open', orgId }), new Date())`; `getSecurityPostureTrend({ orgId, days: 14 })` last point; `backup_jobs` 30-day terminal counts + `backup_sla_events` unresolved `missed_backup` distinct devices; CIS from the `aiToolsCisBenchmark.ts:66` query shape.
- `loadConfiguration`: `configuration_policies` where `org_id = $org OR (org_id IS NULL AND partner_id = <org's partner_id>)`, status ≠ archived, LIMIT 100; for each `listFeatureLinks(policyId)` and project monitoring watches and alert-rule items; `listAssignmentsForTarget('organization', orgId)` plus device_group-level assignments for the org's groups; `alert_templates` with the same owner predicate or `is_built_in`, LIMIT 200.
- `loadAutomation`: `playbook_definitions` where `is_built_in OR org_id = $org`, active; `scripts` where `deleted_at IS NULL AND (org_id = $org OR (org_id IS NULL AND partner_id = <partner>))` LIMIT 1000, tags via `script_to_tags` JOIN `script_tags`; `legacyImport = tags.includes('legacy-import')`; `description` cut to 200 chars.
- `loadLogs`: `device_event_logs` JOIN `devices` (org-pinned) over 30 days, `GROUP BY event_id, source, level ORDER BY count(*) DESC LIMIT 500`.
- `loadCounts`: `alerts` created in 90 days; `tickets` created in 90 days with `deleted_at IS NULL`; endpoints = live device count.
- `loadPrecursors`: `device_disks.used_percent >= thresholds.diskUsedPercent` distinct devices; `devices.pending_reboot`; `pending_reboot AND reboot_scheduled_at < now() - interval '7 days'`; `device_patches` status pending JOIN `patches.release_date < now() - 30 days` distinct devices; `certificateExpiring: null` (no source — spec §4.3 "where known"); `backup_sla_events` unresolved `missed_backup`; `service_process_check_results` grouped `(device_id, name) HAVING count(*) FILTER (WHERE auto_restart_attempted) > thresholds.serviceRestartsPer30d`.
Any loader whose `settled` returns null pushes its section name into `unavailable` and its section becomes empty / null (the `unsure` prompt tells the model which inputs were not measured).

- [ ] **Step 3: Run tests, typecheck, commit**

Run: `cd apps/api && npx vitest run src/services/aiAgents/designEvidence.test.ts && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`

```bash
git add apps/api/src/services/aiAgents/designEvidence.ts apps/api/src/services/aiAgents/designEvidence.test.ts
git commit -m "feat(api): bounded fleet design evidence bundle"
```

### Task 7: `submit_fleet_design`, run context, floor wiring, prompt

**Files:**
- Modify: `apps/api/src/services/aiAgents/outcomeTools.ts:45-53` (names), `:108-134` (`outcomeToolsForProfile`), `validateOutcomeToolInput` overloads (:138-190), `buildOutcomeSdkTools` (:400-470)
- Modify: `apps/api/src/services/aiAgents/runLoopTypes.ts` (`RunContext.design`, outcome fields after :247)
- Modify: `apps/api/src/services/aiAgents/runLoop.ts:438-446` (context load), `:810-816` (read-only denial), `:996-1002` (post-hook capture), `:1309-1325` (prompt context), `:1365-1386` (limits/allowlist), `:1546-1548` (SDK tools), `:1849-1855` (`producedSomething`), `:2104-2121` (`watches`/`notifies`)
- Modify: `apps/api/src/services/aiAgents/runnerPrompt.ts` (`AgentRunDesignPromptContext`, mode section after :351, binding clause :410-412, output clause :436-443, `buildFleetDesignTaskPrompt`, dispatch at :1002)
- Tests: `outcomeTools.test.ts`, `runnerPrompt.test.ts` (extend)

**Interfaces:**
- Produces: `OUTCOME_TOOL_NAMES` gains `'submit_fleet_design'`; `outcomeToolsForProfile('design') === ['submit_fleet_design']`; `validateOutcomeToolInput('submit_fleet_design', input, refs: FleetDesignOutcomeRefs): FleetDesignOutcome`; `buildOutcomeSdkTools(names, refs?: { design?: FleetDesignOutcomeRefs })`; `RunContext.design: { scheduleId: string | null; occurrenceKey: string | null; siteId: string | null; evidence: DesignEvidence } | null`; outcome `fleetDesign?: FleetDesignOutcome`, `fleetDesignReport?: { reportId: string; reportRunId: string }`; `buildFleetDesignTaskPrompt(ctx)`.

- [ ] **Step 1: Failing tests**

`outcomeTools.test.ts` additions:
```ts
it('exposes submit_fleet_design to the design profile only', () => {
  expect(outcomeToolsForProfile('design')).toEqual(['submit_fleet_design']);
  for (const p of ['full', 'verdict', 'sweep', 'narrative', 'triage'] as const) expect(outcomeToolsForProfile(p)).not.toContain('submit_fleet_design');
});
it('submit_fleet_design validates structure and references inside the tool', async () => {
  const refs = { deviceIds: new Set([D1]), baseline: { alertsPer100EndpointsPerMonth: null, ticketsPerMonth: null, precursors: [] }, generatedAt: '2026-09-12T00:00:00.000Z' };
  const [tool] = buildOutcomeSdkTools(['submit_fleet_design'], { design: refs });
  await expect(tool!.handler({ found: {} }, {})).rejects.toThrow(); // structural
  const bad = validSubmission(); bad.functions[0]!.deviceIds = [D2];
  await expect(tool!.handler(bad, {})).rejects.toThrow(/deviceIds\[0\]/); // referential
  const res = await tool!.handler(validSubmission(), {});
  expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual({ status: 'recorded' });
});
it('building submit_fleet_design without refs throws (the loop must pass evidence)', () => {
  expect(() => buildOutcomeSdkTools(['submit_fleet_design'])).toThrow(/design refs/);
});
```
(reuse `validSubmission()` from the shared test by copying it into a local helper; `tool.handler` is the SDK tool's callback — check how the file's existing tests invoke a built tool and use that accessor.)

`runnerPrompt.test.ts` addition: `buildFleetDesignTaskPrompt` output contains `Trigger: manual fleet design` (or `design schedule (<occurrence>)`), the eight section keys in order, the line `Rationale is required on every watch and rule`, and never a raw device jsonb — assert `not.toContain('managementPosture')`.

Run: `cd apps/api && npx vitest run src/services/aiAgents/outcomeTools.test.ts src/services/aiAgents/runnerPrompt.test.ts` → FAIL.

- [ ] **Step 2: `outcomeTools.ts`**

- Add `'submit_fleet_design'` to `OUTCOME_TOOL_NAMES` and `OUTCOME_MCP_TOOL_NAMES`.
- `outcomeToolsForProfile`: `case 'design': return ['submit_fleet_design'];`.
- Overload: `export function validateOutcomeToolInput(toolName: 'submit_fleet_design', input: unknown, refs: FleetDesignOutcomeRefs): FleetDesignOutcome;` implementation arm:
```ts
    case 'submit_fleet_design': {
      if (!refs) throw new Error('[validateOutcomeToolInput] submit_fleet_design needs design refs');
      // `.parse` first (the message names the offending path — the model
      // reads it back as the tool error), then the referential pass, which
      // throws FleetDesignReferenceError with the same path discipline.
      return fleetDesignOutcomeFromSubmission(fleetDesignSubmissionSchema.parse(input), refs);
    }
```
- `buildOutcomeSdkTools(names, refs?: { design?: FleetDesignOutcomeRefs })`: the `submit_fleet_design` case builds the tool with the raw shape `SUBMIT_FLEET_DESIGN_SHAPE` (a `z.object` shape mirroring `fleetDesignSubmissionSchema`'s top-level keys with `.describe()` on each — keys only, the handler does the real validation) and:
```ts
      case 'submit_fleet_design': {
        const design = refs?.design;
        if (!design) throw new Error('[buildOutcomeSdkTools] submit_fleet_design requires design refs');
        return tool(
          'submit_fleet_design',
          'Record the Fleet Design for this organization: all eight sections exactly once. Every watch and '
          + 'alert rule needs a rationale. Device ids must come from the evidence. Call exactly once, as your last action.',
          SUBMIT_FLEET_DESIGN_SHAPE,
          async (input) => {
            validateOutcomeToolInput('submit_fleet_design', input, design); // throws → model retries
            return { content: [{ type: 'text', text: JSON.stringify({ status: 'recorded' }) }] };
          },
        ) as SdkTool;
      }
```

- [ ] **Step 3: `runLoopTypes.ts` and `runLoop.ts`**

`runLoopTypes.ts`: add to `RunContext` (next to `narrative`) `design: { scheduleId: string | null; occurrenceKey: string | null; siteId: string | null; evidence: DesignEvidence } | null;` and to the outcome type after `narrativeReport` (:247):
```ts
  /** Fleet Designer (W01) — the validated, server-built design; set once by the post-tool hook. */
  fleetDesign?: FleetDesignOutcome;
  /** Fleet Designer (W01) — the report the design was materialised into (finalizeFleetDesign). */
  fleetDesignReport?: { reportId: string; reportRunId: string };
```
`runLoop.ts`:
- Context load (after :446):
```ts
    let design: RunContext['design'] = null;
    if (isDesignProfile(run as RunRow)) {
      const ref = (run.triggerRef ?? {}) as { occurrenceKey?: unknown; siteId?: unknown };
      const siteId = typeof ref.siteId === 'string' ? ref.siteId : null;
      design = {
        scheduleId: run.scheduleId ?? null,
        occurrenceKey: typeof ref.occurrenceKey === 'string' ? ref.occurrenceKey : null,
        siteId,
        evidence: await loadDesignEvidence(run.orgId, { siteId }),
      };
    }
```
  Fail the run (throw, so it finishes `failed` with the runner error) if `design.evidence.devices.length === 0 && design.evidence.unavailable.includes('devices')` — the spec's "a run only fails when the device section itself cannot be assembled".
- Read-only denial (:810-816): add `|| isDesignProfile(run)` to the condition.
- Post-hook capture (:996-1002): `case 'submit_fleet_design': outcome.fleetDesign = validateOutcomeToolInput(toolName, input, designRefs(ctx)); break;` where `designRefs(ctx)` returns `{ deviceIds: ctx.design!.evidence.deviceIds, baseline: designBaselineNumbers(ctx.design!.evidence), generatedAt: new Date().toISOString() }` (compute once per run and reuse for the SDK tool below).
- Limits/allowlist (:1365-1386): add `const design = isDesignProfile(run);` and the `design ? designLimits(limits) : …` / `design ? designToolAllowlist(effective.toolAllowlist) : …` arms.
- SDK tools (:1546-1548): `buildOutcomeSdkTools(outcomeToolsForRun(run), ctx.design ? { design: designRefs(ctx) } : undefined)`.
- `producedSomething` (:1849-1855): `|| outcome.fleetDesign !== undefined`.
- Finalize row (:1798-1805): call `finalizeFleetDesign(ctx, result)` (Task 8) and thread its error code into the `?? ` chain at :1887-1892.
- `watches` (:2104-2121): exclude design like narrative; `notifies` stays true.
- Prompt context (:1309-1325): `design: ctx.design ? { trigger: ctx.design.scheduleId ? 'schedule' : 'manual', occurrenceKey: ctx.design.occurrenceKey, evidence: ctx.design.evidence } : null`.

- [ ] **Step 4: `runnerPrompt.ts`**

Add `export interface AgentRunDesignPromptContext { trigger: 'manual' | 'schedule'; occurrenceKey: string | null; evidence: DesignEvidence }` and `design: AgentRunDesignPromptContext | null` on `AgentRunPromptContext`. Mode section (after the narrative arm at :351):
```ts
  } else if (ctx.profile === 'design') {
    sections.push(
      '## Mode: fleet design\n'
      + 'You are designing what ONE organization should be monitored for, from evidence the system has '
      + 'already collected. You may verify a guess with the read-only tools you have; you cannot change '
      + 'anything. Every proposal is data for a technician to approve. Finish by calling '
      + 'submit_fleet_design exactly once — that call IS the output of this run.',
    );
```
Binding clause (:410-412) and output clause (:436-443): add `ctx.profile === 'design'` arms mirroring the narrative text ("Use only the evidence and what the tools return; never invent a device, a service or a number").
`buildFleetDesignTaskPrompt(ctx)`: render the evidence as compact labelled lines — org header, window, device table (id, hostname, os, role, site, groups, tags, custom fields, last seen, reliability), then each section with its rows, `Not measured: <unavailable list>`, `<n> devices beyond the bound were not assessed`; then:
```
## Write these eight sections, in this order
found: what the fleet is (counts by role and inferred function, sites, topology, who else manages it) and the fleet-wide findings ranked by device count, each with evidence refs.
functions: one entry per device function you are confident about (>= 0.6). Every device id must come from the device table above. A device belongs to one function.
monitoring: per function, the watches (service/process) and alert rules with thresholds, cooldown, action and paging. Rationale is required on every watch and rule — say why THIS fleet needs it.
retired: watches and rules in the current configuration that the design does not carry forward, each with a reason. Empty is valid.
automation: per function, built-in playbooks by name or a custom playbook described in prose, and scripts you propose (full content).
legacy: for each script tagged legacy-import, its intent and bucket (obsolete | covered | needed); empty when none.
baseline: notes only — the numbers are computed by the system.
unsure: functions below the threshold, unreachable devices, findings that need a human, and any coarse-role correction (billing-relevant).
## Rules
Use ONLY the evidence above and what your tools return. Never invent a device, service, event id, threshold or count. Prefer fewer rules with a reason over many "just in case" rules. Plain English in rationales; no markdown markers, no links.
Call submit_fleet_design exactly once, then stop.
```
Dispatch: `if (ctx.profile === 'design') return buildFleetDesignTaskPrompt(ctx);` beside :1002.

- [ ] **Step 5: Run, typecheck, commit**

Run the Step 1 tests plus `npx vitest run src/services/aiAgents/runLoop` and tsc. Expected: PASS; tsc clean except `finalizeFleetDesign` (Task 8).

```bash
git add apps/api/src/services/aiAgents
git commit -m "feat(api): submit_fleet_design outcome tool, design run context and prompt"
```

### Task 8: Persistence and stored-artifact-only plumbing

**Files:**
- Create: `apps/api/src/services/aiAgents/fleetDesignReport.ts`, `apps/api/src/services/aiAgents/fleetDesignReport.test.ts`
- Modify: `apps/api/src/services/aiAgents/runFinalizers.ts` (add `finalizeFleetDesign` after :295)
- Modify: `apps/api/src/services/reportGenerationService.ts:19-36` (union), `:781-782` + `:825-826` (throw arms); `apps/api/src/routes/reports/schemas.ts:13-34`; `apps/api/src/jobs/reportScheduleWorker.ts:147`; `apps/api/src/routes/reports/helpers.ts` (`isSystemManagedReportDefinition` — add the type)

**Interfaces:**
- Produces: `FLEET_DESIGN_REPORT_TYPE = 'ai_fleet_design'`, `FLEET_DESIGN_REPORT_NAME = 'Fleet Design'`, `FleetDesignPersistConflictError`, `persistFleetDesignReport(input): Promise<{ reportId; reportRunId; downloadPath }>`, `projectFleetDesign(run, outcome, artifact): AiAgentRunFleetDesignDto | null`, `fleetDesignArtifactProjection`, `loadFleetDesignReport(reportRunId, orgCondition): Promise<{ reportRunId; reportId; orgId; summary: FleetDesignReportSummary; generatedAt } | null>`; `finalizeFleetDesign(ctx, result): Promise<string | null>` with codes `design_missing | design_persist_conflict | design_persist_failed`.

- [ ] **Step 1: Failing unit test**

`fleetDesignReport.test.ts` (Drizzle mock as in `narrativeReport.test.ts` — copy its harness):
```ts
it('persists one definition per org keyed on the type and one artifact per run, then CAS-links the run', async () => {
  // arrange the mocked db as narrativeReport.test.ts does for the happy path
  const out = await persistFleetDesignReport({ run: { id: RUN, orgId: ORG, agentId: AGENT, scheduleId: null }, agent: { id: AGENT, name: 'Designer' }, evidence: evidenceFixture, outcome: outcomeFixture });
  expect(insertSpy.reports.values).toMatchObject({ orgId: ORG, type: 'ai_fleet_design', name: 'Fleet Design', schedule: 'one_time', format: 'pdf', createdBy: null, executionScopePrincipalKind: 'system' });
  expect(insertSpy.reports.onConflict).toMatchObject({ target: ['org_id'], where: expect.stringContaining("type = 'ai_fleet_design'") });
  expect(insertSpy.reportRuns.values.result.summary.fleetDesign.outcome.schemaVersion).toBe(1);
  expect(insertSpy.reportRuns.values.requestedByKind).toBe('system');
  expect(out.downloadPath).toBe(`/api/reports/runs/${out.reportRunId}/download`);
});
it('throws FleetDesignPersistConflictError when the run already carries an artifact', …);
it('projectFleetDesign returns counts and paths, null when no outcome', …);
```
Run → FAIL.

- [ ] **Step 2: `fleetDesignReport.ts`**

Copy `narrativeReport.ts` wholesale and change: constants (`FLEET_DESIGN_REPORT_TYPE = 'ai_fleet_design' as const`, `FLEET_DESIGN_REPORT_NAME = 'Fleet Design'`); `NarrativePersistInput` → `FleetDesignPersistInput { run: { id; orgId; agentId; scheduleId: string | null }; agent: { id; name }; evidence: DesignEvidence; outcome: FleetDesignOutcome }`; the definition upsert:
```ts
    await db.insert(reports).values({
      orgId: run.orgId,
      name: FLEET_DESIGN_REPORT_NAME,
      type: FLEET_DESIGN_REPORT_TYPE,
      config: { source: 'ai_agent', agentId: agent.id, scheduleId: run.scheduleId },
      schedule: 'one_time',
      format: 'pdf',
      createdBy: null,
      sourceAiAgentScheduleId: run.scheduleId,
      ...scopeValues,
    }).onConflictDoNothing({ target: [reports.orgId], where: sql`${reports.type} = 'ai_fleet_design'` });
    const [definition] = await db.select({ id: reports.id }).from(reports)
      .where(and(eq(reports.orgId, run.orgId), eq(reports.type, FLEET_DESIGN_REPORT_TYPE))).limit(1);
```
the summary:
```ts
    const summary: FleetDesignReportSummary = {
      fleetDesign: {
        schemaVersion: outcome.schemaVersion,
        outcome,
        orgName: flattenLine(evidence.org.name), partnerName: flattenLine(evidence.org.partnerName),
        siteName: evidence.org.siteName ? flattenLine(evidence.org.siteName) : null,
        generatedAt: generatedAt.toISOString(), runId: run.id, agentName: flattenLine(agent.name),
        evidenceTruncated: evidence.truncated, devicesNotAssessed: evidence.devicesNotAssessed,
      },
    };
```
Keep the lock, CAS on `report_run_id IS NULL`, `lastGeneratedAt` stamp and `downloadPath` exactly as the narrative. `projectFleetDesign(run, outcome, artifact)` returns `{ reportRunId, reportId, downloadPath, generatedAt, functionCount: sections.functions.length, watchCount: sum of watches, ruleCount: sum of alertRules, evidenceTruncated }` or null. `loadFleetDesignReport(reportRunId, orgCondition)` selects `reportRuns` JOIN `reports` where `reports.type = 'ai_fleet_design'` and the caller's `orgCondition(reports.orgId)`, returning the summary (used by Task 12 and W03).

- [ ] **Step 3: `finalizeFleetDesign`**

In `runFinalizers.ts`, after `finalizeNarrative`:
```ts
export async function finalizeFleetDesign(ctx: RunContext, result: LoopResult): Promise<string | null> {
  if (!isDesignProfile(ctx.run)) return null;
  const { outcome } = result;
  if (!outcome.fleetDesign) return 'design_missing';
  if (!ctx.design) return 'design_missing';
  if (!(await isRunStillRunning(ctx.run.id, ctx.run.orgId))) return null;
  try {
    const { reportId, reportRunId } = await persistFleetDesignReport({
      run: { id: ctx.run.id, orgId: ctx.run.orgId, agentId: ctx.run.agentId, scheduleId: ctx.design.scheduleId },
      agent: { id: ctx.agent.id, name: ctx.agent.name },
      evidence: ctx.design.evidence,
      outcome: outcome.fleetDesign,
    });
    outcome.fleetDesignReport = { reportId, reportRunId };
    return null;
  } catch (error) {
    if (error instanceof FleetDesignPersistConflictError) return 'design_persist_conflict';
    console.error('[aiAgentRunLoop] failed to persist the fleet design report', { runId: ctx.run.id, error });
    return 'design_persist_failed';
  }
}
```
Unlike the narrative, a missing schedule is NOT an error: manual runs persist too.

- [ ] **Step 4: Stored-artifact-only plumbing**

`reportGenerationService.ts`: add `| 'ai_fleet_design'` to `ReportType` and `case 'ai_fleet_design': throw new StoredArtifactOnlyReportError(type);` in BOTH switches. `routes/reports/schemas.ts`: add to `reportTypeSchema` and `INTERNAL_REPORT_TYPES`. `jobs/reportScheduleWorker.ts:147`: `['ai_org_narrative', 'ai_fleet_design'] as const`. `routes/reports/helpers.ts` `isSystemManagedReportDefinition`: include the type (mirror `ReportsList.tsx:41-53`).

- [ ] **Step 5: Run, typecheck, commit**

Run: `cd apps/api && npx vitest run src/services/aiAgents/fleetDesignReport.test.ts src/services/aiAgents/runFinalizers src/services/reportGenerationService src/routes/reports src/jobs/reportScheduleWorker && tsc`

```bash
git add apps/api/src/services/aiAgents apps/api/src/services/reportGenerationService.ts apps/api/src/routes/reports apps/api/src/jobs/reportScheduleWorker.ts
git commit -m "feat(api): persist fleet design as a system-authored report artifact"
```

### Task 9: Run-detail projection and notification

**Files:**
- Modify: `apps/api/src/services/aiAgents/runTrace.ts:138-143` (+ `RunTraceFleetDesignArtifactInput`), `:381-384` (7th param), `:443-454`
- Modify: `apps/api/src/services/aiAgents/runFinishedNotify.ts:163-179`, `:464-511`, `:568-575`
- Modify: `apps/api/src/routes/aiAgents.ts:1323-1354`, `:1409-1418`
- Tests: `runTrace.test.ts`, `runFinishedNotify.test.ts`, `routes/aiAgents.test.ts` (extend)

- [ ] **Step 1: Failing tests**

`runFinishedNotify.test.ts`: a completed `design` run with `outcome.fleetDesignReport` notifies with title `Fleet Design ready — <org>`, link `/ai-agents/fleet-design#<reportRunId>`, priority null, `metadata.fleetDesign.reportRunId`. `runTrace.test.ts`: `buildRunTrace(...)` on a design run yields `fleetDesign.functionCount` and `reportRunId`; on a triage run `fleetDesign === null`. `routes/aiAgents.test.ts`: `GET /runs/:id` for a design run includes `fleetDesign.downloadPath`.
Run → FAIL.

- [ ] **Step 2: Implement**

`runTrace.ts`: `export interface RunTraceFleetDesignArtifactInput { reportId: string | null; generatedAt: string | null; evidenceTruncated: boolean }`; add `fleetDesignArtifact: RunTraceFleetDesignArtifactInput | null = null` as a new trailing parameter of `buildRunTrace`; DTO: `fleetDesign: projectFleetDesign(run, outcome, fleetDesignArtifact)`.
`runFinishedNotify.ts`: `readFleetDesignDigest(outcome)` reading `outcome.fleetDesignReport`; `const design = run.profile === 'design' ? readFleetDesignDigest(run.outcome ?? {}) : null;` title/link/priority arms before the narrative ones; metadata `{ fleetDesign: { reportRunId, reportId } }`.
`routes/aiAgents.ts`: beside the narrative artifact lookup, when `run.profile === 'design' && run.reportRunId`, select `fleetDesignArtifactProjection` (reportId, `result->'summary'->'fleetDesign'->>'generatedAt'`, `->>'evidenceTruncated'`) with the same `reports.orgId` + `auth.orgCondition` guard and pass it as the new `buildRunTrace` argument.

- [ ] **Step 3: Run, commit**

```bash
git add apps/api/src/services/aiAgents/runTrace.ts apps/api/src/services/aiAgents/runFinishedNotify.ts apps/api/src/routes/aiAgents.ts apps/api/src/services/aiAgents/*.test.ts apps/api/src/routes/aiAgents.test.ts
git commit -m "feat(api): fleet design run-detail projection and completion notification"
```

### Task 10: `design` schedule fan-out

**Files:**
- Modify: `apps/api/src/jobs/aiAgentSweepScheduler.ts:559-561`, `:609-629`
- Modify: `apps/api/src/routes/aiAgentSchedules.ts` (audit `kind` already flows; nothing else)
- Test: `apps/api/src/jobs/aiAgentSweepScheduler.test.ts` (extend)

- [ ] **Step 1: Failing test**

Copy the existing narrative fan-out test in `aiAgentSweepScheduler.test.ts` (grep `profile: 'narrative'`) and assert for a `kind: 'design'` baseline: `createAndEnqueueAgentRun` is called once per live org with `{ kind: 'designer', profile: 'design', deviceId: null, scheduleId: baseline.id, triggerRef: { scheduleId, occurrenceKey, kind: 'design' }, dedupeKey: \`design-${baseline.id}-${orgId}-${occurrenceKey}\` }`.
Run: `cd apps/api && npx vitest run src/jobs/aiAgentSweepScheduler.test.ts` → FAIL.

- [ ] **Step 2: Implement**

Replace the `isNarrative` ternary at :609-629 with a `switch (baseline.kind)`:
```ts
  const admission = (): Parameters<typeof createAndEnqueueAgentRun>[0] => {
    switch (baseline.kind) {
      case 'narrative':
        return { orgId, kind: 'triage', triggerKind: 'schedule', deviceId: null, profile: 'narrative', scheduleId: baseline.id,
          triggerRef: { scheduleId: baseline.id, occurrenceKey, kind: 'narrative' }, dedupeKey: `narrative-${baseline.id}-${orgId}-${occurrenceKey}` };
      case 'design':
        return { orgId, kind: 'designer', triggerKind: 'schedule', deviceId: null, profile: 'design', scheduleId: baseline.id,
          triggerRef: { scheduleId: baseline.id, occurrenceKey, kind: 'design' }, dedupeKey: `design-${baseline.id}-${orgId}-${occurrenceKey}` };
      case 'sweep':
        return { orgId, kind: 'triage', triggerKind: 'schedule', deviceId: null, profile: 'sweep', scheduleId: baseline.id,
          triggerRef: { scheduleId: baseline.id, occurrenceKey, sweepKinds: effective.sweepKinds }, dedupeKey: `sweep-${baseline.id}-${orgId}-${occurrenceKey}` };
      default: { const exhaustive: never = baseline.kind; throw new Error(`[AiAgentSweepScheduler] unknown schedule kind ${String(exhaustive)}`); }
    }
  };
  const result = await createAndEnqueueAgentRun(admission());
```
Replace `isNarrative` (:559-561) with `const kind = baseline.kind;` and update the two places that read it.

- [ ] **Step 3: Run, commit**

```bash
git add apps/api/src/jobs/aiAgentSweepScheduler.ts apps/api/src/jobs/aiAgentSweepScheduler.test.ts
git commit -m "feat(api): design schedules fan out one design run per org"
```

### Task 11: PDF label and render arm

**Files:**
- Modify: `packages/shared/src/reportPdf/reportPdf.ts:56-67` (`BuildOpts.summary` union), `:84-88` (labels), `:925-1067` (add `renderFleetDesignReport` beside `renderNarrativeReport`), `:1472-1483` (arm)
- Test: `packages/shared/src/reportPdf/reportPdf.test.ts` (extend; follow the narrative render test)

- [ ] **Step 1: Failing test**

```ts
it('renders a fleet design summary without throwing and titles it Fleet Design', () => {
  const doc = buildReportPdf([], { reportType: 'ai_fleet_design', generatedAt: '2026-09-12 09:00', timezone: 'UTC', summary: { fleetDesign: { schemaVersion: 1, outcome: outcomeFixture, orgName: 'Acme', agentName: 'Designer', generatedAt: '2026-09-12T09:00:00Z' } } });
  expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
  // the label is used for the title block
  expect(REPORT_TYPE_LABELS_FOR_TEST.ai_fleet_design).toBe('Fleet Design');
});
```
(export `REPORT_TYPE_LABELS` under a test-only name if it is not exported; otherwise assert via the title text the way the narrative test does.)

- [ ] **Step 2: Implement**

- `REPORT_TYPE_LABELS.ai_fleet_design = 'Fleet Design'`; `BuildOpts.summary` union gains `FleetDesignReportSummary`.
- `renderFleetDesignReport(doc, fd: NonNullable<FleetDesignReportSummary['fleetDesign']>, opts)`: title block `drawTitleBlock(doc, 'Fleet Design', orgName, meta)` with meta `Generated …   ·   Agent: …   ·   Site: …` when present; then for each `FLEET_DESIGN_SECTION_KEYS` key, `drawSectionHeading(doc, FLEET_DESIGN_SECTION_TITLES[key], y)` and:
  - `found`, `baseline`, `unsure`: bullet lines (reuse the narrative bullet loop: `sanitizeNarrativeText`, `doc.circle`, `ensureNarrativeRoom`).
  - `functions`: `autoTable` with columns Function | Devices | Confidence | Evidence (`rowPageBreak: 'avoid'`, `styles.fontSize 7.5`, copying the option block at :1319-1340 minus `didParseCell`).
  - `monitoring`: per function a sub-heading then two tables — Watches (Type | Name | Alert on stop | Auto-restart | Rationale) and Alert rules (Name | Severity | Cooldown | Paging | Rationale).
  - `retired`, `legacy`: one table each (Kind/Item/Policy/Reason; Script/Bucket/Covered by/Intent).
  - `automation`: bullets.
  Add a footnote via `drawNarrativeFootnote`'s pattern reading "Proposals only — nothing here is live until a technician applies it."
- Arm: `else if (opts.reportType === 'ai_fleet_design' && opts.summary && (opts.summary as FleetDesignReportSummary).fleetDesign) { renderFleetDesignReport(doc, (opts.summary as FleetDesignReportSummary).fleetDesign!, opts); }` before the generic fallback.

- [ ] **Step 3: Run, commit**

Run: `cd packages/shared && npx vitest run src/reportPdf && npx tsc --noEmit -p tsconfig.json`

```bash
git add packages/shared/src/reportPdf
git commit -m "feat(shared): Fleet Design PDF render arm"
```

### Task 12: Routes — trigger, list, detail

**Files:**
- Create: `apps/api/src/routes/fleetDesign.ts`, `apps/api/src/routes/fleetDesign.test.ts`
- Modify: `apps/api/src/index.ts` (import + `api.route('/ai/fleet-design', fleetDesignRoutes);` next to the `/ai/agents` mounts, ~:979)
- Modify: `packages/shared/src/validators/fleetDesign.ts` (add `triggerFleetDesignRunSchema`)

**Interfaces:**
- Produces: `POST /ai/fleet-design/runs` `{ orgId: uuid, siteId?: uuid }` → 202 `{ runId }` | 200 `{ skipped: reason }` | 404 `{ error: 'no_designer_agent' }`; `GET /ai/fleet-design?orgId=` → `{ items: [{ reportRunId, reportId, orgId, generatedAt, runId, functionCount, watchCount, ruleCount, evidenceTruncated }] }`; `GET /ai/fleet-design/:reportRunId` → `{ reportRunId, reportId, orgId, summary: FleetDesignReportSummary, markdown, downloadPath }`.

- [ ] **Step 1: Failing route tests**

Follow `routes/aiAgents.test.ts`'s harness (app factory, auth stub, Drizzle mocks). Cases:
```ts
it('POST /runs admits a design run for the org through createAndEnqueueAgentRun', …) // expect call with { orgId, kind: 'designer', profile: 'design', triggerKind: 'manual', deviceId: null, dedupeKey: /^design-manual-/, triggerRef: { requestedByUserId, agentId, siteId: null } }
it('POST /runs 404s when the org has no effective designer agent', …)
it('POST /runs 400s on a non-object body / extra keys (.strict)', …)
it('POST /runs 404s for an org outside the caller\'s access', …)
it('GET / lists ai_fleet_design report runs for the org newest first', …)
it('GET /:reportRunId 404s for another org\'s report run', …)
```
Run: `cd apps/api && npx vitest run src/routes/fleetDesign.test.ts` → FAIL.

- [ ] **Step 2: Implement**

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { triggerFleetDesignRunSchema } from '@breeze/shared';
import { db } from '../db';
import { reportRuns, reports } from '../db/schema';
import { requirePermission, requireScope } from '../middleware/auth';   // same imports as routes/aiAgents.ts:1-30
import { requireMfa } from '../middleware/mfa';
import { PERMISSIONS } from '../services/permissions';
import { resolveEffectiveAgent } from '../services/aiAgents/effectivePolicy';
import { createAndEnqueueAgentRun } from '../services/aiAgents/runService';
import { FLEET_DESIGN_REPORT_TYPE, loadFleetDesignReport } from '../services/aiAgents/fleetDesignReport';
import { writeRouteAudit } from '../services/auditEvents';

export const fleetDesignRoutes = new Hono<AppEnv>();
const scopes = requireScope('organization', 'partner', 'system');
const requireAiRead = requirePermission(PERMISSIONS.AI_AGENTS_READ.resource, PERMISSIONS.AI_AGENTS_READ.action);
const requireAiWrite = requirePermission(PERMISSIONS.AI_AGENTS_WRITE.resource, PERMISSIONS.AI_AGENTS_WRITE.action);

fleetDesignRoutes.post('/runs', scopes, requireAiWrite, requireMfa(), zValidator('json', triggerFleetDesignRunSchema), async (c) => {
  const auth = c.get('auth');
  const { orgId, siteId } = c.req.valid('json');
  if (!auth.canAccessOrg(orgId)) return c.json({ error: 'not_found' }, 404);
  const resolved = await resolveEffectiveAgent(auth, orgId, 'designer');
  if (!resolved) return c.json({ error: 'no_designer_agent' }, 404);
  const result = await createAndEnqueueAgentRun({
    orgId, kind: 'designer', triggerKind: 'manual', deviceId: null, profile: 'design',
    dedupeKey: `design-manual-${randomUUID()}`,
    triggerRef: { requestedByUserId: auth.user.id, agentId: resolved.agentId, siteId: siteId ?? null },
  });
  writeRouteAudit(c, { orgId, action: 'ai_fleet_design.run', resourceType: 'ai_agent', resourceId: resolved.agentId, details: { siteId: siteId ?? null, result: result.kind } });
  if (result.kind === 'skipped') return c.json({ skipped: result.reason }, 200);
  return c.json({ runId: result.runId }, 202);
});

fleetDesignRoutes.get('/', scopes, requireAiRead, async (c) => {
  const auth = c.get('auth');
  const orgId = c.req.query('orgId');
  const conditions = [eq(reports.type, FLEET_DESIGN_REPORT_TYPE), eq(reportRuns.status, 'completed')];
  const orgCond = auth.orgCondition(reports.orgId);
  if (orgCond) conditions.push(orgCond);
  if (orgId) { if (!auth.canAccessOrg(orgId)) return c.json({ items: [] }); conditions.push(eq(reports.orgId, orgId)); }
  const rows = await db.select({ reportRunId: reportRuns.id, reportId: reports.id, orgId: reports.orgId, completedAt: reportRuns.completedAt, summary: reportRuns.result })
    .from(reportRuns).innerJoin(reports, eq(reportRuns.reportId, reports.id)).where(and(...conditions)).orderBy(desc(reportRuns.completedAt)).limit(100);
  return c.json({ items: rows.map(projectListItem) });
});

fleetDesignRoutes.get('/:reportRunId', scopes, requireAiRead, async (c) => {
  const auth = c.get('auth');
  const row = await loadFleetDesignReport(c.req.param('reportRunId'), auth.orgCondition.bind(auth));
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json({ reportRunId: row.reportRunId, reportId: row.reportId, orgId: row.orgId, summary: row.summary, markdown: row.summary.fleetDesign?.outcome?.markdown ?? '', downloadPath: `/api/reports/runs/${row.reportRunId}/download` });
});
```
`projectListItem` reads `summary.summary.fleetDesign.outcome.sections` counts the way `projectFleetDesign` does; `triggerFleetDesignRunSchema = z.object({ orgId: z.string().uuid(), siteId: z.string().uuid().optional() }).strict()`. Match the exact `createAndEnqueueAgentRun` result discriminant (`CreateAgentRunResult`, `runService.ts:751-753`) — read it before writing the branch. The `triggerRef.siteId` key is what `runLoop.ts` (Task 7) reads.

- [ ] **Step 3: Run, typecheck, commit**

```bash
git add apps/api/src/routes/fleetDesign.ts apps/api/src/routes/fleetDesign.test.ts apps/api/src/index.ts packages/shared/src/validators/fleetDesign.ts
git commit -m "feat(api): /ai/fleet-design trigger, list and detail routes"
```

### Task 13: Integration test (live Postgres)

**Files:**
- Create: `apps/api/src/__tests__/integration/aiAgentFleetDesign.integration.test.ts`

- [ ] **Step 1: Write the suite** (copy the harness from `aiAgentNarrativeReport.integration.test.ts` — `runDb`, fixtures, system context; it must live under `src/__tests__/integration/` or no CI job runs it)

Cases:
1. `persistFleetDesignReport` for org A creates one `reports` row (`type = 'ai_fleet_design'`, `execution_scope_principal_kind = 'system'`, `source_ai_agent_schedule_id IS NULL`) and one `report_runs` row (`requested_by_kind = 'system'`, `result->'summary'->'fleetDesign'->'outcome'->>'schemaVersion' = '1'`), and sets `ai_agent_runs.report_run_id`.
2. A second persist for the same org reuses the definition (still one `reports` row, two `report_runs`).
3. A second persist for the same RUN throws `FleetDesignPersistConflictError` (CAS).
4. Erasure of org A (call `eraseOrganization`/the tenantCascade entry the narrative suite uses) succeeds after a design persisted.
5. `loadDesignEvidence(orgA)` under system context never returns a device of org B (seed one device in each org, assert `deviceIds` ⊆ org A).
6. Schedule fan-out: insert a partner baseline `kind = 'design'` targeting a partner-wide `designer` agent (mode `act`), run the occurrence job the sweep-fanout suite runs, assert one `ai_agent_runs` row with `profile = 'design'` per live org; a baseline targeting a `triage` agent is rejected at `createSchedule` with `agent_kind_not_designer`.
7. `ai_agent_schedules` CHECK: inserting `kind = 'design'` with a non-empty `sweep_kinds` fails 23514.

- [ ] **Step 2: Run against the test stack**

Run: `pnpm test-stack up` then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiAgentFleetDesign.integration.test.ts` — confirm in the output that the 7 tests RAN (not skipped). `pnpm test-stack down` when done.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/aiAgentFleetDesign.integration.test.ts
git commit -m "test(api): fleet design persistence, erasure, evidence isolation and schedule fan-out"
```

### Task 14: Web — kind card, modes, always-on note, schedule kind, badges, run detail, reports list

**Files:**
- Modify: `apps/web/src/components/settings/aiAgents/ModeChoice.tsx:16-41` (add `kind: AiAgentKind` prop; `modeUnavailable` also true when `!allowedModesForKind(kind).includes(candidate)`; show `aiAgentsPage.modeChoice.shadowUnavailableForKind` under a disabled shadow), `steps/PurposeStep.tsx:71-79` (pass `kind={draft.kind}`; when the kind changes to `designer` and `draft.mode === 'shadow'`, `patch({ kind, mode: 'off' })`), `apps/web/src/components/settings/AiAgentForm.tsx` (pass `kind={agent.kind}` to `ModeChoice`)
- Modify: `apps/web/src/components/settings/aiAgents/CapabilityPicker.tsx:227-228`: when `kind === 'designer'`, render only the always-on `<details>` plus a note `aiAgentsPage.catalog.designerReadOnly` and hide the selectable list
- Modify: `apps/web/src/components/settings/AiAgentSchedulesSection.tsx`: offer `design` in the kind chooser (only when a partner-wide `designer` agent exists — the section already loads agents to pick the triage one; filter by kind for the design option), default cron `DESIGN_DEFAULT_CRON`, block Save unless `isMonthlyOrRarerLiteralCron`, map `agent_kind_not_designer` in the error copy map (:100-113)
- Modify: `apps/web/src/components/aiAgents/RunsListPage.tsx:256-270` (add a `design` chip like the narrative one), `RunDetailPage.tsx:1783-1847` (add a `fleetDesign` block: counts, generated-at, "Open in Fleet Design" link to `/ai-agents/fleet-design#<reportRunId>` — the page itself lands in W03; until then the link goes to `/reports` like the narrative — and a Download button calling the existing `exportReport` path with `reportType: 'ai_fleet_design'`)
- Modify: `apps/web/src/components/reports/ReportsList.tsx:29-53` (`'ai_fleet_design'` in the union and `SYSTEM_MANAGED_REPORT_TYPES`), `ReportBuilder.tsx:159-176` (`ai_fleet_design: 'activity'`)
- Locales (8): `settings.json` — `aiAgentsPage.kinds.designer`, `aiAgentsPage.flow.kinds.designer.{blurb,runsWhen,recommended}`, `aiAgentsPage.modeChoice.shadowUnavailableForKind`, `aiAgentsPage.catalog.designerReadOnly`, `aiAgentsPage.schedules.kinds.design`, `aiAgentsPage.schedules.errors.agentKindNotDesigner`, `aiAgentsPage.runs.profile.design`, `aiAgentsPage.runs.fleetDesign.{title,counts,openReport,download,downloadFailed,truncatedNote}`; `reports.json` — `reportTypes.ai_fleet_design` at every path where `ai_org_narrative` appears (:268, :326, :821) and `reportsList.errors.noCompletedRun` is generic enough to keep.
- Tests: `PurposeStep.test.tsx`, `ModeChoice.test.tsx` (create if absent), `CapabilityPicker.test.tsx`, `AiAgentSchedulesSection.test.tsx`, `RunsListPage.test.tsx`, `RunDetailPage.test.tsx`, `ReportsList.test.tsx` (extend)

English copy:
```json
"kinds": { "designer": "Fleet designer" },
"flow": { "kinds": { "designer": {
  "blurb": "Reads the whole fleet and writes a justified monitoring design for a technician to approve.",
  "runsWhen": "you start a Fleet Design for an organization, or on a quarterly schedule",
  "recommended": "a clean-slate migration, or a quarterly configuration audit" } } },
"modeChoice": { "shadowUnavailableForKind": "This agent only reads and writes reports — there is nothing to shadow." },
"catalog": { "designerReadOnly": "The Fleet designer reaches every read-only tool and one report tool. It has no mutating capabilities to choose." },
"schedules": { "kinds": { "design": "Fleet design" }, "errors": { "agentKindNotDesigner": "A design schedule must target a Fleet designer agent." } },
"runs": { "profile": { "design": "Fleet design" }, "fleetDesign": {
  "title": "Fleet Design", "counts": "{{functions}} functions · {{watches}} watches · {{rules}} alert rules",
  "openReport": "Open report", "download": "Download PDF", "downloadFailed": "Could not download the PDF.",
  "truncatedNote": "The evidence was cut short — this design did not see the whole fleet." } }
```
`reports.json`: `"ai_fleet_design": "Fleet Design"`.

- [ ] **Step 1: Failing tests** — one `it` per bullet above (kind card renders for `designer`; shadow disabled with the reason when `kind === 'designer'`; picker shows only always-on for designer; schedule form offers `design` only with a designer agent and blocks a weekly cron; runs chip; detail block; reports label + "Open latest").
Run: `cd apps/web && npx vitest run src/components/settings/aiAgents src/components/settings/AiAgentSchedulesSection.test.tsx src/components/aiAgents src/components/reports/ReportsList.test.tsx` → FAIL.

- [ ] **Step 2: Implement** as listed. Translations for the other 7 locales are real translations (de-DE: "Flottendesigner", "Flottendesign" …; the `translationCoverage.test.ts` baseline must not be bumped).

- [ ] **Step 3: Run the web gates**

Run: the Step 1 list plus `npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/__tests__/no-silent-mutations.test.ts && npx astro check && pnpm lint`
Expected: PASS.

- [ ] **Step 4: Commit and open the PR**

```bash
git add apps/web/src
git commit -m "feat(web): fleet designer kind card, modes, schedule kind, run and report surfaces"
```
Before the PR: `cd apps/api && npx vitest run` (full unit suite), `pnpm db:check-drift`, the integration suite of Task 13, and `gh workflow run CI --ref <branch>` only if the branch is stacked. PR body: what the designer writes, what it never does (no intents, no fleet changes), the two migrations, `Closes #5651`.
