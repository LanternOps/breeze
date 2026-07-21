# BE-16 Vulnerability Management — Phase 5 (Network Devices) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **⛔ BLOCKED / GATED ON BE-30.** This phase cannot start until the discovery subsystem parses firmware versions and stores them. It is included for roadmap completeness so the full BE-16 arc lives in one place. **Verify the dependencies in "Preconditions" before treating any task as executable** — several reference tables/columns that do not exist yet and must be built by BE-30 (or as the first tasks here, by agreement with whoever owns BE-30).

**Goal:** Extend vulnerability matching to non-endpoint network devices (routers, switches, firewalls, APs) discovered via SNMP — reusing the same `vulnerabilities` catalog and `os_vulnerabilities`-style fact model, but sourcing versions from parsed `sysDescr` firmware strings and vendor PSIRT feeds instead of the endpoint agent.

**Architecture:** Per-vendor parsers extract a firmware version (plus provenance) from the raw `discovered_assets.snmp_data.sysDescr` jsonb. A new `network_device_firmware` table (specced loosely in BE-30, but with a different column shape — see Task 0) holds structured versions. Vendor PSIRT feeds (Cisco openVuln, Fortinet PSIRT) plus NVD provide "product/firmware-range → CVE" facts. Correlation matches a device's parsed firmware against those facts via **per-vendor comparators** (Cisco IOS train, JunOS), writing into a sibling **`network_device_vulnerabilities`** table (network devices live in `discovered_assets`, which carries `org_id` via discovery's existing tenancy — not `devices`). Matching stays the aggregate-dimension JOIN model from Phases 1–2.

**Tech Stack:** Hono (TS API), Drizzle ORM, PostgreSQL + RLS, BullMQ, the Go agent's SNMP discovery (`agent/internal/discovery/`), Vitest + Go `testing`.

**Source spec:** `internal/BE-16-vulnerability-management-v2.md` (Scope boundary section). **Dependency spec:** `internal/BE-30-network-device-config-management.md`. **Predecessors:** Phases 1–4 plans.

> Revised 2026-06-23 per Codex review (corrections folded into tasks below).

## Preconditions (verify before starting — several are BE-30 deliverables)

1. **Firmware parsing does not exist yet.** `discovered_assets.snmp_data` is a jsonb column (`apps/api/src/db/schema/discovery.ts:126`) and the agent stores the raw `sysDescr` under it, but the firmware version is **not parsed**. BE-30 states "No endpoint agent changes required for MVP" (`internal/BE-30-network-device-config-management.md:92`) and does not ship a parser, so Task 1 below builds it (API-side, off the stored `snmp_data.sysDescr`).
2. **`network_device_firmware` table does not exist and BE-30's sketch does not match this plan.** BE-30 sketches it (`internal/BE-30-network-device-config-management.md:46`) with `assetId` (no FK reference), **no `vendor` column**, and no provenance fields. This plan needs `discovered_asset_id` (FK → `discovered_assets(id)`), `vendor`, and the provenance fields in Task 2. Reconciling that contract is an explicit Task 0 item.
3. **Discovered assets carry org tenancy (confirmed).** `discovered_assets.org_id` exists (`apps/api/src/db/schema/discovery.ts:108`). But `device_vulnerabilities.device_id` FKs `devices.id` (`internal/BE-16-vulnerability-management-v2.md:163`), and network devices are **not** in `devices` — so network-device vulns CANNOT reuse `device_vulnerabilities`. A sibling `network_device_vulnerabilities` table (keyed on `discovered_asset_id`) is the decided model — Task 0 ratifies it.
4. **Additional SNMP OIDs are out of scope for MVP.** Today discovery queries exactly the 3 system OIDs — `sysDescr` (`1.3.6.1.2.1.1.1.0`), `sysObjectID` (`.1.2.0`), `sysName` (`.1.5.0`) — at `agent/internal/discovery/snmp.go:96`. BE-30 declares no agent changes, so this plan parses firmware out of the existing `sysDescr` only. If a vendor's `sysDescr` lacks the version, record low confidence (Task 2 provenance) rather than adding OIDs — adding vendor OIDs (e.g. Cisco `ENTITY-MIB entPhysicalSoftwareRev`) is a separate agent change to negotiate with BE-30's owner, not assumed here.

---

### Task 0: Ratify the storage model + reconcile the BE-30 contract (design spike, no code)

The storage model is **already decided** — these steps record and ratify it, they do not re-open it.

- [ ] **Step 1 — Ratify the sibling table (DECIDED).** Network-device vulns get a **new sibling table `network_device_vulnerabilities`**, NOT a reuse of `device_vulnerabilities`. Driver (verified): `device_vulnerabilities.device_id` is `notNull().references(() => devices.id)` (`internal/BE-16-vulnerability-management-v2.md:163`), and network devices live in `discovered_assets`, not `devices` — so they can never satisfy that FK. The decided schema:

  ```typescript
  export const networkDeviceVulnerabilities = pgTable('network_device_vulnerabilities', {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    discoveredAssetId: uuid('discovered_asset_id').notNull().references(() => discoveredAssets.id),
    vulnerabilityId: uuid('vulnerability_id').notNull().references(() => vulnerabilities.id),
    firmwareId: uuid('firmware_id').references(() => networkDeviceFirmware.id),
    status: varchar('status', { length: 20 }).notNull().default('open'), // open|patched|mitigated|accepted
    riskScore: numeric('risk_score', { precision: 5, scale: 2 }),
    detectedAt: timestamp('detected_at').notNull(),
    resolvedAt: timestamp('resolved_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  });
  ```

  Shape-1 RLS (`breeze_has_org_access(org_id)`) in the creating migration; add to `ORG_CASCADE_DELETE_ORDER` (localeCompare slot) and the rls-coverage allowlist auto-discovery (direct `org_id` column → auto-discovered). The build of this table lands in Task 4 (correlation) alongside its writer. Record the ratified decision in `internal/BE-16-vulnerability-management-v2.md` Scope section. The only condition that would re-open this is BE-30 promoting network assets into the `devices` table — confirm in Step 3 that it does not.

- [ ] **Step 2 — Reconcile the BE-30 `network_device_firmware` contract (REQUIRED — there is a real mismatch).** BE-30's sketched table (`internal/BE-30-network-device-config-management.md:46`) and this plan's needs DIVERGE:

  | Field | BE-30 sketch | This plan needs |
  |---|---|---|
  | asset link | `assetId uuid` (no FK reference) | `discovered_asset_id uuid` FK → `discovered_assets(id)` |
  | vendor | (absent) | `vendor varchar` (required for PSIRT matching + per-vendor comparators) |
  | provenance | (absent) | raw `sysDescr`, parser name/version, parsed vendor, product/OS line, model, source OID, confidence (Task 2) |
  | agent changes | "No endpoint agent changes required for MVP" (`:92`) | none assumed — parse from existing `snmp_data.sysDescr`; new vendor OIDs are explicitly out of scope unless renegotiated |

  Agree with BE-30's owner: (a) the asset-link column name and that it gets a real FK to `discovered_assets(id)`; (b) adding `vendor` + provenance columns; (c) that no agent SNMP-OID changes are in scope for this phase. If BE-30 ships the table first, this plan must add the missing columns via a forward migration (Task 2 Step 1) rather than editing BE-30's shipped migration. Record which side ships the table.

- [ ] **Step 3:** Confirm with BE-30's owner which of Tasks 1–2 BE-30 delivers vs this plan, and confirm BE-30 does NOT move network assets into `devices` (which would moot the sibling table). Update the task list accordingly. Commit the decision note only.

---

### Task 1: Per-vendor `sysDescr` firmware parser (if not delivered by BE-30)

**Files:**
- Create: `apps/api/src/services/networkFirmwareParse.ts` (API-side: parse off the already-stored `discovered_assets.snmp_data.sysDescr`. Per the precondition + Task 0 Step 2, no agent changes are in scope — do NOT move parsing into `agent/internal/discovery/` unless BE-30's owner renegotiates that.)
- Test: `apps/api/src/services/networkFirmwareParse.test.ts`

**Interfaces:**
- Produces a **structured summary with provenance** (version alone is insufficient for PSIRT matching — see Task 0 Step 2). The parser returns a `ParsedFirmware` so the populate step (Task 2) can persist provenance and a confidence score:

  ```ts
  export interface ParsedFirmware {
    vendor: string | null;          // 'cisco' | 'fortinet' | 'juniper' | ...
    version: string | null;         // raw vendor-format version, e.g. '15.2(7)E5', '12.3R12'
    productOrOsLine: string | null; // e.g. 'IOS', 'IOS-XE', 'FortiOS', 'JUNOS'
    model: string | null;           // e.g. 'C2960X', 'FortiGate-60F', 'ex2200'
    rawSysDescr: string;            // verbatim input, for forensics/re-parse
    parserName: string;             // which vendor matcher fired, e.g. 'cisco-ios'
    parserVersion: string;          // bump when a regex changes, for re-parse diffing
    sourceOid: string;              // '1.3.6.1.2.1.1.1.0' (sysDescr) for MVP
    confidence: number;             // 0..1; 1 = exact version match, lower when guessed
  }

  export function parseFirmware(sysDescr: string): ParsedFirmware;
  ```

  Regex-per-vendor extraction. Examples to cover: Cisco IOS, FortiOS, Juniper JunOS, HP/Aruba, Ubiquiti banner formats. On no match, return `{ vendor: null, version: null, productOrOsLine: null, model: null, rawSysDescr: sysDescr, parserName: 'none', parserVersion: PARSER_VERSION, sourceOid: '1.3.6.1.2.1.1.1.0', confidence: 0 }`.

- [ ] **Step 1: Write the failing table-driven test**

```ts
import { parseFirmware, type ParsedFirmware } from './networkFirmwareParse';

// helper: assert only the load-bearing fields; provenance (parserName/Version, confidence)
// is checked separately so version-regex edits don't churn every case.
function pick(p: ParsedFirmware) {
  return { vendor: p.vendor, version: p.version, productOrOsLine: p.productOrOsLine, model: p.model };
}

describe('parseFirmware', () => {
  const cases: Array<[string, Pick<ParsedFirmware, 'vendor' | 'version' | 'productOrOsLine' | 'model'>]> = [
    ['Cisco IOS Software, C2960X Software, Version 15.2(7)E5',
      { vendor: 'cisco', version: '15.2(7)E5', productOrOsLine: 'IOS', model: 'C2960X' }],
    ['FortiGate-60F v7.2.5,build1517',
      { vendor: 'fortinet', version: '7.2.5', productOrOsLine: 'FortiOS', model: 'FortiGate-60F' }],
    ['Juniper Networks, Inc. ex2200 ... JUNOS 12.3R12',
      { vendor: 'juniper', version: '12.3R12', productOrOsLine: 'JUNOS', model: 'ex2200' }],
    ['Unknown banner text',
      { vendor: null, version: null, productOrOsLine: null, model: null }],
  ];
  it.each(cases)('parses %s', (input, expected) => {
    expect(pick(parseFirmware(input))).toEqual(expected);
  });

  it('always echoes the raw sysDescr and source OID for provenance', () => {
    const p = parseFirmware('Cisco IOS Software, C2960X Software, Version 15.2(7)E5');
    expect(p.rawSysDescr).toBe('Cisco IOS Software, C2960X Software, Version 15.2(7)E5');
    expect(p.sourceOid).toBe('1.3.6.1.2.1.1.1.0');
    expect(p.confidence).toBeGreaterThan(0);
    expect(p.parserName).toBe('cisco-ios');
  });

  it('returns confidence 0 and parserName "none" on no match', () => {
    const p = parseFirmware('Unknown banner text');
    expect(p.confidence).toBe(0);
    expect(p.parserName).toBe('none');
    expect(p.rawSysDescr).toBe('Unknown banner text');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/networkFirmwareParse.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** a vendor-keyed matcher table (one entry per vendor: `{ name, vendor, productOrOsLine, test, extractVersion, extractModel }`). Iterate the table, return the first match's full `ParsedFirmware` (set `confidence: 1` when a version was extracted, lower if only vendor/model matched), else the null/`confidence: 0`/`parserName: 'none'` shape above. Export a `PARSER_VERSION` constant and bump it whenever a regex changes. Keep the set extensible (one entry per vendor).

- [ ] **Step 4: Run to verify pass** (same command) — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/networkFirmwareParse.ts apps/api/src/services/networkFirmwareParse.test.ts
git commit -m "feat(vuln): per-vendor sysDescr firmware parser"
```

---

### Task 2: `network_device_firmware` table + populate from discovery (if not delivered by BE-30)

**Files:**
- Modify: `apps/api/src/db/schema/discovery.ts` (or a new schema file)
- Create: `apps/api/migrations/<date>-network-device-firmware.sql`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- Modify: `apps/api/src/services/tenantCascade.ts` (org cascade)
- Test: real-DB integration test

> **BE-30 contract note (from Task 0 Step 2):** BE-30's sketch uses `assetId` (no FK), has no `vendor`, and no provenance. This task uses `discovered_asset_id` (real FK), adds `vendor`, and adds provenance columns. If BE-30 already shipped its version of the table, do NOT edit that migration — add the missing columns (`vendor`, provenance, and a real FK constraint if absent) via this task's forward migration with `ADD COLUMN IF NOT EXISTS`.

**Interfaces:**
- Produces: `network_device_firmware` with tenancy, the structured version, AND provenance:

  ```typescript
  export const networkDeviceFirmware = pgTable('network_device_firmware', {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    discoveredAssetId: uuid('discovered_asset_id').notNull().references(() => discoveredAssets.id),
    vendor: varchar('vendor', { length: 40 }),                 // parsed vendor, e.g. 'cisco'
    currentVersion: varchar('current_version', { length: 80 }),
    latestVersion: varchar('latest_version', { length: 80 }),
    eolDate: timestamp('eol_date'),
    cveCount: integer('cve_count').default(0),
    lastCheckedAt: timestamp('last_checked_at'),
    // provenance (Task 0 Step 2 / Task 1 ParsedFirmware):
    rawSysDescr: text('raw_sys_descr'),                        // verbatim banner
    parserName: varchar('parser_name', { length: 40 }),        // which matcher fired
    parserVersion: varchar('parser_version', { length: 20 }),  // PARSER_VERSION at parse time
    productOrOsLine: varchar('product_or_os_line', { length: 40 }), // 'IOS' | 'FortiOS' | 'JUNOS'
    model: varchar('model', { length: 80 }),                   // 'C2960X' | 'FortiGate-60F'
    sourceOid: varchar('source_oid', { length: 64 }),          // '1.3.6.1.2.1.1.1.0'
    confidence: numeric('confidence', { precision: 3, scale: 2 }), // 0..1
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  }, (table) => ({
    orgAssetIdx: uniqueIndex('net_fw_org_asset_idx').on(table.orgId, table.discoveredAssetId),
  }));
  ```

  Shape-1 RLS (`breeze_has_org_access(org_id)`); add to `ORG_CASCADE_DELETE_ORDER`. A discovery post-process calls `parseFirmware(snmp_data.sysDescr)` and upserts a row per network asset (on conflict `(org_id, discovered_asset_id)`), persisting `vendor`, `currentVersion = parsed.version`, and the full provenance set from `ParsedFirmware`.

- [ ] **Step 1:** Add schema + idempotent migration with shape-1 RLS policies (mirror Phase 1 Task 1's policy block). Use `CREATE TABLE IF NOT EXISTS` and, for the BE-30-already-shipped case, `ADD COLUMN IF NOT EXISTS` for `vendor` + each provenance column. Add to `ORG_CASCADE_DELETE_ORDER` (localeCompare slot). This table references `discovered_assets`, NOT `devices`, so the device-org-rewrite list does not apply — its org cascade is the standard org-delete path only.
- [ ] **Step 2:** Write a failing integration test: after a discovery run produces a network asset with a parseable `sysDescr`, a `network_device_firmware` row exists with the parsed `currentVersion`, `vendor`, non-null `rawSysDescr`, and `sourceOid = '1.3.6.1.2.1.1.1.0'`.
- [ ] **Step 3:** Run drift check + the failing test (expect fail), implement the populate step, re-run (expect pass).

Run (drift): `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift`
Run (test): `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/services/networkFirmware.integration.test.ts`

- [ ] **Step 4: Commit** the schema, migration, allowlist, cascade, and populate step together.

---

### Task 3: Vendor PSIRT + NVD network facts

**Files:**
- Create: `apps/api/src/services/psirtClient.ts` (Cisco openVuln, Fortinet PSIRT)
- Modify: `apps/api/src/jobs/vulnerabilityJobs.ts` (add `syncPsirt`)
- Test: `apps/api/src/services/psirtClient.test.ts` + integration

**Interfaces:**
- Produces: `parsePsirt(doc, vendor): NetworkFactRecord[]` (`vendor`, `productOrOsLine`, version range, `cveId`, `cvss`) and `syncPsirt()` upserting into `vulnerabilities` + the network fact model (reuse `os_vulnerabilities` with `platform=<vendor>` OR a dedicated `network_vulnerabilities` fact table — record the chosen fact-model shape in Task 0 Step 1's decision note). Cisco openVuln needs OAuth2 client credentials; store creds in env, never in code.

- [ ] **Step 1:** Fixture from a real PSIRT response (Cisco openVuln `/security/advisories`), trim to one advisory with affected versions + CVE + CVSS.
- [ ] **Step 2–4:** TDD the parser, then the sync (idempotent, rate-limited, cursor in `vulnerability_sources` source `'psirt_cisco'`/`'psirt_fortinet'`). Commands mirror Phase 2 Task 3/4.
- [ ] **Step 5: Commit.**

---

### Task 4: Network-device correlation

**Files:**
- Modify: `apps/api/src/services/vulnerabilityCorrelation.ts` (add `correlateNetworkDevices`)
- Test: integration

**Files:**
- Create: `apps/api/src/services/networkVersionCompare.ts` (per-vendor comparators) + `apps/api/src/services/networkVersionCompare.test.ts`
- Modify: `apps/api/src/services/vulnerabilityCorrelation.ts` (add `correlateNetworkDevices`)
- Modify: `apps/api/src/db/schema/` (create `network_device_vulnerabilities` per Task 0, with shape-1 RLS migration) — its writer lands here
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` + `apps/api/src/services/tenantCascade.ts`
- Test: integration

**Interfaces:**
- Produces: `correlateNetworkDevices(orgId)` — join `network_device_firmware` (org's network assets) against the network fact model on `vendor` + firmware-version-range, writing into **`network_device_vulnerabilities`** (the sibling table ratified in Task 0). Open/patched lifecycle mirrors `correlateOrg`.

  **DO NOT route these versions through the generic `compareBuilds`.** Confirmed footgun: the Phase 1/2 `compareBuilds` is a dot-split + `parseInt`, so `15.2(7)E5` and `15.2(7)E6` both collapse to `[15, 2]` (the `(7)E5`/`(7)E6` tail is dropped at the `(`), and `12.3R12` loses `R12` → false matches in both directions. Instead, build **per-vendor comparators** in `networkVersionCompare.ts`, each fully self-contained and each with its own tests:

  ```ts
  // Returns -1 | 0 | 1 (a<b | a==b | a>b); null when either string is not in this vendor's format.
  export type VendorComparator = (a: string, b: string) => -1 | 0 | 1 | null;

  // Cisco IOS train, e.g. '15.2(7)E5' = major.minor(build)train-rebuild.
  // Compare tuple: [major, minor, build, train, rebuild] where train is the letter run ('E')
  // compared lexicographically and rebuild is its numeric suffix (5).
  export const compareCiscoIos: VendorComparator = (a, b) => { /* parse 15.2(7)E5 → [15,2,7,'E',5] */ };

  // JunOS, e.g. '12.3R12' = major.minor R rebuild (also S/B/X variants). Compare [major, minor, kind, rebuild].
  export const compareJunos: VendorComparator = (a, b) => { /* parse 12.3R12 → [12,3,'R',12] */ };

  export const VENDOR_COMPARATORS: Record<string, VendorComparator> = {
    cisco: compareCiscoIos,
    juniper: compareJunos,
    // fortinet: FortiOS is dot-numeric (7.2.5) → may reuse the generic compareBuilds safely; key it explicitly here anyway.
  };
  ```

  `correlateNetworkDevices` picks the comparator by the firmware row's `vendor`; if no per-vendor comparator exists and the version is plain dot-numeric, it MAY fall back to the generic `compareBuilds`, otherwise it skips the row and records why (do not silently mis-rank).

- [ ] **Step 1: Write the failing comparator tests FIRST** (`networkVersionCompare.test.ts`), one suite per vendor — these are the cases the generic comparator collapses:

  ```ts
  import { compareCiscoIos, compareJunos } from './networkVersionCompare';

  describe('compareCiscoIos', () => {
    it('orders the (build)train-rebuild tail the generic splitter drops', () => {
      expect(compareCiscoIos('15.2(7)E5', '15.2(7)E6')).toBe(-1); // generic compareBuilds → 0 (BUG)
      expect(compareCiscoIos('15.2(7)E6', '15.2(7)E5')).toBe(1);
      expect(compareCiscoIos('15.2(7)E5', '15.2(7)E5')).toBe(0);
      expect(compareCiscoIos('15.2(7)E5', '15.3(1)S')).toBe(-1);  // minor train differs
    });
    it('returns null for a non-Cisco-format string', () => {
      expect(compareCiscoIos('12.3R12', '15.2(7)E5')).toBeNull();
    });
  });

  describe('compareJunos', () => {
    it('orders the R-rebuild the generic splitter drops', () => {
      expect(compareJunos('12.3R12', '12.3R11')).toBe(1);  // generic → 0 (BUG: 'R12' lost)
      expect(compareJunos('12.3R11', '12.3R12')).toBe(-1);
      expect(compareJunos('12.3R12', '12.3R12')).toBe(0);
      expect(compareJunos('12.3R12', '13.2R1')).toBe(-1);
    });
    it('returns null for a non-JunOS-format string', () => {
      expect(compareJunos('15.2(7)E5', '12.3R12')).toBeNull();
    });
  });
  ```

  Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/networkVersionCompare.test.ts` → Expected: FAIL.

- [ ] **Step 2:** Implement `compareCiscoIos` / `compareJunos` (regex-parse each into its tuple, compare element-wise, return `null` on format miss). Re-run → PASS. Commit the comparators on their own.

- [ ] **Step 3:** Create the `network_device_vulnerabilities` table (Task 0 schema) + idempotent shape-1 RLS migration; add to `ORG_CASCADE_DELETE_ORDER` (localeCompare slot — `network_device_vulnerabilities` sorts after `network_device_firmware`; place accordingly) and verify rls-coverage auto-discovers it (direct `org_id`). Forge a cross-tenant insert as `breeze_app` — must fail with `new row violates row-level security policy`.

- [ ] **Step 4:** Failing integration test — a Cisco switch on `15.2(7)E5` below a fixed `15.2(7)E6` flags the advisory's CVE in `network_device_vulnerabilities`; one at/above (`15.2(7)E6`) does not. Implement `correlateNetworkDevices` (comparator selected by `vendor`), reuse the resolve-patched union pattern from `correlateOrg`. Re-run → PASS.

- [ ] **Step 5: Commit** the table, migration, allowlist/cascade wiring, and `correlateNetworkDevices` together.

---

### Task 5: UI + events (extend Phase 3/4 surfaces)

- [ ] **Step 1:** Surface network-device vulns in the fleet dashboard (filter by asset type) and on a network-device detail view (if one exists post-topology-redesign — coordinate with branch `docs/1728-topology-redesign-spec`).
- [ ] **Step 2:** Emit `vulnerability.critical_detected` for network devices (reuse Phase 4 event).
- [ ] **Step 3:** E2E happy path. Commit.

---

## Self-Review

**Spec coverage (v2 Scope boundary → network devices):**
- `sysDescr` firmware parsing (with provenance) → Task 1. ✅ (gated)
- `network_device_firmware` table (BE-30 contract reconciled) → Task 0 Step 2 + Task 2. ✅ (gated / BE-30)
- Vendor PSIRT + NVD facts → Task 3. ✅
- Per-vendor version comparators (Cisco IOS train, JunOS) → Task 4. ✅
- `network_device_vulnerabilities` sibling table + correlation → Task 0 + Task 4. ✅
- UI + events → Task 5. ✅

**Known risks / why this is "lighter" than Phases 1–4:**
- Depends on BE-30 deliverables that don't exist yet (firmware table, parsing). Task 0 resolves ownership AND reconciles the column-shape mismatch (BE-30's `assetId`/no-`vendor`/no-provenance sketch vs this plan's needs).
- Cisco/Juniper version formats are NOT dot-numeric — they need dedicated per-vendor comparators (the generic `compareBuilds` collapses them); built and tested in Task 4.
- Vendor PSIRT feeds each have their own auth/rate model (Cisco OAuth2) — more integration surface than NVD/OSV.

## Notes for the implementer

- **Do not start before BE-30 alignment.** Task 0 is a hard gate — ratify the sibling-table model AND reconcile the BE-30 `network_device_firmware` column contract first, or you'll build on a table that changes under you.
- **Reuse the matching engine, but NOT the generic version comparator for network gear.** Facts + the correlate/resolve pattern carry over; the genuinely new logic is firmware parsing (with provenance) and the per-vendor comparators (Cisco IOS train, JunOS). Do not route `15.2(7)E5` / `12.3R12` through `compareBuilds` — it collapses them.
- **Tenancy:** network-device vuln rows live in `network_device_vulnerabilities` and carry their own `org_id` (denormalized from `discovered_assets.org_id`); verify the forge test as `breeze_app` exactly as in Phase 1 Task 2.
```
