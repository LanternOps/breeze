# Learned Networks W06a: Agent guarded SNMP poll and network checks

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Five guarded commands (`snmp_poll_guarded`, `network_ping_guarded`, `network_tcp_check_guarded`,
`network_http_check_guarded`, `network_dns_check_guarded`) run their existing probe only through an
interface whose gateway was proven to be one the command names, and return the base result plus
`verifiedNetwork`, or a coded refusal that never reads as "offline".

**Architecture:** `netguard.Acquire` runs spec 7.2 steps 1 to 3 (select, prove, bind) and may reuse a
gateway proof for up to 60 seconds per interface until the hub sees a change on that interface. Each
existing probe body moves behind a small `monitorNet` interface: the unguarded handlers keep a
`systemNet` that makes today's exact calls; the guarded handlers get a `boundNet` built from the
`Binding`. A thin wrapper validates, acquires, probes, confirms the interface did not change, and
stamps `verifiedNetwork`.

**Tech stack:** Go agent (`net`, `net/http`, gosnmp v1.47.0 through `snmppoll`).

**Spec:** `docs/superpowers/specs/monitoring/2026-11-20-learned-networks-discovery-gate-design.md`
(12; 7.2 steps 1 to 3; 13 items 13 and 14).

**Index:** `docs/superpowers/plans/monitoring/2026-11-21-learned-networks.md`. Its Global constraints,
Review focus and Cross-wave contract apply to every task. This wave owns C5, the agent half of H, and
plan call 11.

## Wave constraints

- Starts after W02c merged. Consumes W02c's names verbatim: `netguard.Binding` (with `Dialer`,
  `UDPDialer`, `Resolver`, `ListenConfig`, `Verified`, `Nameservers`), `netguard.ExpectedGateway`,
  `MismatchError`, `ErrNetworkChanged`, `ErrWatchUnavailable`, `ProveTimeout`, the hub and its seams
  (`currentAttachments`, `proveGateway`, `readNameservers`), `discovery.PingSweepBound`, the
  `snmppoll.SNMPClientConfig` fields `LocalAddr`, `Control`, `Context`, and the heartbeat helpers
  `parseExpectedNetwork` and `guardRefusal`.
- Order for every guarded probe: validate the payload (base fields and `expectedNetwork`) →
  `since := time.Now()` → `Acquire` → the base probe through `boundNet` → `Confirm(ctx, b, since)` →
  the base result, completed or failed, plus `"verifiedNetwork": b.Verified()`. Nothing leaves the host
  before `Acquire` returns.
- **Index C5: every result produced after the binding was acquired and confirmed carries
  `verifiedNetwork`, a failed probe included** (an `offline` ping, an SNMP poll that fails as a whole).
  Only a refusal, where the binding could not be acquired or confirmed, carries none. The API reads any
  guarded result without a valid `verifiedNetwork` as not checked.
- Refusals use W02c's `guardRefusal`: `*MismatchError` → `network_mismatch` with `observedGateways` in
  `Result`; any other `Acquire` or `Confirm` failure → `network_changed`. Status is `failed` and
  `Stdout` is empty, so no refusal carries `"status": "offline"`. A missing base field or a malformed
  `expectedNetwork` → `invalid_argument`, before anything is acquired (no `verifiedNetwork`).
- **Where each body travels** (index C7; the same rule as W02c's Wave constraints). A completed result's
  body, `verifiedNetwork` included, is its JSON `Stdout`: the WebSocket leg reparses it into `result`
  (`toWSCommandResult`, `heartbeat.go:7817`); the REST leg (`submitCommandResult`, `heartbeat.go:7780`)
  carries it as `stdout` only. A result with `Error` set (a refusal, or a failed probe after `Confirm`)
  carries its body in an explicit `CommandResult.Result` with `Stdout` empty, because the WebSocket
  reparse is skipped when `Error` is set; it is the `result` key on both transports, and both result
  routes store `stdout ?? JSON.stringify(result)` (`routes/agents/commands.ts:143-146`,
  `routes/agentWs.ts:845-848`).
- A probe that ran through a confirmed binding reports its real outcome, including `offline`, with
  `verifiedNetwork`. A probe that needs a name lookup when `b.Nameservers` is empty cannot run, so it is
  refused before it starts with `network_changed` and the cause `netguard.ErrNoNameserver` (no
  `verifiedNetwork`, so not checked), rather than reading as "failed to resolve, offline".
- Proof reuse (index plan call 11): `netguard.ProofReuseWindow = 60 * time.Second`; reuse only when the
  proof's age is strictly less. `Begin` (discovery) never reads or writes the proof cache.
- Agent-shipped code: TDD, `go test -race`, one review round. Fixtures as in W02c; probe target
  `192.168.1.20`, host name `DESKTOP-01`. Each commit step stages exactly the task's Files.

## File structure

| File | Responsibility |
|---|---|
| `agent/internal/netguard/acquire.go`, `acquire_test.go` | `Acquire`, proof cache, `Confirm`; hub recheck extended |
| `agent/internal/snmppoll/metrics.go:355-366` (`SNMPDevice.ClientConfig`) and the `SNMPDevice` type | bind fields carried to the client |
| `agent/internal/heartbeat/monitor_net.go`, `monitor_net_test.go` | `monitorNet`, `systemNet`, `boundNet`; static guard |
| `agent/internal/heartbeat/handlers_monitor.go:41-479`, `handlers_network.go:353-370` | bodies take a `monitorNet`; handlers unchanged outside that |
| `agent/internal/heartbeat/handlers_probe_guarded.go`, `_test.go` | the five guarded handlers |
| `agent/internal/remote/tools/types.go:187,195-198`, `heartbeat/handlers_test.go:67-70` | command types, `allCommandTypes` |
| `apps/api/src/services/partnerTrust.ts:65` (`GATED_COMMAND_TYPES`) | classify the five types; `partnerTrust.test.ts` parses the Go handler registry |

## How each probe opens its socket

| Probe | Today | Guarded (`boundNet`) |
|---|---|---|
| Ping, name target | `net.LookupIP(target)` (`handlers_monitor.go:59`) | `b.Resolver().LookupIP(ctx, "ip4", target)`, first address |
| Ping, ICMP | `discovery.PingSweep` → `icmp.ListenPacket("ip4:icmp","0.0.0.0")` (`:76`) | `discovery.PingSweepBound(ctx, b, …)`: `b.ListenConfig()` raw ICMP on `b.SourceAddress` |
| Ping, TCP fallback | `net.DialTimeout("tcp", host:443/80)` (`:98`) | `b.Dialer(timeout).DialContext(ctx, "tcp", …)` |
| TCP check | `net.DialTimeout("tcp", addr)` (`:136`) | `b.Dialer(timeout).DialContext`; a name resolves through `Dialer.Resolver` |
| HTTP check | `&http.Transport{TLSClientConfig}` (`:230`), default dialer, no proxy | same literal plus `DialContext: b.Dialer(timeout).DialContext`; `Proxy` stays nil; every redirect hop uses it |
| DNS check, `nameserver` set | `net.Resolver{PreferGo, Dial: net.Dialer{}.DialContext(ctx, "udp", ns)}` (`:382-394`) | same resolver, `Dial` through `b.UDPDialer(timeout).DialContext(ctx, "udp", ns)` |
| DNS check, no `nameserver` | `net.Resolver{PreferGo: true}`: system config | `b.Resolver()`: the interface's own servers; none → refused before the probe (`needsLookup`) |
| SNMP poll | `snmppoll.CollectMetrics(device)` → `NewClient` (`handlers_network.go:362`) | device gains `LocalAddr = b.SourceAddress:0`, `Control = netbind.Control(b.InterfaceIndex, false)`, `Context = ctx`; a non-literal target resolves through `b.Resolver()` to an IPv4 first |

## What the unguarded handlers keep doing

`network_ping`, `network_tcp_check`, `network_http_check`, `network_dns_check` and `snmp_poll` keep
their payloads, results and calls: `handleX(_ *Heartbeat, cmd)` becomes
`runX(context.Background(), cmd, unguardedNet)` with `unguardedNet monitorNet = systemNet{}`, and each
`systemNet` method is the line it replaces (`net.LookupIP(host)` ignoring `ctx`, `discovery.PingSweep`,
`net.DialTimeout`, the bare `http.Transport` literal, today's resolver, `snmppoll.CollectMetrics`). The
existing tests `TestHandleNetworkHttpCheck_TLSObservation`, `TestHandleNetworkHttpCheck_RedirectLoopIsCapped`,
`TestHandleNetworkHttpCheck_ErrorOmitsRequestURL`, `TestClampPingCount`,
`TestHandleSnmpPollRejectsOutOfRangePort` and the `TestParseSnmpPollRequest_*` set pass untouched.

## Tasks

### Task 1: `netguard.Acquire`, proof reuse and `Confirm`

**Files:** Create `agent/internal/netguard/acquire.go`, `acquire_test.go`. Modify `hub.go` (recheck also
covers cache entries; watcher exit clears the cache).

**Interfaces:** Consumes W02c's hub, seams and Begin step 6 rules. Produces:

```go
const ProofReuseWindow = 60 * time.Second
var now = time.Now // seam
// Steps 1 to 3 of spec 7.2 for short probes. A proof may be reused per the rules below.
func Acquire(ctx context.Context, expected []ExpectedGateway) (Binding, error)
// ErrNetworkChanged when the hub saw a change on b's interface at or after since,
// or a fresh read no longer shows b's interface, source address and gateway.
func Confirm(ctx context.Context, b Binding, since time.Time) error
```

**Algorithm** (not determined by the signatures):

```
Acquire:
1. hub.ensureStarted(); watcher not running → ErrWatchUnavailable
2. atts := currentAttachments(ctx); candidates ordered as in Begin
3. for each candidate c, holding a per-interface mutex for c.InterfaceIndex (concurrent calls share one proof):
     e := cache[c.InterfaceIndex]
     reuse if e exists, e.snapshot == {index, source, prefix, gateway} of c, now()-e.provedAt < ProofReuseWindow,
       and an expected entry has (c.GatewayAddress, e.mac)
     else prove with ProveTimeout; a match stores cache[c.InterfaceIndex] = {snapshot, mac, provedAt: now()};
       a mismatch or error deletes the entry
4. nothing bound → Begin's step 6 rules (MismatchError or the proof error)
5. Binding with readNameservers(ctx, index)
Hub recheck (added): every cache entry is tested with the session rule; a failing entry is deleted and
lastChange[index] = now(); a cancelled session also sets lastChange[index]. Watcher exit: clear the cache,
set lastChange for every cached index.
```

- [ ] **Step 1: Write the failing tests** (W02c fakes plus `setNow(t, t0)`):

```go
func TestAcquire_ReusesProofInsideWindow(t *testing.T) {
	ethernetOnly(t); setProof(t, 4, "a4:2b:b0:11:22:9c"); setNow(t, t0)
	b1, err := Acquire(ctx, []ExpectedGateway{gwA}); must(t, err)
	setNow(t, t0.Add(59*time.Second))
	b2, err := Acquire(ctx, []ExpectedGateway{gwA}); must(t, err)
	if proveCalls(4) != 1 || b1.GatewayID != b2.GatewayID || b2.InterfaceIndex != 4 { t.Fatal(proveCalls(4), b2) }
}
func TestAcquire_ProofExpiresAtWindow(t *testing.T) {
	ethernetOnly(t); setProof(t, 4, "a4:2b:b0:11:22:9c"); setNow(t, t0)
	_, err := Acquire(ctx, []ExpectedGateway{gwA}); must(t, err)
	setNow(t, t0.Add(ProofReuseWindow)) // exactly 60 s: not "strictly less", so it proves again
	_, err = Acquire(ctx, []ExpectedGateway{gwA}); must(t, err)
	if proveCalls(4) != 2 { t.Fatal(proveCalls(4)) }
}
func TestAcquire_ChangeOnInterfaceDropsProof(t *testing.T) {
	ethernetOnly(t); setProof(t, 4, "a4:2b:b0:11:22:9c"); _, _ = Acquire(ctx, []ExpectedGateway{gwA})
	applyAttachments(t, setLocal(4, "192.168.1.60/24")); fireWatch(t); waitRecheck(t)
	applyAttachments(t, setLocal(4, "192.168.1.57/24")) // back to the original state: the proof must still be gone
	_, _ = Acquire(ctx, []ExpectedGateway{gwA})
	if proveCalls(4) != 2 { t.Fatal(proveCalls(4)) }
}
func TestAcquire_OtherInterfaceChangeKeepsProof(t *testing.T) { /* Ethernet + Wi-Fi; dropIndex(7), fire, recheck; Acquire → proveCalls(4) == 1 */ }
func TestAcquire_ReuseRequiresExpectedMAC(t *testing.T)      { /* Acquire(gwA) then Acquire(gwB: 192.168.1.1, 3c:37:86:aa:bb:10) → proves again, *MismatchError */ }
func TestAcquire_WatcherExitDropsCache(t *testing.T)         { /* Acquire; fakeWatch returns an error; restart; Acquire → proveCalls(4) == 2 */ }
func TestAcquire_ConcurrentCallsShareOneProof(t *testing.T)  { /* fake proof sleeps 50 ms; 10 goroutines → proveCalls(4) == 1, all bound to index 4 */ }
func TestBegin_NeverReusesProof(t *testing.T) {
	ethernetOnly(t); setProof(t, 4, "a4:2b:b0:11:22:9c")
	_, _ = Acquire(ctx, []ExpectedGateway{gwA})
	s, err := Begin(ctx, []ExpectedGateway{gwA}); must(t, err); s.Close()
	_, _ = Acquire(ctx, []ExpectedGateway{gwA}) // Begin did not seed or refresh the cache either
	if proveCalls(4) != 2 { t.Fatal(proveCalls(4)) }
}
func TestConfirm(t *testing.T) {
	// no change since → nil; a change on index 4 after since → ErrNetworkChanged;
	// a change before since → nil; attachment gone at confirm time → ErrNetworkChanged; no rows plus a read error → ErrNetworkChanged
}
```

- [ ] **Step 2: Run** `cd agent && go test -race ./internal/netguard/ -run 'Acquire|NeverReuses|Confirm'` — FAIL (undefined `Acquire`).
- [ ] **Step 3: Implement** `acquire.go` and the hub additions.
- [ ] **Step 4: Run** `cd agent && go test -race -count=3 ./internal/netguard/... && CGO_ENABLED=0 go test ./internal/netguard/...` — PASS, W02c's tests included.
- [ ] **Step 5: Commit** — `git commit -m "feat(agent/netguard): Acquire with 60-second proof reuse, and Confirm"`

### Task 2: `SNMPDevice` carries the bind fields

**Files:** Modify `agent/internal/snmppoll/metrics.go` (the `SNMPDevice` type; `ClientConfig` at `:355-366`).
Test `agent/internal/snmppoll/metrics_bind_test.go`.

**Interfaces:** Produces `SNMPDevice` fields `LocalAddr string`, `Control func(network, address string, c syscall.RawConn) error`,
`Context context.Context`, copied by `ClientConfig()` to the W02c `SNMPClientConfig` fields.

- [ ] **Step 1: Write the failing test**

```go
func TestClientConfig_CarriesBindFields(t *testing.T) {
	ctx := context.WithValue(context.Background(), ctxKey{}, 1)
	ctl := func(string, string, syscall.RawConn) error { return nil }
	cfg := SNMPDevice{IP: "192.168.1.20", LocalAddr: "192.168.1.57:0", Control: ctl, Context: ctx}.ClientConfig()
	if cfg.LocalAddr != "192.168.1.57:0" || cfg.Control == nil || cfg.Context != ctx { t.Fatal(cfg) }
	if zero := (SNMPDevice{IP: "192.168.1.20"}).ClientConfig(); zero.LocalAddr != "" || zero.Control != nil || zero.Context != nil { t.Fatal(zero) }
}
```

- [ ] **Step 2: Run** `cd agent && go test -race ./internal/snmppoll/ -run CarriesBindFields` — FAIL.
- [ ] **Step 3: Add** the fields and copy them.
- [ ] **Step 4: Run** `cd agent && go test -race ./internal/snmppoll/...` — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(agent/snmppoll): SNMP poll device carries socket binding"`

### Task 3: `monitorNet`: unguarded unchanged, guarded bound

**Files:** Create `agent/internal/heartbeat/monitor_net.go`, `monitor_net_test.go`. Modify
`handlers_monitor.go:41-479` (bodies become `runNetworkPing`, `runNetworkTcpCheck`, `runNetworkHttpCheck`,
`runNetworkDnsCheck`), `handlers_network.go:353-370` (`runSnmpPoll`).

**Interfaces:** Consumes Tasks 1 and 2, `discovery.PingSweepBound`. Produces:

```go
type monitorNet interface {
	LookupIP(ctx context.Context, host string) ([]net.IP, error)
	PingSweep(ctx context.Context, targets []net.IP, timeout time.Duration, workers int) []discovery.PingResult
	DialTCP(ctx context.Context, address string, timeout time.Duration) (net.Conn, error)
	HTTPTransport(tlsConfig *tls.Config, timeout time.Duration) *http.Transport
	Resolver(nameserver string, timeout time.Duration) *net.Resolver // "" = system (unguarded) or the binding's servers (guarded)
	CollectSNMP(ctx context.Context, d snmppoll.SNMPDevice) ([]snmppoll.SNMPMetric, error)
}
type systemNet struct{}
type boundNet struct{ b netguard.Binding }
var unguardedNet monitorNet = systemNet{}
var (
	pingSweepBound = discovery.PingSweepBound // seams for boundNet tests
	collectMetrics = snmppoll.CollectMetrics
)
func runNetworkPing(ctx context.Context, cmd Command, n monitorNet) tools.CommandResult      // and the four siblings
```

`boundNet.LookupIP` returns IPv4 only. `boundNet.CollectSNMP` sets the three bind fields and resolves a
non-literal `d.IP` through `b.Resolver()` to the first IPv4 (none → error).

- [ ] **Step 1: Write the failing tests** (`loopbackBinding(t)`: loopback index, source `127.0.0.1`, a DNS stub
  in `Nameservers`; `fixture`: index 4, source `192.168.1.57`, which is not a local address on the runner):

```go
// static guard over handlers_monitor.go, handlers_network.go, handlers_probe_guarded.go (go/parser, build tags ignored)
func TestMonitorProbesOpenNothingOutsideMonitorNet(t *testing.T) {
	forbidden := []string{"net.Dial", "net.DialTimeout", "net.LookupIP", "net.LookupHost", "net.LookupAddr", "discovery.PingSweep",
		"discovery.PingSweepBound", "snmppoll.CollectMetrics", "net.Dialer", "net.Resolver", "http.Transport"} // calls and literals
	for _, hit := range findSelectors(t, []string{"handlers_monitor.go", "handlers_network.go", "handlers_probe_guarded.go"}, forbidden) {
		t.Errorf("%s:%d uses %s; go through monitorNet", hit.File, hit.Line, hit.Name)
	}
}
func TestUnguardedHandlersUseSystemNet(t *testing.T) { /* swap unguardedNet for a recorder; run each unguarded handler; every call recorded */ }
func TestBoundNet_TCPLeavesFromSource(t *testing.T) {
	ln := mustListen(t, "tcp4", "127.0.0.1:0")
	conn, err := boundNet{loopbackBinding(t)}.DialTCP(ctx, ln.Addr().String(), time.Second); must(t, err); conn.Close()
	if acceptedFrom(t, ln) != "127.0.0.1" { t.Fatal("wrong source") }
	if _, err := (boundNet{fixture}).DialTCP(ctx, ln.Addr().String(), time.Second); err == nil { t.Fatal("dial ignored the binding") }
}
func TestBoundNet_HTTPTransportIsBound(t *testing.T) {
	tr := boundNet{fixture}.HTTPTransport(&tls.Config{}, time.Second)
	if tr.DialContext == nil || tr.Proxy != nil { t.Fatal(tr) }
	srv := httptest.NewServer(okHandler); defer srv.Close()
	if _, err := (&http.Client{Transport: tr}).Get(srv.URL); err == nil { t.Fatal("request left without the binding") }
	if resp, err := (&http.Client{Transport: boundNet{loopbackBinding(t)}.HTTPTransport(&tls.Config{}, time.Second)}).Get(srv.URL); err != nil || resp.StatusCode != 200 { t.Fatal(err) }
}
func TestBoundNet_ResolverWithNameserverIsBound(t *testing.T)   { /* DNS stub on 127.0.0.1: loopback binding answers; fixture binding fails */ }
func TestBoundNet_ResolverDefaultsToBindingServers(t *testing.T) { /* Resolver("") with stub in Nameservers answers; no Nameservers → the lookup fails (DNSError text contains ErrNoNameserver) */ }
func TestBoundNet_PingUsesBoundSweep(t *testing.T)              { /* pingSweepBound recorder receives the binding and the targets */ }
func TestBoundNet_CollectSNMPIsBound(t *testing.T) {
	var got snmppoll.SNMPDevice
	collectMetrics = func(d snmppoll.SNMPDevice) ([]snmppoll.SNMPMetric, error) { got = d; return nil, nil } // restored by t.Cleanup
	b := loopbackBinding(t) // stub answers DESKTOP-01 → 192.168.1.20
	_, err := boundNet{b}.CollectSNMP(ctx, snmppoll.SNMPDevice{IP: "DESKTOP-01", Port: 161}); must(t, err)
	if got.IP != "192.168.1.20" || got.LocalAddr != "127.0.0.1:0" || got.Control == nil || got.Context == nil { t.Fatal(got) }
}
```

- [ ] **Step 2: Run** `cd agent && go test -race ./internal/heartbeat/ -run 'MonitorProbes|UnguardedHandlers|BoundNet'` — FAIL (the guard lists today's direct calls; the rest are undefined).
- [ ] **Step 3: Implement** `monitor_net.go`; move each handler body into its `run*` function with every
  socket and lookup going through `n`; the five `handle*` functions call `run*(context.Background(), cmd, unguardedNet)`.
- [ ] **Step 4: Run** `cd agent && go test -race ./internal/heartbeat/...` — PASS, the tests listed under
  "What the unguarded handlers keep doing" untouched.
- [ ] **Step 5: Commit** — `git commit -m "refactor(agent): monitor probes open sockets through monitorNet"`

### Task 4: The five guarded handlers

**Files:** Create `agent/internal/heartbeat/handlers_probe_guarded.go`, `handlers_probe_guarded_test.go`.
Modify `agent/internal/remote/tools/types.go` (after `:187` and `:198`), `handlers_test.go:67-70`,
`apps/api/src/services/partnerTrust.ts:65` (`GATED_COMMAND_TYPES`). `partnerTrust.test.ts` › "classifies
every known command type exactly once" parses `tools/types.go` and every `heartbeat/handlers*.go`
registration, so registering the five Go handlers without classifying them turns Test API red. W06b
adds the same five; whichever PR merges second finds them present and leaves them.

**Interfaces:** Consumes Tasks 1 to 3; W02c `parseExpectedNetwork`, `guardRefusal`. Produces:

```go
const (
	CmdSnmpPollGuarded         = "snmp_poll_guarded"           // tools
	CmdNetworkPingGuarded      = "network_ping_guarded"
	CmdNetworkTcpCheckGuarded  = "network_tcp_check_guarded"
	CmdNetworkHttpCheckGuarded = "network_http_check_guarded"
	CmdNetworkDnsCheckGuarded  = "network_dns_check_guarded"
)
var (
	acquireGuard = netguard.Acquire
	confirmGuard = netguard.Confirm
	newBoundNet  = func(b netguard.Binding) monitorNet { return boundNet{b} }
)
// required checks the base payload (target | url | hostname | parseSnmpPollRequest) before acquiring.
func runGuardedProbe(cmd Command, required func(map[string]any) *tools.CommandResult,
	run func(context.Context, Command, monitorNet) tools.CommandResult) tools.CommandResult
// Called on every result run returns after a successful Confirm. Completed: unmarshals the Stdout
// object, adds "verifiedNetwork", marshals it back. Failed (Error set): sets Result to a map holding
// "verifiedNetwork" (for snmp_poll_guarded also "deviceId" from the payload and "success": false, the
// shape W06b Task 9 reads), merged over any existing Result map; Stdout stays empty.
func withVerifiedNetwork(cmd Command, res tools.CommandResult, b netguard.Binding) tools.CommandResult
// True when the probe resolves a name: ping/tcp target, http URL host, snmp target not an IP literal;
// dns with no nameserver or a non-literal one. Checked after Acquire: true with empty b.Nameservers → refusal.
func needsLookup(cmdType string, payload map[string]any) bool
```

A failed base result from `required` gets `ErrorCode = wire.ErrCodeInvalidArgument`. A failed result
from `run` after a successful `Confirm` (for example an SNMP collection error) keeps its status, error and
error code and carries `verifiedNetwork` in `Result` (C5; `withVerifiedNetwork`), so the API records it
as a real failure.

- [ ] **Step 1: Write the failing tests.** `guardedCase` lists the five types with a valid payload each
  (`target: "192.168.1.20"`, `url: "http://192.168.1.20/"`, `hostname: "DESKTOP-01"`, SNMP `target` and
  `oids`), plus `expectedNetwork` with the `gwA` fixture. `recNet` is a `monitorNet` that records calls
  and makes each probe succeed.

```go
func TestGuardedProbes_MismatchIsCodedRefusal(t *testing.T) {
	for _, c := range guardedCases {
		t.Run(c.typ, func(t *testing.T) {
			acquireGuard = acquireErr(&netguard.MismatchError{}); rec := useRecNet(t)
			res := dispatchGuarded(t, c)
			if res.Status != "failed" || res.ErrorCode != wire.ErrCodeNetworkMismatch || res.Stdout != "" || res.Result == nil || rec.calls() != 0 { t.Fatal(res) }
		})
	}
}
func TestGuardedProbes_OtherAcquireErrorIsNetworkChanged(t *testing.T) { /* acquireErr(netguard.ErrWatchUnavailable) → network_changed, Stdout "", no probe call */ }
func TestGuardedProbes_ChangeDuringProbeDiscardsResult(t *testing.T) {
	for _, c := range guardedCases {
		acquireGuard = acquireOK(fixture); rec := useRecNet(t); rec.failAll(errors.New("connect: host is unreachable"))
		confirmGuard = func(context.Context, netguard.Binding, time.Time) error { return netguard.ErrNetworkChanged }
		res := dispatchGuarded(t, c)
		raw, _ := json.Marshal(res)
		if res.ErrorCode != wire.ErrCodeNetworkChanged || res.Stdout != "" || bytes.Contains(raw, []byte("offline")) ||
			bytes.Contains(raw, []byte("verifiedNetwork")) || rec.calls() == 0 { t.Errorf("%s: %s", c.typ, raw) }
	}
}
func TestGuardedProbes_SuccessAddsVerifiedNetwork(t *testing.T) {
	for _, c := range guardedCases {
		t.Run(c.typ, func(t *testing.T) {
			acquireGuard = acquireOK(fixture); rec := useRecNet(t)
			res := dispatchGuarded(t, c)
			body := stdoutMap(t, res)
			if res.Status != "completed" || !reflect.DeepEqual(body["verifiedNetwork"], fixture.Verified()) || rec.calls() == 0 { t.Fatal(res) }
			if c.typ == tools.CmdSnmpPollGuarded && body["protocol"] != float64(SnmpResultProtocol) { t.Fatal(body) }
		})
	}
}
func TestGuardedProbes_FailedButProvenCarriesVerifiedNetwork(t *testing.T) { // C5
	for _, c := range guardedCases {
		t.Run(c.typ, func(t *testing.T) {
			// network checks: the probe fails (ping no reply, TCP refused, HTTP and DNS errors) → completed, body status offline.
			// snmp: collectMetrics returns an error → status failed, Error set.
			acquireGuard = acquireOK(fixture); rec := useRecNet(t); rec.failAll(errors.New("connect: connection refused"))
			res := dispatchGuarded(t, c)
			if c.typ == tools.CmdSnmpPollGuarded {
				if res.Status != "failed" || res.Error == "" || res.Stdout != "" { t.Fatal(res) }
			} else if res.Status != "completed" || stdoutMap(t, res)["status"] != "offline" { t.Fatal(res) }
			// on both transports
			ws := toWSCommandResult("c-1", res)
			if got := roundTrip(t, ws.Result)["verifiedNetwork"]; !reflect.DeepEqual(got, fixture.Verified()) { t.Fatal(ws.Result) }
			raw, _ := json.Marshal(res)
			if !bytes.Contains(raw, []byte(`verifiedNetwork`)) { t.Fatal(string(raw)) }
		})
	}
}
func TestGuardedProbes_MalformedPayloadNeverAcquires(t *testing.T) {
	// per type: base field missing; expectedNetwork missing; gateways [] → invalid_argument; acquireGuard not called
}
func TestGuardedProbes_OrderIsAcquireProbeConfirm(t *testing.T) { /* trace == [acquire probe confirm] for each type */ }
func TestGuardedProbes_NoBoundNameserverIsRefusedNotOffline(t *testing.T) {
	// acquireOK(binding with no Nameservers); ping target "DESKTOP-01"; dns with no nameserver; http "http://DESKTOP-01/"
	// → network_changed, Error mentions ErrNoNameserver, Stdout "", rec.calls() == 0.
	// The same commands with IP-literal targets (and dns nameserver "192.168.1.1") run normally.
}
func TestUnguardedProbeResultsHaveNoVerifiedNetwork(t *testing.T) { /* each unguarded handler through recNet: no verifiedNetwork key */ }
```

- [ ] **Step 2: Run** `cd agent && go test -race ./internal/heartbeat/ -run 'GuardedProbes|UnguardedProbeResults|HandlerRegistry'` — FAIL.
- [ ] **Step 3: Implement**; register the five in `handlers_probe_guarded.go`'s `init()` as
  `handlerRegistry[tools.CmdXGuarded] = …` (the form the API test parses); add them to `allCommandTypes`.
  Then run `cd apps/api && npx vitest run src/services/partnerTrust.test.ts` — FAIL, "expected
  network_dns_check_guarded in exactly one command classification" (the test walks the types sorted,
  so it names the first unclassified one; unless W06b already merged them). Add the
  five to `GATED_COMMAND_TYPES`, each after its base type (operator-directed LAN probes, like their base
  types; skip any already present).
- [ ] **Step 4: Run** `cd agent && go test -race ./internal/heartbeat/... ./internal/netguard/... ./internal/snmppoll/...` — PASS.
  Then `cd apps/api && npx vitest run src/services/partnerTrust.test.ts src/services/callerVerification/workstation.contract.test.ts src/routes/agents/schemas.commandResult.test.ts` — PASS
  (the API tests that read the Go files this wave changes; `workstation.contract.test.ts` reads only
  `caller_verify.go` and `ipc` files and runs as the index asks).
- [ ] **Step 5: Commit** — `git commit -m "feat(agent): guarded SNMP poll and network check commands"`

### Task 5: CI and native runs

**Files:** Create `agent/internal/heartbeat/guarded_probe_live_test.go`. Check `.github/workflows/ci.yml:2755`
already lists `./internal/netguard` (W02c); this wave adds no package.

- [ ] **Step 1: Write the live test.** `TestLive_GuardedProbes` skips unless `BREEZE_GUARD_LIVE=1`; reads W02c's
  `BREEZE_GUARD_GATEWAY` and `_GATEWAY_MAC`, plus `BREEZE_GUARD_TARGET` (a LAN host) and optional
  `BREEZE_GUARD_EXPECT=mismatch`. It dispatches each guarded type twice within 60 s and logs per type only
  the status, the error code and whether `verifiedNetwork` is present, plus `netguard` proof counts
  (first call proves, second reuses).
- [ ] **Step 2: Run it on Windows, macOS and Linux** as Administrator or root against a real router (Linux
  and Windows `CGO_ENABLED=0`; macOS both): `cd agent && BREEZE_GUARD_LIVE=1 BREEZE_GUARD_GATEWAY=<gw> BREEZE_GUARD_GATEWAY_MAC=<mac> BREEZE_GUARD_TARGET=<host> go test -count=1 -v -run TestLive_GuardedProbes ./internal/heartbeat/`,
  then with `BREEZE_GUARD_EXPECT=mismatch` and a wrong MAC.
- [ ] **Step 3: Capture during the first run, on both interfaces**: ICMP echo, TCP SYN, UDP 161 and UDP 53
  from this host to the target or its DNS servers. Pass needs both: on the bound interface each kind the
  run used is **nonzero** with the bound source, and the ping type returned `online` with at least one
  reply (raw ICMP through `ListenConfig` is tested nowhere else); on the other interface, 0 of each.
  Toggle the bound link during a run whose target is unreachable: the result is `network_changed`, never
  `offline`. Without the toggle, the same unreachable target returns `offline` with `verifiedNetwork`
  present (C5).
- [ ] **Step 4: Run** `cd agent && go test -race ./... && CGO_ENABLED=0 go vet ./... && bash ../scripts/check-windows-vet.sh && GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go vet ./...` — PASS.
- [ ] **Step 5: Commit** — `git commit -m "test(agent): live guarded probe check"`

## Done when

- [ ] `cd agent && go test -race ./internal/netguard/... ./internal/heartbeat/... ./internal/snmppoll/... ./internal/discovery/...` passes; `CGO_ENABLED=0 go test` of the same packages passes.
- [ ] `cd agent && CGO_ENABLED=0 go vet ./...`, `bash scripts/check-windows-vet.sh` (repo root) and `cd agent && GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go vet ./...` are clean; `cd agent && golangci-lint run --new-from-rev=origin/main ./...` reports nothing new.
- [ ] `TestHandlerRegistryCompleteness` and `TestHandlerRegistryNoExtraEntries` pass with the five types.
- [ ] `cd apps/api && npx vitest run src/services/partnerTrust.test.ts src/services/callerVerification/workstation.contract.test.ts src/routes/agents/schemas.commandResult.test.ts` passes, and each of the five types appears once in `GATED_COMMAND_TYPES`.
- [ ] The `test-agent-windows` job log shows `./internal/netguard` ran, including `TestAcquire_*`.
- [ ] The PR body states: `Closes #<sub-issue>`; the five command types; that the unguarded handlers are
  unchanged, naming the tests above; the proof-reuse rule (60 s, dropped on a change to that interface,
  never used by discovery); per OS: version, cgo setting, each type's live outcome, the reuse count, the
  per-kind packet counts on the other interface, and the toggle result. **Redact first:** no real addresses,
  MACs, host names or lab machine names.
- [ ] Each Contract note is folded into the index in this PR.

## Contract notes

1. **`netguard.Confirm(ctx, b, since)`** is in index D6 beside `Acquire`. It checks after the probe that
   the interface did not change, so a result from a laptop that left mid-probe becomes `network_changed`
   (no `verifiedNetwork`, so not checked) instead of `offline`.
2. **Every failure that is not a mismatch is `network_changed`**, as in W02c Contract note 4, including a
   name lookup that cannot run because the interface has no DNS server. W06b can also receive
   `invalid_argument`, only for a malformed command its own builder sent. None of these carries
   `verifiedNetwork`, so the index H rule ("any guarded result without a valid `verifiedNetwork` is not
   checked") covers them all; a failed result that does carry one is a real failure (C5).
3. **The proof cache is invalidated by a detected change, not by every event.** `WatchChanges` does not say
   which interface changed; the hub re-reads and drops a cached proof when that interface's link, address,
   prefix, gateway or cached gateway MAC differs (W02c's rule). A flap that restores the same state before the
   re-read keeps the proof.
4. **Name lookups use the bound interface's own DNS servers** (W02c `Binding.Nameservers`). A host whose only
   resolver is a loopback stub cannot run a guarded check by host name; it is refused, never reported offline.
5. **`snmppoll.SNMPDevice` gains `LocalAddr`, `Control` and `Context`** (Task 2), not listed in the index.
6. **Where W06b reads `verifiedNetwork`** is settled by index C7 and the transport rule in Wave
   constraints: a completed body is `result` on the WebSocket and `stdout` on REST, which the API
   parses; a failed-but-proven body and a refusal body (`observedGateways`) are `result` on both legs.
   W06b's verdict reads `result.result.verifiedNetwork`, so its REST path for a completed result parses
   `stdout`.
