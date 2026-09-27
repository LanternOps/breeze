package hyperv

import (
	"encoding/json"
	"fmt"
	"strings"
)

// exportEstimate is the JSON the EstimateExportBytes PowerShell probe prints.
type exportEstimate struct {
	VHDBytes    int64  `json:"vhdBytes"`
	MemoryBytes int64  `json:"memoryBytes"`
	State       string `json:"state"`
}

// parseExportEstimate reads the probe's output. runPS returns stdout and
// stderr combined, so a stray warning line can precede the JSON: the LAST
// line that looks like a JSON object is the result.
func parseExportEstimate(out string) (int64, error) {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if !strings.HasPrefix(line, "{") {
			continue
		}
		var est exportEstimate
		if err := json.Unmarshal([]byte(line), &est); err != nil {
			return 0, fmt.Errorf("parse export size estimate: %w", err)
		}
		if est.VHDBytes < 0 || est.MemoryBytes < 0 {
			return 0, fmt.Errorf("export size estimate is negative: %s", line)
		}
		if est.VHDBytes == 0 {
			// Every exportable VM has at least one virtual disk file; zero means
			// the probe saw nothing (pass-through disks only, or a query that
			// silently matched no drives) — not a basis for a space verdict.
			return 0, fmt.Errorf("export size estimate found no virtual disk files")
		}
		return est.VHDBytes + est.MemoryBytes, nil
	}
	return 0, fmt.Errorf("export size estimate produced no JSON: %q", strings.TrimSpace(out))
}
