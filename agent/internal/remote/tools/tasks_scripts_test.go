package tools

import (
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/psscript"
)

// Task paths are compared inside PowerShell, so a path containing any
// single-quote character (ASCII or typographic) must stay one literal.
func TestTaskScriptsQuoteThePath(t *testing.T) {
	paths := []string{
		`\Microsoft\Windows\Defrag\ScheduledDefrag`,
		`\Vendor\it's daily`,
		"\\Vendor\\O’Brien’s report",
		"\\Vendor\\‘quoted’ ‚low‛",
	}
	for _, path := range paths {
		detail := taskDetailScript(path)
		if want := "\n$fullPath=" + psscript.Quote(path) + "\n"; !strings.Contains(detail, want) {
			t.Errorf("task detail script for %q does not assign %q", path, strings.TrimSpace(want))
		}
		history := taskHistoryScript(path, 25)
		if want := "$taskPath = " + psscript.Quote(path) + "\n$limit = 25\n"; !strings.HasPrefix(history, want) {
			t.Errorf("task history script for %q does not start with %q", path, want)
		}
	}
}
