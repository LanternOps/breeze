---
tracking_issue: LanternOps/breeze#5988
---
# Network Device Page Truth W02: Agent Acquisition — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SNMP table OIDs actually collect. The server tells the agent *how* to acquire each OID (`oidSpecs` with `get`/`walk` and `fast`/`slow` cadence, plus hard `limits`); the agent walks table columns with per-OID and per-poll bounds, emits one row per instance with `baseOid` + `instance`, turns `noSuchObject` / `noSuchInstance` / `endOfMibView` / bound-hit into explicit per-OID **error rows** instead of silent nulls, and stamps `protocol: 2` on the result. The legacy `oids: string[]` field and its meaning never change, so agents in the field keep working untouched. `classify.go` stops writing sysObjectID into `model`.

**Architecture:** One new pure API service (`services/snmpOidSpecs.ts`) turns a template's `oids` jsonb into `OidSpec[]` and gates `slow` specs on `snmp_devices.poll_seq` (W01 column). `buildSnmpPollCommand` gains an optional 5th argument and, when the device has a template, adds `oidSpecs` + `limits` to the existing payload without touching any existing key. On the agent, `snmppoll` gains a spec/limits vocabulary (`specs.go`), a streaming bounded walk on the client (`WalkBounded`), and a `pduSource` seam so `CollectMetrics` can be tested against an in-package fake with zero network I/O. `handlers_network.go` splits payload parsing and result assembly into two pure functions so both the new payload fields and `protocol: 2` are unit-testable.

**Tech Stack:** Go 1.x + `github.com/gosnmp/gosnmp v1.44.0` + stdlib `testing` (table-driven, `-race`); TypeScript + Drizzle ORM + BullMQ + Vitest (unit, Drizzle mocks, `PgDialect` SQL rendering).

**Spec:** `docs/superpowers/specs/monitoring/2026-09-16-network-device-page-truth-design.md` (approved 2026-09-16). This wave is §7.1 (command payload), §7.2 (result payload), §7.4 (agent implementation), §9 last bullet (`classify.go`), §15 Go tests, §17 volume note. W01 (`…-w01-api-truth.md`) must be merged first: it ships `snmp_devices.poll_seq`, `snmp_metrics.base_oid/instance/error`, and the protocol-2 ingestion this wave feeds. Where this plan is more specific than the spec (exact function names, the streaming walk instead of `BulkWalkAll`, the empty-walk error row), the plan wins; each such decision is stated inline as **Decision**.

## Global Constraints

- **Wire compatibility is the whole point of this wave.** `oids: string[]` keeps its exact current value (`template.oids.map(o => o.oid)`, full template order, every OID, never cadence-gated) on every dispatch; `oidSpecs` and `limits` are *additive* keys. An agent that has never heard of them reads `oids` through `tools.GetPayloadStringSlice` and behaves exactly as today. In the other direction, absence of `protocol` on a result means the legacy row shape (`baseOid = oid`, `instance = ''`) — never infer the shape from the server version.
- **Bounds are fixed by the index, not re-derived:** `POLL_LIMITS = { maxRowsPerOid: 512, maxRowsPerPoll: 4096, maxBytesPerPoll: 1048576, maxDurationMs: 20000 }`, `SLOW_CADENCE_EVERY = 12`. Go mirrors them as `DefaultPollLimits` and uses them whenever the payload omits `limits`.
- **Agent code ships to customer machines**, so every behaviour change in `agent/` lands with a test that fails before the change. No exceptions in this wave — a bad walk bound is a memory/DoS bug on a machine we do not own.
- Go tests: `cd agent && go test -race ./internal/snmppoll/... ./internal/heartbeat/... ./internal/discovery/... ./internal/remote/tools/...`. CI runs the same suite CGO-off in **Test Agent** and with `-race` in **Test Agent (race)**; `go vet ./...` and `golangci-lint run --new-from-rev="origin/main" ./...` (v2.12.2, new-issues-only) run in **Lint Agent (Go)**.
- Go tests are table-driven where there is more than one input/output pair, and **never make a real network call** — `snmppoll` tests drive the `pduSource` fake, `heartbeat` tests drive the pure parse/result helpers.
- API tests run one file at a time as `cd apps/api && npx vitest run <path>`. Never `pnpm --filter @breeze/api test -- --run <path>` (pnpm forwards the `--`, vitest swallows `--run`, and the full 1,470-file suite runs in watch mode).
- **W02 ships no migration.** Every column it reads (`snmp_devices.poll_seq`) is W01's. If `grep -n "pollSeq" apps/api/src/db/schema/snmp.ts` comes back empty, stop: W01 has not merged and Task 2 cannot compile.
- Never create a test file with `Write` over an existing path — every test file named below is new; confirm with `ls` before writing, and use `Edit` to extend an existing one.
- Branch `feature/<parent#>-network-device-page-truth/wave-<W02 sub-issue#>`, PR body contains `Closes #<W02 sub-issue#>`. Stacked on W01's branch ⇒ no `pull_request` CI run fires; dispatch `gh workflow run CI --ref <branch>` before enqueueing. Every commit message ends with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  ```

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/src/services/snmpOidSpecs.ts` (new) | `buildOidSpecs`, `selectOidSpecsForSeq`, `includesSlowCadence`, `POLL_LIMITS`, `SLOW_CADENCE_EVERY`, types |
| `apps/api/src/services/snmpOidSpecs.test.ts` (new) | mode/cadence defaults, explicit overrides, de-dupe, cadence gating |
| `apps/api/src/jobs/snmpWorker.ts` | build `oidSpecs` in `loadPollDispatchInputs`; `buildSnmpPollCommand` 5th arg; `poll_seq` increment in `markPollDispatched` |
| `apps/api/src/jobs/snmpWorker.oidSpecs.test.ts` (new) | `oids` byte-for-byte unchanged, `oidSpecs`/`limits` present, cadence gating end-to-end, `poll_seq` increment SQL |
| `agent/internal/remote/tools/types.go` | `GetPayloadObjectSlice`, `GetPayloadObject` |
| `agent/internal/remote/tools/payload_objects_test.go` (new) | the two helpers: happy path, wrong type, missing key, mixed junk |
| `agent/internal/snmppoll/specs.go` (new) | `OIDSpec`, `PollLimits`, `DefaultPollLimits`, error codes, `SpecsFromOIDs`, `defaultMode`, `instanceSuffix`, `findSpecForOID` |
| `agent/internal/snmppoll/specs_test.go` (new) | spec vocabulary + OID/instance helpers |
| `agent/internal/snmppoll/metrics.go` | `SNMPMetric` gains `BaseOID`/`Instance`/`Error`; `pduSource` seam; `collectWithSource`; GET error rows; bounded walks |
| `agent/internal/snmppoll/metrics_specs_test.go` (new) | GET error rows, base/instance, fake-driven walk bounds, truncation, empty-walk error row |
| `agent/internal/snmppoll/client.go` | `WalkBounded` (streaming `BulkWalk` + sentinel stop) |
| `agent/internal/snmppoll/client_walkbounded_test.go` (new) | `WalkBounded` guard clauses |
| `agent/internal/snmppoll/templates.go` | `Deprecated:` note on `GetTemplate` (no deletion) |
| `agent/internal/heartbeat/handlers_network.go` | `parseSnmpPollRequest`, `snmpPollResultPayload` (`protocol: 2`), `handleSnmpPoll` composes them |
| `agent/internal/heartbeat/handlers_network_snmp_test.go` (new) | payload parsing incl. legacy fallback; `protocol: 2` in the result |
| `agent/internal/discovery/classify.go` | drop the sysObjectID→model assignment |
| `agent/internal/discovery/classify_test.go` | rewrite `TestClassifyAssetModelFromSNMPObjectID` |

---

### Task 1: `services/snmpOidSpecs.ts` — template entries to acquisition specs

**Files:**
- Create: `apps/api/src/services/snmpOidSpecs.ts`
- Create: `apps/api/src/services/snmpOidSpecs.test.ts`

**Interfaces:**
- Consumes: the `snmp_templates.oids` jsonb value, whose shipped entry shape is `{ oid, name, type, description }` (see `apps/api/migrations/2026-05-22-snmp-multi-vendor-templates.sql`); W03 adds optional `mode` and `cadence`.
- Produces:
  ```ts
  export type OidMode = 'get' | 'walk';
  export type OidCadence = 'fast' | 'slow';
  export interface TemplateOidEntry { oid: string; name?: string | null; type?: string | null; description?: string | null; mode?: OidMode | null; cadence?: OidCadence | null; }
  export interface OidSpec { oid: string; name: string; mode: OidMode; cadence: OidCadence; }
  export const POLL_LIMITS: { readonly maxRowsPerOid: 512; readonly maxRowsPerPoll: 4096; readonly maxBytesPerPoll: 1048576; readonly maxDurationMs: 20000 };
  export type PollLimits = typeof POLL_LIMITS;
  export const SLOW_CADENCE_EVERY = 12;
  export function buildOidSpecs(templateOids: unknown): OidSpec[];
  export function includesSlowCadence(pollSeq: number): boolean;
  export function selectOidSpecsForSeq(specs: OidSpec[], pollSeq: number): OidSpec[];
  ```

**Decision (mode default).** Acquisition mode defaults from the OID's trailing `.0`, never from the entry's `type`. Surveyed against every shipped built-in template: 36 `counter64`, 22 `counter` and 6 `string` entries are table columns, while `table` is itself used as a `type` value — so `type` is a value type and cannot decide acquisition (spec §7.1). The `.0` rule classifies all 204 seed scalars as `get` and all 230 seed columns as `walk`.

**Decision (all-slow fallback).** `selectOidSpecsForSeq` never returns an empty list for a non-empty input. A template whose every entry is `slow` would otherwise dispatch `oidSpecs: []` on 11 of every 12 polls and the agent would collect nothing at all; when nothing is `fast`, the full set is sent.

- [ ] **Step 1: Write the test first**

Create `apps/api/src/services/snmpOidSpecs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  POLL_LIMITS,
  SLOW_CADENCE_EVERY,
  buildOidSpecs,
  includesSlowCadence,
  selectOidSpecsForSeq,
  type OidSpec,
} from './snmpOidSpecs';

/** The shipped built-in entry shape: {oid,name,type,description}, no mode/cadence. */
const SEED_ENTRIES = [
  { oid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime', type: 'timeticks', description: 'Uptime' },
  { oid: '1.3.6.1.2.1.43.11.1.1.9', name: 'prtMarkerSuppliesLevel', type: 'table', description: 'Level' },
  { oid: '1.3.6.1.2.1.31.1.1.1.6', name: 'ifHCInOctets', type: 'counter64', description: 'In octets' },
  { oid: '1.3.6.1.2.1.43.11.1.1.6', name: 'prtMarkerSuppliesDescription', type: 'string', description: 'Supply name' },
];

describe('buildOidSpecs — mode defaults from the OID, not from `type`', () => {
  it.each([
    ['1.3.6.1.2.1.1.3.0', 'get'],
    ['1.3.6.1.2.1.1.5.0', 'get'],
    ['1.3.6.1.2.1.43.11.1.1.9', 'walk'],
    ['1.3.6.1.2.1.2.2.1.2', 'walk'],
  ])('%s defaults to %s', (oid, mode) => {
    expect(buildOidSpecs([{ oid, name: 'x', type: 'table' }])[0]!.mode).toBe(mode);
  });

  it('walks counter64 and string columns, which `type` alone would misclassify', () => {
    const byName = Object.fromEntries(buildOidSpecs(SEED_ENTRIES).map((s) => [s.name, s]));
    expect(byName.sysUpTime!.mode).toBe('get');
    expect(byName.ifHCInOctets!.mode).toBe('walk');
    expect(byName.prtMarkerSuppliesDescription!.mode).toBe('walk');
    expect(byName.prtMarkerSuppliesLevel!.mode).toBe('walk');
  });

  it('defaults every seed entry to fast cadence', () => {
    expect(buildOidSpecs(SEED_ENTRIES).every((s) => s.cadence === 'fast')).toBe(true);
  });

  it('falls back to the OID as the name when the entry has none', () => {
    expect(buildOidSpecs([{ oid: '1.3.6.1.2.1.1.3.0' }])[0]).toEqual({
      oid: '1.3.6.1.2.1.1.3.0', name: '1.3.6.1.2.1.1.3.0', mode: 'get', cadence: 'fast',
    });
  });
});

describe('buildOidSpecs — explicit overrides win', () => {
  it('honours an explicit mode against the .0 default', () => {
    const specs = buildOidSpecs([
      { oid: '1.3.6.1.2.1.1.3.0', name: 'weird', mode: 'walk' },
      { oid: '1.3.6.1.2.1.2.2.1.2', name: 'ifDescr', mode: 'get' },
    ]);
    expect(specs.map((s) => s.mode)).toEqual(['walk', 'get']);
  });

  it('honours an explicit slow cadence', () => {
    expect(buildOidSpecs([{ oid: '1.3.6.1.2.1.2.2.1.2', name: 'ifDescr', cadence: 'slow' }])[0]!.cadence).toBe('slow');
  });

  it('ignores an unrecognised mode or cadence rather than shipping it to the agent', () => {
    const [spec] = buildOidSpecs([{ oid: '1.3.6.1.2.1.2.2.1.2', name: 'ifDescr', mode: 'bulk' as never, cadence: 'hourly' as never }]);
    expect(spec).toEqual({ oid: '1.3.6.1.2.1.2.2.1.2', name: 'ifDescr', mode: 'walk', cadence: 'fast' });
  });
});

describe('buildOidSpecs — junk input', () => {
  it.each([[null], [undefined], ['{}'], [42], [{}]])('returns [] for %p', (input) => {
    expect(buildOidSpecs(input)).toEqual([]);
  });

  it('drops entries with no usable oid and keeps the rest', () => {
    const specs = buildOidSpecs([
      { oid: '' }, { oid: '   ' }, { name: 'no oid' }, null, 'string-entry',
      { oid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime' },
    ]);
    expect(specs.map((s) => s.oid)).toEqual(['1.3.6.1.2.1.1.3.0']);
  });

  it('trims surrounding whitespace on the oid', () => {
    expect(buildOidSpecs([{ oid: ' 1.3.6.1.2.1.1.3.0 ', name: 'sysUpTime' }])[0]!.oid).toBe('1.3.6.1.2.1.1.3.0');
  });

  it('de-duplicates by oid, keeping the first entry — a duplicated walk doubles the row budget', () => {
    const specs = buildOidSpecs([
      { oid: '1.3.6.1.2.1.2.2.1.2', name: 'ifDescr' },
      { oid: '1.3.6.1.2.1.2.2.1.2', name: 'ifDescr-again' },
    ]);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.name).toBe('ifDescr');
  });
});

describe('cadence gating', () => {
  const specs: OidSpec[] = [
    { oid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime', mode: 'get', cadence: 'fast' },
    { oid: '1.3.6.1.2.1.2.2.1.2', name: 'ifDescr', mode: 'walk', cadence: 'slow' },
  ];

  it('includes slow specs on the very first poll (poll_seq 0)', () => {
    expect(includesSlowCadence(0)).toBe(true);
    expect(selectOidSpecsForSeq(specs, 0)).toEqual(specs);
  });

  it.each([1, 2, 5, 11, 13])('excludes slow specs on poll_seq %i', (seq) => {
    expect(selectOidSpecsForSeq(specs, seq).map((s) => s.name)).toEqual(['sysUpTime']);
  });

  it('includes slow specs again every SLOW_CADENCE_EVERY polls', () => {
    expect(SLOW_CADENCE_EVERY).toBe(12);
    for (const seq of [12, 24, 120]) expect(selectOidSpecsForSeq(specs, seq)).toEqual(specs);
  });

  it('falls back to the full set when nothing is fast, so an all-slow template never polls nothing', () => {
    const allSlow: OidSpec[] = [{ oid: '1.3.6.1.2.1.2.2.1.2', name: 'ifDescr', mode: 'walk', cadence: 'slow' }];
    expect(selectOidSpecsForSeq(allSlow, 5)).toEqual(allSlow);
  });

  it('treats a missing or nonsensical poll_seq as a slow poll rather than skipping data', () => {
    for (const seq of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(selectOidSpecsForSeq(specs, seq)).toEqual(specs);
    }
  });

  it('returns [] for [] without inventing work', () => {
    expect(selectOidSpecsForSeq([], 3)).toEqual([]);
  });
});

describe('POLL_LIMITS', () => {
  it('matches the values the plan index fixes', () => {
    expect(POLL_LIMITS).toEqual({ maxRowsPerOid: 512, maxRowsPerPoll: 4096, maxBytesPerPoll: 1048576, maxDurationMs: 20000 });
  });
});
```

- [ ] **Step 2: Watch it fail**

```bash
cd apps/api && npx vitest run src/services/snmpOidSpecs.test.ts
```
Expected: `Error: Failed to load url ./snmpOidSpecs` — the module does not exist yet.

- [ ] **Step 3: Implement**

Create `apps/api/src/services/snmpOidSpecs.ts`:

```ts
/**
 * SNMP acquisition specs (spec §7.1).
 *
 * A template row only says WHICH OIDs to read. Until this module existed the
 * server flattened them to `oids: string[]` and the agent issued one GET over
 * all of them — so every table column (145 of the ~407 built-in OIDs) came back
 * `noSuchObject`, `parseValue` yielded nil, and the row was stored as
 * `value_type = 'null'`. This module says HOW to read each one, and the agent
 * walks the columns.
 *
 * Pure: no I/O, no DB, no clock. Both the poll dispatcher and its tests use it.
 */

export type OidMode = 'get' | 'walk';
export type OidCadence = 'fast' | 'slow';

/** A `snmp_templates.oids` entry. `mode`/`cadence` are W03 additions. */
export interface TemplateOidEntry {
  oid: string;
  name?: string | null;
  type?: string | null;
  description?: string | null;
  mode?: OidMode | null;
  cadence?: OidCadence | null;
}

/** One acquisition instruction, as it appears in the agent command payload. */
export interface OidSpec {
  oid: string;
  name: string;
  mode: OidMode;
  cadence: OidCadence;
}

/**
 * Hard bounds the agent enforces per poll. Sent on the wire so the ceiling can
 * be lowered from the server without shipping an agent, and mirrored in Go as
 * `snmppoll.DefaultPollLimits` for payloads that omit them.
 *
 * Sized against the worst realistic case in §17: a 48-port switch with ten
 * walked columns is ~480 rows per poll, comfortably inside maxRowsPerPoll, and
 * maxRowsPerOid stops a runaway table (a large FDB) at 512.
 */
export const POLL_LIMITS = {
  maxRowsPerOid: 512,
  maxRowsPerPoll: 4096,
  maxBytesPerPoll: 1_048_576,
  maxDurationMs: 20_000,
} as const;

export type PollLimits = typeof POLL_LIMITS;

/**
 * `slow` specs ride along on one dispatch in every SLOW_CADENCE_EVERY. At the
 * default 5-minute interval that refreshes static columns (ifDescr, ifName,
 * supply descriptions) hourly instead of every poll.
 */
export const SLOW_CADENCE_EVERY = 12;

/**
 * Default acquisition mode.
 *
 * The trailing `.0` is the scalar marker in every shipped built-in template and
 * in SMI itself: a scalar object instance is `<object>.0`, a columnar instance
 * is `<column>.<index>`. The entry's `type` CANNOT decide this — `type` is a
 * VALUE type, and the seed has 36 `counter64`, 22 `counter` and 6 `string`
 * entries that are table columns (`ifHCInOctets` is a counter64 column).
 */
function defaultMode(oid: string): OidMode {
  return oid.endsWith('.0') ? 'get' : 'walk';
}

/**
 * Turn a template's raw `oids` jsonb into acquisition specs.
 *
 * Takes `unknown` on purpose: the column is jsonb, so Drizzle hands back
 * `unknown` and the contents are whatever a custom template's author saved.
 * Anything unusable is dropped rather than shipped to an agent that would turn
 * it into a network request.
 */
export function buildOidSpecs(templateOids: unknown): OidSpec[] {
  if (!Array.isArray(templateOids)) return [];

  const specs: OidSpec[] = [];
  const seen = new Set<string>();

  for (const raw of templateOids) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as TemplateOidEntry;

    const oid = typeof entry.oid === 'string' ? entry.oid.trim() : '';
    if (oid === '') continue;
    // De-duplicate: `oidSpecs` drives real requests and a repeated walk spends
    // the row budget twice on the same table. `oids` keeps whatever the
    // template holds — that field's contract is "unchanged", not "cleaned up".
    if (seen.has(oid)) continue;
    seen.add(oid);

    const name = typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : oid;
    const mode: OidMode = entry.mode === 'get' || entry.mode === 'walk' ? entry.mode : defaultMode(oid);
    const cadence: OidCadence = entry.cadence === 'slow' || entry.cadence === 'fast' ? entry.cadence : 'fast';

    specs.push({ oid, name, mode, cadence });
  }

  return specs;
}

/**
 * Does this dispatch carry the `slow` specs?
 *
 * Reads the PRE-increment `snmp_devices.poll_seq`, which defaults to 0, so a
 * device's very first poll is a slow poll. Gating on the post-increment value
 * would leave a just-onboarded switch with no interface names for an hour.
 *
 * A NULL/NaN/negative sequence counts as a slow poll: failing open costs one
 * extra walk, failing closed silently withholds data.
 */
export function includesSlowCadence(pollSeq: number): boolean {
  if (!Number.isFinite(pollSeq) || pollSeq < 0) return true;
  return Math.floor(pollSeq) % SLOW_CADENCE_EVERY === 0;
}

/**
 * The specs this dispatch carries.
 *
 * Never returns an empty list for a non-empty input: a template whose every
 * entry is `slow` would otherwise send `oidSpecs: []` on 11 of every 12 polls
 * and the agent, seeing the field present, would collect nothing at all.
 */
export function selectOidSpecsForSeq(specs: OidSpec[], pollSeq: number): OidSpec[] {
  if (specs.length === 0) return [];
  if (includesSlowCadence(pollSeq)) return specs;
  const fast = specs.filter((spec) => spec.cadence !== 'slow');
  return fast.length > 0 ? fast : specs;
}
```

- [ ] **Step 4: Run it green**

```bash
cd apps/api && npx vitest run src/services/snmpOidSpecs.test.ts
```
Expected: 1 file, all tests passing.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/snmpOidSpecs.ts apps/api/src/services/snmpOidSpecs.test.ts
git commit -m "$(cat <<'EOF'
feat(api/snmp): derive per-OID acquisition specs from template entries

buildOidSpecs turns a template's {oid,name,type,description} entries into
{oid,name,mode,cadence}. Mode defaults from the OID's trailing .0, not from
`type` — `type` is a value type and the built-in seed has 36 counter64, 22
counter and 6 string entries that are table columns. selectOidSpecsForSeq
gates `slow` specs on poll_seq with SLOW_CADENCE_EVERY = 12, treating seq 0
as a slow poll so a new device gets its static columns immediately.

Spec §7.1.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `buildSnmpPollCommand` sends `oidSpecs` + `limits`; `poll_seq` advances at dispatch

**Files:**
- Modify: `apps/api/src/jobs/snmpWorker.ts`
- Create: `apps/api/src/jobs/snmpWorker.oidSpecs.test.ts`

**Interfaces:**
- Consumes: `buildOidSpecs`, `selectOidSpecsForSeq`, `POLL_LIMITS`, `OidSpec` from `../services/snmpOidSpecs`; `snmpDevices.pollSeq` (W01 Drizzle column, `snmp_devices.poll_seq integer NOT NULL DEFAULT 0`).
- Produces:
  ```ts
  export interface SnmpPollCommandExtras { oidSpecs?: OidSpec[]; pollSeq?: number }
  export function buildSnmpPollCommand(
    deviceId: string,
    device: { ipAddress: string; port: number | null; snmpVersion: string | null; community: string | null; username: string | null; authProtocol: string | null; authPassword: string | null; privProtocol: string | null; privPassword: string | null },
    oids: string[],
    idPrefix?: string,
    extras?: SnmpPollCommandExtras,
  ): AgentCommand;
  ```
  Payload gains `oidSpecs: OidSpec[]` and `limits: PollLimits` **only** when `extras.oidSpecs` is non-empty.

**Decision (signature).** `idPrefix` stays the 4th positional parameter and the new options object is 5th. `apps/api/src/jobs/snmpQueue.test.ts:129` already calls the function with `'test'` positionally; reshuffling the signature would break a passing credential-decryption test for no gain.

**Decision (absent template).** When the device has no template entries the payload keeps exactly the keys it has today — no `oidSpecs`, no `limits`. A new agent then falls back to `oids` as `get`, which is the current behaviour of that path (the `/test` route shape), and the diff stays auditable as purely additive.

- [ ] **Step 1: Confirm W01 landed**

```bash
grep -n "pollSeq" apps/api/src/db/schema/snmp.ts
```
Expected: a line like `pollSeq: integer('poll_seq').notNull().default(0),`. If empty, stop — W01 is not merged.

- [ ] **Step 2: Write the test first**

Create `apps/api/src/jobs/snmpWorker.oidSpecs.test.ts`:

```ts
/**
 * Poll-command wire contract (spec §7.1).
 *
 * Two things are being locked down, and they pull in opposite directions:
 *   1. `oids: string[]` must not move a single byte — agents in the field read
 *      only that field, and they will keep doing so indefinitely.
 *   2. `oidSpecs` + `limits` must appear alongside it, cadence-gated on
 *      snmp_devices.poll_seq, which must advance exactly once per dispatch.
 *
 * Uses the REAL drizzle schema (only `../db` is mocked) so the poll_seq
 * increment can be rendered through a real Postgres dialect and asserted on,
 * the same approach snmpWorkerScheduler.test.ts takes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { DispatchOutcome } from '../services/agentCommandRelay';

const { addMock, getJobMock, closeMock, agentRelayMock, decryptMock } = vi.hoisted(() => ({
  addMock: vi.fn(),
  getJobMock: vi.fn(),
  closeMock: vi.fn(),
  agentRelayMock: {
    isAgentConnectedAnywhere: vi.fn(async () => true),
    dispatchCommandToAgent: vi.fn(async (): Promise<DispatchOutcome> => ({ status: 'sent', via: 'local' })),
  },
  decryptMock: vi.fn((v: string | null) => v),
}));

vi.mock('bullmq', () => ({
  Queue: class { getJob = getJobMock; add = addMock; close = closeMock; },
  Worker: class { close = vi.fn(); on = vi.fn(); },
  Job: class {},
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

vi.mock('../services/agentCommandRelay', () => ({
  isAgentConnectedAnywhere: agentRelayMock.isAgentConnectedAnywhere,
  dispatchCommandToAgent: agentRelayMock.dispatchCommandToAgent,
}));

vi.mock('../services/snmpSecrets', () => ({ decryptSnmpSecret: decryptMock }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

/** Rows handed back, in order, to successive `db.select()` chains. */
let selectResults: unknown[][] = [];
/** Every `.set()` payload, in order. */
const updateSets: Record<string, unknown>[] = [];

vi.mock('../db', () => {
  const selectChain = () => {
    const rows = selectResults.shift() ?? [];
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.limit = () => Promise.resolve(rows);
    chain.for = () => Promise.resolve(rows);
    chain.then = (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(ok, fail);
    return chain;
  };
  return {
    db: {
      select: () => selectChain(),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updateSets.push(values);
          return { where: () => Promise.resolve() };
        },
      }),
      insert: () => ({ values: () => Promise.resolve() }),
    },
    withSystemDbAccessContext: undefined,
    assertOutsideHeldDbContext: vi.fn(),
  };
});

import { __testables, buildSnmpPollCommand } from './snmpWorker';
import { POLL_LIMITS } from '../services/snmpOidSpecs';

const { processPollDevice } = __testables;
const dialect = new PgDialect();

const DEVICE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_ID = '11111111-1111-1111-1111-111111111111';

/** A printer template: two scalars, two table columns, one of them slow. */
const TEMPLATE_OIDS = [
  { oid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime', type: 'timeticks', description: 'Uptime' },
  { oid: '1.3.6.1.2.1.1.5.0', name: 'sysName', type: 'string', description: 'Name' },
  { oid: '1.3.6.1.2.1.43.11.1.1.9', name: 'prtMarkerSuppliesLevel', type: 'table', description: 'Level' },
  { oid: '1.3.6.1.2.1.43.11.1.1.6', name: 'prtMarkerSuppliesDescription', type: 'table', description: 'Supply', cadence: 'slow' },
];
const EXPECTED_OIDS = TEMPLATE_OIDS.map((o) => o.oid);

function deviceRow(pollSeq: number) {
  return {
    id: DEVICE_ID, orgId: ORG_ID, assetId: null, templateId: 'tpl-1',
    ipAddress: '10.0.0.1', port: 161, snmpVersion: 'v2c',
    community: 'public', username: null, authProtocol: null, authPassword: null,
    privProtocol: null, privPassword: null, pollSeq,
  };
}

/** device row → template oids → online agent. */
function wireDispatch(pollSeq: number) {
  selectResults = [[deviceRow(pollSeq)], [{ oids: TEMPLATE_OIDS }], [{ agentId: 'agent-1' }]];
}

async function dispatchedPayload(pollSeq: number): Promise<Record<string, unknown>> {
  wireDispatch(pollSeq);
  await processPollDevice({ type: 'poll-device', deviceId: DEVICE_ID, orgId: ORG_ID });
  const call = agentRelayMock.dispatchCommandToAgent.mock.calls.at(-1);
  if (!call) throw new Error('no command was dispatched');
  return (call[1] as { payload: Record<string, unknown> }).payload;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectResults = [];
  updateSets.length = 0;
  addMock.mockResolvedValue({ id: 'job-1' });
  getJobMock.mockResolvedValue(null);
  agentRelayMock.isAgentConnectedAnywhere.mockResolvedValue(true);
  agentRelayMock.dispatchCommandToAgent.mockResolvedValue({ status: 'sent', via: 'local' });
  decryptMock.mockImplementation((v: string | null) => v);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('legacy `oids` is frozen', () => {
  it('sends every template OID in template order on a slow poll', async () => {
    expect((await dispatchedPayload(0)).oids).toEqual(EXPECTED_OIDS);
  });

  it('sends the SAME list on a fast poll — cadence never gates `oids`', async () => {
    expect((await dispatchedPayload(5)).oids).toEqual(EXPECTED_OIDS);
  });

  it('keeps every pre-existing payload key', async () => {
    const payload = await dispatchedPayload(0);
    expect(Object.keys(payload)).toEqual(expect.arrayContaining([
      'deviceId', 'target', 'port', 'version', 'community', 'username',
      'authProtocol', 'authPassword', 'privProtocol', 'privPassword', 'oids',
    ]));
  });
});

describe('`oidSpecs` and `limits`', () => {
  it('carries a spec per template entry on a slow poll, walking the columns', async () => {
    expect((await dispatchedPayload(0)).oidSpecs).toEqual([
      { oid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime', mode: 'get', cadence: 'fast' },
      { oid: '1.3.6.1.2.1.1.5.0', name: 'sysName', mode: 'get', cadence: 'fast' },
      { oid: '1.3.6.1.2.1.43.11.1.1.9', name: 'prtMarkerSuppliesLevel', mode: 'walk', cadence: 'fast' },
      { oid: '1.3.6.1.2.1.43.11.1.1.6', name: 'prtMarkerSuppliesDescription', mode: 'walk', cadence: 'slow' },
    ]);
  });

  it('drops the slow spec on a fast poll while `oids` keeps it', async () => {
    const payload = await dispatchedPayload(5);
    expect((payload.oidSpecs as Array<{ name: string }>).map((s) => s.name))
      .toEqual(['sysUpTime', 'sysName', 'prtMarkerSuppliesLevel']);
    expect(payload.oids).toEqual(EXPECTED_OIDS);
  });

  it('sends the fixed bounds alongside the specs', async () => {
    expect((await dispatchedPayload(0)).limits).toEqual(POLL_LIMITS);
  });
});

describe('poll_seq', () => {
  it('advances by one in the same UPDATE that counts the dispatch', async () => {
    await dispatchedPayload(0);
    const dispatchSet = updateSets.find((s) => 'consecutiveFailures' in s);
    expect(dispatchSet).toBeDefined();
    expect(dispatchSet).toHaveProperty('pollSeq');
    expect(dialect.sqlToQuery(dispatchSet!.pollSeq as SQL).sql).toMatch(/"poll_seq"\s*\+\s*1/i);
  });

  it('does not advance when nothing is dispatched', async () => {
    selectResults = [[deviceRow(0)], [{ oids: [] }]]; // no template OIDs → no dispatch
    await processPollDevice({ type: 'poll-device', deviceId: DEVICE_ID, orgId: ORG_ID });
    expect(updateSets.some((s) => 'pollSeq' in s)).toBe(false);
  });
});

describe('buildSnmpPollCommand without a template', () => {
  const device = {
    ipAddress: '10.0.0.1', port: 161, snmpVersion: 'v2c', community: 'public',
    username: null, authProtocol: null, authPassword: null, privProtocol: null, privPassword: null,
  };

  it('omits both new keys entirely, so the payload is byte-for-byte the legacy shape', () => {
    const { payload } = buildSnmpPollCommand(DEVICE_ID, device, ['1.3.6.1.2.1.1.3.0'], 'test');
    expect(payload).not.toHaveProperty('oidSpecs');
    expect(payload).not.toHaveProperty('limits');
  });

  it('omits them for an explicitly empty spec list too', () => {
    const { payload } = buildSnmpPollCommand(DEVICE_ID, device, ['1.3.6.1.2.1.1.3.0'], 'test', { oidSpecs: [], pollSeq: 3 });
    expect(payload).not.toHaveProperty('oidSpecs');
  });
});
```

- [ ] **Step 3: Watch it fail**

```bash
cd apps/api && npx vitest run src/jobs/snmpWorker.oidSpecs.test.ts
```
Expected: the `oidSpecs`/`limits`/`poll_seq` tests fail — `payload.oidSpecs` is `undefined`, `payload.limits` is `undefined`, and the dispatch `.set()` has no `pollSeq` key. The two "legacy `oids` is frozen" tests should already pass; that is the point of writing them now.

- [ ] **Step 4: Implement**

In `apps/api/src/jobs/snmpWorker.ts`:

1. Add the import next to the existing service imports:
```ts
import { buildOidSpecs, selectOidSpecsForSeq, POLL_LIMITS, type OidSpec } from '../services/snmpOidSpecs';
```

2. `markPollDispatched` — advance the sequence in the same statement:
```ts
async function markPollDispatched(deviceId: string): Promise<void> {
  const nextFailures = sql`${snmpDevices.consecutiveFailures} + 1`;
  await db
    .update(snmpDevices)
    .set({
      consecutiveFailures: nextFailures,
      // The cadence counter advances with the failure counter and for exactly
      // the same reason: both mean "a poll genuinely went out". Keeping it in
      // this single UPDATE makes the slow-cadence rotation immune to the early
      // returns above it — a device that never dispatches never rotates, so it
      // never silently skips its static columns.
      pollSeq: sql`${snmpDevices.pollSeq} + 1`,
      lastStatus: sql`CASE WHEN ${nextFailures} >= ${FAILURE_STATUS_THRESHOLD} THEN 'offline' ELSE ${snmpDevices.lastStatus} END`
    })
    .where(eq(snmpDevices.id, deviceId));
}
```

3. `PollDispatchInputs` — carry the specs on the `ok` variant:
```ts
  | {
      status: 'ok';
      device: typeof snmpDevices.$inferSelect;
      oids: string[];
      oidSpecs: OidSpec[];
      agentId: string;
    };
```

4. `loadPollDispatchInputs` — build the specs from the SAME template rows, leaving the `oids` line untouched:
```ts
  // Load template OIDs if device has a template
  let oids: string[] = [];
  let oidSpecs: OidSpec[] = [];
  if (device.templateId) {
    const [template] = await db
      .select({ oids: snmpTemplates.oids })
      .from(snmpTemplates)
      .where(and(
        eq(snmpTemplates.id, device.templateId),
        or(eq(snmpTemplates.isBuiltIn, true), eq(snmpTemplates.orgId, device.orgId))!
      ))
      .limit(1);

    if (template && Array.isArray(template.oids)) {
      // UNCHANGED. Old agents read only this, so it stays the full template
      // list in template order, cadence and mode notwithstanding.
      oids = (template.oids as Array<{ oid: string }>).map((o) => o.oid);
      oidSpecs = buildOidSpecs(template.oids);
    }
  }
```
and the success return:
```ts
  return { status: 'ok', device, oids, oidSpecs, agentId };
```

5. `processPollDevice` — destructure and pass through:
```ts
  const { device, oids, oidSpecs, agentId } = inputs;
```
```ts
  // Build and send the command payload. `device.pollSeq` is the PRE-increment
  // value read in phase 1; `markPollDispatched` above has already advanced the
  // stored counter, so gating on the loaded value keeps this dispatch's
  // decision independent of write ordering.
  const command = buildSnmpPollCommand(data.deviceId, device, oids, 'snmp', {
    oidSpecs,
    pollSeq: device.pollSeq ?? 0,
  });
```

6. `buildSnmpPollCommand` — additive 5th argument:
```ts
/**
 * Extra, purely additive poll-command inputs (spec §7.1).
 *
 * Separate from the positional parameters so the existing call sites — and
 * `snmpQueue.test.ts`, which passes `idPrefix` positionally — keep compiling.
 */
export interface SnmpPollCommandExtras {
  /** Acquisition specs from the device's template; empty means "legacy only". */
  oidSpecs?: OidSpec[];
  /** Pre-increment `snmp_devices.poll_seq`, gating the `slow` specs. */
  pollSeq?: number;
}

export function buildSnmpPollCommand(
  deviceId: string,
  device: {
    ipAddress: string;
    port: number | null;
    snmpVersion: string | null;
    community: string | null;
    username: string | null;
    authProtocol: string | null;
    authPassword: string | null;
    privProtocol: string | null;
    privPassword: string | null;
  },
  oids: string[],
  idPrefix = 'snmp',
  extras: SnmpPollCommandExtras = {}
): AgentCommand {
  const specs = extras.oidSpecs ?? [];
  // Only devices with template entries get the new fields. Without them the
  // payload is byte-for-byte what it has always been, which is what the poll
  // `/test` route and every agent released before this wave expect.
  const dispatchSpecs = specs.length > 0 ? selectOidSpecsForSeq(specs, extras.pollSeq ?? 0) : [];

  return {
    id: `${idPrefix}-${deviceId}-${Date.now()}`,
    type: 'snmp_poll',
    payload: {
      deviceId,
      target: device.ipAddress,
      port: device.port ?? 161,
      version: device.snmpVersion ?? 'v2c',
      community: decryptSnmpSecret(device.community, { table: 'snmp_devices', column: 'community' }) ?? 'public',
      username: device.username ?? '',
      authProtocol: device.authProtocol ?? '',
      authPassword: decryptSnmpSecret(device.authPassword, { table: 'snmp_devices', column: 'auth_password' }) ?? '',
      privProtocol: device.privProtocol ?? '',
      privPassword: decryptSnmpSecret(device.privPassword, { table: 'snmp_devices', column: 'priv_password' }) ?? '',
      // NEVER cadence-gated and never reordered: this is the only field an
      // agent released before W02 reads (`tools.GetPayloadStringSlice`).
      oids,
      ...(dispatchSpecs.length > 0 ? { oidSpecs: dispatchSpecs, limits: { ...POLL_LIMITS } } : {})
    }
  };
}
```

- [ ] **Step 5: Run green, including the neighbours that touch this file**

```bash
cd apps/api && npx vitest run src/jobs/snmpWorker.oidSpecs.test.ts src/jobs/snmpQueue.test.ts src/jobs/snmpWorkerScheduler.test.ts src/jobs/snmpWorker.orgAuthority.test.ts src/jobs/snmpWorker.dbcontext.test.ts
```
Expected: 5 files, all passing. If `snmpWorkerScheduler.test.ts` fails on an update-payload key count, the assertion needs `pollSeq` added — fix the assertion, never the production increment.

- [ ] **Step 6: Typecheck**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/jobs/snmpWorker.ts apps/api/src/jobs/snmpWorker.oidSpecs.test.ts
git commit -m "$(cat <<'EOF'
feat(api/snmp): send oidSpecs + limits on poll commands, advance poll_seq

buildSnmpPollCommand takes an additive 5th argument and, when the device has
template entries, adds `oidSpecs` (cadence-gated on the pre-increment
poll_seq) and `limits` to the payload. `oids: string[]` is untouched — same
list, same order, never gated — so agents in the field are unaffected.
markPollDispatched advances poll_seq in the same UPDATE that counts the
dispatch, so a device that never dispatches never rotates its cadence.

Spec §7.1.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Agent reads `oidSpecs` and `limits`, with a legacy fallback

**Files:**
- Modify: `agent/internal/remote/tools/types.go`
- Create: `agent/internal/remote/tools/payload_objects_test.go`
- Create: `agent/internal/snmppoll/specs.go`
- Create: `agent/internal/snmppoll/specs_test.go`
- Modify: `agent/internal/heartbeat/handlers_network.go`
- Create: `agent/internal/heartbeat/handlers_network_snmp_test.go`

**Interfaces:**
- Produces (`tools`):
  ```go
  func GetPayloadObjectSlice(payload map[string]any, key string) []map[string]any
  func GetPayloadObject(payload map[string]any, key string) map[string]any
  ```
- Produces (`snmppoll`):
  ```go
  const (ModeGet = "get"; ModeWalk = "walk"; CadenceFast = "fast"; CadenceSlow = "slow")
  const (ErrCodeNoSuchObject = "noSuchObject"; ErrCodeNoSuchInstance = "noSuchInstance"; ErrCodeEndOfMib = "endOfMib"; ErrCodeTimeout = "timeout"; ErrCodeTruncated = "truncated")
  type OIDSpec struct { OID string `json:"oid"`; Name string `json:"name"`; Mode string `json:"mode"`; Cadence string `json:"cadence"` }
  type PollLimits struct { MaxRowsPerOID int; MaxRowsPerPoll int; MaxBytesPerPoll int; MaxDuration time.Duration }
  var DefaultPollLimits = PollLimits{512, 4096, 1 << 20, 20 * time.Second}
  func SpecsFromOIDs(oids []string) []OIDSpec
  func DefaultMode(oid string) string
  func InstanceSuffix(baseOID, pduName string) string
  func FindSpecForOID(specs []OIDSpec, pduName string) *OIDSpec
  ```
- Produces (`heartbeat`, unexported):
  ```go
  func parseSnmpPollRequest(payload map[string]any) (snmppoll.SNMPDevice, *tools.CommandResult)
  ```
- Consumes: command payload keys `oids`, `oidSpecs`, `limits` (spec §7.1).

**Decision (legacy fallback).** `oidSpecs` absent or empty ⇒ `SpecsFromOIDs(oids)`: every legacy OID becomes `{mode: "get", cadence: "fast", name: oid}`, which is precisely what the agent does today. The new agent must never guess `walk` from a payload the server did not mark, or a pre-W02 server would suddenly start bulk-walking production switches.

- [ ] **Step 1: Write the `tools` test first**

```bash
ls agent/internal/remote/tools/payload_objects_test.go   # must not exist
```

Create `agent/internal/remote/tools/payload_objects_test.go`:

```go
package tools

import "testing"

func TestGetPayloadObjectSlice(t *testing.T) {
	tests := []struct {
		name    string
		payload map[string]any
		key     string
		want    []map[string]any
	}{
		{
			name: "array of objects",
			payload: map[string]any{"oidSpecs": []any{
				map[string]any{"oid": "1.3.6.1.2.1.1.3.0", "mode": "get"},
				map[string]any{"oid": "1.3.6.1.2.1.2.2.1.2", "mode": "walk"},
			}},
			key: "oidSpecs",
			want: []map[string]any{
				{"oid": "1.3.6.1.2.1.1.3.0", "mode": "get"},
				{"oid": "1.3.6.1.2.1.2.2.1.2", "mode": "walk"},
			},
		},
		{name: "missing key", payload: map[string]any{}, key: "oidSpecs", want: nil},
		{name: "nil payload", payload: nil, key: "oidSpecs", want: nil},
		{name: "not an array", payload: map[string]any{"oidSpecs": "nope"}, key: "oidSpecs", want: nil},
		{name: "empty array", payload: map[string]any{"oidSpecs": []any{}}, key: "oidSpecs", want: []map[string]any{}},
		{
			name:    "non-object members are dropped, objects survive",
			payload: map[string]any{"oidSpecs": []any{"junk", 42, nil, map[string]any{"oid": "1.3"}}},
			key:     "oidSpecs",
			want:    []map[string]any{{"oid": "1.3"}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := GetPayloadObjectSlice(tt.payload, tt.key)
			if len(got) != len(tt.want) {
				t.Fatalf("GetPayloadObjectSlice() = %v (len %d), want %v (len %d)", got, len(got), tt.want, len(tt.want))
			}
			for i := range got {
				for k, v := range tt.want[i] {
					if got[i][k] != v {
						t.Errorf("entry %d key %q = %v, want %v", i, k, got[i][k], v)
					}
				}
			}
		})
	}
}

func TestGetPayloadObject(t *testing.T) {
	tests := []struct {
		name     string
		payload  map[string]any
		key      string
		wantNil  bool
		wantKeys map[string]any
	}{
		{
			name:     "object",
			payload:  map[string]any{"limits": map[string]any{"maxRowsPerOid": float64(512)}},
			key:      "limits",
			wantKeys: map[string]any{"maxRowsPerOid": float64(512)},
		},
		{name: "missing key", payload: map[string]any{}, key: "limits", wantNil: true},
		{name: "nil payload", payload: nil, key: "limits", wantNil: true},
		{name: "wrong type", payload: map[string]any{"limits": []any{1}}, key: "limits", wantNil: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := GetPayloadObject(tt.payload, tt.key)
			if tt.wantNil {
				if got != nil {
					t.Fatalf("GetPayloadObject() = %v, want nil", got)
				}
				return
			}
			for k, v := range tt.wantKeys {
				if got[k] != v {
					t.Errorf("key %q = %v, want %v", k, got[k], v)
				}
			}
		})
	}
}
```

- [ ] **Step 2: Watch it fail**

```bash
cd agent && go test -race ./internal/remote/tools/ -run 'TestGetPayloadObject'
```
Expected: `undefined: GetPayloadObjectSlice` / `undefined: GetPayloadObject` (build failure).

- [ ] **Step 3: Implement the `tools` helpers**

Append to `agent/internal/remote/tools/types.go`, immediately after `GetPayloadStringSlice`:

```go
// GetPayloadObjectSlice reads a JSON array of objects from a command payload —
// e.g. the SNMP poll command's `oidSpecs`. Same contract as
// GetPayloadStringSlice: a missing key, a non-array value, or a nil payload all
// yield nil, and members of the wrong shape are dropped rather than failing the
// whole command. A server that sends junk must not take the agent down with it.
func GetPayloadObjectSlice(payload map[string]any, key string) []map[string]any {
	raw, ok := payload[key]
	if !ok {
		return nil
	}
	slice, ok := raw.([]any)
	if !ok {
		return nil
	}
	result := make([]map[string]any, 0, len(slice))
	for _, v := range slice {
		if obj, ok := v.(map[string]any); ok {
			result = append(result, obj)
		}
	}
	return result
}

// GetPayloadObject reads a single JSON object from a command payload — e.g. the
// SNMP poll command's `limits`. Returns nil for a missing key or a non-object
// value, so callers fall back to their own defaults.
func GetPayloadObject(payload map[string]any, key string) map[string]any {
	raw, ok := payload[key]
	if !ok {
		return nil
	}
	obj, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	return obj
}
```

- [ ] **Step 4: Write the `snmppoll` spec-vocabulary test first**

Create `agent/internal/snmppoll/specs_test.go`:

```go
package snmppoll

import "testing"

func TestDefaultMode(t *testing.T) {
	tests := []struct{ oid, want string }{
		{"1.3.6.1.2.1.1.3.0", ModeGet},
		{".1.3.6.1.2.1.1.5.0", ModeGet},
		{"1.3.6.1.2.1.43.11.1.1.9", ModeWalk},
		{"1.3.6.1.2.1.2.2.1.2", ModeWalk},
		{"", ModeWalk},
	}
	for _, tt := range tests {
		if got := DefaultMode(tt.oid); got != tt.want {
			t.Errorf("DefaultMode(%q) = %q, want %q", tt.oid, got, tt.want)
		}
	}
}

func TestSpecsFromOIDs(t *testing.T) {
	specs := SpecsFromOIDs([]string{"1.3.6.1.2.1.1.3.0", "1.3.6.1.2.1.2.2.1.2"})
	if len(specs) != 2 {
		t.Fatalf("SpecsFromOIDs returned %d specs, want 2", len(specs))
	}
	// Legacy OIDs are ALWAYS `get`: a pre-W02 server never asked for a walk, and
	// inferring one would start bulk-walking production switches on upgrade.
	for i, spec := range specs {
		if spec.Mode != ModeGet {
			t.Errorf("spec %d mode = %q, want %q", i, spec.Mode, ModeGet)
		}
		if spec.Cadence != CadenceFast {
			t.Errorf("spec %d cadence = %q, want %q", i, spec.Cadence, CadenceFast)
		}
		if spec.Name != spec.OID {
			t.Errorf("spec %d name = %q, want the OID %q", i, spec.Name, spec.OID)
		}
	}
}

func TestSpecsFromOIDs_SkipsBlanks(t *testing.T) {
	if got := SpecsFromOIDs([]string{"", "   "}); len(got) != 0 {
		t.Fatalf("SpecsFromOIDs(blanks) = %v, want empty", got)
	}
}

func TestInstanceSuffix(t *testing.T) {
	tests := []struct{ name, base, pdu, want string }{
		{"scalar exact match", "1.3.6.1.2.1.1.3.0", ".1.3.6.1.2.1.1.3.0", ""},
		{"leading dots on both sides", ".1.3.6.1.2.1.1.3.0", "1.3.6.1.2.1.1.3.0", ""},
		{"single index", "1.3.6.1.2.1.43.11.1.1.9", ".1.3.6.1.2.1.43.11.1.1.9.1", "1"},
		{"compound index", "1.3.6.1.2.1.43.11.1.1.9", ".1.3.6.1.2.1.43.11.1.1.9.1.1", "1.1"},
		{"unrelated oid", "1.3.6.1.2.1.1.3.0", ".1.3.6.1.2.1.2.2.1.2.1", ""},
		// A sibling whose OID merely starts with the same digits is NOT an
		// instance: 1.3.6.1.2.1.43.11.1.1.90 must not read as instance "0".
		{"digit-prefix sibling is not an instance", "1.3.6.1.2.1.43.11.1.1.9", ".1.3.6.1.2.1.43.11.1.1.90", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := InstanceSuffix(tt.base, tt.pdu); got != tt.want {
				t.Errorf("InstanceSuffix(%q, %q) = %q, want %q", tt.base, tt.pdu, got, tt.want)
			}
		})
	}
}

func TestFindSpecForOID(t *testing.T) {
	specs := []OIDSpec{
		{OID: "1.3.6.1.2.1.43.11.1.1", Name: "prtMarkerSupplies", Mode: ModeWalk},
		{OID: "1.3.6.1.2.1.43.11.1.1.9", Name: "prtMarkerSuppliesLevel", Mode: ModeWalk},
		{OID: "1.3.6.1.2.1.1.3.0", Name: "sysUpTime", Mode: ModeGet},
	}

	// Longest base wins, or every supply column collapses into the table root.
	if got := FindSpecForOID(specs, ".1.3.6.1.2.1.43.11.1.1.9.1.1"); got == nil || got.Name != "prtMarkerSuppliesLevel" {
		t.Fatalf("FindSpecForOID(level instance) = %v, want prtMarkerSuppliesLevel", got)
	}
	if got := FindSpecForOID(specs, ".1.3.6.1.2.1.1.3.0"); got == nil || got.Name != "sysUpTime" {
		t.Fatalf("FindSpecForOID(scalar) = %v, want sysUpTime", got)
	}
	if got := FindSpecForOID(specs, ".1.3.6.1.4.1.9999.1"); got != nil {
		t.Fatalf("FindSpecForOID(unknown) = %v, want nil", got)
	}
}
```

- [ ] **Step 5: Implement `specs.go`**

Create `agent/internal/snmppoll/specs.go`:

```go
package snmppoll

import (
	"strings"
	"time"
)

// Acquisition modes and cadences, as sent by the server in `oidSpecs`
// (spec §7.1). Unknown values fall back to the defaults rather than failing the
// poll: a newer server must be able to add a mode without bricking old agents.
const (
	ModeGet     = "get"
	ModeWalk    = "walk"
	CadenceFast = "fast"
	CadenceSlow = "slow"
)

// Per-OID error codes carried on a metric row (spec §7.2). The set is CLOSED:
// the server's ingestion and the OID-state derivation both key off it, so a new
// code means a coordinated server change.
const (
	ErrCodeNoSuchObject   = "noSuchObject"
	ErrCodeNoSuchInstance = "noSuchInstance"
	ErrCodeEndOfMib       = "endOfMib"
	ErrCodeTimeout        = "timeout"
	ErrCodeTruncated      = "truncated"
)

// OIDSpec is one acquisition instruction from the server.
type OIDSpec struct {
	OID     string `json:"oid"`
	Name    string `json:"name"`
	Mode    string `json:"mode"`
	Cadence string `json:"cadence"`
}

// PollLimits bounds one poll. Enforced per OID and per poll, on rows, bytes and
// wall clock, because each bound fails differently: a 48-port switch blows the
// row bound, a chatty FDB blows the byte bound, and an unresponsive device that
// answers slowly blows neither but holds the agent's poll slot for minutes.
type PollLimits struct {
	MaxRowsPerOID   int
	MaxRowsPerPoll  int
	MaxBytesPerPoll int
	MaxDuration     time.Duration
}

// DefaultPollLimits mirrors POLL_LIMITS in
// apps/api/src/services/snmpOidSpecs.ts and is used whenever the payload omits
// `limits` — i.e. against every server released before W02.
var DefaultPollLimits = PollLimits{
	MaxRowsPerOID:   512,
	MaxRowsPerPoll:  4096,
	MaxBytesPerPoll: 1 << 20,
	MaxDuration:     20 * time.Second,
}

// DefaultMode mirrors the server's rule: a trailing `.0` is SMI's scalar
// instance marker, everything else is a columnar object that has to be walked.
func DefaultMode(oid string) string {
	if strings.HasSuffix(oid, ".0") {
		return ModeGet
	}
	return ModeWalk
}

// SpecsFromOIDs converts a legacy `oids` payload into specs.
//
// Everything becomes `get`. A server that sent no `oidSpecs` never asked for a
// walk, and a new agent that inferred one would start bulk-walking every
// customer switch the moment it upgraded — against a server that has no
// per-instance ingestion to receive the result.
func SpecsFromOIDs(oids []string) []OIDSpec {
	specs := make([]OIDSpec, 0, len(oids))
	for _, oid := range oids {
		oid = strings.TrimSpace(oid)
		if oid == "" {
			continue
		}
		specs = append(specs, OIDSpec{OID: oid, Name: oid, Mode: ModeGet, Cadence: CadenceFast})
	}
	return specs
}

// normalizeOID strips the leading dot gosnmp puts on returned PDU names so a
// base OID from the template ("1.3.6…") and a PDU name (".1.3.6…") compare.
func normalizeOID(oid string) string {
	return strings.TrimPrefix(strings.TrimSpace(oid), ".")
}

// InstanceSuffix returns the index part of a PDU name relative to its base OID:
// "" for a scalar or an exact match, "1.1" for prtMarkerSuppliesLevel.1.1.
//
// The separator is required, not just the prefix: 1.3.6.1.2.1.43.11.1.1.90 is a
// DIFFERENT object from 1.3.6.1.2.1.43.11.1.1.9, not its instance 0.
func InstanceSuffix(baseOID, pduName string) string {
	base := normalizeOID(baseOID)
	name := normalizeOID(pduName)
	if base == "" || name == base {
		return ""
	}
	if strings.HasPrefix(name, base+".") {
		return name[len(base)+1:]
	}
	return ""
}

// FindSpecForOID returns the spec a PDU belongs to, matching on OID rather than
// on response order so a device that reorders or omits varbinds cannot shift
// every metric onto the wrong name.
//
// The LONGEST matching base wins: a template carrying both a table root and one
// of its columns would otherwise collapse every column into the root.
func FindSpecForOID(specs []OIDSpec, pduName string) *OIDSpec {
	name := normalizeOID(pduName)
	var best *OIDSpec
	for i := range specs {
		base := normalizeOID(specs[i].OID)
		if base == "" {
			continue
		}
		if name != base && !strings.HasPrefix(name, base+".") {
			continue
		}
		if best == nil || len(base) > len(normalizeOID(best.OID)) {
			best = &specs[i]
		}
	}
	return best
}
```

- [ ] **Step 6: Write the handler parsing test first**

Create `agent/internal/heartbeat/handlers_network_snmp_test.go`:

```go
package heartbeat

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/snmppoll"
)

func basePayload() map[string]any {
	return map[string]any{
		"deviceId":  "dev-1",
		"target":    "192.0.2.10",
		"port":      161,
		"version":   "v2c",
		"community": "public",
		"oids":      []any{"1.3.6.1.2.1.1.3.0", "1.3.6.1.2.1.43.11.1.1.9"},
	}
}

func TestParseSnmpPollRequest_LegacyPayloadBecomesAllGets(t *testing.T) {
	device, errResult := parseSnmpPollRequest(basePayload())
	if errResult != nil {
		t.Fatalf("parseSnmpPollRequest returned %v, want nil error result", errResult)
	}
	if len(device.Specs) != 2 {
		t.Fatalf("Specs = %v, want 2 specs", device.Specs)
	}
	for _, spec := range device.Specs {
		if spec.Mode != snmppoll.ModeGet {
			t.Errorf("legacy OID %q parsed as mode %q, want %q — a pre-W02 server never asked for a walk",
				spec.OID, spec.Mode, snmppoll.ModeGet)
		}
	}
	if device.Limits != snmppoll.DefaultPollLimits {
		t.Errorf("Limits = %+v, want DefaultPollLimits %+v", device.Limits, snmppoll.DefaultPollLimits)
	}
	// The legacy field is still handed to the device so nothing downstream that
	// reads OIDs changes meaning.
	if len(device.OIDs) != 2 {
		t.Errorf("OIDs = %v, want the 2 payload OIDs", device.OIDs)
	}
}

func TestParseSnmpPollRequest_OidSpecsWin(t *testing.T) {
	payload := basePayload()
	payload["oidSpecs"] = []any{
		map[string]any{"oid": "1.3.6.1.2.1.1.3.0", "name": "sysUpTime", "mode": "get", "cadence": "fast"},
		map[string]any{"oid": "1.3.6.1.2.1.43.11.1.1.9", "name": "prtMarkerSuppliesLevel", "mode": "walk", "cadence": "fast"},
	}

	device, errResult := parseSnmpPollRequest(payload)
	if errResult != nil {
		t.Fatalf("parseSnmpPollRequest returned %v, want nil error result", errResult)
	}
	if len(device.Specs) != 2 {
		t.Fatalf("Specs = %v, want 2", device.Specs)
	}
	if device.Specs[0].Name != "sysUpTime" || device.Specs[0].Mode != snmppoll.ModeGet {
		t.Errorf("spec 0 = %+v, want sysUpTime/get", device.Specs[0])
	}
	if device.Specs[1].Name != "prtMarkerSuppliesLevel" || device.Specs[1].Mode != snmppoll.ModeWalk {
		t.Errorf("spec 1 = %+v, want prtMarkerSuppliesLevel/walk", device.Specs[1])
	}
}

func TestParseSnmpPollRequest_SpecDefaultsFillGaps(t *testing.T) {
	payload := basePayload()
	payload["oidSpecs"] = []any{
		map[string]any{"oid": "1.3.6.1.2.1.2.2.1.2"},                       // no name, no mode, no cadence
		map[string]any{"oid": "1.3.6.1.2.1.1.3.0", "mode": "sideways"},     // unknown mode
		map[string]any{"name": "no oid at all"},                            // unusable
	}

	device, _ := parseSnmpPollRequest(payload)
	if len(device.Specs) != 2 {
		t.Fatalf("Specs = %+v, want the 2 usable entries", device.Specs)
	}
	if device.Specs[0].Mode != snmppoll.ModeWalk || device.Specs[0].Name != "1.3.6.1.2.1.2.2.1.2" {
		t.Errorf("spec 0 = %+v, want walk with the OID as its name", device.Specs[0])
	}
	if device.Specs[1].Mode != snmppoll.ModeGet {
		t.Errorf("unknown mode %q should fall back to the .0 default get, got %q", "sideways", device.Specs[1].Mode)
	}
	if device.Specs[0].Cadence != snmppoll.CadenceFast {
		t.Errorf("missing cadence = %q, want fast", device.Specs[0].Cadence)
	}
}

func TestParseSnmpPollRequest_LimitsFromPayload(t *testing.T) {
	payload := basePayload()
	payload["limits"] = map[string]any{
		"maxRowsPerOid":   float64(16),
		"maxRowsPerPoll":  float64(32),
		"maxBytesPerPoll": float64(4096),
		"maxDurationMs":   float64(1500),
	}

	device, _ := parseSnmpPollRequest(payload)
	want := snmppoll.PollLimits{MaxRowsPerOID: 16, MaxRowsPerPoll: 32, MaxBytesPerPoll: 4096, MaxDuration: 1500 * time.Millisecond}
	if device.Limits != want {
		t.Errorf("Limits = %+v, want %+v", device.Limits, want)
	}
}

func TestParseSnmpPollRequest_PartialLimitsKeepDefaults(t *testing.T) {
	payload := basePayload()
	payload["limits"] = map[string]any{"maxRowsPerOid": float64(8)}

	device, _ := parseSnmpPollRequest(payload)
	if device.Limits.MaxRowsPerOID != 8 {
		t.Errorf("MaxRowsPerOID = %d, want 8", device.Limits.MaxRowsPerOID)
	}
	if device.Limits.MaxRowsPerPoll != snmppoll.DefaultPollLimits.MaxRowsPerPoll {
		t.Errorf("MaxRowsPerPoll = %d, want the default %d", device.Limits.MaxRowsPerPoll, snmppoll.DefaultPollLimits.MaxRowsPerPoll)
	}
	if device.Limits.MaxDuration != snmppoll.DefaultPollLimits.MaxDuration {
		t.Errorf("MaxDuration = %v, want the default %v", device.Limits.MaxDuration, snmppoll.DefaultPollLimits.MaxDuration)
	}
}

func TestParseSnmpPollRequest_NonPositiveLimitsAreIgnored(t *testing.T) {
	payload := basePayload()
	payload["limits"] = map[string]any{"maxRowsPerOid": float64(0), "maxDurationMs": float64(-1)}

	device, _ := parseSnmpPollRequest(payload)
	// A zero bound would mean "collect nothing" and a negative duration would
	// mean "already expired" — both silently kill collection, so they are
	// treated as absent.
	if device.Limits.MaxRowsPerOID != snmppoll.DefaultPollLimits.MaxRowsPerOID {
		t.Errorf("MaxRowsPerOID = %d, want the default %d", device.Limits.MaxRowsPerOID, snmppoll.DefaultPollLimits.MaxRowsPerOID)
	}
	if device.Limits.MaxDuration != snmppoll.DefaultPollLimits.MaxDuration {
		t.Errorf("MaxDuration = %v, want the default %v", device.Limits.MaxDuration, snmppoll.DefaultPollLimits.MaxDuration)
	}
}

func TestParseSnmpPollRequest_RejectsBadPortAndMissingTarget(t *testing.T) {
	if _, errResult := parseSnmpPollRequest(map[string]any{"port": 161}); errResult == nil {
		t.Error("missing target should return an error result")
	}
	payload := basePayload()
	payload["port"] = 70000
	if _, errResult := parseSnmpPollRequest(payload); errResult == nil {
		t.Error("out-of-range port should return an error result")
	}
}
```

- [ ] **Step 7: Watch it fail**

```bash
cd agent && go test -race ./internal/heartbeat/ -run TestParseSnmpPollRequest
```
Expected: `undefined: parseSnmpPollRequest` (build failure).

- [ ] **Step 8: Implement the handler split**

Replace `handleSnmpPoll` in `agent/internal/heartbeat/handlers_network.go` with the parse helper plus a thin handler (the result helper arrives in Task 6):

```go
// parseSnmpPollRequest turns a poll command payload into an SNMPDevice.
//
// Split out of handleSnmpPoll so the wire contract (spec §7.1) is unit-testable
// without a network: every branch below decides what the agent will put on the
// wire, and that is exactly the part an SNMP device cannot be asked about.
func parseSnmpPollRequest(payload map[string]any) (snmppoll.SNMPDevice, *tools.CommandResult) {
	target, errResult := tools.RequirePayloadString(payload, "target")
	if errResult != nil {
		return snmppoll.SNMPDevice{}, errResult
	}

	var snmpVersion snmppoll.SNMPVersion
	switch tools.GetPayloadString(payload, "version", "v2c") {
	case "v1":
		snmpVersion = 0x00
	case "v3":
		snmpVersion = 0x03
	default:
		snmpVersion = 0x01
	}

	// The port narrows to uint16 below; an out-of-range value would silently
	// wrap onto some other port, so reject it instead of probing the wrong one.
	port := tools.GetPayloadInt(payload, "port", 161)
	if port < 1 || port > 65535 {
		result := tools.NewErrorResult(fmt.Errorf("port must be 1-65535, got %d", port), 0)
		return snmppoll.SNMPDevice{}, &result
	}

	oids := tools.GetPayloadStringSlice(payload, "oids")

	return snmppoll.SNMPDevice{
		IP:      target,
		Port:    uint16(port),
		Version: snmpVersion,
		Auth: snmppoll.SNMPAuth{
			Community:      tools.GetPayloadString(payload, "community", "public"),
			Username:       tools.GetPayloadString(payload, "username", ""),
			AuthProtocol:   snmppoll.ParseAuthProtocol(tools.GetPayloadString(payload, "authProtocol", "")),
			AuthPassphrase: tools.GetPayloadString(payload, "authPassword", ""),
			PrivProtocol:   snmppoll.ParsePrivProtocol(tools.GetPayloadString(payload, "privProtocol", "")),
			PrivPassphrase: tools.GetPayloadString(payload, "privPassword", ""),
		},
		OIDs:    oids,
		Specs:   parseOIDSpecs(payload, oids),
		Limits:  parsePollLimits(payload),
		Timeout: time.Duration(tools.GetPayloadInt(payload, "timeout", 2)) * time.Second,
		Retries: tools.GetPayloadInt(payload, "retries", 1),
	}, nil
}

// parseOIDSpecs reads `oidSpecs`, falling back to the legacy `oids` as plain
// GETs. The fallback is the compatibility contract in both directions: a
// pre-W02 server sends no specs and gets exactly today's behaviour.
func parseOIDSpecs(payload map[string]any, legacyOIDs []string) []snmppoll.OIDSpec {
	raw := tools.GetPayloadObjectSlice(payload, "oidSpecs")
	specs := make([]snmppoll.OIDSpec, 0, len(raw))
	for _, entry := range raw {
		oid := strings.TrimSpace(tools.GetPayloadString(entry, "oid", ""))
		if oid == "" {
			continue
		}
		name := tools.GetPayloadString(entry, "name", "")
		if name == "" {
			name = oid
		}
		mode := tools.GetPayloadString(entry, "mode", "")
		if mode != snmppoll.ModeGet && mode != snmppoll.ModeWalk {
			mode = snmppoll.DefaultMode(oid)
		}
		cadence := tools.GetPayloadString(entry, "cadence", "")
		if cadence != snmppoll.CadenceFast && cadence != snmppoll.CadenceSlow {
			cadence = snmppoll.CadenceFast
		}
		specs = append(specs, snmppoll.OIDSpec{OID: oid, Name: name, Mode: mode, Cadence: cadence})
	}
	if len(specs) > 0 {
		return specs
	}
	return snmppoll.SpecsFromOIDs(legacyOIDs)
}

// parsePollLimits reads `limits`, keeping the compiled-in default for any bound
// the server omitted or sent as a non-positive value. A zero row bound means
// "collect nothing" and a negative duration means "already expired"; both would
// silently stop collection, so neither is honoured.
func parsePollLimits(payload map[string]any) snmppoll.PollLimits {
	limits := snmppoll.DefaultPollLimits
	raw := tools.GetPayloadObject(payload, "limits")
	if raw == nil {
		return limits
	}
	if v := tools.GetPayloadInt(raw, "maxRowsPerOid", 0); v > 0 {
		limits.MaxRowsPerOID = v
	}
	if v := tools.GetPayloadInt(raw, "maxRowsPerPoll", 0); v > 0 {
		limits.MaxRowsPerPoll = v
	}
	if v := tools.GetPayloadInt(raw, "maxBytesPerPoll", 0); v > 0 {
		limits.MaxBytesPerPoll = v
	}
	if v := tools.GetPayloadInt(raw, "maxDurationMs", 0); v > 0 {
		limits.MaxDuration = time.Duration(v) * time.Millisecond
	}
	return limits
}

func handleSnmpPoll(_ *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	device, errResult := parseSnmpPollRequest(cmd.Payload)
	if errResult != nil {
		errResult.DurationMs = time.Since(start).Milliseconds()
		return *errResult
	}

	metrics, err := snmppoll.CollectMetrics(device)
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	return tools.NewSuccessResult(map[string]any{
		"deviceId": tools.GetPayloadString(cmd.Payload, "deviceId", ""),
		"metrics":  metrics,
	}, time.Since(start).Milliseconds())
}
```

Add `"strings"` to the file's import block. `SNMPDevice.Specs` / `.Limits` do not exist yet — add them in `agent/internal/snmppoll/metrics.go` now:

```go
// SNMPDevice defines the target and credentials for polling.
type SNMPDevice struct {
	IP             string
	Port           uint16
	Version        SNMPVersion
	Auth           SNMPAuth
	// OIDs is the legacy flat list. Kept verbatim: it is what pre-W02 servers
	// send and what SpecsFromOIDs falls back to.
	OIDs           []string
	// Specs is the per-OID acquisition plan (spec §7.1). When empty,
	// CollectMetrics derives it from OIDs as plain GETs.
	Specs          []OIDSpec
	// Limits bounds one poll. The zero value is replaced with
	// DefaultPollLimits by CollectMetrics.
	Limits         PollLimits
	Timeout        time.Duration
	Retries        int
	MaxRepetitions uint32
}
```

- [ ] **Step 9: Run green**

```bash
cd agent && go test -race ./internal/remote/tools/ ./internal/snmppoll/ ./internal/heartbeat/
```
Expected: all three packages pass. `TestHandleSnmpPollRejectsOutOfRangePort` must still pass — the handler's early returns are unchanged.

- [ ] **Step 10: Commit**

```bash
git add agent/internal/remote/tools/types.go agent/internal/remote/tools/payload_objects_test.go \
        agent/internal/snmppoll/specs.go agent/internal/snmppoll/specs_test.go agent/internal/snmppoll/metrics.go \
        agent/internal/heartbeat/handlers_network.go agent/internal/heartbeat/handlers_network_snmp_test.go
git commit -m "$(cat <<'EOF'
feat(agent/snmp): parse oidSpecs and limits from the poll payload

Adds tools.GetPayloadObjectSlice/GetPayloadObject, the snmppoll spec
vocabulary (OIDSpec, PollLimits, DefaultPollLimits, error codes, OID/instance
helpers), and splits payload parsing out of handleSnmpPoll into the pure
parseSnmpPollRequest so the wire contract is testable without a network.

A payload with no oidSpecs falls back to the legacy `oids` as plain GETs:
a pre-W02 server never asked for a walk, and inferring one would start
bulk-walking customer switches on upgrade.

Spec §7.1, §7.4.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `SNMPMetric` gains `BaseOID`/`Instance`/`Error`; the GET path emits error rows

**Files:**
- Modify: `agent/internal/snmppoll/metrics.go`
- Create: `agent/internal/snmppoll/metrics_specs_test.go`

**Interfaces:**
- Produces:
  ```go
  type SNMPMetric struct {
      OID           string    `json:"oid"`
      BaseOID       string    `json:"baseOid"`
      Instance      string    `json:"instance"`
      Name          string    `json:"name"`
      Value         any       `json:"value"`
      Error         string    `json:"error,omitempty"`
      Timestamp     time.Time `json:"timestamp"`
      ValueEncoding string    `json:"valueEncoding,omitempty"`
  }
  type pduSource interface {
      GetMulti(oids []string) ([]gosnmp.SnmpPDU, error)
      WalkBounded(rootOID string, fn gosnmp.WalkFunc) error
  }
  func collectWithSource(src pduSource, specs []OIDSpec, limits PollLimits, stamp time.Time) ([]SNMPMetric, error)
  ```
- Consumes: `OIDSpec`, `PollLimits`, `FindSpecForOID`, `InstanceSuffix`, the error-code constants (Task 3).

**Decision (no `omitempty` on `baseOid`/`instance`).** They are the point of protocol 2 and are always meaningful, including the empty instance of a scalar; the spec's §7.2 example shows `"instance": ""` on the wire. `error` keeps `omitempty` because its absence is the normal case and it costs bytes on every one of ~138 k rows/day.

**Decision (pair PDUs to specs by OID, not by index).** SNMP guarantees varbind order, but a device that omits or reorders one varbind would then shift every subsequent metric onto the wrong name — a silent data-corruption bug that no test of a well-behaved device would catch. `FindSpecForOID` is O(specs × pdus) on lists of tens of entries.

**Decision (this task keeps one `GetMulti`).** `walk` specs are still fetched through the GET batch here, so the increment is complete and shippable on its own: table columns stop producing silent `value_type = 'null'` rows and start producing explicit `noSuchObject` error rows the server can render as `unsupported`. Task 5 replaces that with real walks.

- [ ] **Step 1: Write the test first**

```bash
ls agent/internal/snmppoll/metrics_specs_test.go   # must not exist
```

Create `agent/internal/snmppoll/metrics_specs_test.go`:

```go
package snmppoll

import (
	"errors"
	"testing"
	"time"

	"github.com/gosnmp/gosnmp"
)

// fakePDUSource stands in for *SNMPClient. Poll behaviour is decided entirely
// by the PDUs a device returns, and a fake is the only way to exercise an
// unsupported OID, a 600-row table and a mid-walk failure without one.
type fakePDUSource struct {
	getPDUs  []gosnmp.SnmpPDU
	getErr   error
	getCalls [][]string

	// walkPDUs maps a root OID to the rows a walk of it yields.
	walkPDUs  map[string][]gosnmp.SnmpPDU
	walkErrs  map[string]error
	walkCalls []string
	// walkDelay advances the clock the caller sees, per row, for deadline tests.
	onWalkRow func()
}

func (f *fakePDUSource) GetMulti(oids []string) ([]gosnmp.SnmpPDU, error) {
	f.getCalls = append(f.getCalls, oids)
	if f.getErr != nil {
		return nil, f.getErr
	}
	return f.getPDUs, nil
}

func (f *fakePDUSource) WalkBounded(rootOID string, fn gosnmp.WalkFunc) error {
	f.walkCalls = append(f.walkCalls, rootOID)
	if err, ok := f.walkErrs[rootOID]; ok && err != nil {
		return err
	}
	for _, pdu := range f.walkPDUs[rootOID] {
		if f.onWalkRow != nil {
			f.onWalkRow()
		}
		if err := fn(pdu); err != nil {
			return err
		}
	}
	return nil
}

var stamp = time.Date(2026, 9, 16, 12, 0, 0, 0, time.UTC)

func metricByOID(metrics []SNMPMetric, oid string) *SNMPMetric {
	for i := range metrics {
		if metrics[i].OID == oid {
			return &metrics[i]
		}
	}
	return nil
}

func TestCollectWithSource_ScalarGetCarriesBaseAndEmptyInstance(t *testing.T) {
	src := &fakePDUSource{getPDUs: []gosnmp.SnmpPDU{
		{Name: ".1.3.6.1.2.1.1.3.0", Type: gosnmp.TimeTicks, Value: uint32(12345)},
	}}
	specs := []OIDSpec{{OID: "1.3.6.1.2.1.1.3.0", Name: "sysUpTime", Mode: ModeGet, Cadence: CadenceFast}}

	metrics, err := collectWithSource(src, specs, DefaultPollLimits, stamp)
	if err != nil {
		t.Fatalf("collectWithSource returned %v", err)
	}
	if len(metrics) != 1 {
		t.Fatalf("got %d metrics, want 1: %+v", len(metrics), metrics)
	}
	m := metrics[0]
	if m.BaseOID != "1.3.6.1.2.1.1.3.0" {
		t.Errorf("BaseOID = %q, want the template's own spelling", m.BaseOID)
	}
	if m.Instance != "" {
		t.Errorf("Instance = %q, want empty for a scalar", m.Instance)
	}
	if m.Name != "sysUpTime" {
		t.Errorf("Name = %q, want the spec name", m.Name)
	}
	if m.Error != "" {
		t.Errorf("Error = %q, want empty", m.Error)
	}
	// The OID field keeps the device's own spelling, as it always has — the
	// server stores it and legacy rows are matched on it.
	if m.OID != ".1.3.6.1.2.1.1.3.0" {
		t.Errorf("OID = %q, want the PDU name verbatim", m.OID)
	}
}

func TestCollectWithSource_UnsupportedOIDBecomesAnErrorRow(t *testing.T) {
	tests := []struct {
		name     string
		pduType  gosnmp.Asn1BER
		wantCode string
	}{
		{"noSuchObject", gosnmp.NoSuchObject, ErrCodeNoSuchObject},
		{"noSuchInstance", gosnmp.NoSuchInstance, ErrCodeNoSuchInstance},
		{"endOfMibView", gosnmp.EndOfMibView, ErrCodeEndOfMib},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			src := &fakePDUSource{getPDUs: []gosnmp.SnmpPDU{
				{Name: ".1.3.6.1.2.1.25.3.5.1.1", Type: tt.pduType, Value: nil},
			}}
			specs := []OIDSpec{{OID: "1.3.6.1.2.1.25.3.5.1.1", Name: "hrPrinterStatus", Mode: ModeGet, Cadence: CadenceFast}}

			metrics, err := collectWithSource(src, specs, DefaultPollLimits, stamp)
			if err != nil {
				t.Fatalf("collectWithSource returned %v", err)
			}
			if len(metrics) != 1 {
				t.Fatalf("got %d metrics, want 1", len(metrics))
			}
			// This is F3's fix: the row used to be stored as value_type 'null',
			// indistinguishable from a device that genuinely reported nothing.
			if metrics[0].Error != tt.wantCode {
				t.Errorf("Error = %q, want %q", metrics[0].Error, tt.wantCode)
			}
			if metrics[0].Value != nil {
				t.Errorf("Value = %v, want nil on an error row", metrics[0].Value)
			}
			if metrics[0].Name != "hrPrinterStatus" {
				t.Errorf("Name = %q, want the spec name so the UI can label the failure", metrics[0].Name)
			}
		})
	}
}

func TestCollectWithSource_PairsPDUsBySpecNotByOrder(t *testing.T) {
	// The device answers in a different order than asked and drops one varbind.
	src := &fakePDUSource{getPDUs: []gosnmp.SnmpPDU{
		{Name: ".1.3.6.1.2.1.1.5.0", Type: gosnmp.OctetString, Value: []byte("switch-2")},
		{Name: ".1.3.6.1.2.1.1.3.0", Type: gosnmp.TimeTicks, Value: uint32(7)},
	}}
	specs := []OIDSpec{
		{OID: "1.3.6.1.2.1.1.3.0", Name: "sysUpTime", Mode: ModeGet, Cadence: CadenceFast},
		{OID: "1.3.6.1.2.1.1.5.0", Name: "sysName", Mode: ModeGet, Cadence: CadenceFast},
		{OID: "1.3.6.1.2.1.1.6.0", Name: "sysLocation", Mode: ModeGet, Cadence: CadenceFast},
	}

	metrics, err := collectWithSource(src, specs, DefaultPollLimits, stamp)
	if err != nil {
		t.Fatalf("collectWithSource returned %v", err)
	}
	if m := metricByOID(metrics, ".1.3.6.1.2.1.1.5.0"); m == nil || m.Name != "sysName" {
		t.Fatalf("out-of-order PDU landed on %v, want sysName", m)
	}
	if m := metricByOID(metrics, ".1.3.6.1.2.1.1.3.0"); m == nil || m.Name != "sysUpTime" {
		t.Fatalf("out-of-order PDU landed on %v, want sysUpTime", m)
	}
	// The dropped varbind produces nothing rather than shifting the others.
	if len(metrics) != 2 {
		t.Errorf("got %d metrics, want 2 — the omitted varbind must not invent a row", len(metrics))
	}
}

func TestCollectWithSource_UnknownPDUFallsBackToItsOwnOID(t *testing.T) {
	src := &fakePDUSource{getPDUs: []gosnmp.SnmpPDU{
		{Name: ".1.3.6.1.4.1.9999.1.0", Type: gosnmp.Integer, Value: 1},
	}}
	specs := []OIDSpec{{OID: "1.3.6.1.2.1.1.3.0", Name: "sysUpTime", Mode: ModeGet, Cadence: CadenceFast}}

	metrics, err := collectWithSource(src, specs, DefaultPollLimits, stamp)
	if err != nil {
		t.Fatalf("collectWithSource returned %v", err)
	}
	if len(metrics) != 1 {
		t.Fatalf("got %d metrics, want 1", len(metrics))
	}
	if metrics[0].BaseOID != ".1.3.6.1.4.1.9999.1.0" || metrics[0].Instance != "" {
		t.Errorf("unmatched PDU = %+v, want baseOid == oid and empty instance", metrics[0])
	}
}

func TestCollectWithSource_GetTransportErrorFailsThePoll(t *testing.T) {
	src := &fakePDUSource{getErr: errors.New("request timeout")}
	specs := []OIDSpec{{OID: "1.3.6.1.2.1.1.3.0", Name: "sysUpTime", Mode: ModeGet, Cadence: CadenceFast}}

	// Unchanged from today: a failed GET batch means the device did not answer,
	// which the server already handles as a whole-poll failure.
	if _, err := collectWithSource(src, specs, DefaultPollLimits, stamp); err == nil {
		t.Fatal("collectWithSource with a failing GET should return an error")
	}
}

func TestCollectMetrics_NoSpecsAndNoOIDsReturnsError(t *testing.T) {
	if _, err := CollectMetrics(SNMPDevice{IP: "192.0.2.1"}); err == nil {
		t.Fatal("CollectMetrics with neither Specs nor OIDs should return an error")
	}
}
```

- [ ] **Step 2: Watch it fail**

```bash
cd agent && go test -race ./internal/snmppoll/ -run 'TestCollectWithSource|TestCollectMetrics_NoSpecs'
```
Expected: `undefined: collectWithSource`, and `unknown field BaseOID in struct literal` from the test's field accesses (build failure).

- [ ] **Step 3: Implement**

In `agent/internal/snmppoll/metrics.go`:

1. Extend `SNMPMetric`:
```go
// SNMPMetric represents a single SNMP value read.
//
// BaseOID and Instance split what used to be one opaque OID string. BaseOID is
// the TEMPLATE's own spelling of the object, which is what the server matches a
// row back to a template entry with; Instance is the index suffix, empty for a
// scalar. Neither is `omitempty`: they are the substance of the protocol-2 row
// shape (spec §7.2), and an empty instance is a fact about a scalar, not a
// missing field.
//
// Error carries a per-OID failure code (spec §7.2 closed set). It IS
// `omitempty` — the overwhelming majority of rows succeed, and a walked 48-port
// switch is ~138k rows/day.
//
// ValueEncoding declares how Value was encoded by the agent. It is set to
// ValueEncodingHex only for octet strings the agent had to hex-encode, and is
// omitted otherwise: `omitempty` keeps the wire format backward-compatible in
// both directions (older APIs ignore the unknown field, older agents simply
// never send it).
type SNMPMetric struct {
	OID           string    `json:"oid"`
	BaseOID       string    `json:"baseOid"`
	Instance      string    `json:"instance"`
	Name          string    `json:"name"`
	Value         any       `json:"value"`
	Error         string    `json:"error,omitempty"`
	Timestamp     time.Time `json:"timestamp"`
	ValueEncoding string    `json:"valueEncoding,omitempty"`
}
```

2. Replace `CollectMetrics`, `buildMetrics` and `getDevicePDUs`:
```go
// pduSource is the SNMP transport CollectMetrics needs: a multi-OID GET and a
// bounded, streaming subtree walk. *SNMPClient satisfies it.
//
// The seam exists for one reason: what this file does is decided entirely by
// the PDUs a device returns, and an unsupported table OID, a 600-row FDB and a
// mid-walk timeout are all things a real device on a test runner cannot be
// asked to produce. No production behaviour depends on the indirection.
type pduSource interface {
	GetMulti(oids []string) ([]gosnmp.SnmpPDU, error)
	WalkBounded(rootOID string, fn gosnmp.WalkFunc) error
}

// CollectMetrics fetches all configured OIDs for a device.
func CollectMetrics(device SNMPDevice) ([]SNMPMetric, error) {
	if device.IP == "" {
		return nil, errors.New("device IP is required")
	}

	specs := device.Specs
	if len(specs) == 0 {
		specs = SpecsFromOIDs(device.OIDs)
	}
	if len(specs) == 0 {
		return nil, errors.New("device has no OIDs configured")
	}

	limits := device.Limits
	if limits.MaxRowsPerOID <= 0 {
		limits = DefaultPollLimits
	}

	client, err := NewClient(device.ClientConfig())
	if err != nil {
		return nil, err
	}
	defer client.Close()

	return collectWithSource(client, specs, limits, time.Now().UTC())
}

// collectWithSource is CollectMetrics with the transport and the clock supplied.
func collectWithSource(src pduSource, specs []OIDSpec, limits PollLimits, stamp time.Time) ([]SNMPMetric, error) {
	getSpecs := make([]OIDSpec, 0, len(specs))
	for _, spec := range specs {
		// Task 5 routes ModeWalk specs to bounded walks; until then every spec
		// goes through the GET batch, which is what the agent has always done.
		getSpecs = append(getSpecs, spec)
	}

	metrics := make([]SNMPMetric, 0, len(getSpecs))
	if len(getSpecs) > 0 {
		oids := make([]string, 0, len(getSpecs))
		for _, spec := range getSpecs {
			oids = append(oids, spec.OID)
		}
		pdus, err := src.GetMulti(oids)
		if err != nil {
			// Unchanged: a failed GET batch means the device did not answer at
			// all, which is a whole-poll transport failure, not a per-OID one.
			return nil, err
		}
		metrics = append(metrics, buildGetMetrics(getSpecs, pdus, stamp)...)
	}

	return metrics, nil
}

// buildGetMetrics maps GET varbinds onto SNMPMetric rows, declaring the encoding
// at the same place the value is produced and turning the three "this object is
// not here" PDU types into explicit error rows.
func buildGetMetrics(specs []OIDSpec, pdus []gosnmp.SnmpPDU, stamp time.Time) []SNMPMetric {
	metrics := make([]SNMPMetric, 0, len(pdus))
	for _, pdu := range pdus {
		metrics = append(metrics, metricFromPDU(specs, pdu, stamp))
	}
	return metrics
}

// metricFromPDU builds one row, resolving which spec the PDU belongs to by OID.
func metricFromPDU(specs []OIDSpec, pdu gosnmp.SnmpPDU, stamp time.Time) SNMPMetric {
	spec := FindSpecForOID(specs, pdu.Name)

	metric := SNMPMetric{
		OID:       pdu.Name,
		BaseOID:   pdu.Name,
		Instance:  "",
		Name:      pdu.Name,
		Timestamp: stamp,
	}
	if spec != nil {
		metric.BaseOID = spec.OID
		metric.Instance = InstanceSuffix(spec.OID, pdu.Name)
		metric.Name = spec.Name
	}

	// A device that does not implement the object answers with one of these
	// three PDU types and a nil value. Before W02 that became value_type
	// 'null', indistinguishable from a real null — 145 of the ~407 built-in
	// template OIDs sat in that state permanently (spec F3).
	if code := pduErrorCode(pdu); code != "" {
		metric.Error = code
		metric.Value = nil
		return metric
	}

	value, hexEncoded := parseValue(pdu)
	metric.Value = value
	if hexEncoded {
		metric.ValueEncoding = ValueEncodingHex
	}
	return metric
}

// pduErrorCode maps the SNMP "no such thing" PDU types onto the closed per-OID
// error-code set. Everything else returns "" and is treated as a value.
func pduErrorCode(pdu gosnmp.SnmpPDU) string {
	switch pdu.Type {
	case gosnmp.NoSuchObject:
		return ErrCodeNoSuchObject
	case gosnmp.NoSuchInstance:
		return ErrCodeNoSuchInstance
	case gosnmp.EndOfMibView:
		return ErrCodeEndOfMib
	default:
		return ""
	}
}
```
Delete the old `buildMetrics` and `getDevicePDUs` functions.

3. Fix the existing tests that reference the removed helpers:
```bash
cd agent && grep -n "buildMetrics\|getDevicePDUs" internal/snmppoll/metrics_test.go
```
Rename those call sites to `buildGetMetrics(nil, pdus, stamp)` — passing `nil` specs exercises the unmatched-PDU fallback, which is exactly what those tests assert (OID and value round-tripping).

- [ ] **Step 4: Run green**

```bash
cd agent && go test -race ./internal/snmppoll/ ./internal/heartbeat/
```
Expected: both packages pass, including every pre-existing `parseValue`/`octetStringToText` test.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/snmppoll/metrics.go agent/internal/snmppoll/metrics_specs_test.go agent/internal/snmppoll/metrics_test.go
git commit -m "$(cat <<'EOF'
feat(agent/snmp): per-OID base/instance/error on every metric row

SNMPMetric gains BaseOID, Instance and Error. noSuchObject, noSuchInstance
and endOfMibView now become explicit error rows instead of nil values stored
as value_type 'null' — the state 145 of the ~407 built-in template OIDs have
been stuck in. PDUs are paired to specs by OID rather than by response order,
so a device that reorders or omits a varbind cannot shift every metric onto
the wrong name.

Introduces the pduSource seam so the poll path is testable against a fake
with no network I/O.

Spec §7.2, §7.4.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: bounded walks per `walk` spec

**Files:**
- Modify: `agent/internal/snmppoll/client.go`
- Create: `agent/internal/snmppoll/client_walkbounded_test.go`
- Modify: `agent/internal/snmppoll/metrics.go`
- Modify: `agent/internal/snmppoll/metrics_specs_test.go`
- Modify: `agent/internal/snmppoll/templates.go`

**Interfaces:**
- Produces:
  ```go
  func (c *SNMPClient) WalkBounded(rootOID string, fn gosnmp.WalkFunc) error
  ```
  plus unexported `walkBudget`, `collectWalkSpec`, `metricByteSize`, `errorMetric`, `errWalkStop` in `metrics.go`.
- Consumes: `gosnmp.(*GoSNMP).BulkWalk(rootOid string, walkFn WalkFunc) error` (v1.44.0, `gosnmp.go:610`).

**Decision (streaming, not `BulkWalkAll`).** The spec names `client.BulkWalk`; the existing `SNMPClient.BulkWalk` wraps `BulkWalkAll`, which **buffers the entire subtree before returning**. A bound applied to that result bounds nothing that matters — the memory is already allocated and the wall clock already spent. W02 adds `WalkBounded` over gosnmp's streaming `BulkWalk(root, walkFn)` and stops the walk from inside the callback with a sentinel error. Existing `Walk`/`BulkWalk` callers (`discovery/snmp.go:192-199`, `discovery/adjacency.go:171-181`) are untouched.

**Decision (an empty walk is an error row).** gosnmp's walk loop breaks out on a `NoSuchObject` / `NoSuchInstance` / `EndOfMibView` PDU **without invoking the callback** (v1.44.0 `walk.go:129-133`), so a walk of a table the device does not implement is indistinguishable at the agent from an empty table. A `walk` spec that finishes with zero rows and no error therefore emits one `noSuchObject` error row. Without it the server's per-OID state could never leave `never_polled` for an unsupported table — F3 in a new costume.

**Decision (walk transport errors map to `timeout`).** The per-OID error-code set stays closed so W01's ingestion and the UI mapping need no change; the underlying error text goes to `slog.Warn` so the cause is not lost. A failed walk against a live device is overwhelmingly a request timeout.

**Decision (skipped specs get a `truncated` row).** When the poll-level budget is exhausted, every remaining walk spec emits its own `truncated` row rather than being silently omitted, so the OID table reads "partial" instead of "never polled".

- [ ] **Step 1: Write the `WalkBounded` guard test first**

Create `agent/internal/snmppoll/client_walkbounded_test.go`:

```go
package snmppoll

import (
	"strings"
	"testing"

	"github.com/gosnmp/gosnmp"
)

func TestWalkBounded_EmptyOIDReturnsError(t *testing.T) {
	err := (&SNMPClient{client: &gosnmp.GoSNMP{}}).WalkBounded("", func(gosnmp.SnmpPDU) error { return nil })
	if err == nil {
		t.Fatal("WalkBounded(\"\") = nil error, want non-nil")
	}
	if !strings.Contains(err.Error(), "oid is required") {
		t.Errorf("WalkBounded(\"\") error = %q, want it to name the missing oid", err.Error())
	}
}

func TestWalkBounded_NilClientReturnsError(t *testing.T) {
	if err := (&SNMPClient{client: nil}).WalkBounded("1.3.6", func(gosnmp.SnmpPDU) error { return nil }); err == nil {
		t.Fatal("WalkBounded with nil client = nil error, want non-nil")
	}
}

func TestWalkBounded_NilCallbackReturnsError(t *testing.T) {
	if err := (&SNMPClient{client: &gosnmp.GoSNMP{}}).WalkBounded("1.3.6", nil); err == nil {
		t.Fatal("WalkBounded with nil callback = nil error, want non-nil")
	}
}
```

- [ ] **Step 2: Append the walk-behaviour tests**

Append to `agent/internal/snmppoll/metrics_specs_test.go`:

```go
// walkRows builds n instance PDUs under base, numbered from 1.
func walkRows(base string, n int) []gosnmp.SnmpPDU {
	pdus := make([]gosnmp.SnmpPDU, 0, n)
	for i := 1; i <= n; i++ {
		pdus = append(pdus, gosnmp.SnmpPDU{
			Name:  base + "." + itoa(i),
			Type:  gosnmp.Integer,
			Value: i,
		})
	}
	return pdus
}

func itoa(i int) string { return strconv.Itoa(i) }

const suppliesLevel = ".1.3.6.1.2.1.43.11.1.1.9"

func walkSpec() OIDSpec {
	return OIDSpec{OID: "1.3.6.1.2.1.43.11.1.1.9", Name: "prtMarkerSuppliesLevel", Mode: ModeWalk, Cadence: CadenceFast}
}

func TestCollectWithSource_WalkEmitsOneRowPerInstance(t *testing.T) {
	src := &fakePDUSource{walkPDUs: map[string][]gosnmp.SnmpPDU{
		"1.3.6.1.2.1.43.11.1.1.9": walkRows(suppliesLevel, 4),
	}}

	metrics, err := collectWithSource(src, []OIDSpec{walkSpec()}, DefaultPollLimits, stamp)
	if err != nil {
		t.Fatalf("collectWithSource returned %v", err)
	}
	if len(metrics) != 4 {
		t.Fatalf("got %d metrics, want 4: %+v", len(metrics), metrics)
	}
	// No GET is issued for a walk spec — that was the bug.
	if len(src.getCalls) != 0 {
		t.Errorf("walk spec issued %d GET batches, want 0", len(src.getCalls))
	}
	for i, m := range metrics {
		if m.BaseOID != "1.3.6.1.2.1.43.11.1.1.9" {
			t.Errorf("row %d BaseOID = %q, want the template base", i, m.BaseOID)
		}
		if m.Instance != itoa(i+1) {
			t.Errorf("row %d Instance = %q, want %q", i, m.Instance, itoa(i+1))
		}
		if m.Name != "prtMarkerSuppliesLevel" {
			t.Errorf("row %d Name = %q, want the spec name", i, m.Name)
		}
		if m.Error != "" {
			t.Errorf("row %d Error = %q, want empty", i, m.Error)
		}
	}
}

func TestCollectWithSource_WalkStopsAtMaxRowsPerOID(t *testing.T) {
	src := &fakePDUSource{walkPDUs: map[string][]gosnmp.SnmpPDU{
		"1.3.6.1.2.1.43.11.1.1.9": walkRows(suppliesLevel, 40),
	}}
	limits := DefaultPollLimits
	limits.MaxRowsPerOID = 10

	metrics, err := collectWithSource(src, []OIDSpec{walkSpec()}, limits, stamp)
	if err != nil {
		t.Fatalf("collectWithSource returned %v", err)
	}
	// 10 value rows plus one truncation marker.
	if len(metrics) != 11 {
		t.Fatalf("got %d metrics, want 10 values + 1 truncated row: %+v", len(metrics), metrics)
	}
	last := metrics[len(metrics)-1]
	if last.Error != ErrCodeTruncated {
		t.Errorf("last row Error = %q, want %q", last.Error, ErrCodeTruncated)
	}
	if last.BaseOID != "1.3.6.1.2.1.43.11.1.1.9" || last.Instance != "" {
		t.Errorf("truncation row = %+v, want the base OID with an empty instance", last)
	}
	for _, m := range metrics[:10] {
		if m.Error != "" {
			t.Errorf("row before the bound carries Error %q; rows collected before truncation must still be emitted", m.Error)
		}
	}
}

func TestCollectWithSource_PollRowBudgetStopsLaterSpecs(t *testing.T) {
	src := &fakePDUSource{walkPDUs: map[string][]gosnmp.SnmpPDU{
		"1.3.6.1.2.1.43.11.1.1.9": walkRows(suppliesLevel, 10),
		"1.3.6.1.2.1.43.11.1.1.6": walkRows(".1.3.6.1.2.1.43.11.1.1.6", 10),
	}}
	limits := DefaultPollLimits
	limits.MaxRowsPerPoll = 6

	specs := []OIDSpec{
		walkSpec(),
		{OID: "1.3.6.1.2.1.43.11.1.1.6", Name: "prtMarkerSuppliesDescription", Mode: ModeWalk, Cadence: CadenceFast},
	}
	metrics, err := collectWithSource(src, specs, limits, stamp)
	if err != nil {
		t.Fatalf("collectWithSource returned %v", err)
	}

	values := 0
	truncated := map[string]bool{}
	for _, m := range metrics {
		if m.Error == ErrCodeTruncated {
			truncated[m.BaseOID] = true
			continue
		}
		values++
	}
	if values != 6 {
		t.Errorf("collected %d value rows, want the poll budget of 6", values)
	}
	// The second spec never got to run, and that must be visible rather than
	// looking like an OID that was never polled.
	if !truncated["1.3.6.1.2.1.43.11.1.1.6"] {
		t.Error("the skipped spec has no truncated row; it would read as never_polled in the UI")
	}
}

func TestCollectWithSource_ByteBudgetTruncates(t *testing.T) {
	big := make([]gosnmp.SnmpPDU, 0, 20)
	for i := 1; i <= 20; i++ {
		big = append(big, gosnmp.SnmpPDU{
			Name:  suppliesLevel + "." + itoa(i),
			Type:  gosnmp.OctetString,
			Value: []byte(strings.Repeat("x", 512)),
		})
	}
	src := &fakePDUSource{walkPDUs: map[string][]gosnmp.SnmpPDU{"1.3.6.1.2.1.43.11.1.1.9": big}}
	limits := DefaultPollLimits
	limits.MaxBytesPerPoll = 2048

	metrics, err := collectWithSource(src, []OIDSpec{walkSpec()}, limits, stamp)
	if err != nil {
		t.Fatalf("collectWithSource returned %v", err)
	}
	if len(metrics) >= 20 {
		t.Fatalf("got %d metrics, want the byte budget to cut the walk short", len(metrics))
	}
	if metrics[len(metrics)-1].Error != ErrCodeTruncated {
		t.Errorf("last row Error = %q, want %q", metrics[len(metrics)-1].Error, ErrCodeTruncated)
	}
}

func TestCollectWithSource_UnimplementedTableBecomesNoSuchObject(t *testing.T) {
	// gosnmp's walk loop breaks on NoSuchObject/NoSuchInstance/EndOfMibView
	// WITHOUT calling the callback, so an unimplemented table looks exactly like
	// an empty one here. It must not be silently empty.
	src := &fakePDUSource{walkPDUs: map[string][]gosnmp.SnmpPDU{}}

	metrics, err := collectWithSource(src, []OIDSpec{walkSpec()}, DefaultPollLimits, stamp)
	if err != nil {
		t.Fatalf("collectWithSource returned %v", err)
	}
	if len(metrics) != 1 || metrics[0].Error != ErrCodeNoSuchObject {
		t.Fatalf("empty walk produced %+v, want one %q error row", metrics, ErrCodeNoSuchObject)
	}
}

func TestCollectWithSource_WalkErrorIsPerOIDNotPerPoll(t *testing.T) {
	src := &fakePDUSource{
		getPDUs: []gosnmp.SnmpPDU{{Name: ".1.3.6.1.2.1.1.3.0", Type: gosnmp.TimeTicks, Value: uint32(9)}},
		walkErrs: map[string]error{
			"1.3.6.1.2.1.43.11.1.1.9": errors.New("request timeout"),
		},
	}
	specs := []OIDSpec{
		{OID: "1.3.6.1.2.1.1.3.0", Name: "sysUpTime", Mode: ModeGet, Cadence: CadenceFast},
		walkSpec(),
	}

	metrics, err := collectWithSource(src, specs, DefaultPollLimits, stamp)
	if err != nil {
		t.Fatalf("one failing walk must not fail the whole poll, got %v", err)
	}
	if m := metricByOID(metrics, ".1.3.6.1.2.1.1.3.0"); m == nil || m.Error != "" {
		t.Errorf("the healthy scalar was lost or errored: %v", m)
	}
	var errRow *SNMPMetric
	for i := range metrics {
		if metrics[i].BaseOID == "1.3.6.1.2.1.43.11.1.1.9" {
			errRow = &metrics[i]
		}
	}
	if errRow == nil || errRow.Error != ErrCodeTimeout {
		t.Fatalf("failing walk produced %v, want a %q error row", errRow, ErrCodeTimeout)
	}
}

func TestCollectWithSource_MixedSpecsIssueOneGetBatchAndOneWalkEach(t *testing.T) {
	src := &fakePDUSource{
		getPDUs: []gosnmp.SnmpPDU{
			{Name: ".1.3.6.1.2.1.1.3.0", Type: gosnmp.TimeTicks, Value: uint32(1)},
			{Name: ".1.3.6.1.2.1.1.5.0", Type: gosnmp.OctetString, Value: []byte("printer-1")},
		},
		walkPDUs: map[string][]gosnmp.SnmpPDU{"1.3.6.1.2.1.43.11.1.1.9": walkRows(suppliesLevel, 2)},
	}
	specs := []OIDSpec{
		{OID: "1.3.6.1.2.1.1.3.0", Name: "sysUpTime", Mode: ModeGet, Cadence: CadenceFast},
		walkSpec(),
		{OID: "1.3.6.1.2.1.1.5.0", Name: "sysName", Mode: ModeGet, Cadence: CadenceFast},
	}

	metrics, err := collectWithSource(src, specs, DefaultPollLimits, stamp)
	if err != nil {
		t.Fatalf("collectWithSource returned %v", err)
	}
	if len(src.getCalls) != 1 {
		t.Fatalf("issued %d GET batches, want exactly 1", len(src.getCalls))
	}
	if len(src.getCalls[0]) != 2 {
		t.Errorf("GET batch = %v, want only the two get specs", src.getCalls[0])
	}
	if len(src.walkCalls) != 1 || src.walkCalls[0] != "1.3.6.1.2.1.43.11.1.1.9" {
		t.Errorf("walk calls = %v, want one walk of the supplies column", src.walkCalls)
	}
	if len(metrics) != 4 {
		t.Errorf("got %d metrics, want 2 scalars + 2 instances", len(metrics))
	}
}
```
Add `"strconv"` and `"strings"` to that file's imports.

- [ ] **Step 3: Watch it fail**

```bash
cd agent && go test -race ./internal/snmppoll/ -run 'TestWalkBounded|TestCollectWithSource_Walk|TestCollectWithSource_Poll|TestCollectWithSource_Byte|TestCollectWithSource_Unimplemented|TestCollectWithSource_Mixed'
```
Expected: `undefined: (*SNMPClient).WalkBounded` (build failure), then — once that compiles — `got 0 metrics, want 4` from the walk tests, because `collectWithSource` still routes every spec through `GetMulti`.

- [ ] **Step 4: Implement `WalkBounded`**

Append to `agent/internal/snmppoll/client.go`:

```go
// WalkBounded streams a GETBULK walk of rootOID, calling fn for each PDU, and
// stops the moment fn returns an error.
//
// Deliberately NOT BulkWalkAll (which Walk and BulkWalk above use): BulkWalkAll
// buffers the entire subtree before returning, so a caller that wants to cap
// rows, bytes or wall clock has already paid all three by the time it can look.
// A bound that only applies after the fact bounds nothing, and this walks
// customer hardware — an FDB table on a busy switch is unbounded in practice.
func (c *SNMPClient) WalkBounded(rootOID string, fn gosnmp.WalkFunc) error {
	if rootOID == "" {
		return errors.New("oid is required")
	}
	if c == nil || c.client == nil {
		return errors.New("SNMP client is not connected")
	}
	if fn == nil {
		return errors.New("walk callback is required")
	}
	return c.client.BulkWalk(rootOID, fn)
}
```

- [ ] **Step 5: Implement the bounded walk in `metrics.go`**

Replace the `getSpecs` loop in `collectWithSource` and add the walk machinery:

```go
// errWalkStop unwinds a walk from inside its callback once a bound is hit. It
// never escapes collectWalkSpec.
var errWalkStop = errors.New("snmppoll: walk bound reached")

// walkBudget carries the POLL-level bounds across every walk spec in one poll.
// Per-OID bounds live in collectWalkSpec; both are needed, because one runaway
// table and fifty modest ones fail differently.
type walkBudget struct {
	rows     int
	bytes    int
	deadline time.Time
	limits   PollLimits
}

func (b *walkBudget) exhausted(now time.Time) bool {
	return b.rows >= b.limits.MaxRowsPerPoll ||
		b.bytes >= b.limits.MaxBytesPerPoll ||
		!now.Before(b.deadline)
}

// jsonOverheadPerMetric is a flat allowance for the JSON keys, quoting and
// RFC3339 timestamp every row carries. metricByteSize is a safety valve, not an
// accounting ledger: it has to be cheap and to over- rather than under-estimate.
const jsonOverheadPerMetric = 96

func metricByteSize(m SNMPMetric) int {
	size := jsonOverheadPerMetric + len(m.OID) + len(m.BaseOID) + len(m.Instance) + len(m.Name) + len(m.Error)
	switch v := m.Value.(type) {
	case nil:
	case string:
		size += len(v)
	default:
		size += 20 // every numeric form serialises to at most 20 bytes
	}
	return size
}

// errorMetric builds a value-less row carrying a per-OID failure code.
func errorMetric(spec OIDSpec, instance, code string, stamp time.Time) SNMPMetric {
	oid := spec.OID
	if instance != "" {
		oid = spec.OID + "." + instance
	}
	return SNMPMetric{
		OID:       oid,
		BaseOID:   spec.OID,
		Instance:  instance,
		Name:      spec.Name,
		Value:     nil,
		Error:     code,
		Timestamp: stamp,
	}
}

// collectWalkSpec walks one spec, stopping at the first bound it hits.
func collectWalkSpec(src pduSource, spec OIDSpec, budget *walkBudget, stamp time.Time) (rows []SNMPMetric, truncated bool, err error) {
	perOID := 0
	specs := []OIDSpec{spec}

	walkErr := src.WalkBounded(spec.OID, func(pdu gosnmp.SnmpPDU) error {
		// Checked BEFORE the row is kept, so MaxRowsPerOID = 512 yields exactly
		// 512 rows and the 513th trips truncation.
		if perOID >= budget.limits.MaxRowsPerOID || budget.exhausted(time.Now()) {
			truncated = true
			return errWalkStop
		}
		metric := metricFromPDU(specs, pdu, stamp)
		rows = append(rows, metric)
		perOID++
		budget.rows++
		budget.bytes += metricByteSize(metric)
		return nil
	})
	if walkErr != nil && !errors.Is(walkErr, errWalkStop) {
		return rows, truncated, walkErr
	}
	return rows, truncated, nil
}
```

and the routing in `collectWithSource`:

```go
func collectWithSource(src pduSource, specs []OIDSpec, limits PollLimits, stamp time.Time) ([]SNMPMetric, error) {
	getSpecs := make([]OIDSpec, 0, len(specs))
	walkSpecs := make([]OIDSpec, 0, len(specs))
	for _, spec := range specs {
		if spec.Mode == ModeWalk {
			walkSpecs = append(walkSpecs, spec)
			continue
		}
		getSpecs = append(getSpecs, spec)
	}

	metrics := make([]SNMPMetric, 0, len(getSpecs)+len(walkSpecs))

	// All scalars in ONE GET, exactly as before.
	if len(getSpecs) > 0 {
		oids := make([]string, 0, len(getSpecs))
		for _, spec := range getSpecs {
			oids = append(oids, spec.OID)
		}
		pdus, err := src.GetMulti(oids)
		if err != nil {
			// Unchanged: a failed GET batch means the device did not answer at
			// all, which is a whole-poll transport failure, not a per-OID one.
			return nil, err
		}
		metrics = append(metrics, buildGetMetrics(getSpecs, pdus, stamp)...)
	}

	budget := &walkBudget{
		bytes:    totalMetricBytes(metrics),
		rows:     len(metrics),
		deadline: time.Now().Add(limits.MaxDuration),
		limits:   limits,
	}

	for _, spec := range walkSpecs {
		if budget.exhausted(time.Now()) {
			// Explicit, not omitted: a spec that never ran must not read as
			// "never polled" in the OID table.
			metrics = append(metrics, errorMetric(spec, "", ErrCodeTruncated, stamp))
			continue
		}

		rows, truncated, err := collectWalkSpec(src, spec, budget, stamp)
		metrics = append(metrics, rows...)

		switch {
		case err != nil:
			// Per-OID, not per-poll: one unimplemented or slow table must not
			// discard the scalars and the other columns that did answer. The
			// code set is closed, so the underlying error goes to the log.
			slog.Warn("SNMP walk failed", "oid", spec.OID, "name", spec.Name, "error", err)
			metrics = append(metrics, errorMetric(spec, "", ErrCodeTimeout, stamp))
		case truncated:
			metrics = append(metrics, errorMetric(spec, "", ErrCodeTruncated, stamp))
		case len(rows) == 0:
			// gosnmp's walk swallows NoSuchObject/NoSuchInstance/EndOfMibView
			// PDUs (v1.44.0 walk.go:129-133) without calling the callback, so a
			// table the device does not implement arrives here as zero rows and
			// a nil error. Emitting nothing would leave the server's per-OID
			// state stuck on never_polled forever.
			metrics = append(metrics, errorMetric(spec, "", ErrCodeNoSuchObject, stamp))
		}
	}

	return metrics, nil
}

func totalMetricBytes(metrics []SNMPMetric) int {
	total := 0
	for _, m := range metrics {
		total += metricByteSize(m)
	}
	return total
}
```
Add `"log/slog"` to the file's imports (the same logger `discovery/snmp.go` uses).

- [ ] **Step 6: Mark `GetTemplate` deprecated**

In `agent/internal/snmppoll/templates.go`, above `GetTemplate`:

```go
// GetTemplate returns a list of OIDs for the requested device type.
//
// Deprecated: not used in production — the server sends the device's template
// as `oids`/`oidSpecs` on every poll command (spec §7.1), and these hardcoded
// lists carry no mode or cadence, so wiring them in would GET table columns and
// reproduce the silent-null bug W02 exists to fix. Kept only as the offline
// fallback set a future disconnected mode would start from.
func GetTemplate(deviceType string) []string {
```

- [ ] **Step 7: Run green**

```bash
cd agent && go test -race ./internal/snmppoll/ ./internal/heartbeat/ ./internal/discovery/ ./internal/remote/tools/
```
Expected: all four packages pass. `discovery` matters here: it is the other `SNMPClient` consumer and must be unaffected.

- [ ] **Step 8: Commit**

```bash
git add agent/internal/snmppoll/client.go agent/internal/snmppoll/client_walkbounded_test.go \
        agent/internal/snmppoll/metrics.go agent/internal/snmppoll/metrics_specs_test.go agent/internal/snmppoll/templates.go
git commit -m "$(cat <<'EOF'
feat(agent/snmp): bounded BULK walks for table OIDs

Each `walk` spec gets its own streaming GETBULK walk through the new
SNMPClient.WalkBounded, bounded per OID and per poll on rows, bytes and wall
clock. Streaming rather than BulkWalkAll: a bound applied after the whole
subtree is buffered bounds nothing, and this runs against customer hardware.

A walk that hits a bound emits its collected rows plus one `truncated` row;
a walk that returns nothing emits one `noSuchObject` row, because gosnmp
swallows the NoSuchObject/EndOfMibView PDU without calling the callback and
an unimplemented table would otherwise be indistinguishable from an empty
one. A failing walk is per-OID, never per-poll.

Spec §7.4, §17.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: the result carries `protocol: 2`

**Files:**
- Modify: `agent/internal/heartbeat/handlers_network.go`
- Modify: `agent/internal/heartbeat/handlers_network_snmp_test.go`

**Interfaces:**
- Produces: `func snmpPollResultPayload(deviceID string, metrics []snmppoll.SNMPMetric) map[string]any` returning `{ "deviceId", "metrics", "protocol": 2 }`.

**Decision (unconditional).** `protocol: 2` is stamped on every successful poll result, including one produced from a legacy `oids`-only payload. Such a poll is all GETs and every row already carries `baseOid = spec.OID` and `instance = ""` — exactly the protocol-2 shape. Making the marker conditional on the payload would make the result shape a function of the *server's* version, which is the coupling the marker exists to remove.

- [ ] **Step 1: Write the test first**

Append to `agent/internal/heartbeat/handlers_network_snmp_test.go`:

```go
func TestSnmpPollResultPayload_StampsProtocol2(t *testing.T) {
	payload := snmpPollResultPayload("dev-1", []snmppoll.SNMPMetric{
		{OID: ".1.3.6.1.2.1.1.3.0", BaseOID: "1.3.6.1.2.1.1.3.0", Name: "sysUpTime", Value: 1},
	})

	if payload["protocol"] != 2 {
		t.Errorf("protocol = %v, want 2 — the server reads the row shape off this marker", payload["protocol"])
	}
	if payload["deviceId"] != "dev-1" {
		t.Errorf("deviceId = %v, want dev-1", payload["deviceId"])
	}
	metrics, ok := payload["metrics"].([]snmppoll.SNMPMetric)
	if !ok || len(metrics) != 1 {
		t.Fatalf("metrics = %v, want the one row passed in", payload["metrics"])
	}
}

func TestSnmpPollResultPayload_StampsProtocol2ForEmptyAndLegacyPolls(t *testing.T) {
	// A poll that collected nothing, and a poll built from a legacy oids-only
	// payload, both still declare the new row shape: the marker describes the
	// AGENT, not the command it happened to receive.
	if got := snmpPollResultPayload("dev-1", nil)["protocol"]; got != 2 {
		t.Errorf("protocol on an empty poll = %v, want 2", got)
	}
}

func TestSnmpPollResultPayload_KeysAreExactlyTheContract(t *testing.T) {
	payload := snmpPollResultPayload("dev-1", nil)
	for _, key := range []string{"deviceId", "metrics", "protocol"} {
		if _, ok := payload[key]; !ok {
			t.Errorf("result payload is missing %q", key)
		}
	}
	if len(payload) != 3 {
		t.Errorf("result payload has %d keys (%v), want exactly 3", len(payload), payload)
	}
}
```

- [ ] **Step 2: Watch it fail**

```bash
cd agent && go test -race ./internal/heartbeat/ -run TestSnmpPollResultPayload
```
Expected: `undefined: snmpPollResultPayload` (build failure).

- [ ] **Step 3: Implement**

In `agent/internal/heartbeat/handlers_network.go`:

```go
// SnmpResultProtocol marks the metric row shape this agent emits (spec §7.2):
// every row carries baseOid, instance and an optional per-OID error. The server
// treats a result with NO protocol field as the legacy shape (baseOid = oid,
// instance = ""), so this must be stamped on every successful poll — including
// one built from a legacy oids-only command, whose rows already have that shape.
const SnmpResultProtocol = 2

func snmpPollResultPayload(deviceID string, metrics []snmppoll.SNMPMetric) map[string]any {
	return map[string]any{
		"deviceId": deviceID,
		"metrics":  metrics,
		"protocol": SnmpResultProtocol,
	}
}
```
and in `handleSnmpPoll` replace the success return with:
```go
	return tools.NewSuccessResult(
		snmpPollResultPayload(tools.GetPayloadString(cmd.Payload, "deviceId", ""), metrics),
		time.Since(start).Milliseconds(),
	)
```

- [ ] **Step 4: Run green**

```bash
cd agent && go test -race ./internal/heartbeat/
```
Expected: pass, including `TestHandleSnmpPollRejectsOutOfRangePort` (the failure path returns before the result helper and carries no `protocol`, which is correct — a transport failure is still one top-level error, per spec §7.2).

- [ ] **Step 5: Commit**

```bash
git add agent/internal/heartbeat/handlers_network.go agent/internal/heartbeat/handlers_network_snmp_test.go
git commit -m "$(cat <<'EOF'
feat(agent/snmp): stamp protocol 2 on poll results

Every successful poll result declares the new row shape, including one built
from a legacy oids-only command: those rows already carry baseOid and an
empty instance, and making the marker conditional on the command would make
the result shape depend on the server's version — the exact coupling the
marker exists to remove.

Spec §7.2.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `classify.go` stops writing sysObjectID into `model`

**Files:**
- Modify: `agent/internal/discovery/classify.go`
- Modify: `agent/internal/discovery/classify_test.go`

**Interfaces:**
- Produces: `ClassifyAsset` returns `""` for model when no vendor rule matched, never a raw OID.
- Consumes: nothing new. The server owns identity from here: W01's read-time mask (`maskOidShapedModel`) and W03's `resolveAssetIdentity` cover both old and new agents.

- [ ] **Step 1: Rewrite the test first**

In `agent/internal/discovery/classify_test.go`, replace `TestClassifyAssetModelFromSNMPObjectID` (around line 369) with:

```go
func TestClassifyAssetDoesNotUseSysObjectIDAsModel(t *testing.T) {
	// A Xerox C325 rendered Model ".1.3.6.1.4.1.253.8.62.1.37.1.4.1.1" on the
	// device page (spec F5). The scanner does not know the model here, and
	// saying so is the honest answer — the server maps the enterprise number to
	// a vendor and a model, for old and new agents alike.
	tests := []struct {
		name        string
		sysObjectID string
	}{
		{"net-snmp enterprise OID", "1.3.6.1.4.1.8072.3.2.10"},
		{"Xerox enterprise OID", ".1.3.6.1.4.1.253.8.62.1.37.1.4.1.1"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			host := DiscoveredHost{
				IP:       "192.168.1.60",
				SNMPData: &SNMPInfo{SysObjectID: tt.sysObjectID},
			}
			if _, _, model := ClassifyAsset(host); model != "" {
				t.Fatalf("model = %q, want \"\" — a raw OID is a scanner internal, not a model", model)
			}
		})
	}
}

func TestClassifyAssetStillClassifiesTypeAndManufacturerFromSNMP(t *testing.T) {
	// Dropping the model assignment must not take the rest of the classifier
	// with it: sysDescr-driven manufacturer and type are unaffected.
	host := DiscoveredHost{
		IP: "192.168.1.61",
		SNMPData: &SNMPInfo{
			SysDescr:    "Cisco IOS Software, C3750 Software",
			SysObjectID: "1.3.6.1.4.1.9.1.516",
		},
	}
	assetType, manufacturer, model := ClassifyAsset(host)
	if manufacturer != "Cisco" {
		t.Errorf("manufacturer = %q, want Cisco", manufacturer)
	}
	if assetType == "" {
		t.Error("assetType is empty; classification must still run")
	}
	if model != "" {
		t.Errorf("model = %q, want \"\"", model)
	}
}
```

- [ ] **Step 2: Watch it fail**

```bash
cd agent && go test -race ./internal/discovery/ -run TestClassifyAsset
```
Expected: `model = "1.3.6.1.4.1.8072.3.2.10", want ""` — the assignment is still there.

- [ ] **Step 3: Implement**

In `agent/internal/discovery/classify.go`, delete these three lines (currently 45-47):

```go
	if model == "" && host.SNMPData != nil {
		model = strings.TrimSpace(host.SNMPData.SysObjectID)
	}
```

and replace them with:

```go
	// The sysObjectID is deliberately NOT used as a model. It is a scanner
	// internal — a Xerox C325 rendered Model ".1.3.6.1.4.1.253.8.62.1.37.1.4.1.1"
	// on the device page (spec F5). Identity resolution is the server's job
	// (services/discoveredAssetClassification.ts): it maps the IANA enterprise
	// number to a vendor and runs tested per-vendor model extractors, and it has
	// to do so for agents that predate this change anyway. An empty model here
	// means "unknown", which is the truth.
```

Then check whether `strings` is still used in the file — it is (every `strings.Contains` rule above and in `classifyType`), so the import stays. Confirm with `go build ./...`.

- [ ] **Step 4: Run green**

```bash
cd agent && go test -race ./internal/discovery/
```
Expected: pass. If another test asserts a non-empty model from sysObjectID, it is asserting the bug — update it to expect `""` and say so in the test name.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/discovery/classify.go agent/internal/discovery/classify_test.go
git commit -m "$(cat <<'EOF'
fix(agent/discovery): stop writing sysObjectID into the asset model

A Xerox C325 rendered Model ".1.3.6.1.4.1.253.8.62.1.37.1.4.1.1" on the
device page. The scanner does not know the model; the server does, from the
IANA enterprise number and per-vendor extractors, and has to for pre-W02
agents regardless. An empty model is the honest answer.

Spec §9.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Whole-wave verification and PR

**Files:** none modified (verification only), except any fix a step below forces.

**Interfaces:**
- Consumes: W01's protocol-2 ingestion (`processPollResults` in `apps/api/src/jobs/snmpWorker.ts` and its test file) — this task proves W02's output is shaped the way W01's input expects.

- [ ] **Step 1: Full agent suite, race on**

```bash
cd agent && go test -race ./...
```
Expected: pass. This is what **Test Agent (race)** runs.

- [ ] **Step 2: Vet and lint exactly as CI does**

```bash
cd agent && go vet ./...
cd agent && golangci-lint run --new-from-rev="origin/main" ./...
```
Expected: clean. **Lint Agent (Go)** pins golangci-lint v2.12.2 and runs new-issues-only against `origin/${BASE_REF}`; if the binary is missing locally, `go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.12.2`.

- [ ] **Step 3: Prove the agent's row shape against W01's ingestion**

Find W01's protocol-2 ingestion test and run it:

```bash
grep -rln "protocol" apps/api/src/jobs | grep snmp
cd apps/api && npx vitest run src/jobs/snmpWorker.test.ts
```
Expected: pass unchanged. If W01 named the file differently, run the file the grep found.

Then check the agent's actual JSON against the fields that ingestion reads, with a throwaway program in the scratchpad (not committed):

```bash
cat > /tmp/protocol2check/main.go <<'EOF'
package main

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/snmppoll"
)

func main() {
	b, _ := json.Marshal([]snmppoll.SNMPMetric{
		{OID: ".1.3.6.1.2.1.43.11.1.1.9.1.1", BaseOID: "1.3.6.1.2.1.43.11.1.1.9", Instance: "1.1",
			Name: "prtMarkerSuppliesLevel", Value: 37, Timestamp: time.Unix(0, 0).UTC()},
		{OID: "1.3.6.1.2.1.25.3.5.1.1", BaseOID: "1.3.6.1.2.1.25.3.5.1.1", Instance: "",
			Name: "hrPrinterStatus", Value: nil, Error: "noSuchObject", Timestamp: time.Unix(0, 0).UTC()},
	})
	fmt.Println(string(b))
}
EOF
```
Run it from the agent module (`cd agent && go run /tmp/protocol2check/main.go`) and confirm the output carries `"baseOid"`, `"instance"` (present even when empty) and `"error"` only on the error row, matching the spec §7.2 examples. Delete the file afterwards.

- [ ] **Step 4: API suites that touch the changed files**

```bash
cd apps/api && npx vitest run src/services/snmpOidSpecs.test.ts src/jobs/snmpWorker.oidSpecs.test.ts src/jobs/snmpQueue.test.ts src/jobs/snmpWorkerScheduler.test.ts src/jobs/snmpWorker.orgAuthority.test.ts src/jobs/snmpWorker.dbcontext.test.ts
cd apps/api && npx tsc --noEmit -p tsconfig.json
```
Expected: 6 files green, no type errors.

- [ ] **Step 5: Grep the compatibility contract**

```bash
# `oids` is built from the template in exactly one place and is never gated.
grep -n "template.oids as Array" apps/api/src/jobs/snmpWorker.ts
grep -n "selectOidSpecsForSeq" apps/api/src/jobs/snmpWorker.ts
# The agent reads `oids` only through the legacy helper, never as specs.
grep -rn "GetPayloadStringSlice(payload, \"oids\")\|GetPayloadStringSlice(cmd.Payload, \"oids\")" agent/internal
# No stray protocol marker anywhere else.
grep -rn "\"protocol\"" agent/internal/heartbeat
```
Expected: `selectOidSpecsForSeq` appears only inside `buildSnmpPollCommand`; the `oids` mapping line is unchanged from `git show origin/main:apps/api/src/jobs/snmpWorker.ts`; `protocol` appears only in `snmpPollResultPayload`.

- [ ] **Step 6: Open the PR**

```bash
git push -u origin feature/<parent#>-network-device-page-truth/wave-<W02 sub-issue#>
gh pr create --base <W01 branch or main, whichever this is stacked on> --title "feat(snmp): agent acquisition — oidSpecs, bounded walks, per-OID errors (W02)" --body "$(cat <<'EOF'
Wave W02 of the Network Device Page Truth feature. Spec §7.1, §7.2, §7.4, §9, §15, §17.

Closes #<W02 sub-issue#>

## What ships

- `services/snmpOidSpecs.ts`: `buildOidSpecs` / `selectOidSpecsForSeq` / `POLL_LIMITS` / `SLOW_CADENCE_EVERY`. Mode defaults from the OID's trailing `.0`, never from the entry's `type` (the seed has 36 counter64, 22 counter and 6 string entries that are table columns).
- `buildSnmpPollCommand` adds `oidSpecs` + `limits`; `markPollDispatched` advances `snmp_devices.poll_seq` so `slow` specs ride one dispatch in twelve.
- Agent: `oidSpecs`/`limits` parsing with a legacy `oids`-as-GET fallback; `SNMPMetric` gains `BaseOID`/`Instance`/`Error`; unsupported OIDs become explicit error rows; each `walk` spec gets a streaming, bounded BULK walk; results stamp `protocol: 2`.
- `classify.go` stops writing sysObjectID into `model`.

## Wire compatibility

`oids: string[]` is byte-for-byte unchanged — same list, same order, never cadence-gated — so every agent in the field behaves exactly as before. Absence of `protocol` on a result still means the legacy row shape. Tests assert both directions.

## Verification

- `cd agent && go test -race ./...`, `go vet ./...`, `golangci-lint run --new-from-rev=origin/main ./...`
- `cd apps/api && npx vitest run src/services/snmpOidSpecs.test.ts src/jobs/snmpWorker.oidSpecs.test.ts src/jobs/snmpQueue.test.ts src/jobs/snmpWorkerScheduler.test.ts src/jobs/snmpWorker.orgAuthority.test.ts src/jobs/snmpWorker.dbcontext.test.ts`
- `cd apps/api && npx tsc --noEmit`
- W01's protocol-2 ingestion test run unchanged against this agent's row shape.

## Not in this wave

No migration (W01 owns `poll_seq`). Template `mode`/`cadence` seeding and the Xerox template are W03; the printer Health card that renders the new supply rows is W05. Until W03 seeds `cadence: slow`, every spec is `fast` and the cadence gate is inert — by design, and asserted by the "all-slow falls back to the full set" test.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 7: Dispatch CI for the branch**

```bash
gh workflow run CI --ref feature/<parent#>-network-device-page-truth/wave-<W02 sub-issue#>
```
Required if this PR targets W01's branch rather than `main`: `ci.yml` triggers on `pull_request: branches: [main]`, so a stacked PR gets no run at all and `gh pr checks` reads green on nothing. If the PR targets `main` (W01 already merged), skip this — the `pull_request` run already covers it.

- [ ] **Step 8: PR checklist before requesting review**

- [ ] `oids` diff is additive only — `git diff origin/main -- apps/api/src/jobs/snmpWorker.ts` shows no change to the `template.oids.map` line.
- [ ] No new migration file in `apps/api/migrations/`.
- [ ] No table registration needed: W02 adds no column and no table (the export-policy and cascade lists are W01's concern for `poll_seq`).
- [ ] Every Go behaviour change has a test that was red first.
- [ ] `agent/internal/snmppoll` tests make zero network calls (`grep -n "NewClient\|net.Dial" agent/internal/snmppoll/*_test.go` returns only the pre-existing `TestNewClient_*` guard-clause tests).
- [ ] `GetTemplate` is deprecated-annotated, not deleted, and `templates_test.go` still passes.
