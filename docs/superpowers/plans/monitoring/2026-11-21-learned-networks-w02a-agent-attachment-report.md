# Learned Networks W02a: Agent attachment report in the heartbeat

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every agent sends `networkAttachmentsV1` in its heartbeat: one entry per IPv4 default route on a
LAN interface, with the gateway's MAC from the neighbour cache, under a persisted epoch and sequence.

**Architecture:** A new package `agent/internal/netattach` reads routes, interfaces, neighbours and the
route to the server through its own `networkcontext.NewReader` (never the network-context manager or
its snapshot). `Current` turns those rows into attachments, `State` hands out monotonic sequence numbers
from a file written once per 1,024 reports, and `BuildReport` produces the §7.1 JSON. The heartbeat runs
one bounded read at a time in the background and attaches each finished report to exactly one beat.

**Tech stack:** Go (agent), `golang.org/x/sys/windows` v0.50.0, `internal/collectors/networkcontext`,
`internal/atomicrename`. No cgo.

**Spec:** `docs/superpowers/specs/monitoring/2026-11-20-learned-networks-discovery-gate-design.md` (§7, §7.1, §11)

**Index:** `docs/superpowers/plans/monitoring/2026-11-21-learned-networks.md`. Its Global constraints,
Review focus and Cross-wave contract apply to every task here (this wave owns contract C1 and D1 and
review-focus items 1 and 3).

## Wave constraints

- Agent code ships to customer machines: TDD, one independent review round, `go test -race`.
- Builds and passes with `CGO_ENABLED=0` on Linux, Windows and macOS (Linux and Windows release builds
  are cgo-off; macOS releases are cgo-on and CI vets macOS cgo-off).
- The report never sends a packet to the LAN. It reads OS tables (netlink, the routing socket,
  `iphlpapi`) and resolves the server host through the system resolver. Nothing else.
- Release: the build may merge before W01b, but it is promoted only after W01b is deployed (index
  sequencing rule 3). A server that predates W01b drops the key: `heartbeatSchema`
  (`apps/api/src/routes/agents/schemas.ts:208-586`) is a plain `z.object`, not `.strict()`.
- Fixtures use only the index's synthetic values. `127.0.0.1` appears only as the loopback constant and
  `breeze.example` only as a server host name.
- Native evidence pasted into the PR body is redacted: every real address and MAC is replaced by a
  synthetic value from the index, consistently; interface names and kinds are kept.

## Decisions this plan makes

These close what the spec and contract leave open. The tests in the tasks pin each one.

| # | Decision |
|---|---|
| K1 | **Reportable interface kinds (exclusion rule).** Never reported: `tunnel`, and any `bridge` or `virtual` row without a proven physical uplink. Everything else (`ethernet`, `wifi`, `cellular`, `other`, `unknown`) is reported. `unknown` must stay reportable: macOS classifies every `en*` as `unknown` (`networkcontext/interfacekind.go:127-139`). Loopback never reaches `Current` (the readers drop it, `native.go:69`, `windows.go:96`); `Current` also skips any row whose local or gateway address is loopback. |
| K2 | **Bridged uplink fact, per OS** (the kinds cannot tell an external switch from a NAT switch). Linux: a `bridge` or `virtual` row is bridged when one of its members, read from `/sys/class/net/<name>/brif/*` and `/sys/class/net/<name>/lower_*`, classifies as `ethernet` or `wifi` under the existing sysfs rule. Windows: decided natively in Task 2 between the candidates listed there. macOS: no member list is read in v1, so a macOS `bridge` row is never reported (Contract notes). |
| K3 | **Up:** `OperState == "up"`, or `OperState == "unknown"` and `AdminState == "up"`. Windows rows set `OperState` (`windows.go:105-110`); Linux and macOS set `AdminState` (`native.go:77-85`). |
| K4 | **Default route:** `Family == "ipv4"`, `DestinationPrefix == "0.0.0.0/0"`, `RouteType == "unicast"`, from every routing table except Linux `TableKey == "255"` (local). Each next hop with an address is one candidate; a hop's `InterfaceKey` wins over the row's. Candidates are de-duplicated on (interface key, gateway). macOS scoped defaults (one per interface) are included. |
| K5 | **Local address:** the interface's IPv4 address whose prefix contains the gateway; otherwise its lowest IPv4 address that is not link-local. An interface with neither is skipped. Link-local, loopback, multicast or unspecified gateways are skipped. |
| K6 | **Gateway MAC:** the neighbour row on the same interface key with the gateway's address and a 6-byte MAC, unless its state is `incomplete` or `failed`. Otherwise `nil`. `stale` and `permanent` entries count: the report never probes. |
| K7 | **Primary:** resolve `serverHost` (an IP literal is used as is; otherwise `net.DefaultResolver.LookupNetIP(ctx, "ip4", host)`, first address), then `LookupRoute` with the context key from `Contexts()`. Primary is the attachment on the selected interface whose gateway equals the selected next hop (or the only attachment on that interface when the next hop is nil). At most one. A server route through a tunnel makes nothing primary. **An empty `serverHost` skips the resolve and the route lookup: nothing is primary and no error is added** (index D1; `netguard` calls `Current(ctx, "")`). |
| K8 | **`complete` and `err`:** `err` joins every read error (contexts, interfaces, routes, neighbours, uplink, resolve, route lookup). `complete` is false when `err != nil` or the list was cut. A host name with no IPv4 address is not an error: nothing is primary. An empty `serverHost` is not an error either (K7). `Contexts`, `Interfaces` or `Routes` failing with no rows returns `nil, false, err`. |
| K9 | **Order and cut:** primary first, then `InterfaceName`, then gateway address; cut to `MaxAttachments` (8). Names are truncated to the longest prefix of at most 128 runes **and** 128 UTF-16 units; an empty name becomes `if<index>`. |
| K10 | **Heartbeat timing:** the read runs in one background goroutine at a time with a 3-second context. A beat never waits for it. Each finished report is attached to one beat only. A report whose read exceeded 3 seconds, or that started more than 5 minutes before the beat (half the server's 10-minute capture bound, index E2), is dropped. The first beat after start carries no report. |

## File structure

| File | Responsibility |
|---|---|
| `agent/internal/netattach/attachment.go` | `Attachment`, `MaxAttachments`, `Current`, the `deps` seam, `current` (K1, K3–K9) |
| `agent/internal/netattach/uplink.go` (untagged) | pure uplink rules shared by the OS files (`windowsBridgedUplink`) |
| `agent/internal/netattach/deps_linux.go`, `deps_darwin.go`, `deps_windows.go` | `osDeps()`: the real reader, lookup, resolver and uplink fact for each OS |
| `agent/internal/netattach/state.go` | `State`, `OpenState`, `Next`, the state file |
| `agent/internal/netattach/report.go` | `Report`, `ReportAttachment`, `BuildReport` |
| `agent/internal/netattach/*_test.go` | tests beside each file; `live_test.go` for the native run |
| `agent/internal/collectors/networkcontext/interfacekind.go` | add `LinuxBridgedUplink` (Linux fact, K2) |
| `agent/internal/heartbeat/network_attachments.go` | `netAttachReporter`, `attachNetworkAttachments` |
| `agent/internal/heartbeat/heartbeat.go` | payload field (`:98-101`), reporter fields (`:510-512`), call site (`:5855`) |
| `.github/workflows/ci.yml` | `./internal/netattach` added to `test-agent-windows` (`:2755`) |

---

### Task 1: Linux bridged-uplink fact

**Files:**
- Modify: `agent/internal/collectors/networkcontext/interfacekind.go` (after `readLinuxLinkFacts`, `:92-121`)
- Test: `agent/internal/collectors/networkcontext/interfacekind_test.go`

**Interfaces:**
- Produces: `func LinuxBridgedUplink(root, name string) bool` (untagged, pure on `root`, so it runs on every OS)

- [ ] **Step 1: Write the failing test.** Lift the `mk` closure out of `TestReadLinuxLinkFacts`
(`interfacekind_test.go:55-65`) into a package helper `mk(t, root, name, files, dirs...)` that creates
`root/name/<file>` with the given body and the listed directories (real sysfs uses symlinks for
`brif/*` and `lower_*`; only the entry names are read, so directories stand in for them).

```go
func TestLinuxBridgedUplink(t *testing.T) {
	root := t.TempDir()
	mk(t, root, "eth0", map[string]string{"type": "1\n"}, "device")                        // physical NIC
	mk(t, root, "vnet0", map[string]string{"type": "1\n"}, "tun_flags")                   // tap
	mk(t, root, "veth1", map[string]string{"type": "1\n"})                                 // veth
	mk(t, root, "br0", map[string]string{"type": "1\n", "uevent": "DEVTYPE=bridge\n"}, "brif/eth0", "brif/vnet0")
	mk(t, root, "virbr0", map[string]string{"type": "1\n", "uevent": "DEVTYPE=bridge\n"}, "brif/vnet0")
	mk(t, root, "docker0", map[string]string{"type": "1\n", "uevent": "DEVTYPE=bridge\n"}, "brif/veth1")
	mk(t, root, "mv0", map[string]string{"type": "1\n"}, "lower_eth0")
	mk(t, root, "empty0", map[string]string{"type": "1\n", "uevent": "DEVTYPE=bridge\n"})
	for name, want := range map[string]bool{
		"br0": true, "mv0": true, "virbr0": false, "docker0": false, "empty0": false,
		"missing": false, "../br0": false, "": false,
	} {
		if got := LinuxBridgedUplink(root, name); got != want {
			t.Errorf("LinuxBridgedUplink(%q) = %v, want %v", name, got, want)
		}
	}
}
```

- [ ] **Step 2: Run it and see it fail.** `cd agent && go test -race -run TestLinuxBridgedUplink ./internal/collectors/networkcontext/` → FAIL, `undefined: LinuxBridgedUplink`.

- [ ] **Step 3: Implement `LinuxBridgedUplink(root, name string) bool`.** Reject a name that is not one path
element (same rule as `readLinuxLinkFacts`). Members are the entries of `root/name/brif/` plus every
`root/name/lower_<member>` entry. True when any member's `linuxInterfaceKind(readLinuxLinkFacts(root, member))`
is `ethernet` or `wifi`. Any read error is false.

- [ ] **Step 4: Run it and see it pass** (same command). Expected: PASS.
- [ ] **Step 5: Commit** both files: `feat(agent): read whether a Linux bridge has a physical member`.

### Task 2: Windows bridged-uplink fact (pinned natively first)

The Windows kinds put an external vEthernet, an internal or NAT vEthernet and TAP-style VPN adapters all
under `virtual` (`interfacekind.go:141-170`). Which extra fact separates the first from the others is
**not established by reading the code**. This task decides it on real hosts before any of it is coded.

**Files:**
- Create: `agent/internal/netattach/uplink.go`, `agent/internal/netattach/uplink_test.go`
- Create (in Task 3's `deps_windows.go`): the reader for the chosen fact

**Interfaces:**
- Produces: `type hardwareInterface struct { Index uint32; MAC string; Up bool }` and
  `func windowsBridgedUplink(row networkcontext.InterfaceRow, hw []hardwareInterface) bool` (candidate A)

- [ ] **Step 1: Record the facts natively.** On a Windows host with Hyper-V and three switches (external
with "allow management OS to share", internal, and the Default Switch) and with a TAP-style VPN adapter
installed, run as administrator and save the output outside the repo:

```powershell
Get-NetAdapter -IncludeHidden | Sort-Object ifIndex | Format-Table ifIndex,Name,InterfaceDescription,MacAddress,Status,HardwareInterface,ConnectorPresent,Virtual -AutoSize
Get-VMSwitch | Format-Table Name,SwitchType,NetAdapterInterfaceDescription
Get-NetIPConfiguration | Format-Table InterfaceIndex,InterfaceAlias,IPv4DefaultGateway
```

Candidates, in order of preference (none verified):

| | Fact | Read with | Would separate them if |
|---|---|---|---|
| A | The `virtual` row's MAC equals the MAC of an up interface with the `HardwareInterface` flag | `GetIfTable2Ex(MibIfTableNormalWithoutStatistics)` (x/sys v0.50.0 has it; no `Rows()` helper, so `unsafe.Slice(&t.Table[0], t.NumEntries)` then `FreeMibTable`) | the external vEthernet shares the physical NIC's MAC and no internal, NAT or TAP adapter shares a hardware MAC |
| B | The `virtual` row's `ConnectorPresent` flag (`InterfaceAndOperStatusFlags` bit 2) | `GetIfEntry2` by LUID, as `windowsHardwareInterface` does (`windows.go:412-418`) | only the external vEthernet sets it |
| C | Hyper-V's own switch type for the adapter | WMI `root\virtualization\v2` | always, but needs the Hyper-V WMI provider and a WMI call per read |

- [ ] **Step 2: Decide.** Adopt the first candidate whose condition holds in the Step 1 output. Write the
table of adapters (redacted MACs) and the chosen candidate in the PR body. If none holds, stop and take
it to the owner: without it a Hyper-V host cannot report (review focus 1).

- [ ] **Step 3: Write the failing test** `TestWindowsBridgedUplink` (table; shown for candidate A, for
B or C the same rows expressed in that fact). The NIC is `hardwareInterface{Index: 4, MAC: "00:1a:8c:00:00:01", Up: true}`;
rows have `OSIndex: 12` unless stated.

| Row | Kind, MAC | Hardware list | Want |
|---|---|---|---|
| external switch shares the NIC's MAC | `virtual`, `00:1a:8c:00:00:01` | the NIC | true |
| NAT or internal switch has its own MAC | `virtual`, `3c:37:86:aa:bb:10` | the NIC | false |
| matching NIC is down | `virtual`, `00:1a:8c:00:00:01` | the NIC with `Up: false` | false |
| virtual row without a MAC | `virtual`, `""` | the NIC | false |
| the row is the NIC itself (`OSIndex: 4`) | `virtual`, `00:1a:8c:00:00:01` | the NIC | false |
| tunnel kind never | `tunnel`, `00:1a:8c:00:00:01` | the NIC | false |

- [ ] **Step 4: Run it and see it fail.** `cd agent && go test -race -run TestWindowsBridgedUplink ./internal/netattach/` → FAIL, undefined.
- [ ] **Step 5: Implement `windowsBridgedUplink`** in `uplink.go` (untagged, pure). Only `virtual` rows qualify.
- [ ] **Step 6: Run it and see it pass** (same command).
- [ ] **Step 7: Commit** `feat(agent): rule for a Windows virtual adapter bridged to a NIC`.

### Task 3: `Current`

**Files:**
- Create: `agent/internal/netattach/attachment.go`, `attachment_test.go`, `deps_linux.go`, `deps_darwin.go`, `deps_windows.go`

**Interfaces:**
- Consumes: `networkcontext.NewReader`, `Reader`, `RouteLookupRequest`, `RouteSelection`; Task 1 and Task 2 rules.
- Produces (D1, verbatim): `type Attachment struct { InterfaceName string; InterfaceIndex uint32; LocalAddress netip.Addr; PrefixLength uint8; GatewayAddress netip.Addr; GatewayMAC net.HardwareAddr; Primary bool }`, `const MaxAttachments = 8`, `func Current(ctx context.Context, serverHost string) (attachments []Attachment, complete bool, err error)`.
- Seam (unexported; the only thing tests construct):

```go
type deps struct {
	reader  networkcontext.Reader
	lookup  func(context.Context, networkcontext.RouteLookupRequest) (networkcontext.RouteSelection, error)
	resolve func(ctx context.Context, host string) ([]netip.Addr, error)
	// bridged reports, by InterfaceKey, which bridge or virtual rows have a physical uplink (K2).
	bridged func(context.Context, []networkcontext.InterfaceRow) (map[string]bool, error)
}
func current(ctx context.Context, d deps, serverHost string) ([]Attachment, bool, error)
func osDeps() deps // per OS; Current is `return current(ctx, osDeps(), serverHost)`
```

`osDeps`: `reader` is `networkcontext.NewReader("netattach")` built once per process (the string only
scopes interface keys inside this process; Windows ignores it). `lookup` is the reader's `LookupRoute`
reached by type assertion as `internal/networkdiagnostic/native.go:31-37` does; a failed assertion
returns `networkcontext.ErrUnsupported`. `resolve` wraps `net.DefaultResolver.LookupNetIP`. `bridged`:
Linux calls `networkcontext.LinuxBridgedUplink("/sys/class/net", row.Name)` for each `bridge` or
`virtual` row; Windows reads the Task 2 fact once per call (resolve any iphlpapi export with
`LazyProc.Find()` before `Call()`, precedent `getIfEntry2`, `windows.go:420-435`); macOS returns an empty map.

- [ ] **Step 1: Write the failing tests.** Fixtures are built in code with a `fixture` builder in
`attachment_test.go` whose `deps()` returns a `deps` backed by a fake `networkcontext.Reader`. Its
methods (signatures only; the implementer writes the bodies):

```go
func newFixture(t *testing.T) *fixture
func (f *fixture) iface(key, name, kind string, up upShape, cidrs ...string) *fixture // OSIndex = order added, from 1
func (f *fixture) route(key, gateway string) *fixture                                // ipv4 0.0.0.0/0 unicast, TableKey "254"
func (f *fixture) neigh(key, address, mac, state string) *fixture                   // mac "" = nil
func (f *fixture) bridged(keys ...string) *fixture
func (f *fixture) serverVia(key, nextHop string) *fixture                           // "breeze.example" -> 203.0.113.20 -> key
func (f *fixture) fail(section string, err error) *fixture // "contexts","interfaces","routes","neighbors","lookup","resolve","bridged"
func (f *fixture) deps() deps
type upShape int // upUnix (AdminState up, OperState unknown), upWindows (OperState up), down
```

```go
func TestCurrent_BridgedUplinkIsReported(t *testing.T) {
	for _, tc := range []struct{ name, iface, kind string }{
		{"hyper-v external switch", "vEthernet (External)", "virtual"},
		{"linux bridge with a physical port", "br0", "bridge"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := newFixture(t).iface("k1", tc.iface, tc.kind, upWindows, "192.168.1.57/24").
				route("k1", "192.168.1.1").neigh("k1", "192.168.1.1", "a4:2b:b0:11:22:9c", "reachable").
				bridged("k1").serverVia("k1", "192.168.1.1").deps()
			got, complete, err := current(context.Background(), d, "breeze.example")
			want := []Attachment{{InterfaceName: tc.iface, InterfaceIndex: 1,
				LocalAddress: netip.MustParseAddr("192.168.1.57"), PrefixLength: 24,
				GatewayAddress: netip.MustParseAddr("192.168.1.1"),
				GatewayMAC: mustMAC(t, "a4:2b:b0:11:22:9c"), Primary: true}}
			if err != nil || !complete || !reflect.DeepEqual(got, want) {
				t.Fatalf("got %+v complete=%v err=%v", got, complete, err)
			}
		})
	}
}

func TestCurrent_NatSwitchIsSkipped(t *testing.T) {
	for _, tc := range []struct{ name, iface, kind string }{
		{"hyper-v internal or NAT switch", "vEthernet (Default Switch)", "virtual"},
		{"tap-style VPN adapter", "Ethernet 3", "virtual"},
		{"container veth behind a NAT bridge", "eth0", "virtual"},
		{"linux bridge with only tap or veth ports", "virbr0", "bridge"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := newFixture(t).iface("k1", tc.iface, tc.kind, upUnix, "10.1.2.57/24").
				route("k1", "10.1.2.100").neigh("k1", "10.1.2.100", "3c:37:86:aa:bb:10", "reachable").
				serverVia("k1", "10.1.2.100").deps() // not bridged
			got, complete, err := current(context.Background(), d, "breeze.example")
			if err != nil || !complete || len(got) != 0 {
				t.Fatalf("got %+v complete=%v err=%v; want empty, complete", got, complete, err)
			}
		})
	}
}

func TestCurrent_TwoDefaultRoutes(t *testing.T) {
	d := newFixture(t).
		iface("k1", "Ethernet", "ethernet", upWindows, "192.168.1.57/24").route("k1", "192.168.1.1").
		neigh("k1", "192.168.1.1", "a4:2b:b0:11:22:9c", "reachable").
		iface("k2", "Wi-Fi", "wifi", upWindows, "10.1.2.57/24").route("k2", "10.1.2.100").
		neigh("k2", "10.1.2.100", "3c:37:86:aa:bb:10", "stale").
		serverVia("k2", "10.1.2.100").deps()
	got, complete, err := current(context.Background(), d, "breeze.example")
	// one per LAN route; the server route decides primary, not the metric; primary sorts first
	if err != nil || !complete || len(got) != 2 ||
		got[0].InterfaceName != "Wi-Fi" || !got[0].Primary || got[0].GatewayMAC.String() != "3c:37:86:aa:bb:10" ||
		got[1].InterfaceName != "Ethernet" || got[1].Primary || got[1].GatewayMAC.String() != "a4:2b:b0:11:22:9c" {
		t.Fatalf("got %+v complete=%v err=%v", got, complete, err)
	}
}
```

Further table tests in the same file (one `t.Run` per row; each asserts the full `[]Attachment`,
`complete` and whether `err` is nil):

| Test | Fixture | Expected |
|---|---|---|
| `TestCurrent_TunnelAndLoopbackExcluded` | (a) `tunnel` row with a default route; (b) `other` row `127.0.0.1/8` with default via `127.0.0.1`; (c) default route on a key with no interface row; (d) an `ethernet` row that is `down`; (e) a `blackhole` default and a `0.0.0.0/0` in `TableKey "255"` | no attachments, `complete` true |
| `TestCurrent_ReportableKinds` | one row per kind `ethernet wifi cellular other unknown` (reported), `tunnel` (never, even with `bridged`), `bridge virtual` (only with `bridged`) | exactly K1 |
| `TestCurrent_UpPredicate` | `upUnix`, `upWindows`, `down`, and `OperState "down", AdminState "up"` | reported, reported, skipped, skipped |
| `TestCurrent_MissingNeighbourGivesNilMAC` | (a) no neighbour row; (b) row state `incomplete`, MAC nil; (c) row state `failed` with a MAC; (d) the right MAC on another interface key; (e) `permanent` with a MAC | `GatewayMAC == nil` for (a)–(d), the MAC for (e); always `complete` true |
| `TestCurrent_LocalAddressChoice` | `ethernet` row with `10.1.2.57/24` and `192.168.1.57/24`, default via `192.168.1.1`; a second row whose only address does not contain its gateway | `192.168.1.57/24`; the lowest non-link-local IPv4 for the second |
| `TestCurrent_TwoDefaultRoutes` subtest "office LAN under a full-tunnel VPN" | Ethernet as above, plus `utun4` (kind `tunnel`, `10.1.2.57/32`, default via `10.1.2.100`); server via `utun4` | one attachment, Ethernet, `Primary` false; `complete` true |
| `TestCurrent_ReadFailureIsIncomplete` | `fail("neighbors")`; `fail("lookup")`; `fail("resolve")`; `fail("bridged")` with one `bridge` and one `ethernet` row; `fail("routes")`, `fail("interfaces")`, `fail("contexts")`, each with no rows | attachments with nil MACs / no primary / no primary / the `ethernet` one only / `nil` / `nil` / `nil`; `complete` false and `err` non-nil in every row |
| `TestCurrent_ServerWithoutIPv4` | `resolve` returns only an IPv6 address | attachments, none primary, `complete` true, `err` nil |
| `TestCurrent_EmptyServerHost` | the `TestCurrent_TwoDefaultRoutes` fixture plus `fail("resolve", e)` and `fail("lookup", e)`; `current(ctx, d, "")` | both attachments, none `Primary`, `complete` true, `err` nil (so neither resolve nor lookup was called) |
| `TestCurrent_CutToEight` | ten `ethernet` rows `eth0`…`eth9`, addresses `192.168.1.50`…`192.168.1.59/24`, all via `192.168.1.1`; server via `eth9` | 8: `eth9` (primary), then `eth0`…`eth6`; `complete` false, `err` nil |
| `TestCurrent_NameIsCapped` | names of 130 × `é`, 70 × `😀`, and `""` at index 3 | 128 runes; 64 runes; `if3` |

- [ ] **Step 2: Run them and see them fail.** `cd agent && go test -race -run 'TestCurrent_' ./internal/netattach/` → FAIL, `undefined: current`.

- [ ] **Step 3: Implement `current`, `Current`, and `osDeps` for the three OSes** per K1 and K3–K9. Read
order: `Contexts` (first context's key), then `Interfaces`, `Routes` and `Neighbors` for
`Families: []string{"ipv4"}`, then `bridged` for the `bridge` and `virtual` rows, then resolve and
`lookup`. Keep the rows a reader returns alongside its error (the Linux reader returns partial rows
with `errors.Join`).

- [ ] **Step 4: Run them and see them pass** (same command), then the cross-compile checks:

```bash
cd agent && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go vet ./internal/netattach/ \
  && CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go vet ./internal/netattach/ \
  && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go vet ./internal/netattach/
```
Expected: no output, exit 0.

- [ ] **Step 5: Commit** `feat(agent): read current network attachments without the context manager`.

### Task 4: `State`

**Files:**
- Create: `agent/internal/netattach/state.go`, `state_test.go`

**Interfaces:**
- Produces (D1): `type State struct{...}`, `func OpenState(path string) (*State, error)`,
  `func (s *State) Next() (epoch string, sequence uint64, err error)`.
- Unexported seams: `persist func(path string, data []byte) error` (default `writeStateFile`) and
  `random io.Reader` (default `crypto/rand.Reader`), set by tests through `openStateWith`.

File `network-attachment-state.json` in `config.GetDataDir()`, mode 0600, content
`{"epoch":"<16 lower-case hex>","reservedThrough":<n>}`. It records a high-water mark: every sequence
this epoch has handed out is at most `reservedThrough`. `OpenState` keeps a valid file's epoch and sets
`next = reservedThrough + 1`, so a restart resumes above anything sent. A missing, unreadable, larger
than 4 KiB or invalid file (bad JSON, epoch not `^[0-9a-f]{16}$`, `reservedThrough` outside
`0..2^53-1`) gets a new random epoch with `next = 1`. `OpenState` returns an error only when the random
source fails. `writeStateFile` follows `internal/heartbeat/control_plane_block.go:267-337`: temp file in
the same directory, `Chmod(0600)`, write, `Sync`, `Close`, `atomicrename.Replace`, then a best-effort
directory sync off Windows.

`Next` is the one algorithm the signature does not determine:

```go
const blockSize = 1024
const maxSequence = 1<<53 - 1 // the server parses a JSON number

func (s *State) Next() (string, uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.next == 0 || s.next > maxSequence {
		if err := s.newEpoch(); err != nil { // next = 1, reservedThrough = 0
			return "", 0, err
		}
	}
	if s.next > s.reservedThrough {
		ceiling := min(s.next+blockSize-1, maxSequence)
		if err := s.persist(s.path, encodeState(s.epoch, ceiling)); err != nil {
			// The file may hold a mark below what this epoch has sent: never continue it.
			s.warnOnce(err)
			if err := s.newEpoch(); err != nil {
				return "", 0, err
			}
			ceiling = blockSize // memory-only block; the write is retried when it is used up
		}
		s.reservedThrough = ceiling
	}
	seq := s.next
	s.next++
	return s.epoch, seq, nil
}
```

- [ ] **Step 1: Write the failing tests.** `stateFromFile(t, body)` writes `body` to a temp
`network-attachment-state.json` and opens it; `openStateWith(path, persist, random)` sets the seams.

| Test | Setup | Asserts |
|---|---|---|
| `TestOpenState_MissingFileCreatesEpoch` | no file | `OpenState` err nil; `Next` → epoch matches `^[0-9a-f]{16}$`, seq 1; the file parses to `{epoch, reservedThrough: 1024}`; off Windows its mode is `0600` |
| `TestState_SequenceSurvivesRestart` | s1: `Next` ×3; s2 = `OpenState` on the same path, one `Next`; s3 likewise | s1 → 1, 2, 3; s2 → 1025; s3 → 2049; one epoch throughout |
| `TestState_PersistsOncePerBlock` | counting `persist` seam | 2,048 `Next` → 2 writes; the 2,049th → 3 |
| `TestOpenState_CorruptFileGetsNewEpoch` | bodies `{not json`; `{"epoch":"XYZ","reservedThrough":5}`; `{"epoch":"9f2c1e7ab4d04c11","reservedThrough":-1}`; the same epoch with `9007199254740992`; 5,000 spaces | `OpenState` err nil; `Next` → valid epoch other than `9f2c1e7ab4d04c11`, seq 1; the file then parses with the new epoch |
| `TestState_PersistFailureRotatesEpoch` | `{"epoch":"9f2c1e7ab4d04c11","reservedThrough":417}`, failing `persist` | `Next` → new epoch, seq 1, err nil; `Next` → same epoch, seq 2, no write attempted; with `persist` restored, nothing is written up to seq 1024 and seq 1025 writes `{newEpoch, 2048}` |
| `TestState_RotatesAtSafeIntegerLimit` | `reservedThrough` = 2^53 − 1 | `Next` → new epoch, seq 1 |
| `TestState_RandomFailure` | no file, failing `random` | `OpenState` returns a non-nil error |
| `TestState_ConcurrentNextIsUnique` | 8 goroutines × 300 `Next` under `-race` | 2,400 distinct sequences, one epoch |

- [ ] **Step 2: Run them and see them fail.** `cd agent && go test -race -run 'TestOpenState_|TestState_' ./internal/netattach/` → FAIL, undefined.
- [ ] **Step 3: Implement `OpenState`, `Next`, `newEpoch` (8 bytes from `random`, hex), `encodeState`, `writeStateFile`.** `warnOnce` logs through `logging.L("netattach")`.
- [ ] **Step 4: Run them and see them pass** (same command). On a Windows machine or VM also run `CGO_ENABLED=0 go test ./internal/netattach/` (the rename path differs there; CI covers it after Task 7).
- [ ] **Step 5: Commit** `feat(agent): persisted epoch and sequence for attachment reports`.

### Task 5: `Report` and `BuildReport`

**Files:**
- Create: `agent/internal/netattach/report.go`, `report_test.go`

**Interfaces:**
- Consumes: `Current`, `State.Next`.
- Produces (D1, C1). Field order is the JSON order of §7.1:

```go
type Report struct {
	Epoch       string             `json:"epoch"`
	Sequence    uint64             `json:"sequence"`
	CapturedAt  string             `json:"capturedAt"` // now.UTC(), time.RFC3339 (whole seconds)
	Complete    bool               `json:"complete"`
	Attachments []ReportAttachment `json:"attachments"` // never nil
}
type ReportAttachment struct {
	InterfaceName  string  `json:"interfaceName"`
	LocalAddress   string  `json:"localAddress"`
	PrefixLength   uint8   `json:"prefixLength"`
	GatewayAddress string  `json:"gatewayAddress"`
	GatewayMac     *string `json:"gatewayMac"` // lower-case aa:bb:cc:dd:ee:ff, null when absent
	Primary        bool    `json:"primary"`
}
func BuildReport(ctx context.Context, st *State, serverHost string, now time.Time) Report
func buildReport(ctx context.Context, st *State, serverHost string, now time.Time,
	cur func(context.Context, string) ([]Attachment, bool, error)) Report // seam; BuildReport passes Current
```

`buildReport` calls `cur` first, then `st.Next()`. A read error gives `Complete: false` with whatever
attachments came back. A `Next` error gives the zero `Report` (empty `Epoch`), which the heartbeat never
attaches.

- [ ] **Step 1: Write the failing tests**

```go
// The exact JSON of spec §7.1, compacted.
const specReport = `{"epoch":"9f2c1e7ab4d04c11","sequence":418,"capturedAt":"2026-11-20T15:04:05Z","complete":true,"attachments":[{"interfaceName":"Ethernet","localAddress":"192.168.1.57","prefixLength":24,"gatewayAddress":"192.168.1.1","gatewayMac":"a4:2b:b0:11:22:9c","primary":true}]}`

func TestBuildReport_MatchesSpecJSON(t *testing.T) {
	st := stateFromFile(t, `{"epoch":"9f2c1e7ab4d04c11","reservedThrough":417}`) // Next -> 418
	now := time.Date(2026, 11, 20, 10, 4, 5, 987_000_000, time.FixedZone("EST", -5*3600))
	cur := func(context.Context, string) ([]Attachment, bool, error) {
		return []Attachment{{InterfaceName: "Ethernet", InterfaceIndex: 7,
			LocalAddress: netip.MustParseAddr("192.168.1.57"), PrefixLength: 24,
			GatewayAddress: netip.MustParseAddr("192.168.1.1"),
			GatewayMAC: mustMAC(t, "a4:2b:b0:11:22:9c"), Primary: true}}, true, nil
	}
	b, _ := json.Marshal(buildReport(context.Background(), st, "breeze.example", now, cur))
	if string(b) != specReport {
		t.Fatalf("got  %s\nwant %s", b, specReport)
	}
}
```

| Test | Input | Asserts |
|---|---|---|
| `TestBuildReport_EmptyCompleteList` | `cur` returns `nil, true, nil` | JSON contains `"complete":true,"attachments":[]` |
| `TestBuildReport_NilMACIsNull` | one attachment with `GatewayMAC: nil` | JSON contains `"gatewayMac":null` |
| `TestBuildReport_ReadErrorIsIncomplete` | `cur` returns one attachment, `true`, `errors.New("x")` | `Complete` false, one attachment |
| `TestBuildReport_StateFailureGivesZeroReport` | state opened from a valid file, then `persist` and `random` both fail | `Report{}` with `Epoch == ""` |
| `TestBuildReport_SequenceIncreases` | two calls | second `Sequence` is the first plus one, same `Epoch` |

- [ ] **Step 2: Run them and see them fail.** `cd agent && go test -race -run TestBuildReport_ ./internal/netattach/` → FAIL.
- [ ] **Step 3: Implement `BuildReport` and `buildReport`.**
- [ ] **Step 4: Run them and see them pass** (same command).
- [ ] **Step 5: Commit** `feat(agent): build the networkAttachmentsV1 report`.

### Task 6: Heartbeat wiring

**Files:**
- Create: `agent/internal/heartbeat/network_attachments.go`, `network_attachments_test.go`
- Modify: `agent/internal/heartbeat/heartbeat.go` — payload field after `NetworkContextReset` (`:101`);
  a `netAttach *netAttachReporter` field beside `networkContextMu` (`:510-512`); construction in
  `NewWithVersion` (`:1358`, the `&Heartbeat{` literal at `:1372`); call after `attachLogShipping(&payload)` (`:5855`)

**Interfaces:**
- Consumes: `netattach.OpenState`, `netattach.BuildReport`, `serverHost` (`heartbeat.go:5342`), `h.serverURL()` (`:5388`), `h.stopChan` (`:517`).
- Produces (D1): ``NetworkAttachmentsV1 *netattach.Report `json:"networkAttachmentsV1,omitempty"` `` on `HeartbeatPayload`; `func (h *Heartbeat) attachNetworkAttachments(payload *HeartbeatPayload)`.

```go
type netAttachReporter struct {
	mu       sync.Mutex
	open     func() (*netattach.State, error)
	build    func(context.Context, *netattach.State, string, time.Time) netattach.Report
	bound    time.Duration // 3 * time.Second
	maxAge   time.Duration // 5 * time.Minute
	state    *netattach.State
	inflight bool
	ready    *netattach.Report
	started  time.Time // when the read that produced ready began
}
func newNetAttachReporter(path string) *netAttachReporter
// attach returns the finished, unsent report (or nil) and starts a read when none is running.
func (r *netAttachReporter) attach(now time.Time, serverHost string, stop <-chan struct{}) *netattach.Report
```

`NewWithVersion` sets `netAttach: newNetAttachReporter(filepath.Join(config.GetDataDir(),
"network-attachment-state.json"))`; the state file is opened at the first beat, not in the constructor.
A nil `netAttach` (a `&Heartbeat{}` built directly by a test) makes `attachNetworkAttachments` a no-op,
so those tests never read the OS or write the data directory. Otherwise it sets
`payload.NetworkAttachmentsV1 = h.netAttach.attach(time.Now(), serverHost(h.serverURL()), h.stopChan)`.

`attach` rules (K10): it never blocks on a read. An open failure is retried next beat. The read
goroutine uses `context.WithTimeout(bound)` (also cancelled by `stop`), recovers a panic and logs it,
and stores its result only when it finished inside `bound` and `Epoch != ""`. `attach` hands out
`ready` once, and drops it when `now.Sub(started) > maxAge`.

- [ ] **Step 1: Write the failing tests** (on `newNetAttachReporter` with `open` and `build` replaced)

| Test | Setup | Asserts |
|---|---|---|
| `TestNetAttachReporter_SlowReadNeverBlocksBeat` | `build` blocks on a channel | `attach` returns `nil` in under 100 ms; after release and completion the next `attach` returns the report; the one after returns `nil` and starts a new read |
| `TestNetAttachReporter_OneReadAtATime` | `build` blocks; `attach` called 5 times | `build` entered once |
| `TestNetAttachReporter_ReadPastBoundIsDiscarded` | `bound` 50 ms; `build` ignores `ctx`, sleeps 100 ms, returns a report | next `attach` returns `nil` and a new read starts |
| `TestNetAttachReporter_OldReportIsDropped` | finished report, `attach` with `now` 6 minutes after `started` | `nil` |
| `TestNetAttachReporter_ZeroReportNotAttached` | `build` returns `netattach.Report{}` | `nil` on every beat |
| `TestNetAttachReporter_PanicInReadIsRecovered` | `build` panics once, then returns a report | no crash; a later `attach` returns the report |
| `TestNetAttachReporter_StateOpenFailure` | `open` fails twice, then succeeds | `nil`, `nil`, then a report on a later beat |
| `TestHeartbeatPayload_NetworkAttachmentsV1Key` | marshal a payload with and without the field | `"networkAttachmentsV1":{"epoch":` present / key absent |
| `TestAttachNetworkAttachments_NilReporterIsNoop` | `(&Heartbeat{}).attachNetworkAttachments(&p)` | no panic, field nil |

- [ ] **Step 2: Run them and see them fail.** `cd agent && go test -race -run 'TestNetAttachReporter_|TestHeartbeatPayload_NetworkAttachmentsV1Key|TestAttachNetworkAttachments_' ./internal/heartbeat/` → FAIL, undefined.
- [ ] **Step 3: Implement the reporter, the payload field, the fields and the one-line call.**
- [ ] **Step 4: Run them and see them pass** (same command), then the whole package: `cd agent && go test -race ./internal/heartbeat/` → PASS.
- [ ] **Step 5: Commit** `feat(agent): send network attachments in the heartbeat`.

### Task 7: Windows CI, the live test, and the native runs

**Files:**
- Create: `agent/internal/netattach/live_test.go`
- Modify: `.github/workflows/ci.yml:2755` (append `./internal/netattach`), with a comment paragraph above the step in the style of the others: what Windows-only code the package carries (the uplink reader, the state-file rename) and how it was verified (`GOOS=windows GOARCH=amd64 CGO_ENABLED=0` vets, the test binary compiles, no cgo and no `remote/desktop` in `go list -deps`).

- [ ] **Step 1: Write `TestCurrent_Live`** (untagged; runs in every CI job). It calls `Current(ctx,
"203.0.113.20")` (an IP literal, so no DNS query) with a 3-second context and asserts structural invariants only: returns inside the
bound; at most `MaxAttachments`; at most one `Primary`; every address is IPv4; `PrefixLength <= 32`;
`GatewayMAC` is nil or 6 bytes; `complete == false` whenever `err != nil`. With `NETATTACH_LIVE=1` it
also prints each attachment and the `complete` flag with `t.Logf`.

- [ ] **Step 2: Run it** on the dev machine: `cd agent && go test -race -run TestCurrent_Live -v ./internal/netattach/` → PASS.
- [ ] **Step 3: Check the Windows package graph:** `cd agent && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go test -c -o /dev/null ./internal/netattach && ! CGO_ENABLED=0 GOOS=windows go list -deps ./internal/netattach | grep -E 'remote/desktop|runtime/cgo'` → exit 0.

- [ ] **Step 4: Native run on each OS.** Build the test binary with `CGO_ENABLED=0` for the target and
run `NETATTACH_LIVE=1 ./netattach.test -test.run TestCurrent_Live -test.v`:
  - **the Windows lab VM**, once as an administrator and once as LocalSystem (a one-shot scheduled task
    with `/ru SYSTEM` writing to a file); compare with `route print -4` and `Get-NetNeighbor -AddressFamily IPv4`;
  - **the lab Mac**, with Ethernet and Wi-Fi both up if available (review focus 3); compare with
    `netstat -rn -f inet` and `arp -an`;
  - **a Linux lab VM**; compare with `ip -4 route show table all` and `ip -4 neigh`;
  - **the Task 2 Hyper-V host** (external switch reported, Default Switch not) and, if available, a
    Linux host whose address is on a bridge with a physical port.

  For each attachment record "matches the OS command: yes/no" for interface, local address and prefix,
  gateway, MAC and primary.

- [ ] **Step 5: Commit** `ci(agent): run netattach tests on Windows`.

---

## Done when

- [ ] `cd agent && go test -race ./internal/netattach/... ./internal/collectors/networkcontext/... ./internal/heartbeat/...` → `ok` for each package.
- [ ] `cd agent && CGO_ENABLED=0 go test ./internal/netattach/...` → `ok` (cgo-off on the dev OS).
- [ ] `cd apps/api && npx vitest run src/services/agentOrgRateLimit.test.ts` → PASS (it parses
  `heartbeat.go` for `sendInventoryData` call sites; this wave adds none, so it must stay green).
- [ ] The CI build path (`ci.yml:2304-2315`), cgo off, for each target, from the repo root:
  `for t in linux/amd64 linux/arm64 windows/amd64 darwin/arm64; do CGO_ENABLED=0 agent/scripts/build-edition.sh --edition self-host --component agent --goos ${t%/*} --goarch ${t#*/} --version dev --out /tmp/breeze-agent-${t%/*}-${t#*/} || exit 1; done` → exit 0.
- [ ] `cd agent && CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go vet ./...` → exit 0 (the `lint-agent` macOS step, `ci.yml:3600-3605`).
- [ ] `bash scripts/check-windows-vet.sh` from the repo root → exit 0. A changed unsafeptr count for a new file is adjudicated in a comment and locked with `--update`, as the script's message says.
- [ ] `grep -c 'internal/netattach' .github/workflows/ci.yml` → at least 1, on the `test-agent-windows` `go test` line.
- [ ] The Windows `test-agent-windows`, `test-agent` and `test-agent-race` jobs are green on the PR.
- [ ] The PR body states: `Closes #<W02a sub-issue>`; that the release is promoted only after W01b is deployed; the Task 2 adapter table and the chosen Windows fact; the redacted native output per OS with the yes/no match column; the run as LocalSystem; and every Contract note below.

## Contract notes

1. **The kind values cannot separate a bridged uplink from a NAT switch.** D1 says "reportable
   interface"; this plan adds an OS fact (K2). Linux reads bridge and lower members from sysfs through a
   new exported `networkcontext.LinuxBridgedUplink`. **Windows: the fact is not established.** Task 2
   decides it natively among three candidates (shared hardware MAC through `GetIfTable2Ex`, the
   `ConnectorPresent` flag, Hyper-V WMI). If none separates them, a Hyper-V host behind an external switch
   cannot report, and review focus 1 goes back to the owner.
2. **macOS bridges are never reported in v1.** No member list is read. A Mac whose address sits on a
   bridge with a physical member reports no attachment for it.
3. **`BuildReport` has no error return.** A state that cannot produce a sequence (only a failed random
   source) yields the zero `Report`, and the heartbeat omits the field. A state-file write failure does
   not stop reporting: `State` moves to a fresh in-memory epoch, which the server treats as a reset (§8.1).
4. **"Bounded to 3 seconds and never delays a heartbeat" is met by reading in the background** (K10):
   a beat carries a report captured up to one interval earlier, never one older than 5 minutes.
5. **The field is absent on some beats, as index C1 allows**: the first beat after start, a beat with no
   read finished since the last one, and after a read that overran or failed to produce a sequence. Per
   C1 an absent field means "no change" and is never read as "on no network" (that is an empty,
   complete list). W01b treats it as no change: nothing confirmed, nothing cleared (E3 reason `absent`).
6. **An empty `serverHost` marks nothing primary and adds no error** (K7, index D1).
   `TestCurrent_EmptyServerHost` pins it; W02c's `netguard` relies on it.
