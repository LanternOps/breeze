package tools

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
	"time"
)

const sharedInstallTimeoutsPath = "../../../../packages/shared/src/constants/softwareInstallTimeouts.ts"

// TestInstallTimeoutsMatchSharedConstants pins the agent's download and
// installer ceilings to their TypeScript mirrors (#3578). The web deployment
// view uses those mirrors to decide when an in-flight install has gone quiet
// for longer than the agent would ever take, so a one-sided edit would make it
// warn too early or never.
func TestInstallTimeoutsMatchSharedConstants(t *testing.T) {
	path := filepath.Clean(sharedInstallTimeoutsPath)
	data, err := os.ReadFile(path)
	if err != nil {
		// A missing file is a failure, not a skip: an unverified pin is no pin.
		t.Fatalf("cannot read the shared constants at %s: %v", path, err)
	}

	for _, tc := range []struct {
		name string
		goMs int
	}{
		{"SOFTWARE_INSTALL_DOWNLOAD_TIMEOUT_MS", int(downloadTimeout / time.Millisecond)},
		{"SOFTWARE_INSTALL_INSTALLER_TIMEOUT_MS", int(installTimeout / time.Millisecond)},
	} {
		// Anchored on the declaration so doc-comment prose cannot retarget it.
		re := regexp.MustCompile(`export\s+const\s+` + tc.name + `\s*=\s*([0-9_*\s]+?);`)
		m := re.FindSubmatch(data)
		if m == nil {
			t.Fatalf("no `export const %s = <expr>;` declaration in %s", tc.name, path)
		}
		shared, err := evalByteProduct(string(m[1]))
		if err != nil {
			t.Fatalf("could not parse %s value %q: %v", tc.name, m[1], err)
		}
		if shared != tc.goMs {
			t.Fatalf("shared %s = %d ms but the Go agent uses %d ms — change both sides in the SAME commit",
				tc.name, shared, tc.goMs)
		}
	}
}
