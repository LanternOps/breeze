---
tracking_issue: LanternOps/breeze#5988
---
# Network Device Page Truth W03: Templates and Identity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the SNMP template being a manual guess and stop the device page showing scanner internals as identity. A `sys_object_id_prefixes text[]` column on `snmp_templates`, seeded with IANA-verified enterprise prefixes on every built-in, drives a boundary-aware `suggestTemplate` service behind `GET /monitoring/templates/suggest` and behind `PUT /monitoring/assets/:id/snmp` when the caller omits `templateId`. A new `ianaEnterprise.ts` code table plus vendor-family model extractors in `assetIdentity.ts` resolve manufacturer and model server-side at scan ingest, so a Xerox C325 reads `Xerox` / `Xerox(R) C325 Color MFP` instead of `LEXMARK INTERNATIONAL, INC.` / `.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1` (spec F5).

**Architecture:** One idempotent DDL+DML migration adds the column, inserts the "Xerox Printer" built-in, seeds prefixes by template name, and rewrites the built-ins' `oids` jsonb with explicit `mode` / `cadence` keys that W02's `buildOidSpecs` consumes. Two new pure-ish services — `services/ianaEnterprise.ts` (no I/O) and `services/snmpTemplateSuggest.ts` (one indexed read) — are the only new logic. `services/assetIdentity.ts` (created by W01) gains `resolveAssetIdentity`, called from one place in `jobs/discoveryWorker.ts`'s `processResults`; the existing manual-precedence guards in `buildScanUpdateSet` are untouched and re-asserted.

**Tech Stack:** PostgreSQL + hand-written SQL migration (jsonb rewrites, `text[]`), Drizzle ORM, Hono + Zod, Vitest (API unit with Drizzle mocks; API integration on real Postgres).

**Spec:** `docs/superpowers/specs/monitoring/2026-09-16-network-device-page-truth-design.md` (approved 2026-09-16). This wave implements **§8** (prefix column, suggestion service + route, PUT behaviour, Xerox built-in, printer `mode`/`cadence`), **§9** (identity resolution at ingest), the §13 row for `snmp_templates`, and the §15 lines for boundary matching and per-vendor fixtures. It does **not** touch §7.1's `buildOidSpecs` / wire contract (W02 owns that; W03 only seeds the jsonb keys it reads) and does not touch the agent (`classify.go`'s one-line change is W02's).

Where this plan is more specific than the spec, the plan wins; each such decision is called out inline under **Decision:**.

---

## Global Constraints

- **Migration name is reserved by the index:** `apps/api/migrations/2026-10-17-110300-snmp-templates-prefixes-modes-xerox.sql`. Before the commit in Task 2, re-check the ceiling:
  ```bash
  ls apps/api/migrations | grep '\.sql$' | sort | tail -1
  ```
  As of 2026-09-16 the newest committed is `2026-10-16-193300-software-deployments-policy-origin.sql`, so the reserved name sorts after. If main has moved past it, rename **upward** (keep the `-1103xx-` slot family) and sweep every reference to the old path — `apps/api/src/db/autoMigrate.test.ts` asserts that every `readFileSync`/`replayMigration` reference resolves.
- **The migration writes rows, so it elects system scope FIRST.** `SELECT set_config('breeze.scope', 'system', true);` is statement 1 of the file, before any `INSERT`/`UPDATE`. `snmp_templates` is `FORCE ROW LEVEL SECURITY` and its INSERT/UPDATE policies only admit built-in rows under `breeze_current_scope() = 'system' AND org_id IS NULL` (`apps/api/migrations/2026-05-02-snmp-secret-hardening.sql`), so without the election the `UPDATE`s match **zero rows silently** and the `INSERT` aborts with 42501. Enforced statically by `apps/api/src/db/migrationRlsScope.test.ts` (**Test API**) — never add this file to that baseline.
- **Idempotency:** `ADD COLUMN IF NOT EXISTS`; the Xerox insert is guarded by `IF NOT EXISTS (… WHERE name = 'Xerox Printer' AND is_built_in = true)` (the house pattern from `2026-05-22-snmp-multi-vendor-templates.sql`); the prefix seed carries `AND sys_object_id_prefixes = '{}'`; each jsonb rewrite carries an `EXISTS (… WHERE NOT (entry ? '<key>'))` guard. Re-applying the whole file must be a no-op. No inner `BEGIN;`/`COMMIT;` — `autoMigrate` wraps each file.
- **Every `UPDATE` reports its row count** via `GET DIAGNOSTICS n = ROW_COUNT; RAISE NOTICE …`, per CLAUDE.md's cleanup-statement rule.
- **Never edit a shipped migration.** `2026-05-22-snmp-multi-vendor-templates.sql` and `2026-05-22-unifi-snmp-templates.sql` are content-hash immutable; the new file fixes forward.
- **Export policy is the same task as the migration.** `snmp_templates` is already in `CORE_ORG_CASCADE_DELETE_ORDER`, so adding a **column** fires `CORE_TENANT_EXPORT_POLICY` (`apps/api/src/services/tenantExportPolicyRegistry.ts:550`). `sys_object_id_prefixes` is a list of public OID prefixes — not a capability, not an open container — so it is `included`. No new table ⇒ **no RLS-policy change, no cascade-list change, no `orgMergeRegistry` change, no `DUAL_AXIS_TENANT_TABLES` / partner-wide branch** (`snmp_templates` has no `partner_id`). Verify, do not assume:
  ```bash
  grep -rn 'snmp_templates' apps/api/src/services/tenantCascade.ts apps/api/src/routes/devices/core.ts apps/api/src/services/orgMergeRegistry.ts
  ```
- **Run one test file** as `cd apps/api && npx vitest run <path>`. Never `pnpm --filter @breeze/api test -- --run <path>` (the `--` is swallowed and the whole 1,470-file suite runs in watch mode). A trailing-slash or `*` path filter silently skips siblings — list dotted siblings explicitly.
- **Integration suites before the PR** (they need real Postgres; `pnpm test-stack up` for a per-worktree copy, `pnpm test-stack down` when finished):
  ```bash
  cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy src/__tests__/integration/tenantExportErasureRoundtrip src/__tests__/integration/snmpTemplateSuggest
  ```
- **W01 is a hard dependency.** `apps/api/src/services/assetIdentity.ts` (`maskOidShapedModel`, `nicVendorFromMac`) and its test file are created by W01; this wave **extends** both. Branch off W01's branch, not main, until W01 merges. **Use `Edit`, never `Write`, on `assetIdentity.ts` and `assetIdentity.test.ts`** — a `Write` on an existing test file clobbers W01's cases silently.
- **Stacked-branch CI:** `ci.yml` triggers on `pull_request: branches: [main]`, so a PR based on W01's branch gets **no CI run at all** and `gh pr checks` reads green. Dispatch per branch before enqueueing: `gh workflow run CI --ref <branch>`.
- **Branch / PR / commits.** Branch `feature/<parent#>-network-device-page-truth/wave-<W03 sub-issue#>`. PR body contains `Closes #<W03 sub-issue#>`. One commit per task, message ending with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  ```
- **Schema drift:** after Task 2, `export DATABASE_URL=… && pnpm db:migrate && pnpm db:check-drift` must be clean.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/src/services/ianaEnterprise.ts` (+ `.test.ts`) | `IANA_ENTERPRISE_VENDORS`, `enterpriseNumberFromSysObjectId`, `vendorFromSysObjectId` |
| `apps/api/migrations/2026-10-17-110300-snmp-templates-prefixes-modes-xerox.sql` | column, Xerox built-in, prefix seed, `mode`/`cadence` jsonb rewrite |
| `apps/api/src/db/schema/snmp.ts` | `snmpTemplates.sysObjectIdPrefixes` |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | `snmp_templates` → `sys_object_id_prefixes` in `included` |
| `apps/api/src/routes/snmp.ts` | `oidSchema` accepts optional `mode` / `cadence` |
| `apps/api/src/services/snmpTemplateSuggest.ts` (+ `.test.ts`) | `normalizeOid`, `oidHasPrefix`, `suggestTemplate` |
| `apps/api/src/routes/monitoring.ts` | `GET /templates/suggest`; `PUT /assets/:id/snmp` suggestion application + `templateSuggestion` echo |
| `apps/api/src/routes/monitoring_templates_suggest.test.ts` | new route tests (Drizzle mocks) |
| `apps/api/src/routes/monitoring_assets_snmp.test.ts` | **extend** — PUT suggestion behaviour, PATCH null-as-unset regression |
| `apps/api/src/services/assetIdentity.ts` (+ `.test.ts`) | **extend (W01 file)** — `resolveAssetIdentity` + vendor rules + model extractors |
| `apps/api/src/jobs/discoveryWorker.ts` | `resolveScanIdentity` helper; call it in `processResults` |
| `apps/api/src/jobs/discoveryWorker.identity.test.ts` | pure identity-at-ingest unit tests + manual-guard re-assertion |
| `apps/api/src/__tests__/integration/snmpTemplateSuggest.integration.test.ts` | migration replay/idempotency, seed assertions, boundary + org scoping under RLS, ingest wiring, manual precedence |

---

### Task 1: `services/ianaEnterprise.ts` — IANA enterprise number → vendor

**Files:**
- Create: `apps/api/src/services/ianaEnterprise.ts`
- Create: `apps/api/src/services/ianaEnterprise.test.ts`

**Interfaces:**
- `export const IANA_ENTERPRISE_VENDORS: Readonly<Record<number, string>>`
- `export function enterpriseNumberFromSysObjectId(oid: string | null | undefined): number | null`
- `export function vendorFromSysObjectId(oid: string | null | undefined): string | null`
- `export const GENERIC_AGENT_ENTERPRISE_NUMBERS: ReadonlySet<number>`

**Decision (stated inline, spec was silent):** PEN **8072 (net-snmp)** stays in `IANA_ENTERPRISE_VENDORS` — it is a real registration and the template suggester needs it — but it is also listed in `GENERIC_AGENT_ENTERPRISE_NUMBERS`, which `resolveAssetIdentity` (Task 5) skips. "net-snmp" is an SNMP daemon, not a hardware manufacturer; surfacing it as `Manufacturer` would re-create exactly the F5 class of defect (a scanner internal presented as identity). The OUI vendor / sysDescr rules answer for those hosts instead.

**Decision:** every number below was verified on 2026-09-15 against the live IANA registry (`https://www.iana.org/assignments/enterprise-numbers.txt`, "last updated 2026-09-15"). The comment on each line is the **registrant string as IANA prints it**, so a future reader can re-verify with one grep. Nothing here is guessed; there are no `unverified:` entries.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/ianaEnterprise.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  GENERIC_AGENT_ENTERPRISE_NUMBERS,
  IANA_ENTERPRISE_VENDORS,
  enterpriseNumberFromSysObjectId,
  vendorFromSysObjectId,
} from './ianaEnterprise';

describe('enterpriseNumberFromSysObjectId', () => {
  it('parses the Xerox C325 sysObjectID, leading dot and all (spec F5)', () => {
    expect(enterpriseNumberFromSysObjectId('.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1')).toBe(253);
  });

  it('parses without a leading dot and tolerates surrounding whitespace', () => {
    expect(enterpriseNumberFromSysObjectId('  1.3.6.1.4.1.641.2.1  ')).toBe(641);
  });

  it('accepts the bare enterprise arc itself', () => {
    expect(enterpriseNumberFromSysObjectId('1.3.6.1.4.1.2435')).toBe(2435);
  });

  it('tolerates a trailing dot', () => {
    expect(enterpriseNumberFromSysObjectId('1.3.6.1.4.1.9.1.516.')).toBe(9);
  });

  it('strips leading zeros rather than mismatching on them', () => {
    expect(enterpriseNumberFromSysObjectId('1.3.6.1.4.1.0253.1')).toBe(253);
  });

  it.each([
    ['the enterprise arc with no PEN', '1.3.6.1.4.1'],
    ['a MIB-2 scalar', '1.3.6.1.2.1.1.1.0'],
    ['a non-numeric component', '1.3.6.1.4.1.abc.1'],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a PEN beyond the safe integer range', '1.3.6.1.4.1.99999999999999999999.1'],
  ])('returns null for %s', (_label, oid) => {
    expect(enterpriseNumberFromSysObjectId(oid)).toBeNull();
  });

  it.each([null, undefined, 42 as unknown as string])('returns null for non-string input %s', (value) => {
    expect(enterpriseNumberFromSysObjectId(value as string | null | undefined)).toBeNull();
  });
});

describe('vendorFromSysObjectId', () => {
  it.each([
    ['.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1', 'Xerox'],
    ['1.3.6.1.4.1.641.2.1.2.1.5.1', 'Lexmark'],
    ['1.3.6.1.4.1.2435.2.3.9.1', 'Brother'],
    ['1.3.6.1.4.1.11.2.3.9.1', 'HP'],
    ['1.3.6.1.4.1.9.1.516', 'Cisco'],
    ['1.3.6.1.4.1.318.1.3.27', 'APC'],
  ])('%s resolves to %s', (oid, vendor) => {
    expect(vendorFromSysObjectId(oid)).toBe(vendor);
  });

  it('is null for a PEN that is real but not in the table', () => {
    // 20682 = "Campusmart Ltd." — a genuine registration we deliberately do not carry.
    expect(enterpriseNumberFromSysObjectId('1.3.6.1.4.1.20682.1')).toBe(20682);
    expect(vendorFromSysObjectId('1.3.6.1.4.1.20682.1')).toBeNull();
  });

  it('does not confuse the boundary neighbours 25 and 253', () => {
    expect(enterpriseNumberFromSysObjectId('1.3.6.1.4.1.25.1')).toBe(25);
    expect(vendorFromSysObjectId('1.3.6.1.4.1.25.1')).toBeNull();
  });
});

describe('IANA_ENTERPRISE_VENDORS table integrity', () => {
  it('has only positive safe-integer keys and trimmed non-empty values', () => {
    for (const [key, value] of Object.entries(IANA_ENTERPRISE_VENDORS)) {
      const pen = Number(key);
      expect(Number.isSafeInteger(pen)).toBe(true);
      expect(pen).toBeGreaterThan(0);
      expect(value).toBe(value.trim());
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it('carries every vendor the built-in template prefixes are seeded with', () => {
    // Mirrors the seed list in 2026-10-17-110300-…; a PEN dropped from one side
    // must be dropped from the other.
    for (const pen of [
      9, 11, 232, 253, 318, 367, 534, 641, 674, 1248, 1347, 1602, 2385, 2435, 2636,
      3808, 4526, 6574, 6876, 8072, 8741, 10642, 10876, 11863, 12356, 14823, 14988,
      15446, 18334, 19046, 24681, 25053, 29671, 41112, 47196, 50919, 53869, 55062,
    ]) {
      expect(IANA_ENTERPRISE_VENDORS[pen], `PEN ${pen}`).toBeTruthy();
    }
  });

  it('marks net-snmp as a generic agent PEN, not a hardware vendor', () => {
    expect(GENERIC_AGENT_ENTERPRISE_NUMBERS.has(8072)).toBe(true);
    expect(GENERIC_AGENT_ENTERPRISE_NUMBERS.has(253)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/ianaEnterprise.test.ts
```

Expected: `Error: Failed to load url ./ianaEnterprise` / "Cannot find module" — the module does not exist yet.

- [ ] **Step 3: Implement**

Create `apps/api/src/services/ianaEnterprise.ts`:

```ts
/**
 * IANA Private Enterprise Number (PEN) → vendor name (spec §9, decision D6).
 *
 * WHY THIS EXISTS. `agent/internal/discovery/classify.go` writes
 * `model = sysObjectID` when it knows nothing better, and the manufacturer
 * falls back to the MAC OUI vendor. A Xerox C325 has a Lexmark-built engine
 * (OUI "LEXMARK INTERNATIONAL, INC.") and a sysObjectID under enterprise 253
 * (Xerox), so the device page rendered Model
 * `.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1` and Manufacturer `LEXMARK …` — spec F5.
 * The enterprise arc of the sysObjectID is the ONE identity signal that is
 * assigned rather than inferred, so it outranks every heuristic below it.
 *
 * VERIFICATION. Every number here was read out of the live IANA registry
 * (https://www.iana.org/assignments/enterprise-numbers.txt, "last updated
 * 2026-09-15") on 2026-09-15; the trailing comment is the registrant string
 * exactly as IANA prints it, so any entry can be re-verified with:
 *
 *   curl -s https://www.iana.org/assignments/enterprise-numbers.txt \
 *     | grep -A1 -x '253'
 *
 * Adding an entry WITHOUT that check is prohibited: a wrong PEN silently
 * mislabels every device of that vendor (spec §17, "Enterprise-number errors").
 * Only the ROOT arc is registered with IANA — product sub-arcs
 * (1.3.6.1.4.1.674.10892.x for Dell iDRAC, say) are vendor-MIB knowledge and
 * are deliberately NOT encoded here or in the template prefix seed.
 */

export const IANA_ENTERPRISE_VENDORS: Readonly<Record<number, string>> = Object.freeze({
  9: 'Cisco',              // ciscoSystems
  11: 'HP',                // Hewlett-Packard  (LaserJet, ProCurve / ArubaOS-Switch)
  232: 'HP',               // Compaq           (the arc HP ProLiant / iLO still reports under)
  253: 'Xerox',            // Xerox
  318: 'APC',              // American Power Conversion Corp.
  367: 'Ricoh',            // RICOH Co. Ltd.
  534: 'Eaton',            // Eaton Corporation
  641: 'Lexmark',          // Lexmark International
  674: 'Dell',             // Dell Inc.
  1248: 'Epson',           // SEIKO EPSON CORPORATION
  1347: 'Kyocera',         // KYOCERA Corporation
  1602: 'Canon',           // CANON Inc.
  2385: 'Sharp',           // SHARP Corporation
  2435: 'Brother',         // Brother Industries, Ltd.
  2636: 'Juniper',         // Juniper Networks, Inc.
  3808: 'CyberPower',      // Cyber Power System Inc.      (the UPS arc)
  4526: 'Netgear',         // Netgear
  6574: 'Synology',        // Synology Inc.
  6876: 'VMware',          // VMware Inc.
  8072: 'net-snmp',        // net-snmp  — see GENERIC_AGENT_ENTERPRISE_NUMBERS
  8741: 'SonicWall',       // SonicWALL, Inc.
  10642: 'Zebra',          // Zebra Technologies Corporation
  10876: 'Supermicro',     // Super Micro Computer Inc.
  11863: 'TP-Link',        // TP-Link Systems Inc.
  12356: 'Fortinet',       // Fortinet, Inc.
  14823: 'Aruba',          // Aruba, a Hewlett Packard Enterprise company
  14988: 'MikroTik',       // MikroTik
  15446: 'CyberPower',     // CyberPower Systems, Inc.     (second registration)
  18334: 'Konica Minolta', // KONICA MINOLTA HOLDINGS, INC.
  19046: 'Lenovo',         // Lenovo Enterprise Business Group
  24681: 'QNAP',           // QNAP SYSTEMS, INC
  25053: 'Ruckus',         // Ruckus Wireless, Inc.
  29671: 'Meraki',         // Meraki Networks, Inc.
  41112: 'Ubiquiti',       // Ubiquiti Networks, Inc.
  47196: 'HPE',            // Hewlett Packard Enterprise
  50919: 'Konica Minolta', // KONICA MINOLTA, INC.         (second registration)
  53869: 'OPNsense',       // OPNsense
  55062: 'QNAP',           // QNAP Systems, Inc.           (second registration)
});

/**
 * PENs that identify the SNMP AGENT rather than the hardware vendor.
 *
 * pfSense, OPNsense and every Linux box running net-snmpd report 8072, which
 * says nothing about who made the box. `resolveAssetIdentity` skips these so
 * the sysDescr rules or the NIC OUI answer instead — surfacing "net-snmp" as a
 * Manufacturer would be the same class of defect as F5. The number stays in the
 * table above because the TEMPLATE suggester legitimately matches on it.
 */
export const GENERIC_AGENT_ENTERPRISE_NUMBERS: ReadonlySet<number> = new Set([8072]);

/** `1.3.6.1.4.1` — iso.org.dod.internet.private.enterprise. */
const ENTERPRISE_ROOT = ['1', '3', '6', '1', '4', '1'] as const;

/** Split an OID into components, dropping leading/trailing dots and leading zeros. */
function oidComponents(oid: string): string[] | null {
  const trimmed = oid.trim().replace(/^\.+/, '').replace(/\.+$/, '');
  if (!trimmed) return null;
  const parts = trimmed.split('.');
  const out: string[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    out.push(part.replace(/^0+(?=\d)/, ''));
  }
  return out;
}

/**
 * The enterprise number of a sysObjectID, or null when the OID is not under
 * `1.3.6.1.4.1.<PEN>` at all (a MIB-2 scalar, a malformed string, the bare arc).
 * A well-formed but unregistered PEN is RETURNED — this is a parser, not a
 * lookup; `vendorFromSysObjectId` is the lookup.
 */
export function enterpriseNumberFromSysObjectId(oid: string | null | undefined): number | null {
  if (typeof oid !== 'string') return null;
  const parts = oidComponents(oid);
  if (!parts || parts.length <= ENTERPRISE_ROOT.length) return null;
  for (let i = 0; i < ENTERPRISE_ROOT.length; i += 1) {
    if (parts[i] !== ENTERPRISE_ROOT[i]) return null;
  }
  const value = Number(parts[ENTERPRISE_ROOT.length]);
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

/** Vendor name for a sysObjectID, or null when the PEN is absent or unknown. */
export function vendorFromSysObjectId(oid: string | null | undefined): string | null {
  const pen = enterpriseNumberFromSysObjectId(oid);
  if (pen === null) return null;
  return IANA_ENTERPRISE_VENDORS[pen] ?? null;
}
```

- [ ] **Step 4: Run it green**

```bash
cd apps/api && npx vitest run src/services/ianaEnterprise.test.ts
```

Expected: 1 file, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ianaEnterprise.ts apps/api/src/services/ianaEnterprise.test.ts
git commit -m "$(cat <<'EOF'
feat(api): IANA enterprise number to vendor code table

Every PEN verified against the live IANA registry (enterprise-numbers.txt,
last updated 2026-09-15); the registrant string is quoted on each line so
entries can be re-verified with one grep. net-snmp (8072) is flagged as a
generic agent PEN so identity resolution skips it.

Refs #<parent> (W03, spec §9)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Migration, schema, export policy — prefixes, Xerox built-in, `mode`/`cadence`

**Files:**
- Create: `apps/api/migrations/2026-10-17-110300-snmp-templates-prefixes-modes-xerox.sql`
- Modify: `apps/api/src/db/schema/snmp.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts`
- Modify: `apps/api/src/routes/snmp.ts`

**Interfaces:**
- Produces: column `snmp_templates.sys_object_id_prefixes text[] NOT NULL DEFAULT '{}'`; built-in template row `name = 'Xerox Printer'`; `mode` on every built-in **printer** template OID entry; `cadence: 'slow'` on the §7.1 static-descriptor entries across all built-ins.
- Drizzle: `snmpTemplates.sysObjectIdPrefixes: text('sys_object_id_prefixes').array().notNull().default(sql\`'{}'::text[]\`)`.
- Zod: `oidSchema` gains `mode: z.enum(['get','walk']).optional()`, `cadence: z.enum(['fast','slow']).optional()`.

**Decision (spec ambiguity, §8 vs §7.1):** §8 says "All printer templates' table entries get `mode: walk`"; §7.1's slow list includes `ifDescr` / `ifName` / `ifSpeed`, which live in *switch* templates. Resolution: write explicit **`mode` on built-in printer templates only** (minimal blast radius — W02's `buildOidSpecs` derives the identical value for every other built-in from the `.0` rule, so an explicit write there would add nothing), and write **`cadence: 'slow'` on the §7.1 names wherever they appear in any built-in**, which is what §7.1 actually asks for.

**Decision:** the Xerox template's `oids` are written as a **literal** JSON array (the RFC 3805 set with `mode`/`cadence` already baked in) rather than copied from the `Generic Printer (RFC 3805)` row. A `SELECT oids FROM …` copy would silently inherit whatever state that row is in on the target database; a literal is deterministic and keeps the two templates independently editable.

**Decision:** `oidSchema` in `routes/snmp.ts` is a non-strict `z.object`, so a custom template POSTed with `mode`/`cadence` currently has them **silently stripped**. Adding the two optional enum fields is in scope here: the seed introduces the keys, and an org-owned template must be able to carry them too.

- [ ] **Step 1: Write the failing schema/export-policy assertion first**

The export-policy contract needs a live DB, so add a cheap unit-level guard that fails now and passes after the registry edit. Append to `apps/api/src/services/ianaEnterprise.test.ts`? No — put it where it belongs, in a new assertion inside the existing registry-adjacent unit test. Create `apps/api/src/services/tenantExportPolicySnmpTemplates.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CORE_TENANT_EXPORT_POLICY } from './tenantExportPolicyRegistry';
import { snmpTemplates } from '../db/schema';

/**
 * The export-policy registry is the ONE registration list that fires on a new
 * COLUMN rather than a new table, and its own contract suites
 * (tenant-export-policy / tenantExportErasureRoundtrip) only run under
 * Integration Tests — a unit-green PR still reddens main there. This mirrors
 * the column set statically so the miss shows up in Test API instead.
 */
describe('snmp_templates export policy covers every column', () => {
  it('classifies each Drizzle column', () => {
    const policy = CORE_TENANT_EXPORT_POLICY['snmp_templates'];
    expect(policy).toBeDefined();
    const dbColumns = Object.values(snmpTemplates)
      .filter((c): c is { name: string } => typeof (c as { name?: unknown }).name === 'string')
      .map((c) => c.name);
    for (const column of dbColumns) {
      expect(Object.keys(policy!.columns), `unclassified column ${column}`).toContain(column);
    }
    expect(policy!.columns['sys_object_id_prefixes']?.decision).toBe('include');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/tenantExportPolicySnmpTemplates.test.ts
```

Expected: the `toContain('sys_object_id_prefixes')` assertion fails *after* Step 3 adds the Drizzle column — so run it again after Step 3 and before Step 5. Right now it passes vacuously (the column does not exist yet); that is the point of doing Step 3 next.

- [ ] **Step 3: Add the Drizzle column, then re-run Step 2 and watch it fail**

In `apps/api/src/db/schema/snmp.ts`, import `sql` and add the column to `snmpTemplates`:

```ts
import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, integer, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
```

```ts
export const snmpTemplates = pgTable('snmp_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  vendor: varchar('vendor', { length: 100 }),
  deviceType: varchar('device_type', { length: 100 }),
  oids: jsonb('oids').notNull(),
  // Enterprise sysObjectID prefixes this template claims, e.g.
  // {'1.3.6.1.4.1.253'} for Xerox (spec §8). Matching is component-boundary
  // aware in services/snmpTemplateSuggest.ts — '1.3.6.1.4.1.25' must never
  // match a '1.3.6.1.4.1.253…' device.
  sysObjectIdPrefixes: text('sys_object_id_prefixes').array().notNull().default(sql`'{}'::text[]`),
  isBuiltIn: boolean('is_built_in').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  orgIdIdx: index('snmp_templates_org_id_idx').on(table.orgId)
}));
```

```bash
cd apps/api && npx vitest run src/services/tenantExportPolicySnmpTemplates.test.ts
```

Expected failure: `unclassified column sys_object_id_prefixes` — `expected [ …, 'created_at' ] to contain 'sys_object_id_prefixes'`.

- [ ] **Step 4: Write the migration**

Create `apps/api/migrations/2026-10-17-110300-snmp-templates-prefixes-modes-xerox.sql`:

```sql
-- SNMP template sysObjectID prefixes, acquisition modes, and the Xerox built-in.
-- Spec: docs/superpowers/specs/monitoring/2026-09-16-network-device-page-truth-design.md
--       §8 (template selection, Xerox alias), §7.1 (mode/cadence), §13 (data changes).
--
-- SYSTEM SCOPE IS ELECTED FIRST AND IT IS LOAD-BEARING. snmp_templates is
-- FORCE ROW LEVEL SECURITY; its INSERT/UPDATE policies
-- (2026-05-02-snmp-secret-hardening.sql) admit a built-in row only under
-- `breeze_current_scope() = 'system' AND org_id IS NULL`. Without this line the
-- UPDATEs below match ZERO rows silently (the RAISE NOTICE prints a truthful
-- looking 0) and the INSERT aborts with 42501. `is_local => true` scopes it to
-- autoMigrate's per-file transaction. Enforced by
-- apps/api/src/db/migrationRlsScope.test.ts.
--
-- Idempotent throughout: re-applying this file is a no-op. Every prefix below
-- is an IANA Private Enterprise Number verified against
-- https://www.iana.org/assignments/enterprise-numbers.txt (last updated
-- 2026-09-15); the registrant string is quoted on each line. Only ROOT arcs are
-- seeded — product sub-arcs are not IANA-assigned and are left to the
-- device_type tie-break in services/snmpTemplateSuggest.ts.

SELECT set_config('breeze.scope', 'system', true);

-- ---------------------------------------------------------------------------
-- 1. Column
-- ---------------------------------------------------------------------------
ALTER TABLE snmp_templates
  ADD COLUMN IF NOT EXISTS sys_object_id_prefixes text[] NOT NULL DEFAULT '{}';

-- ---------------------------------------------------------------------------
-- 2. New built-in: Xerox Printer (spec D5 / §8)
--    The Generic Printer (RFC 3805) OID set, written literally so this row does
--    not inherit whatever state the Generic row is in, with mode/cadence baked
--    in. Scalars end in `.0` and are GETs; every Printer-MIB / HOST-RESOURCES
--    column is a WALK (a GET on a column OID returns noSuchObject — spec F3).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM snmp_templates WHERE name = 'Xerox Printer' AND is_built_in = true) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in, sys_object_id_prefixes)
    VALUES (
      NULL, 'Xerox Printer',
      'Xerox VersaLink / AltaLink / WorkCentre / Phaser printers and MFPs. Uses the standards-based RFC 3805 Printer-MIB set (toner and ink levels, input trays, page counts, error states) plus HOST-RESOURCES-MIB status. Selected automatically for devices whose sysObjectID is under the Xerox enterprise arc 1.3.6.1.4.1.253.',
      'Xerox', 'printer',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",           "name": "sysDescr",                    "type": "string",   "mode": "get",  "description": "Printer model + firmware"},
        {"oid": "1.3.6.1.2.1.1.5.0",           "name": "sysName",                     "type": "string",   "mode": "get",  "description": "Configured device name"},
        {"oid": "1.3.6.1.2.1.1.6.0",           "name": "sysLocation",                 "type": "string",   "mode": "get",  "description": "Physical location"},
        {"oid": "1.3.6.1.2.1.25.3.2.1.5",      "name": "hrDeviceStatus",              "type": "table",    "mode": "walk", "description": "1=unknown 2=running 3=warning 4=testing 5=down"},
        {"oid": "1.3.6.1.2.1.25.3.5.1.1",      "name": "hrPrinterStatus",             "type": "table",    "mode": "walk", "description": "1=other 2=unknown 3=idle 4=printing 5=warmup"},
        {"oid": "1.3.6.1.2.1.25.3.5.1.2",      "name": "hrPrinterDetectedErrorState", "type": "table",    "mode": "walk", "description": "Bitmask of error conditions (paper jam, low toner, etc.)"},
        {"oid": "1.3.6.1.2.1.43.5.1.1.16",     "name": "prtGeneralPrinterName",       "type": "table",    "mode": "walk", "description": "Vendor-assigned printer name"},
        {"oid": "1.3.6.1.2.1.43.5.1.1.17",     "name": "prtGeneralSerialNumber",      "type": "table",    "mode": "walk", "description": "Serial number"},
        {"oid": "1.3.6.1.2.1.43.8.2.1.10",     "name": "prtInputCurrentLevel",        "type": "table",    "mode": "walk", "description": "Sheets remaining per input tray"},
        {"oid": "1.3.6.1.2.1.43.8.2.1.13",     "name": "prtInputName",                "type": "table",    "mode": "walk", "cadence": "slow", "description": "Input tray name"},
        {"oid": "1.3.6.1.2.1.43.10.2.1.4",     "name": "prtMarkerLifeCount",          "type": "table",    "mode": "walk", "description": "Lifetime page count"},
        {"oid": "1.3.6.1.2.1.43.10.2.1.5",     "name": "prtMarkerPowerOnCount",       "type": "table",    "mode": "walk", "description": "Pages since power-on"},
        {"oid": "1.3.6.1.2.1.43.11.1.1.5",     "name": "prtMarkerSuppliesType",       "type": "table",    "mode": "walk", "cadence": "slow", "description": "Toner/ink type per supply"},
        {"oid": "1.3.6.1.2.1.43.11.1.1.6",     "name": "prtMarkerSuppliesDescription","type": "table",    "mode": "walk", "cadence": "slow", "description": "Vendor description (e.g., Cyan Toner)"},
        {"oid": "1.3.6.1.2.1.43.11.1.1.8",     "name": "prtMarkerSuppliesMaxCapacity","type": "table",    "mode": "walk", "description": "Max capacity"},
        {"oid": "1.3.6.1.2.1.43.11.1.1.9",     "name": "prtMarkerSuppliesLevel",      "type": "table",    "mode": "walk", "description": "Current level (negative = unknown)"},
        {"oid": "1.3.6.1.2.1.43.12.1.1.4",     "name": "prtMarkerColorantValue",      "type": "table",    "mode": "walk", "cadence": "slow", "description": "Color name per supply"}
      ]'::jsonb,
      true,
      ARRAY['1.3.6.1.4.1.253']::text[]   -- Xerox
    );
    RAISE NOTICE 'inserted built-in SNMP template "Xerox Printer"';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Seed sysObjectID prefixes on the existing built-ins, by name.
--    `sys_object_id_prefixes = '{}'` in the WHERE makes this idempotent AND
--    keeps an operator's deliberate clearing cleared.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n integer;
BEGIN
  WITH seed(template_name, prefixes) AS (
    VALUES
      ('Cisco IOS Switch'::text,             ARRAY['1.3.6.1.4.1.9']::text[]),                                    -- ciscoSystems
      ('Cisco IOS Router',                   ARRAY['1.3.6.1.4.1.9']),                                            -- ciscoSystems
      ('Cisco ASA Firewall',                 ARRAY['1.3.6.1.4.1.9']),                                            -- ciscoSystems
      ('Cisco Meraki',                       ARRAY['1.3.6.1.4.1.29671']),                                        -- Meraki Networks, Inc.
      ('Fortinet FortiGate',                 ARRAY['1.3.6.1.4.1.12356']),                                        -- Fortinet, Inc.
      ('SonicWall Firewall',                 ARRAY['1.3.6.1.4.1.8741']),                                         -- SonicWALL, Inc.
      ('MikroTik RouterOS',                  ARRAY['1.3.6.1.4.1.14988']),                                        -- MikroTik
      ('Aruba / HPE ProCurve Switch',        ARRAY['1.3.6.1.4.1.11','1.3.6.1.4.1.14823','1.3.6.1.4.1.47196']),   -- Hewlett-Packard / Aruba, a HPE company / Hewlett Packard Enterprise
      ('Synology DSM (NAS)',                 ARRAY['1.3.6.1.4.1.6574']),                                         -- Synology Inc.
      ('QNAP QTS (NAS)',                     ARRAY['1.3.6.1.4.1.24681','1.3.6.1.4.1.55062']),                    -- QNAP SYSTEMS, INC / QNAP Systems, Inc.
      ('APC UPS (PowerNet)',                 ARRAY['1.3.6.1.4.1.318']),                                          -- American Power Conversion Corp.
      ('Linux net-snmpd',                    ARRAY['1.3.6.1.4.1.8072']),                                         -- net-snmp
      ('pfSense / OPNsense',                 ARRAY['1.3.6.1.4.1.8072','1.3.6.1.4.1.53869']),                     -- net-snmp (pfSense reports it) / OPNsense
      ('VMware ESXi Host',                   ARRAY['1.3.6.1.4.1.6876']),                                         -- VMware Inc.
      ('Juniper JUNOS',                      ARRAY['1.3.6.1.4.1.2636']),                                         -- Juniper Networks, Inc.
      ('Dell Networking PowerSwitch',        ARRAY['1.3.6.1.4.1.674']),                                          -- Dell Inc.
      ('Dell PowerEdge (iDRAC)',             ARRAY['1.3.6.1.4.1.674']),                                          -- Dell Inc.
      ('HPE ProLiant Server (iLO)',          ARRAY['1.3.6.1.4.1.232','1.3.6.1.4.1.47196']),                      -- Compaq (the ProLiant/iLO arc) / Hewlett Packard Enterprise
      ('Lenovo ThinkSystem (XCC)',           ARRAY['1.3.6.1.4.1.19046']),                                        -- Lenovo Enterprise Business Group
      ('Netgear ProSAFE Switch',             ARRAY['1.3.6.1.4.1.4526']),                                         -- Netgear
      ('TP-Link Omada Switch',               ARRAY['1.3.6.1.4.1.11863']),                                        -- TP-Link Systems Inc.
      ('Brother Printer',                    ARRAY['1.3.6.1.4.1.2435']),                                         -- Brother Industries, Ltd.
      ('Lexmark Printer',                    ARRAY['1.3.6.1.4.1.641']),                                          -- Lexmark International
      ('Eaton UPS',                          ARRAY['1.3.6.1.4.1.534']),                                          -- Eaton Corporation
      ('CyberPower UPS',                     ARRAY['1.3.6.1.4.1.3808','1.3.6.1.4.1.15446']),                     -- Cyber Power System Inc. / CyberPower Systems, Inc.
      ('Ruckus / CommScope AP',              ARRAY['1.3.6.1.4.1.25053']),                                        -- Ruckus Wireless, Inc.
      ('Ubiquiti UniFi Switch',              ARRAY['1.3.6.1.4.1.41112']),                                        -- Ubiquiti Networks, Inc.
      ('Ubiquiti UniFi Access Point',        ARRAY['1.3.6.1.4.1.41112']),                                        -- Ubiquiti Networks, Inc.
      ('Ubiquiti UniFi Gateway',             ARRAY['1.3.6.1.4.1.41112'])                                         -- Ubiquiti Networks, Inc.
      -- Deliberately NOT seeded (they are the by-device-type fallbacks, spec §8):
      --   'Generic Printer (RFC 3805)', 'Generic UPS (RFC 1628)'.
  )
  UPDATE snmp_templates t
     SET sys_object_id_prefixes = seed.prefixes
    FROM seed
   WHERE t.name = seed.template_name
     AND t.is_built_in = true
     AND t.sys_object_id_prefixes = '{}';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'seeded sysObjectID prefixes on % built-in SNMP templates', n;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Acquisition mode on built-in PRINTER templates (spec §8).
--    `.0` suffix => scalar => get; everything else is a table column => walk.
--    The entry's `type` cannot decide this (ifHCInOctets is counter64 AND a
--    column) — spec §7.1. Existing `mode` keys are preserved.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n integer;
BEGIN
  UPDATE snmp_templates t
     SET oids = COALESCE((
           SELECT jsonb_agg(
                    CASE WHEN e.entry ? 'mode' THEN e.entry
                         ELSE e.entry || jsonb_build_object(
                                'mode',
                                CASE WHEN e.entry->>'oid' LIKE '%.0' THEN 'get' ELSE 'walk' END)
                    END
                    ORDER BY e.ord)
             FROM jsonb_array_elements(t.oids) WITH ORDINALITY AS e(entry, ord)
         ), '[]'::jsonb)
   WHERE t.is_built_in = true
     AND t.device_type = 'printer'
     AND jsonb_typeof(t.oids) = 'array'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.oids) AS x(entry)
                  WHERE NOT (x.entry ? 'mode'));
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'set acquisition mode on % built-in printer templates', n;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Slow cadence on the static descriptor OIDs named in spec §7.1, across all
--    built-ins (ifDescr/ifName/ifSpeed live in the switch templates). These
--    change ~never, so W02 ships them on every 12th dispatch instead of every
--    poll. Existing `cadence` keys are preserved.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n integer;
  slow_names text[] := ARRAY[
    'ifDescr', 'ifName', 'ifSpeed',
    'prtInputName', 'prtMarkerSuppliesDescription', 'prtMarkerSuppliesType',
    'prtMarkerColorantValue'
  ];
BEGIN
  UPDATE snmp_templates t
     SET oids = COALESCE((
           SELECT jsonb_agg(
                    CASE WHEN e.entry ? 'cadence' THEN e.entry
                         WHEN e.entry->>'name' = ANY (slow_names)
                           THEN e.entry || '{"cadence":"slow"}'::jsonb
                         ELSE e.entry
                    END
                    ORDER BY e.ord)
             FROM jsonb_array_elements(t.oids) WITH ORDINALITY AS e(entry, ord)
         ), '[]'::jsonb)
   WHERE t.is_built_in = true
     AND jsonb_typeof(t.oids) = 'array'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.oids) AS x(entry)
                  WHERE NOT (x.entry ? 'cadence')
                    AND x.entry->>'name' = ANY (slow_names));
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'marked slow-cadence OID entries on % built-in SNMP templates', n;
END $$;
```

- [ ] **Step 5: Register the column in the export policy**

In `apps/api/src/services/tenantExportPolicyRegistry.ts`, replace the `snmp_templates` line (currently line 550):

```ts
  // sys_object_id_prefixes (#<parent>, spec §13): a list of PUBLIC IANA
  // enterprise OID prefixes the template claims. Not a capability list and not
  // an open container (text[]), so `included`. `oids` stays excludedOpen.
  "snmp_templates": tablePolicy("org_id", {"included":["id","org_id","name","description","vendor","device_type","sys_object_id_prefixes","is_built_in","created_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["oids"]}),
```

- [ ] **Step 6: Let custom templates carry `mode` / `cadence`**

In `apps/api/src/routes/snmp.ts`, extend `oidSchema` (line 65):

```ts
const oidSchema = z.object({
  oid: z.string().min(1),
  name: z.string().min(1),
  label: z.string().optional(),
  unit: z.string().optional(),
  type: z.string().optional(),
  // Acquisition hints consumed by services/snmpOidSpecs.ts (W02). Optional:
  // omitted entries fall back to the `.0` => get / else walk default and
  // `fast`. Without these fields the non-strict z.object SILENTLY STRIPPED
  // them from custom templates.
  mode: z.enum(['get', 'walk']).optional(),
  cadence: z.enum(['fast', 'slow']).optional(),
  description: z.string().optional()
});
```

- [ ] **Step 7: Run the unit guards green**

```bash
cd apps/api && npx vitest run src/services/tenantExportPolicySnmpTemplates.test.ts src/db/migrationRlsScope.test.ts src/db/autoMigrate.test.ts
```

Expected: 3 files, all pass. `migrationRlsScope.test.ts` is the one that would fail if the `set_config` line were missing or misplaced.

- [ ] **Step 8: Verify against a real database**

```bash
pnpm test-stack up
export DATABASE_URL="$(grep '^DATABASE_URL=' apps/api/.env.test | cut -d= -f2-)"
pnpm db:migrate
pnpm db:check-drift     # must report no drift
```

Then assert the seed landed and re-applying is a no-op:

```bash
psql "$DATABASE_URL" -c "select name, sys_object_id_prefixes from snmp_templates where is_built_in and sys_object_id_prefixes <> '{}' order by name;"
psql "$DATABASE_URL" -c "select count(*) filter (where e->>'mode' is null) as missing_mode from snmp_templates t, jsonb_array_elements(t.oids) e where t.is_built_in and t.device_type = 'printer';"
# expect missing_mode = 0
psql "$DATABASE_URL" -f apps/api/migrations/2026-10-17-110300-snmp-templates-prefixes-modes-xerox.sql
# expect: all four NOTICE lines report 0, and no error
```

- [ ] **Step 9: Re-check the migration filename ceiling, then commit**

```bash
ls apps/api/migrations | grep '\.sql$' | sort | tail -1     # must sort BEFORE our file
git add apps/api/migrations/2026-10-17-110300-snmp-templates-prefixes-modes-xerox.sql \
        apps/api/src/db/schema/snmp.ts \
        apps/api/src/services/tenantExportPolicyRegistry.ts \
        apps/api/src/services/tenantExportPolicySnmpTemplates.test.ts \
        apps/api/src/routes/snmp.ts
git commit -m "$(cat <<'EOF'
feat(api): snmp_templates sysObjectID prefixes, Xerox built-in, OID modes

Adds sys_object_id_prefixes text[] seeded with IANA-verified enterprise
prefixes on every built-in, inserts the "Xerox Printer" built-in (RFC 3805
set, prefix 1.3.6.1.4.1.253), and stamps mode/cadence into the built-ins'
oids jsonb so W02's oidSpecs walk table columns instead of GETting them.

Migration elects breeze.scope=system first (snmp_templates is FORCE RLS and
its built-in policies require it) and is idempotent. sys_object_id_prefixes
registered in CORE_TENANT_EXPORT_POLICY as `included`.

Refs #<parent> (W03, spec §8, §7.1, §13)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `services/snmpTemplateSuggest.ts` — boundary matching and ranking

**Files:**
- Create: `apps/api/src/services/snmpTemplateSuggest.ts`
- Create: `apps/api/src/services/snmpTemplateSuggest.test.ts`

**Interfaces:**
```ts
export interface TemplateSuggestionInput { sysObjectId: string | null; assetType: string | null; orgId: string; }
export interface TemplateSuggestion { templateId: string; templateName: string; reason: string; }
export function normalizeOid(oid: string | null | undefined): string[] | null;
export function oidHasPrefix(oidParts: string[], prefix: string): number;   // matched component count, 0 = no match
export async function suggestTemplate(input: TemplateSuggestionInput): Promise<TemplateSuggestion | null>;
```
(The index pins `suggestTemplate({ sysObjectId, assetType, orgId }): Promise<{ templateId, templateName, reason } | null>` — matched verbatim.)

**Decision (spec contradiction, D5 vs §8):** D5's summary says "longest boundary-aware prefix, tie by device type"; §8's detail says "ties on prefix are broken by `device_type` matching the asset's type, then by the longer prefix". **§8 wins** (it is the section this wave implements, and it is what the wave brief specifies). Ranking keys, in order: (1) `device_type === assetType`, (2) longer matched prefix, (3) org-owned before built-in, (4) template name ascending.

**Decision (spec silent):** if the top two candidates tie on *all* of (1)–(3), the suggestion is **ambiguous and `suggestTemplate` returns `null`**. Alphabetical would silently attach `Cisco ASA Firewall` to an unclassified Catalyst (all three Cisco built-ins carry `1.3.6.1.4.1.9`), and an honestly-empty suggestion is exactly the case spec §14 already has copy for ("No template matched; pick one", with the sysObjectID shown). The same rule keeps an unclassified Ubiquiti box (Switch / AP / Gateway all on 41112) from being mis-templated.

**Decision:** the query filters `is_built_in = true OR org_id = :orgId` at the app layer even though the `snmp_templates_select` RLS policy already says `is_built_in = true OR breeze_has_org_access(org_id)`. RLS is the enforcement; the app-layer clause is what stops a *partner*-scope caller (who legitimately has access to many orgs) seeing a sibling org's template in this org's suggestion. Never claim parity between the two.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/snmpTemplateSuggest.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: { select: vi.fn() } }));
vi.mock('../db/schema', () => ({
  snmpTemplates: {
    id: 'snmpTemplates.id',
    orgId: 'snmpTemplates.orgId',
    name: 'snmpTemplates.name',
    vendor: 'snmpTemplates.vendor',
    deviceType: 'snmpTemplates.deviceType',
    isBuiltIn: 'snmpTemplates.isBuiltIn',
    sysObjectIdPrefixes: 'snmpTemplates.sysObjectIdPrefixes',
  },
}));

import { db } from '../db';
import { normalizeOid, oidHasPrefix, suggestTemplate } from './snmpTemplateSuggest';

const ORG = '11111111-1111-1111-1111-111111111111';

type Row = {
  id: string; name: string; vendor: string | null; deviceType: string | null;
  isBuiltIn: boolean; prefixes: string[];
};

function mockTemplates(rows: Row[]) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }),
  } as never);
}

const XEROX: Row = { id: 'tpl-xerox', name: 'Xerox Printer', vendor: 'Xerox', deviceType: 'printer', isBuiltIn: true, prefixes: ['1.3.6.1.4.1.253'] };
const GENERIC: Row = { id: 'tpl-generic', name: 'Generic Printer (RFC 3805)', vendor: null, deviceType: 'printer', isBuiltIn: true, prefixes: [] };
const CISCO_SW: Row = { id: 'tpl-sw', name: 'Cisco IOS Switch', vendor: 'Cisco', deviceType: 'switch', isBuiltIn: true, prefixes: ['1.3.6.1.4.1.9'] };
const CISCO_RTR: Row = { id: 'tpl-rtr', name: 'Cisco IOS Router', vendor: 'Cisco', deviceType: 'router', isBuiltIn: true, prefixes: ['1.3.6.1.4.1.9'] };
const CISCO_ASA: Row = { id: 'tpl-asa', name: 'Cisco ASA Firewall', vendor: 'Cisco', deviceType: 'firewall', isBuiltIn: true, prefixes: ['1.3.6.1.4.1.9'] };
const MERAKI: Row = { id: 'tpl-meraki', name: 'Cisco Meraki', vendor: 'Meraki', deviceType: 'unknown', isBuiltIn: true, prefixes: ['1.3.6.1.4.1.29671'] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.select).mockReset();
});

describe('normalizeOid', () => {
  it('strips dots and leading zeros', () => {
    expect(normalizeOid('.1.3.6.1.4.1.0253.')).toEqual(['1', '3', '6', '1', '4', '1', '253']);
  });
  it.each(['', '   ', '1.3.x.1', null, undefined])('rejects %s', (v) => {
    expect(normalizeOid(v as string | null | undefined)).toBeNull();
  });
});

describe('oidHasPrefix — component boundaries (spec §15)', () => {
  const xeroxOid = normalizeOid('.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1')!;

  it('1.3.6.1.4.1.25 must NOT match a 1.3.6.1.4.1.253 device', () => {
    expect(oidHasPrefix(xeroxOid, '1.3.6.1.4.1.25')).toBe(0);
  });
  it('1.3.6.1.4.1.253 matches and reports 7 components', () => {
    expect(oidHasPrefix(xeroxOid, '1.3.6.1.4.1.253')).toBe(7);
  });
  it('a prefix longer than the OID never matches', () => {
    expect(oidHasPrefix(normalizeOid('1.3.6.1.4.1.253')!, '1.3.6.1.4.1.253.8')).toBe(0);
  });
  it('an empty or malformed prefix never matches', () => {
    expect(oidHasPrefix(xeroxOid, '')).toBe(0);
    expect(oidHasPrefix(xeroxOid, 'nope')).toBe(0);
  });
});

describe('suggestTemplate', () => {
  it('suggests the Xerox template for a Xerox sysObjectID', async () => {
    mockTemplates([XEROX, GENERIC, CISCO_SW]);
    const result = await suggestTemplate({ sysObjectId: '.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1', assetType: 'printer', orgId: ORG });
    expect(result).toEqual({
      templateId: 'tpl-xerox',
      templateName: 'Xerox Printer',
      reason: 'Detected Xerox printer, using Xerox Printer',
    });
  });

  it('does not match a 25-prefixed template against a 253 device', async () => {
    mockTemplates([{ ...XEROX, id: 'tpl-25', name: 'Bogus 25', prefixes: ['1.3.6.1.4.1.25'] }]);
    expect(await suggestTemplate({ sysObjectId: '1.3.6.1.4.1.253.1', assetType: 'printer', orgId: ORG })).toBeNull();
  });

  it('breaks a prefix tie by device_type before prefix length', async () => {
    mockTemplates([CISCO_SW, CISCO_RTR, CISCO_ASA]);
    const result = await suggestTemplate({ sysObjectId: '1.3.6.1.4.1.9.1.516', assetType: 'switch', orgId: ORG });
    expect(result?.templateId).toBe('tpl-sw');
  });

  it('prefers the longer prefix when no device_type matches', async () => {
    mockTemplates([
      { ...CISCO_SW, id: 'tpl-broad', name: 'Broad', deviceType: 'switch', prefixes: ['1.3.6.1.4.1.9'] },
      { ...CISCO_SW, id: 'tpl-narrow', name: 'Narrow', deviceType: 'router', prefixes: ['1.3.6.1.4.1.9.1.516'] },
    ]);
    const result = await suggestTemplate({ sysObjectId: '1.3.6.1.4.1.9.1.516.2', assetType: 'printer', orgId: ORG });
    expect(result?.templateId).toBe('tpl-narrow');
  });

  it('prefers the org\'s own template over an equally-ranked built-in', async () => {
    mockTemplates([XEROX, { ...XEROX, id: 'tpl-org', name: 'House Xerox', isBuiltIn: false }]);
    const result = await suggestTemplate({ sysObjectId: '1.3.6.1.4.1.253.1', assetType: 'printer', orgId: ORG });
    expect(result?.templateId).toBe('tpl-org');
  });

  it('returns null rather than guessing when candidates tie on every key', async () => {
    mockTemplates([CISCO_SW, CISCO_RTR, CISCO_ASA]);
    // assetType null: no device_type match, equal prefixes, all built-in.
    expect(await suggestTemplate({ sysObjectId: '1.3.6.1.4.1.9.1.516', assetType: null, orgId: ORG })).toBeNull();
  });

  it('still resolves an unambiguous vendor when the asset type is unknown', async () => {
    mockTemplates([CISCO_SW, CISCO_RTR, CISCO_ASA, MERAKI]);
    const result = await suggestTemplate({ sysObjectId: '1.3.6.1.4.1.29671.1.1', assetType: null, orgId: ORG });
    expect(result?.templateId).toBe('tpl-meraki');
  });

  it('returns null without querying when there is no sysObjectID', async () => {
    expect(await suggestTemplate({ sysObjectId: null, assetType: 'printer', orgId: ORG })).toBeNull();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns null when nothing has a prefix at all', async () => {
    mockTemplates([GENERIC]);
    expect(await suggestTemplate({ sysObjectId: '1.3.6.1.4.1.253.1', assetType: 'printer', orgId: ORG })).toBeNull();
  });

  it('tolerates a row whose prefixes column is not an array', async () => {
    mockTemplates([{ ...GENERIC, prefixes: null as unknown as string[] }]);
    expect(await suggestTemplate({ sysObjectId: '1.3.6.1.4.1.253.1', assetType: 'printer', orgId: ORG })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/snmpTemplateSuggest.test.ts
```

Expected: "Failed to resolve import ./snmpTemplateSuggest".

- [ ] **Step 3: Implement**

Create `apps/api/src/services/snmpTemplateSuggest.ts`:

```ts
/**
 * Suggest an SNMP template from a device's sysObjectID (spec §8, decision D5).
 *
 * BOUNDARY MATCHING IS THE WHOLE POINT. A naive `sysObjectId.startsWith(prefix)`
 * makes enterprise 25 match every enterprise-253 (Xerox) device, because "253"
 * starts with "25". Both sides are split on `.` and compared component by
 * component; `1.3.6.1.4.1.25` therefore matches 0 components of
 * `1.3.6.1.4.1.253.8.62…` and is not a candidate at all.
 *
 * RANKING (spec §8): device_type match, then longer matched prefix, then the
 * org's own template over a built-in, then name. When the top two tie on ALL of
 * those the answer is AMBIGUOUS and we return null rather than guessing — the
 * three Cisco built-ins all claim 1.3.6.1.4.1.9, and quietly attaching the ASA
 * template to a Catalyst is worse than the UI saying "pick one" (spec §14).
 */
import { eq, or } from 'drizzle-orm';
import { db } from '../db';
import { snmpTemplates } from '../db/schema';

export interface TemplateSuggestionInput {
  sysObjectId: string | null;
  assetType: string | null;
  orgId: string;
}

export interface TemplateSuggestion {
  templateId: string;
  templateName: string;
  reason: string;
}

/** Components of an OID, leading/trailing dots and leading zeros removed; null when malformed. */
export function normalizeOid(oid: string | null | undefined): string[] | null {
  if (typeof oid !== 'string') return null;
  const trimmed = oid.trim().replace(/^\.+/, '').replace(/\.+$/, '');
  if (!trimmed) return null;
  const parts = trimmed.split('.');
  const out: string[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    out.push(part.replace(/^0+(?=\d)/, ''));
  }
  return out;
}

/**
 * Number of components `prefix` matches at the head of `oidParts`, or 0 when it
 * is not a component-boundary prefix of it. A prefix longer than the OID, an
 * empty prefix and a malformed prefix all score 0.
 */
export function oidHasPrefix(oidParts: string[], prefix: string): number {
  const prefixParts = normalizeOid(prefix);
  if (!prefixParts || prefixParts.length === 0) return 0;
  if (prefixParts.length > oidParts.length) return 0;
  for (let i = 0; i < prefixParts.length; i += 1) {
    if (prefixParts[i] !== oidParts[i]) return 0;
  }
  return prefixParts.length;
}

interface Candidate {
  id: string;
  name: string;
  vendor: string | null;
  isBuiltIn: boolean;
  matchLength: number;
  typeMatch: boolean;
}

/** Descending rank order. Returns <0 when `a` should win. */
function compareCandidates(a: Candidate, b: Candidate): number {
  return (Number(b.typeMatch) - Number(a.typeMatch))
    || (b.matchLength - a.matchLength)
    || (Number(a.isBuiltIn) - Number(b.isBuiltIn))
    || a.name.localeCompare(b.name);
}

/** True when the top two candidates are indistinguishable on every ranking key. */
function isAmbiguous(a: Candidate, b: Candidate | undefined): boolean {
  if (!b) return false;
  return a.typeMatch === b.typeMatch
    && a.matchLength === b.matchLength
    && a.isBuiltIn === b.isBuiltIn;
}

function buildReason(winner: Candidate, assetType: string | null): string {
  const subject = winner.vendor ?? 'SNMP device';
  const qualifier = winner.typeMatch && assetType ? ` ${assetType}` : '';
  return `Detected ${subject}${qualifier}, using ${winner.name}`;
}

export async function suggestTemplate(input: TemplateSuggestionInput): Promise<TemplateSuggestion | null> {
  const oidParts = normalizeOid(input.sysObjectId);
  if (!oidParts) return null;

  // RLS (snmp_templates_select) already admits built-ins plus orgs the caller
  // can access; this clause narrows a PARTNER-scope caller to THIS org's own
  // templates. RLS is stricter than the app layer, never the other way round.
  const rows = await db
    .select({
      id: snmpTemplates.id,
      name: snmpTemplates.name,
      vendor: snmpTemplates.vendor,
      deviceType: snmpTemplates.deviceType,
      isBuiltIn: snmpTemplates.isBuiltIn,
      prefixes: snmpTemplates.sysObjectIdPrefixes,
    })
    .from(snmpTemplates)
    .where(or(eq(snmpTemplates.isBuiltIn, true), eq(snmpTemplates.orgId, input.orgId))!);

  const candidates: Candidate[] = [];
  for (const row of rows) {
    const prefixes = Array.isArray(row.prefixes) ? row.prefixes : [];
    let matchLength = 0;
    for (const prefix of prefixes) {
      const matched = oidHasPrefix(oidParts, prefix);
      if (matched > matchLength) matchLength = matched;
    }
    if (matchLength === 0) continue;
    candidates.push({
      id: row.id,
      name: row.name,
      vendor: row.vendor,
      isBuiltIn: row.isBuiltIn,
      matchLength,
      typeMatch: Boolean(input.assetType) && row.deviceType === input.assetType,
    });
  }

  if (candidates.length === 0) return null;
  candidates.sort(compareCandidates);

  const winner = candidates[0]!;
  if (isAmbiguous(winner, candidates[1])) return null;

  return {
    templateId: winner.id,
    templateName: winner.name,
    reason: buildReason(winner, input.assetType),
  };
}
```

- [ ] **Step 4: Run it green**

```bash
cd apps/api && npx vitest run src/services/snmpTemplateSuggest.test.ts
```

Expected: 1 file, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/snmpTemplateSuggest.ts apps/api/src/services/snmpTemplateSuggest.test.ts
git commit -m "$(cat <<'EOF'
feat(api): SNMP template suggestion from sysObjectID prefixes

Component-boundary matching (1.3.6.1.4.1.25 must not match .253), ranked by
device_type match, then longer prefix, then org-owned over built-in. An
all-keys tie returns null rather than guessing, so the three Cisco built-ins
sharing 1.3.6.1.4.1.9 never silently mis-template an unclassified Catalyst.

Refs #<parent> (W03, spec §8, §15)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `GET /monitoring/templates/suggest` and the PUT suggestion path

**Files:**
- Modify: `apps/api/src/routes/monitoring.ts`
- Create: `apps/api/src/routes/monitoring_templates_suggest.test.ts`
- Modify: `apps/api/src/routes/monitoring_assets_snmp.test.ts` (**Edit — do not Write**)

**Interfaces:**
- `GET /monitoring/templates/suggest?assetId=<uuid>` → `200 { sysObjectId: string | null; assetType: string | null; suggestion: TemplateSuggestion | null }`
- `PUT /monitoring/assets/:id/snmp` response gains `templateSuggestion: (TemplateSuggestion & { applied: boolean }) | null`
- Internal helper: `function readSysObjectId(snmpData: unknown): string | null`

**Decision (spec ambiguity, D5 "only on create" vs §8 "when `templateId` omitted"):** the suggestion is applied when `templateId` is **absent from the request body** *and* the row that would result has no template — i.e. there is no existing `snmp_devices` row, or the existing one has `template_id IS NULL`. If the existing row already carries a template and the caller omits `templateId`, the existing template is **preserved**. This honours both sentences and also removes a latent defect: today's `templateId: body.templateId ?? null` silently wipes an assigned template on any PUT that does not re-send it.

**Decision:** `templateId: null` sent **explicitly** remains "no template" on both PUT and PATCH — no suggestion is computed and none is applied. The existing PATCH null-as-unset handling (`for (const [k, v] of Object.entries(body)) if (v !== undefined) setValues[k] = v;`, `monitoring.ts:612`) is untouched; a regression test pins it.

**Decision:** `templateSuggestion` carries an extra `applied: boolean`. The index pins the *field name* only; without `applied`, a caller has to compare `snmpDevice.templateId` itself to know whether the suggestion was used, and W04's modal needs that distinction for its reason line.

- [ ] **Step 1: Write the failing route test**

Create `apps/api/src/routes/monitoring_templates_suggest.test.ts`. Copy the `vi.mock` preamble from `monitoring_assets_snmp.test.ts` verbatim (same `../db`, `../db/schema`, `../middleware/auth`, `../services/auditEvents`, `../services/redis` factories), add `snmpData` and `assetType` to the `discoveredAssets` mock, add `sysObjectIdPrefixes` to the `snmpTemplates` mock, and mock the suggester so the route test is about the route:

```ts
vi.mock('../services/snmpTemplateSuggest', () => ({
  suggestTemplate: vi.fn(),
}));
```

```ts
import { monitoringRoutes } from './monitoring';
import { db } from '../db';
import { suggestTemplate } from '../services/snmpTemplateSuggest';

const ORG_ID = 'org-111';
const ASSET_ID = '11111111-1111-1111-1111-111111111111';
const SITE_ALLOWED = 'aaaaaaaa-0000-0000-0000-000000000001';
const SITE_HIDDEN = 'bbbbbbbb-0000-0000-0000-000000000002';
const OTHER_ORG_ASSET = '44444444-4444-4444-4444-444444444444';

function mockAssetLookup(row: Record<string, unknown> | null) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(row ? [row] : []) }),
    }),
  } as never);
}

describe('GET /monitoring/templates/suggest', () => {
  let app: Hono;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(suggestTemplate).mockReset();
    app = new Hono();
    app.route('/monitoring', monitoringRoutes);
  });

  const get = (assetId: string, site?: string) => app.request(
    `/monitoring/templates/suggest?assetId=${assetId}`,
    { headers: { Authorization: 'Bearer token', ...(site ? { 'x-restrict-site': site } : {}) } },
  );

  it('returns the suggestion with the sysObjectID it matched on', async () => {
    mockAssetLookup({
      id: ASSET_ID, orgId: ORG_ID, siteId: SITE_ALLOWED, assetType: 'printer',
      snmpData: { sysObjectId: '.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1', sysDescr: 'Xerox(R) C325 Color MFP; …' },
    });
    vi.mocked(suggestTemplate).mockResolvedValue({
      templateId: 'tpl-xerox', templateName: 'Xerox Printer', reason: 'Detected Xerox printer, using Xerox Printer',
    });

    const res = await get(ASSET_ID, SITE_ALLOWED);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sysObjectId: '.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1',
      assetType: 'printer',
      suggestion: { templateId: 'tpl-xerox', templateName: 'Xerox Printer', reason: 'Detected Xerox printer, using Xerox Printer' },
    });
    expect(suggestTemplate).toHaveBeenCalledWith({
      sysObjectId: '.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1', assetType: 'printer', orgId: ORG_ID,
    });
  });

  it('returns a null suggestion with a null sysObjectID when the asset was never SNMP-scanned', async () => {
    mockAssetLookup({ id: ASSET_ID, orgId: ORG_ID, siteId: SITE_ALLOWED, assetType: 'unknown', snmpData: null });
    vi.mocked(suggestTemplate).mockResolvedValue(null);

    const res = await get(ASSET_ID, SITE_ALLOWED);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sysObjectId: null, assetType: 'unknown', suggestion: null });
  });

  it('404s for an asset outside the caller\'s org', async () => {
    mockAssetLookup(null);
    const res = await get(OTHER_ORG_ASSET);
    expect(res.status).toBe(404);
    expect(suggestTemplate).not.toHaveBeenCalled();
  });

  it('403s for a site the caller cannot see, before suggesting anything', async () => {
    mockAssetLookup({ id: ASSET_ID, orgId: ORG_ID, siteId: SITE_HIDDEN, assetType: 'printer', snmpData: {} });
    const res = await get(ASSET_ID, SITE_ALLOWED);
    expect(res.status).toBe(403);
    expect(suggestTemplate).not.toHaveBeenCalled();
  });

  it('400s on a non-uuid assetId', async () => {
    const res = await get('not-a-uuid');
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Extend the PUT test (Edit `monitoring_assets_snmp.test.ts`)**

Add `vi.mock('../services/snmpTemplateSuggest', () => ({ suggestTemplate: vi.fn() }));` to the preamble, add `snmpData: 'discoveredAssets.snmpData'` and `assetType: 'discoveredAssets.assetType'` to the `discoveredAssets` schema mock, import `suggestTemplate`, reset it in `beforeEach`, and append this describe block:

```ts
describe('PUT /monitoring/assets/:id/snmp — template suggestion (spec §8)', () => {
  const asset = {
    id: ASSET_ID, orgId: ORG_ID, siteId: SITE_ALLOWED, hostname: 'xerox-01', ipAddress: '10.0.0.5',
    assetType: 'printer', snmpData: { sysObjectId: '.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1' },
  };

  function mockPutChain(existing: Record<string, unknown> | null) {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({ for: vi.fn().mockResolvedValue([asset]) }),
          }),
        }),
      } as never)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(existing ? [existing] : []) }),
          }),
        }),
      } as never);
  }

  const put = (body: unknown) => app.request(`/monitoring/assets/${ASSET_ID}/snmp`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token', 'x-restrict-site': SITE_ALLOWED },
    body: JSON.stringify(body),
  });

  it('applies the suggestion when templateId is omitted on create, and echoes it', async () => {
    mockPutChain(null);
    vi.mocked(suggestTemplate).mockResolvedValue({
      templateId: 'tpl-xerox', templateName: 'Xerox Printer', reason: 'Detected Xerox printer, using Xerox Printer',
    });
    const insertValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: SNMP_DEVICE_ID, snmpVersion: 'v2c', port: 161, community: 'enc:v1:mock', username: null, templateId: 'tpl-xerox', pollingInterval: 300, isActive: true, lastPolled: null, lastStatus: null }]),
    });
    vi.mocked(db.insert).mockReturnValueOnce({ values: insertValues } as never);

    const res = await put({ snmpVersion: 'v2c', community: 'public' });

    expect(res.status).toBe(200);
    expect(insertValues.mock.calls[0]?.[0]).toMatchObject({ templateId: 'tpl-xerox' });
    const body = await res.json();
    expect(body.templateSuggestion).toEqual({
      templateId: 'tpl-xerox', templateName: 'Xerox Printer',
      reason: 'Detected Xerox printer, using Xerox Printer', applied: true,
    });
  });

  it('does not suggest, and stores null, when templateId is explicitly null', async () => {
    mockPutChain(null);
    const insertValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: SNMP_DEVICE_ID, snmpVersion: 'v2c', port: 161, community: 'enc:v1:mock', username: null, templateId: null, pollingInterval: 300, isActive: true, lastPolled: null, lastStatus: null }]),
    });
    vi.mocked(db.insert).mockReturnValueOnce({ values: insertValues } as never);

    const res = await put({ snmpVersion: 'v2c', community: 'public', templateId: null });

    expect(res.status).toBe(200);
    expect(suggestTemplate).not.toHaveBeenCalled();
    expect(insertValues.mock.calls[0]?.[0]).toMatchObject({ templateId: null });
    expect((await res.json()).templateSuggestion).toBeNull();
  });

  it('keeps an already-assigned template when templateId is omitted', async () => {
    mockPutChain({ id: SNMP_DEVICE_ID, templateId: 'tpl-chosen', community: 'enc:v1:old', isActive: true });
    const updateSet = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: SNMP_DEVICE_ID, snmpVersion: 'v2c', port: 161, community: 'enc:v1:old', username: null, templateId: 'tpl-chosen', pollingInterval: 300, isActive: true, lastPolled: null, lastStatus: null }]),
      }),
    });
    vi.mocked(db.update).mockReturnValueOnce({ set: updateSet } as never);

    const res = await put({ snmpVersion: 'v2c', community: '********' });

    expect(res.status).toBe(200);
    expect(suggestTemplate).not.toHaveBeenCalled();
    expect(updateSet.mock.calls[0]?.[0]).toMatchObject({ templateId: 'tpl-chosen' });
  });
});

describe('PATCH /monitoring/assets/:id/snmp — null-as-unset is preserved', () => {
  it('writes templateId null and never consults the suggester', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({ for: vi.fn().mockResolvedValue([{ id: ASSET_ID, orgId: ORG_ID, siteId: SITE_ALLOWED, ipAddress: '10.0.0.5' }]) }),
          }),
        }),
      } as never)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: SNMP_DEVICE_ID, templateId: 'tpl-old' }]) }),
          }),
        }),
      } as never);
    const updateSet = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: SNMP_DEVICE_ID, snmpVersion: 'v2c', port: 161, community: null, username: null, templateId: null, pollingInterval: 300, isActive: true, lastPolled: null, lastStatus: null }]),
      }),
    });
    vi.mocked(db.update).mockReturnValueOnce({ set: updateSet } as never);

    const res = await app.request(`/monitoring/assets/${ASSET_ID}/snmp`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token', 'x-restrict-site': SITE_ALLOWED },
      body: JSON.stringify({ templateId: null }),
    });

    expect(res.status).toBe(200);
    expect(suggestTemplate).not.toHaveBeenCalled();
    expect(updateSet.mock.calls[0]?.[0]).toMatchObject({ templateId: null });
  });
});
```

- [ ] **Step 3: Run both and watch them fail**

```bash
cd apps/api && npx vitest run src/routes/monitoring_templates_suggest.test.ts src/routes/monitoring_assets_snmp.test.ts
```

Expected: the suggest suite 404s on every request (no such route); the PUT suite fails with `templateSuggestion` undefined and `templateId: null` where `tpl-xerox`/`tpl-chosen` was expected.

- [ ] **Step 4: Implement the route and the PUT change**

In `apps/api/src/routes/monitoring.ts` add the import and helper near `validateSnmpTemplateAccess`:

```ts
import { suggestTemplate, type TemplateSuggestion } from '../services/snmpTemplateSuggest';
```

```ts
/**
 * The scan stores `{ sysDescr, sysObjectId, sysName }` in discovered_assets.snmpData
 * (jsonb, agent-authored) — treat every field as untrusted shape.
 */
function readSysObjectId(snmpData: unknown): string | null {
  if (!snmpData || typeof snmpData !== 'object') return null;
  const raw = (snmpData as Record<string, unknown>).sysObjectId;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}
```

Add the route immediately after the `GET /assets/:id` handler (before `upsertSnmpSchema`):

```ts
const suggestTemplateQuerySchema = z.object({ assetId: z.string().guid() });

monitoringRoutes.get(
  '/templates/suggest',
  requireScope('organization', 'partner', 'system'),
  requireMonitoringRead,
  zValidator('query', suggestTemplateQuerySchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { assetId } = c.req.valid('query');

    const orgResult = await resolveOrgIdForAsset(auth, assetId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const orgId = orgResult.orgId;
    if (!orgId) return c.json({ error: 'Could not determine organization context' }, 400);

    const [asset] = await db
      .select({
        id: discoveredAssets.id,
        orgId: discoveredAssets.orgId,
        siteId: discoveredAssets.siteId,
        assetType: discoveredAssets.assetType,
        snmpData: discoveredAssets.snmpData,
      })
      .from(discoveredAssets)
      .where(and(eq(discoveredAssets.id, assetId), eq(discoveredAssets.orgId, orgId)))
      .limit(1);
    if (!asset) return c.json({ error: 'Asset not found' }, 404);

    const perms = c.get('permissions') as UserPermissions | undefined;
    if (perms?.allowedSiteIds && (typeof asset.siteId !== 'string' || !canAccessSite(perms, asset.siteId))) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    const sysObjectId = readSysObjectId(asset.snmpData);
    const suggestion = await suggestTemplate({
      sysObjectId,
      assetType: asset.assetType ?? null,
      orgId: asset.orgId,
    });

    return c.json({ sysObjectId, assetType: asset.assetType ?? null, suggestion });
  }
);
```

In the PUT handler, replace the `templateId` handling. The existing-row lookup already runs before `setValues` is built, so only three edits are needed. First, right after the template-access check:

```ts
    // `templateId` ABSENT and `templateId: null` are different requests
    // (spec §8): absent means "choose for me", explicit null means "no
    // template". zod drops absent optional keys, so the key's presence is the
    // signal — do not use `?? null`, which conflates the two.
    const templateIdProvided = Object.prototype.hasOwnProperty.call(body, 'templateId');
```

Then, after `const existing = (() => { … })();`:

```ts
    // Apply the suggestion only when the resulting row would otherwise have no
    // template: on create, or on a row whose template_id is already null (spec
    // D5 "only on create when no template is given", §8 "templateId omitted
    // applies it"). Omitting templateId on a row that HAS one now preserves it
    // rather than silently wiping it.
    let templateSuggestion: TemplateSuggestion | null = null;
    let resolvedTemplateId: string | null = templateIdProvided
      ? (body.templateId ?? null)
      : (existing?.templateId ?? null);
    if (!templateIdProvided && !resolvedTemplateId) {
      templateSuggestion = await suggestTemplate({
        sysObjectId: readSysObjectId(asset.snmpData),
        assetType: asset.assetType ?? null,
        orgId: asset.orgId,
      });
      if (templateSuggestion) resolvedTemplateId = templateSuggestion.templateId;
    }
```

Then in `setValues`, replace `templateId: body.templateId ?? null,` with `templateId: resolvedTemplateId,`, and extend the success response:

```ts
    return c.json({
      success: true,
      snmpDevice: serializeSnmpDevice(upserted),
      templateSuggestion: templateSuggestion
        ? { ...templateSuggestion, applied: upserted.templateId === templateSuggestion.templateId }
        : null
    });
```

- [ ] **Step 5: Run them green**

```bash
cd apps/api && npx vitest run src/routes/monitoring_templates_suggest.test.ts src/routes/monitoring_assets_snmp.test.ts src/routes/monitoring_assets_list.test.ts
```

Expected: 3 files, all pass (the list suite is included because it shares the `monitoring.ts` module graph).

- [ ] **Step 6: Typecheck and commit**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
git add apps/api/src/routes/monitoring.ts apps/api/src/routes/monitoring_templates_suggest.test.ts apps/api/src/routes/monitoring_assets_snmp.test.ts
git commit -m "$(cat <<'EOF'
feat(api): GET /monitoring/templates/suggest and PUT template suggestion

PUT /monitoring/assets/:id/snmp now distinguishes an ABSENT templateId
("choose for me") from an explicit null ("no template"): absent applies the
suggestion when the row would otherwise have none, and preserves an already
assigned template instead of silently wiping it. The response echoes
templateSuggestion with an `applied` flag. PATCH null-as-unset is unchanged
and pinned by a regression test.

Refs #<parent> (W03, spec §8, §12, §14)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `resolveAssetIdentity` — enterprise vendor + vendor-family model extractors

**Files:**
- Modify: `apps/api/src/services/assetIdentity.ts` (**Edit — W01 created this file**)
- Modify: `apps/api/src/services/assetIdentity.test.ts` (**Edit — never Write**)

**Interfaces:**
```ts
export type ManufacturerSource = 'enterprise_oid' | 'sysdescr' | 'scan' | 'mac_oui';
export type ModelSource = 'vendor_extractor' | 'snmp_name' | 'scan';
export interface AssetIdentityInput {
  sysObjectId?: string | null;
  sysDescr?: string | null;
  snmpData?: Record<string, unknown> | null;
  macVendor?: string | null;
  current?: { manufacturer?: string | null; model?: string | null } | null;
}
export interface ResolvedAssetIdentity {
  manufacturer: string | null;
  manufacturerSource: ManufacturerSource | null;
  model: string | null;
  modelSource: ModelSource | null;
}
export function resolveAssetIdentity(input: AssetIdentityInput): ResolvedAssetIdentity;
```

**Decision (spec §9 says `services/discoveredAssetClassification.ts`, the plan index says `services/assetIdentity.ts`):** the **index wins**. It is the cross-wave contract W01/W04/W05 read, `discoveredAssetClassification.ts` is specifically the *type*-precedence module (it exports only SQL-guard builders), and identity has no business in it.

**Decision (one deliberate divergence from `classify.go`):** the agent matches `strings.Contains(sysDescr, "hp")`, which fires on "**sharp**", "grap**hp**oint" and similar. The server rule uses `\bhp\b`. Every other classify.go verdict is reproduced exactly, and a test pins each one; the Sharp case is pinned as a *fix*, not a regression. `classify.go` itself is W02's change.

**Decision:** manufacturer precedence is enterprise PEN → sysDescr rule → agent-provided value → MAC OUI vendor (spec §9's order, with the agent's own value slotted above the OUI because it is observation rather than inference). PENs in `GENERIC_AGENT_ENTERPRISE_NUMBERS` are skipped at step 1.

**Decision:** `model` is never the raw sysObjectID. Every path runs through W01's `maskOidShapedModel`, including the `current.model` fallback, which is exactly the value `classify.go` poisons today.

- [ ] **Step 1: Append the failing tests to `assetIdentity.test.ts`**

```ts
import { resolveAssetIdentity } from './assetIdentity';

const XEROX_C325 = {
  sysObjectId: '.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1',
  sysDescr: 'Xerox(R) C325 Color MFP; SS CXTGV.230.096, kernel 5.4.254-yocto-standard, All-N-1',
};

describe('resolveAssetIdentity — manufacturer (spec §9, F5)', () => {
  it('prefers the IANA enterprise arc over a mismatched NIC OUI (the Xerox C325 case)', () => {
    const result = resolveAssetIdentity({
      ...XEROX_C325,
      macVendor: 'LEXMARK INTERNATIONAL, INC.',
      current: { manufacturer: null, model: '.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1' },
    });
    expect(result.manufacturer).toBe('Xerox');
    expect(result.manufacturerSource).toBe('enterprise_oid');
  });

  it('falls back to the sysDescr rules when the PEN is unknown', () => {
    const result = resolveAssetIdentity({
      sysObjectId: '1.3.6.1.4.1.20682.1',
      sysDescr: 'Cisco IOS Software, C3750 Software (C3750-IPSERVICESK9-M), Version 12.2(55)SE12',
      macVendor: null,
    });
    expect(result.manufacturer).toBe('Cisco');
    expect(result.manufacturerSource).toBe('sysdescr');
  });

  it('ignores the net-snmp PEN so a pfSense box is not labelled "net-snmp"', () => {
    const result = resolveAssetIdentity({
      sysObjectId: '1.3.6.1.4.1.8072.3.2.10',
      sysDescr: 'FreeBSD fw.example 14.0-RELEASE',
      macVendor: 'Netgate',
    });
    expect(result.manufacturer).toBe('Netgate');
    expect(result.manufacturerSource).toBe('mac_oui');
  });

  it('falls back to the agent value, then the OUI', () => {
    expect(resolveAssetIdentity({ current: { manufacturer: 'Acme' }, macVendor: 'Other' }))
      .toMatchObject({ manufacturer: 'Acme', manufacturerSource: 'scan' });
    expect(resolveAssetIdentity({ macVendor: 'Other' }))
      .toMatchObject({ manufacturer: 'Other', manufacturerSource: 'mac_oui' });
  });

  it('reproduces every classify.go sysDescr verdict', () => {
    const cases: Array<[string, string]> = [
      ['Cisco IOS Software', 'Cisco'],
      ['Hewlett-Packard J9727A', 'HP'],
      ['HP ETHERNET MULTI-ENVIRONMENT', 'HP'],
      ['Dell EMC Networking OS10', 'Dell'],
      ['Juniper Networks, Inc. ex2300', 'Juniper'],
      ['RouterOS RB750 MikroTik', 'MikroTik'],
      ['Synology DiskStation DS920+', 'Synology'],
      ['QNAP Systems TS-453', 'QNAP'],
      ['Ubiquiti UniFi Switch US-8-150W', 'Ubiquiti'],
      ['FortiGate-60F v7.2.5', 'Fortinet'],
    ];
    for (const [sysDescr, expected] of cases) {
      expect(resolveAssetIdentity({ sysDescr }).manufacturer, sysDescr).toBe(expected);
    }
  });

  it('does not read "Sharp" as "HP" the way classify.go does (deliberate fix)', () => {
    expect(resolveAssetIdentity({ sysDescr: 'Sharp MX-3071 Ver 01.01' }).manufacturer).toBe('Sharp');
  });
});

describe('resolveAssetIdentity — model extractors (spec §9)', () => {
  it('Xerox: the segment before the first semicolon', () => {
    const result = resolveAssetIdentity({ ...XEROX_C325, current: { model: XEROX_C325.sysObjectId } });
    expect(result.model).toBe('Xerox(R) C325 Color MFP');
    expect(result.modelSource).toBe('vendor_extractor');
  });

  it('Lexmark: cuts at " version" when there is no semicolon', () => {
    const result = resolveAssetIdentity({
      sysObjectId: '1.3.6.1.4.1.641.1.1',
      sysDescr: 'Lexmark MX611de version NM.MN.N235 kernel 3.2.0 All-N-1',
    });
    expect(result).toMatchObject({ manufacturer: 'Lexmark', model: 'Lexmark MX611de' });
  });

  it('Brother: the MFC-/HL-/DCP- token', () => {
    const result = resolveAssetIdentity({
      sysObjectId: '1.3.6.1.4.1.2435.2.3.9.1',
      sysDescr: 'Brother NC-8300w, Firmware Ver.1.32, MID 8CF-J20, MFC-L8900CDW',
    });
    expect(result).toMatchObject({ manufacturer: 'Brother', model: 'MFC-L8900CDW' });
  });

  it('HP printers: the LaserJet phrase up to the first comma', () => {
    const result = resolveAssetIdentity({
      sysObjectId: '1.3.6.1.4.1.11.2.3.9.1',
      sysDescr: 'HP LaserJet MFP M428fdw, Serial Number: ABC123, Firmware 002.2226A',
    });
    expect(result).toMatchObject({ manufacturer: 'HP', model: 'HP LaserJet MFP M428fdw' });
  });

  it('HP JetDirect with no model phrase yields no model, never the OID', () => {
    const result = resolveAssetIdentity({
      sysObjectId: '1.3.6.1.4.1.11.2.3.9.1',
      sysDescr: 'HP ETHERNET MULTI-ENVIRONMENT,ROM none,JETDIRECT,JD153,EEPROM V.36.23',
      current: { model: '1.3.6.1.4.1.11.2.3.9.1' },
    });
    expect(result.manufacturer).toBe('HP');
    expect(result.model).toBeNull();
  });

  it('Cisco: the platform token out of the IOS banner', () => {
    const result = resolveAssetIdentity({
      sysObjectId: '1.3.6.1.4.1.9.1.516',
      sysDescr: 'Cisco IOS Software, C3750 Software (C3750-IPSERVICESK9-M), Version 12.2(55)SE12',
    });
    expect(result).toMatchObject({ manufacturer: 'Cisco', model: 'C3750' });
  });

  it('falls back to prtGeneralPrinterName when the vendor has no extractor', () => {
    const result = resolveAssetIdentity({
      sysObjectId: '1.3.6.1.4.1.1602.1',
      sysDescr: 'Canon iR-ADV',
      snmpData: { prtGeneralPrinterName: 'iR-ADV C5560' },
    });
    expect(result).toMatchObject({ manufacturer: 'Canon', model: 'iR-ADV C5560', modelSource: 'snmp_name' });
  });

  it('an unknown vendor with an OID-shaped scan model yields a NULL model, not the OID', () => {
    const result = resolveAssetIdentity({
      sysObjectId: '1.3.6.1.4.1.99999.7.1',
      sysDescr: 'Unbranded embedded controller v1',
      macVendor: null,
      current: { manufacturer: null, model: '.1.3.6.1.4.1.99999.7.1' },
    });
    expect(result.manufacturer).toBeNull();
    expect(result.model).toBeNull();
  });

  it('keeps a plausible scan-authored model when nothing better exists', () => {
    const result = resolveAssetIdentity({ current: { manufacturer: 'Acme', model: 'WidgetBox 9000' } });
    expect(result).toMatchObject({ model: 'WidgetBox 9000', modelSource: 'scan' });
  });

  it('never returns a model longer than the column allows', () => {
    const result = resolveAssetIdentity({
      sysObjectId: '1.3.6.1.4.1.253.1',
      sysDescr: `${'X'.repeat(500)}; rest`,
    });
    expect((result.model ?? '').length).toBeLessThanOrEqual(120);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/assetIdentity.test.ts
```

Expected: `resolveAssetIdentity is not a function` on every new case; W01's existing cases still pass.

- [ ] **Step 3: Implement (append to `assetIdentity.ts`)**

```ts
import { GENERIC_AGENT_ENTERPRISE_NUMBERS, enterpriseNumberFromSysObjectId, vendorFromSysObjectId } from './ianaEnterprise';

export type ManufacturerSource = 'enterprise_oid' | 'sysdescr' | 'scan' | 'mac_oui';
export type ModelSource = 'vendor_extractor' | 'snmp_name' | 'scan';

export interface AssetIdentityInput {
  sysObjectId?: string | null;
  sysDescr?: string | null;
  /** The full polled scalar bag (sysDescr/sysObjectId/sysName today, printer scalars once W02 walks). */
  snmpData?: Record<string, unknown> | null;
  /** NIC OUI vendor, already looked up by the caller. */
  macVendor?: string | null;
  /** What the scan itself proposed. Fills gaps; never outranks the arc or the sysDescr rules. */
  current?: { manufacturer?: string | null; model?: string | null } | null;
}

export interface ResolvedAssetIdentity {
  manufacturer: string | null;
  manufacturerSource: ManufacturerSource | null;
  model: string | null;
  modelSource: ModelSource | null;
}

/** discovered_assets.model is varchar(255); keep well under it and keep it readable. */
const MAX_MODEL_LENGTH = 120;

/**
 * sysDescr → manufacturer, ordered, most specific first.
 *
 * Ported from `agent/internal/discovery/classify.go` so old and new agents get
 * the same answer (spec §9: "the server rule is the source of truth"). ONE
 * deliberate divergence: classify.go uses `strings.Contains(sysDescr, "hp")`,
 * which reads "Sharp" as HP. `\bhp\b` does not. Everything else reproduces the
 * agent's verdicts exactly, pinned by assetIdentity.test.ts.
 */
const SYSDESCR_VENDOR_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bxerox\b/i, 'Xerox'],
  [/\blexmark\b/i, 'Lexmark'],
  [/\bbrother\b/i, 'Brother'],
  [/\bkonica\b/i, 'Konica Minolta'],
  [/\bkyocera\b/i, 'Kyocera'],
  [/\bricoh\b/i, 'Ricoh'],
  [/\bsharp\b/i, 'Sharp'],
  [/\bcanon\b/i, 'Canon'],
  [/\bepson\b/i, 'Epson'],
  [/\bzebra\b/i, 'Zebra'],
  [/\bcisco\b/i, 'Cisco'],
  [/\bmeraki\b/i, 'Meraki'],
  [/\b(?:fortinet|fortigate|fortiswitch|fortiap)\b/i, 'Fortinet'],
  [/\bsonicwall\b/i, 'SonicWall'],
  [/\bmikrotik\b/i, 'MikroTik'],
  [/\bsynology\b/i, 'Synology'],
  [/\bqnap\b/i, 'QNAP'],
  [/\b(?:ubiquiti|unifi|edgeswitch|edgerouter)\b/i, 'Ubiquiti'],
  [/\b(?:ruckus|commscope)\b/i, 'Ruckus'],
  [/\bjuniper\b/i, 'Juniper'],
  [/\bnetgear\b/i, 'Netgear'],
  [/\btp-?link\b/i, 'TP-Link'],
  [/\b(?:aruba|procurve)\b/i, 'Aruba'],
  [/\bsupermicro\b/i, 'Supermicro'],
  [/\blenovo\b/i, 'Lenovo'],
  [/\bvmware\b/i, 'VMware'],
  [/\b(?:apc|american power conversion)\b/i, 'APC'],
  [/\bcyberpower\b/i, 'CyberPower'],
  [/\beaton\b/i, 'Eaton'],
  [/\bdell\b/i, 'Dell'],
  [/\bhewlett[- ]packard\b/i, 'HP'],
  [/\b(?:laserjet|officejet|designjet|pagewide|proliant)\b/i, 'HP'],
  [/\bhpe?\b/i, 'HP'],
];

function manufacturerFromSysDescr(sysDescr: string): string | null {
  for (const [pattern, vendor] of SYSDESCR_VENDOR_RULES) {
    if (pattern.test(sysDescr)) return vendor;
  }
  return null;
}

function tidyModel(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_MODEL_LENGTH).trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** Xerox / Lexmark: the identity phrase that precedes the firmware blurb. */
function vendorPrefixSegment(sysDescr: string): string | null {
  const semicolon = sysDescr.indexOf(';');
  let segment = semicolon >= 0 ? sysDescr.slice(0, semicolon) : sysDescr;
  segment = segment.split(/\s+(?:version|kernel|firmware)\b/i)[0] ?? segment;
  segment = segment.split(',')[0] ?? segment;
  return tidyModel(segment);
}

function matchToken(sysDescr: string, pattern: RegExp): string | null {
  return tidyModel(pattern.exec(sysDescr)?.[1] ?? null);
}

/**
 * Tested extractors only (spec §9 / quorum D6): a universal "split on the first
 * semicolon" mis-parses most vendors, so each family gets a rule that was
 * checked against a real sysDescr, and everything else falls through to the
 * polled printer name or to null. The raw sysObjectID is NEVER a model.
 */
const MODEL_EXTRACTORS: ReadonlyArray<{
  vendors: ReadonlySet<string>;
  extract: (sysDescr: string) => string | null;
}> = [
  { vendors: new Set(['Xerox', 'Lexmark']), extract: vendorPrefixSegment },
  {
    vendors: new Set(['Brother']),
    extract: (d) => matchToken(d, /\b((?:MFC|HL|DCP|ADS|PT|QL|TD)-[A-Za-z0-9]+)\b/),
  },
  {
    vendors: new Set(['HP', 'HPE']),
    extract: (d) => matchToken(d, /\b(HP\s+(?:Color\s+)?(?:LaserJet|OfficeJet|Officejet|PageWide|DesignJet)[^,;]*)/i),
  },
  {
    vendors: new Set(['Cisco']),
    extract: (d) => matchToken(d, /\b((?:WS-C|CBS|ISR|ASR|IE|C)\d[A-Za-z0-9-]*)\b/),
  },
];

/** Printer/host scalars a poll may have captured; used when no extractor fires. */
const SNMP_MODEL_KEYS = ['prtGeneralPrinterName', 'hrDeviceDescr'] as const;

function modelFromSnmpData(snmpData: Record<string, unknown> | null | undefined): string | null {
  if (!snmpData) return null;
  for (const key of SNMP_MODEL_KEYS) {
    const value = snmpData[key];
    if (typeof value === 'string') {
      const tidied = tidyModel(value);
      if (tidied) return tidied;
    }
  }
  return null;
}

/**
 * Resolve manufacturer and model server-side at scan ingest (spec §9, D6).
 *
 * Manufacturer: IANA enterprise arc (the only ASSIGNED signal) → sysDescr
 * keyword rules → what the agent proposed → the NIC OUI vendor. The OUI is last
 * because it names whoever built the NIC, not the box: a Xerox C325 has a
 * Lexmark OUI (F5). Generic-agent PENs (net-snmp) are skipped entirely.
 *
 * Model: vendor-family extractor → a polled printer/device name → the scan's own
 * value → null. Every path is masked by maskOidShapedModel, so a sysObjectID can
 * never reach the column no matter which branch produced it.
 *
 * MANUAL PRECEDENCE IS NOT THIS FUNCTION'S JOB. `buildScanUpdateSet`
 * (jobs/discoveryWorker.ts) already wraps manufacturer/model in a
 * `case when source = 'manual' then <stored> else <proposed> end` guard
 * evaluated by Postgres against the stored row. Do not add a JS-side check here
 * — that is the #3011 race all over again.
 */
export function resolveAssetIdentity(input: AssetIdentityInput): ResolvedAssetIdentity {
  const sysDescr = typeof input.sysDescr === 'string' ? input.sysDescr : null;
  const scanManufacturer = input.current?.manufacturer?.trim() || null;

  let manufacturer: string | null = null;
  let manufacturerSource: ManufacturerSource | null = null;

  const pen = enterpriseNumberFromSysObjectId(input.sysObjectId);
  if (pen !== null && !GENERIC_AGENT_ENTERPRISE_NUMBERS.has(pen)) {
    const vendor = vendorFromSysObjectId(input.sysObjectId);
    if (vendor) {
      manufacturer = vendor;
      manufacturerSource = 'enterprise_oid';
    }
  }
  if (!manufacturer && sysDescr) {
    const vendor = manufacturerFromSysDescr(sysDescr);
    if (vendor) {
      manufacturer = vendor;
      manufacturerSource = 'sysdescr';
    }
  }
  if (!manufacturer && scanManufacturer) {
    manufacturer = scanManufacturer;
    manufacturerSource = 'scan';
  }
  if (!manufacturer && input.macVendor) {
    manufacturer = input.macVendor;
    manufacturerSource = 'mac_oui';
  }

  let model: string | null = null;
  let modelSource: ModelSource | null = null;

  if (manufacturer && sysDescr) {
    for (const extractor of MODEL_EXTRACTORS) {
      if (!extractor.vendors.has(manufacturer)) continue;
      const extracted = extractor.extract(sysDescr);
      if (extracted) {
        model = extracted;
        modelSource = 'vendor_extractor';
      }
      break;
    }
  }
  if (!model) {
    const fromSnmp = modelFromSnmpData(input.snmpData);
    if (fromSnmp) {
      model = fromSnmp;
      modelSource = 'snmp_name';
    }
  }
  if (!model) {
    const fromScan = tidyModel(maskOidShapedModel(input.current?.model ?? null));
    if (fromScan) {
      model = fromScan;
      modelSource = 'scan';
    }
  }

  // Belt and braces: whichever branch won, an OID-shaped string never ships.
  model = maskOidShapedModel(model);
  if (!model) modelSource = null;

  return { manufacturer, manufacturerSource, model, modelSource };
}
```

- [ ] **Step 4: Run it green**

```bash
cd apps/api && npx vitest run src/services/assetIdentity.test.ts src/services/ianaEnterprise.test.ts
```

Expected: 2 files, all pass — including every case W01 wrote.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/assetIdentity.ts apps/api/src/services/assetIdentity.test.ts
git commit -m "$(cat <<'EOF'
feat(api): resolve asset manufacturer and model server-side

Manufacturer from the IANA enterprise arc first (the only assigned signal),
then sysDescr rules ported from classify.go, then the agent value, then the
NIC OUI — so a Xerox C325 with a Lexmark OUI reads Xerox (spec F5). Model
from tested per-vendor extractors, then a polled printer name, then the scan
value; every path masked so a sysObjectID can never land in `model`.

One deliberate divergence from classify.go: `\bhp\b` instead of
Contains(descr, "hp"), which read "Sharp" as HP. Pinned by a test.

Refs #<parent> (W03, spec §9)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Wire identity resolution into the scan ingest path

**Files:**
- Modify: `apps/api/src/jobs/discoveryWorker.ts`
- Create: `apps/api/src/jobs/discoveryWorker.identity.test.ts`

**Interfaces:**
- `export function resolveScanIdentity(host: DiscoveredHostResult, nicVendor: string | null): ResolvedAssetIdentity`

**Decision:** the resolution is factored into one exported pure helper rather than being inlined in `processResults`, so it is unit-testable without a database. The helper is called from exactly one place (the `assetData` construction at `discoveryWorker.ts:~950`), which is the single point both the INSERT and the UPDATE branch read from. The UPDATE branch's manual guards in `buildScanUpdateSet` are **not** touched.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/jobs/discoveryWorker.identity.test.ts`:

```ts
/**
 * Identity at scan ingest (#<parent> W03, spec §9 / F5).
 *
 * `resolveScanIdentity` is the single point `processResults` reads identity
 * from, for both the INSERT and the UPDATE branch. The manual-precedence half
 * is asserted here too, by inspecting the BOUND SQL of buildScanUpdateSet
 * rather than deep-searching the Drizzle tree (a deep search matches a pg
 * enum's `enumValues` array and passes on unfixed code —
 * memory: drizzle_condition_deep_search_matches_enum_values_vacuous).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {},
  withSystemDbAccessContext: async <T>(fn: () => Promise<T>) => fn(),
  runOutsideDbContext: async <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('bullmq', () => ({ Queue: class {}, Worker: class {}, Job: class {} }));

import { buildScanUpdateSet, resolveScanIdentity } from './discoveryWorker';

const sqlText = (frag: unknown): string => {
  const chunks = (frag as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((c) => (typeof c === 'string' ? c : (c as { value?: unknown[] }).value?.join?.('') ?? ''))
    .join(' ');
};

describe('resolveScanIdentity', () => {
  it('turns the Xerox C325 scan payload into Xerox / Xerox(R) C325 Color MFP', () => {
    const identity = resolveScanIdentity(
      {
        ip: '10.0.0.5',
        mac: '00:20:00:aa:bb:cc',
        assetType: 'printer',
        methods: ['snmp'],
        model: '.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1',
        snmpData: {
          sysObjectId: '.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1',
          sysDescr: 'Xerox(R) C325 Color MFP; SS CXTGV.230.096, kernel 5.4.254-yocto-standard, All-N-1',
        },
      } as never,
      'LEXMARK INTERNATIONAL, INC.',
    );
    expect(identity.manufacturer).toBe('Xerox');
    expect(identity.model).toBe('Xerox(R) C325 Color MFP');
  });

  it('still uses the NIC OUI when the scan has no SNMP data at all', () => {
    const identity = resolveScanIdentity(
      { ip: '10.0.0.6', assetType: 'unknown', methods: ['arp'] } as never,
      'Ubiquiti Inc',
    );
    expect(identity).toMatchObject({ manufacturer: 'Ubiquiti Inc', model: null });
  });

  it('never surfaces a bare sysObjectID as the model', () => {
    const identity = resolveScanIdentity(
      {
        ip: '10.0.0.7', assetType: 'unknown', methods: ['snmp'],
        model: '1.3.6.1.4.1.99999.1.2',
        snmpData: { sysObjectId: '1.3.6.1.4.1.99999.1.2', sysDescr: 'Unbranded box' },
      } as never,
      null,
    );
    expect(identity.model).toBeNull();
  });
});

describe('manual precedence survives identity resolution', () => {
  it('still guards manufacturer and model against a manual row', () => {
    const identity = resolveScanIdentity(
      {
        ip: '10.0.0.5', assetType: 'printer', methods: ['snmp'],
        snmpData: { sysObjectId: '1.3.6.1.4.1.253.1', sysDescr: 'Xerox(R) C325 Color MFP; x' },
      } as never,
      null,
    );
    const updateSet = buildScanUpdateSet(
      { manufacturer: identity.manufacturer, model: identity.model, hostname: 'scan-name' },
      null,
    ) as Record<string, unknown>;

    for (const column of ['manufacturer', 'model', 'hostname']) {
      expect(sqlText(updateSet[column]), column).toContain("= 'manual'");
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/jobs/discoveryWorker.identity.test.ts
```

Expected: `resolveScanIdentity is not a function` (the export does not exist).

- [ ] **Step 3: Implement the wiring**

In `apps/api/src/jobs/discoveryWorker.ts`, add the import:

```ts
import { resolveAssetIdentity, type ResolvedAssetIdentity } from '../services/assetIdentity';
```

Add the helper next to `buildScanUpdateSet`:

```ts
/**
 * Identity for one scanned host (spec §9, D6).
 *
 * Exported so it can be unit-tested without a database; `processResults` is the
 * only caller, and it is the single point BOTH the INSERT and the UPDATE branch
 * read manufacturer/model from. Manual precedence is enforced afterwards, in
 * SQL, by buildScanUpdateSet — not here.
 */
export function resolveScanIdentity(
  host: DiscoveredHostResult,
  nicVendor: string | null,
): ResolvedAssetIdentity {
  return resolveAssetIdentity({
    sysObjectId: host.snmpData?.sysObjectId ?? null,
    sysDescr: host.snmpData?.sysDescr ?? null,
    snmpData: (host.snmpData ?? null) as Record<string, unknown> | null,
    macVendor: nicVendor,
    current: { manufacturer: host.manufacturer ?? null, model: host.model ?? null },
  });
}
```

Replace the manufacturer block at `discoveryWorker.ts:~950`:

```ts
    // Identity is resolved SERVER-side now (spec §9): the IANA enterprise arc
    // of the sysObjectID outranks the NIC OUI, and the raw sysObjectID can no
    // longer reach `model`. The OUI vendor is still computed — it remains the
    // last manufacturer fallback and W01 exposes it separately as `nicVendor`.
    const nicVendor = host.mac ? lookupMacVendor(host.mac) : null;
    const identity = resolveScanIdentity(host, nicVendor);
    const resolvedManufacturer = identity.manufacturer;
```

and in `assetData`, replace `model: host.model ?? null,` with:

```ts
      model: identity.model,
```

`resolvedManufacturer` keeps feeding `inferAssetTypeFromVendor` exactly as before — the `vendor_oui` classifier still ranks 10 and a PEN-derived `Xerox` still infers `printer` through `macVendorLookup.ts`'s keyword list.

- [ ] **Step 4: Run it green, plus the neighbouring suites**

```bash
cd apps/api && npx vitest run src/jobs/discoveryWorker.identity.test.ts src/jobs/discoveryWorker.test.ts src/jobs/discoveryWorker.manualSource.test.ts src/jobs/discoveryWorker.dbcontext.test.ts
```

Expected: 4 files, all pass. (Vitest's path filter is a plain substring match — `src/jobs/discoveryWorker` would also pull in `discoveryQueue`; the files are listed explicitly on purpose.)

- [ ] **Step 5: Typecheck and commit**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
git add apps/api/src/jobs/discoveryWorker.ts apps/api/src/jobs/discoveryWorker.identity.test.ts
git commit -m "$(cat <<'EOF'
feat(api): resolve identity at discovery scan ingest

processResults now takes manufacturer/model from resolveScanIdentity instead
of the agent's OUI fallback and raw sysObjectID. The NIC OUI is still
computed and still the last manufacturer fallback. Manual-row precedence is
unchanged — buildScanUpdateSet's SQL CASE guards are re-asserted by test.

Refs #<parent> (W03, spec §9, F5)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Integration suite and PR

**Files:**
- Create: `apps/api/src/__tests__/integration/snmpTemplateSuggest.integration.test.ts`

**Interfaces:** none — this task proves the migration, the RLS-scoped suggestion read, and the ingest wiring against real Postgres.

Everything here needs a live database: the migration's system-scope election, the `text[]` seed, the jsonb rewrites, the `snmp_templates_select` policy, and `processResults`' UPDATE-branch SQL guards are all decided by the server.

- [ ] **Step 1: Write the suite**

```ts
/**
 * SNMP template prefixes, suggestion, and identity at ingest (#<parent> W03).
 *
 * Migration under test:
 * `2026-10-17-110300-snmp-templates-prefixes-modes-xerox.sql`.
 *
 * Needs REAL Postgres: the prefix seed is a text[] UPDATE behind a FORCE-RLS
 * policy that only admits system scope, the mode/cadence rewrites are jsonb
 * aggregations, the suggestion read is filtered by snmp_templates_select, and
 * the manual-precedence half of the ingest path is a SQL CASE evaluated
 * against the stored row. A compiled-SQL mock observes none of it.
 */
import './setup';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { withSystemDbAccessContext } from '../../db';
import { discoveredAssets, discoveryJobs, discoveryProfiles, snmpTemplates } from '../../db/schema';
import { processResults } from '../../jobs/discoveryWorker';
import { suggestTemplate } from '../../services/snmpTemplateSuggest';
import { replayMigration } from './replayMigration';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const MIGRATION = '2026-10-17-110300-snmp-templates-prefixes-modes-xerox.sql';
const XEROX_OID = '.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1';
const XEROX_DESCR = 'Xerox(R) C325 Color MFP; SS CXTGV.230.096, kernel 5.4.254-yocto-standard, All-N-1';

let orgId: string;
let otherOrgId: string;
let siteId: string;
let profileId: string;
let jobId: string;

beforeEach(async () => {
  const partner = await createPartner({});
  orgId = (await createOrganization({ partnerId: partner.id })).id;
  otherOrgId = (await createOrganization({ partnerId: partner.id })).id;
  siteId = (await createSite({ orgId })).id;
  const raw = getTestDb();
  profileId = (await raw.insert(discoveryProfiles)
    .values({ orgId, siteId, name: 'w03-suite', subnets: ['10.9.9.0/24'] }).returning())[0]!.id;
  jobId = (await raw.insert(discoveryJobs)
    .values({ profileId, orgId, siteId, status: 'running' }).returning())[0]!.id;
});

afterEach(async () => {
  const raw = getTestDb();
  await raw.delete(snmpTemplates).where(eq(snmpTemplates.orgId, orgId));
  await raw.delete(snmpTemplates).where(eq(snmpTemplates.orgId, otherOrgId));
  await raw.delete(discoveredAssets).where(eq(discoveredAssets.orgId, orgId));
  await raw.delete(discoveryJobs).where(eq(discoveryJobs.orgId, orgId));
  await raw.delete(discoveryProfiles).where(eq(discoveryProfiles.orgId, orgId));
});

describe('migration: prefixes, Xerox built-in, mode/cadence', () => {
  runDb('seeded the Xerox built-in with its enterprise prefix', async () => {
    const rows = await getTestDb().execute(sql`
      select vendor, device_type, sys_object_id_prefixes
        from snmp_templates where name = 'Xerox Printer' and is_built_in`);
    const row = (rows as unknown as Array<Record<string, unknown>>)[0];
    expect(row).toMatchObject({ vendor: 'Xerox', device_type: 'printer' });
    expect(row!.sys_object_id_prefixes).toEqual(['1.3.6.1.4.1.253']);
  });

  runDb('seeded Lexmark 641 and Brother 2435 (spec §8)', async () => {
    const rows = await getTestDb().execute(sql`
      select name, sys_object_id_prefixes from snmp_templates
       where name in ('Lexmark Printer','Brother Printer') and is_built_in order by name`);
    expect(rows as unknown as Array<Record<string, unknown>>).toEqual([
      { name: 'Brother Printer', sys_object_id_prefixes: ['1.3.6.1.4.1.2435'] },
      { name: 'Lexmark Printer', sys_object_id_prefixes: ['1.3.6.1.4.1.641'] },
    ]);
  });

  runDb('left the by-device-type fallbacks without a prefix', async () => {
    const rows = await getTestDb().execute(sql`
      select name from snmp_templates
       where is_built_in and sys_object_id_prefixes = '{}' order by name`);
    expect((rows as unknown as Array<{ name: string }>).map((r) => r.name))
      .toEqual(['Generic Printer (RFC 3805)', 'Generic UPS (RFC 1628)']);
  });

  runDb('gave every built-in printer OID entry an explicit mode', async () => {
    const rows = await getTestDb().execute(sql`
      select count(*)::int as n from snmp_templates t, jsonb_array_elements(t.oids) e
       where t.is_built_in and t.device_type = 'printer' and not (e ? 'mode')`);
    expect((rows as unknown as Array<{ n: number }>)[0]!.n).toBe(0);
  });

  runDb('marked table columns walk and scalars get', async () => {
    const rows = await getTestDb().execute(sql`
      select e->>'name' as name, e->>'mode' as mode
        from snmp_templates t, jsonb_array_elements(t.oids) e
       where t.name = 'Generic Printer (RFC 3805)' and t.is_built_in
         and e->>'name' in ('sysDescr','prtMarkerSuppliesLevel') order by 1`);
    expect(rows as unknown as Array<Record<string, string>>).toEqual([
      { name: 'prtMarkerSuppliesLevel', mode: 'walk' },
      { name: 'sysDescr', mode: 'get' },
    ]);
  });

  runDb('marked the static descriptors slow (spec §7.1)', async () => {
    const rows = await getTestDb().execute(sql`
      select distinct e->>'cadence' as cadence
        from snmp_templates t, jsonb_array_elements(t.oids) e
       where t.is_built_in and e->>'name' in
         ('ifDescr','ifSpeed','prtInputName','prtMarkerSuppliesDescription',
          'prtMarkerSuppliesType','prtMarkerColorantValue')`);
    expect(rows as unknown as Array<{ cadence: string }>).toEqual([{ cadence: 'slow' }]);
  });

  runDb('re-applying the migration changes nothing', async () => {
    const before = await getTestDb().execute(sql`
      select md5(string_agg(name || coalesce(sys_object_id_prefixes::text,'') || oids::text, '|' order by name)) as h
        from snmp_templates where is_built_in`);
    await replayMigration(MIGRATION);
    const after = await getTestDb().execute(sql`
      select md5(string_agg(name || coalesce(sys_object_id_prefixes::text,'') || oids::text, '|' order by name)) as h
        from snmp_templates where is_built_in`);
    expect((after as unknown as Array<{ h: string }>)[0]!.h)
      .toBe((before as unknown as Array<{ h: string }>)[0]!.h);
  });
});

describe('suggestTemplate against real rows', () => {
  runDb('picks Xerox Printer for a 253 sysObjectID and never a 25 template', async () => {
    const raw = getTestDb();
    await raw.insert(snmpTemplates).values({
      orgId, name: 'Bogus 25', vendor: 'Bogus', deviceType: 'printer',
      oids: sql`'[]'::jsonb`, isBuiltIn: false,
      sysObjectIdPrefixes: ['1.3.6.1.4.1.25'],
    } as never);

    const result = await withSystemDbAccessContext(() =>
      suggestTemplate({ sysObjectId: XEROX_OID, assetType: 'printer', orgId }));
    expect(result?.templateName).toBe('Xerox Printer');
  });

  runDb('does not offer another org\'s template', async () => {
    const raw = getTestDb();
    await raw.insert(snmpTemplates).values({
      orgId: otherOrgId, name: 'Sibling Xerox', vendor: 'Xerox', deviceType: 'printer',
      oids: sql`'[]'::jsonb`, isBuiltIn: false,
      sysObjectIdPrefixes: ['1.3.6.1.4.1.253.8'],
    } as never);

    const result = await withSystemDbAccessContext(() =>
      suggestTemplate({ sysObjectId: XEROX_OID, assetType: 'printer', orgId }));
    expect(result?.templateName).toBe('Xerox Printer');   // NOT 'Sibling Xerox', despite its longer prefix
  });

  runDb('returns null for a sysObjectID no template claims', async () => {
    const result = await withSystemDbAccessContext(() =>
      suggestTemplate({ sysObjectId: '1.3.6.1.4.1.20682.1', assetType: 'printer', orgId }));
    expect(result).toBeNull();
  });
});

describe('identity at ingest', () => {
  const xeroxHost = {
    ip: '10.9.9.5', mac: '00:20:00:aa:bb:cc', assetType: 'printer', methods: ['snmp'],
    model: XEROX_OID, snmpData: { sysObjectId: XEROX_OID, sysDescr: XEROX_DESCR },
  };

  runDb('writes Xerox / the model phrase, never the raw OID', async () => {
    await withSystemDbAccessContext(() => processResults({
      type: 'process-results', jobId, profileId, orgId, siteId,
      hostsScanned: 1, hostsDiscovered: 1, hosts: [xeroxHost as never],
    }));

    const [row] = await getTestDb().select()
      .from(discoveredAssets).where(eq(discoveredAssets.ipAddress, '10.9.9.5'));
    expect(row!.manufacturer).toBe('Xerox');
    expect(row!.model).toBe('Xerox(R) C325 Color MFP');
  });

  runDb('leaves an operator\'s manual identity alone', async () => {
    const raw = getTestDb();
    const [manual] = await raw.insert(discoveredAssets).values({
      orgId, siteId, ipAddress: '10.9.9.5', source: 'manual', approvalStatus: 'approved',
      typeSource: 'manual', isOnline: false,
      manufacturer: 'Front desk printer co.', model: 'The one by the kitchen',
    } as never).returning({ id: discoveredAssets.id });

    await withSystemDbAccessContext(() => processResults({
      type: 'process-results', jobId, profileId, orgId, siteId,
      hostsScanned: 1, hostsDiscovered: 1, hosts: [xeroxHost as never],
    }));

    const [row] = await raw.select().from(discoveredAssets).where(eq(discoveredAssets.id, manual!.id));
    expect(row!.manufacturer).toBe('Front desk printer co.');
    expect(row!.model).toBe('The one by the kitchen');
  });
});
```

- [ ] **Step 2: Run the integration suites**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/snmpTemplateSuggest \
  src/__tests__/integration/tenant-export-policy \
  src/__tests__/integration/tenantExportErasureRoundtrip \
  src/__tests__/integration/tenantCascade \
  src/__tests__/integration/rls-coverage
```

Expected: all green. The export-policy pair is the one that fails if Task 2's registry edit was missed; `rls-coverage` and `tenantCascade` are run to confirm this wave adds nothing to either (no new table).

- [ ] **Step 3: Full API unit sweep and lint**

```bash
cd apps/api && npx vitest run src/services src/routes/monitoring src/routes/snmp src/jobs/discoveryWorker src/db
pnpm lint
```

- [ ] **Step 4: Commit and open the PR**

```bash
git add apps/api/src/__tests__/integration/snmpTemplateSuggest.integration.test.ts
git commit -m "$(cat <<'EOF'
test(api): live-DB coverage for template prefixes, suggestion and identity

Asserts the migration's seed and jsonb rewrites, its idempotency under
replayMigration, boundary matching (1.3.6.1.4.1.25 vs .253) and org scoping
against the real snmp_templates_select policy, and that scan ingest writes
Xerox/model phrase while leaving a manual row untouched.

Refs #<parent> (W03, spec §15)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
git push -u origin HEAD
gh workflow run CI --ref "$(git branch --show-current)"    # stacked branches get no pull_request run
gh pr create --base <W01 branch or main> --title "W03: SNMP template prefixes, suggestion, and server-side identity" --body "$(cat <<'EOF'
Closes #<W03 sub-issue>

Wave 3 of the Network Device Page Truth feature (spec §8, §9, §13, §15).

**What lands**
- `snmp_templates.sys_object_id_prefixes text[]`, seeded on every built-in with IANA-verified enterprise prefixes; new built-in "Xerox Printer" (RFC 3805 set, prefix `1.3.6.1.4.1.253`).
- Built-in printer templates' OID entries carry explicit `mode` (`get` for `.0` scalars, `walk` for table columns — spec F3); the §7.1 static descriptors carry `cadence: slow`.
- `services/snmpTemplateSuggest.ts`: component-boundary prefix matching, ranked by device_type then prefix length then org-owned; an all-keys tie returns null rather than guessing.
- `GET /monitoring/templates/suggest?assetId=`; `PUT /monitoring/assets/:id/snmp` applies the suggestion when `templateId` is *absent* and echoes `templateSuggestion`. `templateId: null` still means "no template" on PUT and PATCH.
- `services/ianaEnterprise.ts` + `resolveAssetIdentity` in `services/assetIdentity.ts`, wired into `processResults`: a Xerox C325 reads `Xerox` / `Xerox(R) C325 Color MFP` instead of `LEXMARK INTERNATIONAL, INC.` / `.1.3.6.1.4.1.253.8.62…` (spec F5).

**Tenancy**
No new tables, so no RLS policies and no cascade-list entries change. The one column addition is registered in `CORE_TENANT_EXPORT_POLICY` as `included` (public OID prefixes, `text[]`, not an open container). The migration writes rows and elects `breeze.scope = 'system'` first — `snmp_templates` is FORCE RLS and its built-in policies require it.

**Verification**
- IANA: every seeded PEN read out of `enterprise-numbers.txt` (last updated 2026-09-15); the registrant string is quoted beside each entry in both the migration and `ianaEnterprise.ts`. No unverified numbers.
- Integration Tests run locally: `snmpTemplateSuggest`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `tenantCascade`, `rls-coverage`.
- Migration re-applied against a live database: all four NOTICE lines report 0 on the second pass.

**Behaviour change to flag in review:** PUT with `templateId` omitted no longer wipes an assigned template — it preserves it. Explicit `null` is the way to clear one.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Post-PR checklist**

- [ ] `gh pr checks` is green **and** a real run exists for this branch (a stacked PR gets none from `pull_request`; confirm the dispatched run, not just the absence of red).
- [ ] `pnpm test-stack down` — tear down the worktree's Postgres/Redis.
- [ ] Run `/pr-review-toolkit:review-pr` and record the pass on the PR. One round; only act on confirmed findings.
- [ ] Do **not** merge before W01. If W01 is still open, the base branch is W01's; rebase onto `main` once W01 lands, re-dispatch CI, then enqueue with `gh pr merge <N>` (no `--admin`, no strategy flag).
