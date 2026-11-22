package gatewayproof

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
)

// This file sequences the Windows candidates (W1 to W4 in the W02b plan). It is
// untagged so the sequencing is tested on every OS; prove_windows.go supplies
// the iphlpapi calls. The spike keeps every candidate, selectable with
// GATEWAYPROOF_WINDOWS_METHOD; the decision task removes the losers.

type windowsMethod int

const (
	methodResolve       windowsMethod = iota + 1 // W1: ResolveIpNetEntry2 alone
	methodDeleteResolve                          // W2: DeleteIpNetEntry2 (dynamic entry), then ResolveIpNetEntry2
	methodDeleteSendARP                          // W3: DeleteIpNetEntry2 (dynamic entry), then SendARP
	methodFlushResolve                           // W4: FlushIpNetTable2 on the interface, then ResolveIpNetEntry2
)

var windowsMethodNames = map[windowsMethod]string{
	methodResolve:       "W1-resolve",
	methodDeleteResolve: "W2-delete-resolve",
	methodDeleteSendARP: "W3-delete-sendarp",
	methodFlushResolve:  "W4-flush-resolve",
}

func (m windowsMethod) String() string {
	if n, ok := windowsMethodNames[m]; ok {
		return n
	}
	return fmt.Sprintf("windowsMethod(%d)", int(m))
}

// parseWindowsMethod reads a GATEWAYPROOF_WINDOWS_METHOD value: W1 to W4, or
// the name after the dash (resolve, delete-resolve, delete-sendarp,
// flush-resolve). Empty means W1. Anything else is an error, never a silent
// default.
func parseWindowsMethod(s string) (windowsMethod, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" {
		return methodResolve, nil
	}
	for m, name := range windowsMethodNames {
		long := strings.ToLower(name)
		if s == long || s == long[:2] || s == long[3:] {
			return m, nil
		}
	}
	return 0, fmt.Errorf("GATEWAYPROOF_WINDOWS_METHOD %q: want W1, W2, W3 or W4", s)
}

// neighborState mirrors NL_NEIGHBOR_STATE: 0 Unreachable, 1 Incomplete,
// 2 Probe, 3 Delay, 4 Stale, 5 Reachable, 6 Permanent. The trace prints the
// number.
type neighborState uint32

const (
	nlnsStale     neighborState = 4
	nlnsReachable neighborState = 5
	nlnsPermanent neighborState = 6
)

// Win32 codes the sequencing needs. The "no answer" mapping is read from
// Microsoft's documentation, not observed: SendARP documents 67 for "no ARP
// reply" on Vista and later (31 on Server 2003 and earlier, kept as a legacy
// mapping); ResolveIpNetEntry2 documents 67 as "the network with the neighbor
// IP address is unreachable". Whether Resolve returns 67 for an unanswered
// request on the local subnet is a lab unknown; the trace prints every raw
// code so the lab records what it observes.
const (
	errGenFailure uint32 = 31   // ERROR_GEN_FAILURE
	errBadNetName uint32 = 67   // ERROR_BAD_NET_NAME
	errNotFound   uint32 = 1168 // ERROR_NOT_FOUND: no neighbour entry
)

// iphlpError is a non-zero status from one iphlpapi call.
type iphlpError struct {
	call string
	code uint32
}

func (e *iphlpError) Error() string { return fmt.Sprintf("iphlpapi %s returned %d", e.call, e.code) }

// neighborResult is what a resolving call returned.
type neighborResult struct {
	mac           []byte
	state         neighborState // from MIB_IPNET_ROW2, when hasState
	hasState      bool          // SendARP returns no row
	lastReachable uint32        // MIB_IPNET_ROW2.ReachabilityTime, recorded only
}

// neighborOps are the iphlpapi calls for one gateway on one interface. Each
// call builds its own row, so a call left running after a deadline shares no
// memory with the next.
type neighborOps interface {
	getEntry() (state neighborState, found bool, err error) // GetIpNetEntry2
	deleteEntry() error                                     // DeleteIpNetEntry2; no entry is not an error
	flushInterface() error                                  // FlushIpNetTable2(AF_INET, index)
	resolve() (neighborResult, error)                       // ResolveIpNetEntry2; blocks
	sendARP() (neighborResult, error)                       // SendARP; blocks
}

// runMethod runs one candidate. W2 to W4 read the gateway entry's state first
// and never delete or flush a permanent entry: a static entry means the OS
// will not ask the gateway, so there is no fresh answer and the result is
// ErrNoAnswer. W1 makes no pre-check: ResolveIpNetEntry2 is documented to
// flush a matching entry before resolving, and what it does with a permanent
// one is a lab unknown (the lab checks the entry is unchanged afterwards).
//
// W4 flushes every dynamic neighbour on the interface. Whether
// FlushIpNetTable2 also drops other permanent entries is not documented. W4 is
// meant to be tried only if W1 to W3 fail, and only on the lab machine; the
// code does not enforce that.
func runMethod(ctx context.Context, ops neighborOps, m windowsMethod) (net.HardwareAddr, error) {
	// Touch nothing in the neighbour table for a call that is already over.
	if err := ctx.Err(); err != nil {
		return nil, doneErr(err)
	}
	tracef(ctx, "method=%s", m)
	if m != methodResolve {
		state, found, err := ops.getEntry()
		switch {
		case err != nil:
			return nil, err
		case found && state == nlnsPermanent:
			tracef(ctx, "get=0,state=%d,permanent_untouched", state)
			return nil, ErrNoAnswer
		case found:
			tracef(ctx, "get=0,state=%d", state)
		default:
			tracef(ctx, "get=%d", errNotFound)
		}
		if m == methodFlushResolve {
			if err := ops.flushInterface(); err != nil {
				return nil, err
			}
			tracef(ctx, "flush=0")
		} else if found {
			if err := ops.deleteEntry(); err != nil {
				return nil, err
			}
			tracef(ctx, "delete=0")
		}
	}
	call, name := ops.resolve, "resolve"
	if m == methodDeleteSendARP {
		call, name = ops.sendARP, "sendarp"
	}
	res, err := await(ctx, call)
	var ie *iphlpError
	switch {
	case errors.As(err, &ie):
		tracef(ctx, "%s=%d", name, ie.code)
		if ie.code == errBadNetName || (name == "sendarp" && ie.code == errGenFailure) {
			return nil, ErrNoAnswer
		}
		return nil, err
	case err != nil:
		return nil, err
	}
	tracef(ctx, "%s=0", name)
	if res.hasState {
		tracef(ctx, "row_state=%d,reach_ms=%d", res.state, res.lastReachable)
	}
	if len(res.mac) != 6 || !usableUnicastMAC(res.mac) {
		tracef(ctx, "len=%d", len(res.mac))
		return nil, fmt.Errorf("%s returned no usable unicast hardware address (length %d)", name, len(res.mac))
	}
	return bytes.Clone(res.mac), nil
}

// await runs a blocking call in a goroutine and returns at the context's end
// without waiting for it; the call finishes in the background and its result
// is dropped (the channel is buffered, so the goroutine never blocks).
func await(ctx context.Context, call func() (neighborResult, error)) (neighborResult, error) {
	type outcome struct {
		res neighborResult
		err error
	}
	done := make(chan outcome, 1)
	go func() {
		res, err := call()
		done <- outcome{res, err}
	}()
	select {
	case o := <-done:
		return o.res, o.err
	case <-ctx.Done():
		tracef(ctx, "returned_at_deadline")
		return neighborResult{}, doneErr(ctx.Err())
	}
}
