package collectors

import (
	"strings"
	"testing"
)

func TestTruncateCollectorString(t *testing.T) {
	t.Parallel()

	short := "hello"
	if got := truncateCollectorString(short); got != short {
		t.Fatalf("truncateCollectorString(short) = %q", got)
	}

	long := strings.Repeat("x", collectorStringLimit+10)
	got := truncateCollectorString(long)
	if !strings.Contains(got, "[truncated]") {
		t.Fatalf("truncateCollectorString(long) = %q", got)
	}
}
