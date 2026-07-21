# Network Topology Phase 1 — Measured LLDP/CDP Backbone Implementation Plan

> **For agentic workers:** Execute this plan with the **superpowers:subagent-driven-development** workflow — each `### Task N` is an independently dispatchable unit. Within a task, follow strict TDD: write the failing test, run it and confirm the expected failure, write the minimal real implementation, run until green, then commit. Do not batch tasks. Do not skip the run-it-fails step. Every code block below is real, paste-ready code — no placeholders.

**Goal:** Ship the measured Layer-2 backbone end-to-end. The Go discovery agent walks LLDP (`lldpRemTable`) and CDP neighbor tables on SNMP-credentialed devices during a scan and emits a new `adjacency` block. The API extends `network_topology` with provenance columns + a unique index, replaces the delete-only `enrichTopology()` with a `reconcileTopology()` writer that materializes **infra↔infra** edges (`method=lldp|cdp`, `confidence=high`, `connection_type=infra`) and ages out stale measured edges. The existing D3 `NetworkTopologyMap.tsx` draws those edges solid + colored-by-method with a provenance legend. FDB/host-attachment is Phase 2 (the payload carries an empty `fdb[]`).

**Architecture:**
```
Go agent (discovery scan)
  snmppoll: add LLDP/CDP OID templates + a generic table Walk()
  discovery: for each SNMP-responding device, walk LLDP + CDP → DeviceAdjacency rows
  handlers_network: emit result payload field `adjacency: DeviceAdjacency[]` (fdb[] empty)
        ↓  (existing network_discovery WS result transport — no new message type)
API agentWs.handleDiscoveryResult → enqueueDiscoveryResults(..., adjacency)
API discoveryWorker.processResults → reconcileTopology(orgId, siteId, hosts, adjacency)
  match neighbors to discovered_assets by chassis-id MAC / mgmt IP / system name
  upsert infra edges on ux_network_topology_provenance; bump last_verified_at; age out unseen ≥3 scans
  [withSystemDbAccessContext — worker path; manual edges never touched]
        ↓
API GET /discovery/topology → edges gain method/confidence/interfaceName/vlan
        ↓
Web NetworkTopologyMap.tsx (D3) → infra edges solid, colored by method, provenance legend
```

**Tech Stack:** Go (agent, `gosnmp`), TypeScript (Hono API, Drizzle queries, BullMQ worker, Zod), hand-written idempotent SQL migrations, React + D3 v7 (web), Vitest (api/web unit + `*.integration.test.ts` real-DB), Go `testing` (table-driven).

## Global Constraints
- Node: prefix shell with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` for pnpm/vitest.
- Migrations: hand-written SQL in `apps/api/migrations/`, named `YYYY-MM-DD-<slug>.sql`, idempotent (IF NOT EXISTS / DO $$ / pg_policies checks), NO inner BEGIN/COMMIT, RLS policies in the SAME migration. Never edit a shipped migration. Run `pnpm db:check-drift` after.
- Drizzle for queries only; never `drizzle-kit generate/push`.
- Tests alongside source. Go: `cd agent && go test -race ./...`. API unit: vitest (`apps/api`), real-DB tests go in `src/__tests__/integration/*.integration.test.ts` run via `--config vitest.integration.config.ts`. Web: vitest+jsdom (stub ResizeObserver per repo convention).
- Web mutations wrapped in `runAction`. (Phase 1 adds no web mutations — read-only edge rendering — so no `runAction` work here; manual editing is Phase 4.)

### Verified facts (anchor every task to these)
- **Migration ordering:** the runner applies files in `localeCompare` order. Files dated `2026-06-26/27/28` already exist in `apps/api/migrations/`. To sort **after** all of them, this plan's migration is named `2026-06-29-topology-provenance.sql`. (Issue is dated 2026-06-22 but the migration prefix must sort last; the filename prefix is purely an ordering key.)
- **`network_topology` already has `interface_name varchar(100)`** (baseline `0001-baseline.sql:4159` + schema `discovery.ts:249`). Do NOT re-add it; the migration only adds `method`, `confidence`, `created_by`, `first_seen_at` and the unique index. `connection_type` already exists.
- **`network_topology` RLS is already enabled + FORCEd + has all four `breeze_org_isolation_{select,insert,update,delete}` policies** keyed on `breeze_has_org_access(org_id)` (baseline `0001-baseline.sql:15768/16629/17490/18351/19108`). It is **shape 1** (auto-discovered `org_id` column) and needs **no** allowlist entry in `rls-coverage.integration.test.ts`. The migration still re-asserts ENABLE/FORCE + policy existence idempotently as defense-in-depth.
- **Agent result payload** today: `handlers_network.go:39-44` returns `map[string]any{ "jobId", "hosts", "hostsScanned", "hostsDiscovered" }`. We add `"adjacency"`.
- **API ingest:** `agentWs.ts:153 handleDiscoveryResult` reads `result.result.hosts` and calls `enqueueDiscoveryResults(jobId, orgId, siteId, hosts, hostsScanned, hostsDiscovered, profileId?, meta)` (`discoveryWorker.ts:1204`). We thread `adjacency` through both.
- **Worker:** `discoveryWorker.ts:585 processResults` ends by calling `enrichTopology(data.orgId, data.siteId, data.hosts)` (line 1020) which only calls `cleanupSpeculativeTopologyLinks` (delete-only, `_hosts` unused). We replace that call with `reconcileTopology`. The whole worker already runs inside `runWithSystemDbAccess(...)` (`discoveryWorker.ts:147`) → DB writes are system-scoped; no extra wrapping needed inside `reconcileTopology`, but it is written to be safe if called standalone.
- **Zod gate:** `queueSchemas.ts:105 process-results` variant validates the job payload; add an optional `adjacency` field there or the enqueue `.parse()` throws.
- **snmppoll client** (`client.go`) only has `Get`/`GetMulti`; no walk. We add `Walk(rootOid) ([]gosnmp.SnmpPDU, error)` using `gosnmp.BulkWalkAll`.
- **Read route:** `discovery.ts:1273` maps edges; extend the mapped object with `method/confidence/interfaceName/vlan`.
- **Web component:** `NetworkTopologyMap.tsx` — `ApiTopologyLink` (line 52), `mapLink` (line 157), `TopologyLink` (line 41), link `<line>` styling (line 360-363), legend (line 561+), degraded note (line 586+).

---

### Task 1: snmppoll — generic SNMP table Walk()

**Files:**
- modify `agent/internal/snmppoll/client.go`
- test `agent/internal/snmppoll/client_test.go` (append)

**Interfaces:**
- Produces: `func (c *SNMPClient) Walk(rootOID string) ([]gosnmp.SnmpPDU, error)` — returns every PDU under `rootOID` (BulkWalkAll for v2c/v3).

Steps:
- [ ] Append a failing test to `agent/internal/snmppoll/client_test.go`:
```go
func TestWalkRejectsEmptyOID(t *testing.T) {
	c := &SNMPClient{} // client field nil; guard must fire before use
	_, err := c.Walk("")
	if err == nil {
		t.Fatal("expected error for empty root OID")
	}
	if !strings.Contains(err.Error(), "root OID is required") {
		t.Fatalf("unexpected error: %v", err)
	}
}
```
  (ensure `import "strings"` is present in the test file; add it if missing.)
- [ ] Run it, expect a compile failure (`c.Walk undefined`): `cd agent && go test ./internal/snmppoll/ -run TestWalkRejectsEmptyOID`. Expected: `undefined (type *SNMPClient has no field or method Walk)`.
- [ ] Implement in `agent/internal/snmppoll/client.go`, after `GetMulti`:
```go
// Walk returns every PDU in the subtree rooted at rootOID using a BULK walk.
// Works for v2c and v3; callers parse the returned index suffixes.
func (c *SNMPClient) Walk(rootOID string) ([]gosnmp.SnmpPDU, error) {
	if rootOID == "" {
		return nil, errors.New("root OID is required")
	}
	if c == nil || c.client == nil {
		return nil, errors.New("SNMP client is not connected")
	}
	pdus, err := c.client.BulkWalkAll(rootOID)
	if err != nil {
		return nil, fmt.Errorf("SNMP walk of %s failed: %w", rootOID, err)
	}
	return pdus, nil
}
```
- [ ] Run until green: `cd agent && go test -race ./internal/snmppoll/`. Expected: `ok`.
- [ ] Commit: `cd agent && git add internal/snmppoll/client.go internal/snmppoll/client_test.go && git commit -m "feat(agent/snmppoll): add generic SNMP table Walk()"`

---

### Task 2: snmppoll — LLDP/CDP OID templates

**Files:**
- modify `agent/internal/snmppoll/templates.go`
- test `agent/internal/snmppoll/templates_test.go` (append)

**Interfaces:**
- Produces exported OID-root constants consumed by Task 3's collector:
  - `LldpRemChassisIDOID = "1.0.8802.1.1.2.1.4.1.1.5"`
  - `LldpRemPortIDOID    = "1.0.8802.1.1.2.1.4.1.1.7"`
  - `LldpRemSysNameOID   = "1.0.8802.1.1.2.1.4.1.1.9"`
  - `LldpLocPortIDOID    = "1.0.8802.1.1.2.1.3.7.1.3"`
  - `CdpCacheDeviceIDOID  = "1.3.6.1.4.1.9.9.23.1.2.1.1.6"`
  - `CdpCacheDevicePortOID= "1.3.6.1.4.1.9.9.23.1.2.1.1.7"`
  - `CdpCacheAddressOID   = "1.3.6.1.4.1.9.9.23.1.2.1.1.4"`
  - `IfNameOID            = "1.3.6.1.2.1.31.1.1.1.1"` (for local-port ifName resolution)

Steps:
- [ ] Append a failing test to `agent/internal/snmppoll/templates_test.go`:
```go
func TestLLDPAndCDPRootOIDs(t *testing.T) {
	cases := map[string]string{
		"lldp chassis": LldpRemChassisIDOID,
		"lldp port":    LldpRemPortIDOID,
		"lldp sysname": LldpRemSysNameOID,
		"cdp device":   CdpCacheDeviceIDOID,
		"cdp port":     CdpCacheDevicePortOID,
		"cdp address":  CdpCacheAddressOID,
		"ifName":       IfNameOID,
	}
	for name, oid := range cases {
		if oid == "" {
			t.Errorf("%s OID is empty", name)
		}
	}
	if !strings.HasPrefix(LldpRemChassisIDOID, "1.0.8802.1.1.2") {
		t.Errorf("LLDP chassis OID has wrong base: %s", LldpRemChassisIDOID)
	}
	if !strings.HasPrefix(CdpCacheDeviceIDOID, "1.3.6.1.4.1.9.9.23") {
		t.Errorf("CDP device OID has wrong base: %s", CdpCacheDeviceIDOID)
	}
}
```
  (add `import "strings"` to the test file if not present.)
- [ ] Run, expect compile failure: `cd agent && go test ./internal/snmppoll/ -run TestLLDPAndCDPRootOIDs`. Expected: `undefined: LldpRemChassisIDOID`.
- [ ] Implement — append to `agent/internal/snmppoll/templates.go`:
```go
// LLDP (IEEE 802.1AB) lldpRemTable columns under 1.0.8802.1.1.2.1.4.1.1.
const (
	LldpRemChassisIDOID = "1.0.8802.1.1.2.1.4.1.1.5" // lldpRemChassisId
	LldpRemPortIDOID    = "1.0.8802.1.1.2.1.4.1.1.7" // lldpRemPortId
	LldpRemSysNameOID   = "1.0.8802.1.1.2.1.4.1.1.9" // lldpRemSysName
	LldpLocPortIDOID    = "1.0.8802.1.1.2.1.3.7.1.3" // lldpLocPortId
)

// Cisco CDP cdpCacheTable columns under 1.3.6.1.4.1.9.9.23.1.2.1.1.
const (
	CdpCacheDeviceIDOID   = "1.3.6.1.4.1.9.9.23.1.2.1.1.6" // cdpCacheDeviceId
	CdpCacheDevicePortOID = "1.3.6.1.4.1.9.9.23.1.2.1.1.7" // cdpCacheDevicePort
	CdpCacheAddressOID    = "1.3.6.1.4.1.9.9.23.1.2.1.1.4" // cdpCacheAddress
)

// IfNameOID is ifName (ifXTable), used to resolve a local ifIndex to a port name.
const IfNameOID = "1.3.6.1.2.1.31.1.1.1.1"
```
- [ ] Run until green: `cd agent && go test -race ./internal/snmppoll/`. Expected: `ok`.
- [ ] Commit: `cd agent && git add internal/snmppoll/templates.go internal/snmppoll/templates_test.go && git commit -m "feat(agent/snmppoll): add LLDP/CDP/ifName OID roots"`

---

### Task 3: discovery — adjacency types + LLDP/CDP collector

**Files:**
- create `agent/internal/discovery/adjacency.go`
- create `agent/internal/discovery/adjacency_test.go`

**Interfaces:**
- Produces the LOCKED payload types (Go side; field names match the cross-phase contract; `fdb` present-but-empty in Phase 1):
```go
type LldpNeighbor struct {
	LocalPort       string `json:"localPort"`
	LocalIfName     string `json:"localIfName,omitempty"`
	RemoteChassisID string `json:"remoteChassisId"`
	RemotePortID    string `json:"remotePortId"`
	RemoteSysName   string `json:"remoteSysName,omitempty"`
}
type CdpNeighbor struct {
	LocalPort      string `json:"localPort"`
	RemoteDeviceID string `json:"remoteDeviceId"`
	RemotePortID   string `json:"remotePortId"`
	RemoteAddress  string `json:"remoteAddress,omitempty"`
}
type FdbEntry struct {
	MAC        string `json:"mac"`
	BridgePort int    `json:"bridgePort"`
	IfName     string `json:"ifName,omitempty"`
	VLAN       int    `json:"vlan,omitempty"`
}
type DeviceAdjacency struct {
	SourceDeviceIP  string         `json:"sourceDeviceIp"`
	SourceChassisID string         `json:"sourceChassisId,omitempty"`
	Lldp            []LldpNeighbor `json:"lldp"`
	Cdp             []CdpNeighbor  `json:"cdp"`
	Fdb            []FdbEntry     `json:"fdb"`
}
```
- Produces pure parsers (table-driven testable, no network):
  - `func parseLLDPNeighbors(chassis, portID, sysName []gosnmp.SnmpPDU) []LldpNeighbor`
  - `func parseCDPNeighbors(deviceID, devicePort, address []gosnmp.SnmpPDU) []CdpNeighbor`
  - `func snmpValueToString(pdu gosnmp.SnmpPDU) string` (octet-string/MAC aware; reuse pattern from `snmp.go:snmpToString` but local to this file)
  - `func indexSuffix(name, root string) string` (returns the OID index suffix after the root, used to join columns by row index)

Steps:
- [ ] Create `agent/internal/discovery/adjacency_test.go` with table-driven parser tests:
```go
package discovery

import (
	"testing"

	"github.com/gosnmp/gosnmp"
)

func pdu(name string, v interface{}, t gosnmp.Asn1BER) gosnmp.SnmpPDU {
	return gosnmp.SnmpPDU{Name: name, Value: v, Type: t}
}

func TestParseLLDPNeighbors(t *testing.T) {
	chassis := []gosnmp.SnmpPDU{
		pdu(".1.0.8802.1.1.2.1.4.1.1.5.0.1.1", []byte{0x00, 0x11, 0x22, 0x33, 0x44, 0x55}, gosnmp.OctetString),
	}
	portID := []gosnmp.SnmpPDU{
		pdu(".1.0.8802.1.1.2.1.4.1.1.7.0.1.1", []byte("Gi0/1"), gosnmp.OctetString),
	}
	sysName := []gosnmp.SnmpPDU{
		pdu(".1.0.8802.1.1.2.1.4.1.1.9.0.1.1", []byte("core-sw"), gosnmp.OctetString),
	}
	got := parseLLDPNeighbors(chassis, portID, sysName)
	if len(got) != 1 {
		t.Fatalf("expected 1 neighbor, got %d", len(got))
	}
	n := got[0]
	if n.RemoteChassisID != "00:11:22:33:44:55" {
		t.Errorf("chassis id = %q", n.RemoteChassisID)
	}
	if n.RemotePortID != "Gi0/1" {
		t.Errorf("remote port = %q", n.RemotePortID)
	}
	if n.RemoteSysName != "core-sw" {
		t.Errorf("sys name = %q", n.RemoteSysName)
	}
	if n.LocalPort != "0.1" {
		t.Errorf("local port (lldp index prefix) = %q", n.LocalPort)
	}
}

func TestParseLLDPNeighborsSkipsRowsWithoutChassis(t *testing.T) {
	got := parseLLDPNeighbors(nil, nil, nil)
	if len(got) != 0 {
		t.Fatalf("expected 0 neighbors, got %d", len(got))
	}
}

func TestParseCDPNeighbors(t *testing.T) {
	deviceID := []gosnmp.SnmpPDU{pdu(".1.3.6.1.4.1.9.9.23.1.2.1.1.6.3.1", []byte("edge-sw.acme"), gosnmp.OctetString)}
	devicePort := []gosnmp.SnmpPDU{pdu(".1.3.6.1.4.1.9.9.23.1.2.1.1.7.3.1", []byte("FastEthernet0/3"), gosnmp.OctetString)}
	address := []gosnmp.SnmpPDU{pdu(".1.3.6.1.4.1.9.9.23.1.2.1.1.4.3.1", []byte{10, 0, 0, 2}, gosnmp.OctetString)}
	got := parseCDPNeighbors(deviceID, devicePort, address)
	if len(got) != 1 {
		t.Fatalf("expected 1 cdp neighbor, got %d", len(got))
	}
	if got[0].RemoteDeviceID != "edge-sw.acme" {
		t.Errorf("device id = %q", got[0].RemoteDeviceID)
	}
	if got[0].RemotePortID != "FastEthernet0/3" {
		t.Errorf("device port = %q", got[0].RemotePortID)
	}
	if got[0].RemoteAddress != "10.0.0.2" {
		t.Errorf("address = %q", got[0].RemoteAddress)
	}
}
```
- [ ] Run, expect compile failure: `cd agent && go test ./internal/discovery/ -run TestParseLLDPNeighbors`. Expected: `undefined: parseLLDPNeighbors`.
- [ ] Implement `agent/internal/discovery/adjacency.go`:
```go
package discovery

import (
	"fmt"
	"net"
	"strings"

	"github.com/breeze-rmm/agent/internal/snmppoll"
	"github.com/gosnmp/gosnmp"
)

// LLDP neighbor row (see cross-phase locked contract).
type LldpNeighbor struct {
	LocalPort       string `json:"localPort"`
	LocalIfName     string `json:"localIfName,omitempty"`
	RemoteChassisID string `json:"remoteChassisId"`
	RemotePortID    string `json:"remotePortId"`
	RemoteSysName   string `json:"remoteSysName,omitempty"`
}

// CDP neighbor row.
type CdpNeighbor struct {
	LocalPort      string `json:"localPort"`
	RemoteDeviceID string `json:"remoteDeviceId"`
	RemotePortID   string `json:"remotePortId"`
	RemoteAddress  string `json:"remoteAddress,omitempty"`
}

// FdbEntry — Phase 2 populates this; Phase 1 always emits an empty slice.
type FdbEntry struct {
	MAC        string `json:"mac"`
	BridgePort int    `json:"bridgePort"`
	IfName     string `json:"ifName,omitempty"`
	VLAN       int    `json:"vlan,omitempty"`
}

// DeviceAdjacency is the per-source-device adjacency block emitted in the scan result.
type DeviceAdjacency struct {
	SourceDeviceIP  string         `json:"sourceDeviceIp"`
	SourceChassisID string         `json:"sourceChassisId,omitempty"`
	Lldp            []LldpNeighbor `json:"lldp"`
	Cdp             []CdpNeighbor  `json:"cdp"`
	Fdb             []FdbEntry     `json:"fdb"`
}

// indexSuffix returns the dotted index after rootOID (no leading dot), or "" if name is not under root.
func indexSuffix(name, root string) string {
	name = strings.TrimPrefix(name, ".")
	root = strings.TrimPrefix(root, ".")
	if !strings.HasPrefix(name, root+".") {
		return ""
	}
	return strings.TrimPrefix(name, root+".")
}

// lldpLocalPort derives the local-port key from an lldpRemTable index.
// lldpRemTable is indexed by lldpRemTimeMark.lldpRemLocalPortNum.lldpRemIndex;
// we key rows on "<timeMark>.<localPortNum>" so columns join consistently.
func lldpLocalPort(suffix string) string {
	parts := strings.Split(suffix, ".")
	if len(parts) >= 2 {
		return parts[0] + "." + parts[1]
	}
	return suffix
}

func snmpValueToString(pdu gosnmp.SnmpPDU) string {
	switch v := pdu.Value.(type) {
	case string:
		return v
	case []byte:
		return string(v)
	default:
		if pdu.Value == nil {
			return ""
		}
		return gosnmp.ToBigInt(pdu.Value).String()
	}
}

// macFromBytes formats a 6-byte chassis-id as colon-separated hex; falls back to string otherwise.
func macFromBytes(pdu gosnmp.SnmpPDU) string {
	b, ok := pdu.Value.([]byte)
	if ok && len(b) == 6 {
		parts := make([]string, 6)
		for i, c := range b {
			parts[i] = fmt.Sprintf("%02x", c)
		}
		return strings.Join(parts, ":")
	}
	return snmpValueToString(pdu)
}

// ipFromBytes formats a 4-byte address as dotted IPv4; falls back to string.
func ipFromBytes(pdu gosnmp.SnmpPDU) string {
	b, ok := pdu.Value.([]byte)
	if ok && len(b) == 4 {
		return net.IP(b).String()
	}
	return snmpValueToString(pdu)
}

func parseLLDPNeighbors(chassis, portID, sysName []gosnmp.SnmpPDU) []LldpNeighbor {
	ports := map[string]string{}
	for _, p := range portID {
		ports[indexSuffix(p.Name, snmppoll.LldpRemPortIDOID)] = snmpValueToString(p)
	}
	names := map[string]string{}
	for _, n := range sysName {
		names[indexSuffix(n.Name, snmppoll.LldpRemSysNameOID)] = snmpValueToString(n)
	}
	out := make([]LldpNeighbor, 0, len(chassis))
	for _, ch := range chassis {
		idx := indexSuffix(ch.Name, snmppoll.LldpRemChassisIDOID)
		if idx == "" {
			continue
		}
		out = append(out, LldpNeighbor{
			LocalPort:       lldpLocalPort(idx),
			RemoteChassisID: macFromBytes(ch),
			RemotePortID:    ports[idx],
			RemoteSysName:   names[idx],
		})
	}
	return out
}

func parseCDPNeighbors(deviceID, devicePort, address []gosnmp.SnmpPDU) []CdpNeighbor {
	ports := map[string]string{}
	for _, p := range devicePort {
		ports[indexSuffix(p.Name, snmppoll.CdpCacheDevicePortOID)] = snmpValueToString(p)
	}
	addrs := map[string]string{}
	for _, a := range address {
		addrs[indexSuffix(a.Name, snmppoll.CdpCacheAddressOID)] = ipFromBytes(a)
	}
	out := make([]CdpNeighbor, 0, len(deviceID))
	for _, d := range deviceID {
		idx := indexSuffix(d.Name, snmppoll.CdpCacheDeviceIDOID)
		if idx == "" {
			continue
		}
		// cdpCacheTable index is cdpCacheIfIndex.cdpCacheDeviceIndex → local port = first element.
		localPort := idx
		if dot := strings.Index(idx, "."); dot > 0 {
			localPort = idx[:dot]
		}
		out = append(out, CdpNeighbor{
			LocalPort:      localPort,
			RemoteDeviceID: snmpValueToString(d),
			RemotePortID:   ports[idx],
			RemoteAddress:  addrs[idx],
		})
	}
	return out
}

// collectDeviceAdjacency walks LLDP then CDP on one connected SNMP client.
// Errors degrade per-table: a failed walk yields no rows for that protocol.
func collectDeviceAdjacency(client *snmppoll.SNMPClient, sourceIP string) DeviceAdjacency {
	adj := DeviceAdjacency{SourceDeviceIP: sourceIP, Lldp: []LldpNeighbor{}, Cdp: []CdpNeighbor{}, Fdb: []FdbEntry{}}

	chassis, errC := client.Walk(snmppoll.LldpRemChassisIDOID)
	if errC == nil && len(chassis) > 0 {
		portID, _ := client.Walk(snmppoll.LldpRemPortIDOID)
		sysName, _ := client.Walk(snmppoll.LldpRemSysNameOID)
		adj.Lldp = parseLLDPNeighbors(chassis, portID, sysName)
	}

	cdpDev, errD := client.Walk(snmppoll.CdpCacheDeviceIDOID)
	if errD == nil && len(cdpDev) > 0 {
		cdpPort, _ := client.Walk(snmppoll.CdpCacheDevicePortOID)
		cdpAddr, _ := client.Walk(snmppoll.CdpCacheAddressOID)
		adj.Cdp = parseCDPNeighbors(cdpDev, cdpPort, cdpAddr)
	}

	return adj
}
```
- [ ] Run until green: `cd agent && go test -race ./internal/discovery/ -run 'TestParseLLDPNeighbors|TestParseLLDPNeighborsSkipsRowsWithoutChassis|TestParseCDPNeighbors'`. Expected: `ok`.
- [ ] Commit: `cd agent && git add internal/discovery/adjacency.go internal/discovery/adjacency_test.go && git commit -m "feat(agent/discovery): LLDP/CDP adjacency types + parsers + collector"`

---

### Task 4: discovery — wire adjacency collection into the scan

**Files:**
- modify `agent/internal/discovery/scanner.go`
- modify `agent/internal/discovery/snmp.go`
- test `agent/internal/discovery/adjacency_test.go` (append)

**Interfaces:**
- Consumes: `collectDeviceAdjacency` (Task 3), `snmppoll.NewClient` / `SNMPClientConfig` (Task 1 client).
- Produces:
  - new exported method `func (s *Scanner) CollectAdjacency(hosts []DiscoveredHost) []DeviceAdjacency` — for each host whose `Methods` include `"snmp"` and whose `SNMPData != nil`, open an SNMP client (reusing the profile's first usable community), collect adjacency, and return only blocks with ≥1 LLDP or CDP row.
  - a package-level seam `var collectAdjacencyFor = collectDeviceAdjacencyForHost` so tests can stub network access.

Steps:
- [ ] Append a test to `agent/internal/discovery/adjacency_test.go` that stubs the per-host collector and asserts only SNMP hosts with neighbors are returned:
```go
func TestCollectAdjacencyFiltersAndStubs(t *testing.T) {
	orig := collectAdjacencyFor
	t.Cleanup(func() { collectAdjacencyFor = orig })

	collectAdjacencyFor = func(ip string, communities []string, timeout time.Duration) DeviceAdjacency {
		if ip == "10.0.0.1" {
			return DeviceAdjacency{
				SourceDeviceIP: ip,
				Lldp:           []LldpNeighbor{{LocalPort: "1", RemoteChassisID: "aa:bb:cc:dd:ee:ff", RemotePortID: "Gi0/1"}},
				Cdp:            []CdpNeighbor{},
				Fdb:            []FdbEntry{},
			}
		}
		return DeviceAdjacency{SourceDeviceIP: ip, Lldp: []LldpNeighbor{}, Cdp: []CdpNeighbor{}, Fdb: []FdbEntry{}}
	}

	s := NewScanner(ScanConfig{SNMPCommunities: []string{"public"}})
	hosts := []DiscoveredHost{
		{IP: "10.0.0.1", Methods: []string{"snmp"}, SNMPData: &SNMPInfo{SysName: "core"}},
		{IP: "10.0.0.2", Methods: []string{"snmp"}, SNMPData: &SNMPInfo{SysName: "edge"}}, // no neighbors → dropped
		{IP: "10.0.0.3", Methods: []string{"ping"}},                                       // not snmp → skipped
	}
	got := s.CollectAdjacency(hosts)
	if len(got) != 1 {
		t.Fatalf("expected 1 adjacency block, got %d", len(got))
	}
	if got[0].SourceDeviceIP != "10.0.0.1" || len(got[0].Lldp) != 1 {
		t.Fatalf("unexpected adjacency: %+v", got[0])
	}
}
```
  (ensure the test file imports `"time"`.)
- [ ] Run, expect compile failure: `cd agent && go test ./internal/discovery/ -run TestCollectAdjacencyFiltersAndStubs`. Expected: `undefined: collectAdjacencyFor` / `s.CollectAdjacency undefined`.
- [ ] Implement. Add to `agent/internal/discovery/adjacency.go`:
```go
import "time" // add to existing import block

// collectAdjacencyFor is the per-host network seam (stubbed in tests).
var collectAdjacencyFor = collectDeviceAdjacencyForHost

// collectDeviceAdjacencyForHost connects via the first usable community and walks LLDP/CDP.
func collectDeviceAdjacencyForHost(ip string, communities []string, timeout time.Duration) DeviceAdjacency {
	empty := DeviceAdjacency{SourceDeviceIP: ip, Lldp: []LldpNeighbor{}, Cdp: []CdpNeighbor{}, Fdb: []FdbEntry{}}
	for _, community := range communities {
		community = strings.TrimSpace(community)
		if community == "" {
			continue
		}
		cfg := snmppoll.SNMPClientConfig{Target: ip, Timeout: timeout}
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
		adj := collectDeviceAdjacency(client, ip)
		client.Close()
		if len(adj.Lldp) > 0 || len(adj.Cdp) > 0 {
			return adj
		}
	}
	return empty
}
```
  Then add the Scanner method (in `scanner.go`, near `Scan`):
```go
// CollectAdjacency walks LLDP/CDP for SNMP-credentialed responders and returns
// adjacency blocks that contain at least one neighbor row.
func (s *Scanner) CollectAdjacency(hosts []DiscoveredHost) []DeviceAdjacency {
	if len(s.config.SNMPCommunities) == 0 {
		return nil
	}
	out := make([]DeviceAdjacency, 0)
	for _, h := range hosts {
		if h.SNMPData == nil || !hasMethod(h.Methods, "snmp") {
			continue
		}
		adj := collectAdjacencyFor(h.IP, s.config.SNMPCommunities, s.config.Timeout)
		if len(adj.Lldp) > 0 || len(adj.Cdp) > 0 {
			out = append(out, adj)
		}
	}
	return out
}

func hasMethod(methods []string, want string) bool {
	for _, m := range methods {
		if m == want {
			return true
		}
	}
	return false
}
```
  (If `hasMethod` collides with an existing helper, reuse the existing one and drop this definition; verify with `grep -n "func hasMethod" agent/internal/discovery`.)
- [ ] Run until green: `cd agent && go test -race ./internal/discovery/`. Expected: `ok`.
- [ ] Commit: `cd agent && git add internal/discovery/adjacency.go internal/discovery/scanner.go && git commit -m "feat(agent/discovery): collect LLDP/CDP adjacency for SNMP responders"`

---

### Task 5: agent handler — emit `adjacency` in the discovery result payload

**Files:**
- modify `agent/internal/heartbeat/handlers_network.go`
- test `agent/internal/heartbeat/handlers_test.go` (append)

**Interfaces:**
- Consumes: `scanner.CollectAdjacency` (Task 4).
- Produces: the `network_discovery` result map gains `"adjacency": []discovery.DeviceAdjacency` (always present, possibly empty slice — never nil/absent), alongside the existing `jobId/hosts/hostsScanned/hostsDiscovered`.

Steps:
- [ ] Append a test to `agent/internal/heartbeat/handlers_test.go` asserting the result payload carries an `adjacency` key (use a minimal scan config so it runs without a real network; the field must exist even when empty). Inspect existing tests in that file first (`grep -n "handleNetworkDiscovery\|adjacency\|CmdNetworkDiscovery" handlers_test.go`) and follow their construction pattern. Minimal assertion:
```go
func TestNetworkDiscoveryResultIncludesAdjacencyKey(t *testing.T) {
	cmd := Command{
		Type:    tools.CmdNetworkDiscovery,
		Payload: map[string]any{"jobId": "job-1", "subnets": []string{"127.0.0.1/32"}, "methods": []string{"ping"}},
	}
	res := handleNetworkDiscovery(nil, cmd)
	data, ok := res.Result.(map[string]any)
	if !ok {
		t.Fatalf("result payload is not a map: %T", res.Result)
	}
	if _, present := data["adjacency"]; !present {
		t.Fatal("expected 'adjacency' key in discovery result payload")
	}
}
```
  (Confirm the `tools.CommandResult` field that holds the payload is `Result` via `grep -n "Result" agent/internal/remote/tools/types.go`; adjust the accessor if the field differs.)
- [ ] Run, expect failure: `cd agent && go test ./internal/heartbeat/ -run TestNetworkDiscoveryResultIncludesAdjacencyKey`. Expected: `expected 'adjacency' key in discovery result payload`.
- [ ] Implement — in `handleNetworkDiscovery`, after `hosts, err := scanner.Scan()` and its error guard, before the success result:
```go
	adjacency := scanner.CollectAdjacency(hosts)
	if adjacency == nil {
		adjacency = []discovery.DeviceAdjacency{}
	}
	return tools.NewSuccessResult(map[string]any{
		"jobId":           tools.GetPayloadString(cmd.Payload, "jobId", ""),
		"hosts":           hosts,
		"hostsScanned":    targetCount,
		"hostsDiscovered": len(hosts),
		"adjacency":       adjacency,
	}, time.Since(start).Milliseconds())
```
  (Remove the old `return tools.NewSuccessResult(...)` block it replaces.)
- [ ] Run until green: `cd agent && go test -race ./internal/heartbeat/`. Expected: `ok`. Then full agent sweep: `cd agent && go test -race ./...`. Expected: `ok` across packages.
- [ ] Commit: `cd agent && git add internal/heartbeat/handlers_network.go internal/heartbeat/handlers_test.go && git commit -m "feat(agent): emit adjacency block in network_discovery result"`

---

### Task 6: API — migration: provenance columns + unique index + RLS re-assertion

**Files:**
- create `apps/api/migrations/2026-06-29-topology-provenance.sql`
- modify `apps/api/src/db/schema/discovery.ts` (Drizzle, for type-safe queries only)
- test `apps/api/src/db/autoMigrate.test.ts` is the existing ordering regression — no edit, just must stay green.

**Interfaces:**
- Produces these new `network_topology` columns/index (LOCKED contract):
  - `method text` (values `'lldp'|'cdp'|'fdb'|'manual'`), `confidence text` (`'high'|'medium'|'asserted'`), `created_by uuid NULL`, `first_seen_at timestamptz` (default now()). `interface_name` already exists.
  - `source_type`/`target_type` gain value `'manual_node'` (no enum — they are `varchar(50)`, so no DDL needed; documented for Phase 4).
  - Unique index `ux_network_topology_provenance(org_id, site_id, source_type, source_id, target_type, target_id, method)`.

Steps:
- [ ] Write the migration `apps/api/migrations/2026-06-29-topology-provenance.sql`:
```sql
-- Phase 1: network topology provenance (issue #1728)
-- Extends the existing network_topology table with method/confidence/created_by/first_seen_at
-- and a provenance unique index for idempotent measured-edge upserts.
-- interface_name already exists (baseline). RLS is re-asserted idempotently as defense-in-depth.

ALTER TABLE public.network_topology
  ADD COLUMN IF NOT EXISTS method text;

ALTER TABLE public.network_topology
  ADD COLUMN IF NOT EXISTS confidence text;

ALTER TABLE public.network_topology
  ADD COLUMN IF NOT EXISTS created_by uuid;

ALTER TABLE public.network_topology
  ADD COLUMN IF NOT EXISTS first_seen_at timestamptz DEFAULT now();

-- Backfill provenance for any pre-existing rows so the unique index can be built
-- without NULL-method collisions. Report the count for the forensic trail.
DO $$
DECLARE n integer;
BEGIN
  UPDATE public.network_topology SET method = 'manual' WHERE method IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'backfilled method=manual on % legacy network_topology row(s)', n; END IF;

  UPDATE public.network_topology SET confidence = 'asserted' WHERE confidence IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'backfilled confidence=asserted on % legacy network_topology row(s)', n; END IF;

  UPDATE public.network_topology SET first_seen_at = COALESCE(last_verified_at, created_at, now()) WHERE first_seen_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'backfilled first_seen_at on % legacy network_topology row(s)', n; END IF;
END $$;

-- Provenance unique index: lets a measured (method=lldp/cdp/fdb) and a manual edge
-- coexist on the same node pair; powers idempotent ON CONFLICT upsert on rescan.
CREATE UNIQUE INDEX IF NOT EXISTS ux_network_topology_provenance
  ON public.network_topology (org_id, site_id, source_type, source_id, target_type, target_id, method);

-- Defense-in-depth: re-assert RLS (already on per baseline). Idempotent.
ALTER TABLE public.network_topology ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_topology FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='network_topology' AND policyname='breeze_org_isolation_select') THEN
    CREATE POLICY breeze_org_isolation_select ON public.network_topology FOR SELECT USING (public.breeze_has_org_access(org_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='network_topology' AND policyname='breeze_org_isolation_insert') THEN
    CREATE POLICY breeze_org_isolation_insert ON public.network_topology FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='network_topology' AND policyname='breeze_org_isolation_update') THEN
    CREATE POLICY breeze_org_isolation_update ON public.network_topology FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='network_topology' AND policyname='breeze_org_isolation_delete') THEN
    CREATE POLICY breeze_org_isolation_delete ON public.network_topology FOR DELETE USING (public.breeze_has_org_access(org_id));
  END IF;
END $$;
```
- [ ] Update the Drizzle schema `apps/api/src/db/schema/discovery.ts` so queries are type-safe. Inside the `networkTopology` `pgTable(...)` column block (after `interfaceName`), add:
```ts
  method: text('method'),
  confidence: text('confidence'),
  createdBy: uuid('created_by'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow(),
```
  Add a uniqueIndex in the table's extra-config callback (the second arg to `pgTable`). If the table currently has no second arg, add one:
```ts
}, (table) => ({
  provenanceUnique: uniqueIndex('ux_network_topology_provenance').on(
    table.orgId, table.siteId, table.sourceType, table.sourceId, table.targetType, table.targetId, table.method
  )
}));
```
  Ensure `text`, `uniqueIndex` are imported at the top of `discovery.ts` (add to the existing `drizzle-orm/pg-core` import if missing).
- [ ] Run drift check (must report no drift — schema matches the migration): `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH && export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:check-drift`. Expected: no drift / "schema matches migrations". If it flags the timezone on `first_seen_at`, reconcile by matching the SQL (`timestamptz`) to the Drizzle `{ withTimezone: true }` — they must agree.
- [ ] Run the migration-ordering regression: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH && pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts`. Expected: pass (filename `2026-06-29-...` sorts after all existing migrations).
- [ ] Commit: `git add apps/api/migrations/2026-06-29-topology-provenance.sql apps/api/src/db/schema/discovery.ts && git commit -m "feat(api): network_topology provenance columns + unique index (#1728)"`

---

### Task 7: API — adjacency types + thread `adjacency` through ingest → worker → process-results

**Files:**
- modify `apps/api/src/jobs/discoveryWorker.ts` (add types, extend `ProcessResultsJobData`, `enqueueDiscoveryResults` signature)
- modify `apps/api/src/jobs/queueSchemas.ts` (Zod: add optional `adjacency` to the `process-results` variant)
- modify `apps/api/src/routes/agentWs.ts` (`handleDiscoveryResult` reads `adjacency`, passes it through)
- test `apps/api/src/jobs/queueSchemas.test.ts` (create if absent, else append)

**Interfaces:**
- Produces (LOCKED contract — exported from `discoveryWorker.ts` for cross-module reuse):
```ts
export interface LldpNeighbor { localPort: string; localIfName?: string; remoteChassisId: string; remotePortId: string; remoteSysName?: string }
export interface CdpNeighbor { localPort: string; remoteDeviceId: string; remotePortId: string; remoteAddress?: string }
export interface FdbEntry { mac: string; bridgePort: number; ifName?: string; vlan?: number }
export interface DeviceAdjacency { sourceDeviceIp: string; sourceChassisId?: string; lldp: LldpNeighbor[]; cdp: CdpNeighbor[]; fdb: FdbEntry[] }
```
- Produces extended signature:
```ts
export async function enqueueDiscoveryResults(
  jobId: string, orgId: string, siteId: string,
  hosts: DiscoveredHostResult[], hostsScanned: number, hostsDiscovered: number,
  profileId?: string, adjacency?: DeviceAdjacency[], meta?: QueueActorMeta,
): Promise<string>
```
  (Adjacency is inserted **before** `meta` to keep `meta` last/defaulted. Update the single existing caller in `agentWs.ts` accordingly.)

Steps:
- [ ] Write a failing Zod test in `apps/api/src/jobs/queueSchemas.test.ts` (append, or create with the standard vitest header):
```ts
import { describe, it, expect } from 'vitest';
import { discoveryQueueJobDataSchema } from './queueSchemas';

describe('discovery process-results adjacency', () => {
  const base = {
    type: 'process-results' as const,
    jobId: 'job-1', orgId: 'org-1', siteId: 'site-1',
    hosts: [], hostsScanned: 0, hostsDiscovered: 0,
  };
  it('accepts an adjacency block with lldp/cdp/fdb', () => {
    const parsed = discoveryQueueJobDataSchema.parse({
      ...base,
      adjacency: [{
        sourceDeviceIp: '10.0.0.1', sourceChassisId: 'aa:bb:cc:dd:ee:ff',
        lldp: [{ localPort: '1', remoteChassisId: 'a1:b2:c3:d4:e5:f6', remotePortId: 'Gi0/1', remoteSysName: 'core' }],
        cdp: [], fdb: [],
      }],
    });
    expect(parsed.type).toBe('process-results');
  });
  it('accepts a payload without adjacency (optional)', () => {
    expect(() => discoveryQueueJobDataSchema.parse(base)).not.toThrow();
  });
});
```
- [ ] Run, expect failure: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH && pnpm --filter @breeze/api exec vitest run src/jobs/queueSchemas.test.ts`. Expected: first case throws (`Unrecognized key "adjacency"` — the variant is `.strict()`).
- [ ] Implement the Zod schema in `apps/api/src/jobs/queueSchemas.ts`. Above `discoveryQueueJobDataSchema`, add:
```ts
const lldpNeighborSchema = z.object({
  localPort: z.string(),
  localIfName: z.string().optional(),
  remoteChassisId: z.string(),
  remotePortId: z.string(),
  remoteSysName: z.string().optional(),
}).strict();
const cdpNeighborSchema = z.object({
  localPort: z.string(),
  remoteDeviceId: z.string(),
  remotePortId: z.string(),
  remoteAddress: z.string().optional(),
}).strict();
const fdbEntrySchema = z.object({
  mac: z.string(),
  bridgePort: z.number().int(),
  ifName: z.string().optional(),
  vlan: z.number().int().optional(),
}).strict();
export const deviceAdjacencySchema = z.object({
  sourceDeviceIp: z.string(),
  sourceChassisId: z.string().optional(),
  lldp: z.array(lldpNeighborSchema),
  cdp: z.array(cdpNeighborSchema),
  fdb: z.array(fdbEntrySchema),
}).strict();
```
  Then add to the `process-results` variant object (after `hostsDiscovered`):
```ts
    adjacency: z.array(deviceAdjacencySchema).optional(),
```
- [ ] In `apps/api/src/jobs/discoveryWorker.ts`: export the four TS interfaces from the Interfaces block above (place them near `DiscoveredHostResult`); add `adjacency?: DeviceAdjacency[]` to `ProcessResultsJobData`; extend `enqueueDiscoveryResults` to the new signature and include `adjacency` in the `withQueueMeta({ type:'process-results', ... })` object passed to `.parse(...)`.
- [ ] In `apps/api/src/routes/agentWs.ts`: extend the `discoveryData` shape to include `adjacency?: DeviceAdjacency[]` (import the type from `../jobs/discoveryWorker`), and pass `discoveryData.adjacency ?? []` into the new `enqueueDiscoveryResults(..., undefined /*profileId*/, discoveryData.adjacency ?? [], { actorType:'agent', ... })` call. Keep `normalizeDiscoveryHosts` for hosts; adjacency needs no date normalization.
- [ ] Run until green: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH && pnpm --filter @breeze/api exec vitest run src/jobs/queueSchemas.test.ts` then `pnpm --filter @breeze/api exec tsc --noEmit`. Expected: tests pass, no type errors.
- [ ] Commit: `git add apps/api/src/jobs/queueSchemas.ts apps/api/src/jobs/queueSchemas.test.ts apps/api/src/jobs/discoveryWorker.ts apps/api/src/routes/agentWs.ts && git commit -m "feat(api): thread adjacency payload agent→worker (#1728)"`

---

### Task 8: API — `reconcileTopology` writer (unit-tested with Drizzle mocks)

**Files:**
- create `apps/api/src/jobs/reconcileTopology.ts`
- create `apps/api/src/jobs/reconcileTopology.test.ts`
- modify `apps/api/src/jobs/discoveryWorker.ts` (replace the `enrichTopology` call site)

**Interfaces:**
- Consumes: `DeviceAdjacency[]`, `DiscoveredHostResult[]` (Task 7), the Drizzle `db` + `networkTopology`, `discoveredAssets`.
- Produces (LOCKED signature):
```ts
export async function reconcileTopology(
  orgId: string,
  siteId: string,
  hosts: DiscoveredHostResult[],
  adjacency: DeviceAdjacency[],
): Promise<void>
```
- Internal pure helper (exported for unit test):
```ts
export function buildInfraEdges(
  orgId: string, siteId: string,
  adjacency: DeviceAdjacency[],
  assetIndex: AssetMatchIndex, // { byMac, byIp, bySysName } maps → assetId
): InfraEdgeUpsert[]
```
  where `InfraEdgeUpsert = { orgId; siteId; sourceType:'discovered_asset'; sourceId; targetType:'discovered_asset'; targetId; connectionType:'infra'; method:'lldp'|'cdp'; confidence:'high'; interfaceName: string|null; vlan: number|null }`.

Behavioral contract (Phase 1):
1. For each `DeviceAdjacency`, resolve the **source** asset id by `sourceDeviceIp` (mgmt IP) — skip the block if unresolved.
2. For each LLDP neighbor: resolve the **target** asset by `remoteChassisId` MAC (normalized), else `remoteSysName`. CDP: by `remoteAddress` IP, else `remoteDeviceId` as sysName. Skip neighbors that don't resolve to an in-inventory asset.
3. Emit one edge per resolved (source,target) with `method` = `lldp`|`cdp`, `confidence='high'`, `connection_type='infra'`, `interface_name = localIfName ?? localPort`, `vlan = null`. De-dupe identical (source,target,method) within a scan (keep first).
4. Upsert each edge on `ux_network_topology_provenance`: `onConflictDoUpdate` set `last_verified_at = now()`, `interface_name`, `updated_at`; on insert set `first_seen_at = now()`, `last_verified_at = now()`.
5. **Age-out:** after upserting, delete measured edges (`method IN ('lldp','cdp')`) in this org+site whose `last_verified_at < now() - (N * scanInterval)` — Phase 1 implements the simpler, deterministic rule from the spec: delete measured edges not re-observed in the **last N=3 scans**, approximated as `last_verified_at` older than the 3rd-most-recent reconcile. To keep Phase 1 self-contained without a new counter table, delete measured rows whose `last_verified_at` is NULL-or-older-than the **current scan's** `reconcileStartedAt` AND not present in this scan's upserted key set. Concretely: collect the upserted keys, then `DELETE ... WHERE method IN ('lldp','cdp') AND org_id=$ AND site_id=$ AND (source_id,target_id,method) NOT IN (<upserted keys>) AND last_verified_at < now() - interval '<3 * default 60s scan> '`. Default age threshold constant `MEASURED_EDGE_AGEOUT_MS = 3 * 60 * 1000` (3 scans × 60s scheduler), exported and documented as configurable in a later phase.
6. **Never** read/modify/delete `method='manual'` rows.

Steps:
- [ ] Write `apps/api/src/jobs/reconcileTopology.test.ts` covering the pure `buildInfraEdges` (no DB): LLDP MAC match, LLDP sysName fallback, CDP IP match, unresolved-target skip, unresolved-source skip, dedupe, confidence/method/connectionType assignment. Example:
```ts
import { describe, it, expect } from 'vitest';
import { buildInfraEdges } from './reconcileTopology';
import type { DeviceAdjacency } from './discoveryWorker';

const idx = {
  byMac: new Map([['aabbccddeeff', 'asset-core'], ['112233445566', 'asset-edge']]),
  byIp: new Map([['10.0.0.1', 'asset-edge'], ['10.0.0.254', 'asset-core']]),
  bySysName: new Map([['core', 'asset-core']]),
};

describe('buildInfraEdges', () => {
  it('builds an LLDP infra edge matched by chassis MAC', () => {
    const adj: DeviceAdjacency[] = [{
      sourceDeviceIp: '10.0.0.1', lldp: [{ localPort: '1', localIfName: 'Gi0/1', remoteChassisId: 'aa:bb:cc:dd:ee:ff', remotePortId: 'Gi0/24', remoteSysName: 'core' }],
      cdp: [], fdb: [],
    }];
    const edges = buildInfraEdges('org-1', 'site-1', adj, idx as any);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      sourceId: 'asset-edge', targetId: 'asset-core',
      method: 'lldp', confidence: 'high', connectionType: 'infra', interfaceName: 'Gi0/1',
    });
  });
  it('skips neighbors not in inventory', () => {
    const adj: DeviceAdjacency[] = [{
      sourceDeviceIp: '10.0.0.1', lldp: [{ localPort: '2', remoteChassisId: 'de:ad:be:ef:00:00', remotePortId: 'x' }], cdp: [], fdb: [],
    }];
    expect(buildInfraEdges('org-1', 'site-1', adj, idx as any)).toHaveLength(0);
  });
  it('skips the whole block when the source IP is unresolved', () => {
    const adj: DeviceAdjacency[] = [{
      sourceDeviceIp: '192.168.99.99', lldp: [{ localPort: '1', remoteChassisId: 'aa:bb:cc:dd:ee:ff', remotePortId: 'y' }], cdp: [], fdb: [],
    }];
    expect(buildInfraEdges('org-1', 'site-1', adj, idx as any)).toHaveLength(0);
  });
  it('builds a CDP edge matched by remote address IP', () => {
    const adj: DeviceAdjacency[] = [{
      sourceDeviceIp: '10.0.0.1', lldp: [], cdp: [{ localPort: '3', remoteDeviceId: 'core', remotePortId: 'Gi0/2', remoteAddress: '10.0.0.254' }], fdb: [],
    }];
    const edges = buildInfraEdges('org-1', 'site-1', adj, idx as any);
    expect(edges[0]).toMatchObject({ sourceId: 'asset-edge', targetId: 'asset-core', method: 'cdp', confidence: 'high' });
  });
  it('dedupes identical source/target/method within one scan', () => {
    const adj: DeviceAdjacency[] = [{
      sourceDeviceIp: '10.0.0.1',
      lldp: [
        { localPort: '1', remoteChassisId: 'aa:bb:cc:dd:ee:ff', remotePortId: 'a' },
        { localPort: '1', remoteChassisId: 'aa:bb:cc:dd:ee:ff', remotePortId: 'a' },
      ], cdp: [], fdb: [],
    }];
    expect(buildInfraEdges('org-1', 'site-1', adj, idx as any)).toHaveLength(1);
  });
});
```
- [ ] Run, expect failure: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH && pnpm --filter @breeze/api exec vitest run src/jobs/reconcileTopology.test.ts`. Expected: `Cannot find module './reconcileTopology'`.
- [ ] Implement `apps/api/src/jobs/reconcileTopology.ts`:
```ts
import * as dbModule from '../db';
import { networkTopology, discoveredAssets } from '../db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DiscoveredHostResult, DeviceAdjacency } from './discoveryWorker';

const { db } = dbModule;

export const MEASURED_EDGE_AGEOUT_MS = 3 * 60 * 1000; // 3 scans × 60s scheduler (configurable later)

export type AssetMatchIndex = {
  byMac: Map<string, string>;
  byIp: Map<string, string>;
  bySysName: Map<string, string>;
};

export type InfraEdgeUpsert = {
  orgId: string;
  siteId: string;
  sourceType: 'discovered_asset';
  sourceId: string;
  targetType: 'discovered_asset';
  targetId: string;
  connectionType: 'infra';
  method: 'lldp' | 'cdp';
  confidence: 'high';
  interfaceName: string | null;
  vlan: number | null;
};

function normMac(v: string | undefined | null): string {
  return (v ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
}

export function buildInfraEdges(
  orgId: string,
  siteId: string,
  adjacency: DeviceAdjacency[],
  assetIndex: AssetMatchIndex,
): InfraEdgeUpsert[] {
  const out: InfraEdgeUpsert[] = [];
  const seen = new Set<string>();

  const push = (sourceId: string, targetId: string, method: 'lldp' | 'cdp', iface: string | null) => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    const key = `${sourceId}|${targetId}|${method}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      orgId, siteId,
      sourceType: 'discovered_asset', sourceId,
      targetType: 'discovered_asset', targetId,
      connectionType: 'infra', method, confidence: 'high',
      interfaceName: iface, vlan: null,
    });
  };

  for (const block of adjacency) {
    const sourceId = assetIndex.byIp.get(block.sourceDeviceIp);
    if (!sourceId) continue;

    for (const n of block.lldp ?? []) {
      const targetId =
        assetIndex.byMac.get(normMac(n.remoteChassisId)) ??
        (n.remoteSysName ? assetIndex.bySysName.get(n.remoteSysName) : undefined);
      if (!targetId) continue;
      push(sourceId, targetId, 'lldp', n.localIfName ?? n.localPort ?? null);
    }

    for (const n of block.cdp ?? []) {
      const targetId =
        (n.remoteAddress ? assetIndex.byIp.get(n.remoteAddress) : undefined) ??
        (n.remoteDeviceId ? assetIndex.bySysName.get(n.remoteDeviceId) : undefined);
      if (!targetId) continue;
      push(sourceId, targetId, 'cdp', n.localPort ?? null);
    }
  }
  return out;
}

async function buildAssetIndex(orgId: string, siteId: string): Promise<AssetMatchIndex> {
  const rows = await db
    .select({
      id: discoveredAssets.id,
      ip: discoveredAssets.ipAddress,
      mac: discoveredAssets.macAddress,
      sysName: discoveredAssets.hostname,
      snmp: discoveredAssets.snmpData,
    })
    .from(discoveredAssets)
    .where(and(eq(discoveredAssets.orgId, orgId), eq(discoveredAssets.siteId, siteId)));

  const byMac = new Map<string, string>();
  const byIp = new Map<string, string>();
  const bySysName = new Map<string, string>();
  for (const r of rows) {
    if (r.mac) byMac.set(normMac(r.mac), r.id);
    if (r.ip) byIp.set(r.ip, r.id);
    const snmpName = (r.snmp as { sysName?: string } | null)?.sysName;
    if (r.sysName) bySysName.set(r.sysName, r.id);
    if (snmpName) bySysName.set(snmpName, r.id);
  }
  return { byMac, byIp, bySysName };
}

export async function reconcileTopology(
  orgId: string,
  siteId: string,
  _hosts: DiscoveredHostResult[],
  adjacency: DeviceAdjacency[],
): Promise<void> {
  if (!adjacency || adjacency.length === 0) {
    // No measured evidence this scan — age out only, do not delete recent edges.
    await ageOutMeasuredEdges(orgId, siteId, []);
    return;
  }

  const assetIndex = await buildAssetIndex(orgId, siteId);
  const edges = buildInfraEdges(orgId, siteId, adjacency, assetIndex);

  for (const e of edges) {
    await db
      .insert(networkTopology)
      .values({
        orgId: e.orgId,
        siteId: e.siteId,
        sourceType: e.sourceType,
        sourceId: e.sourceId,
        targetType: e.targetType,
        targetId: e.targetId,
        connectionType: e.connectionType,
        method: e.method,
        confidence: e.confidence,
        interfaceName: e.interfaceName,
        vlan: e.vlan,
        lastVerifiedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          networkTopology.orgId, networkTopology.siteId,
          networkTopology.sourceType, networkTopology.sourceId,
          networkTopology.targetType, networkTopology.targetId,
          networkTopology.method,
        ],
        set: {
          interfaceName: e.interfaceName,
          confidence: e.confidence,
          lastVerifiedAt: new Date(),
          updatedAt: new Date(),
        },
      });
  }

  await ageOutMeasuredEdges(orgId, siteId, edges);
}

async function ageOutMeasuredEdges(orgId: string, siteId: string, upserted: InfraEdgeUpsert[]): Promise<void> {
  const cutoff = new Date(Date.now() - MEASURED_EDGE_AGEOUT_MS);
  const keepIds = upserted.length > 0
    ? await db
        .select({ id: networkTopology.id })
        .from(networkTopology)
        .where(and(
          eq(networkTopology.orgId, orgId),
          eq(networkTopology.siteId, siteId),
          inArray(networkTopology.method, ['lldp', 'cdp']),
          sql`${networkTopology.lastVerifiedAt} >= ${cutoff.toISOString()}::timestamptz`,
        ))
    : [];
  const keep = new Set(keepIds.map((r) => r.id));

  const stale = await db
    .select({ id: networkTopology.id })
    .from(networkTopology)
    .where(and(
      eq(networkTopology.orgId, orgId),
      eq(networkTopology.siteId, siteId),
      inArray(networkTopology.method, ['lldp', 'cdp']),
      sql`(${networkTopology.lastVerifiedAt} IS NULL OR ${networkTopology.lastVerifiedAt} < ${cutoff.toISOString()}::timestamptz)`,
    ));

  const toDelete = stale.map((r) => r.id).filter((id) => !keep.has(id));
  if (toDelete.length > 0) {
    await db.delete(networkTopology).where(inArray(networkTopology.id, toDelete));
  }
}
```
  (Note: `method='manual'` rows are never selected — the `inArray(method, ['lldp','cdp'])` predicate excludes them everywhere, satisfying the "manual edges never touched" contract.)
- [ ] In `apps/api/src/jobs/discoveryWorker.ts`: import `reconcileTopology`; replace the `enrichTopology(data.orgId, data.siteId, data.hosts)` call (line ~1020) with `await reconcileTopology(data.orgId, data.siteId, data.hosts, data.adjacency ?? [])`. Leave `cleanupSpeculativeTopologyLinks` exported (it may still be referenced by tests) but delete the now-unused `enrichTopology` function and its doc comment. (Grep first: `grep -rn "enrichTopology" apps/api/src` — if other callers exist, keep it; otherwise remove.)
- [ ] Run until green: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH && pnpm --filter @breeze/api exec vitest run src/jobs/reconcileTopology.test.ts` then `pnpm --filter @breeze/api exec tsc --noEmit`. Expected: pass.
- [ ] Commit: `git add apps/api/src/jobs/reconcileTopology.ts apps/api/src/jobs/reconcileTopology.test.ts apps/api/src/jobs/discoveryWorker.ts && git commit -m "feat(api): reconcileTopology writes measured infra edges (#1728)"`

---

### Task 9: API — reconcileTopology real-DB integration test (RLS + upsert + age-out + manual preservation)

**Files:**
- create `apps/api/src/__tests__/integration/reconcile-topology.integration.test.ts`

**Interfaces:**
- Consumes: `reconcileTopology` (Task 8), real `breeze_app` DB via `vitest.integration.config.ts`, `withSystemDbAccessContext`.

This test proves the DB-touching behavior the unit test can't: idempotent upsert on the unique index, `last_verified_at` bump, age-out of stale measured edges, **manual edge survival**, and that RLS does not block the system-context writer. Follow the existing integration-test harness (autoMigrate + per-test TRUNCATE + fresh seed; see a sibling `*.integration.test.ts` for the seed helpers and `withSystemDbAccessContext` usage).

Steps:
- [ ] Create the integration test:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import * as dbModule from '../../db';
import { networkTopology, discoveredAssets } from '../../db/schema';
import { and, eq } from 'drizzle-orm';
import { reconcileTopology, MEASURED_EDGE_AGEOUT_MS } from '../../jobs/reconcileTopology';
import type { DeviceAdjacency } from '../../jobs/discoveryWorker';
// import the repo's integration seed helpers (org/site/partner). Mirror a sibling integration test.

const { withSystemDbAccessContext } = dbModule;

describe('reconcileTopology (real DB)', () => {
  let orgId: string; let siteId: string; let coreId: string; let edgeId: string;

  beforeEach(async () => {
    // seed partner→org→site, then two discovered_assets (core + edge switch) in this site.
    // coreId/edgeId/orgId/siteId set here using the repo's seed helpers.
    // edge mgmt IP 10.0.0.1, mac 1122..; core mac aabb.., ip 10.0.0.254, hostname 'core'.
  });

  const adjacency: DeviceAdjacency[] = [{
    sourceDeviceIp: '10.0.0.1',
    lldp: [{ localPort: '1', localIfName: 'Gi0/1', remoteChassisId: 'aa:bb:cc:dd:ee:ff', remotePortId: 'Gi0/24', remoteSysName: 'core' }],
    cdp: [], fdb: [],
  }];

  it('upserts an infra edge and is idempotent across two scans (one row, bumped last_verified_at)', async () => {
    await withSystemDbAccessContext(() => reconcileTopology(orgId, siteId, [], adjacency));
    const first = await dbModule.db.select().from(networkTopology).where(eq(networkTopology.orgId, orgId));
    expect(first).toHaveLength(1);
    expect(first[0].method).toBe('lldp');
    expect(first[0].confidence).toBe('high');
    expect(first[0].connectionType).toBe('infra');
    expect(first[0].interfaceName).toBe('Gi0/1');
    const firstVerified = first[0].lastVerifiedAt;

    await new Promise((r) => setTimeout(r, 5));
    await withSystemDbAccessContext(() => reconcileTopology(orgId, siteId, [], adjacency));
    const second = await dbModule.db.select().from(networkTopology).where(eq(networkTopology.orgId, orgId));
    expect(second).toHaveLength(1); // upsert, not a duplicate
    expect(second[0].lastVerifiedAt!.getTime()).toBeGreaterThanOrEqual(firstVerified!.getTime());
  });

  it('ages out a measured edge that is not re-observed and is old enough', async () => {
    await withSystemDbAccessContext(() => reconcileTopology(orgId, siteId, [], adjacency));
    // backdate the edge beyond the age-out window, then reconcile with empty-but-defined adjacency for that pair
    await dbModule.db.update(networkTopology)
      .set({ lastVerifiedAt: new Date(Date.now() - MEASURED_EDGE_AGEOUT_MS - 10_000) })
      .where(eq(networkTopology.orgId, orgId));
    await withSystemDbAccessContext(() => reconcileTopology(orgId, siteId, [], [{
      sourceDeviceIp: '10.0.0.1', lldp: [], cdp: [], fdb: [],
    }]));
    const rows = await dbModule.db.select().from(networkTopology).where(eq(networkTopology.orgId, orgId));
    expect(rows.filter((r) => r.method === 'lldp')).toHaveLength(0);
  });

  it('never deletes a manual edge during reconcile', async () => {
    await dbModule.db.insert(networkTopology).values({
      orgId, siteId,
      sourceType: 'discovered_asset', sourceId: edgeId,
      targetType: 'discovered_asset', targetId: coreId,
      connectionType: 'infra', method: 'manual', confidence: 'asserted',
      lastVerifiedAt: new Date(Date.now() - MEASURED_EDGE_AGEOUT_MS - 60_000),
    });
    await withSystemDbAccessContext(() => reconcileTopology(orgId, siteId, [], adjacency));
    const manual = await dbModule.db.select().from(networkTopology)
      .where(and(eq(networkTopology.orgId, orgId), eq(networkTopology.method, 'manual')));
    expect(manual).toHaveLength(1); // survived
  });
});
```
  (Fill the `beforeEach` seed body using the same helpers a sibling integration test uses — read one first, e.g. an existing `discovery` or `network` integration test, to match seed signatures and the org/site/partner fixtures.)
- [ ] Run (real DB): `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH && pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/reconcile-topology.integration.test.ts`. Expected: all 3 cases pass. (If the harness needs `.env.test`/test DB at :5433, confirm per the integration-run mechanics — a plain :5432 run skips.)
- [ ] Commit: `git add apps/api/src/__tests__/integration/reconcile-topology.integration.test.ts && git commit -m "test(api): reconcileTopology integration — upsert/age-out/manual-preservation (#1728)"`

---

### Task 10: API — extend `GET /discovery/topology` edge payload with provenance

**Files:**
- modify `apps/api/src/routes/discovery.ts`
- test `apps/api/src/routes/discovery.test.ts` (append; follow the existing route-test mock pattern in that file)

**Interfaces:**
- Produces: each edge object in the `/discovery/topology` response gains `method`, `confidence`, `interfaceName`, `vlan` (in addition to existing `id/source/target/type/sourceType/targetType/bandwidth/latency/observedAt/inferred`).

Steps:
- [ ] Append a failing test to `apps/api/src/routes/discovery.test.ts` asserting the edge mapping surfaces the new fields. Mirror the file's existing Drizzle-mock + Hono-app test harness (read the top of the file for the mock setup). Assert that given a `networkTopology` row with `method:'lldp', confidence:'high', interfaceName:'Gi0/1', vlan:10`, the JSON edge includes `{ method:'lldp', confidence:'high', interfaceName:'Gi0/1', vlan:10 }`.
- [ ] Run, expect failure: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH && pnpm --filter @breeze/api exec vitest run src/routes/discovery.test.ts`. Expected: assertion on `method`/`confidence` undefined.
- [ ] Implement — in `apps/api/src/routes/discovery.ts`, inside the `/topology` handler's `edges.map((e) => ({ ... }))` (around line 1276), add to the returned object:
```ts
        method: e.method ?? null,
        confidence: e.confidence ?? null,
        interfaceName: e.interfaceName ?? null,
        vlan: e.vlan ?? null,
```
  Keep the existing `inferred` field. (The `networkTopology` select is `select()` = all columns, so `e.method/e.confidence/e.interfaceName/e.vlan` are already available after Task 6's schema change.)
- [ ] Run until green: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH && pnpm --filter @breeze/api exec vitest run src/routes/discovery.test.ts` then `pnpm --filter @breeze/api exec tsc --noEmit`. Expected: pass.
- [ ] Commit: `git add apps/api/src/routes/discovery.ts apps/api/src/routes/discovery.test.ts && git commit -m "feat(api): expose method/confidence/interfaceName/vlan on topology edges (#1728)"`

---

### Task 11: Web — draw measured infra edges (solid, colored by method) + provenance legend

**Files:**
- modify `apps/web/src/components/discovery/NetworkTopologyMap.tsx`
- test `apps/web/src/components/discovery/NetworkTopologyMap.test.tsx` (create if absent, else append)

**Interfaces:**
- Consumes: `/discovery/topology` edges with `method/confidence/interfaceName/vlan` (Task 10).
- Produces: `TopologyLink` gains `method?: 'lldp'|'cdp'|'fdb'|'manual'`, `confidence?`, `interfaceName?`, `vlan?`; `ApiTopologyLink` gains the same optional fields; `mapLink` threads them; `<line>` stroke color is method-driven (LLDP/CDP solid blue, FDB solid green, manual dashed orange, unknown grey solid); a provenance legend row is rendered. The honest degraded note (when `links.length === 0`) is preserved verbatim.

Steps:
- [ ] Write/append a failing test in `apps/web/src/components/discovery/NetworkTopologyMap.test.tsx`. Stub `ResizeObserver` per repo convention, mock `fetchWithAuth` to return one LLDP edge + two nodes, render, and assert (a) the provenance legend label "LLDP/CDP" (or per the strings you implement) is present and (b) a link `<line>` carries the LLDP color. Skeleton:
```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

beforeEach(() => {
  // @ts-expect-error jsdom lacks ResizeObserver
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async () => ({
    ok: true,
    json: async () => ({
      nodes: [
        { id: 'a', label: 'edge', type: 'switch', status: 'online', ipAddress: '10.0.0.1' },
        { id: 'b', label: 'core', type: 'switch', status: 'online', ipAddress: '10.0.0.254' },
      ],
      subnets: ['10.0.0.0/24'],
      edges: [{ id: 'e1', source: 'a', target: 'b', type: 'infra', sourceType: 'discovered_asset', targetType: 'discovered_asset', method: 'lldp', confidence: 'high', interfaceName: 'Gi0/1', vlan: null }],
    }),
  })),
}));

import NetworkTopologyMap from './NetworkTopologyMap';

describe('NetworkTopologyMap provenance', () => {
  it('renders the provenance legend when measured edges exist', async () => {
    render(<NetworkTopologyMap />);
    await waitFor(() => expect(screen.getByText(/LLDP\/CDP/i)).toBeInTheDocument());
  });
});
```
- [ ] Run, expect failure: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH && pnpm --filter @breeze/web exec vitest run src/components/discovery/NetworkTopologyMap.test.tsx`. Expected: legend text not found.
- [ ] Implement in `apps/web/src/components/discovery/NetworkTopologyMap.tsx`:
  - Extend `ApiTopologyLink` (line 52) and `TopologyLink` (line 41) with `method?: 'lldp'|'cdp'|'fdb'|'manual'; confidence?: string | null; interfaceName?: string | null; vlan?: number | null;`.
  - In `mapLink` (line 157), thread them: `method: link.method, confidence: link.confidence, interfaceName: link.interfaceName, vlan: link.vlan`.
  - Add a method→color map near the existing color constants:
```ts
const EDGE_COLOR_BY_METHOD: Record<string, string> = {
  lldp: '#3b82f6', // blue (high)
  cdp: '#3b82f6',  // blue (high)
  fdb: '#22c55e',  // green (medium) — Phase 2
  manual: '#f97316', // orange (asserted) — Phase 4
};
const EDGE_COLOR_DEFAULT = '#94a3b8';
```
  - In the link `<line>` builder (lines 360-363) replace the static stroke/dasharray with method-driven styling:
```ts
      .attr('stroke', (d) => EDGE_COLOR_BY_METHOD[d.method ?? ''] ?? EDGE_COLOR_DEFAULT)
      .attr('stroke-opacity', 0.85)
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', (d) => (d.method === 'manual' ? '6 4' : '0'));
```
  - Add a provenance legend block near the existing online/offline legend (line 561+), only meaningful when edges exist:
```tsx
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4" style={{ backgroundColor: '#3b82f6' }} />
          LLDP/CDP (measured)
        </span>
```
  - Leave the `links.length === 0` degraded note (line 586+) exactly as-is.
- [ ] Run until green: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH && pnpm --filter @breeze/web exec vitest run src/components/discovery/NetworkTopologyMap.test.tsx`. Expected: pass.
- [ ] Type/astro check: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH && pnpm --filter @breeze/web exec tsc --noEmit`. Expected: no errors.
- [ ] Commit: `git add apps/web/src/components/discovery/NetworkTopologyMap.tsx apps/web/src/components/discovery/NetworkTopologyMap.test.tsx && git commit -m "feat(web): draw measured infra edges with provenance legend (#1728)"`

---

### Task 12: Full-suite verification

**Files:** none (verification only).

Steps:
- [ ] Go: `cd agent && go test -race ./...`. Expected: `ok` for all packages.
- [ ] API unit + typecheck: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH && pnpm --filter @breeze/api exec tsc --noEmit && pnpm --filter @breeze/api exec vitest run src/jobs/reconcileTopology.test.ts src/jobs/queueSchemas.test.ts src/routes/discovery.test.ts`. Expected: pass (run affected files single-fork per the parallel-flakiness note; trust CI for the full suite).
- [ ] API integration: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH && pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/reconcile-topology.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts`. Expected: pass — including rls-coverage (network_topology shape 1, no allowlist change needed).
- [ ] Web: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH && pnpm --filter @breeze/web exec tsc --noEmit && pnpm --filter @breeze/web exec vitest run src/components/discovery/NetworkTopologyMap.test.tsx`. Expected: pass.
- [ ] Drift: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH && export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:check-drift`. Expected: no drift.
- [ ] (No commit — this task only confirms green. Stop here; merging/PR is out of scope for the plan executor unless instructed.)

---

## Notes for the executor
- **RLS:** `network_topology` is shape 1 (auto-discovered `org_id`), already ENABLE+FORCE+4 policies. The migration re-asserts them idempotently. No `rls-coverage.integration.test.ts` allowlist edit. No new tables in Phase 1, so no `ORG_CASCADE_DELETE_ORDER`/partner-purge work this phase (those land with `topology_manual_nodes`/`topology_layout` in Phase 3/4).
- **System context:** the worker already wraps everything in `runWithSystemDbAccess`, so `reconcileTopology`'s `db` writes are system-scoped. The integration test wraps explicitly in `withSystemDbAccessContext` to mirror the worker path and prove RLS doesn't block the writer.
- **Manual-edge safety:** every reconcile query is constrained to `method IN ('lldp','cdp')`; `method='manual'` rows are structurally invisible to the writer.
- **Cross-phase contract conformance:** the Go `DeviceAdjacency`/`LldpNeighbor`/`CdpNeighbor`/`FdbEntry`, the TS interfaces, the `reconcileTopology` signature, the new columns, and `ux_network_topology_provenance` all match the LOCKED contracts verbatim. `fdb[]` is emitted-but-empty in Phase 1; Phase 2 fills it.
