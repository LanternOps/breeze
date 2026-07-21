# Network Topology Redesign — Phase 2 (FDB Host Attachment) Implementation Plan

> **For agentic workers:** Execute with the **superpowers:subagent-driven-development** skill. Each `### Task N` is an independent, TDD-ordered unit: write the failing test, prove it fails with the exact command, write the minimal REAL implementation, prove it passes, commit. Do not batch tasks. Do not run `git commit` until a task's run-passes step is green. Do NOT pull/rebase main inside a worktree.

**Issue:** #1728 — Network Discovery topology redesign
**Spec:** `docs/superpowers/specs/monitoring/2026-06-22-network-topology-redesign-design.md` (§12 Phase 2)
**Depends on:** Phase 1 (LLDP/CDP backbone) — assumed merged. Phase 1 has already: (a) added the `adjacency` block to the agent discovery result and the agent-side `DeviceAdjacency`/`LldpNeighbor`/`CdpNeighbor` types with `lldp[]`/`cdp[]` collection; (b) extended `network_topology` with `method`/`confidence`/`created_by`/`first_seen_at` columns + `ux_network_topology_provenance` unique index; (c) replaced `enrichTopology()` with `reconcileTopology(orgId, siteId, hosts, adjacency)` that writes LLDP/CDP infra edges; (d) extended the API zod `adjacency` schema with `lldp`/`cdp` arrays. **This plan EXTENDS those; it never re-creates them.**

## Goal

Collect bridge-FDB (`dot1dTpFdbTable`) rows in the Go agent during a discovery scan, map each MAC→bridge-port→ifName (and VLAN where available), emit them as `fdb: FdbEntry[]` in each `DeviceAdjacency`, and extend `reconcileTopology` to attach hosts to **access** (non-uplink) switch ports — matched by MAC against `discovered_assets`, written as `method='fdb'`, `confidence='medium'`, `connection_type='access'` edges with `interface_name` + `vlan`. Uplink ports (ports that appear as an LLDP/CDP neighbor) and over-threshold ports are excluded with a logged skip count. Manual edges (`method='manual'`) are never touched by reconcile.

## Architecture

```
Agent discovery scan (per SNMP-credentialed switch)
  walkFDB() → dot1dTpFdbTable (MAC→bridgePort)
            → dot1dBasePortIfIndex (bridgePort→ifIndex) → ifName (ifIndex→name)
            → dot1qTpFdbTable VLAN (best-effort)
  ⇒ DeviceAdjacency.fdb []FdbEntry   (joins the Phase-1 lldp/cdp arrays)
        ↓ (existing WS command_result → result.adjacency)
API agentWs.handleDiscoveryResult → enqueueDiscoveryResults(...) carries adjacency
        ↓
discoveryWorker.processResults → reconcileTopology(orgId, siteId, hosts, adjacency)
  [Phase 1 already does LLDP/CDP infra edges here]
  Phase 2 adds:
    1. uplinkIfNames = ports that appear in any lldp/cdp neighbor row of that device
    2. for each fdb row on a NON-uplink port whose MAC ∈ discovered_assets:
         upsert edge switch→host (method='fdb', confidence='medium',
                                   connection_type='access', interface_name, vlan)
    3. skip MAC∉inventory; skip ports with >MAX_MACS_PER_ACCESS_PORT macs (latent uplink);
       log skip counts. Never read/modify method='manual'.
  [withSystemDbAccessContext — worker path, Phase 1 wrapping retained]
```

## Tech Stack

- **Agent:** Go, `github.com/gosnmp/gosnmp v1.43.2`. New table-walk via the underlying `*gosnmp.GoSNMP.BulkWalkAll`. Tests: `go test -race ./...`, table-driven with golden PDU fixtures.
- **API:** TypeScript, Drizzle, Vitest. Reconcile unit tests mock Drizzle; the manual-edge-preservation guard is an integration test against the real DB (`*.integration.test.ts`).
- **No migration:** `network_topology` already carries `method`/`confidence`/`interface_name`/`vlan`/`first_seen_at`/`last_verified_at` and the provenance unique index from Phase 1. Phase 2 adds **zero** schema/DDL.

## Global Constraints

- **Node:** prefix `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` for every `pnpm`/`vitest` invocation.
- **Migrations:** none expected in Phase 2. If one becomes necessary, hand-written idempotent SQL in `apps/api/migrations/`, named `YYYY-MM-DD-<slug>.sql`, no inner `BEGIN`/`COMMIT`, never edit a shipped migration.
- **Tests alongside source.** Go: `agent/internal/<pkg>/<file>_test.go`, table-driven for FDB/port-mapping parsing with golden fixtures. API unit: `*.test.ts` beside source. Real-DB tests: `apps/api/src/__tests__/integration/*.integration.test.ts` (BLOCKING integration job, `breeze_app` conn, autoMigrate + TRUNCATE-per-test). Unit `test-api` job has NO `DATABASE_URL` — real-DB cases there skip vacuously, so the manual-preservation guard MUST live in `integration/`.
- **RLS/tenancy:** no new tables. Reconcile runs under `withSystemDbAccessContext` (worker). No bare pool in any new code path.
- **Locked cross-phase contracts (verbatim, do not redefine):**
  ```ts
  DeviceAdjacency { sourceDeviceIp: string; sourceChassisId?: string; lldp: LldpNeighbor[]; cdp: CdpNeighbor[]; fdb: FdbEntry[] }
  LldpNeighbor { localPort: string; localIfName?: string; remoteChassisId: string; remotePortId: string; remoteSysName?: string }
  CdpNeighbor  { localPort: string; remoteDeviceId: string; remotePortId: string; remoteAddress?: string }
  FdbEntry     { mac: string; bridgePort: number; ifName?: string; vlan?: number }
  ```
  Unique index: `ux_network_topology_provenance(org_id, site_id, source_type, source_id, target_type, target_id, method)`.
  ```ts
  reconcileTopology(orgId: string, siteId: string, hosts: DiscoveredHostResult[], adjacency: DeviceAdjacency[]): Promise<void>
  ```

---

### Task 1 — Agent: SNMP table-walk primitive on the client

Add a `BulkWalk` helper to `SNMPClient` so FDB/port/ifName tables can be walked. The current client (`agent/internal/snmppoll/client.go`) only exposes `Get`/`GetMulti`; `BulkWalkAll` exists on the underlying `*gosnmp.GoSNMP` (gosnmp v1.43.2).

**Files**
- `agent/internal/snmppoll/client.go` (edit — add method)
- `agent/internal/snmppoll/walk_test.go` (new)

**Interfaces**
- Produces: `func (c *SNMPClient) BulkWalk(rootOID string) ([]gosnmp.SnmpPDU, error)`
- Consumes: existing `SNMPClient{ client *gosnmp.GoSNMP }`, `gosnmp.SnmpPDU`.

Steps:
- [ ] Write `agent/internal/snmppoll/walk_test.go`: `TestBulkWalk_EmptyOIDReturnsError` asserting `(&SNMPClient{}).BulkWalk("")` returns a non-nil error with message containing `"oid is required"`, and `TestBulkWalk_NilClientReturnsError` asserting `(&SNMPClient{client: nil}).BulkWalk("1.3.6")` returns an error (no panic). Use only the table fields that exist; do not open a socket.
- [ ] Run-fails: `cd agent && go test -race ./internal/snmppoll/ -run TestBulkWalk` → expect compile failure `undefined: (*SNMPClient).BulkWalk` (or test FAIL).
- [ ] Implement in `client.go`:
  ```go
  // BulkWalk performs a GETBULK walk of an SNMP subtree and returns all PDUs.
  func (c *SNMPClient) BulkWalk(rootOID string) ([]gosnmp.SnmpPDU, error) {
  	if rootOID == "" {
  		return nil, errors.New("oid is required")
  	}
  	if c == nil || c.client == nil {
  		return nil, errors.New("SNMP client is not connected")
  	}
  	pdus, err := c.client.BulkWalkAll(rootOID)
  	if err != nil {
  		return nil, err
  	}
  	return pdus, nil
  }
  ```
- [ ] Run-passes: `cd agent && go test -race ./internal/snmppoll/ -run TestBulkWalk` → PASS.
- [ ] Commit: `feat(agent/snmp): add BulkWalk subtree helper to SNMPClient`.

---

### Task 2 — Agent: parse `dot1dTpFdbTable` PDUs into MAC→bridge-port rows

`dot1dTpFdbTable` = `1.3.6.1.2.1.17.4.3`. The address column `dot1dTpFdbAddress` is `1.3.6.1.2.1.17.4.3.1.1.<6 mac octets>` (value = the MAC), and the port column `dot1dTpFdbPort` is `1.3.6.1.2.1.17.4.3.1.2.<6 mac octets>` (value = bridge port int). The 6-octet OID suffix is the MAC and is the join key between the two columns. We parse the **port** column (`.1.2.`) — its suffix gives the MAC and its value the bridge port — which is sufficient and avoids depending on column ordering.

**Files**
- `agent/internal/snmppoll/fdb.go` (new)
- `agent/internal/snmppoll/fdb_test.go` (new)
- `agent/internal/snmppoll/testdata/fdb_golden.json` (new — golden fixture from a real switch walk; see fixture block below)

**Interfaces**
- Produces:
  ```go
  type FdbRow struct {
  	MAC        string // lowercase colon-form aa:bb:cc:dd:ee:ff
  	BridgePort int
  }
  func parseFdbPortColumn(pdus []gosnmp.SnmpPDU) []FdbRow
  func macFromOIDSuffix(oid, columnPrefix string) (string, bool)
  ```
- Consumes: `gosnmp.SnmpPDU`, `ParseValue` (metrics.go).

Steps:
- [ ] Create the golden fixture `agent/internal/snmppoll/testdata/fdb_golden.json` (decimal octet suffixes; value = bridge port):
  ```json
  [
    { "oid": ".1.3.6.1.2.1.17.4.3.1.2.0.80.86.171.205.239", "value": 3 },
    { "oid": ".1.3.6.1.2.1.17.4.3.1.2.0.30.103.1.2.3",      "value": 5 },
    { "oid": ".1.3.6.1.2.1.17.4.3.1.2.170.187.204.221.238.255", "value": 5 }
  ]
  ```
  (0.80.86.171.205.239 = `00:50:56:ab:cd:ef`; 0.30.103.1.2.3 = `00:1e:67:01:02:03`; 170.187.204.221.238.255 = `aa:bb:cc:dd:ee:ff`.)
- [ ] Write `fdb_test.go`:
  - `TestMacFromOIDSuffix` table-driven: input `.1.3.6.1.2.1.17.4.3.1.2.0.80.86.171.205.239` + prefix `.1.3.6.1.2.1.17.4.3.1.2.` → `("00:50:56:ab:cd:ef", true)`; a too-short suffix → `("", false)`; a non-matching prefix → `("", false)`; suffix with a non-numeric octet → `("", false)`.
  - `TestParseFdbPortColumn_Golden`: load `testdata/fdb_golden.json` into `[]gosnmp.SnmpPDU` (build PDUs with `Name` = oid, `Value` = `big.NewInt(value)` so it exercises `ParseValue`), call `parseFdbPortColumn`, assert exactly 3 rows: `{00:50:56:ab:cd:ef,3}`, `{00:1e:67:01:02:03,5}`, `{aa:bb:cc:dd:ee:ff,5}` (order-insensitive compare via map).
  - `TestParseFdbPortColumn_SkipsBadRows`: include a PDU with a malformed suffix and one with `Value=nil` → both dropped, no panic.
- [ ] Run-fails: `cd agent && go test -race ./internal/snmppoll/ -run 'TestMacFromOIDSuffix|TestParseFdbPortColumn'` → compile failure (`undefined: parseFdbPortColumn`).
- [ ] Implement `fdb.go`:
  ```go
  package snmppoll

  import (
  	"fmt"
  	"strconv"
  	"strings"

  	"github.com/gosnmp/gosnmp"
  )

  const oidFdbPortColumn = ".1.3.6.1.2.1.17.4.3.1.2." // dot1dTpFdbPort

  type FdbRow struct {
  	MAC        string
  	BridgePort int
  }

  // macFromOIDSuffix extracts a 6-octet MAC encoded as the dotted-decimal OID
  // suffix after columnPrefix. Returns ("", false) if the suffix is not a
  // valid 6-octet MAC.
  func macFromOIDSuffix(oid, columnPrefix string) (string, bool) {
  	norm := oid
  	if !strings.HasPrefix(norm, ".") {
  		norm = "." + norm
  	}
  	if !strings.HasPrefix(norm, columnPrefix) {
  		return "", false
  	}
  	suffix := strings.TrimPrefix(norm, columnPrefix)
  	parts := strings.Split(suffix, ".")
  	if len(parts) != 6 {
  		return "", false
  	}
  	octets := make([]string, 6)
  	for i, p := range parts {
  		n, err := strconv.Atoi(p)
  		if err != nil || n < 0 || n > 255 {
  			return "", false
  		}
  		octets[i] = fmt.Sprintf("%02x", n)
  	}
  	return strings.Join(octets, ":"), true
  }

  // parseFdbPortColumn turns dot1dTpFdbPort PDUs into MAC→bridge-port rows.
  func parseFdbPortColumn(pdus []gosnmp.SnmpPDU) []FdbRow {
  	rows := make([]FdbRow, 0, len(pdus))
  	for _, pdu := range pdus {
  		mac, ok := macFromOIDSuffix(pdu.Name, oidFdbPortColumn)
  		if !ok {
  			continue
  		}
  		v := ParseValue(pdu)
  		port, ok := toInt(v)
  		if !ok || port <= 0 {
  			continue
  		}
  		rows = append(rows, FdbRow{MAC: mac, BridgePort: port})
  	}
  	return rows
  }

  // toInt coerces a ParseValue result (int64/uint64/string) into an int.
  func toInt(v any) (int, bool) {
  	switch n := v.(type) {
  	case int64:
  		return int(n), true
  	case uint64:
  		return int(n), true
  	case int:
  		return n, true
  	case string:
  		parsed, err := strconv.Atoi(strings.TrimSpace(n))
  		if err != nil {
  			return 0, false
  		}
  		return parsed, true
  	default:
  		return 0, false
  	}
  }
  ```
- [ ] Run-passes: `cd agent && go test -race ./internal/snmppoll/ -run 'TestMacFromOIDSuffix|TestParseFdbPortColumn'` → PASS.
- [ ] Commit: `feat(agent/snmp): parse dot1dTpFdbTable into MAC→bridge-port rows`.

---

### Task 3 — Agent: map bridge-port → ifName (`dot1dBasePortIfIndex` + `ifName`)

`dot1dBasePortIfIndex` = `1.3.6.1.2.1.17.1.4.1.2.<bridgePort>` (value = ifIndex). `ifName` = `1.3.6.1.2.1.31.1.1.1.1.<ifIndex>` (value = e.g. `Gi0/3`). Compose them into `bridgePort → ifName`.

**Files**
- `agent/internal/snmppoll/fdb.go` (edit)
- `agent/internal/snmppoll/fdb_test.go` (edit)

**Interfaces**
- Produces:
  ```go
  func parseBridgePortIfIndex(pdus []gosnmp.SnmpPDU) map[int]int          // bridgePort → ifIndex
  func parseIfName(pdus []gosnmp.SnmpPDU) map[int]string                  // ifIndex → ifName
  func buildPortIfNameMap(portIfIndex map[int]int, ifNames map[int]string) map[int]string // bridgePort → ifName
  ```

Steps:
- [ ] Add tests to `fdb_test.go`:
  - `TestParseBridgePortIfIndex`: PDUs `.1.3.6.1.2.1.17.1.4.1.2.3 = 10001`, `....2.5 = 10003`, plus a malformed-suffix PDU dropped → `map[int]int{3:10001, 5:10003}`.
  - `TestParseIfName`: PDUs `.1.3.6.1.2.1.31.1.1.1.1.10001 = "Gi0/3"`, `....10003 = "Gi0/5"` → `map[int]string{10001:"Gi0/3", 10003:"Gi0/5"}` (value as `[]byte` to exercise `ParseValue`'s `[]byte→string`).
  - `TestBuildPortIfNameMap`: combine the two above → `map[int]string{3:"Gi0/3", 5:"Gi0/5"}`; a bridge port whose ifIndex has no ifName is omitted.
- [ ] Run-fails: `cd agent && go test -race ./internal/snmppoll/ -run 'TestParseBridgePortIfIndex|TestParseIfName|TestBuildPortIfNameMap'` → compile failure.
- [ ] Implement in `fdb.go`:
  ```go
  const (
  	oidBridgePortIfIndex = ".1.3.6.1.2.1.17.1.4.1.2." // dot1dBasePortIfIndex
  	oidIfName            = ".1.3.6.1.2.1.31.1.1.1.1."  // ifName
  )

  func intFromOIDSuffix(oid, columnPrefix string) (int, bool) {
  	norm := oid
  	if !strings.HasPrefix(norm, ".") {
  		norm = "." + norm
  	}
  	if !strings.HasPrefix(norm, columnPrefix) {
  		return 0, false
  	}
  	suffix := strings.TrimPrefix(norm, columnPrefix)
  	if strings.Contains(suffix, ".") || suffix == "" {
  		return 0, false
  	}
  	return strconv.Atoi(suffix)
  	// strconv.Atoi returns (n, err); adapt below
  }

  func parseBridgePortIfIndex(pdus []gosnmp.SnmpPDU) map[int]int {
  	out := make(map[int]int)
  	for _, pdu := range pdus {
  		port, ok := intFromOIDSuffix(pdu.Name, oidBridgePortIfIndex)
  		if !ok {
  			continue
  		}
  		ifIndex, ok := toInt(ParseValue(pdu))
  		if !ok {
  			continue
  		}
  		out[port] = ifIndex
  	}
  	return out
  }

  func parseIfName(pdus []gosnmp.SnmpPDU) map[int]string {
  	out := make(map[int]string)
  	for _, pdu := range pdus {
  		ifIndex, ok := intFromOIDSuffix(pdu.Name, oidIfName)
  		if !ok {
  			continue
  		}
  		name, ok := ParseValue(pdu).(string)
  		if !ok || name == "" {
  			continue
  		}
  		out[ifIndex] = name
  	}
  	return out
  }

  func buildPortIfNameMap(portIfIndex map[int]int, ifNames map[int]string) map[int]string {
  	out := make(map[int]string, len(portIfIndex))
  	for port, ifIndex := range portIfIndex {
  		if name, ok := ifNames[ifIndex]; ok {
  			out[port] = name
  		}
  	}
  	return out
  }
  ```
  > Note: fix `intFromOIDSuffix` to return `(int, bool)` cleanly — replace the trailing two lines with:
  > ```go
  > n, err := strconv.Atoi(suffix)
  > if err != nil {
  > 	return 0, false
  > }
  > return n, true
  > ```
- [ ] Run-passes: `cd agent && go test -race ./internal/snmppoll/ -run 'TestParseBridgePortIfIndex|TestParseIfName|TestBuildPortIfNameMap'` → PASS.
- [ ] Commit: `feat(agent/snmp): map bridge-port→ifName via dot1dBasePortIfIndex+ifName`.

---

### Task 4 — Agent: best-effort VLAN per MAC from `dot1qTpFdbTable`

Q-BRIDGE `dot1qTpFdbPort` = `1.3.6.1.2.1.17.7.1.2.2.1.2.<vlan>.<6 mac octets>` (value = bridge port). Walking it yields `MAC → vlan`. This is best-effort: many switches expose only `dot1dTpFdbTable` and no VLAN. Absence MUST NOT drop the FDB row — VLAN is left `nil`.

**Files**
- `agent/internal/snmppoll/fdb.go` (edit)
- `agent/internal/snmppoll/fdb_test.go` (edit)

**Interfaces**
- Produces: `func parseQBridgeVlanByMac(pdus []gosnmp.SnmpPDU) map[string]int` // MAC → vlan

Steps:
- [ ] Add `TestParseQBridgeVlanByMac` to `fdb_test.go`: PDU `.1.3.6.1.2.1.17.7.1.2.2.1.2.100.0.80.86.171.205.239 = 3` → `map[string]int{"00:50:56:ab:cd:ef":100}`; a malformed suffix dropped; if the same MAC appears under two VLANs keep the first deterministically (assert one of them, document first-wins).
- [ ] Run-fails: `cd agent && go test -race ./internal/snmppoll/ -run TestParseQBridgeVlanByMac` → compile failure.
- [ ] Implement in `fdb.go`:
  ```go
  const oidQBridgeFdbPort = ".1.3.6.1.2.1.17.7.1.2.2.1.2." // dot1qTpFdbPort: .<vlan>.<6 mac>

  func parseQBridgeVlanByMac(pdus []gosnmp.SnmpPDU) map[string]int {
  	out := make(map[string]int)
  	for _, pdu := range pdus {
  		norm := pdu.Name
  		if !strings.HasPrefix(norm, ".") {
  			norm = "." + norm
  		}
  		if !strings.HasPrefix(norm, oidQBridgeFdbPort) {
  			continue
  		}
  		suffix := strings.TrimPrefix(norm, oidQBridgeFdbPort)
  		parts := strings.SplitN(suffix, ".", 2)
  		if len(parts) != 2 {
  			continue
  		}
  		vlan, err := strconv.Atoi(parts[0])
  		if err != nil || vlan <= 0 {
  			continue
  		}
  		mac, ok := macFromOIDSuffix("."+oidQBridgeFdbPort[1:]+parts[1], oidQBridgeFdbPort)
  		if !ok {
  			continue
  		}
  		if _, exists := out[mac]; !exists { // first-wins
  			out[mac] = vlan
  		}
  	}
  	return out
  }
  ```
  > The `macFromOIDSuffix` reuse reconstructs the column-prefixed OID so the existing 6-octet parser handles the trailing MAC.
- [ ] Run-passes: `cd agent && go test -race ./internal/snmppoll/ -run TestParseQBridgeVlanByMac` → PASS.
- [ ] Commit: `feat(agent/snmp): best-effort VLAN per MAC from dot1qTpFdbTable`.

---

### Task 5 — Agent: assemble `[]FdbEntry` from a switch walk (pure assembler, no socket)

Combine Tasks 2–4 into the per-device assembler that the scan orchestration will call after walking the four subtrees. Pure function over already-fetched PDU slices so it is fully unit-testable with goldens.

**Files**
- `agent/internal/snmppoll/fdb.go` (edit)
- `agent/internal/snmppoll/fdb_test.go` (edit)

**Interfaces**
- Produces:
  ```go
  type FdbEntry struct {
  	MAC        string `json:"mac"`
  	BridgePort int    `json:"bridgePort"`
  	IfName     string `json:"ifName,omitempty"`
  	VLAN       int    `json:"vlan,omitempty"`
  }
  func AssembleFdbEntries(fdbPortPDUs, basePortPDUs, ifNamePDUs, qBridgePDUs []gosnmp.SnmpPDU) []FdbEntry
  ```
  (Field names/JSON tags map 1:1 onto the locked `FdbEntry { mac; bridgePort; ifName?; vlan? }` contract.)

Steps:
- [ ] Add `TestAssembleFdbEntries_Golden` to `fdb_test.go`: feed the FDB-port golden (Task 2), the base-port/ifName goldens (Task 3), and a Q-BRIDGE golden (Task 4); assert it yields entries with `IfName` resolved where the port maps and `VLAN` set only where Q-BRIDGE had it. Include an FDB MAC whose bridge port has no ifIndex mapping → entry still emitted with empty `IfName` (host attachment can still happen by port number/skip). Assert deterministic count.
- [ ] Run-fails: `cd agent && go test -race ./internal/snmppoll/ -run TestAssembleFdbEntries` → compile failure.
- [ ] Implement in `fdb.go`:
  ```go
  func AssembleFdbEntries(fdbPortPDUs, basePortPDUs, ifNamePDUs, qBridgePDUs []gosnmp.SnmpPDU) []FdbEntry {
  	rows := parseFdbPortColumn(fdbPortPDUs)
  	portIfName := buildPortIfNameMap(parseBridgePortIfIndex(basePortPDUs), parseIfName(ifNamePDUs))
  	vlanByMac := parseQBridgeVlanByMac(qBridgePDUs)

  	entries := make([]FdbEntry, 0, len(rows))
  	for _, r := range rows {
  		e := FdbEntry{MAC: r.MAC, BridgePort: r.BridgePort}
  		if name, ok := portIfName[r.BridgePort]; ok {
  			e.IfName = name
  		}
  		if vlan, ok := vlanByMac[r.MAC]; ok {
  			e.VLAN = vlan
  		}
  		entries = append(entries, e)
  	}
  	return entries
  }
  ```
- [ ] Run-passes: `cd agent && go test -race ./internal/snmppoll/ -run TestAssembleFdbEntries` → PASS.
- [ ] Commit: `feat(agent/snmp): assemble []FdbEntry from FDB/port/ifName/VLAN walks`.

---

### Task 6 — Agent: wire FDB collection into the discovery scan (`collectFdbForDevice`) and onto `DeviceAdjacency.fdb`

Walk the four subtrees for each SNMP-credentialed device that responded, and populate the Phase-1 `DeviceAdjacency.fdb` field. SNMP failures degrade per-device (return empty `[]FdbEntry`, scan still succeeds) — mirroring `querySNMP`'s nil-on-failure pattern in `agent/internal/discovery/snmp.go`.

**Files**
- `agent/internal/discovery/snmp.go` (edit — add `collectFdbForDevice`, reuse the per-target community loop pattern)
- `agent/internal/discovery/snmp_test.go` (edit/new — test the gate logic, not the socket)
- `agent/internal/heartbeat/handlers_network.go` (edit — ensure `fdb` rides in each `DeviceAdjacency`; Phase 1 already emits `adjacency` with `lldp`/`cdp`)

**Interfaces**
- Consumes: `snmppoll.NewClient`, `(*SNMPClient).BulkWalk` (Task 1), `snmppoll.AssembleFdbEntries` (Task 5).
- Produces: `func collectFdbForDevice(target string, communities []string, timeout time.Duration) []snmppoll.FdbEntry` — returns `nil`/empty on any SNMP error; populates the Phase-1 `DeviceAdjacency{...}.fdb`.

Steps:
- [ ] In `snmp_test.go` add `TestCollectFdbForDevice_NoCredsReturnsEmpty`: call `collectFdbForDevice("203.0.113.250", nil, 50*time.Millisecond)` (unreachable / no community) → returns `len(...)==0`, no panic. (Confirms graceful degradation; no live SNMP server in CI.)
- [ ] Run-fails: `cd agent && go test -race ./internal/discovery/ -run TestCollectFdbForDevice` → compile failure (`undefined: collectFdbForDevice`).
- [ ] Implement `collectFdbForDevice` in `snmp.go`:
  ```go
  // collectFdbForDevice walks the bridge-FDB tables for a single SNMP device.
  // Returns nil on any SNMP error so a failing device degrades to no adjacency
  // without aborting the scan.
  func collectFdbForDevice(target string, communities []string, timeout time.Duration) []snmppoll.FdbEntry {
  	if len(communities) == 0 {
  		communities = []string{"public"}
  	}
  	for _, community := range communities {
  		community = strings.TrimSpace(community)
  		if community == "" {
  			continue
  		}
  		cfg := snmppoll.SNMPClientConfig{Target: target, Timeout: timeout}
  		if strings.HasPrefix(strings.ToLower(community), "v3:") {
  			cfg.Version = gosnmp.Version3
  			cfg.Auth = snmppoll.SNMPAuth{Username: strings.TrimPrefix(community, "v3:")}
  		} else {
  			cfg.Version = gosnmp.Version2c
  			cfg.Auth = snmppoll.SNMPAuth{Community: community}
  		}
  		client, err := snmppoll.NewClient(cfg)
  		if err != nil {
  			continue
  		}
  		fdbPort, err := client.BulkWalk("1.3.6.1.2.1.17.4.3.1.2")
  		if err != nil {
  			client.Close()
  			continue
  		}
  		basePort, _ := client.BulkWalk("1.3.6.1.2.1.17.1.4.1.2")
  		ifNames, _ := client.BulkWalk("1.3.6.1.2.1.31.1.1.1.1")
  		qBridge, _ := client.BulkWalk("1.3.6.1.2.1.17.7.1.2.2.1.2")
  		client.Close()
  		return snmppoll.AssembleFdbEntries(fdbPort, basePort, ifNames, qBridge)
  	}
  	return nil
  }
  ```
  (Import `github.com/gosnmp/gosnmp` and `breeze-agent/internal/snmppoll` — match the module path used elsewhere in the package.)
- [ ] In `handlers_network.go`, where Phase 1 builds each `DeviceAdjacency`, set `adj.Fdb = collectFdbForDevice(host.IP, communities, timeout)` (only for hosts whose `SNMPData != nil`, i.e. SNMP responded). If the Phase-1 `DeviceAdjacency` Go struct field is absent, add `Fdb []snmppoll.FdbEntry \`json:"fdb"\`` to it (the locked contract requires `fdb` always present — emit `[]` not omitempty so the API always sees the key).
- [ ] Run-passes: `cd agent && go test -race ./internal/discovery/ -run TestCollectFdbForDevice` and `cd agent && go build ./...` → PASS / clean build.
- [ ] Commit: `feat(agent/discovery): collect bridge-FDB per device into DeviceAdjacency.fdb`.

---

### Task 7 — API: extend the incoming adjacency zod schema with `fdb[]`

Phase 1 added an `adjacency` array to the discovery result validation (`apps/api/src/jobs/queueSchemas.ts`) with `lldp`/`cdp`. Add the `fdb` array so reconcile receives it. Keep `.strict()`.

**Files**
- `apps/api/src/jobs/queueSchemas.ts` (edit)
- `apps/api/src/jobs/queueSchemas.test.ts` (edit/new)

**Interfaces**
- Produces:
  ```ts
  export const fdbEntrySchema = z.object({
    mac: z.string().min(1),
    bridgePort: z.number().int().nonnegative(),
    ifName: z.string().min(1).optional(),
    vlan: z.number().int().positive().optional(),
  }).strict();
  // deviceAdjacencySchema (Phase 1) gains: fdb: z.array(fdbEntrySchema).default([])
  export type FdbEntry = z.infer<typeof fdbEntrySchema>;
  ```

Steps:
- [ ] Add `queueSchemas.test.ts` cases: a `DeviceAdjacency` payload `{ sourceDeviceIp, lldp: [], cdp: [], fdb: [{ mac:'aa:bb:cc:dd:ee:ff', bridgePort:5, ifName:'Gi0/5', vlan:100 }] }` parses; an `fdb` entry with an extra unknown key fails `.strict()`; a payload omitting `fdb` parses and defaults `fdb` to `[]`.
- [ ] Run-fails: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/jobs/queueSchemas.test.ts` → FAIL (schema lacks `fdb`).
- [ ] Implement: add `fdbEntrySchema`, splice `fdb: z.array(fdbEntrySchema).default([])` into the Phase-1 `deviceAdjacencySchema`, export the type.
- [ ] Run-passes: same vitest command → PASS.
- [ ] Commit: `feat(api/discovery): validate fdb[] in incoming adjacency payload`.

---

### Task 8 — API: uplink detection + FDB host attachment in `reconcileTopology`

Extend the Phase-1 `reconcileTopology` (in `apps/api/src/jobs/discoveryWorker.ts`). Phase 1 already writes LLDP/CDP infra edges and runs under `withSystemDbAccessContext` via `processResults`. Phase 2 adds the FDB pass. Factor the new logic into a pure, unit-testable helper that decides what to upsert, then a thin DB-writing wrapper.

**Files**
- `apps/api/src/jobs/discoveryWorker.ts` (edit — extend `reconcileTopology`; add `computeFdbAttachments`)
- `apps/api/src/jobs/topologyReconcile.test.ts` (new — unit, mocked Drizzle / pure helper)

**Interfaces**
- Consumes (verbatim): `reconcileTopology(orgId, siteId, hosts: DiscoveredHostResult[], adjacency: DeviceAdjacency[]): Promise<void>`; `DeviceAdjacency { sourceDeviceIp; sourceChassisId?; lldp; cdp; fdb }`; `FdbEntry { mac; bridgePort; ifName?; vlan? }`.
- Produces (new, exported for unit test):
  ```ts
  const MAX_MACS_PER_ACCESS_PORT = 16; // ports with more MACs are treated as latent uplinks

  interface FdbAttachment {
    switchAssetId: string;   // discovered_assets.id of the switch (source)
    hostAssetId: string;     // discovered_assets.id matched by MAC (target)
    interfaceName: string | null;
    vlan: number | null;
  }
  interface FdbReconcileResult {
    attachments: FdbAttachment[];
    skippedUnknownMac: number;     // MAC not in discovered_assets
    skippedUplinkPort: number;     // port is an LLDP/CDP neighbor
    skippedOverThreshold: number;  // port MAC count > MAX_MACS_PER_ACCESS_PORT
  }

  // Pure: no DB. Given one device's adjacency + lookup maps, decide attachments.
  function computeFdbAttachments(
    deviceAdj: DeviceAdjacency,
    switchAssetId: string | null,         // resolved id of the FDB source switch
    macToAssetId: Map<string, string>,    // normalized MAC → discovered_assets.id (site-scoped)
    maxMacsPerPort: number = MAX_MACS_PER_ACCESS_PORT,
  ): FdbReconcileResult;
  ```

**Uplink-detection logic (verbatim):** a switch port is an uplink iff its identifier appears as the `localPort` or `localIfName` of ANY LLDP neighbor, or the `localPort` of ANY CDP neighbor, in that same device's adjacency. Build `uplinkPorts = new Set<string>()` from `deviceAdj.lldp` (`localPort` + `localIfName`) and `deviceAdj.cdp` (`localPort`); an FDB row is on an uplink port iff `uplinkPorts.has(fdb.ifName)` **or** `uplinkPorts.has(String(fdb.bridgePort))`. Uplink ports are excluded from host attachment.

**Per-port MAC-count gate:** group surviving (non-uplink) FDB rows by `ifName ?? String(bridgePort)`; any port group whose size `> maxMacsPerPort` is a likely undetected uplink — skip the whole group, increment `skippedOverThreshold`.

**MAC inventory gate:** for each remaining FDB row, normalize the MAC (reuse `normalizeMac` from `assetApproval`) and look it up in `macToAssetId`; miss → `skippedUnknownMac++`, skip.

Steps:
- [ ] Write `topologyReconcile.test.ts` (pure-helper unit; import `computeFdbAttachments`):
  - **Access attach:** adjacency with `fdb:[{mac:'aa:bb:cc:dd:ee:ff',bridgePort:5,ifName:'Gi0/5',vlan:100}]`, empty `lldp`/`cdp`, `macToAssetId` has that MAC → one attachment with `interfaceName:'Gi0/5'`, `vlan:100`, `skipped*:0`.
  - **Uplink exclusion:** same FDB row but `lldp:[{localPort:'5',localIfName:'Gi0/5',remoteChassisId:'...',remotePortId:'...'}]` → 0 attachments, `skippedUplinkPort:1`.
  - **Unknown MAC:** FDB MAC not in `macToAssetId` → 0 attachments, `skippedUnknownMac:1`.
  - **Over-threshold:** 17 distinct FDB rows on `Gi0/24` (all known MACs) with `maxMacsPerPort:16` → 0 attachments from that port, `skippedOverThreshold:1`.
  - **MAC normalization:** FDB `mac:'AA-BB-CC-DD-EE-FF'`, map keyed by normalized `aa:bb:cc:dd:ee:ff` → matched.
  - **Null switch id:** `switchAssetId=null` (FDB source not in inventory) → 0 attachments, no throw.
- [ ] Run-fails: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/jobs/topologyReconcile.test.ts` → FAIL (`computeFdbAttachments` undefined).
- [ ] Implement `computeFdbAttachments` in `discoveryWorker.ts` (export it):
  ```ts
  export const MAX_MACS_PER_ACCESS_PORT = 16;

  export function computeFdbAttachments(
    deviceAdj: DeviceAdjacency,
    switchAssetId: string | null,
    macToAssetId: Map<string, string>,
    maxMacsPerPort: number = MAX_MACS_PER_ACCESS_PORT,
  ): FdbReconcileResult {
    const result: FdbReconcileResult = {
      attachments: [], skippedUnknownMac: 0, skippedUplinkPort: 0, skippedOverThreshold: 0,
    };
    if (!switchAssetId || deviceAdj.fdb.length === 0) return result;

    const uplinkPorts = new Set<string>();
    for (const n of deviceAdj.lldp) {
      if (n.localPort) uplinkPorts.add(n.localPort);
      if (n.localIfName) uplinkPorts.add(n.localIfName);
    }
    for (const n of deviceAdj.cdp) {
      if (n.localPort) uplinkPorts.add(n.localPort);
    }

    const portKey = (e: FdbEntry) => e.ifName ?? String(e.bridgePort);
    const isUplink = (e: FdbEntry) =>
      (e.ifName !== undefined && uplinkPorts.has(e.ifName)) || uplinkPorts.has(String(e.bridgePort));

    const accessByPort = new Map<string, FdbEntry[]>();
    for (const e of deviceAdj.fdb) {
      if (isUplink(e)) { result.skippedUplinkPort++; continue; }
      const key = portKey(e);
      (accessByPort.get(key) ?? accessByPort.set(key, []).get(key)!).push(e);
    }

    for (const [, entries] of accessByPort) {
      if (entries.length > maxMacsPerPort) { result.skippedOverThreshold++; continue; }
      for (const e of entries) {
        const mac = normalizeMac(e.mac);
        const hostAssetId = mac ? macToAssetId.get(mac) : undefined;
        if (!hostAssetId) { result.skippedUnknownMac++; continue; }
        if (hostAssetId === switchAssetId) continue; // self-edge guard
        result.attachments.push({
          switchAssetId,
          hostAssetId,
          interfaceName: e.ifName ?? null,
          vlan: e.vlan ?? null,
        });
      }
    }
    return result;
  }
  ```
  (Define the `FdbAttachment`/`FdbReconcileResult` interfaces above the function. `normalizeMac` is already imported.)
- [ ] Run-passes: same vitest command → PASS.
- [ ] Commit: `feat(api/topology): compute FDB host attachments with uplink+threshold gating`.

---

### Task 9 — API: wire FDB attachments into `reconcileTopology` (upsert + skip logging)

Extend the Phase-1 `reconcileTopology` body to: resolve a site-scoped `MAC → discovered_assets.id` map and an `sourceDeviceIp/sourceChassisId → switch asset id` resolver, call `computeFdbAttachments` per device, **upsert** each attachment as an `fdb` edge on the provenance unique index, and **log aggregate skip counts**.

**Files**
- `apps/api/src/jobs/discoveryWorker.ts` (edit — `reconcileTopology` FDB pass)
- `apps/api/src/jobs/topologyReconcile.upsert.test.ts` (new — mocked-Drizzle unit asserting the upsert shape + onConflict target)

**Interfaces**
- Upsert shape (Drizzle): `db.insert(networkTopology).values({...}).onConflictDoUpdate({ target: [orgId, siteId, sourceType, sourceId, targetType, targetId, method], set: { lastVerifiedAt: new Date(), interfaceName, vlan, connectionType: 'access', confidence: 'medium' } })`. Edge values: `sourceType:'discovered_asset'`, `sourceId: switchAssetId`, `targetType:'discovered_asset'`, `targetId: hostAssetId`, `method:'fdb'`, `confidence:'medium'`, `connectionType:'access'`, `interfaceName`, `vlan`, `lastVerifiedAt: now`. `firstSeenAt` left to default on insert, untouched on update.

Steps:
- [ ] Write `topologyReconcile.upsert.test.ts`: mock `db.insert(...).values(...).onConflictDoUpdate(...)` (vitest mock returning a thenable); call `reconcileTopology(orgId, siteId, hosts, adjacency)` with one switch host (matched in `hosts`) and one FDB attach; assert `insert` called with `networkTopology`, `values` carries `method:'fdb'`, `confidence:'medium'`, `connectionType:'access'`, correct `sourceId`/`targetId`, and `onConflictDoUpdate.target` is the 7-column provenance tuple. Assert a second call with the SAME edge does not throw (idempotent upsert path). Stub the LLDP/CDP Phase-1 queries so only the FDB pass is exercised, OR assert FDB-specific insert among calls.
- [ ] Run-fails: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/jobs/topologyReconcile.upsert.test.ts` → FAIL.
- [ ] Implement the FDB pass inside `reconcileTopology` (after the Phase-1 infra-edge pass), e.g.:
  ```ts
  // ── Phase 2: FDB host attachment ───────────────────────────────────────
  // Site-scoped MAC → asset id (normalized).
  const siteAssets = await db
    .select({ id: discoveredAssets.id, mac: discoveredAssets.macAddress, ip: discoveredAssets.ipAddress })
    .from(discoveredAssets)
    .where(and(eq(discoveredAssets.orgId, orgId), eq(discoveredAssets.siteId, siteId)));
  const macToAssetId = new Map<string, string>();
  const ipToAssetId = new Map<string, string>();
  for (const a of siteAssets) {
    const m = normalizeMac(a.mac);
    if (m) macToAssetId.set(m, a.id);
    if (a.ip) ipToAssetId.set(a.ip, a.id);
  }

  let totUnknownMac = 0, totUplink = 0, totOverThreshold = 0, totAttached = 0;
  for (const deviceAdj of adjacency) {
    const switchAssetId = ipToAssetId.get(deviceAdj.sourceDeviceIp)
      ?? (deviceAdj.sourceChassisId ? macToAssetId.get(normalizeMac(deviceAdj.sourceChassisId) ?? '') : undefined)
      ?? null;
    const r = computeFdbAttachments(deviceAdj, switchAssetId, macToAssetId);
    totUnknownMac += r.skippedUnknownMac;
    totUplink += r.skippedUplinkPort;
    totOverThreshold += r.skippedOverThreshold;
    for (const att of r.attachments) {
      await db.insert(networkTopology).values({
        orgId, siteId,
        sourceType: 'discovered_asset', sourceId: att.switchAssetId,
        targetType: 'discovered_asset', targetId: att.hostAssetId,
        connectionType: 'access', method: 'fdb', confidence: 'medium',
        interfaceName: att.interfaceName, vlan: att.vlan,
        lastVerifiedAt: new Date(),
      }).onConflictDoUpdate({
        target: [
          networkTopology.orgId, networkTopology.siteId,
          networkTopology.sourceType, networkTopology.sourceId,
          networkTopology.targetType, networkTopology.targetId,
          networkTopology.method,
        ],
        set: {
          lastVerifiedAt: new Date(), interfaceName: att.interfaceName,
          vlan: att.vlan, connectionType: 'access', confidence: 'medium',
        },
      });
      totAttached++;
    }
  }
  if (totUnknownMac || totUplink || totOverThreshold) {
    console.log(
      `[DiscoveryWorker] FDB reconcile org=${orgId} site=${siteId}: attached=${totAttached} ` +
      `skipped_unknown_mac=${totUnknownMac} skipped_uplink=${totUplink} skipped_over_threshold=${totOverThreshold}`
    );
  }
  ```
  > `method`/`confidence` are the Phase-1-added enum columns; reuse their Drizzle field names. If Phase 1 named them differently, adapt to the real column identifiers — do NOT add columns.
- [ ] Run-passes: same vitest command + `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/jobs/topologyReconcile.test.ts` → PASS.
- [ ] Commit: `feat(api/topology): upsert FDB access-port host edges with skip logging`.

---

### Task 10 — API integration: manual edges PRESERVED across reconcile + FDB attach end-to-end (real DB)

The required guard: an edge inserted directly with `method='manual'` survives a full `reconcileTopology` run (this protects the not-yet-built Phase 4 manual feature). Plus a real-DB assertion that an FDB attach writes one `method='fdb'` access edge and is idempotent on a second reconcile.

**Files**
- `apps/api/src/__tests__/integration/topologyReconcile.integration.test.ts` (new)

**Interfaces**
- Consumes: real `reconcileTopology`, `networkTopology`, `discoveredAssets` via `breeze_app` conn; `withSystemDbAccessContext`.

**Run mechanics (verbatim):** integration tests are EXCLUDED from the default vitest run; execute with `--config vitest.integration.config.ts` (injects root `../../.env.test` → `breeze_app` conn on the test DB). autoMigrate runs; TRUNCATE-per-test seeds fresh per `it`. Plain `:5432` run skips on the dev-DB guard.

Steps:
- [ ] Write `topologyReconcile.integration.test.ts`:
  - **Seed:** an org + site; a switch `discovered_asset` (give it an IP) and a host `discovered_asset` with MAC `aa:bb:cc:dd:ee:ff`.
  - **Manual edge preserved:** directly `INSERT` a `network_topology` row `source=switch, target=host, method='manual', confidence='asserted', connection_type='manual'`. Run `reconcileTopology(orgId, siteId, hosts, adjacency)` where `adjacency=[{ sourceDeviceIp: <switch ip>, lldp:[], cdp:[], fdb:[{mac:'aa:bb:cc:dd:ee:ff',bridgePort:5,ifName:'Gi0/5'}] }]`. Assert: the `method='manual'` row STILL EXISTS unchanged (same id, untouched `last_verified_at`), AND a NEW `method='fdb'` row now exists for the same source/target pair (the provenance index lets both coexist). Run reconcile a SECOND time → still exactly one `manual` + one `fdb` row (idempotent; `fdb` `last_verified_at` bumped, no duplicate).
  - **Uplink exclusion (real DB):** add an `lldp` neighbor on `localIfName:'Gi0/5'` for the switch and re-run with the same FDB row → assert NO `method='fdb'` edge is written on that port.
  - **Unknown MAC (real DB):** FDB row with a MAC not seeded → no `fdb` edge written, reconcile resolves without error.
  - Wrap reconcile invocations in `withSystemDbAccessContext` (worker path), seeding inside each `it` per the TRUNCATE-per-test convention; re-seed fixtures per test (never memoize) so RLS cases aren't vacuous.
- [ ] Run-fails: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/topologyReconcile.integration.test.ts` → FAIL until Tasks 8–9 are wired (and confirm it does NOT skip — if it skips, the `.env.test` symlink / `:5433` test DB is missing).
- [ ] Make green: ensure reconcile never SELECTs/DELETEs `method='manual'` rows (the FDB pass only inserts; verify Phase 1's age-out `DELETE` is filtered to the measured set `method IN ('lldp','cdp','fdb')` — if Phase 1 didn't scope it, add that predicate here as part of Phase 2 and note it in the commit).
- [ ] Run-passes: same integration command → PASS.
- [ ] Commit: `test(api/topology): integration — manual edge preserved + FDB attach idempotent`.

---

### Task 11 — Full-suite + Go race verification

**Files:** none (verification only).

Steps:
- [ ] `cd agent && go test -race ./...` → PASS (FDB/port/VLAN parsing + collection).
- [ ] `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/jobs/queueSchemas.test.ts src/jobs/topologyReconcile.test.ts src/jobs/topologyReconcile.upsert.test.ts` → PASS. (Full `vitest run` may show ~7-9 pre-existing parallel-flaky failures unrelated to this work — verify the changed files single-fork; trust CI for the rest.)
- [ ] `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/topologyReconcile.integration.test.ts` → PASS.
- [ ] `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api typecheck` → clean.
- [ ] No commit (verification task). If anything is red, return to the owning task — do not `--admin` past a red required check.

---

## Notes / cross-phase guardrails

- **No migration in Phase 2** — `network_topology` already carries `method`/`confidence`/`interface_name`/`vlan`/`first_seen_at`/`last_verified_at` + `ux_network_topology_provenance` from Phase 1. If a real gap is found (e.g. `connection_type` lacks an `'access'` CHECK value), fix-forward with a new idempotent dated migration; never edit a shipped one.
- **Manual immunity is the load-bearing invariant** (Task 10). Reconcile's FDB pass is INSERT/upsert-only and never references `method='manual'`. Any age-out `DELETE` must be scoped `method IN ('lldp','cdp','fdb')`.
- **Graceful SNMP degradation:** `collectFdbForDevice` returns empty on any error; a switch that fails the FDB walk still contributes its per-host discovery data and its LLDP/CDP edges.
- **Threshold is a guess, logged not silent:** `MAX_MACS_PER_ACCESS_PORT=16` skips latent-uplink ports; the skip count is logged so an operator can see when a real access port is being suppressed (spec §8.3 / §13).
