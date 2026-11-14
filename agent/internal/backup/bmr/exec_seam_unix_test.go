//go:build !windows

package bmr

import (
	"context"
	"testing"
)

// The production runCommandEnv hands its extra variables to the child, and
// they win over the same names in this process's environment. The offline
// service enable depends on it (SYSTEMCTL_SKIP_SYSV=1).
func TestRunCommandEnvPassesEnvironmentToTheChild(t *testing.T) {
	t.Setenv("SYSTEMCTL_SKIP_SYSV", "0")
	out, err := runCommandEnv(context.Background(), []string{"SYSTEMCTL_SKIP_SYSV=1"}, "sh", "-c", `printf %s "$SYSTEMCTL_SKIP_SYSV"`)
	if err != nil {
		t.Fatalf("sh: %v: %s", err, out)
	}
	if string(out) != "1" {
		t.Fatalf("child saw SYSTEMCTL_SKIP_SYSV=%q, want 1", out)
	}
}
