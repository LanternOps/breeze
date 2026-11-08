package selfuninstall

import (
	"strings"
	"testing"
)

// The cleanup line names the directory only through the environment, read
// with delayed expansion, so a % in a path cannot redirect the rmdir.
func TestHelperDirCleanupArgsNeverInlinesAPath(t *testing.T) {
	line := helperDirCleanupArgs()
	for _, want := range []string{"/V:ON", `rmdir /s /q "!` + helperDirEnv + `!"`, `if not exist "!` + helperDirEnv + `!" exit`, "for /L %i in (1,1,60)"} {
		if !strings.Contains(line, want) {
			t.Fatalf("cleanup line %q missing %q", line, want)
		}
	}
	if strings.Contains(line, `:\`) {
		t.Fatalf("cleanup line inlines a path: %q", line)
	}
}

// The helper copy must survive every kill list in the teardown.
func TestHelperExeIsNotKilledByTheTeardown(t *testing.T) {
	for _, name := range append(append([]string{}, windowsHelperProcesses...), windowsAgentProcesses...) {
		if strings.EqualFold(name, HelperExeName) {
			t.Fatalf("%s is in a kill/verify list", HelperExeName)
		}
	}
}
