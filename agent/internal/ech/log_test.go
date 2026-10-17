package ech

import (
	"bytes"
	"strings"
	"sync"
	"testing"

	"github.com/breeze-rmm/agent/internal/logging"
)

// logBuf is a goroutine-safe log sink: async config fetches log from their
// own goroutines.
type logBuf struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *logBuf) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

// lines returns the captured lines containing every one of subs.
func (b *logBuf) lines(subs ...string) []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []string
	for _, l := range strings.Split(b.buf.String(), "\n") {
		ok := l != ""
		for _, s := range subs {
			ok = ok && strings.Contains(l, s)
		}
		if ok {
			out = append(out, l)
		}
	}
	return out
}

func (b *logBuf) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// captureLogs routes the agent logger to a buffer at the stock agent level
// (info), so a Debug line is invisible here exactly as on a customer machine.
// No test in this package runs in parallel, so swapping the global is safe.
func captureLogs(t *testing.T) *logBuf {
	t.Helper()
	b := &logBuf{}
	logging.Init("text", "info", b)
	t.Cleanup(func() { logging.Init("text", "info", nil) })
	return b
}
