package gatewayproof

import (
	"context"
	"fmt"
	"strings"
	"sync"
)

// callTrace collects short notes about how one Prove call ran: which mechanism,
// which OS call returned which code, which wait the BPF reader used. The lab
// harness attaches one per call and prints it, so the lab can answer the
// plan's unknowns from the harness output. Notes carry codes and states only,
// never an address, MAC or interface name. Production callers attach none and
// tracef is then a no-op.
type callTrace struct {
	mu    sync.Mutex
	notes []string
}

type traceKey struct{}

func withTrace(ctx context.Context) (context.Context, *callTrace) {
	t := &callTrace{}
	return context.WithValue(ctx, traceKey{}, t), t
}

func tracef(ctx context.Context, format string, args ...any) {
	t, _ := ctx.Value(traceKey{}).(*callTrace)
	if t == nil {
		return
	}
	note := fmt.Sprintf(format, args...)
	t.mu.Lock()
	t.notes = append(t.notes, note)
	t.mu.Unlock()
}

// String joins the notes with commas; "-" when there are none.
func (t *callTrace) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.notes) == 0 {
		return "-"
	}
	return strings.Join(t.notes, ",")
}
