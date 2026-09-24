# Hardware & RAID Monitoring — W05 BMC In-band Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect daily in-band management-controller facts and associate the controller with its discovered asset without approving it, changing the host's classification, or merging their topology identities.

**Architecture:** Three tool adapters share a daily collector gate and execute in IPMI, Dell, HPE order until one returns a component. The existing hardware ingest transaction associates MAC-matched assets; the existing read view decorates BMC attributes with current association metadata for the Hardware tab. Discovery reconciliation and topology producers and validators preserve the distinction between a management controller and its host.

**Tech Stack:** Go standard library, PostgreSQL, Drizzle ORM, Hono, Vitest, React, react-i18next, jsdom.

**Spec:** `docs/superpowers/specs/monitoring/2026-09-23-hardware-raid-monitoring-design.md`.
**Index:** `docs/superpowers/plans/monitoring/2026-09-23-hardware-monitoring.md`.
**Wave:** W05, branch `feature/<parent#>-hardware-monitoring/wave-<sub#>` (feature-lifecycle fills these literal identifiers).
**Depends on:** W01, W02a, W04. W02b is not required; retain its sources if already present.

## Global Constraints

- Agent code ships to customer machines: `go test -race ./...`, fixture-driven parser tests, a
  native Windows run on VM `.55` for W02a/W02b/W05 (cross-compile has missed test bugs before).
- Web: `fetchWithAuth` from `apps/web/src/stores/auth.ts`; no react-query; inline pill idiom
  (`bg-success/15 text-success border-success/30` etc.); `data-testid` on everything e2e touches;
  mutation handlers via `runAction` (only the config tab mutates).
- Files stay under ~500 lines; new code goes in new files next to the pattern it copies.
- Run the contract suites before every PR that touches tenancy:
  `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`, the integration
  config (`vitest.integration.config.ts`) for cascade / export / merge, with `pnpm test-stack up`.

## Review Focus

The index's five numbered review-focus lines belong to W01, W02a and W03; none is assigned to W05. Index §I's W05 gates are pinned as follows:

- `approval branch checks existing.linkSource !== 'agent_report'` — Task 7, including a second scan.
- `services/topology/publish.ts ~195 and services/topology/aliasClusters.ts ~63 exclude linkSource === 'agent_report'` — Task 8, real-Postgres publication tests.
- `the classification-propagation site (plan locates it in processResults) skips agent_report` — Task 7, host role assertion and SQL guard.
- `runs on the RAID tier but at most once per 24 h (its own lastRun in the collector state file)` — Task 4, restart and failed-attempt tests.

Source audit: `discoveryWorker.ts:1173–1187` really does propagate classification; this is not an absent-code exception. `discoveryWorker.ts:985–990` currently omits linkSource, `:1136–1145` matches deviceNetwork, and `:1201` approves any linked asset. `aliasClusters.ts:6,70` and `publish.ts:197–201` accept linked inventory without provenance. The topology importer also manufactures those merges (`legacyReplay.ts:66,168`); Task 9 fixes the producer and the retained-identity splitter (`legacyIdentitySplit.ts:10,48`).

Decisions left to this plan: an occupied candidate returns `already_linked` even if another device owns it; it never authorizes reassignment. Duplicate eligible MACs return `no_asset` unless the reported IP uniquely disambiguates them; IP alone never establishes BMC identity. Same-site candidates outrank NULL-site candidates. `discoveredAssets.siteId` is currently NOT NULL (`db/schema/discovery.ts:146`), so NULL eligibility is unit-tested defensively without a schema change. Read-time `attributes.bmcLink` is server-derived `{status, assetId?, siteName?}`; overwrite any agent-supplied value, and never persist it. These are local helpers/attributes, not changes to the index's route, top-level view, or linker return union.

W01/W02a/W04 source files are not present in this checkout yet. Anchors for those future modifications explicitly refer to the checked-in predecessor **plan**, not fictitious source lines: W01 ingest transaction lines 1143–1175 and view lines 1288–1320; W02a Source lines 243–249, toolRunner line 293, persist lines 972–980, collector lines 1032–1081; W04 types lines 139–172 and StorageHealthSection lines 838–922. Re-anchor against implemented predecessors before execution; preserve the exact signatures below.

## File Structure

- Create `apps/api/migrations/2026-10-27-100400-discovered-asset-link-source-agent-report.sql` — enum label only.
- Modify `apps/api/src/db/schema/discovery.ts` — append the Drizzle label in database order.
- Modify `apps/api/vitest.integration.config.ts` — discover the three new colocated real-DB suites.
- Create `apps/api/src/services/discovery/agentReportedBmcLink.integration.test.ts` — migration, tenancy, association and ingest proofs.
- Create `apps/api/src/services/discovery/bmc.fixtures.ts` — real-DB test setup shared by this wave's suites; test-only imports.
- Create `apps/api/src/services/discovery/agentReportedBmcLink.ts` — normalized MAC, decision matrix, transaction-scoped linking and read decoration.
- Create `apps/api/src/services/discovery/agentReportedBmcLink.test.ts` — complete pure decision matrix.
- Modify `apps/api/src/services/hardwareHealth/ingest.ts` — BMC hook after accepted upserts, under the existing transaction.
- Modify `apps/api/src/services/hardwareHealth/view.ts` — current, server-derived association attributes.
- Modify `apps/api/src/jobs/discoveryWorker.ts` — BMC identity reconciliation, approval and classification gates.
- Modify `apps/api/src/jobs/discoveryWorker.test.ts` — query-chain and conditional-update mock compatibility.
- Create `apps/api/src/jobs/discoveryWorker.bmc.integration.test.ts` — scan-first/report-first/suppression and classification proofs.
- Modify `apps/api/src/services/topology/aliasClusters.ts` — reject BMC association as merge authority.
- Modify `apps/api/src/services/topology/publish.ts` — reject BMC association as shared-binding authority.
- Modify `apps/api/src/services/topology/legacyReplay.ts` — do not manufacture BMC aliases.
- Modify `apps/api/src/services/topology/legacyIdentitySplit.ts` — separate retained BMC identity.
- Create `apps/api/src/services/topology/bmc.integration.test.ts` — both publisher gates and normal importer proof.
- Modify `apps/api/src/services/topology/legacyIdentitySplit.test.ts` — retained-source split regression.
- Create `agent/internal/collectors/hwhealth/bmc.go` — parser and read-only command adapters.
- Create `agent/internal/collectors/hwhealth/bmc_linux.go`, `bmc_windows.go`, `bmc_other.go` in that directory — executable names and unsupported-platform stub.
- Create `agent/internal/collectors/hwhealth/bmc_test.go` — synthetic fixture/parser tests.
- Create `agent/internal/collectors/hwhealth/bmc_source_test.go` — command/cleanup/error tests.
- Create `agent/internal/collectors/hwhealth/bmc_schedule_test.go` — daily, restart, fallback and configuration tests.
- Modify `agent/internal/collectors/hwhealth/persist.go` — daily BMC attempt timestamp.
- Modify `agent/internal/collectors/hwhealth/collector.go` — ordered daily BMC group and default registration.
- Create `agent/internal/collectors/hwhealth/testdata/ipmi/{lan,info,no-bmc,driver-missing}.txt` — synthetic IPMI captures.
- Create `agent/internal/collectors/hwhealth/testdata/racadm/{nic,version,no-bmc}.txt` — synthetic Dell captures.
- Create `agent/internal/collectors/hwhealth/testdata/hponcfg/{export,no-bmc,malformed}.txt` — synthetic RIBCL and failure captures.
- Create `apps/web/src/components/devices/hardware/ManagementControllerCard.tsx` and `.test.tsx` — read-only facts and association presentation.
- Modify `apps/web/src/components/devices/hardware/StorageHealthSection.tsx` and `apps/web/src/components/devices/hardware/StorageHealthSection.test.tsx` — render the newest BMC observation.

All shell blocks start at the repo root in a fresh shell. Implementation snippets marked “replace” replace only the named block; other existing code stays. No new table, column, route, cascade registration or MCP entry is added in W05. Task 1 still runs existing registration contracts. Test-stack lifecycle commands are implementation-time commands, not instructions to start infrastructure merely while reading this plan.

### Task 1: Add the enum label and real-database test entry points

**Files:** Create `apps/api/migrations/2026-10-27-100400-discovered-asset-link-source-agent-report.sql`, `apps/api/src/services/discovery/bmc.fixtures.ts`, `apps/api/src/services/discovery/agentReportedBmcLink.integration.test.ts`; Modify `apps/api/src/db/schema/discovery.ts:60–63`, `apps/api/vitest.integration.config.ts:13`.
**Test:** `apps/api/src/services/discovery/agentReportedBmcLink.integration.test.ts`.
**Interfaces:** Consumes existing `createTopologyTenant()`, `orgContext(orgId: string): DbAccessContext`, `getTestDb()`. Produces `bmcFixture()` and `discoveredAssetLinkSourceEnum` with `agent_report` appended.

- [ ] **Step 1: Write a migration contract that starts red (5 minutes).** Create the integration file:
```ts
import '../../__tests__/integration/setup';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb } from '../../__tests__/integration/setup';
import { discoveredAssetLinkSourceEnum } from '../../db/schema/discovery';

it('appends agent_report through an enum-only idempotent migration', async () => {
  const path = new URL('../../../migrations/2026-10-27-100400-discovered-asset-link-source-agent-report.sql', import.meta.url);
  const ddl = readFileSync(path, 'utf8');
  expect(ddl.trim()).toBe("ALTER TYPE discovered_asset_link_source ADD VALUE IF NOT EXISTS 'agent_report';");
  await getTestDb().execute(sql.raw(ddl));
  await getTestDb().execute(sql.raw(ddl));
  const rows = await getTestDb().execute(sql`
    SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'discovered_asset_link_source' ORDER BY enumsortorder`);
  expect(rows.map(row => row.enumlabel)).toEqual(['manual', 'auto', 'agent_report']);
  expect(discoveredAssetLinkSourceEnum.enumValues).toEqual(['manual', 'auto', 'agent_report']);
});
```
Insert these exact entries into `test.include` (the latter two files are created in Tasks 7–8):
```ts
'src/services/discovery/agentReportedBmcLink.integration.test.ts',
'src/jobs/discoveryWorker.bmc.integration.test.ts',
'src/services/topology/bmc.integration.test.ts',
```
- [ ] **Step 2: Run red (2 minutes).**
```bash
pnpm test-stack up
cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/discovery/agentReportedBmcLink.integration.test.ts
```
Expected: `ENOENT` naming `2026-10-27-100400-discovered-asset-link-source-agent-report.sql`, not “No test files found”.
- [ ] **Step 3: Implement the complete migration and enum (2 minutes).** Migration:
```sql
ALTER TYPE discovered_asset_link_source ADD VALUE IF NOT EXISTS 'agent_report';
```
Replace only the enum declaration:
```ts
export const discoveredAssetLinkSourceEnum = pgEnum('discovered_asset_link_source', [
  'manual',
  'auto',
  'agent_report'
]);
```
- [ ] **Step 4: Create the reusable real-DB fixture (3 minutes).** `bmc.fixtures.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { getTestDb } from '../../__tests__/integration/setup';
import { createTopologyTenant, orgContext } from '../../__tests__/integration/topology-fixtures';
import { db, withDbAccessContext } from '../../db';
import { devices, discoveredAssets } from '../../db/schema';

export async function bmcFixture() {
  const tenant = await createTopologyTenant();
  const scope = { orgId: tenant.orgId, siteId: tenant.siteId };
  const [device] = await getTestDb().insert(devices).values({
    ...scope, agentId: randomUUID(), hostname: 'BMC fixture host',
    osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1',
    deviceRole: 'server', deviceRoleSource: 'auto',
  }).returning();
  const [asset] = await getTestDb().insert(discoveredAssets).values({
    ...scope, ipAddress: '192.0.2.10', macAddress: '02:00:00:00:00:10',
    approvalStatus: 'pending', assetType: 'unknown',
  }).returning();
  if (!device || !asset) throw new Error('BMC fixture insertion failed');
  return { ...tenant, scope, device, asset,
    scoped: <T>(work: () => Promise<T>) => withDbAccessContext(orgContext(tenant.orgId), work),
    input: { deviceId: device.id, orgId: tenant.orgId, siteId: tenant.siteId,
      mac: asset.macAddress!, ip: asset.ipAddress }, db,
  };
}
```
- [ ] **Step 5: Run green and migration/registration guards (3 minutes).**
```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/discovery/agentReportedBmcLink.integration.test.ts
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
```
Expected: all pass, enum order exactly `manual, auto, agent_report`; no baseline additions. Before commit run `ls apps/api/migrations | sort | tail -1` and compare the reserved slot with origin/main. The index requires moving an unshipped slot upward if main overtook it; update this file's references together if that happens. No data statement uses the new label inside the migration transaction.
- [ ] **Step 6: Commit (2 minutes).**
```bash
git add apps/api/migrations/2026-10-27-100400-discovered-asset-link-source-agent-report.sql apps/api/src/db/schema/discovery.ts apps/api/vitest.integration.config.ts apps/api/src/services/discovery/bmc.fixtures.ts apps/api/src/services/discovery/agentReportedBmcLink.integration.test.ts
git commit -m $'feat(discovery): add agent-reported BMC link provenance\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 2: Parse allowlisted BMC facts from synthetic vendor captures

**Files:** Create `agent/internal/collectors/hwhealth/bmc.go`, `agent/internal/collectors/hwhealth/bmc_test.go`, `agent/internal/collectors/hwhealth/testdata/ipmi/lan.txt`, `agent/internal/collectors/hwhealth/testdata/ipmi/info.txt`, `agent/internal/collectors/hwhealth/testdata/ipmi/no-bmc.txt`, `agent/internal/collectors/hwhealth/testdata/ipmi/driver-missing.txt`, `agent/internal/collectors/hwhealth/testdata/racadm/nic.txt`, `agent/internal/collectors/hwhealth/testdata/racadm/version.txt`, `agent/internal/collectors/hwhealth/testdata/racadm/no-bmc.txt`, `agent/internal/collectors/hwhealth/testdata/hponcfg/export.txt`, `agent/internal/collectors/hwhealth/testdata/hponcfg/no-bmc.txt`, `agent/internal/collectors/hwhealth/testdata/hponcfg/malformed.txt`.
**Test:** `agent/internal/collectors/hwhealth/bmc_test.go`.
**Interfaces:** Consumes W02a `Component`, `Kind`, `ptr[T any](v T) *T`, test helper `fixture(t *testing.T, source, name string) []byte`. Produces `parseBMC(kind Kind, network, info []byte) (Component, error)` and `errNoBMC` for Task 3.

- [ ] **Step 1: Write complete synthetic fixtures and parser tests (5 minutes).** The generator produces only the enumerated fixture files; no live addresses or credentials are used.
```bash
python3 - <<'PY'
from pathlib import Path
root = Path('agent/internal/collectors/hwhealth/testdata')
files = {
 'ipmi/lan.txt': 'IP Address Source : Static Address\nIP Address : 192.0.2.10\nMAC Address : 02:00:00:00:00:10\n',
 'ipmi/info.txt': 'Device ID : 32\nFirmware Revision : 2.80\nManufacturer Name : Dell Inc.\n',
 'ipmi/no-bmc.txt': 'No BMC found\n',
 'ipmi/driver-missing.txt': 'Could not open device at /dev/ipmi0 or /dev/ipmi/0 or /dev/ipmidev/0: No such file or directory\n',
 'racadm/nic.txt': 'NIC Enabled = 1\nIP Address = 192.0.2.11\nMAC Address = 02-00-00-00-00-11\n',
 'racadm/version.txt': 'iDRAC Version = 7.10.30.00\n',
 'racadm/no-bmc.txt': 'ERROR: Unable to communicate with iDRAC\n',
 'hponcfg/export.txt': '<RIBCL VERSION="2.0"><LOGIN USER_LOGIN="fixture" PASSWORD="redacted"><RIB_INFO MODE="write"><MOD_NETWORK_SETTINGS><IP_ADDRESS VALUE="192.0.2.12"/><MAC_ADDRESS VALUE="02:00:00:00:00:12"/></MOD_NETWORK_SETTINGS><GET_FW_VERSION><FIRMWARE_VERSION VALUE="2.99"/></GET_FW_VERSION></RIB_INFO></LOGIN></RIBCL>',
 'hponcfg/no-bmc.txt': 'ERROR: No iLO management processor found\n',
 'hponcfg/malformed.txt': '<RIBCL><IP_ADDRESS VALUE="192.0.2.12">',
}
for name, text in files.items():
 p = root/name
 p.parent.mkdir(parents=True, exist_ok=True)
 p.write_text(text)
PY
```
`bmc_test.go`:
```go
package hwhealth

import (
 "errors"
 "strings"
 "testing"
)

func TestBMCFixtures(t *testing.T) {
 for _, tc := range []struct{kind Kind; network, info, name, ip, mac, fw string}{
  {"ipmi", "lan.txt", "info.txt", "iDRAC", "192.0.2.10", "02:00:00:00:00:10", "2.80"},
  {"racadm", "nic.txt", "version.txt", "iDRAC", "192.0.2.11", "02:00:00:00:00:11", "7.10.30.00"},
  {"hponcfg", "export.txt", "", "iLO", "192.0.2.12", "02:00:00:00:00:12", "2.99"},
 } {
  t.Run(string(tc.kind), func(t *testing.T) {
   var info []byte
   if tc.info != "" { info = fixture(t, string(tc.kind), tc.info) }
   c, err := parseBMC(tc.kind, fixture(t, string(tc.kind), tc.network), info)
   if err != nil { t.Fatal(err) }
   if c.ComponentKey != "bmc:"+string(tc.kind) || c.ComponentType != "bmc" || c.Source != tc.kind || c.Name != tc.name || c.State != "ok" { t.Fatalf("%+v", c) }
   if c.Attributes["ip"] != tc.ip || c.Attributes["mac"] != tc.mac || c.Firmware == nil || *c.Firmware != tc.fw { t.Fatalf("%+v", c) }
   if len(c.Attributes) != 3 { t.Fatal("non-allowlisted export data", c.Attributes) }
  })
 }
}
func TestBMCNoHardwareAndMalformed(t *testing.T) {
 for _, tc := range []struct{kind Kind; file string}{
  {"ipmi", "no-bmc.txt"}, {"ipmi", "driver-missing.txt"},
  {"racadm", "no-bmc.txt"}, {"hponcfg", "no-bmc.txt"},
 } {
  if _, err := parseBMC(tc.kind, fixture(t, string(tc.kind), tc.file), nil); !errors.Is(err, errNoBMC) { t.Fatalf("%s: %v", tc.file, err) }
 }
 for _, raw := range [][]byte{nil, []byte("unrecognized output"), fixture(t,"hponcfg","malformed.txt"), []byte(strings.Repeat("x",4*1024*1024+1))} {
  if _, err := parseBMC("hponcfg", raw, nil); err == nil { t.Fatal("accepted invalid export") }
 }
}
func TestBMCHPEFirmwareBanner(t *testing.T) {
 c,err:=parseBMC("hponcfg",[]byte(`<RIBCL><IP_ADDRESS VALUE="192.0.2.12"/><MAC_ADDRESS VALUE="02:00:00:00:00:12"/></RIBCL>`),[]byte("Firmware Revision = 2.99\nDevice type = iLO"))
 if err!=nil||c.Firmware==nil||*c.Firmware!="2.99"{t.Fatal(c,err)}
}
func TestBMCUnknownVendorAndAbsentOptionalFacts(t *testing.T) {
 c, err := parseBMC("ipmi", []byte("IP Address : 0.0.0.0\nMAC Address : 00:00:00:00:00:00"), []byte("Device ID : 32\nManufacturer Name : Future Vendor"))
 if err != nil || c.Name != "BMC" || c.Firmware != nil { t.Fatal(c, err) }
 if c.Attributes["ip"] != "" || c.Attributes["mac"] != "" { t.Fatal(c.Attributes) }
 c, err = parseBMC("ipmi", fixture(t,"ipmi","lan.txt"), []byte("Manufacturer Name : Lenovo\nFirmware Revision : 1"))
 if err != nil || c.Name != "XClarity Controller" { t.Fatal(c, err) }
}
```
- [ ] **Step 2: Run red (2 minutes).**
```bash
cd agent && go test -race ./internal/collectors/hwhealth/...
```
Expected: `undefined: parseBMC` and `undefined: errNoBMC`.
- [ ] **Step 3: Implement bounded parsers (5 minutes).** Create `bmc.go`:
```go
package hwhealth

import (
 "bytes"
 "encoding/xml"
 "errors"
 "fmt"
 "io"
 "net"
 "regexp"
 "strings"
)

var errNoBMC = errors.New("BMC unavailable")
var bmcPair = regexp.MustCompile(`(?m)^\s*([^\r\n:=]+?)\s*[:=]\s*([^\r\n]*)`)

func bmcUnavailable(raw []byte) bool {
 s := strings.ToLower(string(raw))
 for _, phrase := range []string{"no bmc found", "could not open device at /dev/ipmi", "unable to communicate with idrac", "no ilo management processor found", "ipmi driver is not installed"} {
  if strings.Contains(s, phrase) { return true }
 }
 return false
}
func parseBMC(kind Kind, network, info []byte) (Component, error) {
 if len(network)+len(info) > 4*1024*1024 { return Component{}, errors.New("BMC output exceeds 4 MB") }
 if bmcUnavailable(network) || bmcUnavailable(info) { return Component{}, errNoBMC }
 values := map[string]string{}
 if kind == "hponcfg" {
  dec := xml.NewDecoder(bytes.NewReader(network))
  root := false
  for {
   tok, err := dec.Token()
   if err == io.EOF { break }
   if err != nil { return Component{}, errors.New("invalid BMC XML") }
   if start, ok := tok.(xml.StartElement); ok {
    key := strings.ToUpper(start.Name.Local)
    if key == "RIBCL" { root = true }
    if key == "IP_ADDRESS" || key == "MAC_ADDRESS" || key == "FIRMWARE_VERSION" || key == "FWRI" {
     for _, a := range start.Attr {
      if strings.EqualFold(a.Name.Local,"VALUE") { values[key] = strings.TrimSpace(a.Value) }
     }
    }
   }
  }
  if !root { return Component{}, errors.New("missing RIBCL root") }
 } else {
  raw := append(append([]byte{}, network...), '\n')
  raw = append(raw, info...)
  for _, pair := range bmcPair.FindAllSubmatch(raw, -1) {
   values[strings.ToLower(strings.TrimSpace(string(pair[1])))] = strings.TrimSpace(string(pair[2]))
  }
 }
 ip, mac, fw, vendor, name := "", "", "", "", "BMC"
 switch kind {
 case "ipmi":
  ip, mac, fw, vendor = values["ip address"], values["mac address"], values["firmware revision"], values["manufacturer name"]
  switch {
  case strings.Contains(strings.ToLower(vendor), "dell"): name = "iDRAC"
  case strings.Contains(strings.ToLower(vendor), "hewlett"), strings.Contains(strings.ToLower(vendor), "hpe"): name = "iLO"
  case strings.Contains(strings.ToLower(vendor), "lenovo"): name = "XClarity Controller"
  }
 case "racadm":
  ip, mac, fw, vendor, name = values["ip address"], values["mac address"], values["idrac version"], "Dell", "iDRAC"
 case "hponcfg":
  ip, mac, fw, vendor, name = values["IP_ADDRESS"], values["MAC_ADDRESS"], values["FIRMWARE_VERSION"], "HPE", "iLO"
  if fw == "" { fw = values["FWRI"] }
  if fw == "" {
   for _,pair:=range bmcPair.FindAllSubmatch(info,-1) {
    if strings.EqualFold(strings.TrimSpace(string(pair[1])),"Firmware Revision") {fw=strings.TrimSpace(string(pair[2]))}
   }
  }
 default: return Component{}, fmt.Errorf("unsupported BMC source %s", kind)
 }
 if ip == "" && mac == "" && fw == "" { return Component{}, errors.New("BMC facts missing") }
 parsedIP := net.ParseIP(ip)
 if parsedIP == nil || parsedIP.IsUnspecified() || parsedIP.IsMulticast() { ip = "" } else { ip = parsedIP.String() }
 parsedMAC, err := net.ParseMAC(mac)
 if err != nil || len(parsedMAC) != 6 || parsedMAC[0]&1 != 0 || bytes.Equal(parsedMAC,make([]byte,6)) { mac = "" } else { mac = parsedMAC.String() }
 c := Component{ComponentType:"bmc", ComponentKey:"bmc:"+string(kind), Source:kind,
  Name:name, State:"ok", Attributes:map[string]any{"ip":ip,"mac":mac,"vendor":vendor}}
 if fw != "" { c.Firmware = ptr(fw) }
 return c, nil
}
```
- [ ] **Step 4: Run green (2 minutes).**
```bash
cd agent && go test -race ./internal/collectors/hwhealth/...
```
Expected: `ok`; no exported LOGIN/password content escapes the three allowed attributes. These fixtures are synthetic, not live hardware proof.
- [ ] **Step 5: Commit (2 minutes).**
```bash
git add agent/internal/collectors/hwhealth/bmc.go agent/internal/collectors/hwhealth/bmc_test.go agent/internal/collectors/hwhealth/testdata/ipmi agent/internal/collectors/hwhealth/testdata/racadm agent/internal/collectors/hwhealth/testdata/hponcfg
git commit -m $'feat(agent): parse in-band BMC facts from vendor fixtures\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 3: Execute read-only commands with bounded private HPE exports

**Files:** Modify `agent/internal/collectors/hwhealth/bmc.go` (Task 2); Create `agent/internal/collectors/hwhealth/bmc_source_test.go`, `agent/internal/collectors/hwhealth/bmc_linux.go`, `agent/internal/collectors/hwhealth/bmc_windows.go`, `agent/internal/collectors/hwhealth/bmc_other.go`.
**Test:** `agent/internal/collectors/hwhealth/bmc_source_test.go`.
**Interfaces:** Consumes W02a `toolRunner func(context.Context,time.Duration,string,...string)(execResult,error)`, `lookupTool(names []string,extraDirs []string)(string,bool)`, `Source`. Produces `newBMC(kind Kind, extra []string, run toolRunner) Source`, `bmcToolNames(kind Kind) []string`.

- [ ] **Step 1: Write command and export-cleanup tests (5 minutes).**
```go
package hwhealth

import (
 "context"
 "errors"
 "os"
 "path/filepath"
 "reflect"
 "testing"
 "time"
)

func TestBMCCommands(t *testing.T) {
 for _, kind := range []Kind{"ipmi","racadm","hponcfg"} {
  t.Run(string(kind),func(t *testing.T) {
   calls := [][]string{}
   exported := ""
   runner := func(ctx context.Context, timeout time.Duration, path string, args ...string)(execResult,error) {
    if timeout != 20*time.Second { t.Fatal(timeout) }
    if _, ok := ctx.Deadline(); !ok { t.Fatal("missing cycle deadline") }
    calls = append(calls, append([]string{},args...))
    if kind == "hponcfg" {
     if len(args)!=2 || args[0]!="-w" { t.Fatal(args) }
     exported=args[1]
     if err:=os.WriteFile(exported,fixture(t,"hponcfg","export.txt"),0600);err!=nil { t.Fatal(err) }
     return execResult{},nil
    }
    file:="lan.txt"; if len(calls)==2 { file="info.txt" }
    if kind=="racadm" { file="nic.txt";if len(calls)==2 {file="version.txt"} }
    return execResult{Stdout:fixture(t,string(kind),file)},nil
   }
   src:=newBMC(kind,nil,runner)
   result,err:=src.Collect(context.Background(),Availability{Available:true,Path:"fixture"})
   if err!=nil || !result.Complete || len(result.Components)!=1 || src.Name()!=kind || src.Tier()!=TierRAID { t.Fatal(result,err) }
   if kind=="ipmi" && !reflect.DeepEqual(calls,[][]string{{"lan","print","1"},{"mc","info"}}) { t.Fatal(calls) }
   if kind=="racadm" && !reflect.DeepEqual(calls,[][]string{{"getniccfg"},{"getversion"}}) { t.Fatal(calls) }
   if exported!="" { if _,err:=os.Stat(filepath.Dir(exported)); !os.IsNotExist(err) {t.Fatal("export directory retained",err)} }
  })
 }
}
func TestBMCCommandFailures(t *testing.T) {
 for _, variant:=range []string{"driver","exit","truncated","timeout","export-failed"} {
  t.Run(variant,func(t *testing.T) {
   path:=""; kind:=Kind("ipmi");if variant=="export-failed" {kind="hponcfg"}
   src:=newBMC(kind,nil,func(_ context.Context,_ time.Duration,_ string,args ...string)(execResult,error) {
    switch variant {
    case "driver":return execResult{ExitCode:1,Stderr:fixture(t,"ipmi","driver-missing.txt")},nil
    case "exit":return execResult{ExitCode:1,Stderr:[]byte("sensitive output")},nil
    case "truncated":return execResult{Truncated:true},nil
    case "timeout":return execResult{},context.DeadlineExceeded
    default:path=args[1];return execResult{},errors.New("failure")
    }
   })
   r,err:=src.Collect(context.Background(),Availability{Available:true,Path:"fixture"})
   if err==nil || len(r.Components)!=0 || r.Complete {t.Fatal(r,err)}
   if variant=="driver" && !errors.Is(err,errNoBMC) {t.Fatal(err)}
   if path!="" {if _,err:=os.Stat(filepath.Dir(path));!os.IsNotExist(err){t.Fatal("failed export retained")}}
  })
 }
}
```
- [ ] **Step 2: Run red (2 minutes).**
```bash
cd agent && go test -race ./internal/collectors/hwhealth/...
```
Expected: `undefined: newBMC`.
- [ ] **Step 3: Implement the complete adapter (5 minutes).** Add `context`, `os`, `path/filepath`, `time` to `bmc.go` imports; append:
```go
func newBMC(kind Kind, extra []string, run toolRunner) Source {
 return &source{kind:kind,tier:TierRAID,
  detect:func(context.Context) Availability {
   p,ok:=lookupTool(bmcToolNames(kind),extra)
   return Availability{Path:p,Available:ok}
  },
  collect:func(parent context.Context,a Availability)(Result,error) {
   ctx,cancel:=context.WithTimeout(parent,20*time.Second);defer cancel()
   query:=func(args ...string)([]byte,error) {
    out,err:=run(ctx,20*time.Second,a.Path,args...)
    if err!=nil {return nil,fmt.Errorf("BMC command failed: %w",err)}
    if out.Truncated {return nil,errors.New("BMC output truncated")}
    if bmcUnavailable(out.Stdout)||bmcUnavailable(out.Stderr){return nil,errNoBMC}
    if out.ExitCode!=0 {return nil,fmt.Errorf("BMC command exit %d",out.ExitCode)}
    return out.Stdout,nil
   }
   var network,info []byte
   var err error
   switch kind {
   case "ipmi":
    network,err=query("lan","print","1")
    if err==nil {info,err=query("mc","info")}
   case "racadm":
    network,err=query("getniccfg")
    if err==nil {info,err=query("getversion")}
   case "hponcfg":
    dir,e:=os.MkdirTemp("","breeze-bmc-");if e!=nil{return Result{},e}
    defer os.RemoveAll(dir)
    path:=filepath.Join(dir,"ribcl.xml")
    info,err=query("-w",path)
    if err==nil {
     f,e:=os.Open(path);if e!=nil{return Result{},errors.New("BMC export not readable")}
     network,err=io.ReadAll(io.LimitReader(f,4*1024*1024+1));_ = f.Close()
    }
   default:return Result{},errors.New("unsupported BMC tool")
   }
   if err!=nil{return Result{},err}
   c,err:=parseBMC(kind,network,info);if err!=nil{return Result{},err}
   return Result{Components:[]Component{c},Complete:true},nil
  },
 }
}
```
- [ ] **Step 4: Add executable-name files (2 minutes).** `bmc_linux.go`:
```go
//go:build linux

package hwhealth

func bmcToolNames(kind Kind) []string {
 switch kind {
 case "ipmi":return []string{"ipmitool"}
 case "racadm":return []string{"racadm"}
 case "hponcfg":return []string{"hponcfg"}
 default:return nil
 }
}
```
`bmc_windows.go`:
```go
//go:build windows

package hwhealth

func bmcToolNames(kind Kind) []string {
 switch kind {
 case "ipmi":return []string{"ipmitool.exe","ipmitool"}
 case "racadm":return []string{"racadm.exe","racadm"}
 case "hponcfg":return []string{"hponcfg.exe","hponcfg"}
 default:return nil
 }
}
```
`bmc_other.go`:
```go
//go:build !windows && !linux

package hwhealth

func bmcToolNames(Kind) []string { return nil }
```
- [ ] **Step 5: Run green (2 minutes).**
```bash
cd agent && go test -race ./internal/collectors/hwhealth/...
```
Expected: `ok`; every HPE path is removed on success and failure; no `-g`, credentials, remote host, or shell command is passed.
- [ ] **Step 6: Commit (2 minutes).**
```bash
git add agent/internal/collectors/hwhealth/bmc.go agent/internal/collectors/hwhealth/bmc_source_test.go agent/internal/collectors/hwhealth/bmc_linux.go agent/internal/collectors/hwhealth/bmc_windows.go agent/internal/collectors/hwhealth/bmc_other.go
git commit -m $'feat(agent): collect BMC facts with bounded local commands\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 4: Persist a daily BMC attempt gate and preserve fallback order

**Files:** Modify `agent/internal/collectors/hwhealth/persist.go`, `agent/internal/collectors/hwhealth/collector.go` (W02a plan lines 972,1038,1059–1073); Create `agent/internal/collectors/hwhealth/bmc_schedule_test.go`.
**Test:** `agent/internal/collectors/hwhealth/bmc_schedule_test.go`.
**Interfaces:** Consumes `New(opts Options) *Collector`, `(*Collector).Run(ctx context.Context,tiers []Tier)(*Snapshot,error)`, `writeJSON(path string,value any) error`, `diskState`. Produces `diskState.BMCLastRun time.Time`, `isBMCSource(Kind) bool`, `orderBMC([]Source) []Source`. Group attempt time is persisted before the first invocation, including failed attempts; subsequent daily-silent polls do not replay old facts or grant completeness.

- [ ] **Step 1: Write scheduling regressions (5 minutes).**
```go
package hwhealth

import (
 "context"
 "errors"
 "reflect"
 "testing"
 "time"
)

func TestBMCDailyFallbackSurvivesRestart(t *testing.T) {
 now:=time.Date(2026,9,23,12,0,0,0,time.UTC)
 calls:=[]Kind{}
 sources:=[]Source{fakeSource("mdadm",TierRAID,true,good)}
 for _,kind:=range []Kind{"hponcfg","racadm","ipmi"} {
  k:=kind
  sources=append(sources,fakeSource(k,TierRAID,true,func(context.Context)(Result,error){
   calls=append(calls,k)
   if k=="ipmi" {return Result{},errNoBMC}
   return Result{Complete:true,Components:[]Component{{ComponentKey:"bmc:"+string(k),ComponentType:"bmc",Source:k,Name:"BMC",State:"ok",Attributes:map[string]any{}}}},nil
  }))
 }
 opts:=Options{DataDir:t.TempDir(),Sources:sources,Now:func()time.Time{return now}}
 c:=New(opts);c.state.Next="hponcfg"
 first,err:=c.Run(context.Background(),[]Tier{TierRAID})
 if err!=nil || first==nil || !reflect.DeepEqual(calls,[]Kind{"ipmi","racadm"}) || len(first.Components)!=1 {t.Fatal(first,err,calls)}
 if c.breakers["ipmi"].failures!=0 {t.Fatal("driver absence tripped breaker")}
 c=New(opts)
 now=now.Add(24*time.Hour-time.Nanosecond)
 next,err:=c.Run(context.Background(),[]Tier{TierRAID})
 if err!=nil || len(calls)!=2 || len(next.Components)!=0 {t.Fatal(next,err,calls)}
 for _,s:=range next.Sources {if isBMCSource(s.Source){t.Fatal("replayed daily source",s)}}
 now=now.Add(time.Nanosecond)
 if _,err=c.Run(context.Background(),[]Tier{TierRAID});err!=nil||len(calls)!=4 {t.Fatal(err,calls)}
}
func TestBMCFailureConsumesDailyAttempt(t *testing.T) {
 now:=time.Now();calls:=0;dir:=t.TempDir()
 sources:=[]Source{fakeSource("ipmi",TierRAID,true,func(context.Context)(Result,error){calls++;return Result{},errors.New("timeout")})}
 opts:=Options{DataDir:dir,Sources:sources,Now:func()time.Time{return now}}
 c:=New(opts)
 if _,err:=c.Run(context.Background(),[]Tier{TierDisk});err!=nil||calls!=0 {t.Fatal(err,calls)}
 if _,err:=c.Run(context.Background(),[]Tier{TierRAID});err!=nil||calls!=1 {t.Fatal(err,calls)}
 c=New(opts)
 if _,err:=c.Run(context.Background(),[]Tier{TierRAID});err!=nil||calls!=1 {t.Fatal(err,calls)}
 now=now.Add(24*time.Hour)
 if _,err:=c.Run(context.Background(),[]Tier{TierRAID});err!=nil||calls!=2 {t.Fatal(err,calls)}
 c.ApplyConfig(Config{false,10*time.Minute,time.Hour});now=now.Add(24*time.Hour)
 s,err:=c.Run(context.Background(),[]Tier{TierRAID})
 if err!=nil||calls!=2||s.TiersRun[0]!="disabled" {t.Fatal(s,err,calls)}
}
```
Append these tests to `bmc_schedule_test.go`; add `os` and `path/filepath` to its imports:
```go
func TestBMCStateFailureNeverRunsTool(t *testing.T) {
 dir:=t.TempDir();calls:=0
 c:=New(Options{DataDir:dir,Sources:[]Source{fakeSource("ipmi",TierRAID,true,func(context.Context)(Result,error){calls++;return good(context.Background())})}})
 blocker:=filepath.Join(dir,"hwhealth_state.json.tmp")
 if err:=os.Mkdir(blocker,0700);err!=nil{t.Fatal(err)}
 if snap,err:=c.Run(context.Background(),[]Tier{TierRAID});err==nil||snap!=nil||calls!=0||!c.state.BMCLastRun.IsZero(){t.Fatal(snap,err,calls)}
 if err:=os.Remove(blocker);err!=nil{t.Fatal(err)}
 if _,err:=c.Run(context.Background(),[]Tier{TierRAID});err!=nil||calls!=1{t.Fatal(err,calls)}
}
func TestBMCOrderPreservesFairnessRotation(t *testing.T) {
 kinds:=[]Kind{"ipmi","mdadm","hponcfg","racadm"}
 sources:=[]Source{}
 for _,k:=range kinds {sources=append(sources,fakeSource(k,TierRAID,true,good))}
 got:=[]Kind{}
 for _,src:=range orderBMC(sources){got=append(got,src.Name())}
 if !reflect.DeepEqual(got,[]Kind{"ipmi","racadm","hponcfg","mdadm"}){t.Fatal(got)}
 calls:=0
 hang:=fakeSource("mdadm",TierRAID,true,func(ctx context.Context)(Result,error){<-ctx.Done();return Result{},ctx.Err()})
 bmc:=fakeSource("ipmi",TierRAID,true,func(context.Context)(Result,error){calls++;return good(context.Background())})
 c:=New(Options{DataDir:t.TempDir(),Sources:[]Source{hang,bmc}});c.budget=10*time.Millisecond
 if _,err:=c.Run(context.Background(),[]Tier{TierRAID});err!=nil||calls!=0{t.Fatal(err,calls)}
 if c.state.Next!="ipmi"{t.Fatal(c.state.Next)}
 if _,err:=c.Run(context.Background(),[]Tier{TierRAID});err!=nil||calls!=1{t.Fatal("BMC starved after saved rotation",err,calls)}
}
```
- [ ] **Step 2: Run red (2 minutes).**
```bash
cd agent && go test -race ./internal/collectors/hwhealth/...
```
Expected: `undefined: isBMCSource` / `c.state.BMCLastRun undefined`; after those declarations exist, old scheduling calls hponcfg before ipmi and repeats after restart.
- [ ] **Step 3: Add state and stable tool ordering (3 minutes).** Add this field to `diskState`:
```go
BMCLastRun time.Time `json:"bmcLastRun"`
```
Append these helpers to `bmc.go`:
```go
func isBMCSource(k Kind) bool { return k=="ipmi" || k=="racadm" || k=="hponcfg" }
func orderBMC(sources []Source) []Source {
 group:=[]Source{}
 for _,k:=range []Kind{"ipmi","racadm","hponcfg"} {
  for _,s:=range sources {if s.Name()==k {group=append(group,s)}}
 }
 out:=make([]Source,0,len(sources));inserted:=false
 for _,s:=range sources {
  if isBMCSource(s.Name()) {
   if !inserted {out=append(out,group...);inserted=true}
  } else {out=append(out,s)}
 }
 return out
}
```
Inside `New`, after W02a's inline platform-default source construction and still within its `opts.Sources == nil` platform condition, append:
```go
c.sources=append(c.sources,newBMC("ipmi",opts.ExtraToolDirs,runTool),newBMC("racadm",opts.ExtraToolDirs,runTool),newBMC("hponcfg",opts.ExtraToolDirs,runTool))
```
- [ ] **Step 4: Replace the source loop with the complete daily-aware loop (5 minutes).** Add `errors` to collector imports. Replace W02a `ranTiers:=...` through the end of its source loop, leaving the surrounding merge/persistence code intact:
```go
order=orderBMC(order)
bmcDue:=c.state.BMCLastRun.IsZero() || now.Sub(c.state.BMCLastRun)>=24*time.Hour
bmcStarted,bmcAnswered:=false,false
ranTiers:=map[Tier]bool{};next:=Kind("")
for _,s:=range order {
 k:=s.Name();a:=available[k];report:=SourceReport{Source:k,Path:a.Path,ToolVersion:a.Version}
 if !cfg.Enabled {report.Status="disabled";snapshot.Sources=append(snapshot.Sources,report);continue}
 if isBMCSource(k) && (!requested[TierRAID] || !bmcDue) {continue}
 if !a.Available {report.Status="unavailable";snapshot.Sources=append(snapshot.Sources,report);continue}
 if (k=="perccli" && available["storcli"].Available) || (isBMCSource(k) && bmcAnswered) {
  report.Status="superseded";snapshot.Sources=append(snapshot.Sources,report);continue
 }
 if !requested[s.Tier()] {continue};ranTiers[s.Tier()]=true;b:=c.breakers[k]
 if b.blocked(now) {report.Status="backing_off";report.Error=b.lastError;report.RetryAt=ptr(b.retryAt);snapshot.Sources=append(snapshot.Sources,report);continue}
 if ctx.Err()!=nil {report.Status="failed";report.Error="budget exceeded";if next==""{next=k};snapshot.Sources=append(snapshot.Sources,report);continue}
 if isBMCSource(k) && !bmcStarted {
  pending:=c.state;pending.BMCLastRun=now
  if err:=writeJSON(filepath.Join(c.dir,"hwhealth_state.json"),pending);err!=nil{return nil,fmt.Errorf("persist BMC attempt: %w",err)}
  c.state=pending;bmcStarted=true
 }
 start:=time.Now()
 r,e:=collectors.Guard("hwhealth."+string(k),func()(Result,error){return s.Collect(ctx,a)})
 report.DurationMs=time.Since(start).Milliseconds();report.Warnings=r.Warnings
 if r.ToolVersion!="" {report.ToolVersion=r.ToolVersion}
 if isBMCSource(k) && errors.Is(e,errNoBMC) {
  report.Status="unavailable"
 } else if e!=nil && len(r.Components)==0 {
  report.Status="failed";report.Error=e.Error();b.finish(now,e)
 } else {
  report.Status="ok";report.Complete=ptr(r.Complete&&e==nil)
  if e!=nil {report.Warnings=append(report.Warnings,e.Error())}
  snapshot.Components=append(snapshot.Components,r.Components...);b.finish(now,nil)
  if isBMCSource(k) && len(r.Components)>0 {bmcAnswered=true}
 }
 snapshot.Sources=append(snapshot.Sources,report)
}
```
If W02b has landed, retain its Broadcom-family suppression branch verbatim before `!requested[s.Tier()]`; the BMC branch does not replace W02b precedence. BMC tools share the existing four-minute cycle context; each tool adapter has one twenty-second budget for its command pair. Persisting before execution favors the specified at-most-once property after a crash; no fictitious successful observation is emitted on restart.
- [ ] **Step 5: Run green and native agent checks (3 minutes to launch each).**
```bash
cd agent && go test -race ./internal/collectors/hwhealth/...
cd agent && go test -race ./...
cd agent && go vet ./...
```
Expected: all exit 0. Execute the same `go test -race ./internal/collectors/hwhealth/...` and `go vet ./...` commands from `agent` on the configured native Windows test VM; record the real output in the W05 issue. Cross-compilation is not that check. Do not put a machine address in tracked code or this plan.
- [ ] **Step 6: Commit (2 minutes).**
```bash
git add agent/internal/collectors/hwhealth/bmc.go agent/internal/collectors/hwhealth/bmc_schedule_test.go agent/internal/collectors/hwhealth/collector.go agent/internal/collectors/hwhealth/persist.go
git commit -m $'feat(agent): persist daily ordered BMC collection attempts\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 5: Implement the scoped, idempotent BMC association matrix

**Files:** Create `apps/api/src/services/discovery/agentReportedBmcLink.ts`, `apps/api/src/services/discovery/agentReportedBmcLink.test.ts`; Modify `apps/api/src/services/discovery/agentReportedBmcLink.integration.test.ts` created in Task 1.
**Test:** `apps/api/src/services/discovery/agentReportedBmcLink.test.ts`, `apps/api/src/services/discovery/agentReportedBmcLink.integration.test.ts`.
**Interfaces:** Produces exact §I `linkBmcAssetFromAgentReport(tx, {deviceId,orgId,siteId,mac,ip}): Promise<'linked'|'already_linked'|'suppressed'|'no_asset'|'other_site'>`; `BmcLinkTx`, `BmcReport`, `BmcCandidate`, `BmcLinkStatus`, `normalizeBmcMac`, `chooseBmcAsset`, `readBmcCandidates`. All names not in the index are explicitly created here.

- [ ] **Step 1: Write the full decision matrix (5 minutes).** `.test.ts`:
```ts
import { expect, it } from 'vitest';
import { chooseBmcAsset, normalizeBmcMac, type BmcCandidate } from './agentReportedBmcLink';
const report = { deviceId: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222', siteId: '33333333-3333-4333-8333-333333333333',
  mac: '02:00:00:00:00:10', ip: '192.0.2.10' };
const asset: BmcCandidate = { id: '44444444-4444-4444-8444-444444444444',
  orgId: report.orgId, siteId: report.siteId, macAddress: report.mac, ipAddress: report.ip,
  linkedDeviceId: null, autoLinkSuppressedAt: null };
it.each([
  [[], 'no_asset'],
  [[asset], 'linked'],
  [[{ ...asset, siteId: null }], 'linked'],
  [[{ ...asset, siteId: '55555555-5555-4555-8555-555555555555' }], 'other_site'],
  [[{ ...asset, orgId: '66666666-6666-4666-8666-666666666666' }], 'no_asset'],
  [[{ ...asset, macAddress: '02:00:00:00:00:11' }], 'no_asset'],
  [[{ ...asset, autoLinkSuppressedAt: new Date() }], 'suppressed'],
  [[{ ...asset, linkedDeviceId: report.deviceId }], 'already_linked'],
  [[{ ...asset, linkedDeviceId: '77777777-7777-4777-8777-777777777777' }], 'already_linked'],
  [[asset, { ...asset, id: '88888888-8888-4888-8888-888888888888' }], 'no_asset'],
] as const)('decides %j as %s', (rows, status) => {
  expect(chooseBmcAsset([...rows], report).status).toBe(status);
});
it('uses reported IP only to disambiguate matching MACs and prefers same site', () => {
  const second = { ...asset, id: '88888888-8888-4888-8888-888888888888', ipAddress: '192.0.2.11' };
  expect(chooseBmcAsset([asset, second], report).asset?.id).toBe(asset.id);
  expect(chooseBmcAsset([asset, { ...second, siteId: null }], { ...report, ip: null }).asset?.id).toBe(asset.id);
  expect(chooseBmcAsset([second], { ...report, mac: '' }).status).toBe('no_asset');
});
it.each([
 ['02-00-00-00-00-10','020000000010'], ['0200.0000.0010','020000000010'],
 [' 02:00:00:00:00:10 ','020000000010'], ['00:00:00:00:00:00',null],
 ['ff:ff:ff:ff:ff:ff',null], ['bad',null], ['',null], ['02:zz:00:00:00:10',null],
])('normalizes %s', (raw, expected) => expect(normalizeBmcMac(raw)).toBe(expected));
```
Append to the integration file (new imports may be combined with existing imports):
```ts
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { devices, discoveredAssets } from '../../db/schema';
import { orgContext } from '../../__tests__/integration/topology-fixtures';
import { bmcFixture } from './bmc.fixtures';
import { linkBmcAssetFromAgentReport } from './agentReportedBmcLink';

it('links once without approving; preserves suppression and occupied links', async () => {
  const f = await bmcFixture();
  const link = () => f.scoped(() => db.transaction(tx => linkBmcAssetFromAgentReport(tx, f.input)));
  expect(await link()).toBe('linked');
  expect(await link()).toBe('already_linked');
  let [asset] = await getTestDb().select().from(discoveredAssets).where(eq(discoveredAssets.id, f.asset.id));
  expect(asset).toMatchObject({ linkedDeviceId: f.device.id, linkSource: 'agent_report', approvalStatus: 'pending' });
  await getTestDb().update(discoveredAssets).set({ linkedDeviceId: null, linkSource: null, autoLinkSuppressedAt: new Date() }).where(eq(discoveredAssets.id, f.asset.id));
  expect(await link()).toBe('suppressed');
  [asset] = await getTestDb().select().from(discoveredAssets).where(eq(discoveredAssets.id, f.asset.id));
  expect(asset!.linkedDeviceId).toBeNull();
  const [other] = await getTestDb().insert(devices).values({ ...f.scope, agentId: crypto.randomUUID(), hostname:'other', osType:'linux',osVersion:'1',architecture:'amd64' }).returning();
  await getTestDb().update(discoveredAssets).set({ linkedDeviceId: other!.id, linkSource: 'manual', autoLinkSuppressedAt: null }).where(eq(discoveredAssets.id,f.asset.id));
  expect(await link()).toBe('already_linked');
  [asset] = await getTestDb().select().from(discoveredAssets).where(eq(discoveredAssets.id,f.asset.id));
  expect(asset).toMatchObject({ linkedDeviceId:other!.id, linkSource:'manual' });
});
it('cannot read or mutate another org through forged report arguments', async () => {
  const a=await bmcFixture(), b=await bmcFixture();
  const result=await withDbAccessContext(orgContext(a.orgId),()=>db.transaction(tx=>linkBmcAssetFromAgentReport(tx,b.input)));
  expect(result).toBe('no_asset');
  await a.scoped(async()=>{
    expect(await db.select().from(discoveredAssets).where(eq(discoveredAssets.id,b.asset.id))).toEqual([]);
  });
  await expect(a.scoped(()=>db.insert(discoveredAssets).values({ ...b.scope,ipAddress:'192.0.2.99' }))).rejects.toMatchObject({cause:{code:'42501'}});
});
it('serializes competing links so only one device obtains the asset', async () => {
  const f=await bmcFixture();
  const [other]=await getTestDb().insert(devices).values({ ...f.scope,agentId:crypto.randomUUID(),hostname:'other',osType:'linux',osVersion:'1',architecture:'amd64' }).returning();
  const results=await Promise.all([f.device.id,other!.id].map(deviceId=>f.scoped(()=>db.transaction(tx=>linkBmcAssetFromAgentReport(tx,{...f.input,deviceId})))));
  expect(results.sort()).toEqual(['already_linked','linked']);
});
```
- [ ] **Step 2: Run red (2 minutes).**
```bash
cd apps/api && npx vitest run src/services/discovery/agentReportedBmcLink.test.ts
cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/discovery/agentReportedBmcLink.integration.test.ts
```
Expected: missing `./agentReportedBmcLink` module.
- [ ] **Step 3: Implement identity normalization and deterministic selection (5 minutes).** Create `agentReportedBmcLink.ts`:
```ts
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { devices, discoveredAssets } from '../../db/schema';
export type BmcLinkTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type BmcLinkStatus = 'linked'|'already_linked'|'suppressed'|'no_asset'|'other_site';
export type BmcReport = { deviceId:string; orgId:string; siteId:string|null; mac:string; ip:string|null };
export type BmcCandidate = {
  id:string; orgId:string; siteId:string|null; macAddress:string|null;
  ipAddress:string|null; linkedDeviceId:string|null; autoLinkSuppressedAt:Date|null;
};
export function normalizeBmcMac(raw:string):string|null {
  const value=raw.trim().toLowerCase();
  if (!/^(?:[0-9a-f]{12}|(?:[0-9a-f]{2}:){5}[0-9a-f]{2}|(?:[0-9a-f]{2}-){5}[0-9a-f]{2}|(?:[0-9a-f]{4}\.){2}[0-9a-f]{4})$/.test(value)) return null;
  const normalized=value.replace(/[:.\-]/g,'');
  return normalized==='000000000000'||(parseInt(normalized.slice(0,2),16)&1)!==0?null:normalized;
}
export function chooseBmcAsset(rows:BmcCandidate[],report:BmcReport):{status:BmcLinkStatus;asset?:BmcCandidate} {
  const mac=normalizeBmcMac(report.mac);
  if (!mac) return {status:'no_asset'};
  const matching=rows.filter(r=>r.orgId===report.orgId&&r.macAddress&&normalizeBmcMac(r.macAddress)===mac);
  const same=matching.filter(r=>r.siteId===report.siteId);
  const eligible=same.length?same:matching.filter(r=>r.siteId===null);
  if (!eligible.length) return matching.length?{status:'other_site',asset:matching.length===1?matching[0]:undefined}:{status:'no_asset'};
  const byIP=eligible.filter(r=>report.ip!==null&&r.ipAddress===report.ip);
  const selected=eligible.length===1?eligible[0]:byIP.length===1?byIP[0]:undefined;
  if (!selected) return {status:'no_asset'};
  if (selected.autoLinkSuppressedAt) return {status:'suppressed',asset:selected};
  if (selected.linkedDeviceId) return {status:'already_linked',asset:selected};
  return {status:'linked',asset:selected};
}
export async function readBmcCandidates(tx:Pick<typeof db,'select'>,orgId:string,mac:string) {
  const normalized=normalizeBmcMac(mac);
  if (!normalized) return [];
  return tx.select().from(discoveredAssets).where(and(eq(discoveredAssets.orgId,orgId),
    sql`lower(regexp_replace(${discoveredAssets.macAddress}, '[:.\-]', '', 'g')) = ${normalized}`));
}
```
- [ ] **Step 4: Append the transaction-scoped writer (5 minutes).**
```ts
export async function linkBmcAssetFromAgentReport(tx:BmcLinkTx,report:BmcReport):Promise<'linked'|'already_linked'|'suppressed'|'no_asset'|'other_site'> {
  const normalized=normalizeBmcMac(report.mac);
  if (!normalized) return 'no_asset';
  const [device]=await tx.select({id:devices.id,siteId:devices.siteId}).from(devices)
    .where(and(eq(devices.id,report.deviceId),eq(devices.orgId,report.orgId))).limit(1).for('share');
  if (!device||device.siteId!==report.siteId) return 'no_asset';
  const rows=await tx.select().from(discoveredAssets).where(and(eq(discoveredAssets.orgId,report.orgId),
    sql`lower(regexp_replace(${discoveredAssets.macAddress}, '[:.\-]', '', 'g')) = ${normalized}`))
    .orderBy(discoveredAssets.id).for('update');
  const choice=chooseBmcAsset(rows,report);
  if (choice.status!=='linked'||!choice.asset) return choice.status;
  const updated=await tx.update(discoveredAssets).set({linkedDeviceId:report.deviceId,linkSource:'agent_report',updatedAt:new Date()})
    .where(and(eq(discoveredAssets.id,choice.asset.id),eq(discoveredAssets.orgId,report.orgId),
      isNull(discoveredAssets.linkedDeviceId),isNull(discoveredAssets.autoLinkSuppressedAt)))
    .returning({id:discoveredAssets.id});
  if (!updated.length) throw new Error('BMC link changed while locked');
  return 'linked';
}
```
Suppression and link occupancy are checked under a row lock, and the update rechecks both. The caller never elevates scope. The device SHARE lock serializes site moves as well as org moves; KEY SHARE alone would not protect a non-key site change. Read and write org predicates complement RLS; they do not replace it.
- [ ] **Step 5: Run green (2 minutes).**
```bash
cd apps/api && npx vitest run src/services/discovery/agentReportedBmcLink.test.ts
cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/discovery/agentReportedBmcLink.integration.test.ts
```
Expected: all matrix and concurrency assertions pass; forged insert returns PostgreSQL `42501`.
- [ ] **Step 6: Commit (2 minutes).**
```bash
git add apps/api/src/services/discovery/agentReportedBmcLink.ts apps/api/src/services/discovery/agentReportedBmcLink.test.ts apps/api/src/services/discovery/agentReportedBmcLink.integration.test.ts
git commit -m $'feat(discovery): associate BMC assets with scoped agent reports\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 6: Connect ingest and expose current association metadata in the view

**Files:** Modify `apps/api/src/services/hardwareHealth/ingest.ts` (W01 plan:1143–1175), `apps/api/src/services/hardwareHealth/view.ts` (W01 plan:1288–1320), `apps/api/src/services/discovery/agentReportedBmcLink.ts` and `apps/api/src/services/discovery/agentReportedBmcLink.integration.test.ts` (Task 5).
**Test:** `apps/api/src/services/discovery/agentReportedBmcLink.integration.test.ts`.
**Interfaces:** Consumes exact `ingestHardwareHealthSnapshot(input:{device:{id:string;orgId:string};snapshot:HardwareHealthSnapshot;writer:'agent'|'server';receivedAt:Date}):Promise<IngestResult>` and `getDeviceHardwareHealthView(deviceId:string,opts?:{eventLimit?:number}):Promise<HardwareHealthView|null>`. Produces `bmcViewAttributes(report:BmcReport,attributes:Record<string,unknown>):Promise<Record<string,unknown>>`; `attributes.bmcLink` contains `status:BmcLinkStatus`, optional `assetId:string`, optional `siteName:string`. No top-level response field is added.

- [ ] **Step 1: Append ingest and read-model tests (5 minutes).**
```ts
import { hardwareHealthSnapshotSchema } from '@breeze/shared';
import { createSite } from '../../__tests__/integration/db-utils';
import { deviceHardwareComponents } from '../../db/schema';
import { ingestHardwareHealthSnapshot } from '../hardwareHealth/ingest';
import { getDeviceHardwareHealthView } from '../hardwareHealth/view';

it('links accepted BMC observations, rejects stale side effects, and reads unlink live', async()=>{
 const f=await bmcFixture();
 const snapshot=hardwareHealthSnapshotSchema.parse({snapshotId:crypto.randomUUID(),sequence:1,
  collectedAt:new Date().toISOString(),agentVersion:'test',pollIntervalMinutes:10,diskHealthIntervalMinutes:60,
  tiersRun:['raid'],sources:[{source:'ipmi',status:'ok',complete:true}],components:[{
   componentKey:'bmc:ipmi',componentType:'bmc',source:'ipmi',name:'BMC',state:'ok',
   attributes:{mac:f.input.mac,ip:f.input.ip,vendor:'Dell',bmcLink:{status:'linked',assetId:crypto.randomUUID()}},
  }]});
 const send=()=>f.scoped(()=>ingestHardwareHealthSnapshot({device:f.device,snapshot,writer:'agent',receivedAt:new Date()}));
 expect(await send()).toMatchObject({accepted:true});
 const read=()=>f.scoped(()=>getDeviceHardwareHealthView(f.device.id));
 expect((await read())!.components[0]!.attributes.bmcLink).toEqual({status:'already_linked',assetId:f.asset.id});
 await getTestDb().update(discoveredAssets).set({linkedDeviceId:null,linkSource:null,autoLinkSuppressedAt:new Date()}).where(eq(discoveredAssets.id,f.asset.id));
 expect(await send()).toEqual({accepted:false,reason:'stale_snapshot'});
 expect((await read())!.components[0]!.attributes.bmcLink).toEqual({status:'suppressed'});
 const [stored]=await getTestDb().select().from(deviceHardwareComponents).where(eq(deviceHardwareComponents.deviceId,f.device.id));
 expect(stored!.attributes).not.toHaveProperty('bmcLink');
});
it('stores an other-site observation without linking and labels the site on read',async()=>{
 const f=await bmcFixture();
 const other=await createSite({orgId:f.orgId,name:'Secondary site'});
 await getTestDb().update(discoveredAssets).set({siteId:other.id}).where(eq(discoveredAssets.id,f.asset.id));
 expect(await f.scoped(()=>db.transaction(tx=>linkBmcAssetFromAgentReport(tx,f.input)))).toBe('other_site');
 const {bmcViewAttributes}=await import('./agentReportedBmcLink');
 expect(await f.scoped(()=>bmcViewAttributes(f.input,{mac:f.input.mac}))).toEqual({mac:f.input.mac,bmcLink:{status:'other_site',siteName:'Secondary site'}});
 const [asset]=await getTestDb().select().from(discoveredAssets).where(eq(discoveredAssets.id,f.asset.id));
 expect(asset!.linkedDeviceId).toBeNull();
});
```
- [ ] **Step 2: Run red (2 minutes).**
```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/discovery/agentReportedBmcLink.integration.test.ts
```
Expected: `bmcViewAttributes is not a function` or link metadata assertion fails; accepted W01 ingest alone does not link.
- [ ] **Step 3: Add the hook inside the existing transaction (5 minutes).** Add import:
```ts
import { linkBmcAssetFromAgentReport } from '../discovery/agentReportedBmcLink';
```
Replace the owner projection, retaining the existing `.for('key share')` and org predicate:
```ts
const [owner]=await tx.select({id:devices.id,siteId:devices.siteId}).from(devices)
 .where(and(eq(devices.id,device.id),eq(devices.orgId,device.orgId))).for('key share');
```
Replace the upsert loop with this complete loop; it runs only after the unchanged sequence rejection and `reduceSnapshot` validation:
```ts
for(const row of change.upserts){
 if(row.componentType==='bmc'){
  const {bmcLink:_untrusted,...facts}=row.attributes;
  row.attributes=facts;
 }
 const {id,createdAt,firstSeenAt,...update}=row;
 await tx.insert(deviceHardwareComponents).values(row).onConflictDoUpdate({
  target:[deviceHardwareComponents.deviceId,deviceHardwareComponents.componentKey],set:update,
 });
}
if(writer==='agent'){
 for(const component of snapshot.components){
  if(component.componentType!=='bmc'||typeof component.attributes.mac!=='string')continue;
  await linkBmcAssetFromAgentReport(tx,{
   deviceId:device.id,orgId:device.orgId,siteId:owner.siteId,mac:component.attributes.mac,
   ip:typeof component.attributes.ip==='string'?component.attributes.ip:null,
  });
 }
}
```
No catch converts a failed association write to a successful snapshot: a DB failure rolls back the health update, component writes and links together. A missing/suppressed/occupied asset is a normal union result and does not abort ingestion.
- [ ] **Step 4: Add current metadata projection (5 minutes).** Add `sites` to the linker schema import; append:
```ts
export async function bmcViewAttributes(report:BmcReport,attributes:Record<string,unknown>):Promise<Record<string,unknown>> {
 const {bmcLink:_untrusted,...facts}=attributes;
 const choice=chooseBmcAsset(await readBmcCandidates(db,report.orgId,report.mac),report);
 const metadata:{status:BmcLinkStatus;assetId?:string;siteName?:string}={status:choice.status};
 if(choice.asset?.linkedDeviceId===report.deviceId&&!choice.asset.autoLinkSuppressedAt&&choice.status==='already_linked'){
  metadata.assetId=choice.asset.id;
 } else if(choice.status==='other_site'&&choice.asset?.siteId){
  const [site]=await db.select({name:sites.name}).from(sites)
   .where(and(eq(sites.id,choice.asset.siteId),eq(sites.orgId,report.orgId))).limit(1);
  if(site)metadata.siteName=site.name;
 } else if(choice.status==='linked'){
  metadata.status='no_asset';
 }
 return {...facts,bmcLink:metadata};
}
```
Add `devices` to `view.ts`'s schema import and import the helper:
```ts
import { bmcViewAttributes } from '../discovery/agentReportedBmcLink';
```
Immediately after loading `rows` and before serialization, insert:
```ts
if(rows.some(row=>row.componentType==='bmc')){
 const [device]=await db.select({siteId:devices.siteId}).from(devices).where(eq(devices.id,deviceId)).limit(1);
 for(const row of rows){
  if(row.componentType!=='bmc')continue;
  row.attributes=await bmcViewAttributes({deviceId,orgId:row.orgId,siteId:device?.siteId??null,
   mac:typeof row.attributes.mac==='string'?row.attributes.mac:'',
   ip:typeof row.attributes.ip==='string'?row.attributes.ip:null,
  },row.attributes);
 }
}
```
This decorates only in-memory rows. The view's existing `fresh` calculation is unchanged; daily BMC facts are inventory, excluded from storage rollup and monitors by W01/W03. The card displays their observation time rather than claiming a live BMC health check.
- [ ] **Step 5: Run green (2 minutes).**
```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/discovery/agentReportedBmcLink.integration.test.ts src/services/hardwareHealth/ingest.integration.test.ts
cd apps/api && npx vitest run src/services/hardwareHealth/ingest.test.ts src/services/hardwareHealth/view.test.ts
```
Expected: all pass, including unchanged ordering tests and live suppression metadata.
- [ ] **Step 6: Commit (2 minutes).**
```bash
git add apps/api/src/services/hardwareHealth/ingest.ts apps/api/src/services/hardwareHealth/view.ts apps/api/src/services/discovery/agentReportedBmcLink.ts apps/api/src/services/discovery/agentReportedBmcLink.integration.test.ts
git commit -m $'feat(hardware): link BMC reports and expose current association facts\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 7: Reconcile later discoveries and protect approval and host classification

**Files:** Modify `apps/api/src/jobs/discoveryWorker.ts:985–990,1129–1187,1201–1210`; Modify `apps/api/src/jobs/discoveryWorker.test.ts:27,119,269,283,463–470,514–527`; Create `apps/api/src/jobs/discoveryWorker.bmc.integration.test.ts`.
**Test:** `apps/api/src/jobs/discoveryWorker.bmc.integration.test.ts`, `apps/api/src/jobs/discoveryWorker.test.ts`.
**Interfaces:** Consumes existing `processResults(data:ProcessResultsJobData):Promise<{newAssets:number;updatedAssets:number;durationMs:number}>`, Task 5 linker, W01 `deviceHardwareComponents`. No new public worker interface. Produces provenance-aware BMC MAC matching before deviceNetwork's ordinary IP/MAC match.

- [ ] **Step 1: Write the real scan harness and both arrival orders (5 minutes).**
```ts
import '../__tests__/integration/setup';
import { expect,it } from 'vitest';
import { and,eq } from 'drizzle-orm';
import { getTestDb } from '../__tests__/integration/setup';
import { bmcFixture } from '../services/discovery/bmc.fixtures';
import { db } from '../db';
import { devices,deviceHardwareComponents,deviceNetwork,discoveredAssets,discoveryJobs,discoveryProfiles } from '../db/schema';
import { processResults } from './discoveryWorker';
import { linkBmcAssetFromAgentReport } from '../services/discovery/agentReportedBmcLink';

async function scan(f:Awaited<ReturnType<typeof bmcFixture>>) {
 const [profile]=await getTestDb().insert(discoveryProfiles).values({...f.scope,name:'BMC fixture scan'}).returning();
 const [job]=await getTestDb().insert(discoveryJobs).values({...f.scope,profileId:profile!.id}).returning();
 const result=await f.scoped(()=>processResults({type:'process-results',jobId:job!.id,profileId:profile!.id,
  ...f.scope,hosts:[{ip:f.input.ip!,mac:f.input.mac,assetType:'printer',methods:['arp']}],hostsScanned:1,hostsDiscovered:1}));
 expect(result.updatedAssets+result.newAssets).toBe(1);
 return (await getTestDb().select().from(discoveredAssets).where(and(eq(discoveredAssets.orgId,f.orgId),eq(discoveredAssets.siteId,f.siteId),eq(discoveredAssets.ipAddress,f.input.ip!))))[0]!;
}
async function reportMac(f:Awaited<ReturnType<typeof bmcFixture>>) {
 await getTestDb().insert(deviceHardwareComponents).values({deviceId:f.device.id,orgId:f.orgId,
  componentKey:'bmc:ipmi',componentType:'bmc',source:'ipmi',name:'BMC',state:'ok',health:'ok',
  attributes:{mac:f.input.mac,ip:f.input.ip,vendor:'fixture'},firstSeenAt:new Date(),lastSeenAt:new Date()});
}
it('agent_report association remains pending through two scans and never changes host role',async()=>{
 const f=await bmcFixture();
 await f.scoped(()=>db.transaction(tx=>linkBmcAssetFromAgentReport(tx,f.input)));
 for(let i=0;i<2;i++)expect(await scan(f)).toMatchObject({linkedDeviceId:f.device.id,linkSource:'agent_report',approvalStatus:'pending'});
 const [host]=await getTestDb().select().from(devices).where(eq(devices.id,f.device.id));
 expect(host).toMatchObject({deviceRole:'server',deviceRoleSource:'auto'});
});
it('reconciles a later discovered MAC without taking the normal IP auto-approval path',async()=>{
 const f=await bmcFixture();await reportMac(f);
 await getTestDb().delete(discoveredAssets).where(eq(discoveredAssets.id,f.asset.id));
 await getTestDb().insert(deviceNetwork).values({deviceId:f.device.id,orgId:f.orgId,interfaceName:'fixture0',macAddress:'02:00:00:00:00:20',ipAddress:f.input.ip});
 expect(await scan(f)).toMatchObject({linkedDeviceId:f.device.id,linkSource:'agent_report',approvalStatus:'pending'});
 const [host]=await getTestDb().select().from(devices).where(eq(devices.id,f.device.id));
 expect(host).toMatchObject({deviceRole:'server',deviceRoleSource:'auto'});
});
it('keeps manually suppressed BMC assets unlinked on rescan',async()=>{
 const f=await bmcFixture();await reportMac(f);
 await getTestDb().update(discoveredAssets).set({autoLinkSuppressedAt:new Date()}).where(eq(discoveredAssets.id,f.asset.id));
 expect(await scan(f)).toMatchObject({linkedDeviceId:null,linkSource:null,approvalStatus:'pending'});
});
it('ordinary same-site NIC matching still links and approves',async()=>{
 const f=await bmcFixture();
 await getTestDb().insert(deviceNetwork).values({deviceId:f.device.id,orgId:f.orgId,interfaceName:'fixture0',macAddress:f.input.mac});
 expect(await scan(f)).toMatchObject({linkedDeviceId:f.device.id,linkSource:'auto',approvalStatus:'approved'});
});
```
- [ ] **Step 2: Run red (2 minutes).**
```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/jobs/discoveryWorker.bmc.integration.test.ts
```
Expected: `approvalStatus: 'approved'` instead of `'pending'` for a previously linked controller; report-MAC-only match remains absent or uses `auto`.
- [ ] **Step 3: Load provenance and reconcile BMC identity before NIC identity (5 minutes).** Add imports:
```ts
import { linkBmcAssetFromAgentReport, normalizeBmcMac } from '../services/discovery/agentReportedBmcLink';
```
Add `deviceHardwareComponents` to the existing schema import. Add `linkSource: discoveredAssets.linkSource` to the existing-asset SELECT at :985. Declare this beside `alreadyLinked` at :1052:
```ts
let bmcIdentityMatched=existing?.linkSource==='agent_report';
```
Inside the existing auto-link try block, before `const conditions = []`, insert:
```ts
const normalizedBmcMac=assetData.macAddress?normalizeBmcMac(assetData.macAddress):null;
if(normalizedBmcMac){
 const bmcMatches=await db.select({deviceId:deviceHardwareComponents.deviceId})
  .from(deviceHardwareComponents).innerJoin(devices,eq(devices.id,deviceHardwareComponents.deviceId))
  .where(and(eq(devices.orgId,data.orgId),eq(devices.siteId,data.siteId),
   eq(deviceHardwareComponents.orgId,data.orgId),eq(deviceHardwareComponents.componentType,'bmc'),
   eq(deviceHardwareComponents.stale,false),
   sql`lower(regexp_replace(${deviceHardwareComponents.attributes}->>'mac', '[:.\-]', '', 'g')) = ${normalizedBmcMac}`));
 const candidates=[...new Set(bmcMatches.map(row=>row.deviceId))];
 if(candidates.length){
  bmcIdentityMatched=true;
  if(candidates.length===1){
   await db.transaction(tx=>linkBmcAssetFromAgentReport(tx,{
    deviceId:candidates[0]!,orgId:data.orgId,siteId:data.siteId,
    mac:assetData.macAddress!,ip:assetData.ipAddress,
   }));
  }
 }
}
```
Replace `if (conditions.length > 0)` at :1135 with:
```ts
if (!bmcIdentityMatched && conditions.length > 0) {
```
This is an additional MAC identity source, not an OR with the device NICs that would lose provenance. Multiple hosts reporting the same controller MAC are deliberately not guessed. The BMC match flag blocks ordinary IP fallback even if no safe association can be made.
- [ ] **Step 4: Gate the actual SQL writes and approval shortcut (5 minutes).** Replace the ordinary link update at :1148–1152 with a conditional returning update; only enter the existing `autoLinkedDeviceId` assignment and classification block when a row was returned:
```ts
const linked=await db.update(discoveredAssets)
 .set({linkedDeviceId:match.deviceId,approvalStatus:'approved',linkSource:'auto'})
 .where(and(eq(discoveredAssets.id,upsertedAssetId),
  sql`${discoveredAssets.linkSource} IS DISTINCT FROM 'agent_report'`,
  sql`${discoveredAssets.linkedDeviceId} IS NULL`,
  sql`${discoveredAssets.autoLinkSuppressedAt} IS NULL`))
 .returning({id:discoveredAssets.id});
if(linked.length){
 autoLinkedDeviceId=match.deviceId;
 if(classification){
  await db.update(devices).set({
   deviceRole:sql`(select ${discoveredAssets.assetType} from ${discoveredAssets} where ${discoveredAssets.id} = ${upsertedAssetId})`,
   deviceRoleSource:'discovery',updatedAt:new Date(),
  }).where(and(eq(devices.id,match.deviceId),
   sql`coalesce(${devices.deviceRoleSource}, 'auto') not in ('manual', 'ai')`,
   sql`exists (select 1 from ${discoveredAssets} where ${discoveredAssets.id} = ${upsertedAssetId}
     and ${discoveredAssets.linkedDeviceId} = ${match.deviceId}
     and ${discoveredAssets.linkSource} IS DISTINCT FROM 'agent_report'
     and ${discoveredAssets.typeSource} <> 'manual' and ${discoveredAssets.assetType} <> 'unknown')`,
  ));
 }
}
```
Replace the entire `const decision = ...` at :1201–1210:
```ts
const decision = !bmcIdentityMatched && existing?.linkSource !== 'agent_report' && (autoLinkedDeviceId || alreadyLinked)
 ? {approvalStatus:'approved' as const,shouldAlert:false}
 : buildApprovalDecision({
    existingAsset:existingForApproval?{approvalStatus:existingForApproval.approvalStatus,macAddress:existingForApproval.macAddress}:null,
    incomingMac:host.mac,isKnownGuest:isGuest,alertSettings,
   });
```
At the subsequent `.set({... approvalStatus: decision.approvalStatus ...})`, replace just the approval field with a SQL guard against a concurrent ingest link made after the worker read:
```ts
approvalStatus: sql`CASE WHEN ${discoveredAssets.linkSource} = 'agent_report'
 THEN ${discoveredAssets.approvalStatus} ELSE ${decision.approvalStatus}::discovered_asset_approval_status END`,
```
This last guard is essential because the already-linked branch's earlier SELECT is not locked. A pending BMC remains pending; an operator-approved BMC remains approved.
- [ ] **Step 5: Keep existing worker unit tests faithful to the changed query chains (5 minutes).** Add this table to the schema mock and its name to the existing schema import:
```ts
deviceHardwareComponents:{
 deviceId:'deviceHardwareComponents.deviceId',orgId:'deviceHardwareComponents.orgId',
 componentType:'deviceHardwareComponents.componentType',stale:'deviceHardwareComponents.stale',
 attributes:'deviceHardwareComponents.attributes',
},
```
Also add `approvalStatus: 'discoveredAssets.approvalStatus'` inside the discoveredAssets mock. Add these test helpers after `makeSelectChain`:
```ts
function isBmcProjection(selection:unknown):boolean {
 return typeof selection==='object'&&selection!==null&&'deviceId' in selection
  && selection.deviceId===deviceHardwareComponents.deviceId;
}
function updateResult(){
 return Object.assign(Promise.resolve([]),{returning:()=>Promise.resolve([{id:'asset-1'}])});
}
```
Replace the type-source suite's `beforeEach` select implementation (:269–273):
```ts
vi.mocked(mockDb.select).mockImplementation((selection?:unknown)=>{
 if(isBmcProjection(selection))return makeSelectChain([]);
 return makeSelectChain(selectQueue[selectCallIndex++]??[],condition=>{
  capturedWherePredicates.push(condition);
 });
});
```
Replace the sibling-site test's special select implementation (:514–527):
```ts
vi.mocked(mockDb.select).mockImplementation((selection?:unknown)=>{
 if(isBmcProjection(selection))return makeSelectChain([]);
 const callIndex=selectCallIndex++;
 const initialRows=callIndex===7?[{deviceId:'sibling-site-device'}]:(selectQueue[callIndex]??[]);
 return makeSelectChain(initialRows,condition=>{
  capturedWherePredicates.push(condition);
  if(callIndex!==7)return;
  const leaves=collectSqlLeafStrings(condition);
  return leaves.includes('devices.siteId')&&leaves.includes('site-1')?[]:initialRows;
 });
});
```
Replace each exact `chain.where = () => Promise.resolve([]);` in this file (:283,510,561,588,770,822,909) with:
```ts
chain.where = () => updateResult();
```
Replace the role-propagation test's predicate-capturing where (:467–470):
```ts
chain.where=(w:unknown)=>{updateCalls.push({table,args,where:w});return updateResult();};
```
The empty BMC projection does not consume the pre-existing FIFO NIC-query fixtures; PostgreSQL integration tests above exercise the actual BMC query rather than mocking it.
- [ ] **Step 6: Run green and ordinary discovery regressions (2 minutes).**
```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/jobs/discoveryWorker.bmc.integration.test.ts
cd apps/api && npx vitest run src/jobs/discoveryWorker.test.ts
```
Expected: new gates pass, normal NIC auto-link remains approved, existing discovery tests pass.
- [ ] **Step 7: Commit (2 minutes).**
```bash
git add apps/api/src/jobs/discoveryWorker.ts apps/api/src/jobs/discoveryWorker.test.ts apps/api/src/jobs/discoveryWorker.bmc.integration.test.ts
git commit -m $'fix(discovery): keep BMC associations out of host approval and classification\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 8: Reject BMC association as topology merge or shared-binding authority

**Files:** Modify `apps/api/src/services/topology/aliasClusters.ts:6,70`, `apps/api/src/services/topology/publish.ts:197–201`; Create `apps/api/src/services/topology/bmc.integration.test.ts` (registered in Task 1).
**Test:** `apps/api/src/services/topology/bmc.integration.test.ts`.
**Interfaces:** Consumes existing `publishTopologyBuild(scope:TopologyScope,input:PublicationInput):Promise<{published:boolean;graphRevision:string}>` (`publish.ts:93`), `canonicalIdentityKey`, `planAcceptedAliasClusters(scope,input)` (`aliasClusters.ts:12–14`). Produces provenance filtering without changing public publication types or exception messages.

- [ ] **Step 1: Write both real-DB publication attempts and positive controls (5 minutes).**
```ts
import '../../__tests__/integration/setup';
import { expect,it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb } from '../../__tests__/integration/setup';
import { bmcFixture } from '../discovery/bmc.fixtures';
import { discoveredAssets,topologySiteState,topologyNodes,topologyNodeBindings } from '../../db/schema';
import { publishTopologyBuild, type NodePublication, type PublicationInput } from './publish';
import { canonicalIdentityKey } from './identity';

async function publication(source:'agent_report'|'manual'|'auto',mode:'alias'|'shared') {
 const f=await bmcFixture();
 await getTestDb().update(discoveredAssets).set({linkedDeviceId:f.device.id,linkSource:source}).where(eq(discoveredAssets.id,f.asset.id));
 await getTestDb().insert(topologySiteState).values({...f.scope,buildFence:0n,dirtyRevision:1n,materializedInputRevision:0n})
  .onConflictDoUpdate({target:[topologySiteState.orgId,topologySiteState.siteId],set:{buildFence:0n,dirtyRevision:1n,materializedInputRevision:0n}});
 const node=(sourceKey:string):NodePublication=>({id:crypto.randomUUID(),...f.scope,kind:'endpoint',
  identityKey:canonicalIdentityKey(f.scope,'endpoint',sourceKey),identityMaterial:{version:1,kind:'endpoint',sourceKey},attributes:{}});
 const host=node(`device:${f.device.id}`),bmc=node(`asset:${f.asset.id}`);
 const input:PublicationInput={buildFence:'0',inputRevision:'1',relationships:[],
  nodes:mode==='alias'?[host,{...bmc,aliasTargetId:host.id}]:[host],
  bindings:[{id:crypto.randomUUID(),...f.scope,nodeId:host.id,deviceId:f.device.id},
   {id:crypto.randomUUID(),...f.scope,nodeId:mode==='alias'?bmc.id:host.id,discoveredAssetId:f.asset.id}],
 };
 return {f,input};
}
it.each(['alias','shared'] as const)('rejects agent_report %s authority atomically',async mode=>{
 const {f,input}=await publication('agent_report',mode);
 const before=(await getTestDb().select().from(topologySiteState).where(eq(topologySiteState.siteId,f.siteId)))[0]!;
 await expect(f.scoped(()=>publishTopologyBuild(f.scope,input))).rejects.toThrow(mode==='alias'?'Canonical alias requires an accepted inventory link':'Shared endpoint bindings require an accepted inventory link');
 expect(await getTestDb().select().from(topologyNodes).where(eq(topologyNodes.siteId,f.siteId))).toEqual([]);
 expect(await getTestDb().select().from(topologyNodeBindings).where(eq(topologyNodeBindings.siteId,f.siteId))).toEqual([]);
 const after=(await getTestDb().select().from(topologySiteState).where(eq(topologySiteState.siteId,f.siteId)))[0]!;
 expect(after.graphRevision).toBe(before.graphRevision);
 expect(after.materializedInputRevision).toBe(before.materializedInputRevision);
});
it.each(['manual','auto'] as const)('still accepts %s identity authority',async source=>{
 const {f,input}=await publication(source,'shared');
 expect(await f.scoped(()=>publishTopologyBuild(f.scope,input))).toMatchObject({published:true});
});
```
- [ ] **Step 2: Run red (2 minutes).**
```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/topology/bmc.integration.test.ts
```
Expected: agent-report publication resolves rather than rejecting (`promise resolved ... instead of rejecting`).
- [ ] **Step 3: Gate alias membership (2 minutes).** Replace `AcceptedAsset` at `aliasClusters.ts:6`:
```ts
type AcceptedAsset = {
 id:string; linkedDeviceId:string|null; autoLinkSuppressedAt:Date|null;
 linkSource?:'manual'|'auto'|'agent_report'|null;
};
```
Replace the callback return at :70:
```ts
return !asset || asset.autoLinkSuppressedAt || asset.linkSource === 'agent_report'
 || asset.linkedDeviceId !== managed[0]!.deviceId;
```
Optional provenance preserves the existing pure planner callers and legacy NULL links. Database callers select all columns and therefore always carry the actual provenance.
- [ ] **Step 4: Gate shared bindings (2 minutes).** Replace only `publish.ts:200–201`'s `if` statement:
```ts
if (managed.length !== 1 || group.some(b => b.manualNodeId)
 || group.filter(b => b.discoveredAssetId).some(b => !assets.some(a =>
   a.id === b.discoveredAssetId && a.linkedDeviceId === managed[0]!.deviceId
   && !a.autoLinkSuppressedAt && a.linkSource !== 'agent_report'
 ))) throw new Error('Shared endpoint bindings require an accepted inventory link');
```
- [ ] **Step 5: Run green (2 minutes).**
```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/topology/bmc.integration.test.ts
cd apps/api && npx vitest run src/services/topology/aliasClusters.test.ts src/services/topology/publish.test.ts
```
Expected: both negative gates pass against actual PostgreSQL, both ordinary-provenance controls pass, existing pure planner tests stay green.
- [ ] **Step 6: Commit (2 minutes).**
```bash
git add apps/api/src/services/topology/aliasClusters.ts apps/api/src/services/topology/publish.ts apps/api/src/services/topology/bmc.integration.test.ts
git commit -m $'fix(topology): reject BMC association as shared identity authority\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 9: Keep topology replay and retained identity consistent with the gates

**Files:** Modify `apps/api/src/services/topology/legacyReplay.ts:66,168`, `apps/api/src/services/topology/legacyIdentitySplit.ts:10,48`, `apps/api/src/services/topology/legacyIdentitySplit.test.ts:1–25`, `apps/api/src/services/topology/bmc.integration.test.ts` (Task 8).
**Test:** `apps/api/src/services/topology/legacyIdentitySplit.test.ts`, `apps/api/src/services/topology/bmc.integration.test.ts`.
**Interfaces:** Consumes `importLegacyTopologySite(scope:TopologyScope,options:{batchSize?:number;resumeToken?:string}={}):Promise<LegacyImportResult>`, `drainTopologyOutbox(scope:TopologyScope,options:{throughRevision?:string;batchSize?:number}={}):Promise<LegacyImportResult>` (`legacyImport.ts:21,59`), `planLegacyIdentitySplits(scope,input)` (`legacyIdentitySplit.ts:19`). Produces agent-report-aware `SplitInventoryAsset`; no new queue, schema or identity key.

- [ ] **Step 1: Append an importer regression and a retained-source split regression (5 minutes).** Append to `bmc.integration.test.ts`:
```ts
import { importLegacyTopologySite,drainTopologyOutbox } from './legacyImport';

it('imports and drains a BMC association as two canonical endpoints',async()=>{
 const f=await bmcFixture();
 await getTestDb().update(discoveredAssets).set({linkedDeviceId:f.device.id,linkSource:'agent_report'}).where(eq(discoveredAssets.id,f.asset.id));
 expect((await f.scoped(()=>importLegacyTopologySite(f.scope,{batchSize:1000}))).complete).toBe(true);
 expect((await f.scoped(()=>drainTopologyOutbox(f.scope,{batchSize:1000}))).complete).toBe(true);
 const nodes=await getTestDb().select().from(topologyNodes).where(eq(topologyNodes.siteId,f.siteId));
 const host=nodes.find(n=>n.legacySourceId===f.device.id)!;
 const bmc=nodes.find(n=>n.legacySourceId===f.asset.id)!;
 expect(host).toBeDefined();expect(bmc).toBeDefined();
 expect(host.id).not.toBe(bmc.id);
 expect(host.aliasTargetId).toBeNull();expect(bmc.aliasTargetId).toBeNull();
 const bindings=await getTestDb().select().from(topologyNodeBindings).where(eq(topologyNodeBindings.siteId,f.siteId));
 expect(bindings.find(b=>b.deviceId===f.device.id)!.nodeId).toBe(host.id);
 expect(bindings.find(b=>b.discoveredAssetId===f.asset.id)!.nodeId).toBe(bmc.id);
});
```
Append inside the existing `legacyIdentitySplit.test.ts` describe; it uses that file's real `scope`, `device`, `asset`, `binding`, `deviceId`, `assetId`, `assetRef` fixtures:
```ts
it('separates retained BMC identity despite an agent_report association',()=>{
 const plan=planLegacyIdentitySplits(scope,{
  nodes:[device,{...asset,aliasTargetId:device.id}],
  bindings:[binding(deviceId,device.id,{deviceId}),binding(assetId,device.id,{discoveredAssetId:assetId})],
  liveDeviceIds:new Set([deviceId]),
  liveAssets:[{...assetRef(assetId,deviceId),linkSource:'agent_report'}],
 });
 expect(plan.nodeChanges).toEqual([{id:asset.id,aliasTargetId:null}]);
 expect(plan.bindingMoves).toEqual([{id:assetId,fromNodeId:device.id,toNodeId:asset.id,deviceId:null,discoveredAssetId:assetId}]);
});
```
- [ ] **Step 2: Run red (2 minutes).**
```bash
cd apps/api && npx vitest run src/services/topology/legacyIdentitySplit.test.ts
cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/topology/bmc.integration.test.ts
```
Expected: split produces no changes; importer throws `Canonical alias requires an accepted inventory link` at the Task 8 guard. This proves why downstream rejection alone is insufficient.
- [ ] **Step 3: Carry provenance into replay and stop BMC alias requests (3 minutes).** Replace the `liveAssets` SELECT at `legacyReplay.ts:66`:
```ts
const liveAssets = new Map((await db.select({
 id:discoveredAssets.id,linkedDeviceId:discoveredAssets.linkedDeviceId,
 suppressedAt:discoveredAssets.autoLinkSuppressedAt,linkSource:discoveredAssets.linkSource,
}).from(discoveredAssets).where(and(eq(discoveredAssets.orgId,scope.orgId),eq(discoveredAssets.siteId,scope.siteId)))).map(r=>[r.id,r]));
```
Replace the continue guard at :168:
```ts
if (!asset.linkedDeviceId || asset.suppressedAt || asset.linkSource === 'agent_report'
 || !liveDevices.has(asset.linkedDeviceId)) continue;
```
- [ ] **Step 4: Keep BMCs separate in the retained identity partition (2 minutes).** Replace `SplitInventoryAsset` at `legacyIdentitySplit.ts:10`:
```ts
export type SplitInventoryAsset = {
 id:string; linkedDeviceId:string|null; suppressedAt:Date|null;
 linkSource?:'manual'|'auto'|'agent_report'|null;
};
```
Replace its `componentOf` return at :48–49:
```ts
return asset.linkedDeviceId && !asset.suppressedAt && asset.linkSource !== 'agent_report'
 && input.liveDeviceIds.has(asset.linkedDeviceId)
 ? `device:${asset.linkedDeviceId}` : `asset:${id}`;
```
- [ ] **Step 5: Run green with existing full importer contracts (3 minutes).**
```bash
cd apps/api && npx vitest run src/services/topology/legacyIdentitySplit.test.ts src/services/topology/aliasClusters.test.ts
cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/topology/bmc.integration.test.ts src/__tests__/integration/topology-alias-clusters.integration.test.ts
```
Expected: two BMC canonical nodes and separate bindings; existing manual/auto clusters continue merging.
- [ ] **Step 6: Commit (2 minutes).**
```bash
git add apps/api/src/services/topology/legacyReplay.ts apps/api/src/services/topology/legacyIdentitySplit.ts apps/api/src/services/topology/legacyIdentitySplit.test.ts apps/api/src/services/topology/bmc.integration.test.ts
git commit -m $'fix(topology): preserve BMC nodes during legacy replay\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 10: Render the read-only management controller card

**Files:** Create `apps/web/src/components/devices/hardware/ManagementControllerCard.tsx`, `apps/web/src/components/devices/hardware/ManagementControllerCard.test.tsx`. Read-only anchors: `DeviceDetails.tsx:268–309` establishes `/devices/network/${asset.id}`; W04 `types.ts` plan:139–172 defines `HardwareComponentView`.
**Test:** `apps/web/src/components/devices/hardware/ManagementControllerCard.test.tsx`.
**Interfaces:** Consumes W04 `HardwareComponentView`, Task 6 `attributes.bmcLink`. Produces default `ManagementControllerCard({component}:{component:HardwareComponentView})`. It consumes the parent's fetched view; no extra fetch or mutation handler is needed.

- [ ] **Step 1: Write jsdom rendering and safe-link tests (5 minutes).**
```tsx
import { render,screen } from '@testing-library/react';
import { expect,it } from 'vitest';
import ManagementControllerCard from './ManagementControllerCard';
import { component } from './hardwareHealth.fixtures';
const assetId='44444444-4444-4444-8444-444444444444';
const bmc=(attributes:Record<string,unknown>={})=>component({componentKey:'bmc:ipmi',componentType:'bmc',
 source:'ipmi',name:'iDRAC',firmware:'2.80',attributes:{vendor:'Dell',ip:'192.0.2.10',mac:'02:00:00:00:00:10',...attributes}});
it('shows vendor, firmware, IP and MAC, linking only the asset page',()=>{
 render(<ManagementControllerCard component={bmc({bmcLink:{status:'already_linked',assetId}})} />);
 const card=screen.getByTestId('hardware-management-controller-card');
 expect(card).toHaveTextContent('Management controller');
 expect(card).toHaveTextContent('Dell');expect(card).toHaveTextContent('2.80');
 expect(card).toHaveTextContent('02:00:00:00:00:10');
 expect(screen.getByTestId('hardware-bmc-asset-link')).toHaveAttribute('href',`/devices/network/${assetId}`);
 expect(screen.getByTestId('hardware-bmc-asset-link')).toHaveTextContent('192.0.2.10');
});
it('shows the other-site note without suggesting a host identity link',()=>{
 render(<ManagementControllerCard component={bmc({bmcLink:{status:'other_site',siteName:'Secondary site'}})} />);
 expect(screen.getByTestId('hardware-bmc-other-site')).toHaveTextContent('Management controller found in site Secondary site');
 expect(screen.queryByTestId('hardware-bmc-asset-link')).not.toBeInTheDocument();
});
it.each(['no_asset','suppressed','already_linked'])('shows plain IP for %s without a verified asset id',status=>{
 render(<ManagementControllerCard component={bmc({bmcLink:{status}})} />);
 expect(screen.getByTestId('hardware-bmc-ip')).toHaveTextContent('192.0.2.10');
 expect(screen.queryByTestId('hardware-bmc-asset-link')).not.toBeInTheDocument();
});
it('handles absent optional facts and rejects malformed link metadata',()=>{
 render(<ManagementControllerCard component={component({componentType:'bmc',name:'BMC',firmware:null,
  attributes:{ip:'javascript:alert(1)',bmcLink:{status:'linked',assetId:'../../settings'}}})} />);
 expect(screen.queryByTestId('hardware-bmc-asset-link')).not.toBeInTheDocument();
 expect(screen.getByTestId('hardware-management-controller-card')).toHaveTextContent('BMC');
});
```
- [ ] **Step 2: Run red (2 minutes).**
```bash
cd apps/web && npx vitest run src/components/devices/hardware/ManagementControllerCard.test.tsx
```
Expected: `Failed to resolve import "./ManagementControllerCard"`.
- [ ] **Step 3: Implement the complete card (5 minutes).**
```tsx
import { useTranslation } from 'react-i18next';
import type { HardwareComponentView } from './types';

const text=(value:unknown)=>typeof value==='string'&&value.trim()?value:'—';
const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
export default function ManagementControllerCard({component}:{component:HardwareComponentView}) {
 const {t}=useTranslation('devices');
 const link=object(component.attributes.bmcLink);
 const assetId=typeof link.assetId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(link.assetId)?link.assetId:null;
 const linked=(link.status==='linked'||link.status==='already_linked')&&assetId;
 const ip=text(component.attributes.ip);
 return <section data-testid="hardware-management-controller-card" className="rounded-lg border bg-card p-4 space-y-3">
  <header className="flex flex-wrap items-baseline justify-between gap-2">
   <h4 className="font-medium">{t('hardwareHealth.managementController',{defaultValue:'Management controller'})}</h4>
   <span className="text-sm text-muted-foreground">{component.name}</span>
  </header>
  <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
   <div><dt className="text-muted-foreground">{t('hardwareHealth.bmcVendor',{defaultValue:'Vendor'})}</dt>
    <dd>{text(component.attributes.vendor)}</dd></div>
   <div><dt className="text-muted-foreground">{t('hardwareHealth.bmcFirmware',{defaultValue:'Firmware'})}</dt>
    <dd>{text(component.firmware)}</dd></div>
   <div><dt className="text-muted-foreground">{t('hardwareHealth.bmcIp',{defaultValue:'IP address'})}</dt>
    <dd data-testid="hardware-bmc-ip">{linked?<a data-testid="hardware-bmc-asset-link"
     href={`/devices/network/${assetId}`} className="text-primary hover:underline">{ip==='—'?component.name:ip}</a>:ip}</dd></div>
   <div><dt className="text-muted-foreground">{t('hardwareHealth.bmcMac',{defaultValue:'MAC address'})}</dt>
    <dd className="break-all font-mono">{text(component.attributes.mac)}</dd></div>
  </dl>
  {link.status==='other_site'&&typeof link.siteName==='string'&&<p data-testid="hardware-bmc-other-site" className="text-sm text-muted-foreground">
   {t('hardwareHealth.bmcOtherSite',{defaultValue:'Management controller found in site {{site}}',site:link.siteName})}
  </p>}
  <p className="text-xs text-muted-foreground">
   {t('hardwareHealth.bmcObserved',{defaultValue:'Last reported {{time}}; collected daily.',time:new Date(component.lastSeenAt).toLocaleString()})}
  </p>
 </section>;
}
```
All new strings use translation keys with explicit English defaults, matching the fallback behavior without altering W04's existing key contract. The daily observation label describes facts, not a live BMC reachability verdict. React escapes vendor text and site names; the link target always uses a validated UUID under the local network-device route.
- [ ] **Step 4: Run green (2 minutes).**
```bash
cd apps/web && npx vitest run src/components/devices/hardware/ManagementControllerCard.test.tsx
```
Expected: six test cases pass; no direct IP hyperlink and no controls that would require `runAction`.
- [ ] **Step 5: Commit (2 minutes).**
```bash
git add apps/web/src/components/devices/hardware/ManagementControllerCard.tsx apps/web/src/components/devices/hardware/ManagementControllerCard.test.tsx
git commit -m $'feat(web): show management controller facts and asset association\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 11: Mount the card in Storage & RAID and verify the wave contracts

**Files:** Modify `apps/web/src/components/devices/hardware/StorageHealthSection.tsx` and `apps/web/src/components/devices/hardware/StorageHealthSection.test.tsx` (W04 plan lines 748–823,838–922).
**Test:** `apps/web/src/components/devices/hardware/StorageHealthSection.test.tsx`.
**Interfaces:** Consumes `StorageHealthSection({deviceId}:{deviceId:string})` and Task 10 card. Uses the existing `/devices/${deviceId}/hardware-health` request; no new prop, query parameter or route. Newest BMC row wins across historical fallback sources, with component key as deterministic tie-breaker.

- [ ] **Step 1: Append component-composition regressions (5 minutes).** Reuse that file's real imports and `response`, `component`, `view` helpers:
```tsx
it('renders one newest BMC card from the existing hardware-health response',async()=>{
 const bmc=component({componentType:'bmc',componentKey:'bmc:racadm',source:'racadm',name:'iDRAC',
  firmware:'7.10',lastSeenAt:'2026-09-23T12:00:00.000Z',attributes:{vendor:'Dell',ip:'192.0.2.10',mac:'02:00:00:00:00:10',
   bmcLink:{status:'already_linked',assetId:'44444444-4444-4444-8444-444444444444'}}});
 const old=component({...bmc,componentKey:'bmc:ipmi',source:'ipmi',lastSeenAt:'2026-09-22T12:00:00.000Z',firmware:'old'});
 vi.mocked(fetchWithAuth).mockResolvedValue(response(view({components:[component(),old,bmc]})));
 render(<StorageHealthSection deviceId="device-a" />);
 expect(await screen.findByTestId('hardware-management-controller-card')).toHaveTextContent('7.10');
 expect(screen.getAllByTestId('hardware-management-controller-card')).toHaveLength(1);
 expect(screen.getByTestId('hardware-controller-card')).toBeInTheDocument();
 expect(fetchWithAuth).toHaveBeenCalledTimes(1);
});
it('shows BMC-only inventory without presenting a storage empty-state contradiction',async()=>{
 vi.mocked(fetchWithAuth).mockResolvedValue(response(view({components:[component({componentType:'bmc',componentKey:'bmc:ipmi',source:'ipmi',name:'BMC'})]})));
 render(<StorageHealthSection deviceId="device-a" />);
 expect(await screen.findByTestId('hardware-management-controller-card')).toBeInTheDocument();
 expect(screen.queryByTestId('hardware-empty-state')).not.toBeInTheDocument();
});
it('does not render a management card when no BMC component exists',async()=>{
 vi.mocked(fetchWithAuth).mockResolvedValue(response(view()));
 render(<StorageHealthSection deviceId="device-a" />);
 await screen.findByTestId('hardware-controller-card');
 expect(screen.queryByTestId('hardware-management-controller-card')).not.toBeInTheDocument();
});
```
- [ ] **Step 2: Run red (2 minutes).**
```bash
cd apps/web && npx vitest run src/components/devices/hardware/StorageHealthSection.test.tsx
```
Expected: `Unable to find an element by: [data-testid="hardware-management-controller-card"]`.
- [ ] **Step 3: Compose the card with the existing view (3 minutes).** Add import:
```tsx
import ManagementControllerCard from './ManagementControllerCard';
```
After `const storage = ...`, add:
```tsx
const bmc=data?.components.filter(c=>c.componentType==='bmc')
 .sort((a,b)=>Date.parse(b.lastSeenAt)-Date.parse(a.lastSeenAt)||a.componentKey.localeCompare(b.componentKey))[0];
```
Change only the empty-state condition from `storage.length === 0` to `storage.length === 0 && !bmc`. Immediately before `<SourcesFooter ... />`, insert:
```tsx
{bmc && <ManagementControllerCard component={bmc} />}
```
The disabled-policy message continues to render; previously observed facts stay visible just as W04 retains storage rows. No second browser request races the parent deviceId lifecycle.
- [ ] **Step 4: Run green and wave-level checks (2–5 minutes per command launch).**
```bash
cd apps/web && npx vitest run src/components/devices/hardware/StorageHealthSection.test.tsx src/components/devices/hardware/ManagementControllerCard.test.tsx
cd apps/api && npx vitest run src/services/discovery/agentReportedBmcLink.test.ts src/jobs/discoveryWorker.test.ts src/services/topology/aliasClusters.test.ts src/services/topology/legacyIdentitySplit.test.ts
cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/discovery/agentReportedBmcLink.integration.test.ts src/jobs/discoveryWorker.bmc.integration.test.ts src/services/topology/bmc.integration.test.ts
NODE_OPTIONS=--max-old-space-size=12288 pnpm --filter @breeze/api exec tsc --noEmit
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts
cd agent && go test -race ./internal/collectors/hwhealth/...
cd agent && go vet ./...
```
Check every exit code directly; do not pipe typechecking to `tail`. Expected: all pass with nonzero file/test counts. W05 must not add any RLS/export/cascade baseline exception. The enum migration adds no new column to register. Record Windows native output from Task 4 and fixture-only vendor coverage on the W05 issue; W06 owns live hardware evidence and the release-note sweep.
- [ ] **Step 5: Commit and stop the test stack (2 minutes).**
```bash
git add apps/web/src/components/devices/hardware/StorageHealthSection.tsx apps/web/src/components/devices/hardware/StorageHealthSection.test.tsx
git commit -m $'feat(web): integrate daily management controller inventory\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
pnpm test-stack down
```

## Self-review

- Spec §5.1, §6.1–6.4 and §12: Tasks 2–4 define installed-tool detection, bounded commands, sanitized facts, unavailable outcomes and persisted daily attempts.
- Spec §7.6 and §12: Tasks 5–6 associate only normalized MAC matches under the ingest transaction; RLS, suppression, site eligibility and competing writers have explicit tests.
- Spec §12/D14: Task 7 guards both scan-time approval and the actual host-classification SQL at `discoveryWorker.ts:1173–1187`; the site exists and is tested.
- Spec §12/D14: Tasks 8–9 reject alias/shared-binding authority and fix upstream replay so a BMC remains a usable independent node.
- Spec §11.1: Tasks 10–11 display vendor, firmware, IP, MAC, linked asset and the other-site note through W04's existing data flow.
- W01 owns hardware tables, rollup, retention and GET/PUT authorization; W02a owns the runner and general scheduler; W03 owns alerts; W04 owns general storage UI and docs.
- W06 owns real vendor captures, Storage Spaces/mdadm lab proof and release evidence; W05 still requires native Windows tests and an agent release.
- Index §I ambiguity resolved: `already_linked` covers an occupied asset without reassigning it; duplicate eligible MACs are rejected unless the IP uniquely disambiguates them.
- Index §I NULL-site eligibility is defensive because today's `site_id` is NOT NULL; migration 100400 stays ADD VALUE only. Index §D's generic attributes carry server-derived read-only `bmcLink`, with no new route or top-level response field.
- Index §H/I daily scheduling uses three stable source kinds, an ordered fallback group and `bmcLastRun` in `hwhealth_state.json`; no invented `bmc` wire source and no daily cached-success replay.
