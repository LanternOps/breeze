# Learned Networks W02b: Fresh gateway proof spike (gate)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find out, with lab evidence, whether the agent can get a fresh layer-2 answer from its default
gateway on Windows, macOS and Linux, and if it can, ship that as `agent/internal/gatewayproof`.

**Architecture:** One exported function, `gatewayproof.Prove`. On Linux and macOS it sends an ARP request
on the named interface (a raw `AF_PACKET` socket, a BPF device) and returns the MAC of the first reply
addressed to it. Frame encoding, reply matching and the send-and-wait loop are pure Go in untagged files,
so their tests run on every OS. On Windows, where user-mode code cannot send raw Ethernet frames without
a driver, it uses `iphlpapi` neighbour calls; which call is decided in the lab. Each OS file builds with
`CGO_ENABLED=0`.

**Tech stack:** Go, `golang.org/x/sys/unix` and `golang.org/x/sys/windows` v0.50.0, `golang.org/x/net/bpf`
v0.62.0 (both modules are already dependencies; no new module).

**Spec:** `docs/superpowers/specs/monitoring/2026-11-20-learned-networks-discovery-gate-design.md` (§7.2 step 2, §11 last bullet)

**Index:** `docs/superpowers/plans/monitoring/2026-11-21-learned-networks.md`. Its Global constraints,
Review focus and Cross-wave contract apply to every task here (this wave owns D2 and sequencing rule 1).

## The question

Can the agent obtain a layer-2 answer from the default gateway that was produced during the call, on
Windows, macOS and Linux, without cgo, running as the agent's service account?

## This wave is a gate

From the index, sequencing rule 1, verbatim:

> **W02b is a gate.** It must return a fresh layer-2 answer on all three operating systems, with the
> evidence file committed. If one OS cannot do it, stop: W02c and W03c do not start, and the question
> goes back to the owner (§11). Step 2 of §7.2 is never weakened and no OS is dropped quietly.

When an OS fails: commit the evidence file with that OS's verdict `fail` and what was tried, open the PR
as a draft that says so, and take it to the owner. Do not loosen a criterion, and do not ship the
package for the OSes that passed.

## Wave constraints

- Agent code ships to customer machines: TDD, one independent review round, `go test -race`.
- Every file builds with `CGO_ENABLED=0` on all three OSes. The existing ARP sender
  (`agent/internal/discovery/arp.go`, `//go:build cgo`, pcap) is not used.
- CI tests never send a frame. Anything that touches a real network is the env-gated lab test
  (precedent: `TIMESYNC_LIVE` in `agent/internal/collectors/timesync/live_windows_test.go:14`, described at `ci.yml:2721-2729`).
- The evidence file and the PR body are public. They never carry a real address, MAC, host name or lab
  name. The lab harness prints `match=expected|planted|other` instead of MACs; any capture excerpt is
  rewritten with the index's synthetic values, consistently (router MAC → `a4:2b:b0:11:22:9c`, planted
  wrong MAC → `3c:37:86:aa:bb:10`, LAN → `192.168.1.0/24` via `192.168.1.1`, machine → `192.168.1.57`).
  Raw captures stay outside the repository.
- Everything under "known" below was read in this repository or in x/sys v0.50.0. Everything under
  "unknown" has not been tried; the lab answers it.

## What each OS offers

The service accounts below are **inferred from absent settings**, not observed: the Linux unit has no
`User=` (`agent/service/systemd/breeze-agent.service`, embedded copy
`agent/internal/agentapp/systemd_unit.go`), the launchd plist has no `UserName`
(`agent/service/launchd/com.breeze.agent.plist`), and the Windows service is created with no account in
`mgr.Config` (`agent/internal/winsvcinstall/scm_windows.go:44-50`), which means LocalSystem. Criterion 5
confirms each one.

### Windows (LocalSystem)

Known: x/sys v0.50.0 wraps none of `ResolveIpNetEntry2`, `GetIpNetEntry2`, `DeleteIpNetEntry2`,
`FlushIpNetTable2` or `SendARP`. They are reached as `windows.NewLazySystemDLL("iphlpapi.dll").NewProc(...)`
as `networkcontext/windows.go:37-42` does, and each proc is checked with `Find()` before `Call()`, because
calling a missing export panics the agent (`getIfEntry2`, `windows.go:420-435`, #9233). The row type is a
local mirror of `MIB_IPNET_ROW2`; the same layout already exists unexported as `windowsNeighbor`
(`windows.go:268-278`).

| Order | Candidate | Needs | Unknown |
|---|---|---|---|
| W1 | `ResolveIpNetEntry2(row, source)` alone | the row with `Address` = gateway and `InterfaceIndex`; `source` = the interface address | Microsoft's documentation says it flushes a matching entry and then sends requests (read from the documentation, not tried). Whether it does so for an entry that is `Reachable`, and for a `Permanent` one. How long it blocks with no answer and which error code it returns. Whether it needs administrator rights. |
| W2 | `DeleteIpNetEntry2(row)` for a dynamic entry, then `ResolveIpNetEntry2` | as W1 | Whether deleting the entry the machine is using interrupts its traffic (criterion 4). An entry present after the delete was learned after the call began; whether the machine's own traffic can re-learn it between the two calls is harmless but should be noted. |
| W3 | `DeleteIpNetEntry2`, then `SendARP(gateway, source)` | as W2 | `SendARP` is documented to answer from the table when an entry exists (not tried), so it is only useful after a delete. |
| W4 | `FlushIpNetTable2(AF_INET, index)`, then `ResolveIpNetEntry2` | interface index | Expected to fail criterion 4 (it drops every neighbour on the interface). Try only if W1 to W3 fail. |

A `Permanent` entry: if the lab shows that a candidate returns a planted permanent MAC, `Prove` reads the
entry state with `GetIpNetEntry2` first and returns `ErrNoAnswer` for a permanent entry (a static entry
means the OS will not ask the gateway, so no fresh answer exists). It never deletes or changes a
permanent entry. Whether `MIB_IPNET_ROW2.ReachabilityTime.LastReachable` can confirm that an answer
arrived during the call is unknown; record it, do not rely on it.

### Linux (root, unsandboxed)

Known: `breeze-agent.service:66-72` is deliberately unsandboxed, with no `CapabilityBoundingSet`,
`AmbientCapabilities`, `RestrictAddressFamilies` or `NoNewPrivileges` (read: those words do not appear in
the unit). The installer copies that unit (`agent/scripts/install/install-linux.sh:6-7`). x/sys/unix has
`AF_PACKET`, `ETH_P_ARP`, `SockaddrLinklayer` and `Poll`.

| Order | Candidate | Needs | Unknown |
|---|---|---|---|
| L1 | `socket(AF_PACKET, SOCK_RAW, htons(ETH_P_ARP))`, bound to the interface index; write the request frame to the broadcast address, read until a matching reply | `CAP_NET_RAW` (root has it); the interface MAC from `net.InterfaceByIndex` | Behaviour on Wi-Fi interfaces and on a bridge (`br0`). Whether the kernel's own entry for the gateway changes when it sees the reply (expected to be harmless; record it). |

### macOS (root LaunchDaemon)

Known: x/sys/unix for darwin has `BIOCSETIF`, `BIOCIMMEDIATE`, `BIOCSHDRCMPLT`, `BIOCSSEESENT`,
`BIOCSETF`, `BIOCGBLEN`, `BIOCSRTIMEOUT`, `BPF_ALIGNMENT` (4), `BpfProgram`, `BpfInsn` and `BpfHdr`
(`SizeofBpfHdr` = 20: `Caplen` at offset 8, `Hdrlen` at offset 16), and `IoctlSetPointerInt`, which
passes a pointer to a 32-bit value as `BIOCIMMEDIATE`, `BIOCSHDRCMPLT` and `BIOCSSEESENT` take (`u_int`,
`man 4 bpf`). It has no darwin `ifreq` helper.

| Order | Candidate | Needs | Unknown |
|---|---|---|---|
| M1 | Open the first free `/dev/bpfN` (skip `EBUSY`); `BIOCSETIF` with the BSD name; `BIOCIMMEDIATE` 1, `BIOCSHDRCMPLT` 1, `BIOCSSEESENT` 0; an ARP-reply filter through `BIOCSETF` (assembled with `golang.org/x/net/bpf`); write the request frame; read records until a matching reply | root; the interface MAC from `net.InterfaceByName` | **How `BIOCSETIF` (a pointer to a 32-byte `ifreq`) is issued without cgo.** The candidate is `unix.Syscall(unix.SYS_IOCTL, fd, unix.BIOCSETIF, uintptr(unsafe.Pointer(&ifr)))`; whether that builds and works with `CGO_ENABLED=0` on darwin is to be confirmed. The read timeout: `BIOCSRTIMEOUT` or `unix.Poll` on the device. Whether macOS local-network privacy affects BPF writes from a launchd daemon. Whether it works on Wi-Fi (`en0`) as well as Ethernet. |

## Pass criteria

The evidence file answers each one for each OS. All must pass on all three.

1. **Correct.** The returned MAC equals the gateway's real MAC, read from the test router's label or
   admin page. The harness compares and prints `match=expected`.
2. **Fresh.** With a deliberately wrong neighbour entry for the gateway in place, the call returns the
   live MAC or fails, never the planted one. Run twice: a dynamic (stale) planted entry and a static
   (permanent) one. Shown with a packet capture taken during the call, or an equivalent observation,
   that has a request leaving and a reply arriving inside the call's start and end times.
3. **Unreachable.** With the gateway unreachable and the machine's link still up, the call returns
   `ErrNoAnswer` within its timeout plus 100 ms. Ten calls.
4. **Harmless.** 100 back-to-back calls do not interrupt the machine's own traffic: ping loss to the
   gateway during the calls is no higher than in a baseline of the same length without calls, and an
   open TCP session whose packets go through the gateway shows no gap over 1 second.
5. **Service account.** It works when run as the account the agent runs as (LocalSystem, root under
   launchd, root under systemd), shown by the harness's `user=` line.
6. **No cgo.** The binary that ran was built with `CGO_ENABLED=0`, shown by the harness's `cgo=` line.
7. **Time.** Median and worst call time over the 100 calls of criterion 4.

## Lab rig

- A test router (any consumer router) whose LAN MAC can be read from its label or admin page, serving
  DHCP on its LAN.
- An unmanaged switch between the router and the machines, so unplugging the router's LAN cable leaves
  each machine's link up (criterion 3).
- The three machines on that switch: **the Windows lab VM** (its virtual NIC bridged to the rig's LAN,
  not NAT, or its gateway is the hypervisor), **the lab Mac** on Ethernet (Wi-Fi as a second run if
  available), and **a Linux lab VM** (bridged the same way).
- Management access that does not route through the router: the console, or a session from a host on
  the same switch. A planted wrong gateway MAC cuts every routed session.
- A host beyond the router (on its WAN side) to hold the TCP session of criterion 4.

| | Plant a wrong entry (dynamic / static) | Check it | Remove it | Capture |
|---|---|---|---|---|
| Windows | `New-NetNeighbor -InterfaceIndex <i> -IPAddress <gw> -LinkLayerAddress 3c-37-86-aa-bb-10 -State Stale` / `-State Permanent` (whether a non-permanent entry can be planted is unknown; record which states were accepted) | `Get-NetNeighbor -IPAddress <gw>` | `Remove-NetNeighbor -IPAddress <gw> -Confirm:$false` | `pktmon` (built in): add an ARP filter (`pktmon filter add help` for the syntax), `pktmon start --capture`, `pktmon stop`, `pktmon etl2pcap` |
| Linux | `ip neigh replace <gw> lladdr 3c:37:86:aa:bb:10 dev <if> nud stale` / `nud permanent` | `ip neigh show <gw>` | `ip neigh del <gw> dev <if>` | `tcpdump -n -e -i <if> arp` |
| macOS | `arp -s <gw> 3c:37:86:aa:bb:10 temp` / without `temp` | `arp -n <gw>` | `arp -d <gw>` | `tcpdump -n -e -i <if> arp` |

How each harness run is launched under the service account (criterion 5):

- Windows: a one-shot scheduled task with `/ru SYSTEM` that runs the test binary and writes its output to a file.
- macOS: a temporary plist in `/Library/LaunchDaemons` whose `ProgramArguments` run the test binary, with
  `StandardOutPath`; `launchctl bootstrap system <plist>`, then `bootout` and delete the plist.
- Linux: `systemd-run --wait --pipe --collect <test binary> ...` (a transient system unit, root, no sandbox).

## Evidence file

`docs/superpowers/plans/monitoring/evidence/2026-11-21-learned-networks-fresh-proof.md`, with exactly
these headings:

```markdown
# Learned networks: fresh gateway proof (W02b evidence)
Date, agent commit, who ran it.
## Verdict
## Rig
## Windows
### Candidates tried
### Results
### Capture excerpts (redacted)
## macOS
### Candidates tried
### Results
### Capture excerpts (redacted)
## Linux
### Candidates tried
### Results
### Capture excerpts (redacted)
## Unknowns resolved
## Decision
```

`## Verdict` holds this table, one row per OS:

| OS | OS version | Mechanism | Account | C1 | C2 stale | C2 static | C3 | C4 | C5 | C6 | Median ms | Worst ms | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

Each `### Results` holds `| # | Criterion | How measured | Result (pass/fail) | Evidence (excerpt or harness lines) |`
with rows 1 to 7. `### Candidates tried` holds `| Candidate | Outcome | Criterion that decided it |`.
`## Unknowns resolved` holds `| Unknown (as listed in the W02b plan) | Answer | How observed |`, one row for
every "unknown" cell above. `## Decision` says "gate passed" or names the failing OS and what was asked
of the owner.

## File structure

| File | Responsibility |
|---|---|
| `agent/internal/gatewayproof/gatewayproof.go` (untagged) | `Interface`, `ErrNoAnswer`, `Prove`, request validation, default timeout |
| `agent/internal/gatewayproof/arp.go` (untagged) | `encodeRequest`, `decodeReply` |
| `agent/internal/gatewayproof/exchange.go` (untagged) | `frameConn`, `exchange` (send, resend, wait, match) |
| `agent/internal/gatewayproof/bpfrecords.go` (untagged) | `bpfRecords`: split a darwin BPF read buffer |
| `agent/internal/gatewayproof/prove_linux.go` | `prove`: `AF_PACKET` conn |
| `agent/internal/gatewayproof/bpfconn.go` (untagged) | `bpfConn`, `ifreqName`, `arpReplyFilter` |
| `agent/internal/gatewayproof/prove_darwin.go` | `prove`: open `/dev/bpfN`, ioctls |
| `agent/internal/gatewayproof/prove_windows.go` | `prove`: the chosen `iphlpapi` candidate; `mibIpnetRow2` |
| `agent/internal/gatewayproof/*_test.go` | unit tests per file; `lab_test.go` (env-gated harness) |
| `.github/workflows/ci.yml` | `./internal/gatewayproof` added to `test-agent-windows` (`:2755`) |
| `docs/superpowers/plans/monitoring/evidence/2026-11-21-learned-networks-fresh-proof.md` | the evidence |

---

### Task 1: ARP frame codec

**Files:** Create `agent/internal/gatewayproof/arp.go`, `arp_test.go`

**Interfaces:**
- Produces: `const frameLen = 60`;
  `func encodeRequest(srcMAC net.HardwareAddr, src, target netip.Addr) []byte` (Ethernet broadcast,
  EtherType `0x0806`, htype 1, ptype `0x0800`, hlen 6, plen 4, op 1, `tha` zero, padded with zeros to 60 bytes);
  `func decodeReply(frame []byte, srcMAC net.HardwareAddr, src, gateway netip.Addr) (net.HardwareAddr, bool)`.

`decodeReply` accepts a frame only when: at least 42 bytes; EtherType `0x0806` at offset 12 (an 802.1Q
tag does not match); htype 1, ptype `0x0800`, hlen 6, plen 4; op 2; `spa == gateway`; `tpa == src`;
`tha == srcMAC`; `sha` is not zero, broadcast or multicast. It returns a copy of `sha`.

- [ ] **Step 1: Write the failing tests**

```go
var (
	ourMAC = mustMAC("00:1a:8c:00:00:01")
	gwMAC  = mustMAC("a4:2b:b0:11:22:9c")
	src    = netip.MustParseAddr("192.168.1.57")
	gw     = netip.MustParseAddr("192.168.1.1")
)

func TestEncodeRequest(t *testing.T) {
	want := mustHex("ffffffffffff" + "001a8c000001" + "0806" + "0001" + "0800" + "06" + "04" + "0001" +
		"001a8c000001" + "c0a80139" + "000000000000" + "c0a80101" + strings.Repeat("00", 18))
	if got := encodeRequest(ourMAC, src, gw); !bytes.Equal(got, want) || len(got) != frameLen {
		t.Fatalf("got %x\nwant %x", got, want)
	}
}

func TestDecodeReply(t *testing.T) {
	good := reply(gwMAC, gw, ourMAC, src) // helper: a well-formed op-2 frame, 60 bytes
	if mac, ok := decodeReply(good, ourMAC, src, gw); !ok || mac.String() != "a4:2b:b0:11:22:9c" {
		t.Fatalf("good reply: %v %v", mac, ok)
	}
	for name, frame := range map[string][]byte{
		"request, not reply":       withOp(good, 1),
		"sender is not the gateway": reply(gwMAC, netip.MustParseAddr("192.168.1.2"), ourMAC, src),
		"not addressed to our IP":  reply(gwMAC, gw, ourMAC, netip.MustParseAddr("192.168.1.58")),
		"not addressed to our MAC": reply(gwMAC, gw, mustMAC("3c:37:86:aa:bb:10"), src),
		"zero sender MAC":          reply(mustMAC("00:00:00:00:00:00"), gw, ourMAC, src),
		"broadcast sender MAC":     reply(mustMAC("ff:ff:ff:ff:ff:ff"), gw, ourMAC, src),
		"802.1Q tagged":            vlanTagged(good),
		"IPv4 EtherType":           withEtherType(good, 0x0800),
		"truncated":                good[:41],
		"hlen 8":                   withByte(good, 18, 8),
	} {
		if _, ok := decodeReply(frame, ourMAC, src, gw); ok {
			t.Errorf("%s: accepted", name)
		}
	}
}
```

- [ ] **Step 2: Run them and see them fail.** `cd agent && go test -race -run 'TestEncodeRequest|TestDecodeReply' ./internal/gatewayproof/` → FAIL, undefined.
- [ ] **Step 3: Implement `encodeRequest` and `decodeReply`** with `encoding/binary` (big endian on the wire).
- [ ] **Step 4: Run them and see them pass** (same command).
- [ ] **Step 5: Commit** `feat(agent): ARP request and reply codec for gateway proof`.

### Task 2: Send-and-wait loop, `Prove`, BPF record split

**Files:** Create `gatewayproof.go`, `exchange.go`, `bpfrecords.go` and their `_test.go` files in `agent/internal/gatewayproof/`

**Interfaces:**
- Produces (D2, verbatim):

```go
type Interface struct { Name string; Index uint32; Source netip.Addr }
var ErrNoAnswer = errors.New("gatewayproof: no answer from gateway")
func Prove(ctx context.Context, iface Interface, gateway netip.Addr) (net.HardwareAddr, error)
```

- Unexported: `const defaultTimeout = time.Second` (applied when `ctx` has no deadline);
  `const resendInterval = 250 * time.Millisecond`; `var errReadTimeout`;
  `func prove(ctx context.Context, iface Interface, gateway netip.Addr) (net.HardwareAddr, error)` (one per OS file);

```go
type frameConn interface {
	WriteFrame(frame []byte) error
	ReadFrame(deadline time.Time) ([]byte, error) // errReadTimeout when the deadline passes
	Close() error
}
func exchange(ctx context.Context, c frameConn, request []byte, match func([]byte) (net.HardwareAddr, bool)) (net.HardwareAddr, error)
func bpfRecords(buf []byte) ([][]byte, error)
```

`Prove` rejects, before any socket is opened, a gateway or source that is not a valid IPv4 address, an
`Index` of 0, and a gateway equal to the source. It applies `defaultTimeout` when `ctx` has no deadline,
then calls `prove`. Results: a MAC; `ErrNoAnswer` when the deadline passes without a matching reply;
`context.Canceled` when the caller cancels; any other error wrapped with `gatewayproof:`.

`exchange` is the algorithm the signature does not determine:

```go
// 1. Drain: read with an already-passed deadline until errReadTimeout, discarding everything
//    queued before the request (an answer from before the call never counts).
// 2. Loop until ctx is done:
//      write the request (at start, then every resendInterval);
//      read with deadline = min(next resend, ctx deadline);
//      a frame for which match returns ok -> return that MAC;
//      errReadTimeout -> continue; any other read or write error -> return it.
// 3. ctx deadline -> ErrNoAnswer; ctx cancelled -> ctx.Err().
```

`bpfRecords` walks a darwin BPF read buffer: each record is `Hdrlen` bytes of header (`uint16` at offset
16, native endian) followed by `Caplen` bytes (`uint32` at offset 8), and the next record starts at
`align4(Hdrlen + Caplen)`. A record that runs past the buffer is an error.

- [ ] **Step 1: Write the failing tests** (`fakeConn` scripts reads and records writes with timestamps)

| Test | Setup | Asserts |
|---|---|---|
| `TestExchange_ReplyAfterRequest` | one queued non-matching frame, then a matching reply after the first write | the MAC; the non-matching frame did not end the call |
| `TestExchange_ReplyQueuedBeforeRequestIgnored` | a matching reply already queued when `exchange` starts, nothing after | `ErrNoAnswer` (the drain discarded it) |
| `TestExchange_Resends` | no replies; deadline 600 ms | 3 writes, at about 0, 250 and 500 ms; `ErrNoAnswer` |
| `TestExchange_Cancelled` | no replies; cancel at 100 ms | `context.Canceled`, not `ErrNoAnswer` |
| `TestExchange_WriteErrorReturned` | `WriteFrame` fails | that error, wrapped |
| `TestProve_RejectsBadRequest` | IPv6 gateway; zero `Index`; invalid source; gateway == source | an error that is not `ErrNoAnswer`, returned in under 10 ms |
| `TestProve_DefaultTimeout` | `prove` replaced by a seam that waits for `ctx.Done()`; `ctx` without deadline | returns after 1 s ± 100 ms |
| `TestBPFRecords` | a buffer of two records (hdrlen 20, caplen 42 then 60) with alignment padding; a buffer whose second record is truncated | two frames of 42 and 60 bytes; an error |

`TestProve_DefaultTimeout` swaps a package-variable seam: `gatewayproof.go` declares
`var proveImpl = prove` and `Prove` calls `proveImpl`.

- [ ] **Step 2: Run them and see them fail.** `cd agent && go test -race -run 'TestExchange_|TestProve_|TestBPFRecords' ./internal/gatewayproof/` → FAIL, undefined.
- [ ] **Step 3: Implement `Prove`, `exchange`, `bpfRecords`,** and create `prove_linux.go`,
`prove_darwin.go` and `prove_windows.go` with a stub `prove` that returns
`errors.New("gatewayproof: not implemented")`, so the package builds on all three; Tasks 3 to 5 replace them.
- [ ] **Step 4: Run them and see them pass** (same command).
- [ ] **Step 5: Commit** `feat(agent): gateway proof request loop`.

### Task 3: Linux `AF_PACKET`

**Files:** Modify `agent/internal/gatewayproof/prove_linux.go`; create `prove_linux_test.go`

**Interfaces:** Consumes `exchange`, `encodeRequest`, `decodeReply`. Produces `prove` for Linux and a
`packetConn` implementing `frameConn`.

`prove`: interface MAC from `net.InterfaceByIndex(int(iface.Index))` (must be 6 bytes);
`unix.Socket(unix.AF_PACKET, unix.SOCK_RAW|unix.SOCK_CLOEXEC, int(htons(unix.ETH_P_ARP)))`; `unix.Bind` to
`SockaddrLinklayer{Protocol: htons(ETH_P_ARP), Ifindex: int(iface.Index)}`; writes with `unix.Sendto` to
`SockaddrLinklayer{Ifindex, Halen: 6, Addr: broadcast}`; reads with `unix.Poll` until the deadline, then
`unix.Recvfrom`. Close the socket on every path.

- [ ] **Step 1: Write the failing test.** `TestProveLinux_WithoutRawCapability` (skips when
`os.Geteuid() == 0`; CI runs as a non-root user): `Prove` on the first up, non-loopback interface from
`net.Interfaces()`, `Source` `192.168.1.57`, gateway `192.168.1.1` returns an error with
`errors.Is(err, syscall.EPERM)` and not `ErrNoAnswer`. Nothing is sent: the socket is never opened.
- [ ] **Step 2: Run it and see it fail.** `cd agent && go test -race -run TestProveLinux_ ./internal/gatewayproof/` → FAIL (the stub returns a different error).
- [ ] **Step 3: Implement `prove` and `packetConn` for Linux.**
- [ ] **Step 4: Run it and see it pass**, then `cd agent && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go vet ./internal/gatewayproof/` → exit 0.
- [ ] **Step 5: Commit** `feat(agent): gateway proof over AF_PACKET on Linux`.

### Task 4: macOS BPF

**Files:** Modify `agent/internal/gatewayproof/prove_darwin.go`; create `bpfconn.go`, `bpfconn_test.go`

**Interfaces:** Consumes `exchange`, `encodeRequest`, `decodeReply`, `bpfRecords`. Produces `prove` for
macOS; `bpfConn` implementing `frameConn` over an `*os.File` (it buffers the records of one read and
returns them one at a time); `func ifreqName(name string) ([32]byte, error)` (name in the first 16 bytes,
NUL-terminated, at most 15 bytes); `func arpReplyFilter() []bpf.Instruction`. The two helpers and
`bpfConn`'s record handling are untagged-testable logic, so put them in `bpfconn.go` without a build tag
and keep only the device open and ioctls in `prove_darwin.go`. `bpfConn` waits with `(*os.File).SetReadDeadline`;
whether Go's poller accepts a `/dev/bpf` descriptor on macOS is unknown, and if it does not, `prove_darwin.go`
sets `BIOCSRTIMEOUT` instead and the lab records which one ran.

`prove`: interface MAC from `net.InterfaceByName(iface.Name)`; open `/dev/bpf0` upward, skipping `EBUSY`,
up to `/dev/bpf255`; then the M1 sequence. Read buffer size from `BIOCGBLEN`. The filter accepts
EtherType `0x0806` with op 2 and rejects everything else. Resolve the M1 unknowns here: if
`unix.Syscall(SYS_IOCTL, ...)` for `BIOCSETIF` does not build or does not work with `CGO_ENABLED=0`,
stop and record it in the evidence file before trying anything else.

- [ ] **Step 1: Write the failing tests** (untagged, in `bpfconn_test.go`; none opens a device)

| Test | Asserts |
|---|---|
| `TestIfreqName` | `"en0"` → bytes `65 6e 30 00…`, length 32; a 15-byte name accepted; a 16-byte name and `""` rejected |
| `TestARPReplyFilter` | run through `bpf.NewVM(arpReplyFilter())` (`golang.org/x/net/bpf`): Task 1's good reply is accepted with its full length; the request from `encodeRequest`, an IPv4 frame and an 802.1Q-tagged reply return 0 |
| `TestBPFConn_ReadFrame` | a `bpfConn` over the read end of an `os.Pipe`; the write end receives one buffer holding two BPF records (Task 2's fixture): two `ReadFrame` calls return the two frames, a third with a passed deadline returns `errReadTimeout`. Skips on Windows, where a pipe takes no read deadline |

- [ ] **Step 2: Run them and see them fail.** `cd agent && go test -race -run 'TestIfreqName|TestARPReplyFilter|TestBPFConn_' ./internal/gatewayproof/` → FAIL, undefined.
- [ ] **Step 3: Implement `prove` and `bpfConn` for macOS.**
- [ ] **Step 4: Run it and see it pass**, then `cd agent && CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go vet ./internal/gatewayproof/ && CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go test -c -o /dev/null ./internal/gatewayproof` → exit 0.
- [ ] **Step 5: Commit** `feat(agent): gateway proof over BPF on macOS`.

### Task 5: Windows `iphlpapi` candidates

**Files:** Modify `agent/internal/gatewayproof/prove_windows.go`; create `prove_windows_test.go`;
modify `.github/workflows/ci.yml:2755` (append `./internal/gatewayproof`, with a comment paragraph in the
style of the others saying what Windows-only code it carries and how it was verified)

**Interfaces:** Produces `prove` for Windows, `type mibIpnetRow2 struct` (the `MIB_IPNET_ROW2` mirror),
and for the spike only `type windowsMethod int` with `methodResolve` (W1), `methodDeleteResolve` (W2),
`methodDeleteSendARP` (W3), `methodFlushResolve` (W4), selected by `proveWith(ctx, iface, gateway, method)`.
`prove` calls `proveWith` with `spikeMethod()`, which reads `GATEWAYPROOF_WINDOWS_METHOD` in the lab
build and defaults to W1. Task 8 removes the losing methods and the variable.

Each blocking `iphlpapi` call runs in a goroutine; `proveWith` returns at the context deadline with
`ErrNoAnswer` and lets the call finish in the background. A successful row must have
`PhysicalAddressLength == 6`. Map the "no answer" error codes the lab observes to `ErrNoAnswer` and
record them in the evidence file.

- [ ] **Step 1: Write the failing tests** (Windows-tagged; they run in `test-agent-windows` and send nothing)

| Test | Asserts |
|---|---|
| `TestMibIpnetRow2Layout` | `unsafe.Sizeof(mibIpnetRow2{}) == 88` and offsets: `InterfaceIndex` 28, `InterfaceLuid` 32, `PhysicalAddress` 40, `PhysicalAddressLength` 72, `State` 76, `Flags` 80, `ReachabilityTime` 84 (computed from `netioapi.h`; the test is what confirms them) |
| `TestIphlpapiProcsResolve` | `Find()` returns nil for `ResolveIpNetEntry2`, `GetIpNetEntry2`, `DeleteIpNetEntry2`, `FlushIpNetTable2` and `SendARP` on the runner |
| `TestProveWindows_RejectsBeforeCalling` | `Prove` with `Index: 0` returns an error before any proc is called (the counting seam around `Call` stays at 0) |

- [ ] **Step 2: Run them and see them fail** on a Windows machine (PowerShell): `cd agent; $env:CGO_ENABLED="0"; go test -run "TestMibIpnetRow2Layout|TestIphlpapiProcsResolve|TestProveWindows_" ./internal/gatewayproof/` → FAIL. Elsewhere: `cd agent && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go test -c -o /dev/null ./internal/gatewayproof` → build failure.
- [ ] **Step 3: Implement `mibIpnetRow2`, the procs and `proveWith` for W1 to W4.**
- [ ] **Step 4: Run them and see them pass**, then `bash scripts/check-windows-vet.sh` from the repo root → exit 0 (a changed unsafeptr count is adjudicated in a comment at the call site and locked with `--update`), and `cd agent && ! CGO_ENABLED=0 GOOS=windows go list -deps ./internal/gatewayproof | grep -E 'remote/desktop|runtime/cgo'` → exit 0.
- [ ] **Step 5: Commit** `feat(agent): gateway proof candidates through iphlpapi on Windows`.

### Task 6: Lab harness

**Files:** Create `agent/internal/gatewayproof/lab_test.go` (untagged)

`TestProve_Lab` skips unless `GATEWAYPROOF_LAB=1`. Inputs: `GATEWAYPROOF_IFACE` (name; index from
`net.InterfaceByName`), `GATEWAYPROOF_SOURCE`, `GATEWAYPROOF_GATEWAY`, `GATEWAYPROOF_EXPECT_MAC`,
`GATEWAYPROOF_PLANTED_MAC` (optional), `GATEWAYPROOF_CALLS` (default 1), `GATEWAYPROOF_TIMEOUT`
(default `1s`), `GATEWAYPROOF_WINDOWS_METHOD`. Output, one line each, no MAC or address printed:

```text
user=<os/user.Current().Username> cgo=<CGO_ENABLED from debug.ReadBuildInfo> goos=<runtime.GOOS> method=<name>
call=<n> start=<RFC3339Nano> end=<RFC3339Nano> ms=<duration> result=<ok|no_answer|error:<text>> match=<expected|planted|other|->
summary calls=<n> ok=<n> expected=<n> planted=<n> other=<n> no_answer=<n> errors=<n> median_ms=<x> max_ms=<y>
```

The test fails when any call returns `match=planted`. Start and end times let a capture be lined up
with each call (criterion 2).

- [ ] **Step 1: Write it; run it without the variable:** `cd agent && go test -run TestProve_Lab -v ./internal/gatewayproof/` → `SKIP`.
- [ ] **Step 2: Build the three lab binaries:** `cd agent && for t in linux/amd64 darwin/arm64 darwin/amd64 windows/amd64; do CGO_ENABLED=0 GOOS=${t%/*} GOARCH=${t#*/} go test -c -o gatewayproof-${t%/*}-${t#*/}.test ./internal/gatewayproof || exit 1; done` → four binaries (keep them out of the commit).
- [ ] **Step 3: Commit** `test(agent): env-gated lab harness for gateway proof`.

### Task 7: Lab runs and evidence (the gate)

**Files:** Create the evidence file (headings above).

For each OS, in this order, each run launched under the service account (see Lab rig). Windows starts
with W1 and moves to the next candidate only when one fails a criterion; every candidate tried gets a
row in `### Candidates tried`.

- [ ] **Step 1: C1, C5, C6.** One call, `GATEWAYPROOF_CALLS=1`. Record the `user=`, `cgo=` and `match=` lines.
- [ ] **Step 2: C2.** Plant a dynamic wrong entry, check it, start the capture, run 10 calls with
`GATEWAYPROOF_PLANTED_MAC=3c:37:86:aa:bb:10`, stop the capture, check the table again, remove the entry.
Repeat with a static entry. Pass: no `planted` line, and each call's start-to-end window contains a
request out and a reply in (or the call failed). After the static run, check that the planted
permanent entry is still there and unchanged: `Prove` must not alter a static entry.
- [ ] **Step 3: C3.** Unplug the router's LAN cable from the switch, confirm the machine's link is still
up, run 10 calls. Pass: every line `result=no_answer` with `ms` not above the timeout plus 100.
- [ ] **Step 4: C4 and C7.** Baseline: 60 seconds of `ping` to the gateway at 5 per second (`ping -i 0.2`
on Linux and macOS; on Windows, `Test-Connection` in a loop at the shortest interval it allows, the same
in both windows) and the TCP session (an SSH session to the host beyond the router running a loop that
prints a timestamp every 100 ms). Then the same with `GATEWAYPROOF_CALLS=100` running. Pass: loss during
the calls ≤ baseline loss, largest timestamp gap ≤ 1 s. C7 is the run's `median_ms` and `max_ms`.
- [ ] **Step 5: Write each OS's section**, every unknown from "What each OS offers" answered in
`## Unknowns resolved`, and the verdict row. Redact as the wave constraints say.
- [ ] **Step 6: Commit** `docs(plans): learned networks fresh-proof evidence`.

### Task 8: Decide

- [ ] **Step 1: If any OS failed,** stop here: set `## Decision` to name the OS and the criterion, open
the PR as a draft with the evidence, and take it to the owner. W02c and W03c do not start.
- [ ] **Step 2: If all passed,** reduce Windows to the method that passed: delete the other methods,
`windowsMethod`, `spikeMethod` and the `GATEWAYPROOF_WINDOWS_METHOD` branch; if the static-entry run
needed it, add the `GetIpNetEntry2` permanent-entry check with a test that a `Permanent` state gives
`ErrNoAnswer` (seam around the proc call).
- [ ] **Step 3: Run the Done-when commands** below.
- [ ] **Step 4: Commit** `feat(agent): gateway proof uses <method> on Windows`.

---

## Done when

- [ ] `cd agent && go test -race ./internal/gatewayproof/...` → `ok` (lab test `SKIP`).
- [ ] `cd agent && CGO_ENABLED=0 go test ./internal/gatewayproof/...` → `ok` on the dev OS.
- [ ] `cd agent && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go test -c -o /dev/null ./internal/gatewayproof && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go test -c -o /dev/null ./internal/gatewayproof && CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go test -c -o /dev/null ./internal/gatewayproof && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go test -c -o /dev/null ./internal/gatewayproof` → exit 0.
- [ ] `cd agent && CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go vet ./...` → exit 0, and `bash scripts/check-windows-vet.sh` → exit 0.
- [ ] The CI build path (`ci.yml:2304-2315`), cgo off, from the repo root: `for t in linux/amd64 linux/arm64 windows/amd64 darwin/arm64; do CGO_ENABLED=0 agent/scripts/build-edition.sh --edition self-host --component agent --goos ${t%/*} --goarch ${t#*/} --version dev --out /tmp/breeze-agent-${t%/*}-${t#*/} || exit 1; done` → exit 0. (W02b adds no caller of the package to the agent binary; this proves the tree still builds.)
- [ ] `grep -c 'internal/gatewayproof' .github/workflows/ci.yml` → at least 1, on the `test-agent-windows` `go test` line; `test-agent`, `test-agent-race` and `test-agent-windows` green on the PR.
- [ ] The evidence file exists with every heading above, a verdict row per OS, and no real address or MAC:
  `grep -oiE '([0-9a-f]{2}[:-]){5}[0-9a-f]{2}' <file> | tr 'A-F-' 'a-f:' | sort -u` prints only
  `3c:37:86:aa:bb:10`, `a4:2b:b0:11:22:9c` and `00:1a:8c:00:00:01`, and
  `grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' <file> | sort -u` prints only addresses in `192.168.1.0/24`,
  `10.1.2.0/24`, `203.0.113.20` and `198.51.100.7`.
- [ ] The PR body states: `Closes #<W02b sub-issue>`; the verdict table copied from the evidence file;
  the Windows method chosen and why the others were rejected; that the gate passed (or, as a draft, which
  OS failed and that W02c and W03c are held); and every Contract note below.

## Contract notes

1. **D2 has no timeout argument.** `Prove` uses the caller's deadline, or one second when there is none,
   and resends every 250 ms. Both are unexported. W02c sets its own deadline on the context.
2. **`ErrNoAnswer` is the deadline outcome only.** A caller that cancels gets `context.Canceled`; a bad
   request or an OS error is a wrapped error. W02c maps all three to `network_mismatch` or
   `network_changed` as §7.2 says; only `ErrNoAnswer` means "the gateway did not answer".
3. **`Interface.Name` is used on macOS only** (the BSD name for `BIOCSETIF`); Linux and Windows use
   `Index`. W02c fills both from `netattach.Attachment` (`InterfaceName`, `InterfaceIndex`), which on
   macOS is the BSD name the reader takes from `net.Interface`.
4. **A permanent neighbour entry on Windows** may make `Prove` return `ErrNoAnswer` (Task 8 Step 2), so a
   machine with a static gateway entry cannot be a guarded scan agent. If the lab shows this, it is a new
   known limit for §11 and goes into the W05 docs.
