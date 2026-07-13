package heartbeat

// On-demand runtime diagnostics (#2389). capture_pprof captures heap and/or
// goroutine profiles in-process and returns them base64-encoded in the command
// result. There is deliberately NO pprof HTTP listener: the agent is a root
// daemon and must expose nothing reachable off-box, so the signed/queued
// command path is the only trigger.

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"runtime"
	"runtime/pprof"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// maxProfileBytes caps a single captured profile's raw size. Heap and
// goroutine profiles are sampled/compact — typically well under 1 MB even for
// large processes — and the server-side command result caps stdout at 5 MB,
// so 1 MiB raw per profile (~1.37 MiB base64) keeps the combined result
// comfortably inside that. Var (not const) so tests can exercise the cap
// without allocating a gigantic heap.
var maxProfileBytes = 1 << 20

func handleCapturePprof(_ *Heartbeat, cmd Command) tools.CommandResult {
	// Strict payload validation: key absent → default "all"; key present but
	// not a string → error (don't let a malformed payload silently force a
	// GC + double capture the caller never asked for).
	profile := "all"
	if raw, ok := cmd.Payload["profile"]; ok {
		s, isString := raw.(string)
		if !isString {
			return tools.CommandResult{
				Status: "failed",
				Error:  fmt.Sprintf("profile must be a string, got %T", raw),
			}
		}
		profile = s
	}

	var wantHeap, wantGoroutine bool
	switch profile {
	case "all":
		wantHeap, wantGoroutine = true, true
	case "heap":
		wantHeap = true
	case "goroutine":
		wantGoroutine = true
	default:
		return tools.CommandResult{
			Status: "failed",
			Error:  fmt.Sprintf("invalid profile %q: must be heap, goroutine, or all", profile),
		}
	}

	result := map[string]any{
		"capturedAt": time.Now().UTC().Format(time.RFC3339),
		// Snapshot of the runtime gauges at capture time, so the profile can
		// be correlated with the heartbeat trend without a second command.
		"runtime": collectors.CollectRuntimeStats(),
	}

	if wantHeap {
		// Force a GC first so the heap profile reflects live (in-use) objects
		// rather than garbage awaiting collection — same effect as
		// net/http/pprof's ?gc=1.
		runtime.GC()
		b64, size, err := capturePprofProfile("heap")
		if err != nil {
			return tools.CommandResult{Status: "failed", Error: err.Error()}
		}
		result["heapProfileBase64"] = b64
		result["heapProfileBytes"] = size
	}

	if wantGoroutine {
		b64, size, err := capturePprofProfile("goroutine")
		if err != nil {
			return tools.CommandResult{Status: "failed", Error: err.Error()}
		}
		result["goroutineProfileBase64"] = b64
		result["goroutineProfileBytes"] = size
	}

	return tools.NewSuccessResult(result, 0)
}

// capturePprofProfile writes the named runtime/pprof profile (debug=0 →
// gzip-compressed protobuf, the format `go tool pprof` consumes) and returns
// it base64-encoded along with its raw byte size.
func capturePprofProfile(name string) (string, int, error) {
	p := pprof.Lookup(name)
	if p == nil {
		return "", 0, fmt.Errorf("profile %q not found", name)
	}
	var buf bytes.Buffer
	if err := p.WriteTo(&buf, 0); err != nil {
		return "", 0, fmt.Errorf("failed to write %s profile: %v", name, err)
	}
	if buf.Len() > maxProfileBytes {
		return "", 0, fmt.Errorf("%s profile is %d bytes, exceeds the %d byte result cap", name, buf.Len(), maxProfileBytes)
	}
	return base64.StdEncoding.EncodeToString(buf.Bytes()), buf.Len(), nil
}
