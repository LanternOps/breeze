---
tracking_issue: LanternOps/breeze#4678
---

# Script Custom-Field Write-Back Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a script running on a device persist values into that device's own custom fields, with no API key, no device UUID, and no new network call — by emitting a structured marker that the existing agent command-result ingest parses, validates against the field definitions, and merges.

**Architecture:** The script emits `::breeze:custom-fields:: {"key":"value"}` lines on stdout. `handleScriptResult` (`services/commandResultHandlers.ts` — the single handler both the WebSocket and REST result transports dispatch) extracts them, validates each key against `custom_field_definitions` (including a new per-field `script_write` opt-in gate), coerces by declared type, merges into `devices.custom_fields`, audits, and records a per-execution summary. Authorization is structural: the only device the handler can write is the one whose command row it just terminated, so a script cannot name another device. Wave 1 is API-only and therefore works against **every agent version already in the fleet**; Wave 3 adds a second, preferred structured channel that the agent fills from *raw* stdout before the output sanitizer runs.

**Tech Stack:** PostgreSQL + hand-written SQL migrations, Drizzle ORM, Hono, Zod, Vitest (unit + integration), React (web), Go (agent, `go test -race`).

**Spec:** No separate spec doc. The WHAT is settled on the issue itself — `LanternOps/breeze#2698`, in particular ToddHebebrand's acceptance comment ("the script emits a structured marker … and `handleScriptResult` parses it and applies the same validated merge + audit logic the PATCH endpoint uses"). Read the issue before starting.

---

## Global Constraints

- **Node** pinned to 22.23.2; **Go** toolchain per `agent/go.mod`. Never bump either in this work.
- **Migrations** must be idempotent (`ADD COLUMN IF NOT EXISTS`, `DROP … IF EXISTS` then re-add), must contain **no inner `BEGIN;`/`COMMIT;`** (`autoMigrate` wraps each file in a transaction), and must **sort after the newest committed migration**. As of 2026-09-02 that is `apps/api/migrations/2026-10-04-100000-ticket-requester-contact.sql` on `origin/main` and `apps/api/migrations/2026-10-04-100100-contract-lines-device-roles.sql` on `origin/billing-by-units`. **Re-check both before writing the file** (`ls apps/api/migrations | sort | tail -1`) — shipped filenames run ahead of real time. This plan names the file `2026-10-06-100000-script-custom-field-writeback.sql`, which clears both.
- **Never edit a shipped migration.** Fix forward.
- **No new tables** are introduced by this plan, so no `CORE_ORG_CASCADE_DELETE_ORDER` / `CORE_DEVICE_CASCADE_DELETE_TABLES` / `CORE_DEVICE_ORG_DENORMALIZED_TABLES` / `DUAL_AXIS_TENANT_TABLES` entries are needed. **But two new COLUMNS land on tables already in the org cascade list, and that fires `CORE_TENANT_EXPORT_POLICY`** (`apps/api/src/services/tenantExportPolicyRegistry.ts`). See Task 3. This is the registration step that has shipped broken five times; treat it as a mechanical grep, not a judgement call.
- **`pnpm test` does NOT run the RLS or integration contract suites.** Local green ≠ CI green. Run `vitest.integration.config.ts` explicitly for Task 6.
- **Never write `pnpm --filter <pkg> test -- --run <path>`** — the literal `--` is forwarded into argv and vitest runs the whole suite in watch mode. Use `pnpm --filter @breeze/api test --run <path>` or `cd apps/api && npx vitest run <path>`.
- **Stacked PRs get no CI.** `ci.yml` triggers on `pull_request: branches: [main]`, so a PR based on a sibling branch runs no CI at all and `gh pr checks` reads green. Every wave in this plan targets `main` directly. If a wave is split, dispatch CI per branch: `gh workflow run CI --ref <branch>`.
- **`custom_fields` is not a secrets store.** The marker rides stdout, and stdout is persisted to `script_executions.stdout` where any `scripts:read` user can see it. A value written through this feature is visible in at least two places. This must be stated in the docs (Wave 2) and in the marker parser's file comment.

---

## Already shipped — verified against `origin/main` @ `01d588ae7d` (2026-09-02)

Do not re-build these. The issue is from 2026-07-21 and three of its five asks have landed since.

| Issue ask | Status | Evidence |
|---|---|---|
| Script **reads** a custom field of its own device | **SHIPPED** | `source: 'deviceCustomField'` parameter binding — `apps/api/src/services/sourcedParameters.ts:524-527`; delivered to the script as `BREEZE_PARAM_*` (`agent/internal/executor/executor.go:347`). This is the `Ninja-Property-Get` equivalent. |
| API-key write path for automations | **SHIPPED** (#2066) | `PATCH /devices/:id/custom-fields` — `apps/api/src/routes/devices/customFieldValues.ts`, dual `X-API-Key`/JWT auth, synchronous audit. Rejected as the answer here because it needs an embedded credential. |
| Server-side filtering on custom field values | **SHIPPED for the filter engine** | `custom.<key>` compiles to `jsonb_extract_path_text(devices.custom_fields, …)` — `apps/api/src/services/filterEngine.ts:59-67,175-183`. Reachable through saved filters, dynamic device groups, and deployment target resolution. **Not** exposed as a `GET /devices` query param (`listDevicesSchema` has no condition field) — a genuine, separate gap; do not fix it here. |
| Custom-field condition in **automation** device targeting | **SHIPPED for Advanced** | `automations` accept `targetType: 'filter'` (`apps/api/src/services/automationRuntime.ts:259`), which runs the filter engine above. The Simple targeting builder still offers only Site/Group/OS/Tag — a web-only gap; do not fix it here. |
| Script **writes** a custom field of its own device | **NOT SHIPPED** | `handleScriptResult` (`apps/api/src/services/commandResultHandlers.ts:332`) persists stdout/stderr/exitCode and interprets nothing. **This plan.** |

Also verified absent: `device_custom_field_values` (the promoted values table proposed by the unshipped `docs/superpowers/plans/2026-08-09-custom-field-backfill-import.md`, #3257) and `apps/api/src/services/customFields/`. **This plan deliberately does not create that table** — it writes `devices.custom_fields` through the same merge the PATCH endpoint uses, so #3257 can still land its projection later without conflict. Task 1 creates `services/customFields/validateValue.ts` at the exact path #3257 reserved for it, so that plan inherits it rather than duplicating it.

---

## Wire contract v1

Two channels. The API accepts **both** from Wave 1; the agent starts producing the second in Wave 3. The structured channel wins when both are present.

### Channel A — stdout marker (works on every agent, today)

A line whose **trimmed** form starts with the exact sentinel `::breeze:custom-fields::`. Everything after the sentinel on that line is parsed as JSON and must be a plain object.

```
::breeze:custom-fields:: {"ram_slot_type":"DDR5-5600","free_dimm_slots":2}
```

- Values may be `string | number | boolean | null`. `null` **clears** the field.
- Multiple marker lines are allowed. Later lines win per key.
- Caps (rejection, never truncation): at most **20** marker lines per result, **50** distinct keys total, **8192 bytes** of JSON per line. A line that exceeds a cap or fails `JSON.parse` is reported as `rejected: {reason: 'marker_unparseable'}` — it is never silently dropped.
- **Known limitation, must be documented:** the agent's `SanitizeOutput` (`agent/internal/executor/security.go:200`) and the server's mirror `redactSecretsFromOutput` (`apps/api/src/services/secretRedaction.ts:53-77`) rewrite `(api_key|apikey|token|secret|password|passwd|pwd)\s*[=:]\s*…` pairs to `$1=[REDACTED]`. A marker whose JSON contains such a key/value pair is mangled **before it ever reaches the server**, and `JSON.parse` then fails. Wave 3 is the fix (the agent extracts from raw stdout, pre-sanitizer). Until then the parser must report `marker_unparseable` loudly so the failure is diagnosable rather than mysterious.

### Channel B — structured result envelope (Wave 3 agents)

On the command-result envelope's existing `result` field (`commandResultSchema.result`, `apps/api/src/routes/agents/schemas.ts:450`, already byte-capped):

```json
{ "customFieldWrites": { "schemaVersion": 1, "fields": { "ram_slot_type": "DDR5-5600" } } }
```

`schemaVersion` is a literal `1` and is mandatory — this mirrors the `peripheral_policy_sync_v2` / `pam_apply_v2` payload discipline (`commandResultHandlers.ts:568,596`) and, critically, stops a script that legitimately prints a whole-stdout JSON document containing a `customFields` key from being read as a write-back. `toWSCommandResult` reparses whole-JSON stdout into `result` (`agent/internal/heartbeat/heartbeat.go:5722-5740`), so an unnamespaced key would be a live false-positive channel.

### Authorization model

- **Device scope is structural, not checked.** The handler receives `resolvedDeviceId` from the transport that already authorized the command row (`commandResultHandlers.ts` `CommandResultHandler` params — the transport passes the id it authorized, never one off the payload). The write is `WHERE id = resolvedDeviceId AND org_id = <device org>`. There is no field in either channel that can name a device, so "a script may only write fields of the device it runs on" holds by construction. A test must prove the `org_id` predicate is on the UPDATE.
- **Field scope is opt-in per definition.** New column `custom_field_definitions.script_write boolean NOT NULL DEFAULT false`. Default `false` means no existing field becomes script-writable on deploy. This is the Ninja model (per-field "script write" permission) and is the right axis: it survives partner-wide fields, needs no per-script configuration, and keeps a tech-authored script from silently rewriting an asset tag that billing or device targeting depends on.
- **No dispatcher-permission check at ingest.** The ingest path has no user. The gate that matters is at definition time (`devices:write` + `canManagePartnerWidePolicies` for partner-wide fields, both already enforced in `routes/customFields.ts`).

### RLS shape

No new tables. Two notes that will bite if ignored:

1. **`custom_field_definitions` is dual-axis (shape 4)** — `breeze_dual_axis_select … USING (breeze_has_org_access(org_id) OR breeze_has_partner_access(partner_id))`, `apps/api/migrations/2026-06-11-i-custom-fields-dual-axis-rls.sql`. The agent result handler runs under `runWithAgentOrgDbAccess` (`apps/api/src/routes/agentWs.ts:1512-1530`), which sets `accessiblePartnerIds: []` and `currentPartnerId: null`. **Partner-wide field definitions are therefore invisible to the handler under the ambient context** — the exact trap in CLAUDE.md's Partner-Wide First §3 ("Readers running inside an org-scoped RLS context (agent paths!) cannot see partner-wide rows at all"). The definitions read **must** run in a system context. Task 4 does this and Task 6 proves it against real Postgres.
2. **The `devices` UPDATE is the ambient org context's job** — `devices` is shape 1 (direct `org_id`), the handler's context already grants it, and doing the write under system scope would throw away the RLS backstop. Read definitions system-scoped; write the device org-scoped.

### Performance note — the per-org advisory lock

`AFTER UPDATE ON devices` fires `breeze_partner_export_z_custom_values_update` (`apps/api/migrations/2026-07-31-device-custom-value-move-owners.sql`), which, **when `custom_fields` actually changed**, calls `breeze_partner_export_touch_configuration_orgs` → `pg_advisory_xact_lock(1000201, hashtext(org_id))` (`apps/api/migrations/2026-07-18-partner-export-org-locks.sql:147`). That is an EXCLUSIVE per-org lock held to COMMIT. A fleet-wide script writing a field on 5,000 devices in one org serializes every one of those results behind it.

Two mitigations, both mandatory:

- **Parse before you query.** Extract markers from the in-memory string first; if there are none (the overwhelming majority of script results), return immediately without touching the database at all.
- **Compare before you write.** If the merged `custom_fields` object deep-equals what is already stored, skip the UPDATE entirely. No UPDATE, no trigger row-set, no lock, no WAL.

---

## File Structure

### New files

| File | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-06-100000-script-custom-field-writeback.sql` | `custom_field_definitions.script_write`; `script_executions.custom_field_result` |
| `apps/api/src/services/customFields/validateValue.ts` | `validateCustomFieldValue(definition, raw)` — type coercion + option/range checks. Shared; the path #3257 reserved. |
| `apps/api/src/services/customFields/validateValue.test.ts` | Unit tests for every type arm |
| `apps/api/src/services/customFields/scriptWriteMarkers.ts` | Pure extraction of Channel A + Channel B into one candidate map + parse-failure list |
| `apps/api/src/services/customFields/scriptWriteMarkers.test.ts` | Unit tests: grammar, caps, precedence, sanitizer-mangled line |
| `apps/api/src/services/customFields/scriptWriteBack.ts` | `applyScriptCustomFieldWrites(...)` — definitions load, gate, coerce, merge, audit, summary |
| `apps/api/src/services/customFields/scriptWriteBack.test.ts` | Unit tests with Drizzle mocks |
| `apps/api/src/__tests__/integration/scriptCustomFieldWriteBack.integration.test.ts` | Real Postgres: org isolation, partner-wide visibility, gate, no-op skip |
| `agent/internal/executor/customfields.go` | Wave 3: extract markers from raw stdout, strip the lines |
| `agent/internal/executor/customfields_test.go` | Wave 3 tests |
| `apps/docs/src/content/docs/features/custom-fields.mdx` (section) | Wave 2: "Writing custom fields from a script" |

### Modified files

| File | Change |
|---|---|
| `apps/api/src/db/schema/customFields.ts` | `scriptWrite` column |
| `apps/api/src/db/schema/scripts.ts` | `customFieldResult` column on `scriptExecutions` |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | **Both** new columns classified |
| `apps/api/src/services/commandResultHandlers.ts` | Call the write-back from `handleScriptResult` |
| `apps/api/src/routes/customFields.ts` | Accept/return `scriptWrite` on create + update |
| `packages/shared/src/types/filters.ts` | `scriptWrite: boolean` on `CustomFieldDefinition` |
| `apps/web/src/components/settings/CustomFieldsPage.tsx` | Wave 2: toggle + column |
| `agent/internal/remote/tools/types.go` | Wave 3: nothing — `Result any` already exists |
| `agent/internal/heartbeat/heartbeat.go:5722` | Wave 3: `toWSCommandResult` carries an explicitly-set `Result` |
| `agent/internal/heartbeat/handlers_script.go` | Wave 3: fill `Result.customFieldWrites`, strip marker lines |

---

# Wave 1 — API ingest (one PR, no agent change)

Ships the whole feature to the entire installed fleet. Branch off `main`; PR targets `main`.

### Task 1: Shared custom-field value validator

**Files:**
- Create: `apps/api/src/services/customFields/validateValue.ts`
- Test: `apps/api/src/services/customFields/validateValue.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type CustomFieldValueRejection =
    | 'invalid_type' | 'out_of_range' | 'not_a_choice' | 'too_long' | 'invalid_date';

  export interface CustomFieldValidationTarget {
    fieldKey: string;
    type: 'text' | 'number' | 'boolean' | 'dropdown' | 'date';
    options: unknown;            // raw jsonb — shape is NOT guaranteed, see below
  }

  export type CustomFieldValueResult =
    | { ok: true; value: string | number | boolean | null }
    | { ok: false; reason: CustomFieldValueRejection };

  export function validateCustomFieldValue(
    definition: CustomFieldValidationTarget,
    raw: unknown,
  ): CustomFieldValueResult;
  ```

**Context the implementer needs:** `options` genuinely has two shapes in the wild. `packages/shared/src/types/filters.ts:183` declares `choices?: Array<{label, value}>`, while the API's own create validator (`apps/api/src/routes/customFields.ts:12-18`) declares `choices: z.array(z.string())`, and the web form (`CustomFieldsPage.tsx:52`) stores `{label, value}`. Accept both. Never throw on a malformed `options` — treat it as "no constraint".

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/customFields/validateValue.test.ts
import { describe, it, expect } from 'vitest';
import { validateCustomFieldValue } from './validateValue';

const text = { fieldKey: 'note', type: 'text' as const, options: null };
const num = { fieldKey: 'slots', type: 'number' as const, options: { min: 0, max: 8 } };
const bool = { fieldKey: 'ready', type: 'boolean' as const, options: null };
const date = { fieldKey: 'expiry', type: 'date' as const, options: null };

describe('validateCustomFieldValue', () => {
  it('accepts a string for text and passes it through', () => {
    expect(validateCustomFieldValue(text, 'hello')).toEqual({ ok: true, value: 'hello' });
  });

  it('coerces number and boolean to text', () => {
    expect(validateCustomFieldValue(text, 42)).toEqual({ ok: true, value: '42' });
    expect(validateCustomFieldValue(text, true)).toEqual({ ok: true, value: 'true' });
  });

  it('rejects a text value over 10000 chars', () => {
    expect(validateCustomFieldValue(text, 'x'.repeat(10001))).toEqual({ ok: false, reason: 'too_long' });
  });

  it('accepts a numeric string for number and returns a number', () => {
    expect(validateCustomFieldValue(num, '4')).toEqual({ ok: true, value: 4 });
  });

  it('rejects a non-numeric string for number', () => {
    expect(validateCustomFieldValue(num, 'four')).toEqual({ ok: false, reason: 'invalid_type' });
  });

  it('enforces number min/max from options', () => {
    expect(validateCustomFieldValue(num, 9)).toEqual({ ok: false, reason: 'out_of_range' });
    expect(validateCustomFieldValue(num, -1)).toEqual({ ok: false, reason: 'out_of_range' });
  });

  it('accepts true/false strings for boolean', () => {
    expect(validateCustomFieldValue(bool, 'true')).toEqual({ ok: true, value: true });
    expect(validateCustomFieldValue(bool, 'FALSE')).toEqual({ ok: true, value: false });
  });

  it('rejects an arbitrary string for boolean', () => {
    expect(validateCustomFieldValue(bool, 'yes')).toEqual({ ok: false, reason: 'invalid_type' });
  });

  it('accepts an ISO date and normalises to YYYY-MM-DD', () => {
    expect(validateCustomFieldValue(date, '2026-12-31T00:00:00Z')).toEqual({ ok: true, value: '2026-12-31' });
  });

  it('rejects a non-date string', () => {
    expect(validateCustomFieldValue(date, 'soon')).toEqual({ ok: false, reason: 'invalid_date' });
  });

  it('accepts a dropdown choice in the string-array options shape', () => {
    const dd = { fieldKey: 'tier', type: 'dropdown' as const, options: { choices: ['gold', 'silver'] } };
    expect(validateCustomFieldValue(dd, 'gold')).toEqual({ ok: true, value: 'gold' });
    expect(validateCustomFieldValue(dd, 'bronze')).toEqual({ ok: false, reason: 'not_a_choice' });
  });

  it('accepts a dropdown choice in the {label,value} options shape', () => {
    const dd = {
      fieldKey: 'tier',
      type: 'dropdown' as const,
      options: { choices: [{ label: 'Gold', value: 'gold' }] },
    };
    expect(validateCustomFieldValue(dd, 'gold')).toEqual({ ok: true, value: 'gold' });
    expect(validateCustomFieldValue(dd, 'Gold')).toEqual({ ok: false, reason: 'not_a_choice' });
  });

  it('treats malformed options as no constraint rather than throwing', () => {
    const dd = { fieldKey: 'tier', type: 'dropdown' as const, options: { choices: 'gold' } };
    expect(validateCustomFieldValue(dd, 'anything')).toEqual({ ok: true, value: 'anything' });
  });

  it('passes null through for every type as an explicit clear', () => {
    for (const def of [text, num, bool, date]) {
      expect(validateCustomFieldValue(def, null)).toEqual({ ok: true, value: null });
    }
  });

  it('rejects objects and arrays outright', () => {
    expect(validateCustomFieldValue(text, { a: 1 })).toEqual({ ok: false, reason: 'invalid_type' });
    expect(validateCustomFieldValue(text, [1])).toEqual({ ok: false, reason: 'invalid_type' });
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd apps/api && npx vitest run src/services/customFields/validateValue.test.ts`
Expected: FAIL — `Failed to resolve import "./validateValue"`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/customFields/validateValue.ts
/**
 * Shared validation + coercion for one device custom-field VALUE against its
 * definition. Extracted here (the path #3257's backfill-import plan reserved)
 * so the script write-back path, the value PATCH endpoint and a future
 * importer share one truth about what a field will accept.
 *
 * Deliberately total: it never throws. A malformed `options` jsonb means "no
 * constraint", not "explode" — options are user-authored and two different
 * `choices` shapes are already in the wild (`z.array(z.string())` in the API
 * create validator vs `Array<{label,value}>` in the shared type and the web
 * form).
 */

export type CustomFieldValueRejection =
  | 'invalid_type'
  | 'out_of_range'
  | 'not_a_choice'
  | 'too_long'
  | 'invalid_date';

export interface CustomFieldValidationTarget {
  fieldKey: string;
  type: 'text' | 'number' | 'boolean' | 'dropdown' | 'date';
  options: unknown;
}

export type CustomFieldValueResult =
  | { ok: true; value: string | number | boolean | null }
  | { ok: false; reason: CustomFieldValueRejection };

// Matches `customFieldValueSchema` in routes/devices/customFieldValues.ts so a
// script write and a PATCH write have the same ceiling.
const MAX_TEXT_LENGTH = 10_000;

function readOptions(options: unknown): Record<string, unknown> {
  return options !== null && typeof options === 'object' && !Array.isArray(options)
    ? (options as Record<string, unknown>)
    : {};
}

/** Both shipped `choices` shapes, normalised to the stored value strings. */
function readChoices(options: unknown): string[] | null {
  const raw = readOptions(options).choices;
  if (!Array.isArray(raw)) return null;
  const values: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      values.push(entry);
    } else if (entry !== null && typeof entry === 'object' && typeof (entry as { value?: unknown }).value === 'string') {
      values.push((entry as { value: string }).value);
    } else {
      return null; // mixed / unrecognised — treat as no constraint
    }
  }
  return values.length > 0 ? values : null;
}

export function validateCustomFieldValue(
  definition: CustomFieldValidationTarget,
  raw: unknown,
): CustomFieldValueResult {
  if (raw === null || raw === undefined) return { ok: true, value: null };

  const isScalar = typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean';
  if (!isScalar) return { ok: false, reason: 'invalid_type' };

  switch (definition.type) {
    case 'text': {
      const value = String(raw);
      if (value.length > MAX_TEXT_LENGTH) return { ok: false, reason: 'too_long' };
      return { ok: true, value };
    }
    case 'number': {
      const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (typeof raw === 'boolean' || !Number.isFinite(value)) return { ok: false, reason: 'invalid_type' };
      const options = readOptions(definition.options);
      if (typeof options.min === 'number' && value < options.min) return { ok: false, reason: 'out_of_range' };
      if (typeof options.max === 'number' && value > options.max) return { ok: false, reason: 'out_of_range' };
      return { ok: true, value };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      const normalized = String(raw).trim().toLowerCase();
      if (normalized === 'true') return { ok: true, value: true };
      if (normalized === 'false') return { ok: true, value: false };
      return { ok: false, reason: 'invalid_type' };
    }
    case 'date': {
      if (typeof raw !== 'string') return { ok: false, reason: 'invalid_date' };
      const parsed = new Date(raw.trim());
      if (Number.isNaN(parsed.getTime())) return { ok: false, reason: 'invalid_date' };
      // Stored as a plain calendar date: the field type is `date`, and keeping
      // a time component would make two writes of the same day unequal and
      // defeat the compare-before-write skip in scriptWriteBack.
      return { ok: true, value: parsed.toISOString().slice(0, 10) };
    }
    case 'dropdown': {
      const value = String(raw);
      if (value.length > MAX_TEXT_LENGTH) return { ok: false, reason: 'too_long' };
      const choices = readChoices(definition.options);
      if (choices && !choices.includes(value)) return { ok: false, reason: 'not_a_choice' };
      return { ok: true, value };
    }
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd apps/api && npx vitest run src/services/customFields/validateValue.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/customFields/validateValue.ts apps/api/src/services/customFields/validateValue.test.ts
git commit -m "feat(custom-fields): shared value validator for definition-typed writes"
```

---

### Task 2: Marker extraction (both channels)

**Files:**
- Create: `apps/api/src/services/customFields/scriptWriteMarkers.ts`
- Test: `apps/api/src/services/customFields/scriptWriteMarkers.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export const CUSTOM_FIELD_MARKER = '::breeze:custom-fields::';
  export const MAX_MARKER_LINES = 20;
  export const MAX_MARKER_KEYS = 50;
  export const MAX_MARKER_JSON_BYTES = 8192;

  export interface ExtractedCustomFieldWrites {
    /** Candidate key -> raw value. Empty means "nothing to do". */
    candidates: Map<string, unknown>;
    /** Lines that looked like markers but could not be used. Never silent. */
    failures: Array<{ reason: 'marker_unparseable' | 'too_many_lines' | 'too_many_keys' | 'marker_too_large'; sample: string }>;
    /** Which channel supplied `candidates`. */
    channel: 'none' | 'stdout' | 'envelope';
  }

  export function extractCustomFieldWrites(
    stdout: string | undefined,
    resultEnvelope: unknown,
  ): ExtractedCustomFieldWrites;
  ```

**Context:** `resultEnvelope` is `result.result` from `commandResultSchema` — `z.any()`, so assume nothing. `sample` on a failure is for the operator's summary; truncate it to 200 chars and **never** include it in an audit log (it is raw script output).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/customFields/scriptWriteMarkers.test.ts
import { describe, it, expect } from 'vitest';
import { extractCustomFieldWrites, CUSTOM_FIELD_MARKER } from './scriptWriteMarkers';

const marker = (json: string) => `${CUSTOM_FIELD_MARKER} ${json}`;

describe('extractCustomFieldWrites', () => {
  it('returns nothing for ordinary stdout', () => {
    const out = extractCustomFieldWrites('hello\nworld\n', undefined);
    expect(out.channel).toBe('none');
    expect(out.candidates.size).toBe(0);
    expect(out.failures).toEqual([]);
  });

  it('extracts one marker line and leaves surrounding output alone', () => {
    const out = extractCustomFieldWrites(`scanning...\n${marker('{"ram_slot_type":"DDR5-5600"}')}\ndone\n`, undefined);
    expect(out.channel).toBe('stdout');
    expect(Object.fromEntries(out.candidates)).toEqual({ ram_slot_type: 'DDR5-5600' });
  });

  it('tolerates leading/trailing whitespace and CRLF line endings', () => {
    const out = extractCustomFieldWrites(`  ${marker('{"a":1}')}  \r\n`, undefined);
    expect(Object.fromEntries(out.candidates)).toEqual({ a: 1 });
  });

  it('lets a later marker line win for the same key', () => {
    const out = extractCustomFieldWrites(`${marker('{"a":1}')}\n${marker('{"a":2,"b":3}')}`, undefined);
    expect(Object.fromEntries(out.candidates)).toEqual({ a: 2, b: 3 });
  });

  it('reports an unparseable marker instead of dropping it silently', () => {
    const out = extractCustomFieldWrites(marker('{"a":'), undefined);
    expect(out.candidates.size).toBe(0);
    expect(out.failures[0]?.reason).toBe('marker_unparseable');
  });

  it('reports a marker mangled by the secret sanitizer', () => {
    // What SanitizeOutput does to `{"api_token":"abcdefgh"}`.
    const out = extractCustomFieldWrites(marker('{"api_token=[REDACTED]"}'), undefined);
    expect(out.failures[0]?.reason).toBe('marker_unparseable');
  });

  it('rejects a marker whose payload is not a plain object', () => {
    expect(extractCustomFieldWrites(marker('[1,2]'), undefined).failures[0]?.reason).toBe('marker_unparseable');
    expect(extractCustomFieldWrites(marker('"x"'), undefined).failures[0]?.reason).toBe('marker_unparseable');
  });

  it('caps the number of marker lines', () => {
    const lines = Array.from({ length: 25 }, (_, i) => marker(`{"k${i}":1}`)).join('\n');
    const out = extractCustomFieldWrites(lines, undefined);
    expect(out.candidates.size).toBe(20);
    expect(out.failures.some(f => f.reason === 'too_many_lines')).toBe(true);
  });

  it('caps the number of distinct keys', () => {
    const pairs = Array.from({ length: 60 }, (_, i) => `"k${i}":1`).join(',');
    const out = extractCustomFieldWrites(marker(`{${pairs}}`), undefined);
    expect(out.candidates.size).toBe(50);
    expect(out.failures.some(f => f.reason === 'too_many_keys')).toBe(true);
  });

  it('rejects an oversized marker line', () => {
    const out = extractCustomFieldWrites(marker(`{"a":"${'x'.repeat(9000)}"}`), undefined);
    expect(out.candidates.size).toBe(0);
    expect(out.failures[0]?.reason).toBe('marker_too_large');
  });

  it('reads the versioned envelope and prefers it over stdout', () => {
    const out = extractCustomFieldWrites(marker('{"from":"stdout"}'), {
      customFieldWrites: { schemaVersion: 1, fields: { from: 'envelope' } },
    });
    expect(out.channel).toBe('envelope');
    expect(Object.fromEntries(out.candidates)).toEqual({ from: 'envelope' });
  });

  it('ignores an envelope with the wrong schemaVersion and falls back to stdout', () => {
    const out = extractCustomFieldWrites(marker('{"from":"stdout"}'), {
      customFieldWrites: { schemaVersion: 2, fields: { from: 'envelope' } },
    });
    expect(out.channel).toBe('stdout');
    expect(Object.fromEntries(out.candidates)).toEqual({ from: 'stdout' });
  });

  it('ignores a bare customFields key on a whole-JSON stdout reparse', () => {
    // toWSCommandResult reparses whole-JSON stdout into `result`; an
    // unnamespaced key there must NOT be read as a write-back.
    const out = extractCustomFieldWrites('{"customFields":{"a":1}}', { customFields: { a: 1 } });
    expect(out.channel).toBe('none');
    expect(out.candidates.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd apps/api && npx vitest run src/services/customFields/scriptWriteMarkers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/customFields/scriptWriteMarkers.ts
/**
 * Extracts a script's custom-field write-back request from a command result.
 *
 * NOT A SECRETS CHANNEL. Channel A rides stdout, and stdout is persisted to
 * `script_executions.stdout` for any `scripts:read` user. A value written this
 * way is visible there as well as on the device record.
 *
 * Channel B (`result.customFieldWrites`, schemaVersion 1) is namespaced and
 * versioned on purpose: `toWSCommandResult` (agent/internal/heartbeat/
 * heartbeat.go) reparses whole-JSON stdout into the envelope's `result`, so an
 * unnamespaced `customFields` key would turn any script that prints such a
 * document into an unintended write-back.
 */

export const CUSTOM_FIELD_MARKER = '::breeze:custom-fields::';
export const MAX_MARKER_LINES = 20;
export const MAX_MARKER_KEYS = 50;
export const MAX_MARKER_JSON_BYTES = 8192;

export type MarkerFailureReason =
  | 'marker_unparseable'
  | 'too_many_lines'
  | 'too_many_keys'
  | 'marker_too_large';

export interface ExtractedCustomFieldWrites {
  candidates: Map<string, unknown>;
  failures: Array<{ reason: MarkerFailureReason; sample: string }>;
  channel: 'none' | 'stdout' | 'envelope';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sample(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** Channel B: `{ customFieldWrites: { schemaVersion: 1, fields: {...} } }`. */
function readEnvelope(resultEnvelope: unknown): Record<string, unknown> | null {
  if (!isPlainObject(resultEnvelope)) return null;
  const writes = resultEnvelope.customFieldWrites;
  if (!isPlainObject(writes)) return null;
  if (writes.schemaVersion !== 1) return null;
  return isPlainObject(writes.fields) ? writes.fields : null;
}

export function extractCustomFieldWrites(
  stdout: string | undefined,
  resultEnvelope: unknown,
): ExtractedCustomFieldWrites {
  const failures: ExtractedCustomFieldWrites['failures'] = [];
  const candidates = new Map<string, unknown>();

  const envelopeFields = readEnvelope(resultEnvelope);
  if (envelopeFields) {
    for (const [key, value] of Object.entries(envelopeFields)) {
      if (candidates.size >= MAX_MARKER_KEYS && !candidates.has(key)) {
        failures.push({ reason: 'too_many_keys', sample: key });
        continue;
      }
      candidates.set(key, value);
    }
    return { candidates, failures, channel: 'envelope' };
  }

  if (!stdout || !stdout.includes(CUSTOM_FIELD_MARKER)) {
    return { candidates, failures, channel: 'none' };
  }

  let lineCount = 0;
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith(CUSTOM_FIELD_MARKER)) continue;

    if (lineCount >= MAX_MARKER_LINES) {
      failures.push({ reason: 'too_many_lines', sample: sample(line) });
      continue;
    }
    lineCount += 1;

    const payload = line.slice(CUSTOM_FIELD_MARKER.length).trim();
    if (Buffer.byteLength(payload, 'utf8') > MAX_MARKER_JSON_BYTES) {
      failures.push({ reason: 'marker_too_large', sample: sample(payload) });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      failures.push({ reason: 'marker_unparseable', sample: sample(payload) });
      continue;
    }
    if (!isPlainObject(parsed)) {
      failures.push({ reason: 'marker_unparseable', sample: sample(payload) });
      continue;
    }

    for (const [key, value] of Object.entries(parsed)) {
      if (candidates.size >= MAX_MARKER_KEYS && !candidates.has(key)) {
        failures.push({ reason: 'too_many_keys', sample: key });
        continue;
      }
      candidates.set(key, value);
    }
  }

  return {
    candidates,
    failures,
    channel: candidates.size > 0 || failures.length > 0 ? 'stdout' : 'none',
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd apps/api && npx vitest run src/services/customFields/scriptWriteMarkers.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/customFields/scriptWriteMarkers.ts apps/api/src/services/customFields/scriptWriteMarkers.test.ts
git commit -m "feat(custom-fields): parse script write-back markers from stdout and result envelope"
```

---

### Task 3: Migration, schema, and export-policy registration

**Files:**
- Create: `apps/api/migrations/2026-10-06-100000-script-custom-field-writeback.sql`
- Modify: `apps/api/src/db/schema/customFields.ts`
- Modify: `apps/api/src/db/schema/scripts.ts:121-152`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:153` and `:332`
- Modify: `packages/shared/src/types/filters.ts:168-181`

**Interfaces:**
- Consumes: nothing.
- Produces: `customFieldDefinitions.scriptWrite` (boolean, not null, default false); `scriptExecutions.customFieldResult` (jsonb, nullable) typed as
  ```ts
  export interface ScriptCustomFieldWriteSummary {
    applied: string[];
    rejected: Array<{ key: string; reason: string }>;
  }
  ```
  declared in `apps/api/src/db/schema/scripts.ts` and re-exported for the service.

- [ ] **Step 1: Confirm the filename still sorts last**

```bash
ls apps/api/migrations | sort | tail -1
git -C . ls-tree -r --name-only origin/billing-by-units apps/api/migrations | grep -E '/[0-9].*\.sql$' | sort | tail -1
```
Both must sort **before** `2026-10-06-100000-script-custom-field-writeback.sql`. If either does not, rename the migration to sort after the newest one you see — do not fall back to today's date, which is more than a month behind the migration ceiling.

- [ ] **Step 2: Write the failing test**

Add to `apps/api/src/services/tenantExportPolicyRegistry.test.ts` if one exists; otherwise create the assertion in a new file `apps/api/src/services/customFields/scriptWriteBack.schema.test.ts`:

```ts
// apps/api/src/services/customFields/scriptWriteBack.schema.test.ts
import { describe, it, expect } from 'vitest';
import { CORE_TENANT_EXPORT_POLICY } from '../tenantExportPolicyRegistry';
import { customFieldDefinitions } from '../../db/schema/customFields';
import { scriptExecutions } from '../../db/schema/scripts';

describe('script custom-field write-back schema', () => {
  it('exposes scriptWrite on custom_field_definitions', () => {
    expect(customFieldDefinitions.scriptWrite.name).toBe('script_write');
  });

  it('exposes customFieldResult on script_executions', () => {
    expect(scriptExecutions.customFieldResult.name).toBe('custom_field_result');
  });

  it('classifies script_write as included in the export policy', () => {
    const policy = CORE_TENANT_EXPORT_POLICY['custom_field_definitions'];
    expect(policy.included).toContain('script_write');
  });

  it('classifies custom_field_result as an open container in the export policy', () => {
    const policy = CORE_TENANT_EXPORT_POLICY['script_executions'];
    // Every json/jsonb column is excludedOpen — no exceptions.
    expect(policy.excludedOpen).toContain('custom_field_result');
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `cd apps/api && npx vitest run src/services/customFields/scriptWriteBack.schema.test.ts`
Expected: FAIL — `Cannot read properties of undefined (reading 'name')`.

- [ ] **Step 4: Write the migration**

```sql
-- apps/api/migrations/2026-10-06-100000-script-custom-field-writeback.sql
-- Script custom-field write-back (#2698).
--
-- 1. custom_field_definitions.script_write — per-field opt-in gate. A script
--    result may only write a field whose definition sets this. DEFAULT false
--    means no existing field becomes script-writable on deploy; an admin turns
--    it on deliberately, per field, in Settings → Custom Fields.
-- 2. script_executions.custom_field_result — per-run summary of what the
--    write-back applied and rejected, so a rejected write is visible to the
--    operator instead of vanishing. NULL for every run that wrote nothing,
--    which is the overwhelming majority.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS). No inner BEGIN/COMMIT — autoMigrate
-- wraps each file in a transaction. No RLS change: custom_field_definitions is
-- already dual-axis (2026-06-11-i-custom-fields-dual-axis-rls.sql) and
-- script_executions is already org-scoped shape 1; a new column inherits both.

ALTER TABLE public.custom_field_definitions
  ADD COLUMN IF NOT EXISTS script_write boolean NOT NULL DEFAULT false;

ALTER TABLE public.script_executions
  ADD COLUMN IF NOT EXISTS custom_field_result jsonb;

COMMENT ON COLUMN public.custom_field_definitions.script_write IS
  'When true, a script running on a device may write this field via the ::breeze:custom-fields:: marker (#2698).';
COMMENT ON COLUMN public.script_executions.custom_field_result IS
  'Summary of custom-field writes applied/rejected for this run: {"applied":[...],"rejected":[{"key","reason"}]} (#2698).';
```

- [ ] **Step 5: Add the Drizzle columns**

In `apps/api/src/db/schema/customFields.ts`, inside `customFieldDefinitions`, after `deviceTypes`:

```ts
  // #2698: per-field opt-in for script write-back. Default false so no
  // existing field silently becomes writable by any script that runs.
  scriptWrite: boolean('script_write').notNull().default(false),
```

In `apps/api/src/db/schema/scripts.ts`, add the type above `scriptExecutions` and the column inside it:

```ts
/**
 * #2698: what the script custom-field write-back did for one execution.
 * `rejected.reason` is one of the CustomFieldWriteRejection values in
 * services/customFields/scriptWriteBack.ts. Keys only — never values.
 */
export interface ScriptCustomFieldWriteSummary {
  applied: string[];
  rejected: Array<{ key: string; reason: string }>;
}
```

```ts
  customFieldResult: jsonb('custom_field_result').$type<ScriptCustomFieldWriteSummary>(),
```

- [ ] **Step 6: Register both columns in the export policy**

`apps/api/src/services/tenantExportPolicyRegistry.ts`:
- Line 153, `custom_field_definitions`: append `"script_write"` to the `included` array. It is an ordinary boolean flag, not a credential and not an open container.
- Line 332, `script_executions`: append `"custom_field_result"` to the `excludedOpen` array. **It is jsonb, and every `json`/`jsonb`/`bytea` column is `excludedOpen` with no exceptions** — an open container may embed anything, so it never goes in `included` even when the contents look harmless.

- [ ] **Step 7: Extend the shared type**

`packages/shared/src/types/filters.ts`, in `CustomFieldDefinition`, after `deviceTypes`:

```ts
  scriptWrite: boolean; // #2698 — may a script on the device write this field?
```

- [ ] **Step 8: Run the schema test and the drift check**

```bash
cd apps/api && npx vitest run src/services/customFields/scriptWriteBack.schema.test.ts
cd apps/api && npx vitest run src/db/autoMigrate.test.ts
```
Expected: both PASS. `autoMigrate.test.ts` is the ordering regression guard — if it fails on filename order, rename the migration (it is unmerged and therefore still editable) and rerun.

Then, with a live database:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate && pnpm db:check-drift
```
Expected: migration applies, drift check clean.

- [ ] **Step 9: Commit**

```bash
git add apps/api/migrations/2026-10-06-100000-script-custom-field-writeback.sql \
        apps/api/src/db/schema/customFields.ts apps/api/src/db/schema/scripts.ts \
        apps/api/src/services/tenantExportPolicyRegistry.ts \
        packages/shared/src/types/filters.ts \
        apps/api/src/services/customFields/scriptWriteBack.schema.test.ts
git commit -m "feat(custom-fields): script_write gate + per-run write summary columns (#2698)"
```

---

### Task 4: The write-back service

**Files:**
- Create: `apps/api/src/services/customFields/scriptWriteBack.ts`
- Test: `apps/api/src/services/customFields/scriptWriteBack.test.ts`

**Interfaces:**
- Consumes: `extractCustomFieldWrites` (Task 2), `validateCustomFieldValue` (Task 1), `customFieldDefinitions.scriptWrite` and `ScriptCustomFieldWriteSummary` (Task 3).
- Produces:
  ```ts
  export type CustomFieldWriteRejection =
    | 'unknown_field'
    | 'not_script_writable'
    | 'not_applicable_to_device'
    | 'invalid_type' | 'out_of_range' | 'not_a_choice' | 'too_long' | 'invalid_date'
    | 'marker_unparseable' | 'too_many_lines' | 'too_many_keys' | 'marker_too_large';

  export interface ApplyScriptCustomFieldWritesInput {
    deviceId: string;
    orgId: string;
    agentId: string;
    commandId: string;
    stdout: string | undefined;
    resultEnvelope: unknown;
  }

  /** Returns null when the result carried no write-back request at all. */
  export function applyScriptCustomFieldWrites(
    input: ApplyScriptCustomFieldWritesInput,
  ): Promise<ScriptCustomFieldWriteSummary | null>;
  ```

**Context the implementer needs — read before writing code:**

1. The caller (`handleScriptResult`) runs inside `runWithAgentOrgDbAccess`, an **organization-scoped** DB context with `accessiblePartnerIds: []` and `currentPartnerId: null`. `custom_field_definitions` has a dual-axis policy (`breeze_has_org_access(org_id) OR breeze_has_partner_access(partner_id)`), so **partner-wide definitions (`org_id IS NULL`) are invisible from here**. The definitions SELECT must run under a system context — `runOutsideDbContext(() => withSystemDbAccessContext(...))`, which is the only form that genuinely opens a second context (a bare nested `withSystemDbAccessContext` early-returns and silently runs under the *org* context; see the comment block at `apps/api/src/routes/agentWs.ts:1476-1500`). Keep that system read as short as possible — it holds a second pooled connection for its duration (#1105).
2. The device UPDATE stays in the **ambient org context**, where `devices` RLS (shape 1) is a real backstop.
3. `orgId` alone does not tell you the partner. Read `organizations.partner_id` inside the same system context.
4. Do not run any of this when there is nothing to write. `extractCustomFieldWrites` is pure and cheap; call it first and return `null` on `channel === 'none'` with no failures.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/customFields/scriptWriteBack.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const selectDefinitions = vi.fn();
const selectDevice = vi.fn();
const updateDevice = vi.fn();
const auditCalls: unknown[] = [];

vi.mock('../../db', () => ({
  db: {},
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

vi.mock('./queries', () => ({
  loadDeviceForWriteBack: (...args: unknown[]) => selectDevice(...args),
  loadScriptWritableDefinitions: (...args: unknown[]) => selectDefinitions(...args),
  persistDeviceCustomFields: (...args: unknown[]) => updateDevice(...args),
}));

vi.mock('../auditEvents', () => ({
  ANONYMOUS_ACTOR_ID: '00000000-0000-0000-0000-000000000000',
  requestLikeFromSnapshot: () => ({ req: { header: () => undefined } }),
  writeAuditEventAsync: async (_c: unknown, event: unknown) => { auditCalls.push(event); },
}));

import { applyScriptCustomFieldWrites } from './scriptWriteBack';

const DEVICE = {
  id: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222',
  osType: 'windows',
  hostname: 'WS-01',
  displayName: null,
  customFields: { existing: 'keep' },
};

const marker = (json: string) => `::breeze:custom-fields:: ${json}`;

const input = (stdout: string | undefined, resultEnvelope: unknown = undefined) => ({
  deviceId: DEVICE.id,
  orgId: DEVICE.orgId,
  agentId: '33333333-3333-4333-8333-333333333333',
  commandId: '44444444-4444-4444-8444-444444444444',
  stdout,
  resultEnvelope,
});

beforeEach(() => {
  vi.clearAllMocks();
  auditCalls.length = 0;
  selectDevice.mockResolvedValue(DEVICE);
  updateDevice.mockResolvedValue(true);
});

describe('applyScriptCustomFieldWrites', () => {
  it('returns null and touches no table when there is no marker', async () => {
    const out = await applyScriptCustomFieldWrites(input('plain output'));
    expect(out).toBeNull();
    expect(selectDevice).not.toHaveBeenCalled();
    expect(selectDefinitions).not.toHaveBeenCalled();
    expect(updateDevice).not.toHaveBeenCalled();
  });

  it('applies a value for a script-writable field and merges with existing values', async () => {
    selectDefinitions.mockResolvedValue([
      { fieldKey: 'ram_slot_type', type: 'text', options: null, deviceTypes: null, scriptWrite: true },
    ]);
    const out = await applyScriptCustomFieldWrites(input(marker('{"ram_slot_type":"DDR5-5600"}')));
    expect(out).toEqual({ applied: ['ram_slot_type'], rejected: [] });
    expect(updateDevice).toHaveBeenCalledWith(
      DEVICE.id,
      DEVICE.orgId,
      { existing: 'keep', ram_slot_type: 'DDR5-5600' },
    );
  });

  it('rejects a field whose definition does not opt into script writes', async () => {
    selectDefinitions.mockResolvedValue([
      { fieldKey: 'asset_tag', type: 'text', options: null, deviceTypes: null, scriptWrite: false },
    ]);
    const out = await applyScriptCustomFieldWrites(input(marker('{"asset_tag":"A-1"}')));
    expect(out).toEqual({ applied: [], rejected: [{ key: 'asset_tag', reason: 'not_script_writable' }] });
    expect(updateDevice).not.toHaveBeenCalled();
  });

  it('rejects a key with no definition', async () => {
    selectDefinitions.mockResolvedValue([]);
    const out = await applyScriptCustomFieldWrites(input(marker('{"nope":"x"}')));
    expect(out).toEqual({ applied: [], rejected: [{ key: 'nope', reason: 'unknown_field' }] });
  });

  it('rejects a field not applicable to this device OS', async () => {
    selectDefinitions.mockResolvedValue([
      { fieldKey: 'brew_version', type: 'text', options: null, deviceTypes: ['macos'], scriptWrite: true },
    ]);
    const out = await applyScriptCustomFieldWrites(input(marker('{"brew_version":"4.0"}')));
    expect(out).toEqual({ applied: [], rejected: [{ key: 'brew_version', reason: 'not_applicable_to_device' }] });
  });

  it('rejects a value that fails type validation and still applies the sibling that passes', async () => {
    selectDefinitions.mockResolvedValue([
      { fieldKey: 'slots', type: 'number', options: null, deviceTypes: null, scriptWrite: true },
      { fieldKey: 'note', type: 'text', options: null, deviceTypes: null, scriptWrite: true },
    ]);
    const out = await applyScriptCustomFieldWrites(input(marker('{"slots":"many","note":"ok"}')));
    expect(out).toEqual({ applied: ['note'], rejected: [{ key: 'slots', reason: 'invalid_type' }] });
    expect(updateDevice).toHaveBeenCalledWith(DEVICE.id, DEVICE.orgId, { existing: 'keep', note: 'ok' });
  });

  it('skips the UPDATE when the merged object is unchanged', async () => {
    selectDefinitions.mockResolvedValue([
      { fieldKey: 'existing', type: 'text', options: null, deviceTypes: null, scriptWrite: true },
    ]);
    const out = await applyScriptCustomFieldWrites(input(marker('{"existing":"keep"}')));
    expect(out).toEqual({ applied: ['existing'], rejected: [] });
    expect(updateDevice).not.toHaveBeenCalled();
  });

  it('carries marker parse failures into the rejected list', async () => {
    selectDefinitions.mockResolvedValue([]);
    const out = await applyScriptCustomFieldWrites(input(marker('{"a":')));
    expect(out?.rejected).toEqual([{ key: '(marker)', reason: 'marker_unparseable' }]);
  });

  it('audits keys only, never values, with actorType agent', async () => {
    selectDefinitions.mockResolvedValue([
      { fieldKey: 'ram_slot_type', type: 'text', options: null, deviceTypes: null, scriptWrite: true },
    ]);
    await applyScriptCustomFieldWrites(input(marker('{"ram_slot_type":"DDR5-5600"}')));
    expect(auditCalls).toHaveLength(1);
    const event = auditCalls[0] as Record<string, any>;
    expect(event.actorType).toBe('agent');
    expect(event.action).toBe('device.custom_field.update');
    expect(event.resourceId).toBe(DEVICE.id);
    expect(event.details.changedFields).toEqual(['ram_slot_type']);
    expect(JSON.stringify(event)).not.toContain('DDR5-5600');
  });

  it('does not audit when nothing was applied', async () => {
    selectDefinitions.mockResolvedValue([]);
    await applyScriptCustomFieldWrites(input(marker('{"nope":"x"}')));
    expect(auditCalls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd apps/api && npx vitest run src/services/customFields/scriptWriteBack.test.ts`
Expected: FAIL — `./queries` and `./scriptWriteBack` do not exist.

- [ ] **Step 3: Implement the query seam**

Splitting the three DB touches into `queries.ts` is what makes the service unit-testable without a database, and it is where the DB-context discipline lives.

```ts
// apps/api/src/services/customFields/queries.ts
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { customFieldDefinitions } from '../../db/schema/customFields';
import { devices, organizations } from '../../db/schema';

export interface WriteBackDevice {
  id: string;
  orgId: string;
  osType: string | null;
  hostname: string | null;
  displayName: string | null;
  customFields: unknown;
}

export interface ScriptWritableDefinition {
  fieldKey: string;
  type: 'text' | 'number' | 'boolean' | 'dropdown' | 'date';
  options: unknown;
  deviceTypes: string[] | null;
  scriptWrite: boolean;
}

/** Ambient ORG context — `devices` is shape 1 and RLS is a real backstop here. */
export async function loadDeviceForWriteBack(deviceId: string): Promise<WriteBackDevice | null> {
  const [row] = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      osType: devices.osType,
      hostname: devices.hostname,
      displayName: devices.displayName,
      customFields: devices.customFields,
    })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  return row ?? null;
}

/**
 * SYSTEM context, deliberately.
 *
 * `custom_field_definitions` is dual-axis (org OR partner). The caller runs
 * under `runWithAgentOrgDbAccess`, which sets accessiblePartnerIds: [] and
 * currentPartnerId: null, so `breeze_has_partner_access(partner_id)` is false
 * and every partner-wide definition (org_id IS NULL) is INVISIBLE from there.
 * A partner that defines one field for all its orgs would silently have no
 * script-writable fields at all. See CLAUDE.md, Partner-Wide First §3.
 *
 * `runOutsideDbContext(() => withSystemDbAccessContext(...))` is the only form
 * that genuinely opens a second context — a bare nested
 * `withSystemDbAccessContext` early-returns and runs under the ORG context
 * instead. The scope is app-layer: an explicit org/partner predicate, kept
 * narrow, and the context is released immediately.
 */
export async function loadScriptWritableDefinitions(orgId: string): Promise<ScriptWritableDefinition[]> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext({ label: 'customFields.scriptWriteBack.definitions' }, async () => {
      const [org] = await db
        .select({ partnerId: organizations.partnerId })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);

      const ownerCondition = org?.partnerId
        ? or(
            eq(customFieldDefinitions.orgId, orgId),
            and(isNull(customFieldDefinitions.orgId), eq(customFieldDefinitions.partnerId, org.partnerId)),
          )
        : eq(customFieldDefinitions.orgId, orgId);

      return db
        .select({
          fieldKey: customFieldDefinitions.fieldKey,
          type: customFieldDefinitions.type,
          options: customFieldDefinitions.options,
          deviceTypes: customFieldDefinitions.deviceTypes,
          scriptWrite: customFieldDefinitions.scriptWrite,
        })
        .from(customFieldDefinitions)
        .where(ownerCondition);
    }),
  ) as Promise<ScriptWritableDefinition[]>;
}

/**
 * Ambient ORG context. The org predicate is redundant under RLS but pins the
 * write to the exact device the transport authorized — the same
 * defense-in-depth the PATCH endpoint applies
 * (routes/devices/customFieldValues.ts).
 *
 * Callers MUST skip this when the merged object is unchanged: every UPDATE on
 * `devices` that actually changes `custom_fields` fires
 * `breeze_partner_export_z_custom_values_update`, which takes
 * `pg_advisory_xact_lock(1000201, hashtext(org_id))` — an EXCLUSIVE per-org
 * lock held to COMMIT. A fleet-wide script would otherwise serialise every
 * device in the org behind it.
 */
export async function persistDeviceCustomFields(
  deviceId: string,
  orgId: string,
  merged: Record<string, unknown>,
): Promise<boolean> {
  const updated = await db
    .update(devices)
    .set({ customFields: merged, updatedAt: new Date() })
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
    .returning({ id: devices.id });
  return updated.length > 0;
}

// Referenced so an unused-import lint cannot strip `sql` if a future predicate
// needs it; remove if the linter is satisfied without it.
void sql;
```

- [ ] **Step 4: Implement the service**

```ts
// apps/api/src/services/customFields/scriptWriteBack.ts
/**
 * #2698 — apply a script's custom-field write-back to the device it ran on.
 *
 * Authorization is structural: `deviceId` comes from the transport that already
 * authorized the command row, and neither wire channel can name a device, so a
 * script can only ever write its own device's fields. The second gate is
 * per-field: `custom_field_definitions.script_write` must be true.
 */
import {
  extractCustomFieldWrites,
  type MarkerFailureReason,
} from './scriptWriteMarkers';
import { validateCustomFieldValue, type CustomFieldValueRejection } from './validateValue';
import {
  loadDeviceForWriteBack,
  loadScriptWritableDefinitions,
  persistDeviceCustomFields,
} from './queries';
import { requestLikeFromSnapshot, writeAuditEventAsync } from '../auditEvents';
import type { ScriptCustomFieldWriteSummary } from '../../db/schema/scripts';

export type CustomFieldWriteRejection =
  | 'unknown_field'
  | 'not_script_writable'
  | 'not_applicable_to_device'
  | CustomFieldValueRejection
  | MarkerFailureReason;

export interface ApplyScriptCustomFieldWritesInput {
  deviceId: string;
  orgId: string;
  agentId: string;
  commandId: string;
  stdout: string | undefined;
  resultEnvelope: unknown;
}

const AUDIT_REQUEST = requestLikeFromSnapshot({});

function readExistingCustomFields(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>) }
    : {};
}

export async function applyScriptCustomFieldWrites(
  input: ApplyScriptCustomFieldWritesInput,
): Promise<ScriptCustomFieldWriteSummary | null> {
  // Cheap, pure, and first: the overwhelming majority of script results carry
  // no marker at all and must cost zero database work.
  const extracted = extractCustomFieldWrites(input.stdout, input.resultEnvelope);
  if (extracted.channel === 'none') return null;

  const rejected: ScriptCustomFieldWriteSummary['rejected'] = extracted.failures.map((failure) => ({
    key: '(marker)',
    reason: failure.reason,
  }));
  const applied: string[] = [];

  if (extracted.candidates.size === 0) {
    return { applied, rejected };
  }

  const device = await loadDeviceForWriteBack(input.deviceId);
  if (!device) {
    // RLS or a concurrent delete. Report rather than pretending success.
    console.warn('[customFields] script write-back found no device', {
      deviceId: input.deviceId,
      commandId: input.commandId,
    });
    return { applied, rejected: [...rejected, { key: '(device)', reason: 'unknown_field' }] };
  }

  const definitions = await loadScriptWritableDefinitions(device.orgId);
  const byKey = new Map(definitions.map((d) => [d.fieldKey, d]));

  const existing = readExistingCustomFields(device.customFields);
  const merged = { ...existing };

  for (const [key, raw] of extracted.candidates) {
    const definition = byKey.get(key);
    if (!definition) {
      rejected.push({ key, reason: 'unknown_field' });
      continue;
    }
    if (definition.scriptWrite !== true) {
      rejected.push({ key, reason: 'not_script_writable' });
      continue;
    }
    if (
      Array.isArray(definition.deviceTypes) &&
      definition.deviceTypes.length > 0 &&
      (device.osType === null || !definition.deviceTypes.includes(device.osType))
    ) {
      rejected.push({ key, reason: 'not_applicable_to_device' });
      continue;
    }
    const validated = validateCustomFieldValue(definition, raw);
    if (!validated.ok) {
      rejected.push({ key, reason: validated.reason });
      continue;
    }
    merged[key] = validated.value;
    applied.push(key);
  }

  if (applied.length === 0) {
    return { applied, rejected };
  }

  // Compare BEFORE writing. An unchanged object means no UPDATE, which means
  // the devices statement trigger takes no per-org advisory lock and writes no
  // WAL — the difference between a fleet-wide script being cheap and being a
  // per-org serialisation point. Key order is irrelevant to equality here
  // because `merged` is built from a copy of `existing`.
  const unchanged = applied.every((key) => Object.is(merged[key], existing[key]));
  if (!unchanged) {
    const ok = await persistDeviceCustomFields(device.id, device.orgId, merged);
    if (!ok) {
      console.warn('[customFields] script write-back UPDATE matched no row', {
        deviceId: device.id,
        commandId: input.commandId,
      });
      return { applied: [], rejected: [...rejected, { key: '(device)', reason: 'unknown_field' }] };
    }
  }

  // Audited even when the write was a no-op merge: the script asserted these
  // values and that assertion is the auditable event. Keys only — a value can
  // be anything the script computed and must never enter the audit payload.
  await writeAuditEventAsync(AUDIT_REQUEST, {
    orgId: device.orgId,
    actorType: 'agent',
    actorId: device.id,
    action: 'device.custom_field.update',
    resourceType: 'device',
    resourceId: device.id,
    resourceName: device.hostname ?? device.displayName ?? undefined,
    details: {
      changedFields: applied,
      rejectedFields: rejected.map((r) => ({ key: r.key, reason: r.reason })),
      source: 'script',
      channel: extracted.channel,
      commandId: input.commandId,
      agentId: input.agentId,
    },
    result: rejected.length > 0 ? 'failure' : 'success',
  });

  return { applied, rejected };
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `cd apps/api && npx vitest run src/services/customFields/scriptWriteBack.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/customFields/queries.ts \
        apps/api/src/services/customFields/scriptWriteBack.ts \
        apps/api/src/services/customFields/scriptWriteBack.test.ts
git commit -m "feat(custom-fields): script write-back service with per-field gate and audit"
```

---

### Task 5: Wire into `handleScriptResult` and persist the summary

**Files:**
- Modify: `apps/api/src/services/commandResultHandlers.ts:332-533` (`handleScriptResult`)
- Test: `apps/api/src/services/commandResultHandlers.customFields.test.ts` (create)

**Interfaces:**
- Consumes: `applyScriptCustomFieldWrites` (Task 4), `scriptExecutions.customFieldResult` (Task 3).
- Produces: nothing new. `handleScriptResult` keeps its `Promise<void>` signature.

**Placement rules — get these right or the feature is subtly broken:**
- The write-back runs **before** the `script_executions` UPDATE, so the summary can be written in the same `executionValues` object rather than as a second UPDATE.
- It runs **regardless of `executionId`**. A script dispatched without an `executionId` in the command payload still ran on a device and its markers are still valid; only the summary persistence needs an execution row.
- It runs **regardless of exit code**. A script that discovers something and then exits non-zero has still discovered it.
- It must **never** be allowed to fail the surrounding handler. Wrap it in its own try/catch that logs + `captureException` and continues — losing a custom-field write must not cost the stdout persistence that `handleScriptResult` exists for (that regression class is #3162 / #3607, documented at length inside the function).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/commandResultHandlers.customFields.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const applyMock = vi.fn();
vi.mock('./customFields/scriptWriteBack', () => ({
  applyScriptCustomFieldWrites: (...args: unknown[]) => applyMock(...args),
}));

// Minimal Drizzle capture: we only assert what reaches scriptExecutions.set().
const setCalls: Array<Record<string, unknown>> = [];
vi.mock('../db', () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        setCalls.push(values);
        return { where: () => ({ returning: async () => [{ id: 'exec-1', scriptId: 'script-1' }] }) };
      },
    }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));

import { commandResultHandlers } from './commandResultHandlers';

const EXEC_ID = '55555555-5555-4555-8555-555555555555';
const DEVICE_ID = '11111111-1111-4111-8111-111111111111';

const call = (stdout: string | undefined, resultEnvelope: unknown = undefined) =>
  commandResultHandlers.script!({
    agentId: '33333333-3333-4333-8333-333333333333',
    command: { id: 'cmd-1', payload: { executionId: EXEC_ID }, type: 'script' } as never,
    commandId: 'cmd-1',
    result: { status: 'completed', exitCode: 0, stdout, result: resultEnvelope } as never,
    resolvedDeviceId: DEVICE_ID,
    stdout,
  });

beforeEach(() => {
  vi.clearAllMocks();
  setCalls.length = 0;
});

describe('handleScriptResult custom-field write-back', () => {
  it('passes stdout and the result envelope to the write-back', async () => {
    applyMock.mockResolvedValue(null);
    await call('::breeze:custom-fields:: {"a":1}', { customFieldWrites: { schemaVersion: 1, fields: {} } });
    expect(applyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: DEVICE_ID,
        commandId: 'cmd-1',
        stdout: '::breeze:custom-fields:: {"a":1}',
        resultEnvelope: { customFieldWrites: { schemaVersion: 1, fields: {} } },
      }),
    );
  });

  it('stores the summary on the script_executions row', async () => {
    applyMock.mockResolvedValue({ applied: ['a'], rejected: [] });
    await call('::breeze:custom-fields:: {"a":1}');
    expect(setCalls[0]?.customFieldResult).toEqual({ applied: ['a'], rejected: [] });
  });

  it('leaves customFieldResult null when the result carried no markers', async () => {
    applyMock.mockResolvedValue(null);
    await call('plain output');
    expect(setCalls[0]?.customFieldResult).toBeNull();
  });

  it('still persists stdout when the write-back throws', async () => {
    applyMock.mockRejectedValue(new Error('boom'));
    await call('::breeze:custom-fields:: {"a":1}');
    expect(setCalls[0]?.stdout).toContain('::breeze:custom-fields::');
    expect(setCalls[0]?.customFieldResult).toBeNull();
  });

  it('runs the write-back for a non-zero exit code', async () => {
    applyMock.mockResolvedValue({ applied: ['a'], rejected: [] });
    await commandResultHandlers.script!({
      agentId: 'agent-1',
      command: { id: 'cmd-2', payload: { executionId: EXEC_ID }, type: 'script' } as never,
      commandId: 'cmd-2',
      result: { status: 'completed', exitCode: 3, stdout: '::breeze:custom-fields:: {"a":1}' } as never,
      resolvedDeviceId: DEVICE_ID,
      stdout: '::breeze:custom-fields:: {"a":1}',
    });
    expect(applyMock).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/api && npx vitest run src/services/commandResultHandlers.customFields.test.ts`
Expected: FAIL — `applyMock` never called / `customFieldResult` undefined.

- [ ] **Step 3: Implement**

At the top of `apps/api/src/services/commandResultHandlers.ts`, add:

```ts
import { applyScriptCustomFieldWrites } from './customFields/scriptWriteBack';
import type { ScriptCustomFieldWriteSummary } from '../db/schema/scripts';
```

Inside `handleScriptResult`, immediately after `const payload = command.payload as Record<string, unknown> | null;` and **before** the `executionId` guard:

```ts
    // #2698 — a script may write its own device's custom fields by emitting
    // `::breeze:custom-fields:: {...}` on stdout (or, from agent Wave 3, a
    // versioned `result.customFieldWrites` envelope). Deliberately placed
    // before the executionId guard and outside the exit-code branch: a script
    // that discovers a fact and then exits non-zero, or that was dispatched
    // without an executionId, has still discovered it.
    //
    // Its own try/catch: losing a custom-field write must never cost the
    // stdout persistence this handler exists for. That is exactly the
    // regression class documented at length below (#3162, #3607).
    let customFieldResult: ScriptCustomFieldWriteSummary | null = null;
    try {
      customFieldResult = await applyScriptCustomFieldWrites({
        deviceId: resolvedDeviceId,
        orgId: '', // resolved from the device row inside the service
        agentId,
        commandId: command.id,
        stdout,
        resultEnvelope: result.result,
      });
      if (customFieldResult && customFieldResult.rejected.length > 0) {
        console.warn('[AgentWs] script custom-field write-back rejected entries', {
          commandId: command.id,
          deviceId: resolvedDeviceId,
          rejected: customFieldResult.rejected,
        });
      }
    } catch (err) {
      console.error(`[AgentWs] Custom-field write-back failed for command ${command.id}:`, err);
      captureException(err, undefined, { commandId: command.id, agentId });
      customFieldResult = null;
    }
```

Then add the column to the existing `executionValues` object literal:

```ts
        errorMessage: redactOptionalSecretText(result.error) ?? null,
        customFieldResult,
```

`orgId` on the input is vestigial once the service reads it off the device row — drop it from `ApplyScriptCustomFieldWritesInput` in Task 4 rather than passing `''`, and update the Task 4 tests to match. (Noted here rather than silently: the service derives `device.orgId` itself, so the caller has nothing to contribute.)

- [ ] **Step 4: Run both test files and confirm they pass**

```bash
cd apps/api && npx vitest run src/services/commandResultHandlers.customFields.test.ts src/services/customFields
```
Expected: PASS.

- [ ] **Step 5: Run the existing script-result suites for regressions**

```bash
cd apps/api && npx vitest run src/services/commandResultHandlers src/routes/agentWs
```
Expected: PASS. `agentWs.test.ts:3154` notes that `handleScriptResult`'s `scriptExecutions` update needs ambient DB context — if that test reddens, the write-back is opening a context in the wrong place.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/commandResultHandlers.ts \
        apps/api/src/services/commandResultHandlers.customFields.test.ts \
        apps/api/src/services/customFields/scriptWriteBack.ts \
        apps/api/src/services/customFields/scriptWriteBack.test.ts
git commit -m "feat(scripts): apply custom-field write-back on script result ingest (#2698)"
```

---

### Task 6: `scriptWrite` on the custom-field routes

**Files:**
- Modify: `apps/api/src/routes/customFields.ts:19-42` (create/update schemas), the `CustomFieldDefinition` local type at `:70-84`, and the insert/update/select column lists
- Test: `apps/api/src/routes/customFields_create_update_delete.test.ts`

**Interfaces:**
- Consumes: `customFieldDefinitions.scriptWrite` (Task 3).
- Produces: `POST /custom-fields` and `PUT /custom-fields/:id` accept `scriptWrite?: boolean`; every read path returns it.

Without this task Wave 1 ships a column no administrator can turn on, so it belongs in Wave 1, not Wave 2.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/routes/customFields_create_update_delete.test.ts`, following the existing describe blocks in that file for the auth/mock setup:

```ts
  it('defaults scriptWrite to false on create', async () => {
    const res = await app.request('/custom-fields', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: 'RAM slot type', fieldKey: 'ram_slot_type', type: 'text' }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).scriptWrite).toBe(false);
  });

  it('accepts scriptWrite true on create', async () => {
    const res = await app.request('/custom-fields', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: 'RAM slot type', fieldKey: 'ram_slot_type', type: 'text', scriptWrite: true }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).scriptWrite).toBe(true);
  });

  it('toggles scriptWrite on update', async () => {
    const res = await app.request(`/custom-fields/${existingFieldId}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ scriptWrite: true }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).scriptWrite).toBe(true);
  });
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/api && npx vitest run src/routes/customFields_create_update_delete.test.ts`
Expected: FAIL — `scriptWrite` is `undefined` in the responses.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/customFields.ts`:
- `createCustomFieldSchema`: add `scriptWrite: z.boolean().default(false),`
- `updateCustomFieldSchema`: add `scriptWrite: z.boolean().optional(),`
- Local `CustomFieldDefinition` type: add `scriptWrite: boolean;`
- Every `.select({...})` / `.returning({...})` column list in the file: add `scriptWrite: customFieldDefinitions.scriptWrite,`
- The insert values object: add `scriptWrite: body.scriptWrite,`
- The update values object: add `...(body.scriptWrite !== undefined ? { scriptWrite: body.scriptWrite } : {}),`

No new permission gate: `scriptWrite` is an attribute of a definition, and definition writes are already behind `requireCustomFieldWrite` plus `canManagePartnerWidePolicies` for partner-wide rows.

- [ ] **Step 4: Run and confirm PASS**

```bash
cd apps/api && npx vitest run src/routes/customFields
```
Expected: PASS across all five `customFields*` route test files. Check the reported file count — a bare substring filter also matches unrelated files.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/customFields.ts apps/api/src/routes/customFields_create_update_delete.test.ts
git commit -m "feat(custom-fields): expose scriptWrite on definition create/update"
```

---

### Task 7: Integration test against real Postgres

**Files:**
- Create: `apps/api/src/__tests__/integration/scriptCustomFieldWriteBack.integration.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: nothing.

**Placement matters:** it must live under `apps/api/src/__tests__/integration/` or it runs in **zero** CI jobs. After the first CI run, open the `integration-test` shard log and confirm the file actually executed — a `runIf`-skipped suite reads as green.

- [ ] **Step 1: Write the test**

```ts
// apps/api/src/__tests__/integration/scriptCustomFieldWriteBack.integration.test.ts
/**
 * #2698 — the properties that only a real database can prove:
 *
 *  1. A partner-wide field definition (org_id NULL) IS honoured, even though
 *     the caller runs in the agent's ORG-scoped context where the dual-axis
 *     RLS policy hides such rows. This is the CLAUDE.md Partner-Wide First §3
 *     trap and the reason the definitions read uses a system context.
 *  2. A device in another org is untouched — the write is pinned by org_id.
 *  3. The script_write gate actually blocks a non-opted-in field.
 *  4. An unchanged value writes no row (the per-org advisory-lock avoidance).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { devices, customFieldDefinitions, organizations } from '../../db/schema';
import { applyScriptCustomFieldWrites } from '../../services/customFields/scriptWriteBack';

// Use whatever fixture helper the sibling integration suites in this directory
// already use to create a partner + two orgs + a device; do not hand-roll one.
// (See customFieldDefinitionsPartnerRls / tenantCascade integration suites.)
import { createTenantFixture, type TenantFixture } from './helpers/tenantFixture';

let fixture: TenantFixture;

beforeAll(async () => { fixture = await createTenantFixture(); });
afterAll(async () => { await fixture.cleanup(); });

const marker = (json: string) => `::breeze:custom-fields:: ${json}`;

const runAsAgent = <T>(orgId: string, fn: () => Promise<T>) =>
  withDbAccessContext(
    { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], currentPartnerId: null, label: 'test.agent' },
    fn,
  );

describe('script custom-field write-back (integration)', () => {
  it('honours a PARTNER-WIDE definition from the agent org context', async () => {
    await withSystemDbAccessContext({ label: 'test.seed' }, async () => {
      await db.insert(customFieldDefinitions).values({
        orgId: null,
        partnerId: fixture.partnerId,
        name: 'RAM slot type',
        fieldKey: 'ram_slot_type',
        type: 'text',
        scriptWrite: true,
      });
    });

    const summary = await runAsAgent(fixture.orgAId, () =>
      applyScriptCustomFieldWrites({
        deviceId: fixture.deviceAId,
        agentId: fixture.agentAId,
        commandId: fixture.commandAId,
        stdout: marker('{"ram_slot_type":"DDR5-5600"}'),
        resultEnvelope: undefined,
      }),
    );

    expect(summary).toEqual({ applied: ['ram_slot_type'], rejected: [] });

    const [row] = await withSystemDbAccessContext({ label: 'test.read' }, () =>
      db.select({ customFields: devices.customFields }).from(devices).where(eq(devices.id, fixture.deviceAId)),
    );
    expect((row!.customFields as Record<string, unknown>).ram_slot_type).toBe('DDR5-5600');
  });

  it('leaves a same-key field on a device in ANOTHER org untouched', async () => {
    const [other] = await withSystemDbAccessContext({ label: 'test.read' }, () =>
      db.select({ customFields: devices.customFields }).from(devices).where(eq(devices.id, fixture.deviceBId)),
    );
    expect((other!.customFields as Record<string, unknown> | null)?.ram_slot_type).toBeUndefined();
  });

  it('blocks a field that has not opted into script writes', async () => {
    await withSystemDbAccessContext({ label: 'test.seed' }, async () => {
      await db.insert(customFieldDefinitions).values({
        orgId: fixture.orgAId,
        partnerId: null,
        name: 'Asset tag',
        fieldKey: 'asset_tag',
        type: 'text',
        scriptWrite: false,
      });
    });

    const summary = await runAsAgent(fixture.orgAId, () =>
      applyScriptCustomFieldWrites({
        deviceId: fixture.deviceAId,
        agentId: fixture.agentAId,
        commandId: fixture.commandAId,
        stdout: marker('{"asset_tag":"A-1"}'),
        resultEnvelope: undefined,
      }),
    );

    expect(summary).toEqual({ applied: [], rejected: [{ key: 'asset_tag', reason: 'not_script_writable' }] });
  });

  it('does not bump updated_at when the value is unchanged', async () => {
    const before = await withSystemDbAccessContext({ label: 'test.read' }, () =>
      db.select({ updatedAt: devices.updatedAt }).from(devices).where(eq(devices.id, fixture.deviceAId)),
    );

    const summary = await runAsAgent(fixture.orgAId, () =>
      applyScriptCustomFieldWrites({
        deviceId: fixture.deviceAId,
        agentId: fixture.agentAId,
        commandId: fixture.commandAId,
        stdout: marker('{"ram_slot_type":"DDR5-5600"}'),
        resultEnvelope: undefined,
      }),
    );
    expect(summary).toEqual({ applied: ['ram_slot_type'], rejected: [] });

    const after = await withSystemDbAccessContext({ label: 'test.read' }, () =>
      db.select({ updatedAt: devices.updatedAt }).from(devices).where(eq(devices.id, fixture.deviceAId)),
    );
    expect(after[0]!.updatedAt).toEqual(before[0]!.updatedAt);
  });

  it('reads the org partner via organizations, not the agent context', async () => {
    const [org] = await withSystemDbAccessContext({ label: 'test.read' }, () =>
      db.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, fixture.orgAId)),
    );
    expect(org!.partnerId).toBe(fixture.partnerId);
  });
});
```

- [ ] **Step 2: Run it against a live database**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/scriptCustomFieldWriteBack.integration.test.ts
```
Expected: PASS, 5 tests. If the partner-wide test fails with `applied: []` and `rejected: [{reason:'unknown_field'}]`, the definitions read is running in the org context, not a system context — that is the whole point of the test.

Use `--pool=threads --maxWorkers=2` if a dev stack is running locally; the forks pool hangs under `wt-stack`.

- [ ] **Step 3: Run the RLS contract suite**

```bash
cd apps/api && npx vitest run --config vitest.config.rls.ts
```
Expected: PASS. No new tables, so no allowlist change is expected — a failure here means a column landed somewhere unregistered.

- [ ] **Step 4: Commit and open the PR**

```bash
git add apps/api/src/__tests__/integration/scriptCustomFieldWriteBack.integration.test.ts
git commit -m "test(custom-fields): integration coverage for script write-back tenancy and gate"
git push -u origin <branch>
gh pr create --base main --title "feat(scripts): write device custom fields from a script (#2698)" --body "…"
```

PR body must include `Closes #2698` only if Waves 2-4 are dropped; otherwise reference the issue without closing it. Verify in the PR checks that **Integration Tests** ran and that the new file appears in a shard log.

---

# Wave 2 — Web UI and documentation (one PR)

Nothing in Wave 1 is discoverable without this. Independent PR off `main`.

### Task 8: `Script write` toggle on the Custom Fields settings page

**Files:**
- Modify: `apps/web/src/components/settings/CustomFieldsPage.tsx`
- Test: `apps/web/src/components/settings/CustomFieldsPage.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `scriptWrite` on the API's create/update/read payloads (Wave 1, Task 6); `CustomFieldDefinition.scriptWrite` in `@breeze/shared`.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/settings/CustomFieldsPage.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CustomFieldsPage from './CustomFieldsPage';

describe('CustomFieldsPage script-write toggle', () => {
  it('sends scriptWrite in the create payload when the toggle is on', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<CustomFieldsPage />);
    fireEvent.click(await screen.findByTestId('custom-field-add'));
    fireEvent.change(screen.getByTestId('custom-field-name'), { target: { value: 'RAM slot type' } });
    fireEvent.change(screen.getByTestId('custom-field-key'), { target: { value: 'ram_slot_type' } });
    fireEvent.click(screen.getByTestId('custom-field-script-write'));
    fireEvent.click(screen.getByTestId('custom-field-submit'));

    const body = JSON.parse(String((fetchSpy.mock.calls.at(-1)?.[1] as RequestInit).body));
    expect(body.scriptWrite).toBe(true);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/web && npx vitest run src/components/settings/CustomFieldsPage.test.tsx`
Expected: FAIL — `custom-field-script-write` testid not found.

- [ ] **Step 3: Implement**

In `CustomFieldsPage.tsx`:
- Add `const [formScriptWrite, setFormScriptWrite] = useState(false);` next to `formRequired` (line 48).
- Reset it in the "open create modal" handler and set it from `field.scriptWrite` in the "open edit modal" handler (next to line 118's `setFormRequired`).
- Add `scriptWrite: formScriptWrite,` to the submit payload (next to line 237's `required: formRequired`).
- Add a checkbox next to the existing "Required field" checkbox (line 665), with `data-testid="custom-field-script-write"`, label copy: **"Allow scripts to write this field"**, helper text: **"Scripts running on a device can set this field by printing `::breeze:custom-fields:: {\"key\": \"value\"}`. The value also appears in the script's saved output — never write a secret this way."**
- Add a **Script write** column to the table (next to the `required` column at line 377/401) rendering a badge when true.
- The submit already goes through the page's existing mutation path; verify it is wrapped in `runAction` (`apps/web/src/lib/runAction.ts`). If it is not, wrap it — the `no-silent-mutations` test guards the adopted set and a new mutation must not regress it.
- Add the two new i18n keys to `en` and every other locale file that `customFieldsPage.form.requiredField` appears in. A missing key in `tr-TR` reds the locale-parity test.

- [ ] **Step 4: Run and confirm PASS**

```bash
cd apps/web && npx vitest run src/components/settings/CustomFieldsPage
cd apps/web && npx vitest run src/lib/__tests__/no-silent-mutations.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/CustomFieldsPage.tsx apps/web/src/components/settings/CustomFieldsPage.test.tsx apps/web/src/locales
git commit -m "feat(web): script-write toggle on custom field definitions"
```

---

### Task 9: Surface the per-run write summary and document the feature

**Files:**
- Modify: the script-execution detail component that renders `stdout` (find it with `grep -rn "exitCode" apps/web/src/components/scripts/`)
- Modify: `apps/docs/src/content/docs/features/custom-fields.mdx`
- Modify: `apps/docs/src/content/docs/features/scripts.mdx`

**Interfaces:**
- Consumes: `script_executions.custom_field_result` (Wave 1, Task 3), returned by whichever execution-detail endpoint the component calls. Add the column to that endpoint's select list if it is not already `select *`.
- Produces: nothing.

- [ ] **Step 1: Add the column to the execution-detail API response**

```bash
grep -rn "scriptExecutions.stdout" apps/api/src/routes/scripts.ts apps/api/src/services/aiToolsScripts.ts
```
Add `customFieldResult: scriptExecutions.customFieldResult,` to each explicit select list that already returns `stdout`.

- [ ] **Step 2: Write the failing web test**

```tsx
it('shows applied and rejected custom-field writes', async () => {
  renderExecution({
    stdout: 'ok',
    customFieldResult: { applied: ['ram_slot_type'], rejected: [{ key: 'asset_tag', reason: 'not_script_writable' }] },
  });
  expect(await screen.findByTestId('exec-custom-fields-applied')).toHaveTextContent('ram_slot_type');
  expect(screen.getByTestId('exec-custom-fields-rejected')).toHaveTextContent('asset_tag');
  expect(screen.getByTestId('exec-custom-fields-rejected')).toHaveTextContent('not_script_writable');
});
```

- [ ] **Step 3: Run, confirm failure, implement the panel, confirm PASS**

Render nothing at all when `customFieldResult` is null. Render the rejected list even when `applied` is empty — a silently-rejected write is the failure mode this panel exists to prevent.

- [ ] **Step 4: Write the docs section**

Add to `apps/docs/src/content/docs/features/custom-fields.mdx` a section **"Writing custom fields from a script"** covering:
- Turn on **Allow scripts to write this field** on the definition first; it is off by default.
- The marker grammar, verbatim, with the caps.
- Working one-liners:
  ```powershell
  # PowerShell
  $fields = @{ ram_slot_type = 'DDR5-5600'; free_dimm_slots = 2 }
  Write-Output "::breeze:custom-fields:: $($fields | ConvertTo-Json -Compress)"
  ```
  ```bash
  # Bash
  echo "::breeze:custom-fields:: {\"ram_slot_type\":\"DDR5-5600\",\"free_dimm_slots\":2}"
  ```
  ```python
  # Python
  import json
  print("::breeze:custom-fields:: " + json.dumps({"ram_slot_type": "DDR5-5600"}))
  ```
- `null` clears a field.
- Type coercion rules per field type, and the `dropdown` choice constraint.
- **Never write a secret this way** — the marker rides stdout, which is saved with the run.
- The `api_key=`/`token=`/`secret=` sanitizer caveat and what `marker_unparseable` in the run summary means.
- Cross-link the read side: bind a script parameter with source **Device custom field** to read one.

Add a short pointer in `apps/docs/src/content/docs/features/scripts.mdx`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/scripts apps/api/src/routes/scripts.ts apps/docs/src/content/docs/features
git commit -m "feat(web,docs): surface and document script custom-field write-back"
```

---

# Wave 3 — Agent structured channel (one PR, Go)

**Ships only after Wave 1 is merged and deployed.** The API accepts Channel B from Wave 1, so there is no flag day: a Wave-3 agent talking to a pre-Wave-1 server simply has its envelope ignored and its stdout markers unparsed, which is the status quo.

**Why it is worth doing at all:** the agent's `SanitizeOutput` mangles a marker whose JSON contains a `token`/`secret`/`password`-shaped key or value *before* the server ever sees it. Extracting from **raw** stdout, ahead of the sanitizer, is the only place that can be fixed.

### Task 10: Extract markers from raw stdout in the executor

**Files:**
- Create: `agent/internal/executor/customfields.go`
- Test: `agent/internal/executor/customfields_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```go
  const CustomFieldMarker = "::breeze:custom-fields::"

  // ExtractCustomFields pulls every marker line out of raw (pre-sanitizer)
  // stdout. It returns the merged field map (later lines win) and stdout with
  // the marker lines removed. A nil map means "no markers".
  func ExtractCustomFields(stdout string) (map[string]any, string)
  ```

- [ ] **Step 1: Write the failing table-driven test**

```go
// agent/internal/executor/customfields_test.go
package executor

import (
	"reflect"
	"testing"
)

func TestExtractCustomFields(t *testing.T) {
	tests := []struct {
		name       string
		stdout     string
		wantFields map[string]any
		wantStdout string
	}{
		{
			name:       "no marker",
			stdout:     "hello\nworld\n",
			wantFields: nil,
			wantStdout: "hello\nworld\n",
		},
		{
			name:       "single marker is extracted and removed",
			stdout:     "scanning\n::breeze:custom-fields:: {\"a\":\"1\"}\ndone\n",
			wantFields: map[string]any{"a": "1"},
			wantStdout: "scanning\ndone\n",
		},
		{
			name:       "later marker wins",
			stdout:     "::breeze:custom-fields:: {\"a\":1}\n::breeze:custom-fields:: {\"a\":2,\"b\":3}\n",
			wantFields: map[string]any{"a": float64(2), "b": float64(3)},
			wantStdout: "",
		},
		{
			name:       "secret-shaped value survives because we run before SanitizeOutput",
			stdout:     "::breeze:custom-fields:: {\"vault_token_id\":\"abcdefgh\"}\n",
			wantFields: map[string]any{"vault_token_id": "abcdefgh"},
			wantStdout: "",
		},
		{
			name:       "unparseable marker is left in stdout for the operator to see",
			stdout:     "::breeze:custom-fields:: {\"a\":\n",
			wantFields: nil,
			wantStdout: "::breeze:custom-fields:: {\"a\":\n",
		},
		{
			name:       "CRLF line endings",
			stdout:     "::breeze:custom-fields:: {\"a\":\"1\"}\r\nx\r\n",
			wantFields: map[string]any{"a": "1"},
			wantStdout: "x\r\n",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fields, stdout := ExtractCustomFields(tt.stdout)
			if !reflect.DeepEqual(fields, tt.wantFields) {
				t.Fatalf("fields = %#v, want %#v", fields, tt.wantFields)
			}
			if stdout != tt.wantStdout {
				t.Fatalf("stdout = %q, want %q", stdout, tt.wantStdout)
			}
		})
	}
}

func TestExtractCustomFieldsCaps(t *testing.T) {
	var b []byte
	for i := 0; i < 25; i++ {
		b = append(b, []byte("::breeze:custom-fields:: {\"k\":1}\n")...)
	}
	fields, _ := ExtractCustomFields(string(b))
	if len(fields) != 1 {
		t.Fatalf("expected the merged map to hold 1 key, got %d", len(fields))
	}
}
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd agent && go test -race ./internal/executor/ -run TestExtractCustomFields`
Expected: FAIL — `undefined: ExtractCustomFields`.

- [ ] **Step 3: Implement**

```go
// agent/internal/executor/customfields.go
package executor

import (
	"encoding/json"
	"strings"
)

// CustomFieldMarker is the stdout sentinel a script uses to write its own
// device's custom fields (#2698). Must stay byte-identical to
// CUSTOM_FIELD_MARKER in
// apps/api/src/services/customFields/scriptWriteMarkers.ts.
const CustomFieldMarker = "::breeze:custom-fields::"

const (
	maxCustomFieldMarkerLines = 20
	maxCustomFieldKeys        = 50
	maxCustomFieldJSONBytes   = 8192
)

// ExtractCustomFields pulls every well-formed marker line out of RAW stdout —
// deliberately before SanitizeOutput, which rewrites `token=`/`secret=`-shaped
// substrings and would otherwise corrupt a marker beyond JSON.Unmarshal's
// reach. Returns the merged map (later lines win) and stdout with the consumed
// lines removed. Unparseable marker lines are LEFT IN stdout so the operator
// can see what the script actually printed.
func ExtractCustomFields(stdout string) (map[string]any, string) {
	if !strings.Contains(stdout, CustomFieldMarker) {
		return nil, stdout
	}

	lines := strings.Split(stdout, "\n")
	kept := make([]string, 0, len(lines))
	var fields map[string]any
	markerLines := 0

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, CustomFieldMarker) || markerLines >= maxCustomFieldMarkerLines {
			kept = append(kept, line)
			continue
		}

		payload := strings.TrimSpace(strings.TrimPrefix(trimmed, CustomFieldMarker))
		if len(payload) > maxCustomFieldJSONBytes {
			kept = append(kept, line)
			continue
		}

		var parsed map[string]any
		if err := json.Unmarshal([]byte(payload), &parsed); err != nil || parsed == nil {
			kept = append(kept, line)
			continue
		}

		markerLines++
		if fields == nil {
			fields = make(map[string]any, len(parsed))
		}
		for k, v := range parsed {
			if len(fields) >= maxCustomFieldKeys {
				if _, exists := fields[k]; !exists {
					continue
				}
			}
			fields[k] = v
		}
		// consumed: not appended to kept
	}

	return fields, strings.Join(kept, "\n")
}
```

- [ ] **Step 4: Run and confirm PASS**

Run: `cd agent && go test -race ./internal/executor/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/executor/customfields.go agent/internal/executor/customfields_test.go
git commit -m "feat(agent): extract custom-field markers from raw script stdout"
```

---

### Task 11: Emit the versioned envelope and carry it over the WebSocket

**Files:**
- Modify: `agent/internal/heartbeat/handlers_script.go:196-220` (the `tools.CommandResult` build site at the end of `handleScriptInner`)
- Modify: `agent/internal/heartbeat/heartbeat.go:5722-5741` (`toWSCommandResult`)
- Test: `agent/internal/heartbeat/handlers_script_test.go`, `agent/internal/heartbeat/heartbeat_test.go` (or wherever `toWSCommandResult` is already covered — `grep -rn "toWSCommandResult" agent/internal/heartbeat/*_test.go`)

**Interfaces:**
- Consumes: `executor.ExtractCustomFields` (Task 10).
- Produces: `tools.CommandResult.Result` set to `map[string]any{"customFieldWrites": map[string]any{"schemaVersion": 1, "fields": fields}}` for script results that carried markers; `toWSCommandResult` preserves an explicitly-set `Result`.

- [ ] **Step 1: Write the failing tests**

```go
func TestToWSCommandResultPreservesExplicitResult(t *testing.T) {
	explicit := map[string]any{"customFieldWrites": map[string]any{"schemaVersion": 1}}
	got := toWSCommandResult("cmd-1", tools.CommandResult{
		Status: "completed",
		Stdout: "not json at all",
		Result: explicit,
	})
	if !reflect.DeepEqual(got.Result, explicit) {
		t.Fatalf("Result = %#v, want %#v", got.Result, explicit)
	}
}

func TestToWSCommandResultStillReparsesJSONStdoutWhenResultIsNil(t *testing.T) {
	got := toWSCommandResult("cmd-2", tools.CommandResult{
		Status: "completed",
		Stdout: `{"hosts":[]}`,
	})
	if got.Result == nil {
		t.Fatal("expected the stdout reparse to still populate Result for discovery/backup/snmp handlers")
	}
}

func TestHandleScriptEmitsCustomFieldEnvelopeAndStripsMarker(t *testing.T) {
	// Use the existing script-handler harness in this file (see
	// handlers_script_test.go:280 for the shape).
	res := runScriptHandler(t, `echo '::breeze:custom-fields:: {"a":"1"}'`)
	if strings.Contains(res.Stdout, "::breeze:custom-fields::") {
		t.Fatal("marker line must be stripped from the stdout the server persists")
	}
	writes, ok := res.Result.(map[string]any)["customFieldWrites"].(map[string]any)
	if !ok {
		t.Fatalf("missing customFieldWrites envelope: %#v", res.Result)
	}
	if writes["schemaVersion"] != 1 {
		t.Fatalf("schemaVersion = %#v, want 1", writes["schemaVersion"])
	}
	if writes["fields"].(map[string]any)["a"] != "1" {
		t.Fatalf("fields = %#v", writes["fields"])
	}
}
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd agent && go test -race ./internal/heartbeat/`
Expected: FAIL on all three.

- [ ] **Step 3: Implement**

In `handlers_script.go`, at the local-executor result build site (replacing the current `Stdout: executor.SanitizeOutput(scriptResult.Stdout)` line):

```go
	// #2698: pull markers out of RAW stdout, BEFORE SanitizeOutput. The
	// sanitizer rewrites `token=`/`secret=`-shaped substrings, which corrupts a
	// marker's JSON past recovery — the server's stdout-scanning fallback
	// (Wave 1) can only see post-sanitizer text, which is exactly the gap this
	// closes. The marker lines are stripped so the operator's saved output is
	// the script's real output.
	customFields, cleanedStdout := executor.ExtractCustomFields(scriptResult.Stdout)

	result := tools.CommandResult{
		Status:     status,
		ExitCode:   scriptResult.ExitCode,
		Stdout:     executor.SanitizeOutput(cleanedStdout),
		Stderr:     executor.SanitizeOutput(scriptResult.Stderr),
		Error:      scriptResult.Error,
		DurationMs: time.Since(start).Milliseconds(),
	}
	if len(customFields) > 0 {
		result.Result = map[string]any{
			"customFieldWrites": map[string]any{
				"schemaVersion": 1,
				"fields":        customFields,
			},
		}
	}
	return result
```

Apply the same extraction in `executeViaUserHelper`'s nested-result branch (`handlers_script.go:410`), where the helper's stdout is unpacked — otherwise a `runAs: user` script silently loses the feature.

Note: `handleScript`'s secret redactor (`redact(res.Stdout)`) runs after this returns and does not touch `res.Result`. That is correct — Wave 1 already documents that this is not a secrets channel — but add a line to the wrapper's comment saying so, so a future reader does not assume `Result` is redacted.

In `heartbeat.go`, `toWSCommandResult`:

```go
	// An explicitly-set Result wins. The stdout reparse below stays for the
	// handlers that depend on it (discovery, backup, snmp, monitor read
	// `result`, not stdout) but must never clobber a handler that built a
	// structured payload on purpose — #2698's customFieldWrites envelope is the
	// first such payload on the script path.
	if result.Result != nil {
		wsResult.Result = result.Result
	} else if result.Error != "" {
		wsResult.Error = result.Error
	} else if result.Stdout != "" {
		var jsonResult any
		if err := json.Unmarshal([]byte(result.Stdout), &jsonResult); err == nil {
			wsResult.Result = jsonResult
		}
	}
```

Careful: the current code sets `wsResult.Error` in the first branch. Preserve that — set `wsResult.Error = result.Error` unconditionally before the chain, then use the chain only to decide `Result`. Confirm against the existing tests for `toWSCommandResult` that error propagation is unchanged.

- [ ] **Step 4: Run the full agent suite**

```bash
cd agent && go test -race ./...
```
Expected: PASS. Pay attention to `internal/websocket` and `internal/heartbeat` — `toWSCommandResult` is on the path of every command type.

- [ ] **Step 5: Commit and open the PR**

```bash
git add agent/internal/heartbeat/handlers_script.go agent/internal/heartbeat/heartbeat.go agent/internal/heartbeat/*_test.go
git commit -m "feat(agent): emit versioned customFieldWrites envelope from script results (#2698)"
```

PR body must state that this PR is inert without Wave 1 already deployed, and that mixed-version fleets are safe in both directions.

---

# Wave 4 — Output binding (optional, one PR)

Answers tim104979's Tactical RMM screenshot directly: bind a script's *whole* stdout to one custom field, with no marker convention at all. Reuses Wave 1's validator and persistence untouched. Ship only if wanted — Waves 1-3 close the issue's stated ask on their own.

### Task 12: `outputCustomFieldKey` on a script definition

**Files:**
- Create: `apps/api/migrations/<sorts after Wave 1's file>-script-output-custom-field.sql` — `ALTER TABLE public.scripts ADD COLUMN IF NOT EXISTS output_custom_field_key varchar(100);`
- Modify: `apps/api/src/db/schema/scripts.ts`, `apps/api/src/services/tenantExportPolicyRegistry.ts` (**`scripts` is in the org cascade list — the new column must be classified; a `varchar` key name goes in `included`**), `apps/api/src/services/scriptDispatch.ts` (stamp the key into the command payload), `apps/api/src/services/customFields/scriptWriteBack.ts` (accept an optional `boundFieldKey` whose value is the trimmed stdout), `apps/api/src/routes/scripts.ts`, `apps/web/src/components/scripts/*` (a picker on the script form)
- Test: extend `scriptWriteBack.test.ts` and the integration suite

**Interfaces:**
- Consumes: `applyScriptCustomFieldWrites` (Wave 1).
- Produces: `ApplyScriptCustomFieldWritesInput.boundFieldKey?: string` — when set, the trimmed, first-4096-chars stdout is proposed as that field's value **before** marker candidates are merged, so an explicit marker still wins.

- [ ] **Step 1: Confirm the migration filename sorts after Wave 1's**

```bash
ls apps/api/migrations | sort | tail -1
```

- [ ] **Step 2: Write the failing service test**

```ts
it('writes trimmed stdout into the bound field when boundFieldKey is set', async () => {
  selectDefinitions.mockResolvedValue([
    { fieldKey: 'last_scan', type: 'text', options: null, deviceTypes: null, scriptWrite: true },
  ]);
  const out = await applyScriptCustomFieldWrites({ ...input('  DDR5-5600  \n'), boundFieldKey: 'last_scan' });
  expect(out).toEqual({ applied: ['last_scan'], rejected: [] });
  expect(updateDevice).toHaveBeenCalledWith(DEVICE.id, DEVICE.orgId, { existing: 'keep', last_scan: 'DDR5-5600' });
});

it('lets an explicit marker override the bound field', async () => {
  selectDefinitions.mockResolvedValue([
    { fieldKey: 'last_scan', type: 'text', options: null, deviceTypes: null, scriptWrite: true },
  ]);
  const out = await applyScriptCustomFieldWrites({
    ...input('noise\n::breeze:custom-fields:: {"last_scan":"explicit"}\n'),
    boundFieldKey: 'last_scan',
  });
  expect(updateDevice).toHaveBeenCalledWith(DEVICE.id, DEVICE.orgId, { existing: 'keep', last_scan: 'explicit' });
});

it('still respects the script_write gate for a bound field', async () => {
  selectDefinitions.mockResolvedValue([
    { fieldKey: 'last_scan', type: 'text', options: null, deviceTypes: null, scriptWrite: false },
  ]);
  const out = await applyScriptCustomFieldWrites({ ...input('x'), boundFieldKey: 'last_scan' });
  expect(out).toEqual({ applied: [], rejected: [{ key: 'last_scan', reason: 'not_script_writable' }] });
});
```

- [ ] **Step 3: Run, confirm failure, implement, confirm PASS**

In `applyScriptCustomFieldWrites`, seed the candidate map before merging extracted markers:

```ts
  const candidates = new Map<string, unknown>();
  if (input.boundFieldKey && typeof input.stdout === 'string') {
    candidates.set(input.boundFieldKey, input.stdout.trim().slice(0, 4096));
  }
  for (const [key, value] of extracted.candidates) candidates.set(key, value);
```

and change the early return so a bound key alone is enough to proceed (`extracted.channel === 'none' && !input.boundFieldKey` returns null).

In `handleScriptResult`, read the key off the command payload (`payload?.outputCustomFieldKey`) — `scriptDispatch` stamps it there at dispatch, exactly like `executionId` and `batchId`, so the ingest path needs no extra query.

- [ ] **Step 4: Run everything and commit**

```bash
cd apps/api && npx vitest run src/services/customFields src/services/commandResultHandlers
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/scriptCustomFieldWriteBack.integration.test.ts
git commit -m "feat(scripts): bind script stdout to a custom field (#2698)"
```

---

## Self-Review

**1. Issue coverage.** Every ask in #2698 maps to a task or to the "Already shipped" table:
- "Agent-side helper for self-write" → Waves 1 + 3. `BREEZE_DEVICE_ID` is deliberately **not** added: the chosen design carries device identity in the transport, so exposing a device UUID to script code would create an attack surface (a script could try to write another device) for no benefit. Recorded here so a reviewer does not read it as an omission.
- "Server-side filtering on custom fields" → shipped in `filterEngine.ts`; the residual `GET /devices` query-param gap is named and explicitly out of scope.
- "Custom field conditions in automation targeting" → shipped for Advanced via `targetType: 'filter'`; the Simple-builder gap is named and out of scope.
- tim104979's Tactical "save stdout to a custom field" → Wave 4.

**2. Placeholder scan.** No `TBD`, no "add validation", no "similar to Task N". Two intentional soft spots, both named rather than hidden: Task 7 depends on whichever tenant fixture helper the sibling integration suites already use (hand-rolling a second one would be worse), and Task 9 locates the script-execution detail component by grep because the component name is not stable enough to hard-code.

**3. Type consistency.** `validateCustomFieldValue` / `CustomFieldValidationTarget` / `CustomFieldValueResult` (Task 1) are used unchanged in Task 4. `extractCustomFieldWrites` / `ExtractedCustomFieldWrites` / `MarkerFailureReason` (Task 2) are used unchanged in Task 4. `ScriptCustomFieldWriteSummary` is declared once in Task 3 and consumed in Tasks 4, 5 and 9. `CustomFieldWriteRejection` is the union of the Task-1 and Task-2 reason types plus three gate reasons, so a summary's `reason` string is always one of a closed set. `CUSTOM_FIELD_MARKER` (TS, Task 2) and `CustomFieldMarker` (Go, Task 10) hold the same literal and each file's comment names the other.

**4. One correction folded in.** Task 4's `ApplyScriptCustomFieldWritesInput` originally carried `orgId`; Task 5 revealed the caller has nothing to supply because the service reads `device.orgId` itself. Task 5, Step 3 instructs dropping the field rather than passing `''`. Apply that when implementing Task 4 — do not add `orgId` and then remove it.

**5. CI reality check.** Waves 1, 2 and 4 touch the export-policy registry or a registered table's columns; those failures surface only in **Integration Tests**, never in **Test API**. A PR on a stale base can go green and redden `main`. Merge `main` into the branch and re-verify before every `--admin` merge, and confirm from the shard log that `scriptCustomFieldWriteBack.integration.test.ts` actually executed rather than skipped.
