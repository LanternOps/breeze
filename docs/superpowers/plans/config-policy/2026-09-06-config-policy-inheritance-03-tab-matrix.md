---
tracking_issue: LanternOps/breeze#5080
wave_issue: LanternOps/breeze#5083
---

# Config Policy Inheritance — W03 Task 5: per-tab `featurePolicyId` payload matrix

Built by `grep -n "featurePolicyId" apps/web/src/components/configurationPolicies/featureTabs/*Tab.tsx`
against every entry in `FEATURE_META` (`featureTabs/types.ts`).

**Deviation from the plan's "18 rows":** `device_lifecycle` (added in #5053, merged to
main immediately before this wave started) makes `FEATURE_META` 19 entries, not 18.
The plan's own Step 1 enumeration already lists "Device Lifecycle" in the verify set,
so the row count below (19) is the accurate figure; only the summary line in the plan
text was stale.

| # | Tab | `featurePolicyId` meaning | Sends today | Sends after |
|---|---|---|---|---|
| 1 | Patch | update ring (`selectedRingId`) | ring id / `null` | **keep** — unchanged |
| 2 | Backup | backup profile (`selectedProfileId`) | profile id / `null` per `sourceMode` | **keep** — unchanged |
| 3 | Software Policy | software policy entity (`selectedPolicyId`) | policy id / `null` | **keep** — unchanged (already copies `parentLink.featurePolicyId` on override) |
| 4 | Peripheral Control | peripheral policy entity (`selectedPolicyId`) | policy id / `null` | **keep** — unchanged |
| 5 | Alert Rule | none — inline settings (`items` array) | parent CONFIG policy id (`linkedPolicyId`) — bug | `null` |
| 6 | Automation | none — inline settings (`items` array; `InlineEntityPicker` inside a rule references scripts/software, not a policy-level entity) | `linkedPolicyId` — bug | `null` |
| 7 | Compliance | none — inline settings (`items` array; per-rule pickers reference scripts/software, not a policy-level entity) | `linkedPolicyId` — bug | `null` |
| 8 | Device Lifecycle | none — inline settings (retention window) | `linkedPolicyId` — bug | `null` |
| 9 | Event Log | none — inline settings | `linkedPolicyId` — bug | `null` |
| 10 | Helper (Breeze Assist) | none — inline settings | `linkedPolicyId` — bug | `null` |
| 11 | Maintenance | none — inline settings (windows built inline, not a linked entity) | `linkedPolicyId` — bug | `null` |
| 12 | Monitoring | none — inline settings (service/process watches) | `linkedPolicyId` — bug | `null` |
| 13 | OneDrive Helper | none — inline settings | `linkedPolicyId` — bug | `null` |
| 14 | Pam | none — inline settings | `linkedPolicyId` — bug | `null` |
| 15 | Warranty | none — inline settings | `linkedPolicyId` — bug | `null` |
| 16 | Vulnerability | none — inline settings (boolean enable) | `linkedPolicyId` — bug | `null` |
| 17 | Security | none — inline settings | `linkedPolicyId` — bug | `null` |
| 18 | Sensitive Data | none — inline settings (`fetchUrl` lists other policies for a conflict check, not a link target) | `linkedPolicyId` — bug | `null` |
| 19 | Remote Access | none — inline settings | `linkedPolicyId` — bug | `null` |

**Keep rows (4):** rows 1-4 have a real standalone entity behind `featurePolicyId` and are untouched by this task.

**Fix rows (15):** rows 5-19 send `featurePolicyId: null` after this task. Rows 17-19
(Security, Sensitive Data, Remote Access) additionally had no `handleOverride` path at
all before Task 6 (they didn't yet render inheritance), so their destructured
`linkedPolicyId` becomes fully unused once the featurePolicyId fix lands and is
removed in the same commit; Task 6 re-adds the inheritance gating for these three
using `parentLink`, not `linkedPolicyId`. The other 12 fix-rows keep destructuring
`linkedPolicyId` — it still gates `onRemove`/`onRevert` in those tabs.
