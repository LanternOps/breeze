//go:build darwin

package collectors

import (
	"strings"
	"testing"
)

func TestParseDarwinCrontabTruncatesCommand(t *testing.T) {
	t.Parallel()

	output := "0 * * * * /usr/local/bin/" + strings.Repeat("a", collectorStringLimit+10) + "\n"
	tasks := parseDarwinCrontab(output)
	if len(tasks) != 1 {
		t.Fatalf("expected 1 task, got %d", len(tasks))
	}
	if !strings.Contains(tasks[0].Command, "[truncated]") {
		t.Fatalf("expected truncated command, got %q", tasks[0].Command)
	}
}
