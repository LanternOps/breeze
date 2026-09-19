---
tracking_issue: LanternOps/breeze#5650
---
# AI Agents: the Fleet Designer kind — Plan Index

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-11-fleet-designer-agent-design.md` (draft of 2026-09-11; the amendments below are applied by these plans and must be folded back into the spec by W01 Task 0).

One plan document per wave. Each wave is one PR on its own branch
`feature/5650-fleet-designer/wave-<sub-issue#>` with `Closes #<sub-issue#>` in
the PR body. State lives on GitHub (feature-lifecycle); the wave issue is the
source of truth for status, never this index.

| Wave | Plan | Depends on |
|---|---|---|
| W01 (#5651) | [The designer lane: kind, profile, schedule kind, evidence bundle, `submit_fleet_design`, section contract, persistence, PDF, reports-list entry, create-flow card](2026-09-12-fleet-designer-w01-designer-lane.md) | — |
| W02 (#5652) | [Device function: `device_function_assessments`, projection columns, service, `GET/PUT /devices/:id/function`, device Function field, `applyDesignFunctions`](2026-09-12-fleet-designer-w02-device-function.md) | W01 |
| W03 (#5653) | [Apply and rollback: `rationale` columns, `fleet_design_applied_items` ledger, apply steps 1–3 and 5, groups per function, Fleet Design page with apply drawer](2026-09-12-fleet-designer-w03-apply-and-rollback.md) | W02 |
| W04 (#5654) | [Legacy intent inventory: bundle-import tags, legacy evidence and prompt, script creation in apply (step 4)](2026-09-12-fleet-designer-w04-legacy-intent-inventory.md) | W03 |
| W05 (#5655) | [Scheduled drift design, `fleetDesignsDelivered` impact counter, org_documents hand-off](2026-09-12-fleet-designer-w05-drift-and-impact.md) | W01, W03 |

W02 starts when W01 merges. W03 after W02. W04 and W05 may run in parallel once W03 has merged (W05's impact counter only needs W01, but its drift task reads the W03 ledger).

## Advisor quorum (spec §5)

Codex (`gpt-6-astra`, read-only, `xhigh`) was convened on D1, D3 and D4 on 2026-09-12 while these plans were written. Its findings are recorded in W03 Task 0 (apply ledger) and W02 Task 0 (function storage); where it disagreed with the spec, the plan states the resolution and the reason.

## Spec amendments these plans apply (verified against main `a3be849802`)

1. **Manual trigger.** `POST /ai/agents/:id/runs` takes only `{ deviceId }` (`packages/shared/src/validators/aiAgents.ts:255-257`, `.strict()` on purpose). Design runs are started by a new `POST /ai/fleet-design/runs` with `{ orgId, siteId? }` (W01 Task 12). The spec's §4.1 and §4.10 "through the existing admission path" holds — the route calls `createAndEnqueueAgentRun` — but the body and path are new.
2. **Schedules target one agent kind.** `scheduleService.ts:320-347` only accepts a partner-wide `triage` agent. W01 widens it: a `design` schedule must target a partner-wide `designer` agent; sweep and narrative keep requiring `triage`. Error code `agent_kind_not_designer` joins `agent_kind_not_triage`.
3. **Contract violations are tool errors, not a run failure code.** There is no `outcome_contract_violation` anywhere; a bad `submit_narrative` payload throws inside the tool and the model retries (`outcomeTools.ts:438-450`). `submit_fleet_design` does the same (structural AND referential validation inside the tool, W01 Task 7). A run that ends without a valid submission completes with `error_code = 'design_missing'` and no report (mirrors `narrative_missing`).
4. **Budget code.** `budget_exceeded`, not `budget_exhausted` (`runLoop.ts:1864-1870`).
5. **Report definition key.** Manual design runs have no schedule, so the definition cannot be keyed on `source_ai_agent_schedule_id`. One definition per org keyed by `(org_id) WHERE type = 'ai_fleet_design'` (new partial unique index; the org-merge reports executor gains a third dedupe pass, W01 Task 4).
6. **Per-day admission cap.** `profileCaps()` counts per hour. W01 generalises it to a window (`windowMs`) so `maxDesignRunsPerDay` is enforced at admission rule 6b without a new branch.
7. **Alert rules are inline.** `config_policy_alert_rules` has `conditions jsonb` and no `templateId` (`configurationPolicies.ts:185-201`). A monitoring proposal's alert rule is `{ name, severity, conditions[], cooldownMinutes, rationale, action, paging }` in `alertRuleItemSchema` shape; an `alert_templates` row may be cited as `sourceTemplateId` for provenance only.
8. **Retiring a watch or rule rewrites the feature link.** There is no per-row endpoint; `updateFeatureLink` deletes and re-creates every normalised row from `inlineSettings` (`configurationPolicy.ts:1650-1668`). The W03 retire step rewrites the link's `watches[]` / `items[]` and stores the previous settings in the ledger for rollback.
9. **Apply ledger.** `result.applied` inside `report_runs.result` is replaced by a table, `fleet_design_applied_items` (W03). Idempotency is `UNIQUE (report_run_id, item_ref)`; rollback reads the ledger, not a jsonb manifest. See W03 Task 0 for the quorum record.
10. **Device function SSOT lands in W01**, not W02: the section contract validates `functionKey` against it.
11. **Thresholds are frozen defaults in v1** (`FLEET_DESIGN_CONFIDENCE_THRESHOLD = 0.6`, `FLEET_DESIGN_PRECURSOR_THRESHOLDS`), snapshotted into every report. Partner-tunable thresholds are a roadmap item; there is no settings surface to hang them on yet.
12. **Large organisations (§4.9).** No multi-chunk assembly in v1. The manual trigger accepts `siteId`, and the evidence bundle reports the devices beyond `DESIGN_EVIDENCE_MAX_DEVICES` in `unsure` as "not assessed". Multi-chunk assembly is a roadmap item.
13. **`device_role_source` has no CHECK** (`0058-device-role-classification.sql:6`; values today are `auto | manual | discovery`). `'ai'` is a new literal, no DDL.
14. **Composite FK deferral.** `device_function_assessments_device_org_fk` is `ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED`, copying `device_custom_field_values` / `device_external_links` (device-axis FKs are pinned DEFERRED by `moveOrg.coverage.test.ts:1164`; the merge contract only requires DEFERRABLE).
15. **`rationale` on `config_policy_alert_rules` / `config_policy_monitoring_watches` needs no export-policy entry** — neither table is in `CORE_ORG_CASCADE_DELETE_ORDER` (they hang off `config_policy_feature_links`). `alert_templates.rationale` does.
16. **Designer permissions.** Configuration policies and device groups are gated on `devices:write` (`routes/configurationPolicies/crud.ts:35-36`, `routes/groups.ts:25-26`); scripts on `scripts:write`. The apply route requires `devices:write` and, when scripts are approved, `scripts:write`.

## Migration slots reserved

The deliverables plans (`docs/superpowers/plans/billing/2026-09-10-service-deliverables.md`) hold `2026-10-15-170000` … `170600`. These plans take the `18` block.

| File | Wave |
|---|---|
| `2026-10-15-180000-report-type-ai-fleet-design.sql` (enum add ONLY) | W01 |
| `2026-10-15-180100-ai-agents-fleet-designer.sql` | W01 |
| `2026-10-15-180200-device-function-assessments.sql` | W02 |
| `2026-10-15-180300-fleet-design-apply.sql` | W03 |
| `2026-10-15-180400-ai-agent-impact-fleet-designs.sql` | W05 |

Every executor re-checks `ls apps/api/migrations/*.sql | sort | tail -1` before committing and renames upward if main has moved past these names. W04 needs no migration.

## Cross-wave names that must not drift

Defined in W01 and consumed verbatim later: `AI_AGENT_KINDS` gains `'designer'`; `AI_AGENT_RUN_PROFILES` gains `'design'`; `AI_AGENT_SCHEDULE_KINDS` gains `'design'`; limits `maxConcurrentDesignRuns`, `maxDesignRunsPerDay`, `designBudgetCentsPerRun`, `designMaxTurns` (snapshot v10); `DEVICE_FUNCTION_KEYS`, `DeviceFunctionKey`, `isDeviceFunctionKey` (`packages/shared/src/validators/deviceFunctions.ts`); `FLEET_DESIGN_SECTION_KEYS`, `FleetDesignSubmission`, `FleetDesignOutcome`, `FleetDesignReportSummary`, `AiAgentRunFleetDesignDto`, `fleetDesignSubmissionSchema`, `fleetDesignOutcomeFromSubmission`, `renderFleetDesignMarkdown`, `FLEET_DESIGN_CONFIDENCE_THRESHOLD`, `FLEET_DESIGN_PRECURSOR_THRESHOLDS`; `FLEET_DESIGN_REPORT_TYPE = 'ai_fleet_design'`; `persistFleetDesignReport`, `projectFleetDesign`, `loadFleetDesignReport` (`fleetDesignReport.ts`); `loadDesignEvidence`, `DesignEvidence` (`designEvidence.ts`); routes under `/ai/fleet-design`. Defined in W02: `deviceFunctionAssessments`, `upsertDeviceFunction`, `applyDesignFunctions`. Defined in W03: `fleetDesignAppliedItems`, `applyFleetDesign`, `rollbackFleetDesign`, item-ref grammar `functions:<key>`, `monitoring:<key>:watch:<n>`, `monitoring:<key>:rule:<n>`, `retired:<n>`, `automation:<key>:script:<n>`, `legacy:<scriptId>`, `roleCorrections:<deviceId>`.

## Deferred (roadmap, recorded when the feature is registered)

Partner-tunable confidence and precursor thresholds; multi-chunk assembly for organisations over the device bound; `function_filter` on policy assignments; partner-level design roll-ups; new fleet-finding producers for software age, certificate expiry and patch age; a playbook create route; read tools for software inventory, certificates, warranty, topology and management posture; importing legacy monitors.
