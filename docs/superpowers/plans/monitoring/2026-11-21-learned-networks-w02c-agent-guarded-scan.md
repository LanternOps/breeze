# Learned Networks W02c: Agent guarded discovery scan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent runs `network_discovery_guarded` only after proving, on one interface, a gateway the
command names; every probe leaves through that interface, a change to it cancels the run, and the
gateway is proven again before credentials are used and before anything is posted.

**Architecture:** New package `netbind` holds the per-OS socket control (moved out of
`networkdiagnostic`). New package `netguard` selects an attachment (`netattach.Current`), proves its
gateway (`gatewayproof.Prove`), returns a `Binding`, and watches the interface through one process-wide
change watcher. `discovery` routes every socket, lookup and network command through one seam file, so a
bound scan cannot open anything outside the binding. A thin handler runs the spec order.

**Tech stack:** Go agent, `golang.org/x/net/icmp`, `github.com/gosnmp/gosnmp` v1.47.0; Vitest for one
API list.

**Spec:** `docs/superpowers/specs/monitoring/2026-11-20-learned-networks-discovery-gate-design.md`
(7.2, 11, 13 item 6, 14).

**Index:** `docs/superpowers/plans/monitoring/2026-11-21-learned-networks.md`. Its Global constraints,
Review focus and Cross-wave contract apply to every task. This wave owns C2, C3, C4, C6, D3 to D6 and
review-focus item 3.

## Wave constraints

- Starts after W02b's gate passed and W02a merged; `netattach` and `gatewayproof` are used only through
  D1 and D2. Agent-shipped code: TDD, `go test -race`, one independent review round.
- Normative order: **prove, bind, scan, prove, credentialed pass, prove, post, return.** The credentialed
  pass is every SNMP session using the profile's credentials: the system-group probe (`DiscoverSNMP`)
  and the physical collection (`CollectPhysicalFor`). Neither runs before the first `Reprove` (Contract
  note 3).
- `network_discovery` is unchanged on the wire: payload, result keys, adjacency body. The five scanner
  seam vars (`scanARP`, `pingSweep`, `scanPorts`, `discoverSNMP`, `readARPCache`, `scanner.go:69-75`)
  keep their signatures, so `scanner_test.go` and `credentials_test.go` compile untouched.
- Every guarded failure carries a code: `*netguard.MismatchError` → `network_mismatch`; every other
  `Begin` failure (attachment read, proof error, watcher unavailable), any watched change and any failed
  re-prove → `network_changed` with the cause in `error`; a malformed `expectedNetwork` →
  `invalid_argument`. A guarded failure never returns hosts.
- A refusal body travels in `CommandResult.Result`, not `Stdout`: `toWSCommandResult`
  (`heartbeat.go:7817`) copies an explicit `Result` and skips the stdout reparse when `Error` is set.
- Values pinned in Tasks 5 and 9: `ProveTimeout` 3 s, `MaxObserved` 8, `expectedGatewaysMax` 64 (index
  plan call 9), watcher restart backoff 1 s, at most 3 watcher starts per process on Windows.
- Fixtures: index values only. Interfaces `Ethernet` (index 4) and `Wi-Fi` (index 7); local addresses
  `192.168.1.57/24`, `192.168.1.58/24`, `10.1.2.57/24`. Each commit step stages exactly the task's Files.

## File structure

| Package or file | Responsibility |
|---|---|
| `agent/internal/netbind/` (moved from `networkdiagnostic/bind_*.go`) | `Control` per OS |
| `agent/internal/netguard/` `binding.go`, `hub.go`, `session.go`, `nameservers.go` | `Binding`; watcher and recheck; `Begin`, `Session`, errors; interface DNS servers |
| `agent/internal/snmppoll/client.go:48-109` | bindable client config |
| `agent/internal/discovery/` `netops.go`, `scanner_bound.go`; edits in the probe files | one seam for every open; bound scan and credentialed pass |
| `agent/internal/heartbeat/handlers_network_guarded.go`; `handlers_network.go:38-119` | handler, payload parse, refusals; adjacency post carries `verified` |
| `tools/types.go:184`, `handlers_test.go:67`, `wire/errorcodes.go`, `schemas.ts:677`, `ci.yml:2755` | command type, registry list, C6, Windows CI list |

## Every network open in the scan path

`openers` is the package var in `netops.go`; `b` is the scan's `*netguard.Binding`. With `b == nil` each
opener makes exactly today's call.

| # | Site today | Opens | With `b` set | Cancellation |
|---|---|---|---|---|
| 1, 2 | `arp.go:63` (cgo only; `arp_nocgo.go:13` opens nothing) | pcap on every up interface | only the interface with index `b.InterfaceIndex`, sender `b.SourceAddress`, subnets limited to its prefix as today | per subnet; read loop exits on `ctx.Done()` |
| 3 | `ping.go:41,57` `icmp.ListenPacket("ip4:icmp","0.0.0.0")` | raw ICMP | `b.ListenConfig().ListenPacket(ctx, "ip4:icmp", b.SourceAddress.String())`; `pingWithConn` takes `net.PacketConn` (x/net/icmp has no `ListenConfig` hook) | producer `select`; worker check per target; `context.AfterFunc` closes conns |
| 4 | `ports.go:80` `net.DialTimeout` | TCP | `b.Dialer(timeout).DialContext(ctx, "tcp", addr)` | producer `select`; dial ctx |
| 5 | `snmp.go:119` `snmppoll.NewClient`, **credentials** | UDP 161 | `LocalAddr = b.SourceAddress:0`, `Control = netbind.Control(b.InterfaceIndex, false)`, `Context = ctx`; runs only in `CredentialedPassContext` | producer `select`; gosnmp `Context` |
| 6 | `adjacency_collection.go:481`, **credentials** | UDP 161 | `openBoundPhysicalSession(ctx, ip, cred, timeout, b)`, config as row 5 | existing per-target ctx |
| 7 | `arpcache.go:27-31` `arp` command; `addLocalInterfaces` | process; whole table | no command: `networkcontext.NewReader("netguard").Neighbors` rows on `b.InterfaceIndex`; self entry for `b.SourceAddress` only | reader ctx |
| 8 | `scanner.go:386` `net.LookupAddr` | system resolver | `b.Resolver().LookupAddr(ctx, ip)` | ctx |
| 9, 10 | `fingerprintOS`, `ClassifyAsset`; NetBIOS | nothing (pure functions; no NetBIOS lookup exists, `NetbiosName` is never set) | nothing; the static guard fails if a lookup appears outside `netops.go` | — |
| 11 | `adjacency_transport.go:262` `http.DefaultClient` fallback | HTTPS to the Breeze API | **not bound, by design**: an upload through the heartbeat's client after the final re-prove, not a LAN probe | dispatch deadline |

## Tasks

### Task 1: `netbind`, moved and exported

**Files:** Create `agent/internal/netbind/bind_{darwin,linux,windows}.go` (bodies moved verbatim),
`agent/internal/netbind/bind_test.go`. Delete `agent/internal/networkdiagnostic/bind_*.go`. Modify
`agent/internal/networkdiagnostic/native.go:93`.

**Interfaces:** Produces `func Control(ifaceIndex uint32, ipv6 bool) func(network, address string, c syscall.RawConn) error` (D3).

- [ ] **Step 1: Write the failing tests** (`bind_test.go`):

```go
func TestControl_BindsLoopbackDial(t *testing.T) {
	ln := mustListen(t, "tcp4", "127.0.0.1:0")
	d := net.Dialer{Timeout: 2 * time.Second, LocalAddr: &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)}, Control: Control(loopbackIndex(t), false)}
	conn, err := d.Dial("tcp4", ln.Addr().String())
	if errors.Is(err, syscall.EPERM) { t.Skip("SO_BINDTODEVICE needs CAP_NET_RAW here") }
	if err != nil { t.Fatal(err) }
	conn.Close()
}
func TestControl_UnknownIndexFails(t *testing.T) {
	if runtime.GOOS == "windows" { t.Skip("IP_UNICAST_IF may accept any index (inferred; the VM run records it)") }
	d := net.Dialer{Timeout: time.Second, Control: Control(0x7fffff, false)}
	if _, err := d.Dial("tcp4", mustListen(t, "tcp4", "127.0.0.1:0").Addr().String()); err == nil { t.Fatal("bound to a missing interface") }
}
```

- [ ] **Step 2: Run** `cd agent && go test -race ./internal/netbind/...` — FAIL, `undefined: Control`.
- [ ] **Step 3: Move** the files, rename `bindInterface` → `Control`, package `netbind`; `native.go:93`
  becomes `&net.Dialer{Control: netbind.Control(index, source.Is6())}`.
- [ ] **Step 4: Run** `cd agent && go test -race ./internal/netbind/... ./internal/networkdiagnostic/... && bash ../scripts/check-windows-vet.sh && GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go vet ./internal/netbind/ ./internal/networkdiagnostic/` — PASS, vets clean.
- [ ] **Step 5: Commit** — `git commit -m "refactor(agent): move interface socket binding into netbind"`

### Task 2: Error codes `network_mismatch`, `network_changed` (C6)

**Files:** Modify `agent/internal/wire/errorcodes.go` (after `ErrCodeIsolationBusy` and in
`AllCommandErrorCodes`), `apps/api/src/routes/agents/schemas.ts:677-706`. Test
`apps/api/src/routes/agents/schemas.commandResult.test.ts`; Go pins `TestCommandErrorCodesMatchServerSchema`
and `TestAllCommandErrorCodesListsEveryConstant` already exist.

**Interfaces:** Produces `wire.ErrCodeNetworkMismatch = "network_mismatch"`, `wire.ErrCodeNetworkChanged = "network_changed"`.

- [ ] **Step 1: Write the failing test.** Add the Go constants and list entries only, and in the API test:

```ts
it('carries the guarded-network refusal codes', () => {
  for (const code of ['network_mismatch', 'network_changed']) {
    expect(commandResultSchema.parse(validResult({ status: 'failed', error: 'refused', errorCode: code })).errorCode).toBe(code);
    expect(isAgentCommandErrorCode(code)).toBe(true);
  }
});
```

- [ ] **Step 2: Run** `cd agent && go test ./internal/wire/...` (FAIL: "agent error codes drifted") and
  `cd apps/api && npx vitest run src/routes/agents/schemas.commandResult.test.ts` (FAIL).
- [ ] **Step 3: Add** both strings to `AGENT_COMMAND_ERROR_CODES` under a comment naming the network guard.
- [ ] **Step 4: Run** both commands — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(agent,api): network_mismatch and network_changed error codes"`

### Task 3: Bindable SNMP client

**Files:** Modify `agent/internal/snmppoll/client.go:48-56` (`SNMPClientConfig`), `:75-82` (the `gosnmp.GoSNMP`
literal). Test `agent/internal/snmppoll/client_bind_test.go`.

**Interfaces:** Produces three `SNMPClientConfig` fields, copied by `NewClient` to the same-named
`GoSNMP` fields: `LocalAddr string` (`"a.b.c.d:0"`), `Control func(network, address string, c syscall.RawConn) error`,
`Context context.Context`. `NewClient` never sets `UseUnconnectedUDPSocket` (gosnmp skips `Control` on
that path). Zero values keep today's behavior. W06a reuses these fields.

- [ ] **Step 1: Write the failing tests**

```go
func TestNewClient_AppliesLocalAddrAndControl(t *testing.T) {
	pc := mustListenUDP(t, "127.0.0.1:0") // records the first datagram's source
	var nets []string
	c, err := NewClient(SNMPClientConfig{Target: "127.0.0.1", Port: udpPort(pc), Version: Version2c, Auth: SNMPAuth{Community: "fixture"},
		Timeout: 300 * time.Millisecond, LocalAddr: "127.0.0.1:0", Context: context.Background(),
		Control: func(n, _ string, _ syscall.RawConn) error { nets = append(nets, n); return nil }})
	if err != nil { t.Fatal(err) }
	defer c.Close()
	_, _ = c.Get("1.3.6.1.2.1.1.5.0")
	if !reflect.DeepEqual(nets, []string{"udp4"}) || firstSource(t, pc).IP.String() != "127.0.0.1" { t.Fatal(nets) }
}
func TestNewClient_ZeroBindFieldsUnchanged(t *testing.T) { /* no bind fields: connects; c.client.LocalAddr == "" and Control == nil */ }
```

- [ ] **Step 2: Run** `cd agent && go test -race ./internal/snmppoll/ -run NewClient_` — FAIL (unknown fields).
- [ ] **Step 3: Add** the fields and copy them in `NewClient`.
- [ ] **Step 4: Run** `cd agent && go test -race ./internal/snmppoll/...` — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(agent/snmppoll): bindable SNMP client"`

### Task 4: `netguard.Binding`

**Files:** Create `agent/internal/netguard/binding.go`, `binding_test.go`.

**Interfaces:** Consumes `netbind.Control`. Produces D4's types plus the additions in Contract note 1:

```go
type ExpectedGateway struct { NetworkID, GatewayID string; Address netip.Addr; MAC net.HardwareAddr }
type Binding struct {
	NetworkID, GatewayID string
	GatewayAddress       netip.Addr
	GatewayMAC           net.HardwareAddr
	InterfaceName        string
	InterfaceIndex       uint32
	SourceAddress        netip.Addr
	Nameservers          []netip.AddrPort // this interface's DNS servers; never a loopback stub
}
func (b Binding) Dialer(timeout time.Duration) *net.Dialer    // LocalAddr *net.TCPAddr{source}, Control, Resolver: b.Resolver()
func (b Binding) UDPDialer(timeout time.Duration) *net.Dialer // LocalAddr *net.UDPAddr{source}, Control, Resolver: b.Resolver()
func (b Binding) ListenConfig() net.ListenConfig              // Control
func (b Binding) Resolver() *net.Resolver                     // PreferGo; Dial ignores the address Go chose
func (b Binding) Verified() map[string]any                    // C3 verifiedNetwork
var ErrNoNameserver = errors.New("netguard: no DNS server on the bound interface")
```

`Resolver().Dial(ctx, network, _)` dials `b.Nameservers[i % len]` (i from an atomic counter in the
closure) over `network` with a bound dialer that has **no** `Resolver` (no recursion). Empty
`Nameservers` returns `ErrNoNameserver`. `gatewayMac` is `net.HardwareAddr.String()`.

- [ ] **Step 1: Write the failing tests**

```go
var fixture = Binding{NetworkID: "n-1", GatewayID: "g-1", GatewayAddress: netip.MustParseAddr("192.168.1.1"),
	GatewayMAC: mustMAC("a4:2b:b0:11:22:9c"), InterfaceName: "Ethernet", InterfaceIndex: 4, SourceAddress: netip.MustParseAddr("192.168.1.57")}

func TestBinding_Verified(t *testing.T) {
	want := map[string]any{"networkId": "n-1", "gatewayId": "g-1", "gatewayAddress": "192.168.1.1", "gatewayMac": "a4:2b:b0:11:22:9c", "interfaceName": "Ethernet"}
	if got := fixture.Verified(); !reflect.DeepEqual(got, want) { t.Fatal(got) }
}
func TestBinding_DialersCarrySourceAndControl(t *testing.T) {
	d, u := fixture.Dialer(time.Second), fixture.UDPDialer(time.Second)
	if a, ok := d.LocalAddr.(*net.TCPAddr); !ok || a.IP.String() != "192.168.1.57" || d.Control == nil || d.Resolver == nil { t.Fatal(d) }
	if a, ok := u.LocalAddr.(*net.UDPAddr); !ok || a.IP.String() != "192.168.1.57" || u.Control == nil { t.Fatal(u) }
	if fixture.ListenConfig().Control == nil { t.Fatal("listen config unbound") }
}
func TestBinding_ResolverUsesOnlyBoundNameservers(t *testing.T) {
	srv := startDNSStub(t, "127.0.0.1:0", "DESKTOP-01.") // x/net/dns/dnsmessage responder that counts queries
	b := loopbackBinding(t); b.Nameservers = []netip.AddrPort{srv.AddrPort()}
	names, err := b.Resolver().LookupAddr(context.Background(), "192.168.1.20")
	if err != nil || !reflect.DeepEqual(names, []string{"DESKTOP-01."}) || srv.Queries() != 1 { t.Fatal(names, err) }
	b.Nameservers = nil // net.DNSError keeps only the text of a Dial error (net.newDNSError), so match the message
	if _, err := b.Resolver().LookupAddr(context.Background(), "192.168.1.20"); err == nil || !strings.Contains(err.Error(), ErrNoNameserver.Error()) { t.Fatal(err) }
}
```

- [ ] **Step 2: Run** `cd agent && go test -race ./internal/netguard/...` — FAIL (package missing).
- [ ] **Step 3: Implement** `binding.go`.
- [ ] **Step 4: Run** the same command — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(agent/netguard): Binding with bound dialers and resolver"`

### Task 5: `netguard` select, prove, watch, re-prove

**Files:** Create `agent/internal/netguard/hub.go`, `session.go`, `nameservers.go`, `session_test.go`, `hub_test.go`.

**Interfaces:** Consumes `netattach.Current` (D1); `gatewayproof.Prove`, `Interface`, `ErrNoAnswer` (D2);
`networkcontext.WatchChanges`, `networkcontext.NewReader`. Produces:

```go
type ObservedGateway struct { InterfaceName string; Address netip.Addr; MAC net.HardwareAddr } // MAC nil: unknown
type MismatchError struct{ Observed []ObservedGateway }                                        // at most MaxObserved
var ErrNetworkChanged = errors.New("netguard: network changed")
var ErrWatchUnavailable = errors.New("netguard: network change watcher unavailable")
const ProveTimeout = 3 * time.Second
const MaxObserved = 8
func Begin(ctx context.Context, expected []ExpectedGateway) (*Session, error)
func (s *Session) Context() context.Context          // context.Cause == ErrNetworkChanged after a watched change
func (s *Session) Binding() Binding
func (s *Session) Reprove(ctx context.Context) error // ErrNetworkChanged on any failure, and cancels the session
func (s *Session) Close()                            // unsubscribes; cause context.Canceled
```

Seams (package vars; every test runs on any OS, unprivileged):

```go
var (
	currentAttachments = func(ctx context.Context) ([]netattach.Attachment, bool, error) { return netattach.Current(ctx, "") }
	proveGateway       = gatewayproof.Prove
	watchChanges       = networkcontext.WatchChanges
	readNameservers    = liveNameservers // func(ctx context.Context, ifaceIndex uint32) []netip.AddrPort
	maxWatchStarts     = 0               // 3 when runtime.GOOS == "windows"; 0 means unlimited
	watchRestartDelay  = time.Second     // tests set it to 0
)
```

`liveNameservers`: through `networkcontext.NewReader("netguard")`, map the index to its `InterfaceKey`
(`Interfaces`), keep `Resolvers` rows that are IPv4, not `IsLocalStub`, on that key; if none, the same
filter on rows with a nil `InterfaceKey`.

**Begin** (the signature does not determine this):

```
1. hub.ensureStarted(); watcher not running → ErrWatchUnavailable
2. s := hub.subscribe()                            // every later notify marks s.dirty
3. atts, _, err := currentAttachments(ctx); no rows and err != nil → close s, return the wrapped error
   (rows plus err is usable: W02a K8 joins partial read errors, and an empty serverHost adds a resolve error)
4. candidates := atts whose GatewayAddress is an expected Address; primary first, then InterfaceName
5. for each c: mac, err := proveGateway(ctx+ProveTimeout, Interface{c.InterfaceName, c.InterfaceIndex, c.LocalAddress}, c.GatewayAddress)
     err == nil and an expected e has e.Address == c.GatewayAddress and bytes.Equal(e.MAC, mac) → bind c to e, stop
     otherwise remember mac (nil on error)
6. nothing bound: candidates non-empty and every proof failed with an error other than ErrNoAnswer → return that error;
   else &MismatchError{one entry per attachment, cut to MaxObserved; MAC = proven MAC if proven, else cached GatewayMAC}
7. s.snapshot = {index, source, prefix, gateway, proven MAC}; Binding.Nameservers = readNameservers(ctx, index)
8. s.dirty → recheck now; changed → close s, return ErrNetworkChanged
```

**The hub** (one per process; tests call `resetHubForTest(t)`). `WatchChanges` says *something* changed,
never which interface, so each notification diffs every session against one fresh read:

```
notify(): recheck running → dirty = true, return; else start the recheck loop
loop until !dirty: dirty = false; atts, _, err := currentAttachments(3 s timeout)
  a session survives only if the read returned rows and one has its InterfaceIndex, LocalAddress == source,
  PrefixLength == prefix, GatewayAddress == gateway, and GatewayMAC nil or equal to the proven MAC;
  otherwise cancel it with ErrNetworkChanged (a session with no snapshot yet is only marked dirty)
watcher: started lazily by the first Begin, runs watchChanges(context.Background(), notify), never stopped.
  When it returns: cancel every session with ErrNetworkChanged; restart after watchRestartDelay unless maxWatchStarts is reached,
  after which Begin returns ErrWatchUnavailable.
```

**Reprove:** session context done → `ErrNetworkChanged`; else prove the bound interface and gateway with
`ProveTimeout`; an error or a MAC other than `Binding().GatewayMAC` cancels with `ErrNetworkChanged`.

- [ ] **Step 1: Write the failing tests.** Fakes: `setAttachments` (settable list), `setProof(index, mac|err)`
  with `proveCalls(index)`, `fakeWatch` with `fireWatch(t)`, `waitRecheck(t)` (hub idle).

```go
var gwA = ExpectedGateway{NetworkID: "n-1", GatewayID: "g-1", Address: addr("192.168.1.1"), MAC: mac("a4:2b:b0:11:22:9c")}

func TestBegin_SelectsNonPrimaryMatch(t *testing.T) { // review focus 3
	setAttachments(t, att("Wi-Fi", 7, "10.1.2.57/24", "10.1.2.100", true), att("Ethernet", 4, "192.168.1.57/24", "192.168.1.1", false))
	setProof(t, 4, "a4:2b:b0:11:22:9c")
	s, err := Begin(ctx, []ExpectedGateway{gwA}); must(t, err); defer s.Close()
	if b := s.Binding(); b.InterfaceIndex != 4 || b.SourceAddress != addr("192.168.1.57") || b.GatewayID != "g-1" { t.Fatal(b) }
	if proveCalls(7) != 0 { t.Fatal("proved an interface whose gateway is not expected") }
}
func TestBegin_ProvesEachCandidateUntilMACMatches(t *testing.T) { // one gateway address on two LANs (spec section 1)
	setAttachments(t, att("Ethernet", 4, "192.168.1.57/24", "192.168.1.1", true), att("Wi-Fi", 7, "192.168.1.58/24", "192.168.1.1", false))
	setProof(t, 4, "3c:37:86:aa:bb:10"); setProof(t, 7, "a4:2b:b0:11:22:9c")
	s, err := Begin(ctx, []ExpectedGateway{gwA}); must(t, err); defer s.Close()
	if s.Binding().InterfaceIndex != 7 { t.Fatal(s.Binding()) }
}
func TestBegin_NoExpectedAddressIsMismatch(t *testing.T) {
	setAttachments(t, attMAC("Ethernet", 4, "10.1.2.57/24", "10.1.2.100", "00:1a:8c:00:00:01", true))
	_, err := Begin(ctx, []ExpectedGateway{gwA})
	var m *MismatchError
	if !errors.As(err, &m) || len(m.Observed) != 1 || m.Observed[0].MAC.String() != "00:1a:8c:00:00:01" || proveCalls(4) != 0 { t.Fatal(err) }
}
func TestBegin_ExpectedAddressWrongMACIsMismatch(t *testing.T) {
	setAttachments(t, att("Ethernet", 4, "192.168.1.57/24", "192.168.1.1", true)); setProof(t, 4, "3c:37:86:aa:bb:10")
	_, err := Begin(ctx, []ExpectedGateway{gwA}); var m *MismatchError
	if !errors.As(err, &m) || len(m.Observed) != 1 || m.Observed[0].MAC.String() != "3c:37:86:aa:bb:10" || proveCalls(4) != 1 { t.Fatal(err) }
}
func TestBegin_SilentGatewayIsMismatch(t *testing.T)          { /* proof gatewayproof.ErrNoAnswer → *MismatchError; Observed[0].MAC == nil */ }
func TestBegin_ProofErrorIsNotMismatch(t *testing.T)          { /* proof errors.New("raw socket denied") → not *MismatchError; errors.Is(err, it) */ }
func TestBegin_ObservedCappedAtEight(t *testing.T)            { /* 9 attachments from the fake → len(Observed) == 8 */ }
func TestBegin_ChangeWhileProvingFailsClosed(t *testing.T)    { /* fake proof moves the address and fires the watcher before returning → ErrNetworkChanged */ }

func TestSession_WatchedChangeCancels(t *testing.T) {
	for name, mutate := range map[string]attMutation{
		"link down": dropIndex(4), "address": setLocal(4, "192.168.1.60/24"), "prefix": setLocal(4, "192.168.1.57/25"),
		"default route": setGateway(4, "192.168.1.254"), "cached MAC differs": setCachedMAC(4, "3c:37:86:aa:bb:10"),
		"read error, no rows": failRead(errors.New("netlink dump failed")),
	} {
		t.Run(name, func(t *testing.T) {
			s := beginOnEthernet(t); defer s.Close()
			applyAttachments(t, mutate); fireWatch(t); waitRecheck(t)
			if !errors.Is(context.Cause(s.Context()), ErrNetworkChanged) { t.Fatal(context.Cause(s.Context())) }
		})
	}
}
func TestSession_PartialReadErrorWithRowsDoesNotCancel(t *testing.T) { /* rows unchanged plus a joined neighbour error → not cancelled */ }
func TestSession_OtherInterfaceChangeDoesNotCancel(t *testing.T) {
	s := beginOnEthernet(t); defer s.Close() // Wi-Fi (7) is attached too
	applyAttachments(t, dropIndex(7)); fireWatch(t); waitRecheck(t)
	if s.Context().Err() != nil { t.Fatal("cancelled by a change on another interface") }
}
func TestReprove_GatewaySwapFails(t *testing.T) {
	s := beginOnEthernet(t); defer s.Close()
	setProof(t, 4, "3c:37:86:aa:bb:10")
	if err := s.Reprove(ctx); !errors.Is(err, ErrNetworkChanged) || !errors.Is(context.Cause(s.Context()), ErrNetworkChanged) { t.Fatal(err) }
}
func TestReprove_SameGatewayPasses(t *testing.T)          { /* same MAC → nil; proveCalls(4) == 2 */ }
func TestHub_WatcherStartedOnce(t *testing.T)             { /* 20 concurrent Begin → fakeWatch started once */ }
func TestHub_WatcherExitCancelsSessions(t *testing.T)     { /* fakeWatch returns an error → live session cause ErrNetworkChanged */ }
func TestHub_StopsAfterMaxStarts(t *testing.T)            { /* maxWatchStarts = 3, watcher always fails → next Begin ErrWatchUnavailable */ }
func TestClose_CancelsWithoutNetworkChanged(t *testing.T) { /* Close → cause context.Canceled */ }
```

- [ ] **Step 2: Run** `cd agent && go test -race ./internal/netguard/...` — FAIL (undefined `Begin`).
- [ ] **Step 3: Implement** `hub.go`, `session.go`, `nameservers.go` per the algorithms above.
- [ ] **Step 4: Run** `cd agent && go test -race -count=3 ./internal/netguard/... && CGO_ENABLED=0 go test ./internal/netguard/...` — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(agent/netguard): select, prove, watch and re-prove the scan interface"`

### Task 6: `discovery`, one seam for every open, and a static guard

**Files:** Create `agent/internal/discovery/netops.go`, `seam_guard_test.go`, `netops_test.go`. Modify
`ping.go:41,57,91`, `ports.go:78-86`, `snmp.go:118-123`, `adjacency_collection.go:480-490`,
`arpcache.go:21-89`, `arp.go:17-106`, `arp_nocgo.go:13`, `scanner.go:385-391`.

**Interfaces:** Consumes `netguard.Binding`, the Task 3 config fields. Produces:

```go
type probeOpeners struct {
	dialTCP       func(ctx context.Context, b *netguard.Binding, address string, timeout time.Duration) (net.Conn, error)
	listenICMP    func(ctx context.Context, b *netguard.Binding) (net.PacketConn, error)
	newSNMPClient func(ctx context.Context, b *netguard.Binding, cfg snmppoll.SNMPClientConfig) (*snmppoll.SNMPClient, error)
	lookupAddr    func(ctx context.Context, b *netguard.Binding, ip string) ([]string, error)
	neighbors     func(ctx context.Context, b *netguard.Binding) map[string]string
	arpSweep      func(ctx context.Context, b *netguard.Binding, subnets []*net.IPNet, exclude map[string]struct{}, timeout time.Duration) (map[string]string, error)
}
var openers = systemOpeners()
func arpInterfaceAllowed(iface net.Interface, b *netguard.Binding) bool // no build tag; arp.go uses it
func boundNeighborsFrom(r networkcontext.Reader, b *netguard.Binding) map[string]string
```

The `arp` command and `addLocalInterfaces` move into `netops.go`; `parseARPLine` stays. `arpSweep` is
`scanARPWith` from `arp.go` (cgo) or the no-op in `arp_nocgo.go`. Exported probes (`ScanARP`,
`PingSweep`, `ScanPorts`, `DiscoverSNMP`, `ReadARPCache`) keep their signatures and pass `b == nil`.

- [ ] **Step 1: Write the failing tests**

```go
// seam_guard_test.go: go/parser over every non-test .go file in the directory, build tags ignored,
// so cgo-only arp.go is checked even though CI tests run with CGO_ENABLED=0.
func TestNoSocketOpensOutsideTheSeam(t *testing.T) {
	calls := []string{"net.Dial", "net.DialTimeout", "net.DialTCP", "net.DialUDP", "net.DialIP", "net.Listen", "net.ListenPacket",
		"net.ListenUDP", "net.ListenIP", "net.LookupAddr", "net.LookupHost", "net.LookupIP", "icmp.ListenPacket", "pcap.OpenLive",
		"procspawn.Command", "exec.Command", "exec.CommandContext", "snmppoll.NewClient", "http.DefaultClient", "http.Get", "http.Post"}
	literals := []string{"net.Dialer", "net.ListenConfig", "net.Resolver", "gosnmp.GoSNMP"}
	allowed := map[string][]string{"netops.go": append(calls, literals...), "arp.go": {"pcap.OpenLive"},
		"adjacency_transport.go": {"http.DefaultClient"}} // the upload to the API (enumeration row 11)
	for _, hit := range findSelectors(t, ".", calls, literals) {
		if !slices.Contains(allowed[hit.File], hit.Name) { t.Errorf("%s:%d uses %s outside netops.go", hit.File, hit.Line, hit.Name) }
	}
}
// CI never compiles arp.go (cgo), but macOS release builds do; this is the only test of its binding.
func TestArpSweepFiltersByBinding(t *testing.T) {
	f := parseFile(t, "arp.go")
	if got := callersOf(f, "pcap.OpenLive"); !reflect.DeepEqual(got, []string{"scanARPOnInterface"}) { t.Fatal(got) }
	if got := callersOf(f, "scanARPOnInterface"); !reflect.DeepEqual(got, []string{"scanARPWith"}) { t.Fatal(got) }
	if !calls(f, "scanARPWith", "arpInterfaceAllowed") || !usesParam(f, "scanARPOnInterface", "b") { t.Fatal("pcap sweep skips the interface filter or the bound source") }
}
func TestBoundOpeners_DialTCPUsesBinding(t *testing.T) { /* loopback binding; the 127.0.0.1 listener sees remote IP 127.0.0.1 */ }
func TestBoundOpeners_SNMPConfigIsBound(t *testing.T)  { /* loopback binding: datagram source 127.0.0.1; config Control non-nil, Context set */ }
func TestBoundOpeners_NeighborsOnlyBoundInterface(t *testing.T) {
	// fake reader: 192.168.1.20 on index 4 (00:1a:8c:00:00:01), 192.168.1.21 on index 7 (3c:37:86:aa:bb:10)
	got := boundNeighborsFrom(fakeReader, &fixtureBinding) // index 4, source 192.168.1.57
	if _, leaked := got["192.168.1.21"]; leaked || got["192.168.1.20"] != "00:1a:8c:00:00:01" { t.Fatal(got) }
}
func TestArpInterfaceAllowed(t *testing.T) { /* nil binding: every up, non-loopback interface with a MAC; bound: index 4 only */ }
```

- [ ] **Step 2: Run** `cd agent && go test -race ./internal/discovery/ -run 'Seam|BoundOpeners|ArpInterface'` — FAIL (the guard names `ping.go`, `ports.go`, `snmp.go`, `adjacency_collection.go`, `arpcache.go`, `scanner.go`; the rest are undefined).
- [ ] **Step 3: Implement** `netops.go` and route every site through `openers`.
- [ ] **Step 4: Run** `cd agent && go test -race ./internal/discovery/... && CGO_ENABLED=0 go test ./internal/discovery/...` — PASS, every existing scanner, credentials and adjacency test unchanged.
- [ ] **Step 5: Commit** — `git commit -m "refactor(agent/discovery): route every network open through one seam"`

### Task 7: Bound scan, credentialed pass, cancellation

**Files:** Create `agent/internal/discovery/scanner_bound.go`, `scanner_bound_test.go`. Modify
`scanner.go:15-31` (`ScanConfig.Bind`), `adjacency_collection.go:40-47,546-578,599-637`.

**Interfaces:** Consumes `openers`. Produces (D5, plus Contract note 3):

```go
// ScanConfig gains: Bind *netguard.Binding
var ErrScanNotBound = errors.New("discovery: ScanContext requires ScanConfig.Bind")
// No credentials: arp, ping, port_scan, neighbour fill, hostnames, fingerprint, classify.
func (s *Scanner) ScanContext(ctx context.Context) ([]DiscoveredHost, error)
// SNMP system-group probe over every target with the profile credentials, merged as Scan() merges it;
// fingerprint and classify again; hostnames for hosts that gained one.
func (s *Scanner) CredentialedPassContext(ctx context.Context, hosts []DiscoveredHost) ([]DiscoveredHost, error)
func PingSweepBound(ctx context.Context, b netguard.Binding, targets []net.IP, timeout time.Duration, workers int) []PingResult
// CollectPhysicalFor copies s.config.Bind into an unexported PhysicalRequest.bind; collectPhysicalForHost
// then opens through openBoundPhysicalSession(ctx, ip, cred, timeout, req.bind), else openPhysicalSession as today.
```

Both bound methods return `(nil, context.Cause(ctx))` when `ctx` is done at any stage boundary or at
return. Merge rules are `Scan()`'s (`scanner.go:129-200`).

- [ ] **Step 1: Write the failing tests.** `recordOpeners(t)` swaps `openers` for a recorder of
  `{kind, b}`: `dialTCP` returns a `net.Pipe()` end for `192.168.1.20:22` and an error otherwise;
  `lookupAddr` returns `["DESKTOP-01."]`; `neighbors` returns `{"192.168.1.20": "00:1a:8c:00:00:01"}`;
  the rest return errors or empty maps.

```go
func TestBoundScan_EveryOpenUsesTheBinding(t *testing.T) {
	rec, b := recordOpeners(t), fixtureBinding
	s := NewScanner(ScanConfig{Subnets: []string{"192.168.1.20/32"}, Methods: []string{"arp", "ping", "port_scan", "snmp"},
		PortRanges: []string{"22"}, SNMPCommunities: []string{"fixture"}, ResolveHostnames: true, IdentifyOS: true, Bind: &b})
	hosts, err := s.ScanContext(ctx); must(t, err)
	hosts, err = s.CredentialedPassContext(ctx, hosts); must(t, err)
	_ = s.CollectPhysicalFor(ctx, []DiscoveredHost{snmpHost("192.168.1.20")}, []string{SectionLLDP}, "default")
	for _, k := range []string{"arpSweep", "listenICMP", "dialTCP", "neighbors", "lookupAddr", "newSNMPClient"} {
		if rec.count(k) == 0 { t.Errorf("%s never reached the seam", k) }
	}
	for _, r := range rec.all() {
		if r.b == nil || r.b.InterfaceIndex != 4 || r.b.SourceAddress != b.SourceAddress { t.Errorf("%s opened without the scan's binding", r.kind) }
	}
	if len(hosts) != 1 || hosts[0].Hostname != "DESKTOP-01" || hosts[0].MAC != "00:1a:8c:00:00:01" { t.Fatal(hosts) }
}
func TestScanContext_OpensNoSNMPClient(t *testing.T) { /* methods include snmp; rec.count("newSNMPClient") == 0 after ScanContext */ }
func TestScanContext_CancelledReturnsNoHosts(t *testing.T) {
	// dialTCP blocks until ctx is done; the test cancels with cause netguard.ErrNetworkChanged after the first dial
	if hosts, err := s.ScanContext(ctx); hosts != nil || !errors.Is(err, netguard.ErrNetworkChanged) { t.Fatal(hosts, err) }
}
func TestCredentialedPass_CancelledReturnsNoHosts(t *testing.T) { /* same with newSNMPClient blocking */ }
func TestScanContext_RequiresBind(t *testing.T)                 { /* Bind nil → ErrScanNotBound; rec empty */ }
func TestScan_UnboundOpensWithNilBinding(t *testing.T)          { /* Scan() with the recorder: every record has b == nil */ }
```

- [ ] **Step 2: Run** `cd agent && go test -race ./internal/discovery/ -run 'BoundScan|ScanContext|CredentialedPass|UnboundOpens'` — FAIL (undefined).
- [ ] **Step 3: Implement** `scanner_bound.go` and the `PhysicalRequest.bind` path.
- [ ] **Step 4: Run** `cd agent && go test -race ./internal/discovery/... && CGO_ENABLED=0 go test ./internal/discovery/...`, and on macOS `CGO_ENABLED=1 go build ./internal/discovery/` (compiles `arp.go`) — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(agent/discovery): bound, cancellable scan and credentialed pass"`

### Task 8: Adjacency body carries `verifiedNetwork` (C4)

**Files:** Modify `agent/internal/discovery/adjacency_transport.go:220-223`, `:277-284`, `:481`;
`agent/internal/heartbeat/handlers_network.go:82,99`. Test `adjacency_transport_test.go`.

**Interfaces:** Produces `adjacencyPostBody.VerifiedNetwork map[string]any \`json:"verifiedNetwork,omitempty"\``
(last field), `AdjacencyTransport.VerifiedNetwork map[string]any`, and
`postAdjacencyV2(h, dispatch, jobID, commandID string, physical []discovery.TargetPhysical, verified map[string]any)`;
`handleNetworkDiscovery` passes `nil`.

- [ ] **Step 1: Write the failing test**

```go
func TestAdjacencyTransport_VerifiedNetworkOnlyWhenSet(t *testing.T) {
	if keys := topLevelKeys(t, postOneRaw(t, nil)); !reflect.DeepEqual(keys, []string{"parentJobId", "report"}) { t.Fatal(keys) }
	var body map[string]any
	must(t, json.Unmarshal(postOneRaw(t, fixtureVerified), &body))
	if !reflect.DeepEqual(body["verifiedNetwork"], fixtureVerified) { t.Fatal(body["verifiedNetwork"]) }
}
```

- [ ] **Step 2: Run** `cd agent && go test -race ./internal/discovery/ -run VerifiedNetworkOnlyWhenSet` — FAIL.
- [ ] **Step 3: Add** the fields; pass `t.VerifiedNetwork` into the body.
- [ ] **Step 4: Run** `cd agent && go test -race ./internal/discovery/... ./internal/heartbeat/ -run 'Adjacency|NetworkDiscovery'` — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(agent): adjacency report may carry verifiedNetwork"`

### Task 9: `network_discovery_guarded` handler

**Files:** Create `agent/internal/heartbeat/handlers_network_guarded.go`, `handlers_network_guarded_test.go`.
Modify `agent/internal/remote/tools/types.go:184` (`CmdNetworkDiscoveryGuarded = "network_discovery_guarded"`),
`agent/internal/heartbeat/handlers_test.go:67`, `handlers_network.go:40-52` (extract
`discoveryScanConfig(payload map[string]any) discovery.ScanConfig` for both handlers).

**Interfaces:** Consumes Tasks 2, 5, 7, 8. Produces (W06a reuses `parseExpectedNetwork` and `guardRefusal`):

```go
func handleNetworkDiscoveryGuarded(h *Heartbeat, cmd Command) tools.CommandResult
// payload["expectedNetwork"] = {"gateways":[{"networkId","gatewayId","address","mac"}]}. Missing, not an object, empty,
// more than 64, an empty id, a non-IPv4 address or an unparsable MAC → an error the handler returns as invalid_argument.
func parseExpectedNetwork(payload map[string]any) ([]netguard.ExpectedGateway, error)
// *MismatchError → network_mismatch, Result {"observedGateways":[{"interfaceName","address","mac"|null}]};
// anything else → network_changed. Status "failed", ExitCode 1, Error = cause, Stdout "".
func guardRefusal(err error, durationMs int64) tools.CommandResult
type guardSession interface { Context() context.Context; Binding() netguard.Binding; Reprove(context.Context) error; Close() }
var (
	beginGuard          = func(ctx context.Context, e []netguard.ExpectedGateway) (guardSession, error) // netguard.Begin; never a typed nil
	runGuardedScan      = func(ctx context.Context, s *discovery.Scanner) ([]discovery.DiscoveredHost, error)          // s.ScanContext
	runCredentialedPass = func(ctx context.Context, s *discovery.Scanner, h []discovery.DiscoveredHost) ([]discovery.DiscoveredHost, error)
)
```

Order (D6 with Contract note 3): parse → `beginGuard` → `runGuardedScan(sess.Context())` → `Reprove` →
`runCredentialedPass` → `collectDiscoveryPhysical(scanner, sess.Context(), …)` → `Reprove` →
`postAdjacencyV2(…, binding.Verified())` → the `network_discovery` result map plus
`"verifiedNetwork": binding.Verified()`. A done session context after any stage → `network_changed`.

- [ ] **Step 1: Write the failing tests.** `fakeSession` and the three fakes append to `trace`;
  `collectDiscoveryPhysical` is stubbed as in `handlers_network_adjacency_test.go:36`; an `httptest`
  server counts posts.

```go
func TestGuardedDiscovery_OrderIsProveScanProveCredentialsProvePost(t *testing.T) {
	res := runGuarded(t, okSession(), withTopology)
	want := []string{"begin", "scan", "reprove", "credentialed", "physical", "reprove", "post", "close"}
	if res.Status != "completed" || !reflect.DeepEqual(trace, want) { t.Fatal(res.Status, trace) }
	if got := stdoutMap(t, res)["verifiedNetwork"]; !reflect.DeepEqual(got, fixtureVerified) { t.Fatal(got) }
	if b := lastPostBody(t); !reflect.DeepEqual(b["verifiedNetwork"], fixtureVerified) { t.Fatal(b) }
}
func TestGuardedDiscovery_RejectsMalformedExpectedNetwork(t *testing.T) {
	for name, en := range map[string]any{"absent": nil, "not an object": "x", "empty": gateways(), "65 gateways": gateways(repeat(gwJSON, 65)...),
		"IPv6 address": gateways(with(gwJSON, "address", "fe80::1")), "bad MAC": gateways(with(gwJSON, "mac", "zz")), "empty id": gateways(with(gwJSON, "networkId", ""))} {
		res := runGuardedPayload(t, okSession(), en) // en == nil leaves the key out
		if res.Status != "failed" || res.ErrorCode != wire.ErrCodeInvalidArgument || len(trace) != 0 { t.Errorf("%s: %+v %v", name, res, trace) }
	}
}
func TestGuardedDiscovery_MismatchSendsNothing(t *testing.T) {
	obs := []netguard.ObservedGateway{{InterfaceName: "Ethernet", Address: addr("10.1.2.100")}}
	res := runGuarded(t, beginErr(&netguard.MismatchError{Observed: obs}), withTopology)
	if res.ErrorCode != wire.ErrCodeNetworkMismatch || res.Stdout != "" || !reflect.DeepEqual(trace, []string{"begin"}) || posts() != 0 { t.Fatal(res) }
	want := map[string]any{"observedGateways": []any{map[string]any{"interfaceName": "Ethernet", "address": "10.1.2.100", "mac": nil}}}
	if got := roundTrip(t, res.Result); !reflect.DeepEqual(got, want) { t.Fatal(got) }
}
func TestGuardedDiscovery_ChangeDuringHostScan(t *testing.T) {
	runGuardedScan = func(ctx context.Context, _ *discovery.Scanner) ([]discovery.DiscoveredHost, error) {
		trace = append(trace, "scan"); fakeSess.cancel(netguard.ErrNetworkChanged); return nil, context.Cause(ctx) }
	res := runGuarded(t, fakeSess, withTopology)
	if res.ErrorCode != wire.ErrCodeNetworkChanged || res.Stdout != "" || posts() != 0 || !reflect.DeepEqual(trace, []string{"begin", "scan", "close"}) { t.Fatal(res, trace) }
}
func TestGuardedDiscovery_ReproveFailsBeforeCredentialedPass(t *testing.T) {
	res := runGuarded(t, sessionReproveFailsOn(1), withTopology) // the 1st Reprove returns ErrNetworkChanged
	if res.ErrorCode != wire.ErrCodeNetworkChanged || posts() != 0 || !reflect.DeepEqual(trace, []string{"begin", "scan", "reprove", "close"}) { t.Fatal(res, trace) }
}
func TestGuardedDiscovery_ReproveFailsBeforePost(t *testing.T) {
	res := runGuarded(t, sessionReproveFailsOn(2), withTopology)
	want := []string{"begin", "scan", "reprove", "credentialed", "physical", "reprove", "close"}
	if res.ErrorCode != wire.ErrCodeNetworkChanged || res.Stdout != "" || posts() != 0 || !reflect.DeepEqual(trace, want) { t.Fatal(res, trace) }
}
func TestGuardedDiscovery_OtherBeginErrorIsNetworkChanged(t *testing.T) { /* beginErr(netguard.ErrWatchUnavailable) → network_changed; Error names the watcher */ }
func TestGuardRefusal_BodySurvivesBothTransports(t *testing.T) {
	res := guardRefusal(&netguard.MismatchError{}, 1)
	if ws := toWSCommandResult("c-1", res); ws.ErrorCode != wire.ErrCodeNetworkMismatch || ws.Result == nil { t.Fatal(ws) }
	if raw, _ := json.Marshal(res); !bytes.Contains(raw, []byte(`"result":{"observedGateways":[]}`)) { t.Fatal(string(raw)) }
}
func TestNetworkDiscoveryResultKeysUnchanged(t *testing.T) { /* unguarded, stubbed physical: keys == {adjacency hosts hostsDiscovered hostsScanned jobId} */ }
```

- [ ] **Step 2: Run** `cd agent && go test -race ./internal/heartbeat/ -run 'GuardedDiscovery|GuardRefusal|ResultKeysUnchanged|HandlerRegistry'` — FAIL (undefined; `TestHandlerRegistryCompleteness` fails once the constant exists).
- [ ] **Step 3: Implement**; register in `handlers_network.go`'s `init()` beside `CmdNetworkDiscovery`; add the constant to `allCommandTypes`.
- [ ] **Step 4: Run** `cd agent && go test -race ./internal/heartbeat/... ./internal/discovery/... ./internal/netguard/...` — PASS.
  `network_discovery` is shown unchanged by the untouched `TestNetworkDiscoveryResultIncludesAdjacencyKey`,
  `TestNetworkDiscoveryLegacyOnlyWithoutTopologyBlock` and `TestNetworkDiscoveryPostsV2WhenAdvertisedAndBoundsResult`,
  plus `TestNetworkDiscoveryResultKeysUnchanged` and `TestAdjacencyTransport_VerifiedNetworkOnlyWhenSet`.
- [ ] **Step 5: Commit** — `git commit -m "feat(agent): network_discovery_guarded handler"`

### Task 10: Windows CI list and native runs

**Files:** Modify `.github/workflows/ci.yml:2755` (append `./internal/netbind ./internal/netguard`, with a
comment line above naming this wave). Create `agent/internal/discovery/guarded_live_test.go`.

- [ ] **Step 1: Write the live test.** `TestLive_GuardedScan` skips unless `BREEZE_GUARD_LIVE=1`; reads
  `BREEZE_GUARD_GATEWAY`, `_GATEWAY_MAC`, `_SUBNET` and optional `_EXPECT=mismatch|change`. It runs
  `Begin`, `ScanContext` (ping, port_scan `22,80,443`, hostnames), `Reprove`, logging only counts, the
  interface name and the outcome. `mismatch` expects `*MismatchError`; `change` scans ports `1-1024`,
  logs "toggle the bound link now" and expects `ErrNetworkChanged` within 120 s.
- [ ] **Step 2: Run it on Windows, macOS and Linux** as Administrator or root against a real router, built
  as release builds are (Linux and Windows `CGO_ENABLED=0`; macOS once with `0`, once with `1`):

```bash
cd agent && BREEZE_GUARD_LIVE=1 BREEZE_GUARD_GATEWAY=<gw> BREEZE_GUARD_GATEWAY_MAC=<mac> BREEZE_GUARD_SUBNET=<lan>/24 \
  go test -count=1 -v -run TestLive_GuardedScan ./internal/discovery/
# again with BREEZE_GUARD_EXPECT=mismatch and a wrong MAC, then BREEZE_GUARD_EXPECT=change
```

  On the Windows lab VM also run `go test ./internal/netbind ./internal/netguard ./internal/discovery`.
- [ ] **Step 3: Capture during the first run, on both interfaces** (`tcpdump -ni`, `pktmon` on Windows),
  counting packets from this host by kind: ICMP echo, TCP SYN into the subnet, UDP 161, UDP 53, ARP
  requests. Pass needs both: on the bound interface every kind the run used is **nonzero** and carries the
  bound source address, and the run logged at least one ping reply (the gateway answers ICMP); on the
  other interface, 0 of each. A run that sends nothing passes neither half. Record the Windows result of
  `TestControl_UnknownIndexFails`' skipped case by hand (bind to a missing index, note the outcome).
- [ ] **Step 4: Run** the "Done when" commands — all pass.
- [ ] **Step 5: Commit** — `git commit -m "test(agent): live guarded scan; netbind and netguard on Windows CI"`

## Done when

- [ ] `cd agent && go test -race ./internal/netbind/... ./internal/netguard/... ./internal/discovery/... ./internal/heartbeat/... ./internal/wire/... ./internal/snmppoll/... ./internal/networkdiagnostic/...` passes.
- [ ] `cd agent && CGO_ENABLED=0 go test ./internal/netbind/... ./internal/netguard/... ./internal/discovery/...` passes; on macOS `cd agent && CGO_ENABLED=1 go build ./...` succeeds.
- [ ] `cd agent && CGO_ENABLED=0 go vet ./...`, `bash scripts/check-windows-vet.sh` (repo root) and `cd agent && GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go vet ./...` are clean; `cd agent && golangci-lint run --new-from-rev=origin/main ./...` reports nothing new.
- [ ] `cd agent && go list -deps ./internal/netguard ./internal/gatewayproof ./internal/netattach | grep internal/discovery` prints nothing.
- [ ] `cd apps/api && npx vitest run src/routes/agents/schemas.commandResult.test.ts` passes.
- [ ] The `test-agent-windows` job log shows `./internal/netbind` and `./internal/netguard` ran.
- [ ] The PR body states: `Closes #<sub-issue>`; that `network_discovery` is unchanged, naming the tests in
  Task 9 Step 4; the two codes added on both sides; per OS: version, cgo setting, each live run's outcome
  and the packet counts per kind on the other interface. **Redact first:** no real addresses, MACs, host
  names or lab machine names; use the index fixtures.
- [ ] Each Contract note is folded into the index in this PR or answered by the W02a and W02b owners.

## Contract notes

1. **`Binding.Dialer` cannot dial UDP.** Go rejects a `*net.TCPAddr` local address on a UDP dial
   ("mismatched local address type", `net/dial.go:352`). D4 gains `UDPDialer`, `Resolver`, the field
   `Nameservers` and `ErrNoNameserver`. Both dialers set `Resolver`, so no host name goes to the system
   resolver. A loopback stub (`127.0.0.53`) is unreachable through an interface binding, so
   `Nameservers` holds the interface's own DNS servers, never a stub.
2. **`netattach.Current(ctx, serverHost)` needs a server host `Begin` lacks.** `netguard` passes `""`
   and uses `Primary` only to order candidates. The W02a plan (K7, K8) does not say how it treats `""`;
   it may join a resolve error to the rows, and it joins partial read errors in any case. So `netguard`
   treats "rows plus error" as usable and only "no rows plus error" as a failure. Cleaner: W02a states that
   `""` marks nothing primary and adds no error.
3. **The credentialed pass includes the SNMP system-group probe.** Spec 7.2 step 5 puts "the SNMP sessions
   that use the profile's credentials" after the first re-prove. D6 names only `CollectPhysicalFor`, but
   `Scan()`'s `snmp` method (`DiscoverSNMP`) uses those credentials too. `ScanContext` runs no SNMP; D5
   gains `Scanner.CredentialedPassContext`, called in D6 between the first `Reprove` and
   `CollectPhysicalFor`.
4. **C3 has two codes; `Begin` has more failure kinds.** A failure that is not a mismatch (attachment
   read error, a proof error other than no answer, watcher unavailable) is sent as `network_changed` with
   the cause in `error`. W03a's job sentence for `network_changed` should not assume a mid-scan move.
5. **`gatewayproof` and `netattach` must not import `discovery`** (`discovery` imports `netguard`, which
   imports both). The `go list` check in "Done when" enforces it.
6. **Refusal bodies ride in `result`, not `stdout`.** This matches W06b (`result.result.observedGateways`);
   W03a stores only the code.
7. **Index line corrected:** the unknown-command branch is `heartbeat.go:8262`; the code map says `:8258`.
8. **The watch cannot see a change that is undone before the re-read.** `WatchChanges` names no interface,
   so the hub diffs a fresh read against the snapshot; a link or address flap that returns to the same
   state between the event and the read (milliseconds) is missed. A physical move takes longer than that,
   and the re-proves before credentials and before posting bound what a missed flap can admit. Spec 7.2
   step 4 says "any change"; this is the closest the OS interfaces allow without per-event parsing.
