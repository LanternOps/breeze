package securefs

import (
	"os"
	"sync"
)

var legacyOnce sync.Once

// LogLegacyStagingTrees reports, exactly once per process, any of the legacy
// shared staging trees this fix stopped using.
//
// They are deliberately NOT removed. A legacy tree may hold evidence of an
// attempt to exploit the predictable-path weakness, so it has to be inventoried
// (lstat/owner/mode/hashes, without following links) before anyone decides to
// delete it. Cleanup is a separate, explicitly authorized operator action.
func LogLegacyStagingTrees(warn func(msg string, args ...any)) {
	legacyOnce.Do(func() {
		tmp := os.TempDir()
		for _, name := range []string{"breeze-scripts", "breeze-restore", "breeze-restore-staging"} {
			path := tmp + string(os.PathSeparator) + name
			info, err := os.Lstat(path)
			if err != nil {
				continue
			}
			warn("legacy shared staging tree observed; it is no longer used and was NOT removed - preserve it for inventory before any cleanup",
				"path", path, "mode", info.Mode().String())
		}
	})
}
